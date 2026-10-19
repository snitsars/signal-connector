import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SapiSynthesizer } from "./sapi.js";
import type { RunOutcome, TranscribeRun } from "./whisper.js";

const outcome = (patch: Partial<RunOutcome> = {}): RunOutcome => ({
  code: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...patch,
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Run {
  run: () => Promise<RunOutcome>;
  /** Write the WAV the real voice would leave behind. */
  writes: boolean;
}

/** The PowerShell the synthesiser encoded for -EncodedCommand. */
const scriptOf = (run: TranscribeRun): string =>
  Buffer.from(run.args[3] ?? "", "base64").toString("utf16le");

/** A synthesiser whose PowerShell is a fake that records the argv it was given. */
function makeSapi(run: Run = { run: async () => outcome(), writes: true }) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "sapi-"));
  dirs.push(workDir);
  const runs: TranscribeRun[] = [];
  const runner = async (input: TranscribeRun): Promise<RunOutcome> => {
    runs.push(input);
    if (run.writes) {
      // The real PowerShell writes the path the script names; the fake does the
      // same so the adapter's read-and-delete path is exercised for real.
      const match = /speech-[0-9a-f-]+\.wav/.exec(scriptOf(input));
      if (match) fs.writeFileSync(path.join(workDir, match[0]), Buffer.from("RIFFfakeWAVE"));
    }
    return run.run();
  };
  const synth = new SapiSynthesizer({
    workDir,
    rate: 3,
    voiceName: "Microsoft Zira",
    timeoutMs: 12_345,
    runner,
  });
  return { synth, runs, workDir };
}

describe("SapiSynthesizer", () => {
  it("runs the system voice through PowerShell to one 16 kHz mono WAV", async () => {
    const { synth, runs, workDir } = makeSapi();
    const result = await synth.synthesize("the build passed");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(path.dirname(result.wavPath)).toBe(workDir);
    expect(path.basename(result.wavPath)).toMatch(/^speech-[0-9a-f-]+\.wav$/);
    // The caller deletes it; nothing in the adapter touches it before then.
    expect(fs.existsSync(result.wavPath)).toBe(true);

    expect(runs).toHaveLength(1);
    const call = runs[0]!;
    expect(call.command).toBe("powershell.exe");
    expect(call.timeoutMs).toBe(12_345);
    expect(call.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const script = scriptOf(call);
    expect(script).toContain("Add-Type -AssemblyName System.Speech");
    expect(script).toContain("SpeechAudioFormatInfo(16000");
    expect(script).toContain("Sixteen");
    expect(script).toContain("Mono");
    expect(script).toContain("$synth.Rate = 3");
    expect(script).toContain("$synth.SelectVoice('Microsoft Zira')");
    expect(script).toContain(Buffer.from("the build passed", "utf8").toString("base64"));
    expect(script).toContain(path.basename(result.wavPath));
  });

  it("keeps a transcript's punctuation out of the script's syntax", async () => {
    const { synth, runs } = makeSapi();
    const text = 'say "hi" $env:PATH; Remove-Item C:\\`whoami`\nnext';
    const result = await synth.synthesize(text);
    expect(result.ok).toBe(true);

    const script = scriptOf(runs[0]!);
    // The words ride as base64, so no quote, dollar or newline can change the
    // script: only the base64 form of the text is present.
    expect(script).toContain(Buffer.from(text, "utf8").toString("base64"));
    expect(script).not.toContain("whoami");
    expect(script).not.toContain("Remove-Item");
  });

  it("passes the default voice through when none is configured", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "sapi-"));
    dirs.push(workDir);
    const runs: TranscribeRun[] = [];
    const synth = new SapiSynthesizer({
      workDir,
      runner: async (input) => {
        runs.push(input);
        const match = /speech-[0-9a-f-]+\.wav/.exec(scriptOf(input));
        if (match) fs.writeFileSync(path.join(workDir, match[0]), Buffer.from("RIFF"));
        return outcome();
      },
    });
    await synth.synthesize("hello");
    expect(scriptOf(runs[0]!)).not.toContain("SelectVoice");
    expect(scriptOf(runs[0]!)).toContain("$synth.Rate = 0");
  });

  it("reports a failed run as a reason and leaves no temp file", async () => {
    const { synth, workDir } = makeSapi({
      run: async () => outcome({ code: 1, stderr: "error: no voice installed\nAdd-Type failed" }),
      writes: true,
    });
    const result = await synth.synthesize("hello");
    expect(result).toEqual({ ok: false, reason: "the voice failed: Add-Type failed" });
    expect(fs.readdirSync(workDir)).toEqual([]);
  });

  it("reports a timeout as a reason", async () => {
    const { synth } = makeSapi({ run: async () => outcome({ code: null, timedOut: true }), writes: true });
    expect(await synth.synthesize("hello")).toEqual({
      ok: false,
      reason: "the voice timed out",
    });
  });

  it("reports a run that produced no audio", async () => {
    const { synth, workDir } = makeSapi({ run: async () => outcome(), writes: false });
    expect(await synth.synthesize("hello")).toEqual({
      ok: false,
      reason: "the voice wrote no audio",
    });
    expect(fs.readdirSync(workDir)).toEqual([]);
  });

  it("maps a spawn failure to a reason instead of throwing", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "sapi-"));
    dirs.push(workDir);
    const synth = new SapiSynthesizer({
      workDir,
      runner: async () => {
        throw new Error("ENOENT powershell.exe");
      },
    });
    const result = await synth.synthesize("hello");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("ENOENT");
  });

  it("runs nothing for an empty text", async () => {
    const { synth, runs } = makeSapi();
    const result = await synth.synthesize("   ");
    expect(result.ok).toBe(false);
    expect(runs).toHaveLength(0);
  });
});
