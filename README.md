# Codex Usage Dashboard

Local VS Code dashboard for visualizing Codex usage against a monthly limit and a 5-hour reset window.

This extension does not read Codex credentials, account data, billing data, or private OpenAI usage APIs. It stores local counters in VS Code global storage. Use **Codex Usage: Add Usage** after a Codex session, or use the dashboard buttons.

## Commands

- `Codex Usage: Open Dashboard`
- `Codex Usage: Add Usage`
- `Codex Usage: Set Limits`
- `Codex Usage: Reset 5-Hour Window`
- `Codex Usage: Reset Monthly Usage`

## Usage Model

- Monthly usage resets automatically when the calendar month changes.
- The 5-hour window starts when usage is first logged after a reset.
- If the 5-hour window expires, the next dashboard refresh or usage entry resets the 5-hour counter.
- Limits are local numbers, so set them to match the plan or budget you want to track.
