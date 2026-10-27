# opencode-codex-usage

OpenCode V2 plugin that shows your **Codex 5-hour and weekly quota** in the TUI status bar, plus a read-only `codex_usage` tool and a standalone CLI.

- Status bar: `5h 22% · 7d 79%` (remaining), auto-hidden for non-OpenAI models
- `ctrl+u` or `/codex-usage`: dialog with reset times, credits and reset coupons
- No polling: refreshes on startup, after each turn, on model switch, and manually
- Uses the same endpoint as the Codex CLI (`chatgpt.com/backend-api/wham/usage`), with `codex app-server` fallback

## Install

```bash
opencode plugin add github:shuaijunwu/opencode-codex-usage
```

Or add it manually to `~/.config/opencode/opencode.json`:

```json
{
  "plugins": ["github:shuaijunwu/opencode-codex-usage"]
}
```

Restart OpenCode after installing.

### Requirements

- OpenCode **2.1+** (the TUI plugin API is new in 2.1)
- Codex CLI installed and logged in (`codex login`)
- macOS or Linux
- The status bar appears only for models whose provider is `openai` (that is what consumes Codex quota)

## Usage

| Entry | What it does |
|---|---|
| Status bar | `5h 22% · 7d 79%` under the prompt, same colors as the rest of the TUI |
| `ctrl+u` / `/codex-usage` | Full detail + force refresh, inside a dialog |
| `codex_usage` tool | Lets the agent read the same quota |

Markers: `⟳` refreshing, `!` refresh failed (last value kept), `*` data older than 15 minutes.

### Configuration

If you install by path, options can be passed through `opencode.json`:

```json
{
  "plugins": [
    {
      "package": "/path/to/opencode-codex-usage",
      "options": {
        "providers": ["openai"],
        "alwaysShow": false,
        "debounceMs": 5000
      }
    }
  ]
}
```

## Standalone CLI

`bin/codex-usage` does not need OpenCode:

```bash
./bin/codex-usage             # 5h 96% · 7d 76%
./bin/codex-usage --detail    # reset times, credits, reset coupons
./bin/codex-usage --json      # raw API response
```

Put it on your `PATH` if you like:

```bash
ln -sf "$PWD/bin/codex-usage" ~/.local/bin/codex-usage
```

It requires Python 3 and `~/.codex/auth.json` (respects `CODEX_HOME`).

## How it reads quota

1. `GET https://chatgpt.com/backend-api/wham/usage` with the token from `~/.codex/auth.json`
   (same endpoint the Codex CLI uses).
2. On 401/timeout/5xx it falls back to `codex app-server` → `account/rateLimits/read`,
   which also refreshes an expired token.
3. 60 s in-process cache plus `~/.cache/opencode/codex-usage.json` for instant cold starts.

User-Agent follows the installed Codex version (`~/.codex/version.json` → `codex --version`),
overridable with `CODEX_CLI_USER_AGENT`.

## Privacy

The plugin is read-only with respect to your credentials and configuration:

- never switches accounts or edits tokens
- never changes providers/models
- sends the token only to `chatgpt.com` (the same place the Codex CLI sends it)
- writes only its own cache file

## Development

```bash
# load the working copy instead of the installed package
# ~/.config/opencode/opencode.json
{ "plugins": ["/path/to/opencode-codex-usage"] }

opencode reload
```

Or symlink it into the auto-discovered plugin directory:

```bash
ln -sfn /path/to/opencode-codex-usage ~/.config/opencode/plugins/codex-usage
```

Do not load the GitHub install and the local path at the same time — you would get two copies of the status bar.

## Compatibility

TUI APIs are new in OpenCode 2.1 and may change. The plugin degrades instead of breaking:

- `setup` and every slot render are wrapped in `try/catch`
- missing dialog falls back to a toast; missing status-bar APIs only log
- the `codex_usage` tool and the standalone CLI keep working even if the TUI part breaks

If a status bar disappears after an OpenCode upgrade, check:

```bash
opencode plugin list
grep -i "failed to load plugin" ~/.local/share/opencode/log/opencode.log | tail
```

The quota endpoint is internal and undocumented; if it changes, the `codex app-server` fallback takes over.

## License

MIT
