/**
 * A hosted, OpenAI-compatible `/v1/audio/speech` voice.
 *
 * The operator's own provider and key, like the HTTP recogniser: the connector
 * ships no endpoint and no credential. The response is written to one temp WAV
 * (or MP3 — the page's decodeAudioData handles both), read into base64 and
 * deleted by the caller, exactly like a local clip.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SynthesizeResult, Synthesizer } from "./sapi.js";

export interface HttpSynthesizerOptions {
  url: string;
  model: string;
  voice: string;
  /** `wav` is decoded by every browser; `mp3` also works and is smaller. */
  format?: string;
  /** Style guidance some providers accept (OpenAI gpt-4o-mini-tts). */
  instructions?: string;
  apiKey: string;
  workDir: string;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export class HttpSynthesizer implements Synthesizer {
  private readonly options: HttpSynthesizerOptions;
  private readonly timeoutMs: number;

  constructor(options: HttpSynthesizerOptions) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  get configured(): boolean {
    return this.options.url.trim().length > 0 && this.options.apiKey.trim().length > 0;
  }

  async synthesize(text: string): Promise<SynthesizeResult> {
    if (!text.trim()) return { ok: false, reason: "there is nothing to say" };
    if (!this.configured) {
      return {
        ok: false,
        reason:
          "no speech endpoint is configured (voice.ttsUrl and the tts-api-key secret)",
      };
    }

    const doFetch = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await doFetch(this.options.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.options.model,
          voice: this.options.voice,
          input: text,
          response_format: this.options.format ?? "wav",
          ...(this.options.instructions?.trim()
            ? { instructions: this.options.instructions.trim() }
            : {}),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err: unknown) {
      const name = err instanceof Error ? err.name : "";
      return {
        ok: false,
        reason:
          name === "TimeoutError" || name === "AbortError"
            ? "the speech service timed out"
            : `the speech service could not be reached: ${String(err)}`,
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
        reason: `the speech service answered ${response.status}${detail ? `: ${detail}` : ""}`,
      };
    }

    let audio: Buffer;
    try {
      audio = Buffer.from(await response.arrayBuffer());
    } catch {
      return { ok: false, reason: "the speech service returned no audio" };
    }
    if (audio.length === 0) return { ok: false, reason: "the speech service returned no audio" };

    const ext = (this.options.format ?? "wav").toLowerCase() === "mp3" ? "mp3" : "wav";
    const wavPath = path.join(this.options.workDir, `speech-${crypto.randomUUID()}.${ext}`);
    try {
      fs.mkdirSync(this.options.workDir, { recursive: true });
      fs.writeFileSync(wavPath, audio);
    } catch (err: unknown) {
      return { ok: false, reason: `could not keep the clip: ${String(err)}` };
    }
    return { ok: true, wavPath };
  }
}
