import type { Settings } from '../utils/types';
import { getChannelTrust, setChannelTrust } from '../storage/store';

const ids = [
  'enabled', 'showBadge', 'autoMuteAi', 'autoSkipAi', 'cloudEscalation', 'debugLogging',
] as const;
const numIds = ['aiThreshold', 'uncertainThreshold', 'minAiConfidence', 'cacheTtlHours'] as const;

const status = document.getElementById('status') as HTMLElement;
const saveBtn = document.getElementById('save') as HTMLButtonElement;
const clearBtn = document.getElementById('clear-cache') as HTMLButtonElement;
const rulesEl = document.getElementById('channel-rules') as HTMLElement;
const rulesEmpty = document.getElementById('rules-empty') as HTMLElement;

init().catch((err) => setStatus(err instanceof Error ? err.message : String(err)));

async function init(): Promise<void> {
  const res = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  const settings = res.settings as Settings;
  load(settings);
  await renderChannelRules();

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
