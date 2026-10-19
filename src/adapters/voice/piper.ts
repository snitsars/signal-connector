/**
 * The local neural voice: Piper, fetched the way whisper.cpp is.
 *
 * Piper reads the answer on standard input and writes one WAV with its own
 * speaker model, so the room hears a natural voice instead of the Windows
 * system voice. Nothing is hosted and nothing is installed from npm: the
 * binary and the `.onnx` voice are plain downloads. A missing voice or a
 * failed run comes back as a reason, so the meeting keeps running.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveCommand } from "../spawnCommand.js";
import type { SynthesizeResult, Synthesizer } from "./sapi.js";

/** One bounded Piper run: the text rides on stdin, like the CLI expects. */
export interface PiperRun {
  command: string;
  args: string[];
  input: string;
  timeoutMs: number;
}

export interface PiperOutcome {
  code: number | null;
  stderr: string;
  timedOut: boolean;
}

/** Injectable, so a test proves the argv, the stdin text and a failed run. */
export type PiperRunner = (run: PiperRun) => Promise<PiperOutcome>;

/** Spawn Piper, feed it the sentence, and cap the run by time. */
function spawnedRunner(run: PiperRun): Promise<PiperOutcome> {
  return new Promise((resolve) => {
    const resolved = resolveCommand(run.command, run.args);
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (outcome: PiperOutcome): void => {
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
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err: unknown) {
      resolve({ code: null, stderr: String(err), timedOut: false });
      return;
    }

    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    // A closed stdin after the child died is a failed run, not a crash here.
    child.stdin?.on("error", () => undefined);
    child.on("error", (err) => {
      finish({ code: null, stderr: `${stderr}${String(err)}`, timedOut });
    });
    child.on("close", (code) => {
      finish({ code, stderr, timedOut });
    });
    try {
      child.stdin?.end(run.input, "utf8");
    } catch {
      /* the close/error handlers report the run */
    }

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish({ code: null, stderr, timedOut: true });
    }, run.timeoutMs);
  });
}

export interface PiperOptions {
  /** The fetched `piper.exe`; empty means the Windows voice is used instead. */
  command: string;
  /** The `.onnx` speaker model; its `.onnx.json` sits beside it. */
  voicePath: string;
  /** Piper's pace; 1 is the model's own, higher speaks slower. */
  lengthScale?: number;
  /** Where the temp WAV is written; the caller deletes it. */
  workDir: string;
  /** How long one synthesis may run before it is killed. */
  timeoutMs?: number;
  /** Injectable for tests. */
  runner?: PiperRunner;
}

export class PiperSynthesizer implements Synthesizer {
  private readonly options: PiperOptions;
  private readonly runner: PiperRunner;
  private readonly timeoutMs: number;

  constructor(options: PiperOptions) {
    this.options = options;
    this.runner = options.runner ?? spawnedRunner;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  get configured(): boolean {
    return (
      this.options.command.trim().length > 0 && this.options.voicePath.trim().length > 0
    );
  }

  /** The argv one run uses; exposed so a test can prove it. */
  argumentsFor(wavPath: string): string[] {
    const args = ["--model", this.options.voicePath, "--output_file", wavPath];
    const scale = this.options.lengthScale;
    if (typeof scale === "number" && scale > 0 && Math.abs(scale - 1) > 0.01) {
      args.push("--length_scale", String(scale));
    }
    return args;
  }

  async synthesize(text: string): Promise<SynthesizeResult> {
    if (!text.trim()) return { ok: false, reason: "there is nothing to say" };
    if (!this.options.command.trim() || !this.options.voicePath.trim()) {
      return {
        ok: false,
        reason: "no Piper voice is configured (voice.piperPath / voice.piperVoicePath)",
      };
    }

    const wavPath = path.join(this.options.workDir, `speech-${crypto.randomUUID()}.wav`);
    let outcome: PiperOutcome;
    try {
      fs.mkdirSync(this.options.workDir, { recursive: true });
      outcome = await this.runner({
        command: this.options.command,
        args: this.argumentsFor(wavPath),
        input: `${text}\n`,
        timeoutMs: this.timeoutMs,
      });
    } catch (err: unknown) {
      this.remove(wavPath);
      return { ok: false, reason: `the voice could not run: ${String(err)}` };
    }

    if (outcome.timedOut) {
      this.remove(wavPath);
      return { ok: false, reason: "the voice timed out" };
    }
    if (outcome.code !== 0) {
      this.remove(wavPath);
      const detail = outcome.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1);
      return {
        ok: false,
        reason: detail ? `the voice failed: ${detail}` : "the voice exited non-zero",
      };
    }
    let size = 0;
    try {
      size = fs.statSync(wavPath).size;
    } catch {
      size = 0;
    }
    if (size === 0) {
      this.remove(wavPath);
      return { ok: false, reason: "the voice wrote no audio" };
    }
    return { ok: true, wavPath };
  }

  /** A file that will not delete is not the failure the operator must hear. */
  private remove(wavPath: string): void {
    try {
      fs.rmSync(wavPath, { force: true });
    } catch {
      /* nothing to clean up */
    }
  }
}
