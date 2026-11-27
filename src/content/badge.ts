import type { Settings, Verdict, VerdictLabel } from '../utils/types';

export interface BadgeCallbacks {
  onDeepScan: () => void;
  onOverride: (label: VerdictLabel) => void;
  onTrustChannel: () => void;
  onBlockChannel: () => void;
}

let badge: HTMLDivElement | null = null;
let currentCallbacks: BadgeCallbacks | null = null;

export function ensureBadge(callbacks: BadgeCallbacks): HTMLDivElement | null {
  currentCallbacks = callbacks;
  const player = document.querySelector('#movie_player, .html5-video-player');
  if (!player) return null;
  if (badge && badge.isConnected) return badge;

  badge = document.createElement('div');
  badge.className = 'cohen-badge';
  badge.dataset.label = 'unverified';
  badge.dataset.open = 'false';
  badge.innerHTML = `
    <div class="cohen-header" role="button" aria-label="Toggle Cohen details">
      <span class="cohen-dot"></span>
      <div>
        <div class="cohen-title">Cohen</div>
        <div class="cohen-sub">Checking track…</div>
      </div>
      <div class="cohen-spacer"></div>
      <span class="cohen-pill">—</span>
    </div>
    <div class="cohen-body">
      <div class="cohen-summary"></div>
      <ul class="cohen-reasons"></ul>
      <div class="cohen-meta"></div>
      <div class="cohen-actions">
        <button class="cohen-btn primary" data-action="scan">Deep scan</button>
        <button class="cohen-btn" data-action="human">Mark human</button>
        <button class="cohen-btn" data-action="ai">Mark AI</button>
        <button class="cohen-btn" data-action="trust">Trust channel</button>
        <button class="cohen-btn danger" data-action="block">Block channel</button>
      </div>
    </div>
  `;

  badge.querySelector('.cohen-header')?.addEventListener('click', () => {
    if (!badge) return;
    badge.dataset.open = badge.dataset.open === 'true' ? 'false' : 'true';
  });

  badge.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      if (!currentCallbacks) return;
      if (action === 'scan') currentCallbacks.onDeepScan();
      if (action === 'human') currentCallbacks.onOverride('human');
      if (action === 'ai') currentCallbacks.onOverride('ai');
      if (action === 'trust') currentCallbacks.onTrustChannel();
      if (action === 'block') currentCallbacks.onBlockChannel();
    });
  });

  const host = player as HTMLElement;
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.appendChild(badge);
  return badge;
}

export function removeBadge(): void {
  badge?.remove();
  badge = null;
}

export function setBadgeLoading(text = 'Checking track…'): void {
  if (!badge) return;
  badge.dataset.label = 'unverified';
  setText('.cohen-sub', text);
  setText('.cohen-pill', '…');
  setText('.cohen-summary', 'Collecting metadata and signals.');
  setList([]);
  setText('.cohen-meta', '');
}

export function setBadgeVerdict(verdict: Verdict, settings: Settings): void {
  if (!badge) return;
  badge.dataset.label = verdict.label;
  setText('.cohen-sub', statusLine(verdict));
  setText('.cohen-pill', verdict.label === 'unverified' ? '—' : `${verdict.aiScore}/100`);
  setText('.cohen-summary', verdict.summary);
  setList(verdict.reasons);
  const meta = [
    verdict.label === 'unverified' ? 'Neutral baseline (no evidence)' : `Score ${verdict.aiScore}/100`,
    `Confidence ${(verdict.confidence * 100).toFixed(0)}%`,
    `Source ${verdict.source}`,
    verdict.audioAnalyzed ? 'audio analyzed' : 'metadata only',
    new Date(verdict.analyzedAt).toLocaleTimeString(),
  ].join(' · ');
  setText('.cohen-meta', meta);

  const scanBtn = badge.querySelector<HTMLButtonElement>('[data-action="scan"]');
  if (scanBtn) scanBtn.disabled = !settings.enabled;
}

export function setBadgeError(message: string): void {
  if (!badge) return;
  badge.dataset.label = 'unverified';
  setText('.cohen-sub', 'Could not classify');
  setText('.cohen-pill', 'err');
  setText('.cohen-summary', message);
  setList([]);
}

export function setBadgeHidden(hidden: boolean): void {
  if (!badge) return;
  badge.style.display = hidden ? 'none' : '';
}

function statusLine(verdict: Verdict): string {
  switch (verdict.label) {
    case 'human':
      return 'Likely human-made';
    case 'ai':
      return 'Likely AI-generated';
    case 'uncertain':
      return 'Uncertain provenance';
    default:
      return 'Not enough evidence';
  }
}

function setText(selector: string, value: string): void {
  const el = badge?.querySelector<HTMLElement>(selector);
  if (el) el.textContent = value;
}

function setList(items: string[]): void {
  const ul = badge?.querySelector<HTMLUListElement>('.cohen-reasons');
  if (!ul) return;
  ul.innerHTML = '';
  for (const item of items.slice(0, 5)) {
    const li = document.createElement('li');
    li.textContent = item;
    ul.appendChild(li);
  }
}
