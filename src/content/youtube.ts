import { ensureBadge, removeBadge, setBadgeError, setBadgeHidden, setBadgeLoading, setBadgeVerdict } from './badge';
import { extractTrackMetadata, getCurrentVideoId, waitForMetadata } from './metadata';
import type { BackgroundMessage, Settings, TrackMetadata, Verdict } from '../utils/types';

let currentVideoId: string | null = null;
let currentMetadata: TrackMetadata | null = null;
let currentVerdict: Verdict | null = null;
let settings: Settings | null = null;
let mutedByCohen = false;

init().catch((err) => console.error('[cohen] init failed', err));

async function init(): Promise<void> {
  settings = await requestSettings();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings?.newValue) {
      settings = changes.settings.newValue as Settings;
      if (currentVerdict && settings) setBadgeVerdict(currentVerdict, settings);
      applyVerdictActions(currentVerdict);
      updateBadgeVisibility();
    }
  });

  document.addEventListener('yt-navigate-finish', () => void onNavigation());
  document.addEventListener('yt-page-data-updated', () => void onNavigation());
  window.addEventListener('popstate', () => void onNavigation());
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'COHEN_DEEP_SCAN') {
      void runDeepScan();
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });
  void onNavigation();
}

async function onNavigation(): Promise<void> {
  const videoId = getCurrentVideoId();
  if (!videoId) {
    currentVideoId = null;
    currentMetadata = null;
    currentVerdict = null;
    restoreMute();
    removeBadge();
    return;
  }
  if (videoId === currentVideoId) return;
  currentVideoId = videoId;
  currentMetadata = null;
  currentVerdict = null;
  restoreMute();

  settings = settings ?? (await requestSettings());
  if (!settings.enabled) {
    removeBadge();
    return;
  }

  ensureBadge({
    onDeepScan: () => void runDeepScan(),
    onOverride: (label) => void overrideVerdict(label),
    onTrustChannel: () => void trustChannel(true),
    onBlockChannel: () => void trustChannel(false),
  });
  updateBadgeVisibility();
  setBadgeLoading('Reading track metadata…');

  const metadata = await waitForMetadata(12000);
  if (!metadata || metadata.videoId !== currentVideoId) return;
  currentMetadata = metadata;

  setBadgeLoading('Classifying track…');
  const response = await sendMessage<{ ok: boolean; verdict?: Verdict; error?: string }>({
    type: 'CLASSIFY_TRACK',
    metadata,
  });

  if (metadata.videoId !== currentVideoId) return;
  if (!response?.ok || !response.verdict) {
    setBadgeError(response?.error || 'Classification failed');
    return;
  }

  currentVerdict = response.verdict;
  if (settings) setBadgeVerdict(response.verdict, settings);
  applyVerdictActions(response.verdict);
}

async function runDeepScan(): Promise<void> {
  if (!currentMetadata || !currentVideoId) return;
  settings = settings ?? (await requestSettings());
  setBadgeLoading('Capturing audio for deep scan…');
  const response = await sendMessage<{ ok: boolean; verdict?: Verdict; error?: string }>({
    type: 'DEEP_SCAN_WITH_METADATA',
    metadata: currentMetadata,
  });
  if (!response?.ok || !response.verdict) {
    setBadgeError(response?.error || 'Deep scan failed');
    return;
  }
  currentVerdict = response.verdict;
  if (settings) setBadgeVerdict(response.verdict, settings);
  applyVerdictActions(response.verdict);
}

async function overrideVerdict(label: 'human' | 'ai' | 'uncertain'): Promise<void> {
  if (!currentVideoId) return;
  const response = await sendMessage<{ ok: boolean; verdict?: Verdict }>(
    { type: 'OVERRIDE_VERDICT', videoId: currentVideoId, label } as BackgroundMessage,
  );
  if (response?.ok && response.verdict) {
    currentVerdict = response.verdict;
    if (settings) setBadgeVerdict(response.verdict, settings);
    applyVerdictActions(response.verdict);
  }
}

async function trustChannel(trusted: boolean): Promise<void> {
  if (!currentMetadata?.channelId) return;
  await sendMessage({ type: 'TRUST_CHANNEL', channelId: currentMetadata.channelId, trusted } as BackgroundMessage);
  // Reclassify with updated trust.
  currentVideoId = null;
  await onNavigation();
}

function applyVerdictActions(verdict: Verdict | null): void {
  if (!settings?.enabled || !verdict) {
    restoreMute();
    return;
  }

  const video = document.querySelector<HTMLVideoElement>('video.html5-main-video, video');
  if (!video) return;

  const shouldAct = verdict.label === 'ai' && verdict.aiScore >= settings.aiThreshold;
  if (shouldAct && settings.autoMuteAi) {
    if (!video.muted) {
      video.muted = true;
      mutedByCohen = true;
    }
  } else {
    restoreMute(video);
  }

  if (shouldAct && settings.autoSkipAi) {
    const next = document.querySelector<HTMLButtonElement>('.ytp-next-button');
    if (next) next.click();
  }
}

function restoreMute(video?: HTMLVideoElement | null): void {
  const el = video ?? document.querySelector<HTMLVideoElement>('video.html5-main-video, video');
  if (el && mutedByCohen) {
    el.muted = false;
  }
  mutedByCohen = false;
}

function updateBadgeVisibility(): void {
  const show = Boolean(settings?.enabled && settings?.showBadge && getCurrentVideoId());
  if (!show) {
    setBadgeHidden(true);
    return;
  }
  if (!document.querySelector('.cohen-badge')) {
    // Badge will be created on next navigation; no-op.
  }
  setBadgeHidden(false);
}

async function requestSettings(): Promise<Settings> {
  const response = await sendMessage<{ ok: boolean; settings: Settings }>({ type: 'GET_SETTINGS' } as BackgroundMessage);
  return response.settings;
}

function sendMessage<T>(message: BackgroundMessage | Record<string, unknown>): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}
