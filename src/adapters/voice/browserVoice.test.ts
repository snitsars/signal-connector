import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../../config/config.js";
import { nullLogger } from "../../logging/logger.js";
import type { Utterance } from "../../core/ports.js";
import { BrowserVoice } from "./browserVoice.js";
import { int16ToBase64, type RoomAudioFrame } from "./pcm.js";
import type { TranscribeResult, Transcriber } from "./whisper.js";

const BASE = ConfigSchema.parse({}).voice;

/** One 100 ms frame, so the sample maths stays easy to follow (16 kHz mono). */
const FRAME_MS = 100;
const SAMPLES = (FRAME_MS * 16_000) / 1000;

const speechFrame = (): RoomAudioFrame => {
  const samples = new Int16Array(SAMPLES).fill(3276); // ~0.1 RMS, above the 0.01 floor
  return { pcm: int16ToBase64(samples), rms: 0.1 };
};

const toneFrame = (): RoomAudioFrame => {
  const samples = new Int16Array(SAMPLES).fill(80); // ~0.002 RMS, below the floor
  return { pcm: int16ToBase64(samples), rms: 0.002 };
};

const silenceFrame = (): RoomAudioFrame => ({
  pcm: int16ToBase64(new Int16Array(SAMPLES)),
  rms: 0,
});

class StubTranscriber implements Transcriber {
  configured = true;
  readonly calls: string[] = [];
  readonly sizes: number[] = [];
  result: TranscribeResult = { ok: true, text: "fix the parser" };

  async transcribe(wavPath: string): Promise<TranscribeResult> {
    this.calls.push(wavPath);
    // Prove the WAV was on disk when the tool was asked to open it.
    this.sizes.push(fs.existsSync(wavPath) ? fs.statSync(wavPath).size : -1);
    return this.result;
  }
}

function makeVoice(config = BASE) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-"));
  const transcriber = new StubTranscriber();
  const voice = new BrowserVoice({ config, logger: nullLogger(), workDir, transcriber });
  const utterances: Utterance[] = [];
  const failures: string[] = [];
  const levels: number[] = [];
  const start = async (projectId = "demo") =>
    voice.start({
      projectId,
      projectName: projectId,
      onUtterance: (u) => utterances.push(u),
      onLevel: (level) => levels.push(level),
      onFailure: (reason) => failures.push(reason),
    });
  return { voice, transcriber, workDir, utterances, failures, levels, start };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("BrowserVoice", () => {
  it("transcribes an utterance once speech falls silent", async () => {
    const v = makeVoice();
    dirs.push(v.workDir);
    const handle = await v.start();
    for (let i = 0; i < 3; i++) v.voice.push(speechFrame());
    for (let i = 0; i < 9; i++) v.voice.push(silenceFrame());
    await v.voice.whenIdle();

    expect(v.transcriber.calls).toHaveLength(1);
    expect(v.utterances).toEqual([{ text: "fix the parser", durationMs: 1200 }]);
    expect(v.voice.drops).toBe(0);
    await handle.stop();
  });

  it("never cuts or counts pure room tone in a quiet room", async () => {
    const v = makeVoice();
    dirs.push(v.workDir);
    await v.start();
    // Four seconds of tone: more than four old silence windows, and still no
    // utterance, no transcription and no drop.
    for (let i = 0; i < 40; i++) v.voice.push(toneFrame());
    await v.voice.whenIdle();

    expect(v.transcriber.calls).toHaveLength(0);
    expect(v.utterances).toHaveLength(0);
    expect(v.voice.drops).toBe(0);
  });

  it("posts a failed run's reason and counts the drop", async () => {
    const v = makeVoice();
    dirs.push(v.workDir);
    v.transcriber.result = { ok: false, reason: "the transcriber timed out" };
    await v.start();
    for (let i = 0; i < 3; i++) v.voice.push(speechFrame());
    for (let i = 0; i < 9; i++) v.voice.push(silenceFrame());
    await v.voice.whenIdle();

    expect(v.voice.drops).toBe(1);
    expect(v.failures).toEqual(["the transcriber timed out"]);
    expect(v.utterances).toHaveLength(0);
  });

  it("drops a blank transcript and counts it", async () => {
    const v = makeVoice();
    dirs.push(v.workDir);
    v.transcriber.result = { ok: true, text: "" };
    await v.start();
    for (let i = 0; i < 3; i++) v.voice.push(speechFrame());
    for (let i = 0; i < 9; i++) v.voice.push(silenceFrame());
    await v.voice.whenIdle();

    expect(v.voice.drops).toBe(1);
    expect(v.utterances).toHaveLength(0);
    expect(v.failures).toHaveLength(0); // nothing to say: it was simply blank
  });

  it("cuts an utterance that runs past its maximum length", async () => {
    const v = makeVoice({ ...BASE, maxUtteranceMs: 400, silenceMs: 60_000 });
    dirs.push(v.workDir);
    await v.start();
    for (let i = 0; i < 5; i++) v.voice.push(speechFrame());
    await v.voice.whenIdle();

    expect(v.transcriber.calls).toHaveLength(1);
    expect(v.utterances).toHaveLength(1);
  });

  it("reports the room's level as it hears it", async () => {
    const v = makeVoice();
    dirs.push(v.workDir);
    await v.start();
    v.voice.push(speechFrame());
    v.voice.push(silenceFrame());
    expect(v.levels[0]).toBeCloseTo(0.1, 2);
    expect(v.levels[1]).toBe(0);
  });

  it("names an unconfigured transcriber once and counts each drop", async () => {
    const v = makeVoice();
    dirs.push(v.workDir);
    v.transcriber.configured = false;
    await v.start();
    for (let i = 0; i < 3; i++) v.voice.push(speechFrame());
    for (let i = 0; i < 9; i++) v.voice.push(silenceFrame());
    await v.voice.whenIdle();
    for (let i = 0; i < 3; i++) v.voice.push(speechFrame());
    for (let i = 0; i < 9; i++) v.voice.push(silenceFrame());
    await v.voice.whenIdle();

    expect(v.voice.drops).toBe(2);
    expect(v.failures).toHaveLength(1);
    expect(v.failures[0]).toContain("voice.whisperPath");
    expect(v.transcriber.calls).toHaveLength(0);
  });

  it("reports a missing transcriber again for a later meeting", async () => {
    const v = makeVoice();
    dirs.push(v.workDir);
    v.transcriber.configured = false;

    for (let meeting = 0; meeting < 2; meeting++) {
      const handle = await v.start();
      for (let i = 0; i < 3; i++) v.voice.push(speechFrame());
      for (let i = 0; i < 9; i++) v.voice.push(silenceFrame());
      await v.voice.whenIdle();
      await handle.stop();
    }

    // The process-wide flag must not make the second room silent about it.
    expect(v.failures).toHaveLength(2);
    expect(v.voice.drops).toBe(2);
  });

  it("writes one temp WAV per utterance and deletes it", async () => {
    const v = makeVoice();
    dirs.push(v.workDir);
    await v.start();
    for (let i = 0; i < 3; i++) v.voice.push(speechFrame());
    for (let i = 0; i < 9; i++) v.voice.push(silenceFrame());
    await v.voice.whenIdle();

    expect(v.transcriber.sizes[0]).toBeGreaterThan(44);
    expect(fs.readdirSync(v.workDir)).toEqual([]);
  });

  it("delivers nothing after the handle stops, so no late task runs", async () => {
    const v = makeVoice();
    dirs.push(v.workDir);
    const handle = await v.start();
    for (let i = 0; i < 3; i++) v.voice.push(speechFrame());
    for (let i = 0; i < 9; i++) v.voice.push(silenceFrame());
    await handle.stop();
    await v.voice.whenIdle();

    expect(v.utterances).toHaveLength(0);

    // Frames that arrive after the stop are ignored outright.
    v.voice.push(speechFrame());
    for (let i = 0; i < 9; i++) v.voice.push(silenceFrame());
    await v.voice.whenIdle();
    // The one transcription already under way was not repeated.
    expect(v.transcriber.calls).toHaveLength(1);
  });

  it("reports availability from the configured tool and model", async () => {
    const unconfigured = new BrowserVoice({
      config: BASE,
      logger: nullLogger(),
      workDir: ".",
    });
    expect(await unconfigured.available()).toEqual({
      available: false,
      reason: "no transcription tool is configured (voice.whisperPath)",
    });

    const configured = new BrowserVoice({
      config: { ...BASE, whisperPath: "w.exe", modelPath: "m.bin" },
      logger: nullLogger(),
      workDir: ".",
    });
    expect(await configured.available()).toEqual({ available: true });
  });
});
