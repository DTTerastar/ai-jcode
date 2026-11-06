---
name: honcho-setup
description: First-time Honcho configuration -- set API key, validate connection, create config
---

# Honcho Setup

Walk the user through first-time Honcho configuration so persistent memory works in Jcode.

## Steps

### 1. Validate the connection

Run the setup runner. It's a committed script (`src/skills/setup-runner.ts`) that
checks for an API key (env var, then `~/.honcho/config.json`), validates the
connection, writes the config, and installs the memory statusLine:

```bash
bun run "${HONCHO_PLUGIN_ROOT:-$HOME/Code/jcode-honcho}/src/skills/setup-runner.ts"
```

If `HONCHO_PLUGIN_ROOT` isn't set, point it at the clone:

```bash
export HONCHO_PLUGIN_ROOT="$HOME/Code/jcode-honcho"
```

**API key:** only needed if the target instance has AUTH enabled. If the runner
starts without `HONCHO_API_KEY` set and no `apiKey` in `~/.honcho/config.json`, it
assumes an unauthenticated (self-hosted) instance and proceeds with a placeholder
rather than stopping.

For hosted Honcho (app.honcho.dev) or any AUTH-enabled instance: get a key at
https://app.honcho.dev, set it as an environment variable
(`export HONCHO_API_KEY="..."` in `~/.zshrc`/`~/.bashrc`, or `setx` on Windows),
and restart Jcode. Never ask the user to paste a key into the chat.

**Endpoint:** the plugin hardcodes no deployment. `endpoint.baseUrl` in
`~/.honcho/config.json` (or `HONCHO_ENDPOINT`) chooses the server; with neither
set it uses the hosted API. Ask the user for their server URL during setup if it
is not already configured.

**If the runner succeeds**, the key is valid and the config file has been created.
The statusLine renderer is copied to `~/.honcho/honcho-statusline.sh` for optional
use. Jcode has no statusLine, so it is not registered anywhere — run it yourself
if you want the memory glyph in a shell prompt. Toggle its data with the
`statusline` key in `~/.honcho/config.json`: `on` (default) or `off`.

If it fails for another reason:
- Authentication error: key may be invalid — get a new one at https://app.honcho.dev
- Network error: check the internet connection

### 2. Confirm setup

Tell the user that Honcho is configured and memory will be active on their next
Jcode session. Suggest they restart Jcode to see the memory context load.

If the setup runner (step 1) reported that past local sessions are available to
import, mention it as an optional next step — do **not** import here. Point them to
the dedicated command:

> You also have past Claude Code sessions that can be imported into Honcho.
> Run `/honcho-import` whenever you'd like to backfill them.
