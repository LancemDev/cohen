import { classifyTrack } from '../ai/classifier';
import { isFirebaseConfigured } from '../config/firebase';
import { decodeAudioBlob, extractAudioFeatures } from '../audio/features';
import { log } from '../utils/core';
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
}

type OffscreenRequest = ClassifyMessage | CaptureMessage | { type: 'OFFSCREEN_PING' };

chrome.runtime.onMessage.addListener((message: OffscreenRequest, _sender, sendResponse) => {
  handle(message)
    .then(sendResponse)
    .catch((err) => {
      log.error('offscreen error', err);
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  return true;
});

async function handle(message: OffscreenRequest): Promise<unknown> {
  switch (message.type) {
    case 'OFFSCREEN_PING':
      return { ok: true };
    case 'OFFSCREEN_CAPTURE_AUDIO':
      return captureAudio(message.streamId, message.durationMs);
    case 'OFFSCREEN_CLASSIFY':
      return classify(message);
    default:
      return { ok: false, error: 'Unknown offscreen message' };
  }
}

async function classify(message: ClassifyMessage) {
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
  return { ok: true, ...result };
}

async function captureAudio(streamId: string, durationMs: number): Promise<CaptureResult> {
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
          const audioBlobBase64 = await blobToBase64(blob);
          resolve({
            ok: true,
            features,
            audioBlobBase64,
            mimeType: blob.type || 'audio/webm',
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
