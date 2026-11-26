import { collectMetadataEvidence, scoreMetadataEvidence } from './metadata';
import type { AudioFeatures, Settings, SignalEvidence, TrackMetadata, Verdict, VerdictLabel } from '../utils/types';
import { clamp } from '../utils/core';

export function buildHeuristicVerdict(
  metadata: TrackMetadata,
  settings: Settings,
  audioFeatures?: AudioFeatures,
  channelTrust?: 'trusted' | 'blocked' | null,
): Verdict {
  if (channelTrust === 'trusted') {
    return trustedVerdict(metadata, 'Channel is on your trusted list.');
  }
  if (channelTrust === 'blocked') {
    return blockedVerdict(metadata, 'Channel is on your blocked list.');
  }

  const evidence = collectMetadataEvidence(metadata);
  if (audioFeatures) evidence.push(...audioEvidence(audioFeatures));

  let score = scoreFromEvidence(evidence, audioFeatures);
  let confidence = confidenceFromEvidence(evidence, audioFeatures);
  let label = labelForScore(score, confidence, settings);

  // An explicit disclosure ("made with Suno", "AI-generated", "AI cover", etc.)
  // is stronger evidence than a single incidental keyword. Do not bury it under
  // uncertainty.
  const explicitAiDisclosure = evidence.some((e) => e.source === 'metadata' && e.weight >= 0.45);
  if (explicitAiDisclosure && score >= settings.uncertainThreshold) {
    confidence = Math.max(confidence, 0.7);
    score = Math.max(score, settings.aiThreshold);
    label = 'ai';
  }
  const reasons = evidence
    .slice()
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, 5)
    .map((e) => e.detail);

  const noEvidence = reasons.length === 0;
  if (noEvidence) {
    reasons.push('No strong AI-music signals found in metadata; treating as unverified rather than certain.');
  }

  return {
    videoId: metadata.videoId,
    label: noEvidence ? 'unverified' : label,
    aiScore: Math.round(score),
    confidence,
    summary: summaryFor(label, score, noEvidence),
    reasons,
    evidence,
    source: 'heuristic',
    analyzedAt: Date.now(),
    audioAnalyzed: Boolean(audioFeatures),
  };
}

export function mergeVerdicts(base: Verdict, model: Verdict, settings: Settings): Verdict {
  // Model verdict carries structured reasoning; heuristics provide hard signals.
  const evidence = dedupe([...base.evidence, ...model.evidence]);
  const hasStrongMetadataAi = base.evidence.some((e) => e.weight >= 0.45);
  const hasStrongMetadataHuman = base.evidence.some((e) => e.weight <= -0.2);

  let score = model.aiScore * 0.7 + base.aiScore * 0.3;
  if (hasStrongMetadataAi) score = Math.max(score, model.aiScore * 0.85 + 15);
  if (hasStrongMetadataHuman && model.label !== 'ai') score = Math.min(score, model.aiScore * 0.85 + base.aiScore * 0.15);

  score = clamp(score, 0, 100);
  const confidence = clamp(model.confidence * 0.75 + base.confidence * 0.25, 0, 1);
  let label = labelForScore(score, confidence, settings);

  // Do not auto-label as AI on weak confidence.
  if (label === 'ai' && confidence < settings.minAiConfidence && !hasStrongMetadataAi) label = 'uncertain';

  const reasons = dedupeStrings([...model.reasons, ...base.reasons]).slice(0, 6);
  return {
    ...model,
    label,
    aiScore: Math.round(score),
    confidence,
    summary: summaryFor(label, score, false),
    reasons,
    evidence: evidence.slice(0, 12),
    source: model.source === 'on-device' ? 'hybrid' : model.source,
    analyzedAt: Date.now(),
  };
}

function audioEvidence(f: AudioFeatures): SignalEvidence[] {
  const out: SignalEvidence[] = [];
  if (f.spectralFlatness > 0.28 && f.dynamicRangeDb < 8) {
    out.push({
      id: 'audio-flat-compressed',
      label: 'Audio signal',
      detail: 'Audio is unusually flat and compressed, which can appear in synthetic tracks (weak signal).',
      weight: 0.12,
      source: 'audio',
    });
  }
  if (f.dynamicRangeDb > 14 && f.rhythmicStability < 0.7) {
    out.push({
      id: 'audio-dynamic-human',
      label: 'Audio signal',
      detail: 'Audio shows wider dynamic variation and less rigid rhythm (weak human signal).',
      weight: -0.1,
      source: 'audio',
    });
  }
  if (f.silenceRatio > 0.35) {
    out.push({
      id: 'audio-silence',
      label: 'Audio signal',
      detail: 'Track contains natural pauses or silence gaps.',
      weight: -0.05,
      source: 'audio',
    });
  }
  return out;
}

function scoreFromEvidence(evidence: SignalEvidence[], audioFeatures?: AudioFeatures): number {
  if (evidence.length === 0) return 50;
  const base = scoreMetadataEvidence(evidence.filter((e) => e.source === 'metadata'));
  const audioAdj = evidence.filter((e) => e.source === 'audio').reduce((s, e) => s + e.weight * 20, 0);
  return clamp(base + audioAdj, 0, 100);
}

function confidenceFromEvidence(evidence: SignalEvidence[], audioFeatures?: AudioFeatures): number {
  const strength = evidence.reduce((s, e) => s + Math.abs(e.weight), 0);
  let confidence = clamp(0.25 + strength * 0.18, 0.2, 0.92);
  if (audioFeatures) confidence = clamp(confidence + 0.08, 0, 0.95);
  return confidence;
}

function labelForScore(score: number, confidence: number, settings: Settings): VerdictLabel {
  if (score >= settings.aiThreshold && confidence >= 0.45) return 'ai';
  if (score >= settings.uncertainThreshold) return 'uncertain';
  if (confidence < 0.35) return 'uncertain';
  return 'human';
}

function summaryFor(label: VerdictLabel, score: number, noEvidence: boolean): string {
  if (noEvidence) return 'Not enough public evidence to classify this track.';
  if (label === 'ai') return `Likely AI-generated (score ${Math.round(score)}).`;
  if (label === 'human') return `Likely human-made (score ${Math.round(score)}).`;
  return `Uncertain provenance (score ${Math.round(score)}).`;
}

function trustedVerdict(metadata: TrackMetadata, reason: string): Verdict {
  return {
    videoId: metadata.videoId,
    label: 'human',
    aiScore: 5,
    confidence: 0.99,
    summary: 'Trusted by your channel allowlist.',
    reasons: [reason],
    evidence: [{ id: 'trust', label: 'User trust', detail: reason, weight: -1, source: 'user' }],
    source: 'user',
    analyzedAt: Date.now(),
    audioAnalyzed: false,
  };
}

function blockedVerdict(metadata: TrackMetadata, reason: string): Verdict {
  return {
    videoId: metadata.videoId,
    label: 'ai',
    aiScore: 99,
    confidence: 0.99,
    summary: 'Blocked by your channel blocklist.',
    reasons: [reason],
    evidence: [{ id: 'block', label: 'User block', detail: reason, weight: 1, source: 'user' }],
    source: 'user',
    analyzedAt: Date.now(),
    audioAnalyzed: false,
  };
}

function dedupe(evidence: SignalEvidence[]): SignalEvidence[] {
  const seen = new Set<string>();
  return evidence.filter((e) => {
    const k = `${e.id}|${e.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const k = v.trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
