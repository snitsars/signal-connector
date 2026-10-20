/**
 * Microsoft's Edge neural voices, reached over the same read-aloud service the
 * Edge browser uses. No key and no account: the connector only needs the voice
 * name (`uk-UA-OstapNeural`, `uk-UA-PolinaNeural`) and the text.
 *
 * The service returns MP3, which the page's decodeAudioData accepts exactly like
 * a WAV; the clip is written to one temp file and deleted once the room has it.
 * This is a network path, so it is used only when the operator asks for it
 * (`synthesizer = "edge"`); the local Piper voice stays the default.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EdgeTTS } from "@andresaya/edge-tts";
import type { SynthesizeResult, Synthesizer } from "./sapi.js";

export interface EdgeOptions {
  /** A short voice name, e.g. uk-UA-OstapNeural. */
  voice: string;
  /** Prosody as the service words it: "+0%", "-10%", "+2Hz". */
  rate?: string;
  pitch?: string;
  volume?: string;
  workDir: string;
  timeoutMs?: number;
  /** Injectable for tests; production talks to the Edge read-aloud service. */
  synth?: (text: string) => Promise<Buffer>;
}

export class EdgeSynthesizer implements Synthesizer {
  private readonly options: EdgeOptions;
  private readonly timeoutMs: number;

  constructor(options: EdgeOptions) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  get configured(): boolean {
    return this.options.voice.trim().length > 0;
  }

  async synthesize(text: string): Promise<SynthesizeResult> {
    if (!text.trim()) return { ok: false, reason: "there is nothing to say" };
    if (!this.configured) {
      return { ok: false, reason: "no Edge voice is configured (voice.edgeVoice)" };
    }

    let audio: Buffer;
    try {
      const run = this.options.synth ?? ((value: string) => this.fetchClip(value));
      audio = await run(text);
    } catch (err: unknown) {
      return { ok: false, reason: `the speech service failed: ${String(err)}` };
    }
    if (!audio || audio.length === 0) {
      return { ok: false, reason: "the speech service returned no audio" };
    }

    const clipPath = path.join(this.options.workDir, `speech-${crypto.randomUUID()}.mp3`);
    try {
      fs.mkdirSync(this.options.workDir, { recursive: true });
      fs.writeFileSync(clipPath, audio);
    } catch (err: unknown) {
      return { ok: false, reason: `could not keep the clip: ${String(err)}` };
    }
    return { ok: true, wavPath: clipPath };
  }

  private async fetchClip(text: string): Promise<Buffer> {
    const tts = new EdgeTTS({ timeout: this.timeoutMs });
    const result = await tts.generate(text, this.options.voice, {
      ...(this.options.rate ? { rate: this.options.rate } : {}),
      ...(this.options.pitch ? { pitch: this.options.pitch } : {}),
      ...(this.options.volume ? { volume: this.options.volume } : {}),
      timeout: this.timeoutMs,
    });
    return Buffer.from(result.audio);
  }
}
