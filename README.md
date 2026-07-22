# Codex Fuel

Local VS Code sidebar dashboard for visualizing Codex usage with two compact usage bars.

This extension does not read Codex credentials, account data, billing data, or private OpenAI usage APIs by default. It reads Codex's local session rollout files under `CODEX_HOME/sessions` and displays the latest `rate_limits` snapshot when available.

## Commands

- `Codex Fuel: Open Dashboard`

## Sidebar

After installation, VS Code adds a **Codex Fuel** icon to the Activity Bar. The sidebar shows the key reported usage windows, including daily usage when Codex reports it. Hover over a bar to see reset timing and window details.

## Automatic Codex Usage

When Codex writes a `token_count` event with `rate_limits` to a rollout file, the sidebar shows those reported windows automatically. This commonly includes a 5-hour window plus a weekly or monthly window depending on the account. No auth file is read.

## Experimental Endpoint Mode

The dashboard can also use the ChatGPT usage endpoint pattern used by some usage watchers. Enable `codexUsageDashboard.experimentalReadAuthJson` in VS Code settings to opt in. This allows the extension to read `CODEX_HOME/auth.json` for a bearer token, then call `https://chatgpt.com/backend-api/wham/usage`.

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

The dashboard is read-only. It displays Codex-reported usage windows when Codex exposes them through local session files or the optional endpoint mode.
