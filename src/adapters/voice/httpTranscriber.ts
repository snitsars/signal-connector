/**
 * Any OpenAI-compatible `/v1/audio/transcriptions` endpoint, including a
 * self-hosted NVIDIA NIM, for operators who want a hosted Whisper instead of a
 * local one. The key arrives from the secret store or the environment; it is
 * never written to the config, the logs or an error message.
 *
 * The key is the only secret here, so a failure reports the service's status
 * and a short body, never the request headers.
 */
import fs from "node:fs";
import type { TranscribeResult, Transcriber } from "./whisper.js";

export interface HttpTranscriberOptions {
  url: string;
  model: string;
  language?: string;
  /** Vocabulary hint: names the recogniser should spell as the operator does. */
  prompt?: string;
  apiKey: string;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

type TranscriptionBody = { text?: unknown; transcript?: unknown };

export class HttpTranscriber implements Transcriber {
  private readonly options: HttpTranscriberOptions;
  private readonly timeoutMs: number;

  constructor(options: HttpTranscriberOptions) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  get configured(): boolean {
    return this.options.url.trim().length > 0 && this.options.apiKey.trim().length > 0;
  }

  async transcribe(wavPath: string): Promise<TranscribeResult> {
    if (!this.configured) {
      return {
        ok: false,
        reason:
          "no transcription endpoint is configured (voice.httpTranscriptionUrl and the transcription-api-key secret)",
      };
    }
    let form: FormData;
    try {
      const bytes = fs.readFileSync(wavPath);
      form = new FormData();
      form.append("file", new Blob([bytes], { type: "audio/wav" }), "utterance.wav");
      form.append("model", this.options.model);
      const language = this.options.language?.trim();
      if (language && language !== "auto") form.append("language", language);
      const prompt = this.options.prompt?.trim();
      if (prompt) form.append("prompt", prompt);
    } catch (err: unknown) {
      return { ok: false, reason: `could not read the utterance: ${String(err)}` };
    }

    const doFetch = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await doFetch(this.options.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err: unknown) {
      const name = err instanceof Error ? err.name : "";
      return {
        ok: false,
        reason:
          name === "TimeoutError" || name === "AbortError"
            ? "the transcription service timed out"
            : `the transcription service could not be reached: ${String(err)}`,
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
        reason: `the transcription service answered ${response.status}${detail ? `: ${detail}` : ""}`,
      };
    }

    let body: TranscriptionBody;
    try {
      body = (await response.json()) as TranscriptionBody;
    } catch {
      return { ok: false, reason: "the transcription service returned no JSON" };
    }
    const text =
      typeof body.text === "string"
        ? body.text
        : typeof body.transcript === "string"
          ? body.transcript
          : "";
    const clean = text.trim();
    if (!clean) return { ok: false, reason: "blank transcript" };
    return { ok: true, text: clean };
  }
}
