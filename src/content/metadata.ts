import type { TrackMetadata } from '../utils/types';

export function getCurrentVideoId(): string | null {
  return parseVideoId(location.href);
}

function parseVideoId(value: string): string | null {
  try {
    const url = new URL(value, location.origin);
    if (url.pathname === '/watch') return url.searchParams.get('v');
    if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/')[2] || null;
    return null;
  } catch {
    return null;
  }
}

function getCanonicalVideoId(): string | null {
  // YouTube keeps these in sync with the current watch page during SPA
  // navigation. Checking them prevents pairing a new URL with the previous
  // video's title/description while the watch page is still updating.
  const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  const canonicalId = canonical?.href ? parseVideoId(canonical.href) : null;
  if (canonicalId) return canonicalId;

  const ogUrl = document.querySelector<HTMLMetaElement>('meta[property="og:url"]');
  return ogUrl?.content ? parseVideoId(ogUrl.content) : null;
}

function metadataMatchesCurrentPage(metadata: TrackMetadata): boolean {
  const urlVideoId = getCurrentVideoId();
  if (!urlVideoId || metadata.videoId !== urlVideoId) return false;

  const canonicalVideoId = getCanonicalVideoId();
  return !canonicalVideoId || canonicalVideoId === urlVideoId;
}

export function extractTrackMetadata(): TrackMetadata | null {
  const videoId = getCurrentVideoId();
  if (!videoId) return null;

  const title =
    document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent?.trim() ||
    document.querySelector('meta[name="title"]')?.getAttribute('content')?.trim() ||
    document.title.replace(/ - YouTube$/, '').trim();

  const channelLink =
    document.querySelector<HTMLAnchorElement>('ytd-channel-name a') ||
    document.querySelector<HTMLAnchorElement>('ytd-video-owner-renderer a.yt-simple-endpoint');
  const channelName = channelLink?.textContent?.trim() || 'Unknown channel';
  const channelUrl = channelLink?.href || '';
  const channelId = extractChannelId(channelUrl);

  const description =
    document.querySelector('#description-inline-expander yt-formatted-string')?.textContent?.trim() ||
    document.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() ||
    '';

  const keywordsMeta = document.querySelector('meta[name="keywords"]')?.getAttribute('content') || '';
  const keywords = keywordsMeta
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 20);

  const durationSeconds = parseDuration(
    document.querySelector('.ytp-time-duration')?.textContent?.trim() || '',
  );

  const isMusicCategory = detectMusicCategory();

  return {
    videoId,
    title,
    channelName,
    channelId,
    channelUrl,
    description,
    durationSeconds,
    watchUrl: `https://www.youtube.com/watch?v=${videoId}`,
    keywords,
    isMusicCategory,
    capturedAt: Date.now(),
  };
}

function extractChannelId(url: string): string {
  try {
    const u = new URL(url, location.origin);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'channel' && parts[1]) return parts[1];
    if (parts[0]?.startsWith('@')) return parts[0];
    return parts[1] || parts[0] || '';
  } catch {
    return '';
  }
}

function parseDuration(text: string): number | null {
  if (!text) return null;
  const parts = text.split(':').map((p) => Number(p));
  if (parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

function detectMusicCategory(): boolean | null {
  const category = document.querySelector('meta[itemprop="genre"]')?.getAttribute('content');
  if (category) return /music/i.test(category);
  const microformat = document.querySelector('script[type="application/ld+json"]')?.textContent;
  if (microformat && /"MusicVideoObject"|"MusicRecording"/.test(microformat)) return true;
  return null;
}

export function waitForMetadata(timeoutMs = 12000): Promise<TrackMetadata | null> {
  const start = Date.now();
  const existing = extractTrackMetadata();
  let matchedAt = isUsableMetadata(existing) && metadataMatchesCurrentPage(existing) ? Date.now() : null;
  const settleMs = 600;

  return new Promise((resolve) => {
    let finished = false;

    const finish = (metadata: TrackMetadata | null): void => {
      if (finished) return;
      finished = true;
      clearInterval(interval);
      clearTimeout(timer);
      resolve(metadata);
    };

    const check = (): void => {
      const metadata = extractTrackMetadata();
      const matches = isUsableMetadata(metadata) && metadataMatchesCurrentPage(metadata);
      if (matches && matchedAt === null) matchedAt = Date.now();

      if (matches && matchedAt !== null && Date.now() - matchedAt >= settleMs) {
        finish(metadata);
        return;
      }

      if (Date.now() - start > timeoutMs) {
        finish(matches ? metadata : null);
      }
    };

    const interval = setInterval(check, 250);
    const timer = setTimeout(() => {
      const metadata = extractTrackMetadata();
      finish(isUsableMetadata(metadata) && metadataMatchesCurrentPage(metadata) ? metadata : null);
    }, timeoutMs);

    check();
  });
}

function isUsableMetadata(metadata: TrackMetadata | null): metadata is TrackMetadata {
  return Boolean(metadata?.title && metadata.title !== 'YouTube');
}
