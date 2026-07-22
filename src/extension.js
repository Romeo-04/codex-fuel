const vscode = require('vscode');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const DEFAULT_LOOKBACK_DAYS = 14;

let activePanel;
let sidebarView;
let refreshTimer;

function activate(context) {
  const provider = new UsageSidebarProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('codexUsageDashboard.sidebar', provider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    }),
    vscode.commands.registerCommand('codexUsageDashboard.open', () => openDashboard(context)),
    vscode.commands.registerCommand('codexUsageDashboard.refresh', () => refreshViews(context))
  );

  scheduleRefreshTimer(context);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('codexUsageDashboard.refreshIntervalSeconds')) {
      scheduleRefreshTimer(context);
    }
  }));
}

function deactivate() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}

function scheduleRefreshTimer(context) {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }

  const config = vscode.workspace.getConfiguration('codexUsageDashboard');
  const seconds = Math.max(30, Math.min(3600, Number(config.get('refreshIntervalSeconds', 300)) || 300));
  refreshTimer = setInterval(() => {
    refreshViews(context);
  }, seconds * 1000);
}

class UsageSidebarProvider {
  constructor(context) {
    this.context = context;
  }

  resolveWebviewView(webviewView) {
    sidebarView = webviewView;
    webviewView.webview.options = {
      enableScripts: true
    };

    webviewView.onDidDispose(() => {
      if (sidebarView === webviewView) {
        sidebarView = undefined;
      }
    });

    webviewView.webview.onDidReceiveMessage((message) => {
      handleWebviewMessage(this.context, message);
    });

    refreshViews(this.context);
  }
}

async function openDashboard(context) {
  try {
    await vscode.commands.executeCommand('workbench.view.extension.codexUsageDashboard.container');
    await vscode.commands.executeCommand('codexUsageDashboard.sidebar.focus');
    refreshViews(context);
  } catch {
    openDashboardPanel(context);
  }
}

function openDashboardPanel(context) {
  const column = vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;

  if (activePanel) {
    activePanel.reveal(column);
    refreshViews(context);
    return;
  }

  activePanel = vscode.window.createWebviewPanel(
    'codexUsageDashboard',
    'Codex Fuel',
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
    await handleWebviewMessage(context, message);
  }, undefined, context.subscriptions);

  refreshViews(context);
}

async function handleWebviewMessage(context, message) {
  switch (message.type) {
    case 'refresh':
      refreshViews(context);
      break;
  }
}

async function refreshViews(context) {
  if (!activePanel && !sidebarView) {
    return;
  }

  const codexSnapshot = await readUsageSnapshot(context);

  if (activePanel) {
    activePanel.webview.html = renderDashboard(activePanel.webview, codexSnapshot, 'panel');
  }

  if (sidebarView) {
    sidebarView.webview.html = renderDashboard(sidebarView.webview, codexSnapshot, 'sidebar');
  }
}

async function readUsageSnapshot(context) {
  const config = vscode.workspace.getConfiguration('codexUsageDashboard');
  const dataSource = String(config.get('dataSource', 'auto'));

  if (dataSource === 'endpoint') {
    return readEndpointUsageSnapshot(context);
  }

  if (dataSource === 'sessionFiles') {
    return readCodexUsageSnapshot(context);
  }

  if (config.get('experimentalReadAuthJson', false) === true) {
    const endpointSnapshot = await readEndpointUsageSnapshot(context);
    if (endpointSnapshot && Array.isArray(endpointSnapshot.windows) && endpointSnapshot.windows.length > 0) {
      return endpointSnapshot;
    }
  }

  return readCodexUsageSnapshot(context);
}

function readCodexUsageSnapshot(context) {
  const config = vscode.workspace.getConfiguration('codexUsageDashboard');
  if (config.get('autoReadCodexSessions', true) !== true) {
    return undefined;
  }

  const codexHome = getCodexHome(config);
  const sessionsDir = path.join(codexHome, 'sessions');
  const lookbackDays = Math.max(1, Math.min(90, Number(config.get('lookbackDays', DEFAULT_LOOKBACK_DAYS)) || DEFAULT_LOOKBACK_DAYS));

  try {
    const files = getRecentRolloutFiles(sessionsDir, lookbackDays);
    for (const file of files) {
      const rateLimits = findLatestRateLimits(file.fullPath);
      const snapshot = normalizeRateLimits(rateLimits, file.fullPath);
      if (snapshot) {
        return snapshot;
      }
    }
  } catch {
    return {
      error: `Could not read Codex sessions at ${sessionsDir}`,
      source: sessionsDir
    };
  }

  return {
    error: `No Codex rate-limit snapshot found in the last ${lookbackDays} day${lookbackDays === 1 ? '' : 's'}.`,
    source: sessionsDir
  };
}

async function readEndpointUsageSnapshot(context) {
  const config = vscode.workspace.getConfiguration('codexUsageDashboard');
  if (config.get('experimentalReadAuthJson', false) !== true) {
    return {
      error: 'Endpoint mode requires codexUsageDashboard.experimentalReadAuthJson to be enabled.',
      source: 'auth disabled'
    };
  }

  const endpointUrl = String(config.get('usageEndpointUrl', 'https://chatgpt.com/backend-api/wham/usage') || '').trim();
  if (!isAllowedUsageEndpoint(endpointUrl)) {
    return {
      error: 'Usage endpoint must use https://chatgpt.com/.',
      source: 'endpoint blocked'
    };
  }

  const auth = readCodexAuth(context);
  if (!auth.accessToken) {
    return {
      error: auth.error || 'No usable Codex access token found.',
      source: auth.source || 'auth.json'
    };
  }

  try {
    const response = await httpsGetJson(endpointUrl, {
      Authorization: `Bearer ${auth.accessToken}`,
      Accept: 'application/json',
      Origin: 'https://chatgpt.com',
      Referer: 'https://chatgpt.com/'
    });
    const snapshot = normalizeEndpointUsageResponse(response.body, endpointUrl);
    if (snapshot) {
      return snapshot;
    }

    return {
      error: `Endpoint returned HTTP ${response.statusCode}, but no rate-limit windows were found.`,
      source: endpointUrl
    };
  } catch (error) {
    return {
      error: `Endpoint request failed: ${sanitizeError(error)}`,
      source: endpointUrl
    };
  }
}

function isAllowedUsageEndpoint(endpointUrl) {
  try {
    const parsed = new URL(endpointUrl);
    return parsed.protocol === 'https:' && parsed.hostname === 'chatgpt.com';
  } catch {
    return false;
  }
}

function readCodexAuth(context) {
  const config = vscode.workspace.getConfiguration('codexUsageDashboard');
  const codexHome = getCodexHome(config);
  const authPath = path.join(codexHome, 'auth.json');

  try {
    const raw = fs.readFileSync(authPath, 'utf8');
    const parsed = JSON.parse(raw);
    const accessToken = findAccessToken(parsed);
    return {
      accessToken,
      source: authPath,
      error: accessToken ? undefined : 'auth.json exists, but no access token field matched known Codex shapes.'
    };
  } catch {
    return {
      accessToken: '',
      source: authPath,
      error: `Could not read Codex auth file at ${authPath}.`
    };
  }
}

function findAccessToken(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) {
    return '';
  }

  for (const key of ['access_token', 'accessToken', 'id_token', 'token']) {
    if (typeof value[key] === 'string' && value[key].length > 20) {
      return value[key];
    }
  }

  for (const child of Object.values(value)) {
    const token = findAccessToken(child, depth + 1);
    if (token) {
      return token;
    }
  }

  return '';
}

function httpsGetJson(endpointUrl, headers) {
  return new Promise((resolve, reject) => {
    const request = https.get(endpointUrl, { headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({
            statusCode: response.statusCode || 0,
            body: text ? JSON.parse(text) : {}
          });
        } catch {
          reject(new Error(`HTTP ${response.statusCode || 0} returned non-JSON data`));
        }
      });
    });

    request.setTimeout(15000, () => {
      request.destroy(new Error('request timed out'));
    });
    request.on('error', reject);
  });
}

function normalizeEndpointUsageResponse(body, sourceUrl) {
  const candidates = findRateLimitCandidates(body);
  for (const candidate of candidates) {
    const snapshot = normalizeRateLimits(candidate, sourceUrl);
    if (snapshot) {
      snapshot.sourceFile = sourceUrl;
      snapshot.fromEndpoint = true;
      return snapshot;
    }
  }

  return undefined;
}

function findRateLimitCandidates(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 10) {
    return [];
  }

  const candidates = [];
  if (value.rate_limits && typeof value.rate_limits === 'object') {
    candidates.push(value.rate_limits);
  }

  if ((value.primary && typeof value.primary === 'object') || (value.secondary && typeof value.secondary === 'object')) {
    candidates.push(value);
  }

  for (const child of Object.values(value)) {
    candidates.push(...findRateLimitCandidates(child, depth + 1));
  }

  return candidates;
}

function sanitizeError(error) {
  return String(error?.message || error || 'unknown error').replace(/Bearer\s+[A-Za-z0-9._~-]+/g, 'Bearer [redacted]');
}

function getCodexHome(config) {
  const configured = String(config.get('codexHome', '') || '').trim();
  if (configured) {
    return expandHome(configured);
  }

  if (process.env.CODEX_HOME) {
    return expandHome(process.env.CODEX_HOME);
  }

  return path.join(os.homedir(), '.codex');
}

function expandHome(value) {
  if (value === '~') {
    return os.homedir();
  }

  if (value.startsWith(`~${path.sep}`) || value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}

function getRecentRolloutFiles(sessionsDir, lookbackDays) {
  if (!fs.existsSync(sessionsDir)) {
    return [];
  }

  const files = [];
  const now = new Date();
  for (let offset = 0; offset < lookbackDays; offset += 1) {
    const day = new Date(now);
    day.setDate(now.getDate() - offset);
    const dayDir = path.join(
      sessionsDir,
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, '0'),
      String(day.getDate()).padStart(2, '0')
    );

    if (!fs.existsSync(dayDir)) {
      continue;
    }

    for (const name of fs.readdirSync(dayDir)) {
      if (!/^rollout-.*\.jsonl$/i.test(name)) {
        continue;
      }

      const fullPath = path.join(dayDir, name);
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        files.push({ fullPath, mtimeMs: stat.mtimeMs });
      }
    }
  }

  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function findLatestRateLimits(filePath) {
  let contents;
  try {
    contents = fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }

  const lines = contents.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line || !line.includes('rate_limits')) {
      continue;
    }

    try {
      const parsed = JSON.parse(line);
      const rateLimits = findRateLimitsObject(parsed);
      if (rateLimits) {
        return rateLimits;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

function findRateLimitsObject(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) {
    return undefined;
  }

  if (value.rate_limits && typeof value.rate_limits === 'object') {
    return value.rate_limits;
  }

  for (const child of Object.values(value)) {
    const found = findRateLimitsObject(child, depth + 1);
    if (found) {
      return found;
    }
  }

  return undefined;
}

function normalizeRateLimits(rateLimits, sourceFile) {
  if (!rateLimits || typeof rateLimits !== 'object') {
    return undefined;
  }

  const windows = [];
  for (const key of ['primary', 'secondary']) {
    const window = normalizeRateLimitWindow(rateLimits[key], key);
    if (window) {
      windows.push(window);
    }
  }

  if (!windows.length && Array.isArray(rateLimits.windows)) {
    for (const [index, rawWindow] of rateLimits.windows.entries()) {
      const window = normalizeRateLimitWindow(rawWindow, `window-${index + 1}`);
      if (window) {
        windows.push(window);
      }
    }
  }

  if (!windows.length) {
    return undefined;
  }

  windows.sort((a, b) => a.windowMinutes - b.windowMinutes);

  return {
    sourceFile,
    capturedAt: Date.now(),
    planType: typeof rateLimits.plan_type === 'string' ? rateLimits.plan_type : '',
    credits: rateLimits.credits && typeof rateLimits.credits === 'object' ? rateLimits.credits : undefined,
    windows
  };
}

function normalizeRateLimitWindow(rawWindow, id) {
  if (!rawWindow || typeof rawWindow !== 'object') {
    return undefined;
  }

  const usedPercent = firstFiniteNumber(rawWindow.used_percent, rawWindow.usage_percent, rawWindow.percent_used, rawWindow.percent);
  if (usedPercent === undefined) {
    return undefined;
  }

  const windowMinutes = firstFiniteNumber(rawWindow.window_minutes, rawWindow.windowMinutes, rawWindow.minutes) || inferWindowMinutes(rawWindow);
  const resetsAtMs = getResetTimestampMs(rawWindow);

  return {
    id,
    label: formatWindowLabel(windowMinutes),
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    windowMinutes,
    resetsAtMs
  };
}

function inferWindowMinutes(rawWindow) {
  const name = String(rawWindow.name || rawWindow.label || '').toLowerCase();
  if (name.includes('month')) return 30 * 24 * 60;
  if (name.includes('week')) return 7 * 24 * 60;
  if (name.includes('day')) return 24 * 60;
  if (name.includes('5h') || name.includes('5 hour')) return 5 * 60;
  return 0;
}

function getResetTimestampMs(rawWindow) {
  const resetsAt = firstFiniteNumber(rawWindow.resets_at, rawWindow.reset_at, rawWindow.resetsAt);
  if (resetsAt !== undefined) {
    return resetsAt > 1000000000000 ? resetsAt : resetsAt * 1000;
  }

  const resetsInSeconds = firstFiniteNumber(rawWindow.resets_in_seconds, rawWindow.resetsInSeconds);
  if (resetsInSeconds !== undefined) {
    return Date.now() + resetsInSeconds * 1000;
  }

  return 0;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) {
      return number;
    }
  }
  return undefined;
}

function formatWindowLabel(windowMinutes) {
  if (windowMinutes === 300) return '5-hour window';
  if (windowMinutes === 1440) return 'Daily window';
  if (windowMinutes === 10080) return 'Weekly window';
  if (windowMinutes >= 40320 && windowMinutes <= 44640) return 'Monthly window';
  if (windowMinutes > 0 && windowMinutes < 60) return `${windowMinutes}m window`;
  if (windowMinutes > 0 && windowMinutes % 60 === 0 && windowMinutes < 1440) return `${windowMinutes / 60}h window`;
  if (windowMinutes > 0 && windowMinutes % 1440 === 0) return `${windowMinutes / 1440}d window`;
  return 'Usage window';
}

function pickDisplayWindows(windows) {
  if (!Array.isArray(windows) || windows.length === 0) {
    return [];
  }

  const fiveHour = windows.find((window) => window.windowMinutes === 300);
  const shortWindow = fiveHour || windows[0];
  const monthlyWindow = windows.find((window) => window.windowMinutes >= 40320 && window.windowMinutes <= 44640);
  const longWindow = monthlyWindow || windows[windows.length - 1];

  if (shortWindow === longWindow) {
    return [shortWindow];
  }

  return [shortWindow, longWindow];
}

function getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getStatusClass(percent) {
  if (percent >= 90) return 'danger';
  if (percent >= 70) return 'warning';
  return 'good';
}

function renderCodexUsageBars(snapshot) {
  return pickDisplayWindows(snapshot.windows).map((window) => {
    const percent = Math.round(window.usedPercent);
    const status = getStatusClass(window.usedPercent);
    const resetText = window.resetsAtMs ? `Resets ${formatResetTime(window.resetsAtMs)}` : 'Reset time unavailable';
    const tooltip = [
      resetText,
      `${window.label}: ${percent}% used`,
      `Window length: ${formatWindowDuration(window.windowMinutes)}`
    ].join('\n');

    return `<article class="meter">
        <div class="meter-head">
          <span class="label">${escapeHtml(window.label)}</span>
          <span class="badge ${status}">${percent}%</span>
        </div>
        <div class="bar" data-tooltip="${escapeHtml(tooltip)}" title="${escapeHtml(resetText)}">
          <div class="track" aria-label="${escapeHtml(window.label)} usage progress">
            <div class="fill ${status}" style="--progress: ${window.usedPercent}%"></div>
          </div>
        </div>
      </article>`;
  }).join('');
}

function formatResetTime(timestampMs) {
  const remainingMs = timestampMs - Date.now();
  if (remainingMs <= 0) {
    return 'now';
  }

  const days = Math.floor(remainingMs / (24 * 60 * 60 * 1000));
  const hours = Math.floor((remainingMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const minutes = Math.ceil((remainingMs % (60 * 60 * 1000)) / (60 * 1000));

  if (days > 0) {
    return `in ${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `in ${hours}h ${minutes}m`;
  }
  return `in ${minutes}m`;
}

function formatWindowDuration(windowMinutes) {
  if (!windowMinutes) {
    return 'Window length unavailable';
  }
  if (windowMinutes === 300) {
    return '5 hours';
  }
  if (windowMinutes === 10080) {
    return '7 days';
  }
  if (windowMinutes >= 40320 && windowMinutes <= 44640) {
    return 'monthly';
  }
  if (windowMinutes % 1440 === 0) {
    return `${windowMinutes / 1440} days`;
  }
  if (windowMinutes % 60 === 0) {
    return `${windowMinutes / 60} hours`;
  }
  return `${windowMinutes} minutes`;
}


function renderDashboard(webview, codexSnapshot, surface) {
  const isSidebar = surface === 'sidebar';
  const hasCodexSnapshot = codexSnapshot && Array.isArray(codexSnapshot.windows) && codexSnapshot.windows.length > 0;
  const usageCardsHtml = hasCodexSnapshot
    ? renderCodexUsageBars(codexSnapshot)
    : `<div class="empty" title="${escapeHtml(codexSnapshot?.error || 'No Codex usage data found')}">No usage data found</div>`;
  const sourceHtml = hasCodexSnapshot
    ? ''
    : `<p class="note">${escapeHtml(codexSnapshot?.error || 'Refresh after Codex writes a usage snapshot.')}</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Codex Fuel</title>
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
      container-type: inline-size;
      width: min(100%, 980px);
      margin-inline: auto;
      padding: clamp(var(--space-3), 4cqi, var(--space-8));
      display: grid;
      gap: clamp(var(--space-3), 3cqi, var(--space-6));
    }


    .meters {
      display: grid;
      gap: var(--space-3);
    }

    .meter {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }

    .meter-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
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
      position: relative;
      display: grid;
      gap: var(--space-1);
    }

    .bar::after {
      content: attr(data-tooltip);
      position: absolute;
      left: 0;
      bottom: calc(100% + var(--space-2));
      z-index: 1;
      width: max-content;
      max-width: min(280px, 90cqi);
      padding: var(--space-2);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text);
      background: var(--surface-2);
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.22);
      font-size: var(--text-xs);
      line-height: 1.35;
      white-space: pre-line;
      opacity: 0;
      pointer-events: none;
      transform: translateY(var(--space-1));
      transition: opacity 140ms ease-out, transform 140ms ease-out;
    }

    .bar:hover::after,
    .bar:focus-within::after {
      opacity: 1;
      transform: translateY(0);
    }

    .track {
      width: 100%;
      height: clamp(14px, 2.8cqi, 20px);
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

    .note {
      color: var(--text-muted);
      font-size: var(--text-xs);
      max-width: 78ch;
    }

    .empty {
      padding: var(--space-4);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      color: var(--text-dim);
      background: var(--surface-2);
      text-align: center;
    }

    @container (max-width: 420px) {
      .meters {
        gap: var(--space-2);
      }

      .meter {
        gap: var(--space-1);
      }

      .badge {
        min-height: 22px;
      }
    }

    @container (max-width: 260px) {
      .label {
        font-size: var(--text-xs);
      }
    }

    body.sidebar .shell {
      padding: var(--space-2);
      gap: var(--space-3);
    }


    body.sidebar .meters {
      gap: var(--space-3);
    }

    @media (prefers-reduced-motion: reduce) {
      * {
        transition-duration: 0.01ms !important;
      }
    }
  </style>
</head>
<body class="${isSidebar ? 'sidebar' : 'panel'}">
  <main class="shell">
    <section class="meters" aria-label="Usage meters">
      ${usageCardsHtml}
    </section>

    ${sourceHtml}
  </main>


</body>
</html>`;
}

module.exports = {
  activate,
  deactivate
};
