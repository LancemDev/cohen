import type { Settings, Verdict } from '../utils/types';

const els = {
  enabled: document.getElementById('enabled') as HTMLInputElement,
  autoMuteAi: document.getElementById('autoMuteAi') as HTMLInputElement,
  autoSkipAi: document.getElementById('autoSkipAi') as HTMLInputElement,
  cloudEscalation: document.getElementById('cloudEscalation') as HTMLInputElement,
  trackLabel: document.getElementById('track-label') as HTMLElement,
  trackTitle: document.getElementById('track-title') as HTMLElement,
  trackSummary: document.getElementById('track-summary') as HTMLElement,
  trackReasons: document.getElementById('track-reasons') as HTMLUListElement,
  deepScan: document.getElementById('deep-scan') as HTMLButtonElement,
  openOptions: document.getElementById('open-options') as HTMLButtonElement,
  status: document.getElementById('status') as HTMLElement,
};

init().catch((err) => setStatus(err instanceof Error ? err.message : String(err)));

async function init(): Promise<void> {
  const settings = await getSettings();
  bindSettings(settings);
  await refreshTrack();

  els.deepScan.addEventListener('click', async () => {
    els.deepScan.disabled = true;
    setStatus('Running deep scan…');
    try {
      const tab = await getActiveYouTubeTab();
      if (!tab?.id) throw new Error('Open a YouTube video tab first.');
      const res = (await chrome.tabs.sendMessage(tab.id, { type: 'COHEN_DEEP_SCAN' })) as
        | { ok?: boolean; error?: string }
        | undefined;
      if (res && res.ok === false) throw new Error(res.error || 'Deep scan could not start.');
      setStatus('Deep scan started. Check the badge on the video.');
      setTimeout(() => void refreshTrack(), 2500);
      setTimeout(() => void refreshTrack(), 12000);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      els.deepScan.disabled = false;
    }
  });

  els.openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());
}

function bindSettings(settings: Settings): void {
  els.enabled.checked = settings.enabled;
  els.autoMuteAi.checked = settings.autoMuteAi;
  els.autoSkipAi.checked = settings.autoSkipAi;
  els.cloudEscalation.checked = settings.cloudEscalation;

  for (const key of ['enabled', 'autoMuteAi', 'autoSkipAi', 'cloudEscalation'] as const) {
    els[key].addEventListener('change', async () => {
      await chrome.runtime.sendMessage({
        type: 'SET_SETTINGS',
        settings: { [key]: els[key].checked },
      });
      setStatus('Settings saved.');
    });
  }
}

async function refreshTrack(): Promise<void> {
  const tab = await getActiveYouTubeTab();
  const videoId = tab?.url ? extractVideoId(tab.url) : null;
  if (!videoId) {
    renderVerdict(null);
    return;
  }
  const response = await chrome.runtime.sendMessage({ type: 'GET_VERDICT', videoId });
  renderVerdict(response?.verdict ?? null, tab?.title);
}

function renderVerdict(verdict: Verdict | null, tabTitle?: string): void {
  els.trackReasons.innerHTML = '';
  if (!verdict) {
    els.trackLabel.textContent = 'Unverified';
    els.trackLabel.className = 'pill';
    els.trackTitle.textContent = tabTitle?.replace(/ - YouTube$/, '') || 'Open a YouTube video to classify it.';
    els.trackSummary.textContent = 'No verdict cached yet. Play the track or run a deep scan.';
    return;
  }
  els.trackLabel.textContent = verdict.label.toUpperCase();
  els.trackLabel.className = `pill ${verdict.label}`;
  els.trackTitle.textContent = tabTitle?.replace(/ - YouTube$/, '') || verdict.videoId;
  const score = verdict.label === 'unverified'
    ? 'Neutral 50/100 baseline (no evidence)'
    : `Score ${verdict.aiScore}/100`;
  els.trackSummary.textContent = `${verdict.summary} ${score} · ${(verdict.confidence * 100).toFixed(0)}% confidence · ${verdict.source}.`;
  for (const reason of verdict.reasons.slice(0, 4)) {
    const li = document.createElement('li');
    li.textContent = reason;
    els.trackReasons.appendChild(li);
  }
}

async function getSettings(): Promise<Settings> {
  const res = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  return res.settings as Settings;
}

async function getActiveYouTubeTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && /youtube\.com\/(watch|shorts)/.test(tab.url)) return tab;
  return null;
}

function extractVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.pathname === '/watch') return u.searchParams.get('v');
    if (u.pathname.startsWith('/shorts/')) return u.pathname.split('/')[2] || null;
    return null;
  } catch {
    return null;
  }
}

function setStatus(message: string): void {
  els.status.textContent = message;
}
