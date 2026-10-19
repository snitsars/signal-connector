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
