#!/usr/bin/env bash
# Wire the honcho Jcode plugin into ~/.jcode. Idempotent — safe to re-run.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JCODE_DIR="${JCODE_HOME:-$HOME/.jcode}"
MCP_JSON="$JCODE_DIR/mcp.json"
CONFIG_TOML="$JCODE_DIR/config.toml"
SKILLS_DIR="$JCODE_DIR/skills"
DRY=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    -h|--help)
      echo "usage: $0 [--dry-run]"
      echo "  Installs this checkout ($ROOT) as the honcho plugin for Jcode."
      exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then say "  would: $*"; else "$@"; fi; }

command -v bun >/dev/null 2>&1 || { say "error: bun is required (https://bun.sh)"; exit 1; }
[ -f "$ROOT/mcp-server.ts" ] || { say "error: $ROOT/mcp-server.ts missing"; exit 1; }
[ -d "$ROOT/node_modules" ] || {
  if [ "$DRY" = 1 ]; then
    say "  would: bun install (dependencies not installed yet)"
  else
    say "dependencies not installed — running bun install"
    ( cd "$ROOT" && bun install ) || { say "error: bun install failed"; exit 1; }
    say ""
  fi
}

mkdir -p "$JCODE_DIR" "$SKILLS_DIR"

say "honcho plugin: $ROOT"
say "jcode home:    $JCODE_DIR"
say ""

# --- mcp.json -------------------------------------------------------------
say "mcp server -> $MCP_JSON"
merge_mcp() {
  bun -e '
const fs = require("fs");
const [path, root] = process.argv.slice(1);
let cfg = {};
if (fs.existsSync(path)) {
  try { cfg = JSON.parse(fs.readFileSync(path, "utf-8")); } catch { cfg = {}; }
}
cfg.servers = cfg.servers || {};
cfg.servers.honcho = {
  type: "stdio",
  command: "bun",
  args: ["run", root + "/mcp-server.ts"],
  env: { HONCHO_HOST: "jcode" },
  shared: true,
};
fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
' "$MCP_JSON" "$ROOT"
}
if [ "$DRY" = 1 ]; then say "  would: register servers.honcho (stdio, $ROOT/mcp-server.ts)"; else merge_mcp; fi
say ""

# --- config.toml hooks ----------------------------------------------------
say "hooks -> $CONFIG_TOML"
merge_hooks() {
  bun -e '
const fs = require("fs");
const [path, root] = process.argv.slice(1);
let text = fs.existsSync(path) ? fs.readFileSync(path, "utf-8") : "";
const H = root + "/hooks-jcode";
// One bridge, argument-dispatched. Absolute paths because Jcode does not expand
// ${...} inside hook command strings.
const bridgeFor = (name) => "bun run " + H + "/bridge.ts " + name;
const want = {
  session_start: bridgeFor("session-start"),
  session_end:   bridgeFor("session-end"),
  turn_start:    bridgeFor("turn-start"),
  turn_end:      bridgeFor("turn-end"),
  post_tool:     bridgeFor("post-tool"),
};

// Drop stale honcho hook assignments (whole line) so re-runs and moved checkouts
// do not leave two registrations behind. Every other hook line is preserved.
const stale = /^\s*(session_start|session_end|turn_start|turn_end|post_tool)\s*=.*(jcode-(session-start|session-end|turn-end|post-tool)\.sh|hooks-jcode\/bridge\.ts)/;
let lines = text.split("\n").filter((l) => !stale.test(l));

const block = Object.entries(want).map(([k, v]) => `${k} = ${JSON.stringify([v])}`);

const headerIdx = lines.findIndex((l) => l.trim() === "[hooks]");
if (headerIdx >= 0) {
  lines.splice(headerIdx + 1, 0, ...block);
} else {
  const body = lines.join("\n").replace(/\s*$/, "");
  lines = (body ? body + "\n" : "") + "\n[hooks]\n" + block.join("\n") + "\n";
  lines = [lines];
}

let out = Array.isArray(lines) ? lines.join("\n") : lines;
out = out.replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "") + "\n";
fs.writeFileSync(path, out);
' "$CONFIG_TOML" "$ROOT"
}
if [ "$DRY" = 1 ]; then say "  would: set [hooks] session_start / session_end / turn_end / post_tool"; else merge_hooks; fi
say ""

# --- skills ---------------------------------------------------------------
say "skills -> $SKILLS_DIR"
for d in "$ROOT"/skills/honcho-*; do
  [ -d "$d" ] || continue
  name="$(basename "$d")"
  if [ "$DRY" = 1 ]; then
    say "  would: link $name"
  else
    rm -rf "$SKILLS_DIR/$name"
    ln -s "$d" "$SKILLS_DIR/$name"
    say "  linked $name"
  fi
done
say ""

if [ "$DRY" = 1 ]; then
  say "dry run — nothing written"
  exit 0
fi

say "done."
say ""
say "next:"
say "  1. jcode mcp test honcho"
say "  2. restart jcode"
say ""
say "memory is written to ~/.honcho/ and recalled through the honcho MCP tools"
say "(mcp action=call, server=honcho) plus ~/.honcho/jcode-context.md from session start."