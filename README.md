# Codex Usage Dashboard

Local VS Code sidebar dashboard for visualizing Codex usage against a monthly limit and a 5-hour reset window.

This extension does not read Codex credentials, account data, billing data, or private OpenAI usage APIs. By default, it reads Codex's local session rollout files under `CODEX_HOME/sessions` and displays the latest `rate_limits` snapshot when available. It also keeps manual local counters in VS Code global storage as a fallback.

## Commands

- `Codex Usage: Open Dashboard`
- `Codex Usage: Add Usage`
- `Codex Usage: Set Limits`
- `Codex Usage: Reset 5-Hour Window`
- `Codex Usage: Reset Monthly Usage`

## Sidebar

After installation, VS Code adds a **Codex Usage** icon to the Activity Bar. The sidebar dashboard includes buttons for adding usage, setting limits, refreshing, and resetting the monthly or 5-hour counters.

## Automatic Codex Usage

When Codex writes a `token_count` event with `rate_limits` to a rollout file, the sidebar shows those reported windows automatically. This commonly includes a 5-hour window plus a weekly or monthly window depending on the account. No auth file is read.

## Experimental Endpoint Mode

The dashboard can also use the ChatGPT usage endpoint pattern used by some usage watchers. Click **Enable endpoint** in the sidebar to opt in. This sets `codexUsageDashboard.experimentalReadAuthJson` to `true` and allows the extension to read `CODEX_HOME/auth.json` for a bearer token, then call `https://chatgpt.com/backend-api/wham/usage`.

Endpoint mode is undocumented and may break if the endpoint or auth file changes. The extension does not render, log, store, or refresh the token.

Settings:

- `codexUsageDashboard.dataSource`
- `codexUsageDashboard.experimentalReadAuthJson`
- `codexUsageDashboard.usageEndpointUrl`
- `codexUsageDashboard.autoReadCodexSessions`
- `codexUsageDashboard.codexHome`
- `codexUsageDashboard.lookbackDays`
- `codexUsageDashboard.refreshIntervalSeconds`

## Usage Model

- Monthly usage resets automatically when the calendar month changes.
- The 5-hour window starts when usage is first logged after a reset.
- If the 5-hour window expires, the next dashboard refresh or usage entry resets the 5-hour counter.
- Limits are local numbers, so set them to match the plan or budget you want to track.
