import { classifyTrack } from '../ai/classifier';
import { isFirebaseConfigured } from '../config/firebase';
import { decodeAudioBlob, extractAudioFeatures } from '../audio/features';
import { encodeWav } from '../audio/wav';
import { log, setDebugLogging } from '../utils/core';
import type { CaptureResult, Settings, TrackMetadata } from '../utils/types';

interface ClassifyMessage {
  type: 'OFFSCREEN_CLASSIFY';
  metadata: TrackMetadata;
  audioFeatures?: import('../utils/types').AudioFeatures;
  audioBase64?: string;
  audioMimeType?: string;
  settings: Settings;
}

interface CaptureMessage {
  type: 'OFFSCREEN_CAPTURE_AUDIO';
  streamId: string;
  durationMs: number;
  includeAudio?: boolean;
}

type OffscreenRequest = ClassifyMessage | CaptureMessage | { type: 'OFFSCREEN_PING' };

chrome.runtime.onMessage.addListener((message: OffscreenRequest, _sender, sendResponse) => {
  const type = (message as { type?: string } | undefined)?.type;
  if (!type?.startsWith('OFFSCREEN_')) return false;

  setOffscreenStatus(`Handling ${type}`);
  appendOffscreenActivity(`received ${type}`);
  handle(message)
    .then((result) => {
      appendOffscreenActivity(`completed ${type}`);
      sendResponse(result);
    })
    .catch((err) => {
      log.error('offscreen error', err);
      appendOffscreenActivity(`failed ${type}: ${err instanceof Error ? err.message : String(err)}`);
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  return true;
});

setOffscreenStatus('Ready — waiting for classification or capture requests');

async function handle(message: OffscreenRequest): Promise<unknown> {
  switch (message.type) {
    case 'OFFSCREEN_PING':
      return { ok: true };
    case 'OFFSCREEN_CAPTURE_AUDIO':
      return captureAudio(message.streamId, message.durationMs, message.includeAudio === true);
    case 'OFFSCREEN_CLASSIFY':
      return classify(message);
    default:
      return { ok: false, error: `Unknown offscreen message: ${String((message as { type?: string }).type ?? 'unknown')}` };
  }
}

async function classify(message: ClassifyMessage) {
  setDebugLogging(message.settings.debugLogging);
  log.info('offscreen classify', message.metadata.videoId, {
    cloud: message.settings.cloudEscalation,
    audio: Boolean(message.audioBase64),
    features: Boolean(message.audioFeatures),
  });
  if (!isFirebaseConfigured()) {
    return { ok: false, error: 'Firebase not configured' };
  }
  const result = await classifyTrack({
    metadata: message.metadata,
    audioFeatures: message.audioFeatures,
    audio:
      message.audioBase64 && message.audioMimeType
        ? { base64: message.audioBase64, mimeType: message.audioMimeType }
        : undefined,
    settings: message.settings,
  });
  log.info(
    'offscreen classify result',
    message.metadata.videoId,
    result.verdict?.label,
    result.verdict?.source,
  );
  return { ok: true, ...result };
}

async function captureAudio(
  streamId: string,
  durationMs: number,
  includeAudio: boolean,
): Promise<CaptureResult> {
  let stream: MediaStream | null = null;
  let audioCtx: AudioContext | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      } as unknown as MediaTrackConstraints,
      video: false,
    });

    // Keep tab audio audible by routing captured stream to output.
    audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(audioCtx.destination);
    await audioCtx.resume().catch(() => undefined);

    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: BlobPart[] = [];

    const result = await new Promise<CaptureResult>((resolve) => {
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      recorder.onerror = () => resolve({ ok: false, error: 'MediaRecorder error' });
      recorder.onstop = async () => {
        try {
          const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
          const buffer = await decodeAudioBlob(blob);
          const features = extractAudioFeatures(buffer);
          if (!includeAudio) {
            resolve({ ok: true, features });
            return;
          }
          const wav = encodeWav(buffer, { mono: true, maxSeconds: 12 });
          const audioBlobBase64 = await blobToBase64(wav);
          resolve({
            ok: true,
            features,
            audioBlobBase64,
            mimeType: 'audio/wav',
          });
        } catch (err) {
          resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      };
      recorder.start(250);
      setTimeout(() => {
        if (recorder.state !== 'inactive') recorder.stop();
      }, Math.max(2000, durationMs));
    });

    return result;
  } catch (err) {
    log.error('captureAudio failed', err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
    await audioCtx?.close().catch(() => undefined);
  }
}

function pickMimeType(): string | undefined {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c));
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob'));
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

function setOffscreenStatus(text: string): void {
  const el = document.getElementById('cohen-offscreen-status');
  if (el) el.textContent = text;
}

function appendOffscreenActivity(text: string): void {
  const el = document.getElementById('cohen-offscreen-log');
  if (!el) return;
  const line = `[${new Date().toLocaleTimeString()}] ${text}`;
  const current = el.textContent && el.textContent !== 'No activity yet.' ? el.textContent : '';
  el.textContent = [...current.split('\n').filter(Boolean), line].slice(-40).join('\n');
  el.scrollTop = el.scrollHeight;
}
