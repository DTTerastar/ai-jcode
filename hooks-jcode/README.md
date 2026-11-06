# hooks-jcode

Maps Jcode lifecycle events onto the Honcho hook handlers in `src/hooks/`.

Jcode's hook contract (see `docs/HOOKS.md`):

- data arrives in `JCODE_HOOK_*` environment variables; there is no stdin payload
- `JCODE_HOOK_PAYLOAD` carries the same fields as JSON (capped at 16 KB)
- observers (`turn_start`, `turn_end`, `session_start`, `session_end`, `post_tool`) are
  spawned detached and fire-and-forget, so failures never reach the model

## `bridge.ts`

One entry point, argument-dispatched:

```
bun run hooks-jcode/bridge.ts <session-start|session-end|turn-start|turn-end|post-tool>
```

It converts the env contract into the stdin JSON the handlers expect, dispatches in-process,
and swallows errors (exit 0) so a broken integration can never fail a Jcode turn.

| Argument | Handler | Does |
| --- | --- | --- |
| `session-start` | `src/hooks/session-start.ts` | Creates the Honcho session + peers, fetches memory, writes `~/.honcho/jcode-context.md` |
| `session-end` | `src/hooks/session-end.ts` | Instant no-op cleanup |
| `turn-start` | `src/hooks/save-user-message.ts` | Uploads the user's prompt |
| `turn-end` | `src/hooks/stop.ts` | Uploads the turn's assistant text |
| `post-tool` | `src/hooks/post-tool-use.ts` | Uploads significant tool writes |

## User prompts

Jcode has no `UserPromptSubmit` hook, and `turn_start` carries no prompt text. `bridge.ts`
therefore reads `~/.jcode/sessions/<session_id>.json` and takes the last user message
containing a plain `text` block (skipping `tool_result` blocks, which are tool output).
The uploaded message id is recorded per session in `~/.honcho/jcode-prompts/<session_id>.json`
so repeated `turn_start` events do not duplicate the prompt.

The read harness the handler normally uses (`~/.claude/projects/*.jsonl`) is Claude-specific,
so per-turn *recall* still has no injection surface: memory reaches the model through the
session-start context file and the Honcho MCP tools (`search`, `chat`, `get_briefing`).

## Limits

- `turn_end` gets only `JCODE_HOOK_LAST_ASSISTANT_TEXT`, which Jcode caps at 4000 chars.
  Longer final messages are truncated at the source; the upload records what it is given.
- Intermediate assistant text earlier in the same turn is not visible to the hook.

## Install

`install.sh` writes the hook commands into `[hooks]` in `~/.jcode/config.toml` using absolute
paths (Jcode does not expand `${...}` in hook command strings). `hooks.json` is an equivalent
manifest for tooling that reads plugin metadata directly.
