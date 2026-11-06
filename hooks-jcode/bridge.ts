#!/usr/bin/env bun
/**
 * Jcode → Honcho hook bridge.
 *
 * Jcode observers get their data in environment variables (JCODE_HOOK_*), while
 * the Honcho handlers expect a Claude-Code-style JSON payload on stdin. This
 * maps one to the other and dispatches in-process, so a hook costs one Bun
 * start rather than a shell + python + bun chain.
 *
 * Jcode has no `UserPromptSubmit` event, so user turns are recovered from the
 * session file on `turn_start` (see `latestUserPrompt`), which is the only place
 * the typed prompt is available.
 *
 * Usage: bun run bridge.ts <session-start|session-end|turn-start|turn-end|post-tool>
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { cacheStdin, setDetectedHost } from "../src/config.js";

type Bridge = "session-start" | "session-end" | "turn-start" | "turn-end" | "post-tool";

const env = process.env;

function cwd(): string {
  return env.JCODE_HOOK_CWD || process.cwd();
}

function sessionId(): string {
  return env.JCODE_HOOK_SESSION_ID || "";
}

function parseToolInput(): unknown {
  const raw = env.JCODE_HOOK_TOOL_INPUT;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

type Block = { type?: string; text?: string };
type Message = { id?: string; role?: string; content?: string | Block[]; timestamp?: string };

function textOf(message: Message): string {
  const c = message.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  // Only plain text blocks: tool_result payloads are not user speech.
  return c
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text!)
    .join("\n");
}

/** Path of the live session file. Jcode names files `session_<animal>_<ts>_<hex>`. */
function sessionFile(): string | null {
  const id = sessionId();
  if (!id || id.includes("/") || id.includes("..")) return null;
  return join(homedir(), ".jcode", "sessions", `${id}.json`);
}

/**
 * Most recent user-typed message in the session, or null.
 *
 * The trailing messages are usually tool_result blocks; the last real text block
 * is the prompt that started this turn.
 */
function latestUserPrompt(): Message | null {
  const file = sessionFile();
  if (!file) return null;
  let messages: Message[];
  try {
    messages = JSON.parse(readFileSync(file, "utf-8")).messages ?? [];
  } catch {
    return null;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (textOf(m).trim()) return m;
  }
  return null;
}

/**
 * Per-session record of the last prompt uploaded, so repeated `turn_start`
 * events in one session do not re-upload the same prompt.
 */
function seenFile(): string {
  return join(homedir(), ".honcho", "jcode-prompts", `${sessionId() || "unknown"}.json`);
}

function alreadyUploaded(id: string): boolean {
  try {
    return JSON.parse(readFileSync(seenFile(), "utf-8")).lastId === id;
  } catch {
    return false;
  }
}

function rememberUploaded(id: string): void {
  try {
    const file = seenFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ lastId: id }));
  } catch {
    // Best effort: a lost dedupe marker costs one duplicate message.
  }
}

function payloadFor(bridge: Bridge): Record<string, unknown> {
  switch (bridge) {
    case "session-start":
      return { cwd: cwd(), session_id: sessionId() };
    case "session-end":
      return { cwd: cwd(), session_id: sessionId(), reason: "jcode-close" };
    case "turn-start": {
      const latest = latestUserPrompt();
      const text = latest ? textOf(latest) : "";
      return { cwd: cwd(), session_id: sessionId(), prompt: text };
    }
    case "turn-end":
      return {
        cwd: cwd(),
        session_id: sessionId(),
        // Capped at 4000 chars by Jcode; the handler falls back to this when no
        // transcript is available.
        last_assistant_message: env.JCODE_HOOK_LAST_ASSISTANT_TEXT || "",
      };
    case "post-tool":
      return {
        cwd: cwd(),
        session_id: sessionId(),
        tool_name: env.JCODE_HOOK_TOOL_NAME || "",
        tool_input: parseToolInput(),
      };
  }
}

const HANDLERS: Record<Bridge, { module: string; fn: string }> = {
  "session-start": { module: "../src/hooks/session-start.js", fn: "handleSessionStart" },
  "session-end": { module: "../src/hooks/session-end.js", fn: "handleSessionEnd" },
  "turn-start": { module: "../src/hooks/save-user-message.js", fn: "handleSaveUserMessage" },
  "turn-end": { module: "../src/hooks/stop.js", fn: "handleStop" },
  "post-tool": { module: "../src/hooks/post-tool-use.js", fn: "handlePostToolUse" },
};

const requested = process.argv[2] as Bridge | undefined;
const handler = requested ? HANDLERS[requested] : undefined;

if (!requested || !handler) {
  console.error(`usage: bridge.ts <${Object.keys(HANDLERS).join("|")}>`);
  process.exit(2);
}
const bridge: Bridge = requested;

// No user prompt for this turn (e.g. a resumed turn): nothing to save.
if (bridge === "turn-start") {
  const latest = latestUserPrompt();
  const text = latest ? textOf(latest).trim() : "";
  if (!text) process.exit(0);
  if (latest?.id && alreadyUploaded(latest.id)) process.exit(0);
  if (latest?.id) rememberUploaded(latest.id);
}

// Hooks run detached, so nothing here may assume a TTY. Jcode exports
// JCODE_HOOK_EVENT itself; setting it here keeps the no-TTY behaviour (e.g. the
// spinner short-circuit) correct when the bridge is invoked directly.
process.env.HONCHO_HOST ??= "jcode";
process.env.JCODE_HOOK_EVENT ??= bridge.replace("-", "_");

// Handlers prefer the cached stdin payload over reading the stream themselves.
cacheStdin(JSON.stringify(payloadFor(bridge)));
setDetectedHost("jcode");

const mod = (await import(handler.module)) as Record<string, () => Promise<void>>;
try {
  await mod[handler.fn]();
} catch (error) {
  // Observers are fire-and-forget; never fail the caller.
  console.error(`[honcho] ${bridge} failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(0);
}
