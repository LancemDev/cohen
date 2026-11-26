import { buildHeuristicVerdict, mergeVerdicts } from '../signals/verdict';
import { isFirebaseConfigured } from '../config/firebase';
import { log, setDebugLogging, sleep } from '../utils/core';
import { onBackgroundMessage } from '../utils/messaging';
import {
  clearVerdictCache,
  getChannelTrustFor,
  getSettings,
  getVerdict,
  overrideVerdict,
  putVerdict,
  setChannelTrust,
  setSettings,
} from '../storage/store';
import type {
  BackgroundMessage,
  CaptureResult,
  Settings,
  TrackMetadata,
  Verdict,
} from '../utils/types';

const OFFSCREEN_URL = 'offscreen/offscreen.html';

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  setDebugLogging(settings.debugLogging);
  log.info('Cohen installed', { version: chrome.runtime.getManifest().version });
});

chrome.runtime.onStartup?.addListener(async () => {
  const settings = await getSettings();
  setDebugLogging(settings.debugLogging);
});

onBackgroundMessage(async (message: BackgroundMessage, sender) => {
  const settings = await getSettings();
  setDebugLogging(settings.debugLogging);
  log.debug('background message', message.type);

  switch (message.type) {
    case 'PING':
      return { ok: true, version: chrome.runtime.getManifest().version };
    case 'GET_SETTINGS':
      return { ok: true, settings };
    case 'SET_SETTINGS': {
      const next = await setSettings(message.settings);
      setDebugLogging(next.debugLogging);
      return { ok: true, settings: next };
    }
    case 'CLEAR_CACHE':
      await clearVerdictCache();
      return { ok: true };
    case 'GET_VERDICT': {
      const verdict = await getVerdict(message.videoId);
      return { ok: true, verdict: verdict && isFresh(verdict, settings) ? verdict : null };
    }
    case 'OVERRIDE_VERDICT': {
      const verdict = await overrideVerdict(message.videoId, message.label);
      return { ok: true, verdict };
    }
    case 'TRUST_CHANNEL': {
      const trust = await setChannelTrust(message.channelId, message.trusted);
      return { ok: true, trust };
    }
    case 'CLASSIFY_TRACK':
      log.info('classify request', message.metadata.videoId, message.metadata.title);
      return classifyTrack(message.metadata, settings, message.audioFeatures, message.forceCloud);
    case 'DEEP_SCAN': {
      const tabId = message.tabId || sender.tab?.id;
      if (!tabId) return { ok: false, error: 'Missing tabId for deep scan' };
      return { ok: false, error: 'Use DEEP_SCAN_WITH_METADATA with track metadata' };
    }
    case 'DEEP_SCAN_WITH_METADATA': {
      const tabId = message.tabId || sender.tab?.id;
      if (!tabId) return { ok: false, error: 'Missing tabId for deep scan' };
      log.info('deep scan request', message.metadata.videoId, tabId);
      return deepScan(message.metadata, tabId, settings);
    }
    default:
      return { ok: false, error: `Unknown message type: ${(message as { type?: string }).type}` };
  }
});

async function classifyTrack(
  metadata: TrackMetadata,
  settings: Settings,
  audioFeatures?: import('../utils/types').AudioFeatures,
  forceCloud?: boolean,
): Promise<{ ok: boolean; verdict?: Verdict; error?: string }> {
  try {
    const channelTrust = await getChannelTrustFor(metadata.channelId);
    const heuristic = buildHeuristicVerdict(metadata, settings, audioFeatures, channelTrust);

    // Hard trust/block decisions short-circuit.
    if (channelTrust) {
      await putVerdict(heuristic, settings.cacheTtlHours);
      return { ok: true, verdict: heuristic };
    }

    const cached = await getVerdict(metadata.videoId);
    if (cached && !forceCloud && !audioFeatures && isFresh(cached, settings)) {
      return { ok: true, verdict: cached };
    }

    let verdict = heuristic;

    if (isFirebaseConfigured()) {
      try {
        await ensureOffscreen();
        let modelResult = (await chrome.runtime.sendMessage({
          type: 'OFFSCREEN_CLASSIFY',
          metadata,
          audioFeatures,
          settings,
        })) as { ok: boolean; verdict?: Verdict; error?: string };
        if (modelResult?.error?.includes('Unknown offscreen message')) {
          log.warn('Stale offscreen document detected, recreating');
          await resetOffscreen().catch(() => undefined);
          await ensureOffscreen();
          modelResult = (await chrome.runtime.sendMessage({
            type: 'OFFSCREEN_CLASSIFY',
            metadata,
            audioFeatures,
            settings,
          })) as { ok: boolean; verdict?: Verdict; error?: string };
        }
        if (modelResult?.ok && modelResult.verdict) {
          verdict = mergeVerdicts(heuristic, modelResult.verdict, settings);
        } else {
          log.warn('Model classification unavailable, using heuristics', modelResult?.error);
          verdict = {
            ...heuristic,
            reasons: [
              ...heuristic.reasons,
              modelResult?.error ? `Model unavailable: ${modelResult.error}` : 'Model unavailable; using heuristic signals only.',
            ].slice(0, 6),
          };
        }
      } catch (err) {
        log.warn('Classification fell back to heuristics', err);
        verdict = {
          ...heuristic,
          reasons: [...heuristic.reasons, 'Model classification failed; using heuristic signals only.'].slice(0, 6),
        };
      }
    } else {
      verdict = {
        ...heuristic,
        summary: `${heuristic.summary} (Firebase not configured)`,
        reasons: [...heuristic.reasons, 'Configure Firebase AI Logic for on-device/cloud model classification.'].slice(0, 6),
      };
    }

    log.info('classify complete', metadata.videoId, verdict.label, verdict.source);
    await putVerdict(verdict, settings.cacheTtlHours);
    return { ok: true, verdict };
  } catch (err) {
    log.error('classifyTrack failed', err);
    try {
      const channelTrust = await getChannelTrustFor(metadata.channelId).catch(() => null);
      const fallback = buildHeuristicVerdict(metadata, settings, audioFeatures, channelTrust);
      fallback.reasons = [
        ...fallback.reasons,
        'Classification encountered an error; showing heuristic estimate.',
      ].slice(0, 6);
      await putVerdict(fallback, settings.cacheTtlHours).catch(() => undefined);
      return { ok: true, verdict: fallback };
    } catch {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

async function deepScan(
  metadata: TrackMetadata,
  tabId: number,
  settings: Settings,
): Promise<{ ok: boolean; verdict?: Verdict; error?: string }> {
  try {
    await ensureOffscreen();
    let streamId: string;
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not been invoked/i.test(msg)) {
        return {
          ok: false,
          error: 'Open the Cohen extension popup on this YouTube tab, then start Deep scan from the popup.',
        };
      }
      if (/chrome pages cannot be captured|cannot be captured/i.test(msg)) {
        return {
          ok: false,
          error: 'Chrome cannot capture audio from this page. Open a regular YouTube video tab and try again.',
        };
      }
      throw err;
    }
    let capture = (await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_CAPTURE_AUDIO',
      streamId,
      durationMs: 10000,
      includeAudio: settings.cloudEscalation,
    })) as CaptureResult;
    if (capture?.error?.includes('Unknown offscreen message')) {
      await resetOffscreen().catch(() => undefined);
      await ensureOffscreen();
      capture = (await chrome.runtime.sendMessage({
        type: 'OFFSCREEN_CAPTURE_AUDIO',
        streamId,
        durationMs: 10000,
        includeAudio: settings.cloudEscalation,
      })) as CaptureResult;
    }

    if (!capture.ok || !capture.features) {
      return { ok: false, error: capture.error || 'Audio capture failed' };
    }

    const channelTrust = await getChannelTrustFor(metadata.channelId);
    const heuristic = buildHeuristicVerdict(metadata, settings, capture.features, channelTrust);
    if (channelTrust) {
      await putVerdict(heuristic, settings.cacheTtlHours);
      return { ok: true, verdict: heuristic };
    }

    let verdict = heuristic;
    if (isFirebaseConfigured()) {
      let modelResult = (await chrome.runtime.sendMessage({
        type: 'OFFSCREEN_CLASSIFY',
        metadata,
        audioFeatures: capture.features,
        audioBase64: settings.cloudEscalation ? capture.audioBlobBase64 : undefined,
        audioMimeType: settings.cloudEscalation ? capture.mimeType : undefined,
        settings,
      })) as { ok: boolean; verdict?: Verdict; error?: string };
      if (modelResult?.error?.includes('Unknown offscreen message')) {
        await resetOffscreen().catch(() => undefined);
        await ensureOffscreen();
        modelResult = (await chrome.runtime.sendMessage({
          type: 'OFFSCREEN_CLASSIFY',
          metadata,
          audioFeatures: capture.features,
          audioBase64: settings.cloudEscalation ? capture.audioBlobBase64 : undefined,
          audioMimeType: settings.cloudEscalation ? capture.mimeType : undefined,
          settings,
        })) as { ok: boolean; verdict?: Verdict; error?: string };
      }

      if (modelResult?.ok && modelResult.verdict) {
        verdict = mergeVerdicts(heuristic, modelResult.verdict, settings);
        verdict.audioAnalyzed = true;
      } else {
        verdict = {
          ...heuristic,
          audioAnalyzed: true,
          reasons: [...heuristic.reasons, modelResult?.error || 'Model unavailable during deep scan.'].slice(0, 6),
        };
      }
    } else {
      verdict = { ...heuristic, audioAnalyzed: true };
    }

    log.info('deep scan complete', metadata.videoId, verdict.label, verdict.source);
    await putVerdict(verdict, settings.cacheTtlHours);
    return { ok: true, verdict };
  } catch (err) {
    log.error('deepScan failed', err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function isFresh(verdict: Verdict, settings: Settings): boolean {
  const ageMs = Date.now() - verdict.analyzedAt;
  return ageMs < settings.cacheTtlHours * 60 * 60 * 1000;
}

let offscreenPromise: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  if (offscreenPromise) return offscreenPromise;
  offscreenPromise = createOrWaitForOffscreen().finally(() => {
    offscreenPromise = null;
  });
  return offscreenPromise;
}

async function resetOffscreen(): Promise<void> {
  offscreenPromise = null;
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // No offscreen document to close, or it is already closing.
  }
}

async function createOrWaitForOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (existing.length === 0) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.AUDIO_PLAYBACK],
      justification: 'Capture tab audio for analysis and run Firebase AI Logic inference in a document context.',
    });
  }

  // createDocument() resolves before the document script has necessarily
  // registered its message listener. Wait for a ping so the first classify or
  // capture request is not lost.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      const pong = (await chrome.runtime.sendMessage({ type: 'OFFSCREEN_PING' })) as
        | { ok?: boolean }
        | undefined;
      if (pong?.ok) return;
    } catch {
      // The offscreen document is still loading.
    }
    await sleep(100);
  }
}
