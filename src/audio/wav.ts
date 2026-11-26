/**
 * Encode an AudioBuffer as 16-bit PCM WAV.
 *
 * Gemini's audio input accepts WAV; MediaRecorder produces WebM/Opus in Chrome,
 * so deep scans transcode the captured clip before any cloud request.
 */
export function encodeWav(
  buffer: AudioBuffer,
  options: { mono?: boolean; maxSeconds?: number } = {},
): Blob {
  const mono = options.mono ?? true;
  const maxFrames = options.maxSeconds
    ? Math.min(buffer.length, Math.floor(options.maxSeconds * buffer.sampleRate))
    : buffer.length;
  const frames = Math.max(0, Math.min(maxFrames, buffer.length));
  const channels = mono ? 1 : buffer.numberOfChannels;
  const bytesPerSample = 2;
  const dataSize = frames * channels * bytesPerSample;
  const wav = new ArrayBuffer(44 + dataSize);
  const view = new DataView(wav);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const channelData = Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
    buffer.getChannelData(channel),
  );

  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    if (mono) {
      let mixed = 0;
      for (const data of channelData) mixed += data[frame] ?? 0;
      writeSample(view, offset, mixed / Math.max(1, channelData.length));
      offset += bytesPerSample;
    } else {
      for (const data of channelData) {
        writeSample(view, offset, data[frame] ?? 0);
        offset += bytesPerSample;
      }
    }
  }

  return new Blob([wav], { type: 'audio/wav' });
}

function writeSample(view: DataView, offset: number, value: number): void {
  const clamped = Math.max(-1, Math.min(1, value));
  view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}
