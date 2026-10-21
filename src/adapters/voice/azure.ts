/**
 * Azure Speech: dedicated Ukrainian neural voices, reached over the REST TTS
 * endpoint for one region. The key is a secret; the request is SSML, so rate
 * and (later) phoneme fixes travel with the text. The response is a RIFF WAV
 * the page decodes like any other clip.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SynthesizeResult, Synthesizer } from "./sapi.js";

export interface AzureOptions {
  key: string;
  /** e.g. "northeurope"; the TTS host is derived from it. */
  region: string;
  /** e.g. uk-UA-PolinaNeural. */
  voice: string;
  /** SSML prosody rate, e.g. "-5%". */
  rate?: string;
  workDir: string;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/** Escape text for SSML; the voice only ever receives text, never markup. */
export function escapeSsml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** The one SSML shape this adapter sends. */
export function azureSsml(text: string, voice: string, rate = "-5%"): string {
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="uk-UA"><voice name="${voice}"><prosody rate="${rate}">${escapeSsml(text)}</prosody></voice></speak>`;
}

export class AzureSynthesizer implements Synthesizer {
  private readonly options: AzureOptions;
  private readonly timeoutMs: number;

  constructor(options: AzureOptions) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  get configured(): boolean {
    return (
      this.options.key.trim().length > 0 &&
      this.options.region.trim().length > 0 &&
      this.options.voice.trim().length > 0
    );
  }

  async synthesize(text: string): Promise<SynthesizeResult> {
    if (!text.trim()) return { ok: false, reason: "there is nothing to say" };
    if (!this.configured) {
      return {
        ok: false,
        reason:
          "no Azure voice is configured (the azure-speech-key secret and voice.azureRegion)",
      };
    }

    const host = `https://${this.options.region.trim().toLowerCase()}.tts.speech.microsoft.com/cognitiveservices/v1`;
    const doFetch = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await doFetch(host, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": this.options.key,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "riff-24khz-16bit-mono-pcm",
          "User-Agent": "SignalConnector",
        },
        body: azureSsml(text, this.options.voice, this.options.rate ?? "-5%"),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err: unknown) {
      const name = err instanceof Error ? err.name : "";
      return {
        ok: false,
        reason:
          name === "TimeoutError" || name === "AbortError"
            ? "the Azure voice timed out"
            : `the Azure voice could not be reached: ${String(err)}`,
      };
    }

    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 200);
      } catch {
        /* the status is enough */
      }
      return {
        ok: false,
        reason: `the Azure voice answered ${response.status}${detail ? `: ${detail}` : ""}`,
      };
    }

    let audio: Buffer;
    try {
      audio = Buffer.from(await response.arrayBuffer());
    } catch {
      return { ok: false, reason: "the Azure voice returned no audio" };
    }
    if (audio.length === 0) return { ok: false, reason: "the Azure voice returned no audio" };

    const wavPath = path.join(this.options.workDir, `speech-${crypto.randomUUID()}.wav`);
    try {
      fs.mkdirSync(this.options.workDir, { recursive: true });
      fs.writeFileSync(wavPath, audio);
    } catch (err: unknown) {
      return { ok: false, reason: `could not keep the clip: ${String(err)}` };
    }
    return { ok: true, wavPath };
  }
}
