/**
 * A canonical 16 kHz mono 16-bit PCM WAV writer. The fetched transcriber takes
 * a file, so one short file per utterance is the simplest bounded contract.
 */
import { SAMPLE_RATE } from "./pcm.js";

/** The canonical PCM WAV header is 44 bytes: RIFF, fmt and data chunks. */
export const WAV_HEADER_BYTES = 44;

export function wavHeader(
  dataBytes: number,
  sampleRate = SAMPLE_RATE,
  channels = 1,
  bitsPerSample = 16,
): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4); // everything after this field
  header.write("WAVE", 8, "ascii");

  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size for PCM
  header.writeUInt16LE(1, 20); // format 1 = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);

  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/** A complete WAV: header plus the samples, ready to hand to the transcriber. */
export function pcmToWav(samples: Int16Array, sampleRate = SAMPLE_RATE): Buffer {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  return Buffer.concat([wavHeader(data.byteLength, sampleRate), data]);
}

/**
 * Repair a streamed WAV header. Some providers (OpenAI's speech endpoint) send
 * the canonical 44-byte header but leave the RIFF and data sizes at
 * 0xFFFFFFFF; Chrome's decodeAudioData then refuses the clip. The bytes are
 * already complete here, so the sizes can be filled in.
 */
export function repairWavSizes(wav: Buffer): Buffer {
  if (
    wav.length < WAV_HEADER_BYTES ||
    wav.toString("ascii", 0, 4) !== "RIFF" ||
    wav.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return wav;
  }
  const dataBytes = wav.length - WAV_HEADER_BYTES;
  const dataSize = wav.readUInt32LE(40);
  const riffSize = wav.readUInt32LE(4);
  if (dataSize === 0xffffffff || dataSize > dataBytes) {
    wav.writeUInt32LE(dataBytes, 40);
  }
  if (riffSize === 0xffffffff || riffSize > 36 + dataBytes) {
    wav.writeUInt32LE(36 + dataBytes, 4);
  }
  return wav;
}
export function normalizeSamples(
  samples: Int16Array,
  options: { targetPeak?: number; minimumPeak?: number; maxGain?: number } = {},
): Int16Array {
  const targetPeak = options.targetPeak ?? 0.6;
  const minimumPeak = options.minimumPeak ?? 0.01;
  const maxGain = options.maxGain ?? 24;

  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.abs(samples[i] ?? 0);
    if (value > peak) peak = value;
  }
  // Below the floor this is room tone, not speech: leave it as it is.
  if (peak === 0 || peak < minimumPeak * 32768) return samples;

  const gain = Math.min(maxGain, (targetPeak * 32768) / peak);
  if (gain <= 1.05) return samples;

  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const scaled = Math.round((samples[i] ?? 0) * gain);
    out[i] = scaled > 32767 ? 32767 : scaled < -32768 ? -32768 : scaled;
  }
  return out;
}
