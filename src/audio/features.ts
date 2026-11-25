import type { AudioFeatures } from '../utils/types';
import { clamp } from '../utils/core';

export async function decodeAudioBlob(blob: Blob): Promise<AudioBuffer> {
  const arrayBuffer = await blob.arrayBuffer();
  const ctx = new AudioContext();
  try {
    return await ctx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

export function extractAudioFeatures(buffer: AudioBuffer): AudioFeatures {
  const mono = mixToMono(buffer);
  const sampleRate = buffer.sampleRate;
  const durationSeconds = buffer.duration;

  const rms = computeRms(mono);
  const peak = computePeak(mono);
  const dynamicRangeDb = computeDynamicRangeDb(mono);
  const zeroCrossingRate = computeZeroCrossingRate(mono);
  const silenceRatio = computeSilenceRatio(mono, 0.01);
  const stereoWidth = computeStereoWidth(buffer);

  const spectrum = computeAverageSpectrum(mono, sampleRate, 2048);
  const spectralCentroidHz = spectrum.centroidHz;
  const spectralFlatness = spectrum.flatness;
  const spectralRolloffHz = spectrum.rolloffHz;
  const tempo = estimateTempo(mono, sampleRate);

  return {
    durationSeconds,
    sampleRate,
    rms,
    peak,
    dynamicRangeDb,
    spectralCentroidHz,
    spectralFlatness,
    spectralRolloffHz,
    zeroCrossingRate,
    silenceRatio,
    estimatedTempoBpm: tempo.bpm,
    rhythmicStability: tempo.stability,
    stereoWidth,
  };
}

function mixToMono(buffer: AudioBuffer): Float32Array {
  const length = buffer.length;
  const out = new Float32Array(length);
  const channels = buffer.numberOfChannels;
  for (let c = 0; c < channels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i += 1) out[i] += data[i] / channels;
  }
  return out;
}

function computeRms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, samples.length));
}

function computePeak(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  return peak;
}

function computeDynamicRangeDb(samples: Float32Array): number {
  // Approximate dynamic range as difference between 95th and 10th percentile frame RMS.
  const frame = 2048;
  const hop = 1024;
  const rmsValues: number[] = [];
  for (let i = 0; i + frame <= samples.length; i += hop) {
    let sum = 0;
    for (let j = 0; j < frame; j += 1) {
      const v = samples[i + j];
      sum += v * v;
    }
    rmsValues.push(Math.sqrt(sum / frame));
  }
  if (rmsValues.length === 0) return 0;
  rmsValues.sort((a, b) => a - b);
  const p10 = rmsValues[Math.floor(rmsValues.length * 0.1)] ?? 1e-6;
  const p95 = rmsValues[Math.floor(rmsValues.length * 0.95)] ?? 1e-6;
  return 20 * Math.log10((p95 + 1e-6) / (p10 + 1e-6));
}

function computeZeroCrossingRate(samples: Float32Array): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if ((samples[i - 1] >= 0) !== (samples[i] >= 0)) crossings += 1;
  }
  return crossings / Math.max(1, samples.length);
}

function computeSilenceRatio(samples: Float32Array, threshold: number): number {
  let silent = 0;
  for (let i = 0; i < samples.length; i += 1) {
    if (Math.abs(samples[i]) < threshold) silent += 1;
  }
  return silent / Math.max(1, samples.length);
}

function computeStereoWidth(buffer: AudioBuffer): number {
  if (buffer.numberOfChannels < 2) return 0;
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  const n = Math.min(left.length, right.length);
  let diff = 0;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const l = left[i];
    const r = right[i];
    const mid = (l + r) / 2;
    const side = (l - r) / 2;
    diff += side * side;
    sum += mid * mid + side * side;
  }
  if (sum <= 1e-9) return 0;
  return clamp(diff / sum, 0, 1);
}

interface SpectrumSummary {
  centroidHz: number;
  flatness: number;
  rolloffHz: number;
}

function computeAverageSpectrum(samples: Float32Array, sampleRate: number, fftSize: number): SpectrumSummary {
  const windowCount = Math.max(1, Math.floor((samples.length - fftSize) / fftSize));
  const bins = fftSize / 2;
  const avgMag = new Float64Array(bins);
  const real = new Float64Array(fftSize);
  const imag = new Float64Array(fftSize);
  const hann = buildHann(fftSize);

  let used = 0;
  const maxWindows = Math.min(windowCount, 32);
  const step = Math.max(1, Math.floor(windowCount / maxWindows));
  for (let w = 0, start = 0; w < windowCount && used < maxWindows; w += step, start = w * fftSize) {
    real.fill(0);
    imag.fill(0);
    for (let i = 0; i < fftSize; i += 1) real[i] = (samples[start + i] ?? 0) * hann[i];
    fft(real, imag);
    for (let b = 0; b < bins; b += 1) {
      const mag = Math.hypot(real[b], imag[b]);
      avgMag[b] += mag;
    }
    used += 1;
  }
  for (let b = 0; b < bins; b += 1) avgMag[b] /= Math.max(1, used);

  let weighted = 0;
  let total = 0;
  let geoLog = 0;
  let geoCount = 0;
  for (let b = 1; b < bins; b += 1) {
    const mag = avgMag[b];
    const freq = (b * sampleRate) / fftSize;
    weighted += freq * mag;
    total += mag;
    geoLog += Math.log(mag + 1e-12);
    geoCount += 1;
  }
  const centroidHz = total > 0 ? weighted / total : 0;
  const arithmetic = total / Math.max(1, geoCount);
  const geometric = Math.exp(geoLog / Math.max(1, geoCount));
  const flatness = arithmetic > 0 ? clamp(geometric / arithmetic, 0, 1) : 0;

  const rolloffTarget = total * 0.85;
  let cumulative = 0;
  let rolloffHz = 0;
  for (let b = 1; b < bins; b += 1) {
    cumulative += avgMag[b];
    if (cumulative >= rolloffTarget) {
      rolloffHz = (b * sampleRate) / fftSize;
      break;
    }
  }

  return { centroidHz, flatness, rolloffHz };
}

function buildHann(size: number): Float64Array {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i += 1) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  return w;
}

function fft(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
  let j = 0;
  for (let i = 0; i < n; i += 1) {
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wlenR = Math.cos(ang);
    const wlenI = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wR = 1;
      let wI = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const uR = real[i + k];
        const uI = imag[i + k];
        const vR = real[i + k + len / 2] * wR - imag[i + k + len / 2] * wI;
        const vI = real[i + k + len / 2] * wI + imag[i + k + len / 2] * wR;
        real[i + k] = uR + vR;
        imag[i + k] = uI + vI;
        real[i + k + len / 2] = uR - vR;
        imag[i + k + len / 2] = uI - vI;
        const nextWR = wR * wlenR - wI * wlenI;
        wI = wR * wlenI + wI * wlenR;
        wR = nextWR;
      }
    }
  }
}

function estimateTempo(samples: Float32Array, sampleRate: number): { bpm: number | null; stability: number } {
  // Very lightweight onset-envelope autocorrelation. Not studio-grade; good enough for a signal.
  const frame = 1024;
  const hop = 512;
  const energies: number[] = [];
  for (let i = 0; i + frame <= samples.length; i += hop) {
    let sum = 0;
    for (let j = 0; j < frame; j += 1) sum += Math.abs(samples[i + j]);
    energies.push(sum / frame);
  }
  if (energies.length < 8) return { bpm: null, stability: 0 };

  // Onset envelope: positive differences.
  const onset = new Float64Array(energies.length);
  for (let i = 1; i < energies.length; i += 1) onset[i] = Math.max(0, energies[i] - energies[i - 1]);

  const envRate = sampleRate / hop;
  const minBpm = 70;
  const maxBpm = 180;
  const minLag = Math.floor((60 / maxBpm) * envRate);
  const maxLag = Math.min(onset.length - 2, Math.ceil((60 / minBpm) * envRate));

  let bestLag = -1;
  let bestScore = 0;
  let secondScore = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let score = 0;
    let normA = 0;
    let normB = 0;
    for (let i = lag; i < onset.length; i += 1) {
      score += onset[i] * onset[i - lag];
      normA += onset[i] * onset[i];
      normB += onset[i - lag] * onset[i - lag];
    }
    const denom = Math.sqrt(normA * normB) || 1;
    const normalized = score / denom;
    if (normalized > bestScore) {
      secondScore = bestScore;
      bestScore = normalized;
      bestLag = lag;
    } else if (normalized > secondScore) {
      secondScore = normalized;
    }
  }

  if (bestLag <= 0 || bestScore < 0.15) return { bpm: null, stability: 0 };
  const bpm = Math.round(60 * envRate / bestLag);
  const stability = clamp(bestScore - secondScore * 0.5, 0, 1);
  return { bpm, stability };
}
