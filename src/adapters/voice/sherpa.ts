/**
 * The second local recogniser: sherpa-onnx with the Ukrainian Moonshine model.
 *
 * Moonshine is trained for short utterances and its Ukrainian build is a
 * fraction of whisper's cost on a laptop CPU, which is exactly the meeting's
 * shape: one spoken question at a time. It is a plain Windows binary plus an
 * ONNX model, fetched like whisper.cpp, so nothing is installed from npm and
 * nothing is hosted. It implements the same `Transcriber` contract, and the
 * pipeline picks it when both paths are configured.
 */
import os from "node:os";
import path from "node:path";
import {
  spawnedRunner,
  type ProcessRunner,
  type RunOutcome,
  type TranscribeResult,
  type Transcriber,
} from "./whisper.js";

export interface SherpaOptions {
  /** The fetched `sherpa-onnx-offline.exe`. */
  command: string;
  /** The model directory: encoder, merged decoder and tokens side by side. */
  modelDir: string;
  /** CPU threads; defaults to the machine's logical cores, capped at eight. */
  threads?: number;
  /** How long one run may take before it is killed. */
  timeoutMs?: number;
  /** Injectable, so a test proves the argv, the timeout and the parse. */
  runner?: ProcessRunner;
}

/**
 * sherpa-onnx prints one JSON object per file after its banner. Take the last
 * line that carries a `text` field; an empty result is a blank transcript.
 */
export function parseSherpa(stdout: string): string {
  const lines = stdout.split(/\r?\n/).reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.includes('"text"')) continue;
    try {
      const parsed = JSON.parse(trimmed) as { text?: unknown };
      if (typeof parsed.text === "string") return parsed.text.trim();
    } catch {
      /* a banner line that happens to start with a brace */
    }
  }
  return "";
}

export class SherpaTranscriber implements Transcriber {
  private readonly options: SherpaOptions;
  private readonly runner: ProcessRunner;
  private readonly threads: number;
  private readonly timeoutMs: number;

  constructor(options: SherpaOptions) {
    this.options = options;
    this.runner = options.runner ?? spawnedRunner;
    this.threads = options.threads ?? Math.min(8, Math.max(1, os.availableParallelism()));
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  get configured(): boolean {
    return (
      this.options.command.trim().length > 0 && this.options.modelDir.trim().length > 0
    );
  }

  /** The argv one run uses; exposed so a test can prove it. */
  argumentsFor(wavPath: string): string[] {
    const dir = this.options.modelDir;
    return [
      `--moonshine-encoder=${path.join(dir, "encoder_model.ort")}`,
      `--moonshine-merged-decoder=${path.join(dir, "decoder_model_merged.ort")}`,
      `--tokens=${path.join(dir, "tokens.txt")}`,
      `--num-threads=${this.threads}`,
      wavPath,
    ];
  }

  async transcribe(wavPath: string): Promise<TranscribeResult> {
    if (!this.configured) {
      return {
        ok: false,
        reason: "no sherpa-onnx model is configured (voice.sherpaPath / voice.sherpaModelDir)",
      };
    }
    let outcome: RunOutcome;
    try {
      outcome = await this.runner({
        command: this.options.command,
        args: this.argumentsFor(wavPath),
        timeoutMs: this.timeoutMs,
      });
    } catch (err: unknown) {
      return { ok: false, reason: `the recogniser could not run: ${String(err)}` };
    }
    if (outcome.timedOut) return { ok: false, reason: "the recogniser timed out" };
    if (outcome.code !== 0) {
      const detail = outcome.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .pop();
      return { ok: false, reason: detail ? `the recogniser failed: ${detail}` : "the recogniser failed" };
    }
    const text = parseSherpa(outcome.stdout);
    if (!text) return { ok: false, reason: "blank transcript" };
    return { ok: true, text };
  }
}
