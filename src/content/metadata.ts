import type { TrackMetadata } from '../utils/types';

export function getCurrentVideoId(): string | null {
  const url = new URL(location.href);
  if (url.pathname === '/watch') return url.searchParams.get('v');
  if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/')[2] || null;
  return null;
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

export function waitForMetadata(timeoutMs = 10000): Promise<TrackMetadata | null> {
  const existing = extractTrackMetadata();
  if (existing?.title && existing.title !== 'YouTube') return Promise.resolve(existing);

  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const meta = extractTrackMetadata();
      if (meta?.title && meta.title !== 'YouTube') {
        clearInterval(interval);
        clearTimeout(timer);
        resolve(meta);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        clearTimeout(timer);
        resolve(meta);
      }
    }, 500);
    const timer = setTimeout(() => {
      clearInterval(interval);
      resolve(extractTrackMetadata());
    }, timeoutMs);
  });
}
