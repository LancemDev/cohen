import {
  getGenerativeModel,
  InferenceMode,
  Schema,
  type GenerativeModel,
  type Part,
} from 'firebase/ai';
import { getAIService } from './firebase';
import type { AudioFeatures, Settings, TrackMetadata, Verdict, VerdictLabel } from '../utils/types';
import { clamp, log } from '../utils/core';

const VERDICT_SCHEMA = Schema.object({
  properties: {
    label: Schema.enumString({ enum: ['human', 'ai', 'uncertain'] }),
    aiScore: Schema.number({ description: '0 means clearly human, 100 means clearly AI-generated' }),
    confidence: Schema.number({ description: '0 to 1 confidence in the assessment' }),
    summary: Schema.string({ description: 'One short sentence summary' }),
    reasons: Schema.array({
      items: Schema.string(),
      description: 'Short evidence-based reasons',
    }),
  },
});

interface ModelVerdict {
  label: VerdictLabel;
  aiScore: number;
  confidence: number;
  summary: string;
  reasons: string[];
}

export interface ClassificationResult {
  verdict: Verdict;
  rawText?: string;
}

export async function classifyTrack(args: {
  metadata: TrackMetadata;
  audioFeatures?: AudioFeatures;
  audio?: { base64: string; mimeType: string };
  settings: Settings;
}): Promise<ClassificationResult> {
  const { metadata, audioFeatures, audio, settings } = args;
  const ai = getAIService();

  const useCloudAudio = Boolean(audio);
  // Audio is not supported by on-device inference; PREFER_ON_DEVICE will fall back to cloud.
  const mode = useCloudAudio
    ? InferenceMode.PREFER_ON_DEVICE
    : InferenceMode.PREFER_ON_DEVICE;

  const model = getGenerativeModel(ai, {
    mode,
    inCloudParams: {
      model: useCloudAudio ? 'gemini-2.5-flash' : 'gemini-2.5-flash-lite',
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: VERDICT_SCHEMA,
        temperature: 0.1,
      },
    },
    onDeviceParams: {
      promptOptions: {
        responseConstraint: VERDICT_SCHEMA,
      },
      createOptions: {
        temperature: 0.1,
        topK: 3,
      },
    },
  });

  const prompt = buildPrompt(metadata, audioFeatures, Boolean(audio));
  const parts: Part[] = [{ text: prompt }];
  if (audio) {
    parts.push({
      inlineData: {
        data: audio.base64,
        mimeType: audio.mimeType,
      },
    });
    parts.push({
      text: 'An audio clip from the track is attached. Use it only as supporting evidence. If the audio is inconclusive, say so.',
    });
  }

  const result = await model.generateContent(parts);
  const response = result.response;
  const text = response.text();
  const parsed = parseModelVerdict(text);
  const inferenceSource = (response as unknown as { inferenceSource?: string }).inferenceSource;
  const source = inferSource(inferenceSource, useCloudAudio);

  const verdict: Verdict = {
    videoId: metadata.videoId,
    label: parsed.label,
    aiScore: clamp(Math.round(parsed.aiScore), 0, 100),
    confidence: clamp(parsed.confidence, 0, 1),
    summary: parsed.summary || summaryFor(parsed.label, parsed.aiScore),
    reasons: parsed.reasons.slice(0, 6),
    evidence: parsed.reasons.slice(0, 6).map((reason, i) => ({
      id: `model-${i}`,
      label: 'Model reasoning',
      detail: reason,
      weight: parsed.label === 'ai' ? 0.3 : parsed.label === 'human' ? -0.3 : 0,
      source: 'model' as const,
    })),
    source,
    model: useCloudAudio ? 'gemini-2.5-flash' : 'gemini-2.5-flash-lite/on-device',
    analyzedAt: Date.now(),
    audioAnalyzed: Boolean(audio || audioFeatures),
  };

  // Conservative post-processing: low confidence should not be a hard AI call.
  if (verdict.confidence < settings.cloudEscalationMinConfidence && verdict.label === 'ai') {
    verdict.label = verdict.aiScore >= settings.aiThreshold ? 'uncertain' : 'uncertain';
    verdict.summary = `Uncertain: ${verdict.summary}`;
    verdict.reasons.unshift('Confidence is below the escalation threshold; treating as uncertain.');
  }

  log.debug('classification result', { videoId: metadata.videoId, verdict, inferenceSource, raw: text });
  return { verdict, rawText: text };
}

function inferSource(inferenceSource: string | undefined, audioUsed: boolean): Verdict['source'] {
  if (inferenceSource === 'ON_DEVICE') return 'on-device';
  if (inferenceSource === 'IN_CLOUD') return audioUsed ? 'cloud' : 'cloud';
  return audioUsed ? 'cloud' : 'hybrid';
}

function buildPrompt(metadata: TrackMetadata, audioFeatures: AudioFeatures | undefined, hasAudio: boolean): string {
  const featureBlock = audioFeatures ? formatAudioFeatures(audioFeatures) : 'No audio features available.';
  return [
    'You are Cohen, a careful classifier for music provenance on YouTube.',
    'Task: estimate whether the track is human-made or AI-generated based on evidence.',
    'Be conservative. Do not claim certainty. Use "uncertain" when evidence conflicts or is weak.',
    'Do not accuse real artists of fraud. Focus on observable signals.',
    '',
    'Return JSON with: label ("human"|"ai"|"uncertain"), aiScore (0-100), confidence (0-1), summary, reasons (array of short strings).',
    '',
    'Track metadata:',
    `- Title: ${metadata.title}`,
    `- Channel: ${metadata.channelName}`,
    `- Channel ID: ${metadata.channelId || 'unknown'}`,
    `- URL: ${metadata.watchUrl}`,
    `- Duration seconds: ${metadata.durationSeconds ?? 'unknown'}`,
    `- Keywords: ${metadata.keywords.join(', ') || 'none'}`,
    `- Description: ${truncate(metadata.description, 1400) || 'none'}`,
    '',
    'Audio features:',
    featureBlock,
    '',
    hasAudio
      ? 'An audio clip is attached. Consider vocal artifacts, unnatural phrasing, repetitive structure, or synthetic texture, but treat them as weak evidence.'
      : 'No audio clip attached. Base your answer on metadata and any provided audio features.',
    '',
    'Scoring guide:',
    '- 0-30: likely human',
    '- 31-44: leaning human but uncertain',
    '- 45-69: uncertain / mixed evidence',
    '- 70-100: likely AI-generated',
  ].join('\n');
}

function formatAudioFeatures(f: AudioFeatures): string {
  return [
    `- Duration analyzed: ${f.durationSeconds.toFixed(1)}s @ ${f.sampleRate}Hz`,
    `- RMS: ${f.rms.toFixed(4)}, Peak: ${f.peak.toFixed(4)}, Dynamic range: ${f.dynamicRangeDb.toFixed(1)} dB`,
    `- Spectral centroid: ${f.spectralCentroidHz.toFixed(0)} Hz, Flatness: ${f.spectralFlatness.toFixed(3)}, Rolloff: ${f.spectralRolloffHz.toFixed(0)} Hz`,
    `- Zero crossing rate: ${f.zeroCrossingRate.toFixed(4)}, Silence ratio: ${f.silenceRatio.toFixed(3)}`,
    `- Tempo: ${f.estimatedTempoBpm ?? 'unknown'} BPM, Rhythmic stability: ${f.rhythmicStability.toFixed(3)}`,
    `- Stereo width: ${f.stereoWidth.toFixed(3)}`,
  ].join('\n');
}

function parseModelVerdict(text: string): ModelVerdict {
  const json = extractJson(text);
  const obj = JSON.parse(json) as Partial<ModelVerdict>;
  const label = normalizeLabel(obj.label);
  const aiScore = typeof obj.aiScore === 'number' ? obj.aiScore : label === 'ai' ? 75 : label === 'human' ? 25 : 50;
  const confidence = typeof obj.confidence === 'number' ? obj.confidence : 0.5;
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : summaryFor(label, aiScore);
  const reasons = Array.isArray(obj.reasons)
    ? obj.reasons.filter((r): r is string => typeof r === 'string').map((r) => r.trim()).filter(Boolean)
    : [];
  return { label, aiScore, confidence, summary, reasons };
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (match) return match[0];
  throw new Error('Model response did not contain JSON');
}

function normalizeLabel(label: unknown): VerdictLabel {
  if (label === 'human' || label === 'ai' || label === 'uncertain') return label;
  return 'uncertain';
}

function summaryFor(label: VerdictLabel, score: number): string {
  if (label === 'ai') return `Likely AI-generated (score ${Math.round(score)}).`;
  if (label === 'human') return `Likely human-made (score ${Math.round(score)}).`;
  return `Uncertain provenance (score ${Math.round(score)}).`;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export async function createClassificationModel(settings: Settings): Promise<GenerativeModel> {
  const ai = getAIService();
  return getGenerativeModel(ai, {
    mode: InferenceMode.PREFER_ON_DEVICE,
    inCloudParams: {
      model: 'gemini-2.5-flash-lite',
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: VERDICT_SCHEMA,
        temperature: 0.1,
      },
    },
    onDeviceParams: {
      promptOptions: { responseConstraint: VERDICT_SCHEMA },
      createOptions: { temperature: 0.1, topK: 3 },
    },
  });
}
