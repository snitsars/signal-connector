import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSherpa, SherpaTranscriber, type SherpaOptions } from "./sherpa.js";
import type { ProcessRunner, RunOutcome } from "./whisper.js";

const MODEL = "C:\\models\\uk-moonshine";

function transcriber(
  run: (run: { command: string; args: string[]; timeoutMs: number }) => Promise<RunOutcome>,
  overrides: Partial<SherpaOptions> = {},
) {
  const runs: { command: string; args: string[]; timeoutMs: number }[] = [];
  const runner: ProcessRunner = async (input) => {
    runs.push(input);
    return run(input);
  };
  const voice = new SherpaTranscriber({
    command: overrides.command ?? "sherpa-onnx-offline.exe",
    modelDir: overrides.modelDir ?? MODEL,
    threads: 4,
    timeoutMs: 5_000,
    runner,
  });
  return { voice, runs };
}

const ok = (stdout: string): RunOutcome => ({ code: 0, stdout, stderr: "", timedOut: false });

describe("SherpaTranscriber", () => {
  it("runs the Ukrainian Moonshine model on the wave file", async () => {
    const { voice, runs } = transcriber(async () =>
      ok('{"text": " скільки тестів у проєкті"}'),
    );

    const result = await voice.transcribe("C:\\temp\\u.wav");

    expect(result).toEqual({ ok: true, text: "скільки тестів у проєкті" });
    expect(runs[0]!.command).toBe("sherpa-onnx-offline.exe");
    expect(runs[0]!.args).toEqual([
      `--moonshine-encoder=${path.join(MODEL, "encoder_model.ort")}`,
      `--moonshine-merged-decoder=${path.join(MODEL, "decoder_model_merged.ort")}`,
      `--tokens=${path.join(MODEL, "tokens.txt")}`,
      "--num-threads=4",
      "C:\\temp\\u.wav",
    ]);
  });

  it("takes the last result line after the banner", () => {
    const stdout = [
      "sherpa-onnx-offline --moonshine-encoder=...",
      "Creating recognizer ...",
      '{"text": " перший"}',
      "----",
      '{"lang": "", "text": " другий"}',
    ].join("\n");
    expect(parseSherpa(stdout)).toBe("другий");
  });

  it("reports a blank transcript as a dropped utterance", async () => {
    const { voice } = transcriber(async () => ok('{"text": "  "}'));
    expect(await voice.transcribe("C:\\temp\\u.wav")).toEqual({
      ok: false,
      reason: "blank transcript",
    });
  });

  it("bounds the run and reports a timeout", async () => {
    const { voice, runs } = transcriber(async () => ({
      code: null,
      stdout: "",
      stderr: "",
      timedOut: true,
    }));
    expect(await voice.transcribe("C:\\temp\\u.wav")).toEqual({
      ok: false,
      reason: "the recogniser timed out",
    });
    expect(runs[0]!.timeoutMs).toBe(5_000);
  });

  it("reports a failed run with its last stderr line", async () => {
    const { voice } = transcriber(async () => ({
      code: 1,
      stdout: "",
      stderr: "banner\nmissing model file",
      timedOut: false,
    }));
    expect(await voice.transcribe("C:\\temp\\u.wav")).toEqual({
      ok: false,
      reason: "the recogniser failed: missing model file",
    });
  });

  it("is unconfigured without a binary and a model directory", () => {
    const { voice } = transcriber(async () => ok('{"text": "x"}'), { command: "" });
    expect(voice.configured).toBe(false);
  });
});
