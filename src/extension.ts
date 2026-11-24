import * as vscode from 'vscode';
import * as https from 'node:https';
import { readFile } from 'node:fs/promises';
import * as os from 'node:os';

const SECRET_KEY = 'apiKey';
const IS_RUSSIAN = vscode.env.language.toLowerCase().startsWith('ru');
const LOCALE = IS_RUSSIAN ? 'ru-RU' : 'en-US';
const REFRESH_LABEL = localize('⟳ Обновить', '⟳ Refresh');

function localize(ru: string, en: string): string {
  return IS_RUSSIAN ? ru : en;
}

const ERROR_LABELS: Record<ErrorKind, string> = {
  'no-key': localize('Kimi: нет ключа', 'Kimi: no key'),
  auth: 'Kimi: auth',
  network: localize('Kimi: сеть', 'Kimi: network'),
  data: localize('Kimi: данные', 'Kimi: data')
};

type ErrorKind = 'no-key' | 'auth' | 'network' | 'data';

interface UsageWindow {
  usedRatio: number;
  resetTime?: string;
}

interface RateWindow {
  limit: number;
  used: number;
  durationMinutes: number;
}

interface UsageSnapshot {
  fiveHour: UsageWindow;
  month: UsageWindow;
  rate?: RateWindow;
  updatedAt: number;
}

interface ApiUsageWindow {
  used_ratio?: unknown;
  reset_time?: unknown;
}

interface ApiRateEntry {
  window?: {
    duration?: unknown;
    timeUnit?: unknown;
  };
  detail?: {
    limit?: unknown;
    used?: unknown;
  };
}

class AuthError extends Error {}
class InvalidResponseError extends Error {}

let secretStorage: vscode.SecretStorage;
let statusBar: vscode.StatusBarItem;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let activeRefresh: Promise<void> | undefined;
let lastSnapshot: UsageSnapshot | undefined;
let errorKind: ErrorKind | undefined;
let detailsPanel: vscode.QuickPick<vscode.QuickPickItem> | undefined;

export function activate(context: vscode.ExtensionContext): void {
  secretStorage = context.secrets;
  statusBar = createStatusBar();

  context.subscriptions.push(
    { dispose: () => statusBar.dispose() },
    vscode.commands.registerCommand('kimiLimits.showDetails', showDetailsPanel),
    vscode.commands.registerCommand('kimiLimits.setApiKey', setApiKey),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('kimiLimits')) {
        return;
      }

      if (event.affectsConfiguration('kimiLimits.alignment')) {
        statusBar.dispose();
        statusBar = createStatusBar();
      }
      if (event.affectsConfiguration('kimiLimits.refreshIntervalSeconds')) {
        startTimer();
      }

      renderStatusBar();
      updateDetailsPanel();

      if (
        event.affectsConfiguration('kimiLimits.apiHost') ||
        event.affectsConfiguration('kimiLimits.claudeSettingsPath')
      ) {
        void refreshUsage();
      }
    }),
    {
      dispose: () => {
        if (refreshTimer) {
          clearInterval(refreshTimer);
        }
        detailsPanel?.dispose();
      }
    }
  );

  startTimer();
  renderStatusBar();
  void refreshUsage();
}

function createStatusBar(): vscode.StatusBarItem {
  const configuredAlignment = vscode.workspace
    .getConfiguration('kimiLimits')
    .get<string>('alignment', 'right');
  const alignment = configuredAlignment === 'left'
    ? vscode.StatusBarAlignment.Left
    : vscode.StatusBarAlignment.Right;
  const item = vscode.window.createStatusBarItem(alignment, 100);
  item.command = 'kimiLimits.showDetails';
  item.show();
  return item;
}

function startTimer(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
  const configuredSeconds = vscode.workspace
    .getConfiguration('kimiLimits')
    .get('refreshIntervalSeconds', 60);
  const seconds = Math.max(30, configuredSeconds);
  refreshTimer = setInterval(() => void refreshUsage(), seconds * 1000);
}

async function setApiKey(): Promise<void> {
  const input = await vscode.window.showInputBox({
    title: localize('Kimi Limits: Установить API-ключ', 'Kimi Limits: Set API Key'),
    prompt: localize('Введите API-ключ Kimi Code', 'Enter the Kimi Code API key'),
    password: true,
    ignoreFocusOut: true,
    validateInput: value => value.trim()
      ? undefined
      : localize('Введите непустой ключ', 'Enter a non-empty key')
  });
  if (input === undefined) {
    return;
  }

  await secretStorage.store(SECRET_KEY, input.trim());
  if (activeRefresh) {
    await activeRefresh;
  }
  await refreshUsage();
}

function refreshUsage(): Promise<void> {
  if (activeRefresh) {
    return activeRefresh;
  }

  activeRefresh = performRefresh().finally(() => {
    activeRefresh = undefined;
  });
  return activeRefresh;
}

async function performRefresh(): Promise<void> {
  try {
    const key = await readApiKey();
    if (!key) {
      errorKind = 'no-key';
      return;
    }

    lastSnapshot = await requestUsage(key);
    errorKind = undefined;
  } catch (error) {
    errorKind = error instanceof AuthError
      ? 'auth'
      : error instanceof InvalidResponseError
        ? 'data'
        : 'network';
  } finally {
    renderStatusBar();
    updateDetailsPanel();
  }
}

async function readApiKey(): Promise<string | undefined> {
  const storedKey = await secretStorage.get(SECRET_KEY);
  if (storedKey?.trim()) {
    return storedKey.trim();
  }

  const configuredPath = vscode.workspace
    .getConfiguration('kimiLimits')
    .get('claudeSettingsPath', '~/.claude/settings.json');
  const settingsPath = configuredPath.replace(/^~(?=\/|$)/, os.homedir());

  try {
    const contents = await readFile(settingsPath, 'utf8');
    const settings = JSON.parse(contents) as {
      env?: { ANTHROPIC_API_KEY?: unknown };
    };
    const key = settings.env?.ANTHROPIC_API_KEY;
    return typeof key === 'string' && key.trim() ? key.trim() : undefined;
  } catch {
    return undefined;
  }
}

function requestUsage(key: string): Promise<UsageSnapshot> {
  return new Promise((resolve, reject) => {
    const host = vscode.workspace
      .getConfiguration('kimiLimits')
      .get('apiHost', 'api.kimi.ai');
    const request = https.request({
      protocol: 'https:',
      hostname: host,
      port: 443,
      path: '/coding/v1/usages',
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json'
      },
      timeout: 10_000
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode === 401 || response.statusCode === 403) {
          reject(new AuthError('Authentication failed'));
          return;
        }
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode ?? 'unknown'}`));
          return;
        }

        try {
          resolve(parseUsageResponse(JSON.parse(body)));
        } catch {
          reject(new InvalidResponseError('Invalid API response'));
        }
      });
    });

    request.on('timeout', () => {
      request.destroy(new Error('Request timed out'));
    });
    request.on('error', reject);
    request.end();
  });
}

function parseUsageResponse(value: unknown): UsageSnapshot {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid API response');
  }

  const data = value as {
    usages?: {
      limit_5h?: ApiUsageWindow;
      limit_month_total?: ApiUsageWindow;
    };
    limits?: ApiRateEntry[];
  };
  const fiveHour = data.usages?.limit_5h;
  const month = data.usages?.limit_month_total;
  const hasResetTime =
    (typeof fiveHour?.reset_time === 'string' && fiveHour.reset_time.length > 0) ||
    (typeof month?.reset_time === 'string' && month.reset_time.length > 0);
  if (!hasResetTime) {
    throw new InvalidResponseError('Usage response has no reset time');
  }

  let rate: RateWindow | undefined;
  const rawRate = data.limits?.[0];
  if (rawRate) {
    const limit = asFiniteNumber(rawRate.detail?.limit);
    const used = asFiniteNumber(rawRate.detail?.used);
    const duration = asFiniteNumber(rawRate.window?.duration);
    if (
      limit !== undefined && limit > 0 &&
      used !== undefined && used >= 0 &&
      duration !== undefined && duration > 0 &&
      rawRate.window?.timeUnit === 'TIME_UNIT_MINUTE'
    ) {
      rate = { limit, used, durationMinutes: duration };
    }
  }

  return {
    fiveHour: {
      usedRatio: requireRatio(fiveHour?.used_ratio),
      resetTime: typeof fiveHour?.reset_time === 'string' ? fiveHour.reset_time : undefined
    },
    month: {
      usedRatio: requireRatio(month?.used_ratio),
      resetTime: typeof month?.reset_time === 'string' ? month.reset_time : undefined
    },
    rate,
    updatedAt: Date.now()
  };
}

function requireRatio(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('Invalid usage ratio');
  }
  return value;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function renderStatusBar(): void {
  const snapshot = lastSnapshot;
  const currentError = errorKind;

  if (currentError) {
    statusBar.text = `⚠ ${ERROR_LABELS[currentError]}`;
    statusBar.color = new vscode.ThemeColor('charts.red');
    const tooltip = [ERROR_LABELS[currentError]];
    if (currentError === 'no-key') {
      tooltip.push(localize(
        'Выполните команду «Kimi Limits: Установить API-ключ» или настройте файл Claude',
        'Run "Kimi Limits: Set API Key" or configure the Claude settings file'
      ));
    } else if (currentError === 'auth') {
      tooltip.push(localize(
        'API ответил 401/403. Проверьте или замените API-ключ',
        'API returned 401/403. Check or replace the API key'
      ));
    } else if (currentError === 'data') {
      tooltip.push(localize(
        'API вернул пустой ответ или ответ без корректных лимитов',
        'API returned an empty response or a response without valid limits'
      ));
    } else {
      tooltip.push(localize('Не удалось выполнить запрос к API', 'Failed to call the API'));
    }
    if (snapshot) {
      tooltip.push(
        `${localize('Последние данные', 'Last data')}: ${formatTime(snapshot.updatedAt)} (${formatAge(snapshot.updatedAt)})`,
        ...formatSnapshotLines(snapshot)
      );
    }
    statusBar.tooltip = tooltip.join('\n');
    return;
  }

  if (!snapshot) {
    statusBar.text = 'K $(watch)— $(calendar)—';
    statusBar.color = undefined;
    statusBar.tooltip = localize('Загрузка лимитов Kimi Code…', 'Loading Kimi Code limits…');
    return;
  }

  const fiveHourPercent = Math.round(snapshot.fiveHour.usedRatio * 100);
  const monthPercent = Math.round(snapshot.month.usedRatio * 100);
  statusBar.text = `K $(watch)${fiveHourPercent}% $(calendar)${monthPercent}%`;

  const config = vscode.workspace.getConfiguration('kimiLimits');
  const warnPercent = config.get('warnPercent', 60);
  const errorPercent = config.get('errorPercent', 85);
  const worstPercent = Math.max(snapshot.fiveHour.usedRatio, snapshot.month.usedRatio) * 100;
  statusBar.color = new vscode.ThemeColor(
    worstPercent > errorPercent
      ? 'charts.red'
      : worstPercent >= warnPercent
        ? 'charts.yellow'
        : 'charts.green'
  );
  statusBar.tooltip = [
    `Kimi Code — ${localize('лимиты', 'limits')}`,
    `${localize('Обновлено', 'Updated')} ${formatTime(snapshot.updatedAt)}`,
    ...formatSnapshotLines(snapshot)
  ].join('\n');
}

function formatSnapshotLines(snapshot: UsageSnapshot): string[] {
  const lines = [
    `${localize('5ч-окно', '5h window')}: ${formatRatio(snapshot.fiveHour.usedRatio)}, ${formatReset(snapshot.fiveHour.resetTime, 'time')}`,
    `${localize('Месяц', 'Month')}: ${formatRatio(snapshot.month.usedRatio)}, ${formatReset(snapshot.month.resetTime, 'date')}`
  ];
  const showRate = vscode.workspace
    .getConfiguration('kimiLimits')
    .get('showRateWindow', true);
  if (showRate && snapshot.rate) {
    lines.push(
      `${localize('Rate-окно', 'Rate window')}: ${snapshot.rate.used}/${snapshot.rate.limit} ${localize('запросов за', 'requests per')} ${snapshot.rate.durationMinutes} ${localize('мин', 'min')}`
    );
  }
  return lines;
}

function showDetailsPanel(): void {
  if (detailsPanel) {
    updateDetailsPanel();
    detailsPanel.show();
    return;
  }

  const panel = vscode.window.createQuickPick<vscode.QuickPickItem>();
  detailsPanel = panel;
  panel.onDidAccept(() => {
    const selected = panel.selectedItems[0] ?? panel.activeItems[0];
    if (panel.busy || selected?.label !== REFRESH_LABEL) {
      return;
    }

    panel.busy = true;
    void refreshUsage().finally(() => {
      if (detailsPanel === panel) {
        panel.busy = false;
      }
    });
  });
  panel.onDidHide(() => {
    if (detailsPanel === panel) {
      detailsPanel = undefined;
    }
    panel.dispose();
  });
  updateDetailsPanel();
  panel.show();
}

function updateDetailsPanel(): void {
  if (!detailsPanel) {
    return;
  }

  detailsPanel.title = lastSnapshot
    ? `Kimi Code — ${localize('лимиты', 'limits')} · ${localize('обновлено', 'updated')} ${formatTime(lastSnapshot.updatedAt)}`
    : `Kimi Code — ${localize('лимиты', 'limits')}`;
  detailsPanel.items = buildDetailItems();
}

function buildDetailItems(): vscode.QuickPickItem[] {
  const items: vscode.QuickPickItem[] = [];
  const snapshot = lastSnapshot;

  if (errorKind) {
    const description = errorKind === 'no-key'
      ? localize(
        'Задайте ключ командой «Kimi Limits: Установить API-ключ» или в файле настроек Claude',
        'Set the key with "Kimi Limits: Set API Key" or in the Claude settings file'
      )
      : errorKind === 'auth'
        ? localize(
          'API ответил 401/403. Проверьте или замените API-ключ',
          'API returned 401/403. Check or replace the API key'
        )
        : errorKind === 'data'
          ? localize(
            'API вернул пустой ответ или ответ без корректных лимитов',
            'API returned an empty response or a response without valid limits'
          )
          : localize(
            'Запрос не удался. Проверьте сеть и попробуйте обновить данные',
            'Request failed. Check your connection and try refreshing the data'
          );
    items.push({ label: `⚠ ${ERROR_LABELS[errorKind]}`, description });
  }

  if (snapshot) {
    if (items.length > 0) {
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    }
    items.push(
      {
        label: `${localize('5ч-окно', '5h window')}   ${createBar(snapshot.fiveHour.usedRatio)}  ${formatRatio(snapshot.fiveHour.usedRatio)}`,
        description: formatReset(snapshot.fiveHour.resetTime, 'time')
      },
      {
        label: `${localize('Месяц', 'Month')}     ${createBar(snapshot.month.usedRatio)}  ${formatRatio(snapshot.month.usedRatio)}`,
        description: formatReset(snapshot.month.resetTime, 'date')
      }
    );
    if (snapshot.rate) {
      items.push({
        label: `${localize('Rate-окно', 'Rate window')} ${createBar(snapshot.rate.used / snapshot.rate.limit)}  ${snapshot.rate.used}/${snapshot.rate.limit} ${localize('запросов за', 'requests per')} ${snapshot.rate.durationMinutes} ${localize('мин', 'min')}`
      });
    }
  } else {
    items.push({
      label: errorKind
        ? localize('Данные ещё не получены', 'No data yet')
        : localize('Загрузка данных…', 'Loading data…')
    });
  }

  items.push(
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: REFRESH_LABEL }
  );
  return items;
}

function createBar(ratio: number): string {
  const configuredLength = vscode.workspace
    .getConfiguration('kimiLimits')
    .get('barLength', 10);
  const length = Math.max(1, Math.round(configuredLength));
  const filled = Math.min(length, Math.max(0, Math.round(ratio * length)));
  return '▰'.repeat(filled) + '▱'.repeat(length - filled);
}

function formatRatio(ratio: number): string {
  return `${(ratio * 100).toFixed(1)} %`;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(LOCALE, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function formatAge(timestamp: number): string {
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (elapsedMinutes < 1) {
    return localize('менее минуты назад', 'less than a minute ago');
  }
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes} ${localize('мин назад', 'min ago')}`;
  }
  const hours = Math.floor(elapsedMinutes / 60);
  return `${hours} ${localize('ч', 'h')} ${elapsedMinutes % 60} ${localize('мин назад', 'min ago')}`;
}

function formatReset(resetTime: string | undefined, format: 'time' | 'date'): string {
  if (!resetTime) {
    return localize('время сброса неизвестно', 'reset time unknown');
  }

  const reset = new Date(resetTime);
  if (Number.isNaN(reset.getTime())) {
    return localize('время сброса неизвестно', 'reset time unknown');
  }

  const absolute = format === 'time'
    ? reset.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })
    : reset.toLocaleDateString(LOCALE);
  const remaining = reset.getTime() - Date.now();
  if (remaining <= 0) {
    return `${localize('сброс', 'reset')} ${absolute} (${localize('срок истёк', 'expired')})`;
  }

  if (format === 'date') {
    const days = Math.ceil(remaining / 86_400_000);
    return `${localize('сброс', 'reset')} ${absolute} (${localize('через', 'in')} ${days} ${localize('дн', 'd')})`;
  }

  const totalMinutes = Math.ceil(remaining / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const relative = hours > 0
    ? `${hours} ${localize('ч', 'h')} ${minutes} ${localize('мин', 'min')}`
    : `${minutes} ${localize('мин', 'min')}`;
  return `${localize('сброс', 'reset')} ${absolute} (${localize('через', 'in')} ${relative})`;
}
