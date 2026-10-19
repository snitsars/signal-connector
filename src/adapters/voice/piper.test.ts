import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiperSynthesizer, type PiperRun, type PiperRunner } from "./piper.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function synthesizer(
  run: PiperRunner,
  overrides: { command?: string; voicePath?: string } = {},
) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "piper-"));
  dirs.push(workDir);
  const runs: PiperRun[] = [];
  const runner: PiperRunner = async (input) => {
    runs.push(input);
    return run(input);
  };
  const voice = new PiperSynthesizer({
    command: overrides.command ?? "piper.exe",
    voicePath: overrides.voicePath ?? "C:\\voices\\uk_UA-oleksa-high.onnx",
    workDir,
    timeoutMs: 5_000,
    runner,
  });
  return { voice, runs, workDir };
}

const outputPath = (run: PiperRun): string => run.args[run.args.indexOf("--output_file") + 1]!;

describe("PiperSynthesizer", () => {
  it("runs Piper with the model, writes the WAV and sends the text on stdin", async () => {
    const { voice, runs } = synthesizer(async (run) => {
      fs.writeFileSync(outputPath(run), "RIFF....");
      return { code: 0, stderr: "", timedOut: false };
    });

    const result = await voice.synthesize("Привіт. Як справи?");

    expect(result.ok).toBe(true);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.command).toBe("piper.exe");
    expect(runs[0]!.args).toEqual([
      "--model",
      "C:\\voices\\uk_UA-oleksa-high.onnx",
      "--output_file",
      expect.stringContaining("speech-"),
    ]);
    expect(runs[0]!.args[3]!.endsWith(".wav")).toBe(true);
    expect(runs[0]!.input).toBe("Привіт. Як справи?\n");
  });

  it("is unconfigured without both the binary and the voice", () => {
    const { voice } = synthesizer(async () => ({ code: 0, stderr: "", timedOut: false }), {
      voicePath: "",
    });
    expect(voice.configured).toBe(false);
  });

  it("reports a missing configuration instead of running anything", async () => {
    const { voice, runs } = synthesizer(
      async () => ({ code: 0, stderr: "", timedOut: false }),
      { command: "" },
    );
    const result = await voice.synthesize("hello");
    expect(result).toEqual({
      ok: false,
      reason: "no Piper voice is configured (voice.piperPath / voice.piperVoicePath)",
    });
    expect(runs).toHaveLength(0);
  });

  it("reports the last line Piper printed when it fails", async () => {
    const { voice } = synthesizer(async () => ({
      code: 1,
      stderr: "loading voice\ncould not open the model",
      timedOut: false,
    }));
    const result = await voice.synthesize("hello");
    expect(result).toEqual({ ok: false, reason: "the voice failed: could not open the model" });
  });

  it("reports a timeout and a run that wrote no audio", async () => {
    const timedOut = synthesizer(async () => ({ code: null, stderr: "", timedOut: true }));
    expect(await timedOut.voice.synthesize("hello")).toEqual({
      ok: false,
      reason: "the voice timed out",
    });

    const empty = synthesizer(async (run) => {
      fs.writeFileSync(outputPath(run), "");
      return { code: 0, stderr: "", timedOut: false };
    });
    expect(await empty.voice.synthesize("hello")).toEqual({
      ok: false,
      reason: "the voice wrote no audio",
    });
  });
});
