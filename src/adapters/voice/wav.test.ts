import { describe, expect, it } from "vitest";
import { SAMPLE_RATE } from "./pcm.js";
import { pcmToWav, WAV_HEADER_BYTES, wavHeader } from "./wav.js";

describe("wavHeader", () => {
  it("writes a canonical 16 kHz mono 16-bit PCM header", () => {
    const header = wavHeader(200);
    expect(header.length).toBe(WAV_HEADER_BYTES);
    expect(header.toString("ascii", 0, 4)).toBe("RIFF");
    expect(header.readUInt32LE(4)).toBe(36 + 200);
    expect(header.toString("ascii", 8, 12)).toBe("WAVE");
    expect(header.toString("ascii", 12, 16)).toBe("fmt ");
    expect(header.readUInt16LE(20)).toBe(1); // PCM
    expect(header.readUInt16LE(22)).toBe(1); // mono
    expect(header.readUInt32LE(24)).toBe(SAMPLE_RATE);
    expect(header.readUInt32LE(28)).toBe(SAMPLE_RATE * 2); // byte rate
    expect(header.readUInt16LE(32)).toBe(2); // block align
    expect(header.readUInt16LE(34)).toBe(16); // bits
    expect(header.toString("ascii", 36, 40)).toBe("data");
    expect(header.readUInt32LE(40)).toBe(200);
  });
});

describe("pcmToWav", () => {
  it("appends the samples after the header, little-endian", () => {
    const wav = pcmToWav(new Int16Array([1, -1]));
    expect(wav.length).toBe(WAV_HEADER_BYTES + 4);
    expect(wav.readUInt32LE(4)).toBe(36 + 4);
    expect(wav.readUInt32LE(40)).toBe(4);
    expect(wav.readInt16LE(WAV_HEADER_BYTES)).toBe(1);
    expect(wav.readInt16LE(WAV_HEADER_BYTES + 2)).toBe(-1);
  });

  it("writes a header-only file for no audio", () => {
    const wav = pcmToWav(new Int16Array(0));
    expect(wav.length).toBe(WAV_HEADER_BYTES);
    expect(wav.readUInt32LE(40)).toBe(0);
  });

  it("honours a different sample rate", () => {
    const wav = pcmToWav(new Int16Array([0]), 8_000);
    expect(wav.readUInt32LE(24)).toBe(8_000);
    expect(wav.readUInt32LE(28)).toBe(16_000);
  });
});
