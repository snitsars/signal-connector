import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EdgeSynthesizer } from "./edge.js";

const dirs: string[] = [];
function workDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edge-tts-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("EdgeSynthesizer", () => {
  it("keeps the returned audio as one mp3 clip", async () => {
    const dir = workDir();
    const voice = new EdgeSynthesizer({
      voice: "uk-UA-OstapNeural",
      workDir: dir,
      synth: async () => Buffer.from("ID3 fake mp3"),
    });

    const result = await voice.synthesize("Привіт.");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.wavPath.endsWith(".mp3")).toBe(true);
      expect(fs.readFileSync(result.wavPath).toString()).toBe("ID3 fake mp3");
      expect(fs.readdirSync(dir)).toHaveLength(1);
    }
  });

  it("reports a service failure as a reason, not a throw", async () => {
    const voice = new EdgeSynthesizer({
      voice: "uk-UA-OstapNeural",
      workDir: workDir(),
      synth: async () => {
        throw new Error("handshake refused");
      },
    });
    const result = await voice.synthesize("Привіт.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("handshake refused");
  });

  it("treats an empty response as no audio", async () => {
    const voice = new EdgeSynthesizer({
      voice: "uk-UA-OstapNeural",
      workDir: workDir(),
      synth: async () => Buffer.alloc(0),
    });
    expect(await voice.synthesize("Привіт.")).toEqual({
      ok: false,
      reason: "the speech service returned no audio",
    });
  });

  it("is unconfigured without a voice", () => {
    expect(new EdgeSynthesizer({ voice: "", workDir: workDir() }).configured).toBe(false);
    expect(
      new EdgeSynthesizer({ voice: "uk-UA-OstapNeural", workDir: workDir() }).configured,
    ).toBe(true);
  });
});
