const vscode = require('vscode');

const STATE_KEY = 'codexUsageDashboard.state';
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const MAX_ENTRIES = 120;

let activePanel;

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('codexUsageDashboard.open', () => openDashboard(context)),
    vscode.commands.registerCommand('codexUsageDashboard.addUsage', () => promptAddUsage(context)),
    vscode.commands.registerCommand('codexUsageDashboard.setLimits', () => promptSetLimits(context)),
    vscode.commands.registerCommand('codexUsageDashboard.resetWindow', () => resetWindow(context)),
    vscode.commands.registerCommand('codexUsageDashboard.resetMonth', () => resetMonth(context))
  );
}

function deactivate() {}

function openDashboard(context) {
  const column = vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;

  if (activePanel) {
    activePanel.reveal(column);
    refreshPanel(context);
    return;
  }

  activePanel = vscode.window.createWebviewPanel(
    'codexUsageDashboard',
    'Codex Usage',
    column,
    {
      enableScripts: true,
      retainContextWhenHidden: true
    }
  );

  activePanel.onDidDispose(() => {
    activePanel = undefined;
  }, null, context.subscriptions);

  activePanel.webview.onDidReceiveMessage(async (message) => {
    switch (message.type) {
      case 'addUsage':
        await promptAddUsage(context);
        break;
      case 'setLimits':
        await promptSetLimits(context);
        break;
      case 'resetWindow':
        await resetWindow(context);
        break;
      case 'resetMonth':
        await resetMonth(context);
        break;
      case 'refresh':
        refreshPanel(context);
        break;
    }
  }, undefined, context.subscriptions);

  refreshPanel(context);
}

async function promptAddUsage(context) {
  const amountText = await vscode.window.showInputBox({
    title: 'Add Codex usage',
    prompt: 'Enter usage units to add. Use the same unit as your limits, such as credits, requests, or percent points.',
    placeHolder: 'Example: 3',
    validateInput(value) {
      const number = Number(value);
      if (!Number.isFinite(number) || number <= 0) {
        return 'Enter a number greater than 0.';
      }
      return undefined;
    }
  });

  if (!amountText) {
    return;
  }

  const note = await vscode.window.showInputBox({
    title: 'Usage note',
    prompt: 'Optional note for this entry.',
    placeHolder: 'Example: refactor session'
  });

  const state = normalizeState(context);
  rollExpiredPeriods(state);

  const amount = roundUsage(Number(amountText));
  if (!state.windowStartedAt) {
    state.windowStartedAt = Date.now();
  }

  state.monthlyUsed = roundUsage(state.monthlyUsed + amount);
  state.windowUsed = roundUsage(state.windowUsed + amount);
  state.entries.unshift({
    amount,
    note: note || '',
    timestamp: Date.now()
  });
  state.entries = state.entries.slice(0, MAX_ENTRIES);

  await saveState(context, state);
  refreshPanel(context);
}

async function promptSetLimits(context) {
  const state = normalizeState(context);

  const monthlyLimitText = await vscode.window.showInputBox({
    title: 'Set monthly Codex usage limit',
    prompt: 'Enter the local monthly limit.',
    value: String(state.monthlyLimit),
    validateInput: validateNonNegativeNumber
  });
  if (monthlyLimitText === undefined) {
    return;
  }

  const windowLimitText = await vscode.window.showInputBox({
    title: 'Set 5-hour Codex usage limit',
    prompt: 'Enter the local 5-hour window limit.',
    value: String(state.windowLimit),
    validateInput: validateNonNegativeNumber
  });
  if (windowLimitText === undefined) {
    return;
  }

  state.monthlyLimit = roundUsage(Number(monthlyLimitText));
  state.windowLimit = roundUsage(Number(windowLimitText));

  await saveState(context, state);
  refreshPanel(context);
}

async function resetWindow(context) {
  const state = normalizeState(context);
  state.windowUsed = 0;
  state.windowStartedAt = Date.now();
  await saveState(context, state);
  refreshPanel(context);
}

async function resetMonth(context) {
  const state = normalizeState(context);
  state.monthlyUsed = 0;
  state.monthKey = getMonthKey();
  await saveState(context, state);
  refreshPanel(context);
}

function refreshPanel(context) {
  if (!activePanel) {
    return;
  }

  const state = normalizeState(context);
  const didRoll = rollExpiredPeriods(state);
  if (didRoll) {
    saveState(context, state);
  }

  activePanel.webview.html = renderDashboard(activePanel.webview, state);
}

function normalizeState(context) {
  const config = vscode.workspace.getConfiguration('codexUsageDashboard');
  const defaultMonthlyLimit = Number(config.get('defaultMonthlyLimit', 100));
  const defaultFiveHourLimit = Number(config.get('defaultFiveHourLimit', 25));
  const saved = context.globalState.get(STATE_KEY, {});

  const state = {
    monthlyLimit: toFiniteNumber(saved.monthlyLimit, defaultMonthlyLimit),
    monthlyUsed: toFiniteNumber(saved.monthlyUsed, 0),
    monthKey: typeof saved.monthKey === 'string' ? saved.monthKey : getMonthKey(),
    windowLimit: toFiniteNumber(saved.windowLimit, defaultFiveHourLimit),
    windowUsed: toFiniteNumber(saved.windowUsed, 0),
    windowStartedAt: toFiniteNumber(saved.windowStartedAt, 0),
    entries: Array.isArray(saved.entries) ? saved.entries : []
  };

  if (state.monthlyLimit < 0) state.monthlyLimit = 0;
  if (state.windowLimit < 0) state.windowLimit = 0;
  if (state.monthlyUsed < 0) state.monthlyUsed = 0;
  if (state.windowUsed < 0) state.windowUsed = 0;

  return state;
}

function rollExpiredPeriods(state) {
  let changed = false;
  const currentMonth = getMonthKey();
  if (state.monthKey !== currentMonth) {
    state.monthKey = currentMonth;
    state.monthlyUsed = 0;
    changed = true;
  }

  if (state.windowStartedAt && Date.now() - state.windowStartedAt >= FIVE_HOURS_MS) {
    state.windowStartedAt = 0;
    state.windowUsed = 0;
    changed = true;
  }

  return changed;
}

function saveState(context, state) {
  return context.globalState.update(STATE_KEY, state);
}

function validateNonNegativeNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return 'Enter a number greater than or equal to 0.';
  }
  return undefined;
}

function toFiniteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundUsage(value) {
  return Math.round(value * 100) / 100;
}

function getMonthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

function clampPercent(used, limit) {
  if (limit <= 0) {
    return used > 0 ? 100 : 0;
  }
  return Math.max(0, Math.min(100, (used / limit) * 100));
}

function formatUsage(value) {
  return Number(value).toLocaleString(undefined, {
    maximumFractionDigits: 2
  });
}

function formatDateTime(timestamp) {
  if (!timestamp) {
    return 'Not started';
  }
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function formatTimeLeft(state) {
  if (!state.windowStartedAt) {
    return 'Starts on next usage entry';
  }

  const remaining = Math.max(0, state.windowStartedAt + FIVE_HOURS_MS - Date.now());
  const hours = Math.floor(remaining / (60 * 60 * 1000));
  const minutes = Math.ceil((remaining % (60 * 60 * 1000)) / (60 * 1000));

  if (hours <= 0) {
    return `${minutes}m until reset`;
  }
  return `${hours}h ${minutes}m until reset`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderSegments(percent) {
  const activeSegments = Math.ceil(percent / 10);
  const segments = [];
  for (let index = 1; index <= 10; index += 1) {
    segments.push(`<span class="segment ${index <= activeSegments ? 'segment-active' : ''}"></span>`);
  }
  return segments.join('');
}

function getStatusClass(percent) {
  if (percent >= 90) return 'danger';
  if (percent >= 70) return 'warning';
  return 'good';
}

function renderDashboard(webview, state) {
  const nonce = getNonce();
  const monthlyPercent = clampPercent(state.monthlyUsed, state.monthlyLimit);
  const windowPercent = clampPercent(state.windowUsed, state.windowLimit);
  const monthStatus = getStatusClass(monthlyPercent);
  const windowStatus = getStatusClass(windowPercent);
  const latestEntries = state.entries.slice(0, 8);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Codex Usage</title>
  <style>
    :root {
      --space-1: 4px;
      --space-2: 8px;
      --space-3: 12px;
      --space-4: 16px;
      --space-6: 24px;
      --space-8: 32px;
      --space-12: 48px;
      --radius-sm: 6px;
      --radius-md: 8px;
      --radius-pill: 999px;
      --font-sans: var(--vscode-font-family);
      --text-xs: 12px;
      --text-sm: 13px;
      --text-base: 14px;
      --text-md: 16px;
      --text-lg: 20px;
      --text-xl: 24px;
      --leading-tight: 1.2;
      --leading-normal: 1.5;
      --weight-normal: 400;
      --weight-medium: 500;
      --weight-semibold: 600;
      --bg: var(--vscode-editor-background);
      --surface: var(--vscode-sideBar-background);
      --surface-2: var(--vscode-input-background);
      --border: var(--vscode-panel-border);
      --text: var(--vscode-foreground);
      --text-dim: var(--vscode-descriptionForeground);
      --text-muted: var(--vscode-disabledForeground);
      --track: var(--vscode-progressBar-background);
      --accent: var(--vscode-button-background);
      --accent-hover: var(--vscode-button-hoverBackground);
      --accent-contrast: var(--vscode-button-foreground);
      --success: var(--vscode-testing-iconPassed);
      --warning: var(--vscode-testing-iconQueued);
      --danger: var(--vscode-testing-iconFailed);
      --focus: var(--vscode-focusBorder);
      color-scheme: light dark;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--font-sans);
      font-size: var(--text-base);
      line-height: var(--leading-normal);
    }

    button {
      font: inherit;
    }

    .shell {
      max-width: 980px;
      margin-inline: auto;
      padding: var(--space-8);
      display: grid;
      gap: var(--space-6);
    }

    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: var(--space-4);
    }

    .title-block {
      display: grid;
      gap: var(--space-1);
      min-width: 0;
    }

    h1 {
      margin: 0;
      font-size: var(--text-xl);
      line-height: var(--leading-tight);
      font-weight: var(--weight-semibold);
      letter-spacing: 0;
    }

    .subtitle {
      margin: 0;
      color: var(--text-dim);
      max-width: 68ch;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: var(--space-2);
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 36px;
      padding: 0 var(--space-3);
      border-radius: var(--radius-sm);
      border: 1px solid transparent;
      color: var(--text);
      background: transparent;
      cursor: pointer;
      font-size: var(--text-sm);
      font-weight: var(--weight-medium);
      transition: background 160ms ease-out, border-color 160ms ease-out, transform 120ms ease-out;
    }

    .btn:hover {
      background: var(--surface-2);
      border-color: var(--border);
    }

    .btn:active {
      transform: translateY(1px);
    }

    .btn:focus-visible {
      outline: 2px solid var(--focus);
      outline-offset: 2px;
    }

    .btn-primary {
      background: var(--accent);
      color: var(--accent-contrast);
    }

    .btn-primary:hover {
      background: var(--accent-hover);
      border-color: transparent;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-4);
    }

    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-4);
      display: grid;
      gap: var(--space-4);
      min-width: 0;
    }

    .metric-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--space-3);
    }

    .label {
      color: var(--text-dim);
      font-size: var(--text-sm);
      font-weight: var(--weight-medium);
    }

    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 0 var(--space-2);
      border-radius: var(--radius-pill);
      border: 1px solid var(--border);
      font-size: var(--text-xs);
      font-weight: var(--weight-semibold);
      white-space: nowrap;
    }

    .badge.good { color: var(--success); }
    .badge.warning { color: var(--warning); }
    .badge.danger { color: var(--danger); }

    .usage-value {
      display: flex;
      align-items: baseline;
      gap: var(--space-2);
      flex-wrap: wrap;
    }

    .usage-value strong {
      font-size: var(--text-xl);
      line-height: var(--leading-tight);
      font-weight: var(--weight-semibold);
    }

    .usage-value span {
      color: var(--text-dim);
    }

    .bar {
      display: grid;
      gap: var(--space-2);
    }

    .track {
      width: 100%;
      height: 12px;
      overflow: hidden;
      border-radius: var(--radius-pill);
      background: var(--surface-2);
      border: 1px solid var(--border);
    }

    .fill {
      height: 100%;
      width: var(--progress);
      background: var(--accent);
      border-radius: var(--radius-pill);
      transition: width 180ms ease-out;
    }

    .fill.warning { background: var(--warning); }
    .fill.danger { background: var(--danger); }

    .segments {
      display: grid;
      grid-template-columns: repeat(10, minmax(0, 1fr));
      gap: var(--space-1);
    }

    .segment {
      height: 28px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      background: var(--surface-2);
    }

    .segment-active {
      background: var(--accent);
      border-color: transparent;
    }

    .meta-row {
      display: flex;
      justify-content: space-between;
      gap: var(--space-3);
      color: var(--text-dim);
      font-size: var(--text-sm);
    }

    .history {
      display: grid;
      gap: var(--space-3);
    }

    .history-list {
      display: grid;
      gap: var(--space-2);
    }

    .entry {
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: center;
      gap: var(--space-3);
      padding: var(--space-3);
      border-radius: var(--radius-sm);
      background: var(--surface-2);
      border: 1px solid var(--border);
    }

    .entry-amount {
      font-weight: var(--weight-semibold);
    }

    .entry-note {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-dim);
    }

    .entry-time {
      color: var(--text-muted);
      font-size: var(--text-xs);
      white-space: nowrap;
    }

    .empty {
      padding: var(--space-6);
      border-radius: var(--radius-md);
      border: 1px dashed var(--border);
      color: var(--text-dim);
      text-align: center;
    }

    .note {
      color: var(--text-muted);
      font-size: var(--text-xs);
      max-width: 78ch;
    }

    @media (max-width: 760px) {
      .shell {
        padding: var(--space-4);
      }

      .topbar {
        display: grid;
      }

      .actions {
        justify-content: flex-start;
      }

      .grid {
        grid-template-columns: 1fr;
      }

      .entry {
        grid-template-columns: 1fr;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      * {
        transition-duration: 0.01ms !important;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="topbar">
      <div class="title-block">
        <h1>Codex Usage</h1>
        <p class="subtitle">Local counters for monthly usage and the active 5-hour reset window.</p>
      </div>
      <div class="actions">
        <button class="btn btn-primary" data-command="addUsage">Add usage</button>
        <button class="btn" data-command="setLimits">Set limits</button>
        <button class="btn" data-command="refresh">Refresh</button>
      </div>
    </section>

    <section class="grid" aria-label="Usage meters">
      <article class="card">
        <div class="metric-head">
          <span class="label">Monthly</span>
          <span class="badge ${monthStatus}">${Math.round(monthlyPercent)}%</span>
        </div>
        <div class="usage-value">
          <strong>${formatUsage(state.monthlyUsed)}</strong>
          <span>of ${formatUsage(state.monthlyLimit)} units</span>
        </div>
        <div class="bar">
          <div class="track" aria-label="Monthly usage progress">
            <div class="fill ${monthStatus}" style="--progress: ${monthlyPercent}%"></div>
          </div>
          <div class="segments" aria-hidden="true">${renderSegments(monthlyPercent)}</div>
        </div>
        <div class="meta-row">
          <span>Month ${escapeHtml(state.monthKey)}</span>
          <button class="btn" data-command="resetMonth">Reset month</button>
        </div>
      </article>

      <article class="card">
        <div class="metric-head">
          <span class="label">5-hour window</span>
          <span class="badge ${windowStatus}">${Math.round(windowPercent)}%</span>
        </div>
        <div class="usage-value">
          <strong>${formatUsage(state.windowUsed)}</strong>
          <span>of ${formatUsage(state.windowLimit)} units</span>
        </div>
        <div class="bar">
          <div class="track" aria-label="5-hour usage progress">
            <div class="fill ${windowStatus}" style="--progress: ${windowPercent}%"></div>
          </div>
          <div class="segments" aria-hidden="true">${renderSegments(windowPercent)}</div>
        </div>
        <div class="meta-row">
          <span>${escapeHtml(formatTimeLeft(state))}</span>
          <button class="btn" data-command="resetWindow">Reset window</button>
        </div>
      </article>
    </section>

    <section class="card history">
      <div class="metric-head">
        <span class="label">Recent entries</span>
        <span class="badge">${latestEntries.length} shown</span>
      </div>
      ${latestEntries.length ? `
        <div class="history-list">
          ${latestEntries.map((entry) => `
            <div class="entry">
              <span class="entry-amount">+${formatUsage(entry.amount)}</span>
              <span class="entry-note">${escapeHtml(entry.note || 'Codex session')}</span>
              <span class="entry-time">${escapeHtml(formatDateTime(entry.timestamp))}</span>
            </div>
          `).join('')}
        </div>
      ` : '<div class="empty">No usage entries yet. Add usage after a Codex session to start the 5-hour window.</div>'}
    </section>

    <p class="note">This dashboard is local-only. It does not read Codex credentials, billing data, or ChatGPT account usage. Use the same unit for entries and limits.</p>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-command]');
      if (!button) return;
      vscode.postMessage({ type: button.dataset.command });
    });
  </script>
</body>
</html>`;
}

module.exports = {
  activate,
  deactivate
};
