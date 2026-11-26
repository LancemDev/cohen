import type { SignalEvidence, TrackMetadata } from '../utils/types';
import { normalizeText } from '../utils/core';

interface Pattern {
  id: string;
  label: string;
  weight: number;
  reason: string;
  test: (ctx: MatchContext) => boolean;
}

interface MatchContext {
  title: string;
  channel: string;
  description: string;
  combined: string;
  metadata: TrackMetadata;
}

const AI_TITLE_PATTERNS: Array<[RegExp, string, number]> = [
  [/\b(ai|a\.i\.)\s*(cover|version|remix|song|music|track|generated)\b/i, 'Title references AI-generated music', 0.45],
  [/\b(suno|udio|riffusion|boomy|aiva|soundraw|mubert)\b/i, 'Title references an AI music tool', 0.5],
  [/\b(ai\s*artist|ai\s*singer|ai\s*voice)\b/i, 'Title references an AI artist or voice', 0.35],
  [/\bmade\s+with\s+(suno|udio|ai)\b/i, 'Title says track was made with AI', 0.55],
  [/\bai[- ]generated\b/i, 'Title explicitly says AI-generated', 0.6],
];

const HUMAN_TITLE_PATTERNS: Array<[RegExp, string, number]> = [
  [/\b(official\s+video|official\s+audio|official\s+music\s+video)\b/i, 'Title suggests an official release', -0.18],
  [/\b(live|acoustic|session|rehearsal|soundcheck)\b/i, 'Title suggests a live or acoustic performance', -0.22],
  [/\b(cover\s+by|performed\s+by)\b/i, 'Title credits a human performer', -0.12],
];

const AI_CHANNEL_PATTERNS: Array<[RegExp, string, number]> = [
  [/\b(ai\s*music|ai\s*songs|suno|udio|ai\s*covers?)\b/i, 'Channel name is associated with AI music', 0.35],
];

const AI_DESCRIPTION_PATTERNS: Array<[RegExp, string, number]> = [
  [/\b(created|generated|made|produced)\s+(with|using|by)\s+(suno|udio|ai|artificial intelligence)\b/i, 'Description discloses AI generation', 0.55],
  [/\bthis\s+(song|track|music)\s+(was|is)\s+(created|generated|made)\s+(with|using)\s+ai\b/i, 'Description discloses AI creation', 0.55],
  [/\bai[- ]generated\s+(music|song|track|audio)\b/i, 'Description labels audio as AI-generated', 0.55],
  [/#suno\b|#udio\b|#aimusic\b|#aigeneratedmusic\b/i, 'Description contains AI-music hashtags', 0.3],
];

const HUMAN_DESCRIPTION_PATTERNS: Array<[RegExp, string, number]> = [
  [/\b(written\s+by|composed\s+by|produced\s+by|lyrics\s+by)\b/i, 'Description includes songwriting credits', -0.12],
  [/\b(recorded\s+at|mixed\s+by|mastered\s+by)\b/i, 'Description includes production credits', -0.12],
  [/\b(spotify|bandcamp|apple music|vinyl|cd)\b/i, 'Description links to established release channels', -0.08],
];

export function collectMetadataEvidence(metadata: TrackMetadata): SignalEvidence[] {
  const ctx: MatchContext = {
    title: metadata.title,
    channel: metadata.channelName,
    description: metadata.description,
    combined: normalizeText(`${metadata.title} ${metadata.channelName} ${metadata.description}`),
    metadata,
  };

  const evidence: SignalEvidence[] = [];

  for (const [re, reason, weight] of AI_TITLE_PATTERNS) {
    if (re.test(ctx.title)) evidence.push(makeEvidence(`title-ai:${re.source}`, 'Title signal', reason, weight));
  }
  for (const [re, reason, weight] of HUMAN_TITLE_PATTERNS) {
    if (re.test(ctx.title)) evidence.push(makeEvidence(`title-human:${re.source}`, 'Title signal', reason, weight));
  }
  for (const [re, reason, weight] of AI_CHANNEL_PATTERNS) {
    if (re.test(ctx.channel)) evidence.push(makeEvidence(`channel-ai:${re.source}`, 'Channel signal', reason, weight));
  }
  for (const [re, reason, weight] of AI_DESCRIPTION_PATTERNS) {
    if (re.test(ctx.description)) evidence.push(makeEvidence(`desc-ai:${re.source}`, 'Description signal', reason, weight));
  }
  for (const [re, reason, weight] of HUMAN_DESCRIPTION_PATTERNS) {
    if (re.test(ctx.description)) evidence.push(makeEvidence(`desc-human:${re.source}`, 'Description signal', reason, weight));
  }

  if (metadata.keywords.some((k) => /\b(ai music|suno|udio|ai generated)\b/i.test(k))) {
    evidence.push(makeEvidence('keyword-ai', 'Metadata keyword', 'Video keywords include AI-music terms', 0.25));
  }

  return dedupeEvidence(evidence);
}

function makeEvidence(id: string, label: string, detail: string, weight: number): SignalEvidence {
  return { id, label, detail, weight, source: 'metadata' };
}

function dedupeEvidence(items: SignalEvidence[]): SignalEvidence[] {
  const seen = new Set<string>();
  const out: SignalEvidence[] = [];
  for (const item of items) {
    const key = `${item.label}|${item.detail}|${item.weight}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function scoreMetadataEvidence(evidence: SignalEvidence[]): number {
  if (evidence.length === 0) return 50;
  const total = evidence.reduce((sum, e) => sum + e.weight, 0);
  // Map aggregate weight to 0..100 with a conservative slope.
  const raw = 50 + total * 35;
  return Math.max(0, Math.min(100, raw));
}
