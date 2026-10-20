import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HttpSynthesizer } from "./httpSynthesizer.js";

const dirs: string[] = [];
function workDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "http-tts-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const BASE = {
  url: "https://speech.example/v1/audio/speech",
  model: "gpt-4o-mini-tts",
  voice: "alloy",
  apiKey: "secret-key",
  timeoutMs: 5_000,
};

describe("HttpSynthesizer", () => {
  it("posts the text and keeps the returned audio as one clip", async () => {
    const dir = workDir();
    let sent: { auth?: string; body?: Record<string, unknown> } = {};
    const voice = new HttpSynthesizer({
      ...BASE,
      workDir: dir,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        sent = {
          auth: (init?.headers as Record<string, string>)?.Authorization,
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        };
        return new Response(Buffer.from("RIFF....WAVEfmt "), { status: 200 });
      }) as typeof fetch,
    });

    const result = await voice.synthesize("Привіт, я під'єднався.");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.wavPath.endsWith(".wav")).toBe(true);
      expect(fs.readFileSync(result.wavPath).toString()).toContain("RIFF");
      expect(fs.readdirSync(dir)).toHaveLength(1);
    }
    expect(sent.auth).toBe("Bearer secret-key");
    expect(sent.body).toEqual({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: "Привіт, я під'єднався.",
      response_format: "wav",
    });
  });

  it("writes an mp3 clip when the provider is asked for one", async () => {
    const dir = workDir();
    const voice = new HttpSynthesizer({
      ...BASE,
      workDir: dir,
      format: "mp3",
      fetchImpl: (async () => new Response(Buffer.from("ID3"), { status: 200 })) as typeof fetch,
    });
    const result = await voice.synthesize("текст");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.wavPath.endsWith(".mp3")).toBe(true);
  });

  it("reports the service's status and a short body, never the key", async () => {
    const voice = new HttpSynthesizer({
      ...BASE,
      workDir: workDir(),
      fetchImpl: (async () => new Response("invalid api key", { status: 401 })) as typeof fetch,
    });
    const result = await voice.synthesize("текст");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("401");
      expect(result.reason).not.toContain("secret-key");
    }
  });

  it("reports a timeout", async () => {
    const voice = new HttpSynthesizer({
      ...BASE,
      workDir: workDir(),
      fetchImpl: (async () => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      }) as typeof fetch,
    });
    expect(await voice.synthesize("текст")).toEqual({
      ok: false,
      reason: "the speech service timed out",
    });
  });

  it("is unconfigured without a url and a key", () => {
    expect(new HttpSynthesizer({ ...BASE, workDir: workDir(), apiKey: "" }).configured).toBe(false);
    expect(new HttpSynthesizer({ ...BASE, workDir: workDir(), url: "" }).configured).toBe(false);
    expect(new HttpSynthesizer({ ...BASE, workDir: workDir() }).configured).toBe(true);
  });
});
