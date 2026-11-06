import { Honcho } from "@honcho-ai/sdk";
import {
  loadConfig,
  loadConfigFromEnv,
  saveConfig,
  getConfigPath,
  getConfigDir,
  getHonchoClientOptions,
  getDetectedHost,
  getDefaultWorkspace,
  getDefaultAiPeer,
  configExists,
  setDetectedHost,
  getClaudeSettingsPath,
  getClaudeSettingsDir,
  saveRootField,
} from "../config.js";
import * as s from "../styles.js";
import { findTranscripts } from "./transcript-parse.js";
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// Installs the memory statusLine: ships the renderer to a stable path and
// registers it in the user's global Claude Code settings. Plugins can't
// self-register a statusLine and ${CLAUDE_PLUGIN_ROOT} isn't expanded in
// settings.json, so an absolute path under ~/.honcho is the portable target.
// Idempotent and non-destructive: never clobbers an existing statusLine.
function installStatusline(): void {
  console.log(s.section("Installing memory statusLine"));

  const src = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "honcho-statusline.sh");
  const dest = join(getConfigDir(), "honcho-statusline.sh");
  try {
    if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true });
    copyFileSync(src, dest);
    chmodSync(dest, 0o755);
    console.log(s.success(`Renderer installed at ${dest}`));
  } catch (err) {
    console.log(s.warn(`Could not install renderer: ${err instanceof Error ? err.message : String(err)}`));
    return;
  }

  // Default visibility to "full" only on first run — respect an existing choice.
  try {
    const raw = existsSync(getConfigPath()) ? JSON.parse(readFileSync(getConfigPath(), "utf-8")) : {};
    if (raw.statusline === undefined) saveRootField("statusline", "on");
  } catch {
    // leave config as-is; the renderer defaults to "full" when the key is absent
  }

  // Only Claude Code has a statusLine surface; Jcode does not. Leave settings alone.
  if (getDetectedHost() !== "claude_code") {
    console.log(s.dim(`Renderer at ${dest} — Jcode has no statusLine; run it yourself if wanted.`));
    return;
  }

  // Register in ~/.claude/settings.json without disturbing an existing line.
  const settingsPath = getClaudeSettingsPath();
  let settings: Record<string, unknown> = {};
  try {
    if (existsSync(settingsPath)) settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {
    console.log(s.warn(`Could not parse ${settingsPath} — add the statusLine entry manually:`));
    console.log(s.dim(`  "statusLine": { "type": "command", "command": "${dest}" }`));
    return;
  }

  // refreshInterval re-runs the renderer on a timer so the working glyph can
  // animate at rest; without it Claude Code only repaints on conversation
  // activity and the statusLine looks frozen. 1s is the host minimum.
  const REFRESH = 1;
  const existing = settings.statusLine as { command?: string; refreshInterval?: number } | undefined;
  if (existing?.command === dest) {
    if (existing.refreshInterval === REFRESH) {
      console.log(s.dim("statusLine already points at the honcho renderer"));
      return;
    }
    // Upgrade an older registration that predates the animated renderer.
    settings.statusLine = { type: "command", command: dest, refreshInterval: REFRESH };
    try {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      console.log(s.success("statusLine refreshInterval enabled — memory glyph now animates"));
    } catch (err) {
      console.log(s.warn(`Could not update settings.json: ${err instanceof Error ? err.message : String(err)}`));
    }
    return;
  }
  if (existing) {
    console.log(s.warn("A different statusLine is already configured — leaving it untouched."));
    console.log(s.dim("  To use honcho's instead, set settings.json statusLine.command to:"));
    console.log(s.dim(`  ${dest}`));
    console.log(s.dim(`  and add  "refreshInterval": ${REFRESH}  so the glyph animates.`));
    return;
  }

  settings.statusLine = { type: "command", command: dest, refreshInterval: REFRESH };
  try {
    if (!existsSync(getClaudeSettingsDir())) mkdirSync(getClaudeSettingsDir(), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    console.log(s.success("statusLine registered in ~/.claude/settings.json"));
  } catch (err) {
    console.log(s.warn(`Could not write settings.json: ${err instanceof Error ? err.message : String(err)}`));
    console.log(s.dim(`  Add manually: "statusLine": { "type": "command", "command": "${dest}" }`));
  }
}

export async function setup(): Promise<void> {
  // Jcode host by default; HONCHO_HOST overrides for other hosts.
  setDetectedHost(process.env.HONCHO_HOST === "claude_code" ? "claude_code" : "jcode");

  console.log("");
  console.log(s.header("honcho setup"));
  console.log("");

  // Check for API key — env var takes precedence, then config file
  let apiKey = process.env.HONCHO_API_KEY;
  let keySource = "environment";

  if (!apiKey) {
    // Try reading from config file
    try {
      const configRaw = readFileSync(getConfigPath(), "utf-8");
      const configData = JSON.parse(configRaw);
      apiKey = configData.apiKey;
      keySource = "config";
    } catch {
      // No config file or no apiKey in it
    }
  }

  if (!apiKey) {
    // Self-hosted instances often run with AUTH off. Use a placeholder so setup
    // can still validate the configured endpoint instead of bailing out.
    apiKey = "self-hosted";
    keySource = "unauthenticated default";
    console.log(s.dim("No API key set — assuming an unauthenticated (self-hosted) instance."));
  } else {
    console.log(s.success(`API key found (${keySource})`));
  }
  console.log("");

  // Validate connection
  console.log(s.section("Validating connection"));
  const config = loadConfig() || loadConfigFromEnv();
  if (!config) {
    console.log(s.warn("Failed to build config from environment"));
    process.exit(1);
  }

  try {
    const honcho = new Honcho(getHonchoClientOptions(config));
    await honcho.workspaces();
    console.log(s.success("Connected to Honcho API"));
    console.log(`  ${s.label("Workspace")}: ${config.workspace}`);
    console.log(`  ${s.label("Peer")}:      ${config.peerName}`);
    console.log(`  ${s.label("AI Peer")}:   ${config.aiPeer}`);
    console.log("");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(s.warn(`Connection failed: ${msg}`));
    if (msg.includes("401") || msg.includes("auth")) {
      console.log(s.dim("  API key may be invalid. Get a new one at https://app.honcho.dev"));
      console.log(s.dim("  Self-hosting? Check endpoint.baseUrl in ~/.honcho/config.json."));
    }
    process.exit(1);
  }

  // Write config if it doesn't exist
  if (!configExists()) {
    console.log(s.section("Creating config"));
    try {
      // Root-level globals (owned by user/CLI, written only at initial setup)
      saveRootField("apiKey", config.apiKey);
      saveRootField("peerName", config.peerName);
      // Per-host config goes in hosts.claude_code via saveConfig
      saveConfig({
        apiKey: config.apiKey,
        peerName: config.peerName,
        workspace: config.workspace,
        aiPeer: config.aiPeer,
        saveMessages: true,
        enabled: true,
        logging: true,
      });
      console.log(s.success(`Written to ${getConfigPath()}`));
    } catch (err) {
      console.log(s.warn(`Failed to write config: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
    console.log("");
  } else {
    console.log(s.dim(`Config already exists at ${getConfigPath()}`));
    console.log("");
  }

  installStatusline();
  console.log("");

  // Report availability only — importing lives in /honcho-import.
  try {
    const transcripts = findTranscripts(30);
    if (transcripts.length > 0) {
      console.log(s.section("Import past sessions (optional)"));
      console.log(s.listItem(`Found ${transcripts.length} local Claude Code session(s) from the last 30 days.`));
      console.log(s.dim("  Run /honcho-import whenever you'd like to add your past work to Honcho."));
      console.log("");
    }
  } catch {
    // Non-fatal — the import is optional.
  }

  console.log(s.success("Setup complete -- Honcho memory is ready"));
  console.log("");
}

