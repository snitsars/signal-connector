import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RivaTranscriber, type RivaInput, type RivaResponse } from "./riva.js";

const dirs: string[] = [];
function wav(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "riva-"));
  dirs.push(dir);
  const file = path.join(dir, "u.wav");
  fs.writeFileSync(file, Buffer.from("RIFF....WAVEfmt "));
  return file;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const OPTIONS = {
  host: "grpc.nvcf.nvidia.com:443",
  functionId: "b702f636-f60c-4a3d-a6f4-f3568c13bd7d",
  language: "uk-UA",
  apiKey: "secret-key",
  timeoutMs: 5_000,
};

describe("RivaTranscriber", () => {
  it("sends the key, function and language, and joins the transcripts", async () => {
    let seen: RivaInput | undefined;
    const voice = new RivaTranscriber({
      ...OPTIONS,
      recognize: async (input) => {
        seen = input;
        return { results: [{ alternatives: [{ transcript: " скільки " }, { transcript: "тестів" }] }] };
      },
    });

    const result = await voice.transcribe(wav());

    expect(result).toEqual({ ok: true, text: "скільки тестів" });
    expect(seen?.apiKey).toBe("secret-key");
    expect(seen?.functionId).toBe(OPTIONS.functionId);
    expect(seen?.language).toBe("uk-UA");
    expect(seen?.audio.length).toBeGreaterThan(0);
    expect(seen?.host).toBe(OPTIONS.host);
  });

  it("reports a deadline as a timeout", async () => {
    const voice = new RivaTranscriber({
      ...OPTIONS,
      recognize: async () => {
        throw Object.assign(new Error("Deadline exceeded"), { code: 4 });
      },
    });
    expect(await voice.transcribe(wav())).toEqual({
      ok: false,
      reason: "the NVIDIA recogniser timed out",
    });
  });

  it("reports a service failure without the key", async () => {
    const voice = new RivaTranscriber({
      ...OPTIONS,
      recognize: async () => {
        throw new Error("Model whisper-large-v3 is not available on server");
      },
    });
    const result = await voice.transcribe(wav());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("not available");
      expect(result.reason).not.toContain("secret-key");
    }
  });

  it("treats an empty response as a dropped utterance", async () => {
    const voice = new RivaTranscriber({
      ...OPTIONS,
      recognize: async (): Promise<RivaResponse> => ({ results: [] }),
    });
    expect(await voice.transcribe(wav())).toEqual({ ok: false, reason: "blank transcript" });
  });

  it("is unconfigured without a key", () => {
    expect(new RivaTranscriber({ ...OPTIONS, apiKey: "" }).configured).toBe(false);
    expect(new RivaTranscriber(OPTIONS).configured).toBe(true);
  });
});
