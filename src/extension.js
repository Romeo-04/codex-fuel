const vscode = require('vscode');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const STATE_KEY = 'codexUsageDashboard.state';
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const MAX_ENTRIES = 120;
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
    vscode.commands.registerCommand('codexUsageDashboard.addUsage', () => promptAddUsage(context)),
    vscode.commands.registerCommand('codexUsageDashboard.setLimits', () => promptSetLimits(context)),
    vscode.commands.registerCommand('codexUsageDashboard.resetWindow', () => resetWindow(context)),
    vscode.commands.registerCommand('codexUsageDashboard.resetMonth', () => resetMonth(context))
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
    await handleWebviewMessage(context, message);
  }, undefined, context.subscriptions);

  refreshViews(context);
}

async function handleWebviewMessage(context, message) {
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
    case 'enableEndpoint':
      await promptEnableEndpoint(context);
      break;
    case 'refresh':
      refreshViews(context);
      break;
  }
}

async function promptEnableEndpoint(context) {
  const choice = await vscode.window.showWarningMessage(
    'Enable authenticated Codex usage endpoint? This reads CODEX_HOME/auth.json to extract a bearer token and sends it only to https://chatgpt.com/backend-api/wham/usage. The endpoint is undocumented and may break.',
    { modal: true },
    'Enable'
  );

  if (choice !== 'Enable') {
    return;
  }

  const config = vscode.workspace.getConfiguration('codexUsageDashboard');
  await config.update('experimentalReadAuthJson', true, vscode.ConfigurationTarget.Global);
  await config.update('dataSource', 'auto', vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage('Codex usage endpoint enabled for this VS Code profile.');
  refreshViews(context);
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
  refreshViews(context);
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
  refreshViews(context);
}

async function resetWindow(context) {
  const state = normalizeState(context);
  state.windowUsed = 0;
  state.windowStartedAt = Date.now();
  await saveState(context, state);
  refreshViews(context);
}

async function resetMonth(context) {
  const state = normalizeState(context);
  state.monthlyUsed = 0;
  state.monthKey = getMonthKey();
  await saveState(context, state);
  refreshViews(context);
}

async function refreshViews(context) {
  if (!activePanel && !sidebarView) {
    return;
  }

  const state = normalizeState(context);
  const didRoll = rollExpiredPeriods(state);
  const codexSnapshot = await readUsageSnapshot(context);
  if (didRoll) {
    saveState(context, state);
  }

  if (activePanel) {
    activePanel.webview.html = renderDashboard(activePanel.webview, state, codexSnapshot, 'panel');
  }

  if (sidebarView) {
    sidebarView.webview.html = renderDashboard(sidebarView.webview, state, codexSnapshot, 'sidebar');
  }
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

async function readUsageSnapshot(context) {
  const config = vscode.workspace.getConfiguration('codexUsageDashboard');
  const dataSource = String(config.get('dataSource', 'auto'));

  if (dataSource === 'manual') {
    return undefined;
  }

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

function renderCodexUsageCards(snapshot) {
  return snapshot.windows.map((window) => {
    const percent = Math.round(window.usedPercent);
    const status = getStatusClass(window.usedPercent);
    const resetText = window.resetsAtMs ? `Resets ${formatResetTime(window.resetsAtMs)}` : 'Reset time unavailable';

    return `<article class="card">
        <div class="metric-head">
          <span class="label">${escapeHtml(window.label)}</span>
          <span class="badge ${status}">${percent}%</span>
        </div>
        <div class="usage-value">
          <strong>${percent}%</strong>
          <span>used</span>
        </div>
        <div class="bar">
          <div class="track" aria-label="${escapeHtml(window.label)} usage progress">
            <div class="fill ${status}" style="--progress: ${window.usedPercent}%"></div>
          </div>
          <div class="segments" aria-hidden="true">${renderSegments(window.usedPercent)}</div>
        </div>
        <div class="meta-row">
          <span>${escapeHtml(resetText)}</span>
          <span>${escapeHtml(formatWindowDuration(window.windowMinutes))}</span>
        </div>
      </article>`;
  }).join('');
}

function renderManualUsageCards(state, monthlyPercent, windowPercent, monthStatus, windowStatus) {
  return `<article class="card">
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
      </article>`;
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

function formatSnapshotSource(snapshot) {
  if (snapshot.fromEndpoint) {
    return `Reading Codex usage from the authenticated endpoint. Source: ${snapshot.sourceFile}. The auth token is not shown or stored by this extension.`;
  }

  return `Reading Codex rate limits from local session rollout files. Source: ${path.basename(snapshot.sourceFile)}. No auth tokens are read.`;
}

function renderDashboard(webview, state, codexSnapshot, surface) {
  const nonce = getNonce();
  const monthlyPercent = clampPercent(state.monthlyUsed, state.monthlyLimit);
  const windowPercent = clampPercent(state.windowUsed, state.windowLimit);
  const monthStatus = getStatusClass(monthlyPercent);
  const windowStatus = getStatusClass(windowPercent);
  const latestEntries = state.entries.slice(0, 8);
  const isSidebar = surface === 'sidebar';
  const hasCodexSnapshot = codexSnapshot && Array.isArray(codexSnapshot.windows) && codexSnapshot.windows.length > 0;
  const usageCardsHtml = hasCodexSnapshot
    ? renderCodexUsageCards(codexSnapshot)
    : renderManualUsageCards(state, monthlyPercent, windowPercent, monthStatus, windowStatus);
  const sourceHtml = hasCodexSnapshot
    ? `<p class="note">${escapeHtml(formatSnapshotSource(codexSnapshot))}</p>`
    : `<p class="note">Automatic Codex usage was not available: ${escapeHtml(codexSnapshot?.error || 'No snapshot found')}. Manual counters are shown instead.</p>`;

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

    body.sidebar .shell {
      padding: var(--space-3);
      gap: var(--space-4);
    }

    body.sidebar .topbar {
      display: grid;
      gap: var(--space-3);
    }

    body.sidebar h1 {
      font-size: var(--text-lg);
    }

    body.sidebar .subtitle {
      display: none;
    }

    body.sidebar .actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      justify-content: stretch;
      gap: var(--space-2);
    }

    body.sidebar .actions .btn:first-child {
      grid-column: 1 / -1;
    }

    body.sidebar .btn {
      width: 100%;
      min-height: 34px;
      padding-inline: var(--space-2);
      font-size: var(--text-xs);
    }

    body.sidebar .grid {
      grid-template-columns: 1fr;
      gap: var(--space-3);
    }

    body.sidebar .card {
      padding: var(--space-3);
      gap: var(--space-3);
    }

    body.sidebar .usage-value strong {
      font-size: var(--text-lg);
    }

    body.sidebar .segment {
      height: 20px;
    }

    body.sidebar .meta-row {
      display: grid;
      gap: var(--space-2);
    }

    body.sidebar .entry {
      grid-template-columns: 1fr;
      gap: var(--space-1);
    }

    body.sidebar .entry-time {
      white-space: normal;
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
    <section class="topbar">
      <div class="title-block">
        <h1>Codex Usage</h1>
        <p class="subtitle">${hasCodexSnapshot ? 'Codex-reported rate-limit windows from local session files.' : 'Local counters for monthly usage and the active 5-hour reset window.'}</p>
      </div>
      <div class="actions">
        <button class="btn btn-primary" data-command="addUsage">Add usage</button>
        <button class="btn" data-command="enableEndpoint">Enable endpoint</button>
        <button class="btn" data-command="setLimits">Set limits</button>
        <button class="btn" data-command="refresh">Refresh</button>
      </div>
    </section>

    <section class="grid" aria-label="Usage meters">
      ${usageCardsHtml}
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

    ${sourceHtml}
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
