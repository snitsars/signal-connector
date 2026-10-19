/**
 * Pure helpers for the voice pipeline: bytes and samples in, numbers out.
 * No I/O, no browser, no model — this is the maths every later step leans on.
 */

/** Whisper wants 16 kHz mono, so the page downsamples before anything else. */
export const SAMPLE_RATE = 16_000;

/**
 * One slice of room audio drained from the page: base64-encoded little-endian
 * Int16 mono PCM at 16 kHz, plus the RMS the page measured over it.
 */
export interface RoomAudioFrame {
  pcm: string;
  rms: number;
}

/** Decode base64 into the signed 16-bit samples it carries. */
export function base64ToInt16(base64: string): Int16Array {
  if (!base64) return new Int16Array(0);
  const bytes = Buffer.from(base64, "base64");
  // Copy into an aligned buffer: an odd byte offset would misread every sample.
  const aligned = new Uint8Array(bytes.byteLength);
  aligned.set(bytes);
  return new Int16Array(aligned.buffer, 0, Math.floor(bytes.byteLength / 2));
}

/** Encode samples as base64 little-endian Int16 (the frame the page sends). */
export function int16ToBase64(samples: Int16Array): string {
  const view = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  return view.toString("base64");
}

/** Root-mean-square of the samples, normalised to 0..1. */
export function rms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i]! / 32768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

/** Join decoded frames into the one utterance they make up. */
export function concatInt16(chunks: Int16Array[]): Int16Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
