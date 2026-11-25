import type { Settings } from '../utils/types';

const ids = [
  'enabled', 'showBadge', 'autoMuteAi', 'autoSkipAi', 'cloudEscalation', 'debugLogging',
] as const;
const numIds = ['aiThreshold', 'uncertainThreshold', 'cloudEscalationMinConfidence', 'cacheTtlHours'] as const;

const status = document.getElementById('status') as HTMLElement;
const saveBtn = document.getElementById('save') as HTMLButtonElement;
const clearBtn = document.getElementById('clear-cache') as HTMLButtonElement;

init().catch((err) => setStatus(err instanceof Error ? err.message : String(err)));

async function init(): Promise<void> {
  const res = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  const settings = res.settings as Settings;
  load(settings);

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
