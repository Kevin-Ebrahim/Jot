export interface AudioSegment { start: number; end: number; }

/**
 * Divide at quiet points near 25 seconds. Every sample belongs to exactly one
 * segment; the tiny Whisper model handles each locally and independently.
 */
export function transcriptionSegments(samples: Float32Array, sampleRate = 16_000): AudioSegment[] {
  if (!samples.length || !Number.isFinite(sampleRate) || sampleRate <= 0) return [];
  const max = Math.round(29 * sampleRate);
  const target = Math.round(25 * sampleRate);
  const radius = Math.round(2 * sampleRate);
  const window = Math.max(1, Math.round(.2 * sampleRate));
  const step = Math.max(1, Math.round(.1 * sampleRate));
  const segments: AudioSegment[] = [];
  let start = 0;
  while (samples.length - start > max) {
    const center = start + target;
    let best = center;
    let bestEnergy = Number.POSITIVE_INFINITY;
    for (let cut = center - radius; cut <= center + radius; cut += step) {
      let sum = 0;
      const from = Math.max(start, cut - Math.floor(window / 2));
      const to = Math.min(samples.length, from + window);
      for (let i = from; i < to; i += 1) sum += samples[i] * samples[i];
      const energy = sum / Math.max(1, to - from);
      if (energy < bestEnergy) { bestEnergy = energy; best = cut; }
    }
    const end = Math.max(start + 1, Math.min(best, samples.length));
    segments.push({ start, end });
    start = end;
  }
  if (start < samples.length) segments.push({ start, end: samples.length });
  return segments;
}

/** A conservative silence check to avoid inventing transcripts for empty audio. */
export function isAudioEffectivelySilent(samples: Float32Array): boolean {
  if (!samples.length) return true;
  let total = 0;
  for (const sample of samples) total += sample * sample;
  return Math.sqrt(total / samples.length) < 0.0001;
}
