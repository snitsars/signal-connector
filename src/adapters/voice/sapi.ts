/**
 * The one subprocess in the speaking path: the Windows system voice.
 *
 * SAPI ships with Windows, so answering the room costs no download, no hosted
 * API and no dependency. It runs through PowerShell with a bounded timeout,
 * writes one 16 kHz mono WAV and hands its path back; the caller deletes it as
 * soon as the page has the clip. A missing voice or a failed run comes back as
 * a reason rather than an exception, so the meeting keeps running.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type {
  ProcessRunner,
  RunOutcome,
} from "./whisper.js";
import { resolveCommand } from "../spawnCommand.js";

export type SynthesizeResult =
  | { ok: true; wavPath: string }
  | { ok: false; reason: string };

/** What the voice adapter needs of a synthesiser; the fake in tests implements it. */
export interface Synthesizer {
  /** False when no voice command is configured. */
  readonly configured: boolean;
  synthesize(text: string): Promise<SynthesizeResult>;
}

/** A single-quoted PowerShell literal; only a quote needs doubling. */
function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Spawn PowerShell, cap it by time, and collect what it printed. */
function spawnedRunner(run: { command: string; args: string[]; timeoutMs: number }): Promise<RunOutcome> {
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

export interface SapiOptions {
  /** Where the temp WAV is written; the caller deletes it. */
  workDir: string;
  /** The Windows system voice; empty picks the machine's default. */
  voiceName?: string;
  /** SAPI rate, -10..10; 0 is the voice's own pace. */
  rate?: number;
  /** The PowerShell executable; injectable for a machine with only pwsh. */
  command?: string;
  /** How long one synthesis may run before it is killed. */
  timeoutMs?: number;
  /** Injectable, so a test proves the script, the temp file and a failed run. */
  runner?: ProcessRunner;
}

export class SapiSynthesizer implements Synthesizer {
  private readonly options: SapiOptions;
  private readonly runner: ProcessRunner;
  private readonly timeoutMs: number;

  constructor(options: SapiOptions) {
    this.options = options;
    this.runner = options.runner ?? spawnedRunner;
    this.timeoutMs = options.timeoutMs ?? 45_000;
  }

  get configured(): boolean {
    return (this.options.command ?? "powershell.exe").trim().length > 0;
  }

  /**
   * The PowerShell that makes one clip. The text rides as base64 so no quote,
   * dollar sign or newline in a transcript can change the script's meaning.
   */
  private scriptFor(text: string, wavPath: string, rate: number, voiceName: string): string {
    const lines = [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -AssemblyName System.Speech",
      `$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psLiteral(
        Buffer.from(text, "utf8").toString("base64"),
      )}))`,
      "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
      "try {",
      `  $synth.Rate = ${rate}`,
    ];
    if (voiceName.trim()) {
      lines.push(`  $synth.SelectVoice(${psLiteral(voiceName.trim())})`);
    }
    lines.push(
      "  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)",
      `  $synth.SetOutputToWaveFile(${psLiteral(wavPath)}, $format)`,
      "  $synth.Speak($text)",
      "} finally {",
      "  $synth.Dispose()",
      "}",
    );
    return lines.join("\n");
  }

  async synthesize(text: string): Promise<SynthesizeResult> {
    if (!text.trim()) return { ok: false, reason: "there is nothing to say" };

    const wavPath = path.join(this.options.workDir, `speech-${crypto.randomUUID()}.wav`);
    const rate = Math.max(-10, Math.min(10, Math.round(this.options.rate ?? 0)));
    const script = this.scriptFor(text, wavPath, rate, this.options.voiceName ?? "");

    let outcome: RunOutcome;
    try {
      fs.mkdirSync(this.options.workDir, { recursive: true });
      outcome = await this.runner({
        command: this.options.command ?? "powershell.exe",
        // -EncodedCommand takes the script as base64 UTF-16LE, so a path with a
        // space or a transcript's punctuation never has to be quoted for cmd.
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
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
    if (!fs.existsSync(wavPath)) {
      return { ok: false, reason: "the voice wrote no audio" };
    }
    return { ok: true, wavPath };
  }

  /** A file that will not delete is not the failure the operator must hear. */
  private remove(wavPath: string): void {
    try {
      fs.rmSync(wavPath, { force: true });
    } catch {
      /* nothing to clean up, or the temp dir is already gone */
    }
  }
}
