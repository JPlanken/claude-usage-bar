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

## Publishing

### VS Code Marketplace (one-time setup)

1. Sign in at [Azure DevOps](https://dev.azure.com) with a Microsoft account and create an organisation if you have none. The Marketplace uses Azure DevOps for authentication only.
2. Create a Personal Access Token: user menu, Personal access tokens, New token. Organisation: **All accessible organizations**. Scopes: **Marketplace: Manage**. Store it in Doppler, never in the repo.
3. Create the publisher at [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage). The publisher ID must equal the `publisher` field in `package.json` (`planken`, unclaimed as of 2026-09-13). The display name can differ.
4. Make the GitHub repo public, or the Marketplace listing links will 404: `gh repo edit JPlanken/claude-usage-bar --visibility public`.

### Publish a release

From the repo root:

```bash
npx vsce login planken          # paste the PAT once; stored in the OS keychain
npm version minor               # bumps package.json, commits, tags vX.Y.Z
npx vsce publish --no-dependencies
git push --follow-tags
```

Or let CI do it: add the PAT as the `VSCE_PAT` repository secret (`gh secret set VSCE_PAT`), then `npm version minor && git push --follow-tags`. The workflow in `.github/workflows/release.yml` publishes on any `v*` tag and attaches the `.vsix` to a GitHub release.

### Open VSX (for Cursor and VSCodium)

Cursor installs from [Open VSX](https://open-vsx.org), not from the Microsoft Marketplace. To appear in Cursor's extension panel:

1. Create an Eclipse account and sign the publisher agreement at open-vsx.org.
2. Create an access token there and add it as the `OVSX_PAT` repository secret. The same CI job then publishes to both registries.
3. Manual alternative: `npx ovsx publish --no-dependencies -p <token>`.

### Pre-flight checklist

- `npx vsce ls --no-dependencies` shows only `package.json`, `icon.png`, `README.md`, `LICENSE`, `CHANGELOG.md` and `out/`
- `CHANGELOG.md` has an entry for the new version
- The README opens with a plain description; the Marketplace renders it as the listing page
- `vsce` warns if `repository` is missing or the README contains relative image links
