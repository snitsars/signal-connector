/**
 * The VoicePort: it takes the frames the meeting adapter drains from the page,
 * gates them by energy, cuts an utterance on silence, writes one short 16 kHz
 * WAV, transcribes it locally and hands the text to the core. Nothing here
 * decides what the words mean — a transcript is only ever a prompt.
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
import { pcmToWav } from "./wav.js";
import {
  WhisperTranscriber,
  type TranscribeResult,
  type Transcriber,
} from "./whisper.js";

export interface BrowserVoiceOptions {
  config: Config["voice"];
  logger: Logger;
  /** Where an utterance's temp WAV lives; it is deleted right after the run. */
  workDir: string;
  /** Injectable for tests; production builds the fetched whisper.cpp tool. */
  transcriber?: Transcriber;
}

/** One listening session: the accumulated audio between two cuts. */
interface Listening {
  input: StartListeningInput;
  chunks: Int16Array[];
  samples: number;
  silence: number;
  /** True once audio rose above the floor; only then is a window an utterance. */
  speaking: boolean;
}

export class BrowserVoice implements VoicePort {
  private readonly config: Config["voice"];
  private readonly logger: Logger;
  private readonly workDir: string;
  private readonly transcriber: Transcriber;
  private listening: Listening | undefined;
  /** Transcriptions in flight, in order, so shutdown can wait for them. */
  private pending: Promise<void> = Promise.resolve();
  private dropped = 0;
  /** The missing-config reason is worth saying once, not once per sentence. */
  private missingReported = false;

  constructor(options: BrowserVoiceOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.workDir = options.workDir;
    this.transcriber =
      options.transcriber ??
      new WhisperTranscriber({
        command: options.config.whisperPath,
        modelPath: options.config.modelPath,
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
    // Each meeting is a fresh promise: a later room must say again when the
    // transcriber is missing instead of inheriting the previous room's silence.
    this.missingReported = false;
    this.listening = {
      input,
      chunks: [],
      samples: 0,
      silence: 0,
      speaking: false,
    };
    return {
      stop: async (): Promise<void> => {
        if (this.listening?.input === input) this.listening = undefined;
      },
    };
  }

  async stop(): Promise<void> {
    this.listening = undefined;
    await this.pending.catch(() => undefined);
  }

  /** The meeting adapter hands every frame it drains from the page here. */
  push(frame: RoomAudioFrame): void {
    const listening = this.listening;
    if (!listening) return;

    const samples = base64ToInt16(frame.pcm);
    const level = samples.length > 0 ? rms(samples) : Math.max(0, frame.rms || 0);
    listening.input.onLevel?.(level);
    if (samples.length === 0) return;

    if (level >= this.config.rmsFloor) {
      listening.speaking = true;
      listening.silence = 0;
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

  /** Await every transcription already under way (tests and shutdown). */
  whenIdle(): Promise<void> {
    return this.pending;
  }

  /** Close the utterance being accumulated: transcribe it, or close nothing. */
  private cut(listening: Listening): void {
    const samples = concatInt16(listening.chunks);
    const speaking = listening.speaking;
    listening.chunks = [];
    listening.samples = 0;
    listening.silence = 0;
    listening.speaking = false;
    // Only a window that carried speech is an utterance; a silent stretch never
    // reaches here, and never becomes a dropped utterance.
    if (!speaking || samples.length === 0) return;
    this.pending = this.pending
      .then(() => this.transcribe(listening.input, samples))
      .catch(() => undefined);
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
