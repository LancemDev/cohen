import type { Settings } from '../utils/types';
import { getChannelTrust, setChannelTrust } from '../storage/store';
import { clearLogs, getLogs, type LogEntry } from '../utils/core';

const ids = [
  'enabled', 'showBadge', 'autoMuteAi', 'autoSkipAi', 'cloudEscalation', 'debugLogging',
] as const;
const numIds = ['aiThreshold', 'uncertainThreshold', 'minAiConfidence', 'cacheTtlHours'] as const;

const status = document.getElementById('status') as HTMLElement;
const saveBtn = document.getElementById('save') as HTMLButtonElement;
const clearBtn = document.getElementById('clear-cache') as HTMLButtonElement;
const rulesEl = document.getElementById('channel-rules') as HTMLElement;
const rulesEmpty = document.getElementById('rules-empty') as HTMLElement;
const logsEl = document.getElementById('log-output') as HTMLElement;
const refreshLogsBtn = document.getElementById('refresh-logs') as HTMLButtonElement;
const copyLogsBtn = document.getElementById('copy-logs') as HTMLButtonElement;
const clearLogsBtn = document.getElementById('clear-logs') as HTMLButtonElement;

init().catch((err) => setStatus(err instanceof Error ? err.message : String(err)));

async function init(): Promise<void> {
  const res = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  const settings = res.settings as Settings;
  load(settings);
  await renderChannelRules();
  await renderLogs();

  refreshLogsBtn.addEventListener('click', async () => {
    await renderLogs();
    setStatus('Logs refreshed.');
  });

  copyLogsBtn.addEventListener('click', async () => {
    try {
      await copyText(logsEl.textContent ?? '');
      setStatus('Logs copied.');
    } catch {
      setStatus('Could not copy logs.');
    }
  });

  clearLogsBtn.addEventListener('click', async () => {
    await clearLogs();
    logsEl.textContent = 'No logs yet.';
    setStatus('Logs cleared.');
  });

  saveBtn.addEventListener('click', async () => {
    const patch = collect();
    await chrome.runtime.sendMessage({ type: 'SET_SETTINGS', settings: patch });
    setStatus('Settings saved.');
  });

  clearBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
    setStatus('Verdict cache cleared.');
  });
}

async function renderChannelRules(): Promise<void> {
  const trust = await getChannelTrust();
  const entries = Object.entries(trust).sort(([a], [b]) => a.localeCompare(b));
  rulesEl.innerHTML = '';
  rulesEmpty.hidden = entries.length > 0;

  for (const [channelId, kind] of entries) {
    const row = document.createElement('div');
    row.className = 'rule';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = channelId;
    name.title = channelId;

    const badge = document.createElement('span');
    badge.className = `status ${kind}`;
    badge.textContent = kind;

    const remove = document.createElement('button');
    remove.className = 'btn small';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      await setChannelTrust(channelId, null);
      await renderChannelRules();
      await refreshYouTubeTabs();
      setStatus('Channel rule removed.');
    });

    row.append(name, badge, remove);
    rulesEl.appendChild(row);
  }
}

async function refreshYouTubeTabs(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({
      url: ['https://www.youtube.com/*', 'https://music.youtube.com/*'],
    });
    await Promise.all(
      tabs.map((tab) =>
        tab.id
          ? chrome.tabs.sendMessage(tab.id, { type: 'COHEN_REFRESH' }).catch(() => undefined)
          : undefined,
      ),
    );
  } catch {
    // The rules are still saved; an open tab will refresh on its next navigation.
  }
}

async function renderLogs(): Promise<void> {
  const logs = await getLogs();
  logsEl.textContent = logs.length ? logs.map(formatLog).join('\n') : 'No logs yet.';
  logsEl.scrollTop = logsEl.scrollHeight;
}

function formatLog(entry: LogEntry): string {
  const time = new Date(entry.at).toLocaleTimeString();
  return `[${time}] [${entry.level.toUpperCase()}] [${entry.context}] ${entry.message}`;
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();
  if (!ok) throw new Error('Copy failed');
}

function load(settings: Settings): void {
  for (const id of ids) (document.getElementById(id) as HTMLInputElement).checked = settings[id];
  for (const id of numIds) (document.getElementById(id) as HTMLInputElement).value = String(settings[id]);
}

function collect(): Partial<Settings> {
  const patch: Partial<Settings> = {};
  for (const id of ids) patch[id] = (document.getElementById(id) as HTMLInputElement).checked;
  for (const id of numIds) {
    const raw = (document.getElementById(id) as HTMLInputElement).value;
    const num = Number(raw);
    if (!Number.isNaN(num)) (patch as any)[id] = num;
  }
  return patch;
}

function setStatus(msg: string): void {
  status.textContent = msg;
}
