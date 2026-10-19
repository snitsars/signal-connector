/**
 * The one subprocess in the voice path: the whisper.cpp binary the operator
 * fetched with `scripts/install-whisper.ps1`. It runs with a bounded timeout,
 * its text is parsed, and a missing tool or a failed run comes back as a reason
 * rather than an exception, so the meeting keeps running.
 */
import { spawn } from "node:child_process";
import os from "node:os";
import type { Logger } from "../../logging/logger.js";
import { resolveCommand } from "../spawnCommand.js";

export interface TranscribeRun {
  command: string;
  args: string[];
  timeoutMs: number;
}

export interface RunOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Injectable, so a test can prove the arguments, the timeout and the parse. */
export type ProcessRunner = (run: TranscribeRun) => Promise<RunOutcome>;

export type TranscribeResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

/** What the pipeline needs of a transcriber; the fake in tests implements it. */
export interface Transcriber {
  /** False when no tool or model is configured. */
  readonly configured: boolean;
  transcribe(wavPath: string): Promise<TranscribeResult>;
}

/**
 * Keep the model's words and drop its non-speech markers: a timestamped line,
 * a wholly bracketed `[BLANK_AUDIO]` / `(silence)` line, or nothing at all.
 */
export function parseTranscript(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^\[[\d:.\s\->]*\]\s*/, "").trim())
    .filter((line) => line.length > 0 && !/^[[(].*[\])]$/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Spawn the tool, cap it by time, and collect what it printed. */
function spawnedRunner(run: TranscribeRun): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const resolved = resolveCommand(run.command, run.args);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (outcome: RunOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(outcome);
    };

    let child;
    try {
      child = spawn(resolved.command, resolved.args, {
        shell: resolved.shell,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: unknown) {
      resolve({ code: null, stdout: "", stderr: String(err), timedOut: false });
      return;
    }

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      finish({ code: null, stdout, stderr: `${stderr}${String(err)}`, timedOut });
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr, timedOut });
    });
    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish({ code: null, stdout, stderr, timedOut: true });
    }, run.timeoutMs);
  });
}

export interface WhisperOptions {
  /** The fetched binary, e.g. `…\whisper-cli.exe`. Empty means not configured. */
  command: string;
  /** The multilingual model file, e.g. `…\ggml-base.bin`. */
  modelPath: string;
  /**
   * The optional Silero VAD model. With it, whisper skips non-speech segments
   * instead of inventing words over room tone.
   */
  vadPath?: string;
  /** Spoken language; "auto" lets the model decide. */
  language?: string;
  /**
   * CPU threads for the model. Defaults to the machine's logical cores, capped
   * at eight: a bigger model on a laptop needs every core it can get.
   */
  threads?: number;
  /** How long one transcription may run before it is killed. */
  timeoutMs?: number;
  runner?: ProcessRunner;
  logger?: Logger;
}

export class WhisperTranscriber implements Transcriber {
  private readonly options: WhisperOptions;
  private readonly runner: ProcessRunner;
  private readonly timeoutMs: number;
  private readonly threads: number;

  constructor(options: WhisperOptions) {
    this.options = options;
    this.runner = options.runner ?? spawnedRunner;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.threads = options.threads ?? Math.min(8, os.availableParallelism());
  }

  get configured(): boolean {
    return (
      this.options.command.trim().length > 0 && this.options.modelPath.trim().length > 0
    );
  }

  /** The argv one run uses; exposed so a test can prove it. */
  argumentsFor(wavPath: string): string[] {
    const args = [
      "-m",
      this.options.modelPath,
      "-f",
      wavPath,
      "-l",
      this.options.language?.trim() || "auto",
      "-nt", // no timestamps
      "-np", // no progress or system info, just the words
      // Suppress the model's non-speech tokens ("[BLANK_AUDIO]", "(music)").
      "-sns",
      "-t",
      String(this.threads),
    ];
    // A VAD model is the strongest guard against transcription over room tone:
    // whisper skips the segments Silero says are not speech.
    const vad = this.options.vadPath?.trim();
    if (vad) {
      args.push("--vad", "-vm", vad);
      // The default speech pad trims the first and last syllables, which turned
      // "Скільки тестів у проєкцію?" into "кількі тестів". 200 ms keeps them.
      args.push("--vad-speech-pad-ms", "200");
    }
    return args;
  }

  async transcribe(wavPath: string): Promise<TranscribeResult> {
    if (!this.options.command.trim()) {
      return { ok: false, reason: "no transcription tool is configured (voice.whisperPath)" };
    }
    if (!this.options.modelPath.trim()) {
      return { ok: false, reason: "no transcription model is configured (voice.modelPath)" };
    }

    let outcome: RunOutcome;
    try {
      outcome = await this.runner({
        command: this.options.command,
        args: this.argumentsFor(wavPath),
        timeoutMs: this.timeoutMs,
      });
    } catch (err: unknown) {
      return { ok: false, reason: `the transcriber could not run: ${String(err)}` };
    }

    if (outcome.timedOut) return { ok: false, reason: "the transcriber timed out" };
    if (outcome.code !== 0) {
      const detail = outcome.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1);
      return {
        ok: false,
        reason: detail ? `the transcriber failed: ${detail}` : "the transcriber exited non-zero",
      };
    }
    return { ok: true, text: parseTranscript(outcome.stdout) };
  }
}
