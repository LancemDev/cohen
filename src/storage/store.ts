import { DEFAULT_SETTINGS, type Settings, type Verdict, type VerdictLabel } from '../utils/types';
import { log, mergeSettings } from '../utils/core';

const KEYS = {
  settings: 'settings',
  verdicts: 'verdicts',
  channelTrust: 'channelTrust',
} as const;

type VerdictCache = Record<string, Verdict>;
type ChannelTrust = Record<string, 'trusted' | 'blocked'>;

export async function getSettings(): Promise<Settings> {
  const data = await chrome.storage.local.get(KEYS.settings);
  return mergeSettings(data[KEYS.settings] as Partial<Settings> | undefined);
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next = mergeSettings({ ...current, ...patch });
  await chrome.storage.local.set({ [KEYS.settings]: next });
  return next;
}

export async function onSettingsChanged(
  fn: (settings: Settings) => void,
): Promise<void> {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[KEYS.settings]) return;
    fn(mergeSettings(changes[KEYS.settings].newValue as Partial<Settings>));
  });
}

export async function getVerdict(videoId: string): Promise<Verdict | null> {
  const data = await chrome.storage.local.get(KEYS.verdicts);
  const cache = (data[KEYS.verdicts] as VerdictCache | undefined) ?? {};
  return cache[videoId] ?? null;
}

export async function getVerdictCache(): Promise<VerdictCache> {
  const data = await chrome.storage.local.get(KEYS.verdicts);
  return (data[KEYS.verdicts] as VerdictCache | undefined) ?? {};
}

export async function putVerdict(verdict: Verdict, ttlHours: number): Promise<void> {
  const cache = await getVerdictCache();
  pruneCache(cache, ttlHours);
  cache[verdict.videoId] = verdict;
  await chrome.storage.local.set({ [KEYS.verdicts]: cache });
}

export async function overrideVerdict(
  videoId: string,
  label: VerdictLabel,
): Promise<Verdict | null> {
  const cache = await getVerdictCache();
  const existing = cache[videoId];
  if (!existing) return null;
  const next: Verdict = {
    ...existing,
    label,
    summary: `Manually marked as ${label}.`,
    reasons: [`Manual override by user (${label}).`, ...existing.reasons].slice(0, 6),
    evidence: [
      {
        id: 'manual-override',
        label: 'Manual override',
        detail: `User set verdict to ${label}`,
        weight: label === 'ai' ? 1 : label === 'human' ? -1 : 0,
        source: 'user' as const,
      },
      ...existing.evidence,
    ].slice(0, 12),
    source: 'user',
    analyzedAt: Date.now(),
  };
  cache[videoId] = next;
  await chrome.storage.local.set({ [KEYS.verdicts]: cache });
  return next;
}

export async function clearVerdictCache(): Promise<void> {
  await chrome.storage.local.set({ [KEYS.verdicts]: {} });
}

function pruneCache(cache: VerdictCache, ttlHours: number): void {
  const cutoff = Date.now() - ttlHours * 60 * 60 * 1000;
  for (const [id, verdict] of Object.entries(cache)) {
    if (!verdict?.analyzedAt || verdict.analyzedAt < cutoff) {
      delete cache[id];
    }
  }
}

export async function getChannelTrust(): Promise<ChannelTrust> {
  const data = await chrome.storage.local.get(KEYS.channelTrust);
  return (data[KEYS.channelTrust] as ChannelTrust | undefined) ?? {};
}

export async function setChannelTrust(
  channelId: string,
  trusted: boolean | null,
): Promise<ChannelTrust> {
  const trust = await getChannelTrust();
  if (trusted === null) delete trust[channelId];
  else trust[channelId] = trusted ? 'trusted' : 'blocked';
  await chrome.storage.local.set({ [KEYS.channelTrust]: trust });
  // Trust changes must not be masked by stale verdicts for that channel.
  await clearVerdictCache();
  log.debug('channel trust updated', channelId, trust[channelId]);
  return trust;
}

export async function getChannelTrustFor(channelId: string): Promise<'trusted' | 'blocked' | null> {
  if (!channelId) return null;
  const trust = await getChannelTrust();
  return trust[channelId] ?? null;
}
