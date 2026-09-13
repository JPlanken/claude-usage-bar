# Claude Usage Bar

> **Agent Onboarding**
> Private VS Code extension that shows Claude plan usage in the status bar. One source file, `src/extension.ts`. It reads the Claude Code OAuth token from the macOS Keychain (item "Claude Code-credentials", fallback `~/.claude/.credentials.json`), polls the undocumented usage endpoint that claude.ai's settings page uses, and renders the session, weekly and per-model limits. Not published to the Marketplace; installed from a local `.vsix`.

## What it shows

**Explorer sidebar section "Claude Usage"** (same place as panels like VS Code Pets): one progress bar per limit with percentage and reset time, refresh and open-page buttons in its header. Drag the section header to reorder it; right-click the Explorer title to hide or show it.

**Status bar item** on the right (can be turned off with `claudeUsageBar.showStatusBarItem`), for example:

```
5h 29% · wk 20% · Fable 38%
```

- `5h`: current 5-hour session window
- `wk`: weekly limit across all models
- a per-model row (currently `Fable`) when the plan has one; the binding limit is marked in the tooltip
- hover for reset countdowns and absolute times; click to open the claude.ai usage page
- background turns yellow at 80% and red at 95% (configurable)

## Install

```bash
cd /Users/jonathanvanderplanken/Developer/JP-Github/tools/claude-usage-bar
npm install
npm run install-local
```

`install-local` uses whatever `code` resolves to on your PATH (on this machine that is Cursor). For VS Code proper use `npm run install-vscode`, which calls the CLI inside the app bundle. Then reload the window (`Developer: Reload Window`).

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `claudeUsageBar.refreshIntervalMinutes` | 5 | Poll interval |
| `claudeUsageBar.warnAtPercent` | 80 | Yellow background threshold |
| `claudeUsageBar.errorAtPercent` | 95 | Red background threshold |
| `claudeUsageBar.showStatusBarItem` | true | Show the compact status bar summary as well |

Commands: `Claude Usage: Refresh`, `Claude Usage: Open Usage Page`.

## How it works

1. Token: `security find-generic-password -s "Claude Code-credentials" -w`, parse `claudeAiOauth.accessToken`. Re-read on every poll so a token refreshed by Claude Code is picked up automatically.
2. Request: `GET https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer`, `anthropic-beta: oauth-2025-04-20` and `User-Agent: claude-code/<installed version>`. The User-Agent matters: without it the endpoint answers 429.
3. Parse the `limits[]` array (`session`, `weekly_all`, `weekly_scoped` with `scope.model.display_name`). Falls back to `five_hour` / `seven_day` if `limits` is absent.
4. On 401 it shows a warning and asks you to run `claude` to re-login. On 429 it backs off for 15 minutes.

## Caveats

- The endpoint is undocumented and may change. Community tools have relied on it since 2025.
- The token never leaves the machine except in the request to `api.anthropic.com`. It is never logged or shown.
