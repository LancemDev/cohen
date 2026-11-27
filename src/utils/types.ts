export type VerdictLabel = 'human' | 'ai' | 'uncertain' | 'unverified';

export type VerdictSource = 'heuristic' | 'on-device' | 'cloud' | 'hybrid' | 'user';

export interface SignalEvidence {
  id: string;
  label: string;
  detail: string;
  weight: number; // -1 (human) .. +1 (ai)
  source: 'metadata' | 'audio' | 'model' | 'cache' | 'user';
}

export interface AudioFeatures {
  durationSeconds: number;
  sampleRate: number;
  rms: number;
  peak: number;
  dynamicRangeDb: number;
  spectralCentroidHz: number;
  spectralFlatness: number;
  spectralRolloffHz: number;
  zeroCrossingRate: number;
  silenceRatio: number;
  estimatedTempoBpm: number | null;
  rhythmicStability: number; // 0..1
  stereoWidth: number; // 0..1
}

export interface TrackMetadata {
  videoId: string;
  title: string;
  channelName: string;
  channelId: string;
  channelUrl: string;
  description: string;
  durationSeconds: number | null;
  watchUrl: string;
  keywords: string[];
  isMusicCategory: boolean | null;
  capturedAt: number;
}

export interface Verdict {
  videoId: string;
  label: VerdictLabel;
  /** 0 = clearly human, 100 = clearly AI */
  aiScore: number;
  confidence: number; // 0..1
  summary: string;
  reasons: string[];
  evidence: SignalEvidence[];
  source: VerdictSource;
  model?: string;
  analyzedAt: number;
  audioAnalyzed: boolean;
  /** Identifies the metadata used for this verdict so cache entries cannot survive a metadata change. */
  metadataFingerprint?: string;
}

export interface Settings {
  enabled: boolean;
  autoMuteAi: boolean;
  autoSkipAi: boolean;
  aiThreshold: number; // score >= threshold => ai action
  uncertainThreshold: number; // below aiThreshold, >= uncertainThreshold => uncertain
  cloudEscalation: boolean; // allow cloud fallback / audio upload
  minAiConfidence: number; // minimum confidence before labeling a verdict AI
  cacheTtlHours: number;
  showBadge: boolean;
  debugLogging: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  autoMuteAi: true,
  autoSkipAi: false,
  aiThreshold: 70,
  uncertainThreshold: 45,
  cloudEscalation: false,
  minAiConfidence: 0.65,
  cacheTtlHours: 24 * 7,
  showBadge: true,
  debugLogging: false,
};

export interface ClassificationRequest {
  type: 'CLASSIFY_TRACK';
  metadata: TrackMetadata;
  audioFeatures?: AudioFeatures;
  forceCloud?: boolean;
}

export interface DeepScanRequest {
  type: 'DEEP_SCAN';
  videoId: string;
  tabId: number;
}

export interface DeepScanWithMetadataRequest {
  type: 'DEEP_SCAN_WITH_METADATA';
  metadata: TrackMetadata;
  tabId?: number;
}

export interface VerdictResponse {
  type: 'VERDICT';
  verdict: Verdict;
}

export interface SettingsResponse {
  type: 'SETTINGS';
  settings: Settings;
}

export type BackgroundMessage =
  | ClassificationRequest
  | DeepScanRequest
  | DeepScanWithMetadataRequest
  | { type: 'GET_VERDICT'; videoId: string }
  | { type: 'GET_SETTINGS' }
  | { type: 'SET_SETTINGS'; settings: Partial<Settings> }
  | { type: 'CLEAR_CACHE' }
  | { type: 'OVERRIDE_VERDICT'; videoId: string; label: VerdictLabel }
  | { type: 'TRUST_CHANNEL'; channelId: string; trusted: boolean }
  | { type: 'PING' };

export type OffscreenMessage =
  | {
      type: 'OFFSCREEN_CLASSIFY';
      metadata: TrackMetadata;
      audioFeatures?: AudioFeatures;
      audioBase64?: string;
      audioMimeType?: string;
      settings: Settings;
    }
  | { type: 'OFFSCREEN_CAPTURE_AUDIO'; streamId: string; durationMs: number; includeAudio?: boolean }
  | { type: 'OFFSCREEN_PING' };

export interface CaptureResult {
  ok: boolean;
  features?: AudioFeatures;
  audioBlobBase64?: string;
  mimeType?: string;
  error?: string;
}
