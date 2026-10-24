import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HttpTranscriber } from "./httpTranscriber.js";

const dirs: string[] = [];
function wav(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "http-stt-"));
  dirs.push(dir);
  const file = path.join(dir, "u.wav");
  fs.writeFileSync(file, Buffer.from("RIFF....WAVEfmt "));
  return file;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const OPTIONS = {
  url: "https://stt.example/v1/audio/transcriptions",
  model: "openai/whisper-large-v3",
  language: "uk",
  apiKey: "secret-key",
  timeoutMs: 5_000,
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("HttpTranscriber", () => {
  it("posts the wave file and returns the text", async () => {
    const seen: { url?: string; auth?: string; body?: FormData } = {};
    const voice = new HttpTranscriber({
      ...OPTIONS,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        seen.url = String(url);
        seen.auth = (init?.headers as Record<string, string>)?.Authorization;
        seen.body = init?.body as FormData;
        return response({ text: " скільки тестів " });
      }) as typeof fetch,
    });

    const result = await voice.transcribe(wav());

    expect(result).toEqual({ ok: true, text: "скільки тестів" });
    expect(seen.url).toBe(OPTIONS.url);
    expect(seen.auth).toBe("Bearer secret-key");
    expect(seen.body?.get("model")).toBe(OPTIONS.model);
    expect(seen.body?.get("language")).toBe("uk");
  });

  it("sends no language when it is auto", async () => {
    let sent: FormData | undefined;
    const voice = new HttpTranscriber({
      ...OPTIONS,
      language: "auto",
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        sent = init?.body as FormData;
        return response({ text: "ок" });
      }) as typeof fetch,
    });
    await voice.transcribe(wav());
    expect(sent?.get("language")).toBeNull();
  });

  it("sends the vocabulary prompt so names are spelled as typed", async () => {
    let sent: FormData | undefined;
    const voice = new HttpTranscriber({
      ...OPTIONS,
      prompt: "SignalConnector, opencode",
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        sent = init?.body as FormData;
        return response({ text: "ок" });
      }) as typeof fetch,
    });
    await voice.transcribe(wav());
    expect(sent?.get("prompt")).toBe("SignalConnector, opencode");
  });

  it("sends no prompt when it is empty", async () => {
    let sent: FormData | undefined;
    const voice = new HttpTranscriber({
      ...OPTIONS,
      prompt: "  ",
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        sent = init?.body as FormData;
        return response({ text: "ок" });
      }) as typeof fetch,
    });
    await voice.transcribe(wav());
    expect(sent?.get("prompt")).toBeNull();
  });

  it("reports the service's status and a short body, never the key", async () => {
    const voice = new HttpTranscriber({
      ...OPTIONS,
      fetchImpl: (async () => new Response("invalid api key", { status: 401 })) as typeof fetch,
    });
    const result = await voice.transcribe(wav());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("401");
      expect(result.reason).toContain("invalid api key");
      expect(result.reason).not.toContain("secret-key");
    }
  });

  it("reports a timeout as such", async () => {
    const voice = new HttpTranscriber({
      ...OPTIONS,
      fetchImpl: (async () => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      }) as typeof fetch,
    });
    expect(await voice.transcribe(wav())).toEqual({
      ok: false,
      reason: "the transcription service timed out",
    });
  });

  it("treats an empty text as a dropped utterance", async () => {
    const voice = new HttpTranscriber({
      ...OPTIONS,
      fetchImpl: (async () => response({ text: "  " })) as typeof fetch,
    });
    expect(await voice.transcribe(wav())).toEqual({ ok: false, reason: "blank transcript" });
  });

  it("is unconfigured without a url and a key", () => {
    expect(new HttpTranscriber({ ...OPTIONS, apiKey: "" }).configured).toBe(false);
    expect(new HttpTranscriber({ ...OPTIONS, url: "" }).configured).toBe(false);
    expect(new HttpTranscriber(OPTIONS).configured).toBe(true);
  });
});
