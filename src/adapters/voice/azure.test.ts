import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AzureSynthesizer, azureSsml, escapeSsml } from "./azure.js";

const dirs: string[] = [];
function workDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azure-tts-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const BASE = {
  key: "secret-key",
  region: "northeurope",
  voice: "uk-UA-PolinaNeural",
  rate: "-5%",
  timeoutMs: 5_000,
};

describe("AzureSynthesizer", () => {
  it("escapes the text so it cannot change the SSML", () => {
    expect(escapeSsml('a & b <c> "d"')).toBe("a &amp; b &lt;c&gt; &quot;d&quot;");
    const ssml = azureSsml("Привіт", "uk-UA-PolinaNeural", "-5%");
    expect(ssml).toContain('xml:lang="uk-UA"');
    expect(ssml).toContain('name="uk-UA-PolinaNeural"');
    expect(ssml).toContain('rate="-5%"');
    expect(ssml).toContain("Привіт");
  });

  it("gives an English voice its own language instead of Ukrainian", () => {
    const ssml = azureSsml("opencode is ready", "en-US-JennyNeural");

    expect(ssml).toContain('xml:lang="en-US"');
    expect(ssml).toContain('name="en-US-JennyNeural"');
  });

  it("posts SSML to the region host and keeps the WAV", async () => {
    const dir = workDir();
    let seen: { url?: string; headers?: Record<string, string>; body?: string } = {};
    const voice = new AzureSynthesizer({
      ...BASE,
      workDir: dir,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        seen = {
          url: String(url),
          headers: init?.headers as Record<string, string>,
          body: String(init?.body),
        };
        return new Response(Buffer.from("RIFF....WAVEfmt "), { status: 200 });
      }) as typeof fetch,
    });

    const result = await voice.synthesize("Привіт.");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.wavPath.endsWith(".wav")).toBe(true);
      expect(fs.readFileSync(result.wavPath).toString()).toContain("RIFF");
    }
    expect(seen.url).toBe("https://northeurope.tts.speech.microsoft.com/cognitiveservices/v1");
    expect(seen.headers?.["Ocp-Apim-Subscription-Key"]).toBe("secret-key");
    expect(seen.headers?.["Content-Type"]).toBe("application/ssml+xml");
    expect(seen.body).toContain("Привіт.");
  });

  it("reports the service's status and body, never the key", async () => {
    const voice = new AzureSynthesizer({
      ...BASE,
      workDir: workDir(),
      fetchImpl: (async () => new Response("bad key", { status: 401 })) as typeof fetch,
    });
    const result = await voice.synthesize("Привіт.");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("401");
      expect(result.reason).toContain("bad key");
      expect(result.reason).not.toContain("secret-key");
    }
  });

  it("reports a timeout", async () => {
    const voice = new AzureSynthesizer({
      ...BASE,
      workDir: workDir(),
      fetchImpl: (async () => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      }) as typeof fetch,
    });
    expect(await voice.synthesize("Привіт.")).toEqual({
      ok: false,
      reason: "the Azure voice timed out",
    });
  });

  it("is unconfigured without a key or a voice", () => {
    expect(new AzureSynthesizer({ ...BASE, workDir: workDir(), key: "" }).configured).toBe(false);
    expect(new AzureSynthesizer({ ...BASE, workDir: workDir(), voice: "" }).configured).toBe(false);
    expect(new AzureSynthesizer({ ...BASE, workDir: workDir() }).configured).toBe(true);
  });
});
