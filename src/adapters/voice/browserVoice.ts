/**
 * The VoicePort: it takes the frames the meeting adapter drains from the page,
 * gates them by energy, cuts an utterance on silence, writes one short 16 kHz
 * WAV, transcribes it locally and hands the text to the core. Nothing here
 * decides what the words mean — a transcript is only ever a prompt.
 *
 * It also answers. The room hears only what the synthetic microphone publishes,
 * so a clip is synthesised locally by the Windows system voice, handed to the
 * page through the injectable sink, and played into that same destination. The
 * acknowledgement is made once at `start` and replayed from memory, because a
 * cold PowerShell start does not fit in the two-second budget after a cut. The
 * operator's own voice stops the avatar mid-sentence: an energy rise above the
 * floor drops the playing clip and everything queued behind it.
 *
 * The energy gate is the hallucination guard: a small model invents fluent
 * sentences over room tone, so a window whose audio never rose above the floor
 * is not an utterance at all — it is never transcribed and never counted.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../../config/config.js";
import type { Logger } from "../../logging/logger.js";
import type {
  StartListeningInput,
  VoiceAvailability,
  VoiceHandle,
  VoicePort,
} from "../../core/ports.js";
import {
  base64ToInt16,
  concatInt16,
  rms,
  SAMPLE_RATE,
  type RoomAudioFrame,
} from "./pcm.js";
import { SapiSynthesizer, type Synthesizer } from "./sapi.js";
import { pcmToWav } from "./wav.js";
import {
  WhisperTranscriber,
  type TranscribeResult,
  type Transcriber,
} from "./whisper.js";

/** The one thing the avatar says before it has anything to report. */
export const ACK_TEXT = "On it.";

/**
 * The longest text that is spoken. A long report would otherwise be read out
 * for minutes; the full text is already in the group, so the words are trimmed
 * at a word boundary and never dropped silently.
 */
export function capSpeech(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (maxChars <= 0 || clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  const trimmed = (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
  return `${trimmed}…`;
}

/** What the page says about the speech it is playing. */
export interface SpeechState {
  speaking: boolean;
  queued: number;
}

/** One clip ready for the page, and the temp WAV it came from. */
interface PreparedClip {
  base64: string;
  /** Deleted once the page has the clip; absent for the in-memory ack. */
  wavPath?: string;
}

/**
 * Where a clip goes to be heard. Production wires this to the meeting adapter,
 * which plays it into the page's synthetic microphone; tests inject a fake, so
 * no audio and no browser are needed.
 */
export interface SpeechSink {
  /**
   * Queue one base64 WAV for the room; false when there is no room to play it
   * in. `epoch` names the document the clip was readied for: a page that has
   * reloaded since must refuse it.
   */
  play(wavBase64: string, epoch?: number): Promise<boolean>;
  /** Stop the current clip and drop every clip queued behind it. */
  stop(): Promise<void>;
  /** What the page is playing, when it can say. */
  state?(): Promise<SpeechState>;
  /** The page's document generation; it changes when the room reloads. */
  epoch?(): number;
}

export interface BrowserVoiceOptions {
  config: Config["voice"];
  logger: Logger;
  /** Where an utterance's temp WAV lives; it is deleted right after the run. */
  workDir: string;
  /** Injectable for tests; production builds the fetched whisper.cpp tool. */
  transcriber?: Transcriber;
  /** Injectable for tests; production runs the Windows system voice. */
  synthesizer?: Synthesizer;
  /** Where spoken clips are played; absent means the adapter is deaf-mute. */
  sink?: SpeechSink;
}

/** One listening session: the accumulated audio between two cuts. */
interface Listening {
  input: StartListeningInput;
  chunks: Int16Array[];
  samples: number;
  /** Samples above the floor: the part that could actually hold a word. */
  speechSamples: number;
  silence: number;
  /** True once audio rose above the floor; only then is a window an utterance. */
  speaking: boolean;
}

export class BrowserVoice implements VoicePort {
  private readonly config: Config["voice"];
  private readonly logger: Logger;
  private readonly workDir: string;
  private readonly transcriber: Transcriber;
  private readonly synthesizer: Synthesizer;
  private readonly sink: SpeechSink | undefined;
  private listening: Listening | undefined;
  /** Transcriptions in flight, in order, so shutdown can wait for them. */
  private pending: Promise<void> = Promise.resolve();
  /** Speech in flight, in order, so the acknowledgement plays before an answer. */
  private speechWork: Promise<void> = Promise.resolve();
  /** The pre-made acknowledgement, ready to play the moment a question is cut. */
  private ack: string | undefined;
  /** The acknowledgement being made at `start`; whenIdle waits for it. */
  private ackReady: Promise<void> | undefined;
  /**
   * Every queued clip carries a generation: a barge-in or a new meeting bumps
   * it, and a clip whose generation is stale is dropped rather than played late.
   */
  private speechGeneration = 0;
  /** True once a clip was handed to the page and not yet stopped. */
  private speaking = false;
  /** True while a clip is still being synthesised, before the page has it. */
  private pendingSpeech = false;
  private bargeInPending = false;
  /** Consecutive loud milliseconds; a single spike is not an interruption. */
  private loudMs = 0;
  /** When the acknowledgement last played, so fragments cannot make it nag. */
  private lastAckAt = Number.NEGATIVE_INFINITY;
  private dropped = 0;
  /** The missing-config reason is worth saying once, not once per sentence. */
  private missingReported = false;
  /** The speech failure is posted once per meeting, not once per clip. */
  private speechFailureReported = false;

  constructor(options: BrowserVoiceOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.workDir = options.workDir;
    this.synthesizer =
      options.synthesizer ??
      new SapiSynthesizer({
        workDir: options.workDir,
        rate: options.config.rate,
        voiceName: options.config.voiceName,
      });
    this.sink = options.sink;
    this.transcriber =
      options.transcriber ??
      new WhisperTranscriber({
        command: options.config.whisperPath,
        modelPath: options.config.modelPath,
        ...(options.config.vadPath ? { vadPath: options.config.vadPath } : {}),
        ...(options.config.language ? { language: options.config.language } : {}),
        logger: options.logger,
      });
  }

  /** How many utterances were dropped: a blank transcript or a failed run. */
  get drops(): number {
    return this.dropped;
  }

  async available(): Promise<VoiceAvailability> {
    if (!this.config.whisperPath.trim()) {
      return { available: false, reason: "no transcription tool is configured (voice.whisperPath)" };
    }
    if (!this.config.modelPath.trim()) {
      return { available: false, reason: "no transcription model is configured (voice.modelPath)" };
    }
    return { available: true };
  }

  async start(input: StartListeningInput): Promise<VoiceHandle> {
    // A previous process may have died mid-sentence: its clip is not for us.
    this.sweepStaleClips();
    // Each meeting is a fresh promise: a later room must say again when the
    // transcriber is missing instead of inheriting the previous room's silence.
    this.missingReported = false;
    this.speechFailureReported = false;
    // A new meeting starts silent: anything still queued for a previous room is
    // invalidated here rather than played into this one.
    this.speechGeneration += 1;
    this.speaking = false;
    this.pendingSpeech = false;
    this.loudMs = 0;
    this.lastAckAt = Number.NEGATIVE_INFINITY;
    this.ack = undefined;
    this.listening = {
      input,
      chunks: [],
      samples: 0,
      speechSamples: 0,
      silence: 0,
      speaking: false,
    };
    // The acknowledgement is made now, before it is needed: a cold PowerShell
    // start does not fit in the two-second budget after an utterance is cut.
    this.ackReady = this.prepareAck(input).catch(() => undefined);
    return {
      stop: async (): Promise<void> => {
        if (this.listening?.input === input) this.listening = undefined;
        await this.stopSpeech();
        // Wait for the acknowledgement being made and a clip already being
        // synthesised: each deletes its temp WAV before it notices the stop, so
        // no audio outlives the meeting.
        await this.ackReady?.catch(() => undefined);
        await this.speechWork.catch(() => undefined);
      },
      speak: (text: string): Promise<void> => this.speak(input, text),
      stopSpeaking: (): Promise<void> => this.stopSpeech(),
    };
  }

  async stop(): Promise<void> {
    this.listening = undefined;
    await this.stopSpeech();
    await this.ackReady?.catch(() => undefined);
    await this.pending.catch(() => undefined);
    await this.speechWork.catch(() => undefined);
  }

  /** The meeting adapter hands every frame it drains from the page here. */
  push(frame: RoomAudioFrame): void {
    const listening = this.listening;
    if (!listening) return;

    const samples = base64ToInt16(frame.pcm);
    const level = samples.length > 0 ? rms(samples) : Math.max(0, frame.rms || 0);
    listening.input.onLevel?.(level);

    // The operator's own voice outranks the avatar, but a single noise spike
    // does not: only sustained speech stops the clip. The page says whether it
    // is really speaking, so a quiet room is not mistaken for a stop.
    if (level >= this.config.rmsFloor) {
      this.loudMs += (samples.length * 1000) / SAMPLE_RATE;
      if (this.loudMs >= this.config.bargeInMs) void this.bargeIn(listening.input);
    } else {
      this.loudMs = 0;
    }

    if (samples.length === 0) return;

    if (level >= this.config.rmsFloor) {
      listening.speaking = true;
      listening.silence = 0;
      listening.speechSamples += samples.length;
    } else if (!listening.speaking) {
      // Room tone before any speech is not an utterance: there is nothing to cut
      // and nothing to count, so a quiet room never inflates the drop counter.
      return;
    } else {
      listening.silence += samples.length;
    }

    listening.chunks.push(samples);
    listening.samples += samples.length;

    const silenceReached =
      (listening.silence * 1000) / SAMPLE_RATE >= this.config.silenceMs;
    const tooLong =
      (listening.samples * 1000) / SAMPLE_RATE >= this.config.maxUtteranceMs;
    if (silenceReached || tooLong) this.cut(listening);
  }

  /** Await every transcription and clip already under way (tests and shutdown). */
  async whenIdle(): Promise<void> {
    await this.ackReady?.catch(() => undefined);
    await this.pending.catch(() => undefined);
    await this.speechWork.catch(() => undefined);
  }

  /** Close the utterance being accumulated: acknowledge, transcribe, or close nothing. */
  private cut(listening: Listening): void {
    const samples = concatInt16(listening.chunks);
    const speaking = listening.speaking;
    const speechSamples = listening.speechSamples;
    listening.chunks = [];
    listening.samples = 0;
    listening.speechSamples = 0;
    listening.silence = 0;
    listening.speaking = false;
    // Only a window that carried speech is an utterance; a silent stretch never
    // reaches here, and never becomes a dropped utterance.
    if (!speaking || samples.length === 0) return;
    // A click, a door or a burst of room tone is not a question: less than a
    // word of actual speech is dropped before any acknowledgement or model run.
    const speechMs = (speechSamples * 1000) / SAMPLE_RATE;
    if (speechMs < this.config.minUtteranceMs) {
      this.logger.debug("voice: ignored a too-short window", { speechMs });
      return;
    }
    // The acknowledgement goes out before the slow local transcription, so the
    // room hears it inside the budget instead of waiting for the model.
    void this.acknowledge(listening.input);
    this.pending = this.pending
      .then(() => this.transcribe(listening.input, samples))
      .catch(() => undefined);
  }

  // --- speaking -------------------------------------------------------------

  /** Make the one short acknowledgement and keep it, playable at any moment. */
  private async prepareAck(input: StartListeningInput): Promise<void> {
    // A deaf room has nothing to answer, so it gets no acknowledgement either.
    if (!this.sink || !this.synthesizer.configured || !this.transcriber.configured) return;
    const result = await this.synthesizer.synthesize(ACK_TEXT);
    if (!result.ok) {
      this.reportSpeechFailure(input, result.reason);
      return;
    }
    const clip = this.readClip(result.wavPath);
    // The acknowledgement waits in memory for the rest of the meeting, so its
    // temp file is not needed beyond this read.
    this.discardClip(result.wavPath);
    if (!clip) {
      this.reportSpeechFailure(input, "the voice wrote no audio");
      return;
    }
    // The meeting may have ended while the voice was starting up.
    if (this.listening?.input !== input) return;
    this.ack = clip;
  }

  /** Say the acknowledgement the page already has in memory. */
  private acknowledge(input: StartListeningInput): Promise<void> {
    // Fragments cut one after another must not turn the room into a chorus of
    // "On it": the task still starts, but the acknowledgement is rate-limited.
    const now = Date.now();
    if (now - this.lastAckAt < this.config.ackCooldownMs) return Promise.resolve();
    this.lastAckAt = now;
    return this.enqueueSpeech(input, async () => {
      // If the very first question lands while the clip is still being made,
      // wait for it rather than answering with silence.
      await this.ackReady?.catch(() => undefined);
      const ack = this.listening?.input === input ? this.ack : undefined;
      return ack ? { base64: ack } : undefined;
    });
  }

  /** Speak an answer; a cap keeps a long report out of the room's ears. */
  private speak(input: StartListeningInput, text: string): Promise<void> {
    const capped = capSpeech(text, this.config.maxSpeechChars);
    if (!capped) return Promise.resolve();
    return this.enqueueSpeech(input, async () => {
      const result = await this.synthesizer.synthesize(capped);
      if (!result.ok) {
        this.reportSpeechFailure(input, result.reason);
        return undefined;
      }
      const base64 = this.readClip(result.wavPath);
      if (!base64) {
        this.discardClip(result.wavPath);
        this.reportSpeechFailure(input, "the voice wrote no audio");
        return undefined;
      }
      // The WAV lives until the page has the clip; enqueueSpeech deletes it.
      return { base64, wavPath: result.wavPath };
    });
  }

  /**
   * Queue one clip behind the clips already queued. `makeClip` produces the
   * base64 at its turn, so a clip the operator interrupts is never synthesised.
   */
  private enqueueSpeech(
    input: StartListeningInput,
    makeClip: () => Promise<PreparedClip | undefined>,
  ): Promise<void> {
    if (!this.sink || !this.synthesizer.configured) return Promise.resolve();
    const generation = this.speechGeneration;
    // A reload destroys the document a clip was made for; remember which one it
    // belongs to and never play it into the next.
    const epoch = this.sink.epoch?.();
    const task = async (): Promise<void> => {
      // A barge-in while an earlier clip played invalidates everything queued.
      if (generation !== this.speechGeneration) return;
      if (this.sink?.epoch && this.sink.epoch() !== epoch) return;
      // Say "speech is coming" before the slow synthesis, so an operator who
      // talks over the wait still stops it instead of being talked over.
      this.pendingSpeech = true;
      let clip: PreparedClip | undefined;
      try {
        clip = await makeClip();
        if (!clip) return;
        if (generation !== this.speechGeneration) return;
        if (this.sink?.epoch && this.sink.epoch() !== epoch) return;
        await this.playClip(input, clip.base64, epoch);
      } finally {
        // No audio outlives the page having the clip.
        if (clip?.wavPath) this.discardClip(clip.wavPath);
        this.pendingSpeech = false;
      }
    };
    const run = this.speechWork
      .then(task)
      .catch((err: unknown) => {
        this.reportSpeechFailure(input, `speech failed: ${String(err)}`);
      });
    this.speechWork = run;
    return run;
  }

  /** Hand one clip to the page; a room that cannot play it is said once. */
  private async playClip(
    input: StartListeningInput,
    base64: string,
    epoch?: number,
  ): Promise<void> {
    const sink = this.sink;
    if (!sink) return;
    this.speaking = true;
    try {
      const queued = await sink.play(base64, epoch);
      if (queued === false) {
        this.speaking = false;
        this.reportSpeechFailure(input, "the room could not play the answer");
      }
    } catch (err: unknown) {
      this.speaking = false;
      this.reportSpeechFailure(input, `the room could not play the answer: ${String(err)}`);
    }
  }

  /**
   * The operator's voice, above the gate: stop mid-sentence and drop the queue.
   * A clip still being synthesised counts as speaking, as does a page that is
   * playing one, so a question asked into a silent room never cancels the
   * answer it started.
   */
  private async bargeIn(input: StartListeningInput): Promise<void> {
    if (this.bargeInPending) return;
    if (this.listening?.input !== input) return;
    const sink = this.sink;
    if (!sink) return;
    this.bargeInPending = true;
    try {
      // The synthesis window has no page state yet, so the adapter's own flags
      // are as important as the page's answer.
      let active = this.speaking || this.pendingSpeech;
      if (sink.state) {
        try {
          const state = await sink.state();
          active = active || state.speaking || state.queued > 0;
        } catch {
          // The page could not say; trust the clip this adapter is preparing.
        }
      }
      if (!active) return;
      this.logger.info("voice: the operator spoke; stopping the answer");
      await this.stopSpeech();
    } finally {
      this.bargeInPending = false;
    }
  }

  /** Silence the room at once; every clip still queued is dropped. */
  private async stopSpeech(): Promise<void> {
    this.speechGeneration += 1;
    this.speaking = false;
    const sink = this.sink;
    if (!sink) return;
    try {
      await sink.stop();
    } catch (err: unknown) {
      this.logger.warn("voice: stopping speech failed", { error: String(err) });
    }
  }

  /** Read a clip into memory; a file that will not read is not a crash. */
  private readClip(wavPath: string): string | undefined {
    try {
      return fs.readFileSync(wavPath).toString("base64");
    } catch (err: unknown) {
      this.logger.warn("voice: could not read the clip", { error: String(err) });
      return undefined;
    }
  }

  private discardClip(wavPath: string): void {
    try {
      fs.rmSync(wavPath, { force: true });
    } catch {
      // The clip stands; a file that will not delete is not the failure.
    }
  }

  /**
   * A previous process may have died while the voice was starting up, leaving
   * its clip behind. Only speech files are swept: an utterance WAV belongs to a
   * transcription this adapter may still be reading.
   */
  private sweepStaleClips(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.workDir);
    } catch {
      return; // no directory yet: there is nothing stale to remove
    }
    for (const name of names) {
      if (!/^speech-.*\.wav$/i.test(name)) continue;
      this.discardClip(path.join(this.workDir, name));
    }
  }

  /** Say a speech failure once per meeting; the meeting keeps running. */
  private reportSpeechFailure(input: StartListeningInput, reason: string): void {
    this.logger.warn("voice: speech failed", { reason });
    if (this.speechFailureReported) return;
    this.speechFailureReported = true;
    if (this.listening?.input !== input) return;
    input.onFailure?.(reason);
  }

  /**
   * Count a dropped utterance and say so. The first one and the session's total
   * are stated at info level, so a deaf meeting is visible in the default log.
   */
  private countDrop(reason: string): void {
    this.dropped += 1;
    this.logger.info(
      this.dropped === 1 ? "voice: first dropped utterance" : "voice: dropped utterance",
      { reason, drops: this.dropped },
    );
  }

  private async transcribe(input: StartListeningInput, samples: Int16Array): Promise<void> {
    if (!this.transcriber.configured) {
      const reason = this.missingReason();
      this.countDrop(reason);
      if (!this.missingReported) {
        this.missingReported = true;
        input.onFailure?.(reason);
      }
      return;
    }

    const wavPath = path.join(this.workDir, `utterance-${crypto.randomUUID()}.wav`);
    let result: TranscribeResult;
    try {
      fs.mkdirSync(this.workDir, { recursive: true });
      fs.writeFileSync(wavPath, pcmToWav(samples, SAMPLE_RATE));
      result = await this.transcriber.transcribe(wavPath);
    } catch (err: unknown) {
      result = { ok: false as const, reason: `transcription failed: ${String(err)}` };
    } finally {
      // No audio outlives the run: one temp file, deleted immediately. A delete
      // that fails must not replace the transcription's own result.
      try {
        fs.rmSync(wavPath, { force: true });
      } catch {
        // The outcome stands; a file that will not delete is not the failure.
      }
    }

    // The meeting may have ended while the model ran; a stopped session hears
    // nothing, so a late transcript never becomes a task.
    if (this.listening?.input !== input) return;

    if (!result.ok) {
      this.countDrop(result.reason);
      input.onFailure?.(result.reason);
      return;
    }
    if (!result.text) {
      this.countDrop("blank transcript");
      return;
    }
    input.onUtterance({
      text: result.text,
      durationMs: Math.round((samples.length * 1000) / SAMPLE_RATE),
    });
  }

  private missingReason(): string {
    return this.config.whisperPath.trim()
      ? "no transcription model is configured (voice.modelPath)"
      : "no transcription tool is configured (voice.whisperPath)";
  }
}
