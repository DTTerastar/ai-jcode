# DTTerastar/ai-jcode

Jcode plugins and skills. Fork of [DTTerastar/ai](https://github.com/DTTerastar/ai)
(a fork of [plastic-labs/claude-honcho](https://github.com/plastic-labs/claude-honcho), MIT),
tuned for **Jcode** instead of Claude Code. It works against the hosted Honcho API or
any self-hosted instance; no deployment URL is baked in.

## Plugins

| Plugin | What it is |
| --- | --- |
| **honcho** | Persistent memory for Jcode sessions — MCP tools, session lifecycle hooks, 7 skills |

## Install

```bash
git clone https://github.com/DTTerastar/ai-jcode ~/Code/ai-jcode
~/Code/ai-jcode/install.sh
```

`install.sh` is idempotent. It writes:

- `~/.jcode/mcp.json` — the `honcho` stdio MCP server entry
- `~/.jcode/config.toml` — the four lifecycle hooks under `[hooks]`
- `~/.jcode/skills/honcho-*` — symlinks to the skills in this repo

Restart Jcode afterward. `jcode mcp test honcho` verifies the connection.

### Requirements

- [Bun](https://bun.sh) on `PATH` (the plugin runs TypeScript directly, no build step)
- A reachable Honcho API (hosted or self-hosted).
- Dependencies: run `bun install` in the clone. `install.sh` warns if `node_modules` is
  missing.

## Configuration

Everything lives in `~/.honcho/config.json`, shared with the Claude Code plugin, with
per-host blocks. Point `endpoint` at your own instance (or set `HONCHO_ENDPOINT`):

```json
{
  "apiKey": "your-api-key",
  "peerName": "you",
  "endpoint": { "baseUrl": "https://honcho.example.com/v3" },
  "dashboardUrl": "https://honcho.example.com",
  "timeout": 30000,
  "hosts": {
    "jcode": { "workspace": "default", "aiPeer": "jcode" }
  }
}
```

Defaults when no config exists: endpoint `https://api.honcho.dev/v3` (hosted),
peerName `$USER`, workspace `jcode`, aiPeer `jcode`.

Env overrides: `HONCHO_API_KEY`, `HONCHO_PEER_NAME`, `HONCHO_WORKSPACE`, `HONCHO_AI_PEER`,
`HONCHO_ENDPOINT`, `HONCHO_SAVE_MESSAGES`, `HONCHO_SAVE_TOOL_USE`, `HONCHO_SAVE_GIT_EVENTS`,
`HONCHO_ENABLED`, `HONCHO_LOGGING`.

Use the `honcho-config` skill (or the `set_config` MCP tool) to change settings
interactively — it validates and handles dangerous-field confirmation.

## How it maps to Jcode

Claude Code has plugin hooks that can inject `additionalContext` into the model's turn.
**Jcode hooks cannot do that** — `session_start`, `session_end`, `turn_start`, `turn_end`,
and `post_tool` are fire-and-forget observers, and only `post_tool_feedback` appends stdout
to a tool result.
So the port keeps the parts that work and adapts the rest:

| Claude Code hook | Jcode event | Behaviour |
| --- | --- | --- |
| SessionStart | `session_start` | Creates the Honcho session + peers, fetches memory, writes `~/.honcho/jcode-context.md` |
| SessionEnd | `session_end` | Instant cleanup (no network) |
| UserPromptSubmit | `turn_start` | Recovers the typed prompt from the session file and uploads it (deduped per prompt id) |
| Stop | `turn_end` | Uploads the turn's assistant text (`JCODE_HOOK_LAST_ASSISTANT_TEXT`, capped at 4000 chars by Jcode) |
| PostToolUse | `post_tool` | Uploads significant tool actions (Write/Edit/Bash/Task), secrets redacted |
| *(no equivalent)* | — | Jcode has no hook that can inject context mid-turn. Recall is via the MCP tools (`search`, `chat`, `get_briefing`) plus the session-start context file |
| PreCompact / PreToolUse | — | Not wired — no matching Jcode hook |

All five hooks run through `hooks-jcode/bridge.ts`, which maps Jcode's `JCODE_HOOK_*`
environment into the stdin JSON the handlers expect and dispatches in-process.

`session-start` writes `~/.honcho/jcode-context.md` rather than printing `additionalContext`
JSON, because nothing consumes that JSON in Jcode. Read it (or `@`-include it) when you want
the loaded memory in context; the `honcho-briefing` skill does the same thing through a live
tool call.

## MCP tools

Served by `mcp-server.ts` (stdio):

| Tool | Purpose |
| --- | --- |
| `search` | Semantic search across session messages and saved conclusions |
| `chat` | Dialectic query — Honcho reasons over what it knows about the peer |
| `create_conclusion` | Save an insight |
| `list_conclusions` / `query_conclusions` / `delete_conclusion` | Manage saved conclusions |
| `get_briefing` | Session summary + peer card in one call |
| `get_context` / `get_representation` | Full context object / prose representation |
| `get_config` / `set_config` | Read and change plugin configuration |
| `honcho_remember` | Fan-out dialectic recall — only registered when `rememberTool: true` |

In Jcode these are reached through the `mcp` tool, e.g.
`mcp(action="call", server="honcho", tool="get_briefing")`.

## Skills

| Skill | What it does |
| --- | --- |
| `honcho-briefing` | Load session summary + peer card through a visible tool call |
| `honcho-status` | Connection health, workspace, peers, queue, conclusion count |
| `honcho-config` | Interactive configuration of every plugin setting |
| `honcho-setup` | First-time setup: validate connection, write config |
| `honcho-import` | Backfill past Claude Code transcripts (`~/.claude/projects/*.jsonl`) |
| `honcho-interview` | Short interview to capture stable cross-project preferences |
| `honcho-insights` | Distill memory into AGENTS.md / output-style / skill proposals |

## Fork customizations vs. upstream claude-honcho

- **`jcode` host.** New `HonchoHost` member with its own workspace/aiPeer block, detection via
  `JCODE_HOOK_EVENT`, telemetry attributed as `jcode-honcho`.
- **Jcode hook bridge.** `hooks-jcode/bridge.ts` translates Jcode's env-var contract
  (`JCODE_HOOK_*`) into the stdin JSON the handlers expect, and recovers user prompts from
  the session file on `turn_start` because Jcode has no `UserPromptSubmit` hook.
- **No `additionalContext`.** Session-start and per-turn injection write
  `~/.honcho/jcode-context.md` instead of emitting Claude's hook JSON.
- **Spinner silenced.** Jcode hooks have no terminal surface, so the animation is skipped.
- **No hardcoded deployment.** The endpoint comes from `endpoint.baseUrl` /
  `HONCHO_ENDPOINT` (hosted API otherwise), and session links honour `dashboardUrl` /
  `HONCHO_DASHBOARD_URL`.
- **Configurable SDK timeout.** `timeout` (ms) from config, default 120000, so slower
  dialectic models don't time out.
- **No statusLine install.** Jcode has no statusLine; the renderer is copied to
  `~/.honcho/honcho-statusline.sh` for optional manual use.

## Layout

```
.jcode-plugin/plugin.json   plugin manifest
mcp-servers.json            stdio MCP server definition
mcp-server.ts               MCP entry point
hooks-jcode/                Jcode hook bridge + hooks.json
skills/honcho-*/SKILL.md    7 skills
src/                        config, hooks, MCP server, skills runners
bun.lock                    dependency lockfile
install.sh                  wires mcp.json, config.toml hooks, and skills
```

## License

MIT. Based on [plastic-labs/claude-honcho](https://github.com/plastic-labs/claude-honcho)
(MIT, © 2026 Plastic Labs) via the [DTTerastar/ai](https://github.com/DTTerastar/ai) fork.
