import { describe, expect, it } from "vitest";
import {
  base64ToInt16,
  concatInt16,
  int16ToBase64,
  rms,
  type RoomAudioFrame,
} from "./pcm.js";

const frame = (samples: Int16Array, level = rms(samples)): RoomAudioFrame => ({
  pcm: int16ToBase64(samples),
  rms: level,
});

describe("base64 <-> Int16", () => {
  it("round-trips positive and negative samples", () => {
    const samples = new Int16Array([0, 1, -1, 32767, -32768, 1234, -4321]);
    expect([...base64ToInt16(int16ToBase64(samples))]).toEqual([...samples]);
  });

  it("reads an empty string as no samples", () => {
    expect(base64ToInt16("").length).toBe(0);
  });

  it("round-trips a frame's base64", () => {
    const samples = new Int16Array([100, -100, 200, -200]);
    expect([...base64ToInt16(frame(samples).pcm)]).toEqual([...samples]);
  });
});

describe("rms", () => {
  it("is zero for silence", () => {
    expect(rms(new Int16Array([0, 0, 0, 0]))).toBe(0);
    expect(rms(new Int16Array(0))).toBe(0);
  });

  it("is about 1 for a full-scale square", () => {
    const loud = new Int16Array([32767, -32768, 32767, -32768]);
    expect(rms(loud)).toBeGreaterThan(0.99);
    expect(rms(loud)).toBeLessThanOrEqual(1.0001);
  });

  it("separates room tone from speech", () => {
    const tone = new Int16Array(1600).fill(65); // ~0.002
    const speech = new Int16Array(1600).fill(3276); // ~0.1
    expect(rms(tone)).toBeLessThan(0.01);
    expect(rms(speech)).toBeGreaterThan(0.09);
  });
});

describe("concatInt16", () => {
  it("joins frames in order", () => {
    const joined = concatInt16([new Int16Array([1, 2]), new Int16Array([3])]);
    expect([...joined]).toEqual([1, 2, 3]);
  });

  it("returns nothing for no frames", () => {
    expect(concatInt16([]).length).toBe(0);
  });
});
