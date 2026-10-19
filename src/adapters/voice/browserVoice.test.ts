import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../../config/config.js";
import { nullLogger } from "../../logging/logger.js";
import type { Utterance } from "../../core/ports.js";
import {
  ACK_TEXT,
  BrowserVoice,
  capSpeech,
  type SpeechSink,
  type SpeechState,
} from "./browserVoice.js";
import { int16ToBase64, type RoomAudioFrame } from "./pcm.js";
import type { SynthesizeResult, Synthesizer } from "./sapi.js";
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
  /** Set to hold a transcription open, as a slow local model would. */
  gate: Promise<void> | undefined;
  private openGate: (() => void) | undefined;
  readonly events: string[] = [];

  /** Hold the next transcription until release(). */
  hold(): void {
    this.gate = new Promise((resolve) => {
      this.openGate = resolve;
    });
  }

  release(): void {
    this.openGate?.();
    this.openGate = undefined;
    this.gate = undefined;
  }

  async transcribe(wavPath: string): Promise<TranscribeResult> {
    this.calls.push(wavPath);
    this.events.push("transcribe");
    // Prove the WAV was on disk when the tool was asked to open it.
    this.sizes.push(fs.existsSync(wavPath) ? fs.statSync(wavPath).size : -1);
    if (this.gate) await this.gate;
    return this.result;
  }
}

/** A synthesiser that writes a real temp WAV, so the adapter's clip path runs. */
class StubSynthesizer implements Synthesizer {
  configured = true;
  readonly texts: string[] = [];
  readonly events: string[] = [];
  /** Set to fail, as a machine without the Windows voice would. */
  fail: string | undefined;
  private seq = 0;
  private gate: Promise<void> | undefined;
  private openGate: (() => void) | undefined;

  constructor(private readonly dir: string) {}

  hold(): void {
    this.gate = new Promise((resolve) => {
      this.openGate = resolve;
    });
  }

  release(): void {
    this.openGate?.();
    this.openGate = undefined;
    this.gate = undefined;
  }

  async synthesize(text: string): Promise<SynthesizeResult> {
    this.texts.push(text);
    this.events.push("synthesize");
    if (this.fail) return { ok: false, reason: this.fail };
    if (this.gate) await this.gate;
    const wavPath = path.join(this.dir, `speech-${++this.seq}.wav`);
    fs.writeFileSync(wavPath, Buffer.from(`clip-${this.seq}`));
    return { ok: true, wavPath };
  }
}

/** The page's player: records the clips it was given and answers for its state. */
class StubSink implements SpeechSink {
  readonly played: string[] = [];
  readonly events: string[] = [];
  stops = 0;
  speaking = false;
  queued = 0;
  failPlay = false;
  /** Bumped by a test to stand for the page reloading. */
  epochs = 0;

  async play(wavBase64: string): Promise<boolean> {
    if (this.failPlay) return false;
    this.played.push(wavBase64);
    this.events.push("play");
    return true;
  }

  async stop(): Promise<void> {
    this.stops += 1;
    this.speaking = false;
    this.queued = 0;
  }

  async state(): Promise<SpeechState> {
    return { speaking: this.speaking, queued: this.queued };
  }

  epoch(): number {
    return this.epochs;
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

/** A voice with a fake synthesiser and a fake player, sharing one temp dir. */
function speaking(config = BASE) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-"));
  const transcriber = new StubTranscriber();
  const synthesizer = new StubSynthesizer(workDir);
  const sink = new StubSink();
  const voice = new BrowserVoice({
    config,
    logger: nullLogger(),
    workDir,
    transcriber,
    synthesizer,
    sink,
  });
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
  return { voice, transcriber, workDir, utterances, failures, levels, synthesizer, sink, start };
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

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** The frames that make one cut utterance, as the page would report them. */
const askSomething = (voice: BrowserVoice): void => {
  for (let i = 0; i < 3; i++) voice.push(speechFrame());
  for (let i = 0; i < 9; i++) voice.push(silenceFrame());
};

describe("capSpeech", () => {
  it("leaves a short answer alone", () => {
    expect(capSpeech("  the parser   is fixed ", 100)).toBe("the parser is fixed");
  });

  it("trims a long answer at a word boundary and marks the cut", () => {
    const text = `${"word ".repeat(60)}end`;
    const capped = capSpeech(text, 100);
    expect(capped.length).toBeLessThanOrEqual(101);
    expect(capped.endsWith("…")).toBe(true);
    expect(capped.startsWith("word word")).toBe(true);
    // It is a truncation, never a silent drop: the beginning is all there.
    expect(text.startsWith(capped.slice(0, -1).trimEnd())).toBe(true);
  });

  it("returns nothing for blank text", () => {
    expect(capSpeech("   \n  ", 100)).toBe("");
  });
});

describe("BrowserVoice speech", () => {
  it("makes the acknowledgement before it is needed and plays it on a cut question", async () => {
    const v = speaking();
    dirs.push(v.workDir);
    const handle = await v.start();
    await v.voice.whenIdle();
    // Ready in memory, and silent until a question is heard.
    expect(v.synthesizer.texts).toEqual([ACK_TEXT]);
    expect(v.sink.played).toHaveLength(0);

    askSomething(v.voice);
    await v.voice.whenIdle();

    expect(v.sink.played).toHaveLength(1);
    // The clip is the acknowledgement's bytes, not a fresh synthesis.
    expect(v.synthesizer.texts).toEqual([ACK_TEXT]);
    expect(v.utterances).toHaveLength(1);
    // Played from the pre-made clip, before the model's answer exists.
    expect(v.sink.events[0]).toBe("play");
    await handle.stop();
  });

  it("waits for the acknowledgement when the first question arrives early", async () => {
    const v = speaking();
    dirs.push(v.workDir);
    // The voice is still starting up when the room asks its first question.
    v.synthesizer.hold();
    const handle = await v.start();
    askSomething(v.voice);
    await flush();
    expect(v.sink.played).toHaveLength(0);

    v.synthesizer.release();
    await v.voice.whenIdle();
    expect(v.sink.played).toHaveLength(1);
    await handle.stop();
  });

  it("queues the acknowledgement ahead of the transcription it does not wait for", async () => {
    const v = speaking();
    dirs.push(v.workDir);
    v.transcriber.hold();
    await v.start();
    await v.voice.whenIdle();

    askSomething(v.voice);
    await flush();

    // The acknowledgement is out while the local model is still running.
    expect(v.sink.played).toHaveLength(1);
    expect(v.transcriber.events).toContain("transcribe");
    expect(v.utterances).toHaveLength(0);

    v.transcriber.release();
    await v.voice.whenIdle();
    expect(v.utterances).toHaveLength(1);
  });

  it("speaks a supplied answer, capped, and deletes the temp WAV", async () => {
    const v = speaking({ ...BASE, maxSpeechChars: 40 });
    dirs.push(v.workDir);
    const handle = await v.start();
    await v.voice.whenIdle();

    const long = `${"detail ".repeat(30)}the end`;
    await handle.speak(long);

    expect(v.synthesizer.texts).toHaveLength(2); // the acknowledgement, then the answer
    const spokenText = v.synthesizer.texts[1]!;
    expect(spokenText.length).toBeLessThanOrEqual(41);
    expect(spokenText.endsWith("…")).toBe(true);
    expect(v.sink.played).toHaveLength(1); // only the answer: no question was heard
    // No audio outlives the clip.
    expect(fs.readdirSync(v.workDir)).toEqual([]);
  });

  it("stops mid-sentence when the operator speaks and drops the queued answer", async () => {
    const v = speaking();
    dirs.push(v.workDir);
    const handle = await v.start();
    await v.voice.whenIdle();

    askSomething(v.voice);
    await v.voice.whenIdle();
    expect(v.sink.played).toHaveLength(1);

    // The page is playing the acknowledgement when the answer is prepared.
    v.sink.speaking = true;
    // The answer is being synthesised when the operator talks over it.
    v.synthesizer.hold();
    const pending = handle.speak("a long answer");
    await flush();
    v.voice.push(speechFrame());
    await flush();

    expect(v.sink.stops).toBe(1);
    expect(v.sink.speaking).toBe(false);

    v.synthesizer.release();
    await pending;
    // The queued clip was dropped, not played late.
    expect(v.sink.played).toHaveLength(1);
  });

  it("keeps the answer queued when the room is silent", async () => {
    const v = speaking();
    dirs.push(v.workDir);
    const handle = await v.start();
    await v.voice.whenIdle();

    // Room tone below the gate is not an interruption.
    v.sink.speaking = false;
    v.voice.push(toneFrame());
    await flush();
    expect(v.sink.stops).toBe(0);

    await handle.speak("the answer");
    expect(v.sink.played).toHaveLength(1);
  });

  it("posts a failing voice once and keeps transcribing", async () => {
    const v = speaking();
    dirs.push(v.workDir);
    v.synthesizer.fail = "the voice failed: no voice installed";
    const handle = await v.start();
    await v.voice.whenIdle();

    expect(v.failures).toHaveLength(1);
    expect(v.failures[0]).toContain("no voice installed");

    // Later failures are counted in the log, not repeated in the group.
    await handle.speak("first answer");
    await handle.speak("second answer");
    expect(v.failures).toHaveLength(1);

    askSomething(v.voice);
    await v.voice.whenIdle();
    // Hearing still works: the meeting is not a crash.
    expect(v.utterances).toHaveLength(1);
  });

  it("interrupts a clip still being synthesised even when the page is idle", async () => {
    const v = speaking();
    dirs.push(v.workDir);
    const handle = await v.start();
    await v.voice.whenIdle();
    // No page state says "speaking": the answer is still in the voice.
    v.sink.speaking = false;
    v.synthesizer.hold();
    const pending = handle.speak("an answer still being made");
    await flush();
    expect(v.sink.played).toHaveLength(0);

    v.voice.push(speechFrame());
    await flush();

    // The pending clip counts as speech, so the operator silences it.
    expect(v.sink.stops).toBe(1);
    v.synthesizer.release();
    await pending;
    expect(v.sink.played).toHaveLength(0);
    await handle.stop();
  });

  it("drops a clip readied for a document that has since reloaded", async () => {
    const v = speaking();
    dirs.push(v.workDir);
    const handle = await v.start();
    await v.voice.whenIdle();
    v.synthesizer.hold();
    const pending = handle.speak("an answer for the old page");
    await flush();

    // The page reloaded while the voice was still making the clip.
    v.sink.epochs += 1;
    v.synthesizer.release();
    await pending;

    expect(v.sink.played).toHaveLength(0);
    await handle.stop();
  });

  it("sweeps a stale speech file left by a previous process", async () => {
    const v = speaking();
    dirs.push(v.workDir);
    const stale = path.join(v.workDir, "speech-stale.wav");
    const utterance = path.join(v.workDir, "utterance-keep.wav");
    fs.writeFileSync(stale, "old clip");
    fs.writeFileSync(utterance, "in use");

    const handle = await v.start();
    await v.voice.whenIdle();

    expect(fs.existsSync(stale)).toBe(false);
    // Only speech files are swept; an utterance may still be read.
    expect(fs.existsSync(utterance)).toBe(true);
    await handle.stop();
  });

  it("waits for the acknowledgement being made before it stops", async () => {
    const v = speaking();
    dirs.push(v.workDir);
    v.synthesizer.hold();
    const handle = await v.start();

    let stopped = false;
    const stopping = handle.stop().then(() => {
      stopped = true;
    });
    await flush();
    // The voice is still writing its clip, so stopping has not returned.
    expect(stopped).toBe(false);

    v.synthesizer.release();
    await stopping;
    expect(fs.readdirSync(v.workDir)).toEqual([]);
  });

  it("stops speech and drops the queue when the handle stops", async () => {
    const v = speaking();
    dirs.push(v.workDir);
    const handle = await v.start();
    await v.voice.whenIdle();
    v.sink.speaking = true;

    await handle.stopSpeaking();
    expect(v.sink.stops).toBe(1);
    expect(v.sink.speaking).toBe(false);
  });
});
