import { ensureBadge, removeBadge, setBadgeError, setBadgeHidden, setBadgeLoading, setBadgeVerdict } from './badge';
import { extractTrackMetadata, getCurrentVideoId, waitForMetadata } from './metadata';
import { log, setDebugLogging, withTimeout } from '../utils/core';
import type { BackgroundMessage, Settings, TrackMetadata, Verdict } from '../utils/types';

let currentVideoId: string | null = null;
let currentMetadata: TrackMetadata | null = null;
let currentVerdict: Verdict | null = null;
let settings: Settings | null = null;
let mutedByCohen = false;
let navigationToken = 0;

init().catch((err) => console.error('[cohen] init failed', err));

async function init(): Promise<void> {
  settings = await requestSettings();
  setDebugLogging(settings.debugLogging);
  log.debug('initialized');
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings?.newValue) {
      const previous = settings;
      settings = changes.settings.newValue as Settings;
      setDebugLogging(settings.debugLogging);
      if (!previous?.enabled && settings.enabled) {
        currentVideoId = null;
        void onNavigation();
        return;
      }
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
      if (!currentMetadata || !currentVideoId) {
        sendResponse({ ok: false, error: 'Track metadata is still loading. Try again in a moment.' });
        return false;
      }
      void runDeepScan();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === 'COHEN_REFRESH') {
      currentVideoId = null;
      void onNavigation();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
  void onNavigation();
}

async function onNavigation(): Promise<void> {
  const videoId = getCurrentVideoId();
  if (!videoId) {
    navigationToken += 1;
    currentVideoId = null;
    currentMetadata = null;
    currentVerdict = null;
    restoreMute();
    removeBadge();
    return;
  }
  if (videoId === currentVideoId) return;
  const token = ++navigationToken;
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
  if (token !== navigationToken || !metadata || metadata.videoId !== currentVideoId) return;
  currentMetadata = metadata;

  setBadgeLoading('Classifying track…');
  log.debug('classification started', videoId, metadata.title);
  try {
    const response = await withTimeout(
      sendMessage<{ ok: boolean; verdict?: Verdict; error?: string }>({
        type: 'CLASSIFY_TRACK',
        metadata,
      }),
      30000,
      'Classification',
    );

    if (token !== navigationToken || metadata.videoId !== currentVideoId) return;
    log.debug('classification response', videoId, response?.ok, response?.verdict?.label, response?.error);
    if (!response?.ok || !response.verdict) {
      setBadgeError(response?.error || 'Classification failed');
      return;
    }

    currentVerdict = response.verdict;
    if (settings) setBadgeVerdict(response.verdict, settings);
    applyVerdictActions(response.verdict);
  } catch (err) {
    if (token !== navigationToken || metadata.videoId !== currentVideoId) return;
    const message = err instanceof Error ? err.message : String(err);
    log.warn('classification failed', videoId, message);
    setBadgeError(message.includes('timed out') ? 'Classification timed out. Try again.' : message);
  }
}

let deepScanInFlight = false;

async function runDeepScan(): Promise<void> {
  if (deepScanInFlight) return;
  if (!currentMetadata || !currentVideoId) {
    setBadgeError('Wait for the track to finish loading, then try again.');
    return;
  }
  const metadata = currentMetadata;
  const scannedVideoId = currentVideoId;
  const scanToken = navigationToken;
  deepScanInFlight = true;
  setBadgeLoading('Capturing audio for deep scan…');
  try {
    settings = settings ?? (await requestSettings());
    log.debug('deep scan started', scannedVideoId);
    const response = await withTimeout(
      sendMessage<{ ok: boolean; verdict?: Verdict; error?: string }>({
        type: 'DEEP_SCAN_WITH_METADATA',
        metadata,
      }),
      120000,
      'Deep scan',
    );
    if (scanToken !== navigationToken || scannedVideoId !== currentVideoId) return;
    log.debug('deep scan response', scannedVideoId, response?.ok, response?.verdict?.label, response?.error);
    if (!response?.ok || !response.verdict) {
      setBadgeError(response?.error || 'Deep scan failed');
      return;
    }
    currentVerdict = response.verdict;
    if (settings) setBadgeVerdict(response.verdict, settings);
    applyVerdictActions(response.verdict);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('deep scan failed', scannedVideoId, message);
    setBadgeError(message.includes('timed out') ? 'Deep scan timed out. Try again.' : message);
  } finally {
    deepScanInFlight = false;
  }
}

async function overrideVerdict(label: 'human' | 'ai' | 'uncertain' | 'unverified'): Promise<void> {
  if (!currentVideoId || label === 'unverified') return;
  const videoId = currentVideoId;
  const token = navigationToken;
  const response = await sendMessage<{ ok: boolean; verdict?: Verdict }>(
    { type: 'OVERRIDE_VERDICT', videoId, label } as BackgroundMessage,
  );
  if (token !== navigationToken || videoId !== currentVideoId) return;
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
  // Do not mute or skip YouTube ads; only act on the requested track.
  if (document.querySelector('.ad-showing')) return;

  const shouldAct = verdict.label === 'ai';
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
  const response = await withTimeout(
    sendMessage<{ ok: boolean; settings: Settings }>({ type: 'GET_SETTINGS' } as BackgroundMessage),
    10000,
    'Settings request',
  );
  return response.settings;
}

function sendMessage<T>(message: BackgroundMessage | Record<string, unknown>): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}
