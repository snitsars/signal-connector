import { describe, expect, it, vi } from "vitest";
import {
  parseTranscript,
  WhisperTranscriber,
  type ProcessRunner,
  type RunOutcome,
  type TranscribeRun,
} from "./whisper.js";

const outcome = (patch: Partial<RunOutcome> = {}): RunOutcome => ({
  code: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...patch,
});

function transcriber(run: ProcessRunner, language = "auto", vadPath?: string) {
  const runs: TranscribeRun[] = [];
  const runner: ProcessRunner = async (input) => {
    runs.push(input);
    return run(input);
  };
  const tool = new WhisperTranscriber({
    command: "whisper-cli.exe",
    modelPath: "C:\\whisper\\ggml-base.bin",
    language,
    ...(vadPath ? { vadPath } : {}),
    timeoutMs: 12_345,
    threads: 4,
    runner,
  });
  return { tool, runs };
}

describe("parseTranscript", () => {
  it("keeps the words", () => {
    expect(parseTranscript("Add a retry to the HTTP client.")).toBe(
      "Add a retry to the HTTP client.",
    );
  });

  it("drops timestamped prefixes and rejoins lines", () => {
    expect(parseTranscript("[00:00:00.000 --> 00:00:02.000]  fix the parser\nand the tests")).toBe(
      "fix the parser and the tests",
    );
  });

  it("treats the model's non-speech markers as nothing", () => {
    expect(parseTranscript("[BLANK_AUDIO]")).toBe("");
    expect(parseTranscript("(silence)")).toBe("");
    expect(parseTranscript("[MUSIC]\n\n")).toBe("");
    expect(parseTranscript("")).toBe("");
  });

  it("keeps speech beside a non-speech marker", () => {
    expect(parseTranscript("hello there\n[BLANK_AUDIO]")).toBe("hello there");
  });
});

describe("WhisperTranscriber", () => {
  it("runs the fetched tool with the model and a bounded timeout", async () => {
    const { tool, runs } = transcriber(async () => outcome({ stdout: "hello" }));
    const result = await tool.transcribe("C:\\temp\\u.wav");
    expect(result).toEqual({ ok: true, text: "hello" });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.command).toBe("whisper-cli.exe");
    expect(runs[0]!.timeoutMs).toBe(12_345);
    expect(runs[0]!.args).toEqual([
      "-m",
      "C:\\whisper\\ggml-base.bin",
      "-f",
      "C:\\temp\\u.wav",
      "-l",
      "auto",
      "-nt",
      "-np",
      "-sns",
      "-t",
      "4",
    ]);
  });

  it("passes the VAD model so non-speech is skipped before transcription", async () => {
    const { tool, runs } = transcriber(
      async () => outcome({ stdout: "hello" }),
      "uk",
      "C:\\whisper\\ggml-silero-v6.2.0.bin",
    );
    await tool.transcribe("C:\\temp\\u.wav");
    expect(runs[0]!.args).toEqual([
      "-m",
      "C:\\whisper\\ggml-base.bin",
      "-f",
      "C:\\temp\\u.wav",
      "-l",
      "uk",
      "-nt",
      "-np",
      "-sns",
      "-t",
      "4",
      "--vad",
      "-vm",
      "C:\\whisper\\ggml-silero-v6.2.0.bin",
    ]);
  });

  it("passes a configured language through", async () => {
    const { tool, runs } = transcriber(async () => outcome({ stdout: "bonjour" }), "fr");
    await tool.transcribe("u.wav");
    expect(runs[0]!.args[runs[0]!.args.indexOf("-l") + 1]).toBe("fr");
  });

  it("reports a non-zero exit as a reason, not a throw", async () => {
    const { tool } = transcriber(async () =>
      outcome({ code: 1, stderr: "error: failed to open model\nboom" }),
    );
    const result = await tool.transcribe("u.wav");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("boom");
  });

  it("reports a timeout as a reason", async () => {
    const { tool } = transcriber(async () => outcome({ code: null, timedOut: true }));
    const result = await tool.transcribe("u.wav");
    expect(result).toEqual({ ok: false, reason: "the transcriber timed out" });
  });

  it("maps a spawn failure to a reason", async () => {
    const { tool } = transcriber(async () => {
      throw new Error("ENOENT");
    });
    const result = await tool.transcribe("u.wav");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("ENOENT");
  });

  it("names a missing tool or model without running anything", async () => {
    const run = vi.fn(async () => outcome());
    const noTool = new WhisperTranscriber({ command: "", modelPath: "m.bin", runner: run });
    const noModel = new WhisperTranscriber({ command: "w.exe", modelPath: "", runner: run });
    expect(noTool.configured).toBe(false);
    expect((await noTool.transcribe("u.wav")).ok).toBe(false);
    expect((await noModel.transcribe("u.wav")).ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("returns empty text for a blank transcript", async () => {
    const { tool } = transcriber(async () => outcome({ stdout: "[BLANK_AUDIO]" }));
    expect(await tool.transcribe("u.wav")).toEqual({ ok: true, text: "" });
  });
});
