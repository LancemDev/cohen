import { DEFAULT_SETTINGS, type Settings } from './types';

const PREFIX = '[cohen]';
const LOG_STORAGE_KEY = 'cohen:logs';
const MAX_LOG_ENTRIES = 400;
const FLUSH_DELAY_MS = 300;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: string;
  at: number;
  level: LogLevel;
  context: string;
  message: string;
}

let debugEnabled = DEFAULT_SETTINGS.debugLogging;
let sequence = 0;
let pendingLogs: LogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function setDebugLogging(enabled: boolean): void {
  debugEnabled = enabled;
}

function contextLabel(): string {
  try {
    const path = globalThis.location?.pathname ?? '';
    const host = globalThis.location?.hostname ?? '';
    if (path.includes('offscreen')) return 'offscreen';
    if (path.includes('popup')) return 'popup';
    if (path.includes('options')) return 'options';
    if (host.includes('youtube')) return 'youtube';
  } catch {
    // No location in service workers.
  }
  return 'service-worker';
}

function serializeArg(value: unknown): string {
  if (value instanceof Error) {
    return value.stack || `${value.name}: ${value.message}`;
  }
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function recordLog(level: LogLevel, args: unknown[]): void {
  const context = contextLabel();
  sequence += 1;
  pendingLogs.push({
    id: `${context}-${Date.now()}-${sequence}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    level,
    context,
    message: args.map(serializeArg).join(' '),
  });
  scheduleLogFlush();
}

function scheduleLogFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushLogs();
  }, FLUSH_DELAY_MS);
}

export async function flushLogs(): Promise<void> {
  if (pendingLogs.length === 0) return;
  const batch = pendingLogs;
  pendingLogs = [];

  try {
    const result = await chrome.storage.local.get(LOG_STORAGE_KEY);
    const existing = Array.isArray(result[LOG_STORAGE_KEY]) ? (result[LOG_STORAGE_KEY] as LogEntry[]) : [];
    const ids = new Set(existing.map((entry) => entry.id));
    const merged = [...existing, ...batch.filter((entry) => !ids.has(entry.id))]
      .sort((a, b) => a.at - b.at)
      .slice(-MAX_LOG_ENTRIES);
    await chrome.storage.local.set({ [LOG_STORAGE_KEY]: merged });
  } catch {
    // Logging should never break extension behavior.
  }
}

export async function getLogs(): Promise<LogEntry[]> {
  await flushLogs();
  try {
    const result = await chrome.storage.local.get(LOG_STORAGE_KEY);
    const logs = Array.isArray(result[LOG_STORAGE_KEY]) ? (result[LOG_STORAGE_KEY] as LogEntry[]) : [];
    return logs.sort((a, b) => a.at - b.at).slice(-MAX_LOG_ENTRIES);
  } catch {
    return [];
  }
}

export async function clearLogs(): Promise<void> {
  pendingLogs = [];
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    await chrome.storage.local.remove(LOG_STORAGE_KEY);
  } catch {
    // No-op: nothing to clear if storage is unavailable.
  }
}

export const log = {
  debug(...args: unknown[]): void {
    recordLog('debug', args);
    if (debugEnabled) console.debug(PREFIX, ...args);
  },
  info(...args: unknown[]): void {
    recordLog('info', args);
    console.info(PREFIX, ...args);
  },
  warn(...args: unknown[]): void {
    recordLog('warn', args);
    console.warn(PREFIX, ...args);
  },
  error(...args: unknown[]): void {
    recordLog('error', args);
    console.error(PREFIX, ...args);
  },
};

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function hashString(input: string): string {
  // Small non-crypto hash for cache keys / dedupe.
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\u2019']/g, "'")
    .replace(/[^a-z0-9\s'-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function titleCaseLabel(label: string): string {
  return label.length ? label[0].toUpperCase() + label.slice(1) : label;
}

export function mergeSettings(partial: Partial<Settings> | undefined): Settings {
  return { ...DEFAULT_SETTINGS, ...(partial ?? {}) };
}
