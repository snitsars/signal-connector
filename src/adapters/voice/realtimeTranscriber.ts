/**
 * Streaming recognition over the OpenAI Realtime transcription socket. The room
 * frames are appended while the operator speaks, so by the time the utterance
 * is cut only the tail has to be processed; the final arrives in a few hundred
 * milliseconds instead of a full HTTP round trip.
 *
 * It is strictly an optimisation: every failure returns `ok: false` and the
 * caller falls back to the batch recogniser, so a dropped socket can never make
 * the meeting deaf. The key is sent as a WebSocket subprotocol because the
 * browser-compatible handshake has no header slot; it is never logged.
 */
import type { TranscribeResult } from "./whisper.js";

/** The part of the streaming recogniser the voice adapter depends on. */
export interface StreamingTranscription {
  readonly configured: boolean;
  /** True once the socket is open and the session has been acknowledged. */
  readonly ready: boolean;
  /** Open the session; resolves false when it cannot be used this meeting. */
  start(): Promise<boolean>;
  /** Feed one 16 kHz mono PCM16 frame (base64), as the page sent it. */
  append(pcmBase64: string): void;
  /** Commit the utterance and wait for its final text. */
  finish(): Promise<TranscribeResult>;
  /** Drop the buffered audio after a window that will not be transcribed. */
  reset(): void;
  stop(): void;
}

/** The socket the adapter needs; injectable so tests never touch the network. */
export interface RealtimeSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

export type RealtimeSocketFactory = (url: string, protocols: string[]) => RealtimeSocket;

export interface RealtimeOptions {
  apiKey: string;
  /** e.g. "gpt-live-transcribe": the model built for live audio. */
  model: string;
  /** Spoken language hint, e.g. "uk"; empty lets the model decide. */
  language?: string;
  /** Vocabulary hint: names spelled as the operator writes them. */
  prompt?: string;
  url?: string;
  connectTimeoutMs?: number;
  finishTimeoutMs?: number;
  factory?: RealtimeSocketFactory;
}

const DEFAULT_URL = "wss://api.openai.com/v1/realtime?intent=transcription";

/** The API's minimum input rate is 24 kHz; the page captures 16 kHz. */
export function upsample16To24(pcm: Buffer): Buffer {
  const count = Math.floor(pcm.length / 2);
  if (count === 0) return Buffer.alloc(0);
  const input = new Int16Array(count);
  for (let i = 0; i < count; i++) input[i] = pcm.readInt16LE(i * 2);
  const out = new Int16Array(Math.round((count * 3) / 2));
  for (let i = 0; i < out.length; i++) {
    const at = (i * 2) / 3;
    const low = Math.floor(at);
    const high = Math.min(count - 1, low + 1);
    const mix = at - low;
    out[i] = Math.round((input[low] ?? 0) * (1 - mix) + (input[high] ?? 0) * mix);
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

function messageText(event: unknown): string {
  if (typeof event === "object" && event !== null && "data" in event) {
    const data = (event as { data: unknown }).data;
    return typeof data === "string" ? data : "";
  }
  return "";
}

type Pending = {
  resolve: (result: TranscribeResult) => void;
  timer: NodeJS.Timeout;
};

type RealtimeEvent = { type?: unknown; transcript?: unknown; error?: unknown };

export class OpenAiStreamingTranscriber implements StreamingTranscription {
  private readonly options: RealtimeOptions;
  private readonly connectTimeoutMs: number;
  private readonly finishTimeoutMs: number;
  private readonly factory: RealtimeSocketFactory;
  private socket: RealtimeSocket | undefined;
  private connecting: Promise<boolean> | undefined;
  private opened = false;
  private pending: Pending | undefined;

  constructor(options: RealtimeOptions) {
    this.options = options;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.finishTimeoutMs = options.finishTimeoutMs ?? 15_000;
    this.factory =
      options.factory ??
      ((url, protocols) => new WebSocket(url, protocols) as unknown as RealtimeSocket);
  }

  get configured(): boolean {
    return this.options.apiKey.trim().length > 0 && this.options.model.trim().length > 0;
  }

  get ready(): boolean {
    return this.opened;
  }

  async start(): Promise<boolean> {
    if (this.opened) return true;
    if (!this.configured) return false;
    if (!this.connecting) this.connecting = this.connect();
    const ok = await this.connecting;
    if (!ok) this.connecting = undefined;
    return ok;
  }

  private connect(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!ok) {
          this.opened = false;
          this.connecting = undefined;
          this.socket?.close();
          this.socket = undefined;
        }
        resolve(ok);
      };
      const timer = setTimeout(() => settle(false), this.connectTimeoutMs);
      let socket: RealtimeSocket;
      try {
        socket = this.factory(this.options.url?.trim() || DEFAULT_URL, [
          "realtime",
          `openai-insecure-api-key.${this.options.apiKey}`,
        ]);
      } catch {
        settle(false);
        return;
      }
      this.socket = socket;
      socket.addEventListener("open", () => {
        try {
          socket.send(JSON.stringify(this.sessionUpdate()));
        } catch {
          settle(false);
        }
      });
      socket.addEventListener("message", (event) => {
        const text = messageText(event);
        if (!text) return;
        let data: RealtimeEvent;
        try {
          data = JSON.parse(text) as RealtimeEvent;
        } catch {
          return;
        }
        const type = typeof data.type === "string" ? data.type : "";
        if (type === "session.updated") {
          this.opened = true;
          settle(true);
          return;
        }
        if (type === "conversation.item.input_audio_transcription.completed") {
          const text = typeof data.transcript === "string" ? data.transcript.trim() : "";
          this.settle(text ? { ok: true, text } : { ok: false, reason: "blank transcript" });
          return;
        }
        if (type === "conversation.item.input_audio_transcription.failed" || type === "error") {
          const reason = this.errorText(data.error);
          if (!this.opened) settle(false);
          this.settle({ ok: false, reason });
        }
      });
      socket.addEventListener("error", () => {
        if (!this.opened) settle(false);
        this.settle({ ok: false, reason: "the streaming recogniser failed" });
      });
      socket.addEventListener("close", () => {
        this.opened = false;
        this.socket = undefined;
        this.connecting = undefined;
        if (!settled) settle(false);
        this.settle({ ok: false, reason: "the streaming recogniser closed" });
      });
    });
  }

  private sessionUpdate(): Record<string, unknown> {
    const language = this.options.language?.trim() ?? "";
    const prompt = this.options.prompt?.trim() ?? "";
    return {
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            transcription: {
              model: this.options.model,
              ...(language && language !== "auto" ? { language } : {}),
              ...(prompt ? { prompt } : {}),
            },
            noise_reduction: { type: "near_field" },
            turn_detection: null,
          },
        },
      },
    };
  }

  private errorText(error: unknown): string {
    if (typeof error === "object" && error !== null && "message" in error) {
      const message = (error as { message: unknown }).message;
      if (typeof message === "string" && message.trim()) {
        return `the streaming recogniser said: ${message.replace(/\s+/g, " ").slice(0, 200)}`;
      }
    }
    return "the streaming recogniser refused the utterance";
  }

  append(pcmBase64: string): void {
    if (!this.opened || !this.socket) return;
    try {
      const pcm = Buffer.from(pcmBase64, "base64");
      const audio = upsample16To24(pcm).toString("base64");
      if (!audio) return;
      this.socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
    } catch {
      // A broken socket is not a reason to lose the question: the caller falls
      // back to the batch recogniser.
    }
  }

  async finish(): Promise<TranscribeResult> {
    if (!this.opened || !this.socket) {
      // Heal in the background so the next question can use the stream; this
      // one is answered by the batch recogniser.
      if (this.configured) void this.start();
      return { ok: false, reason: "the streaming recogniser is not connected" };
    }
    if (this.pending) {
      return { ok: false, reason: "the streaming recogniser is still finishing another utterance" };
    }
    return new Promise<TranscribeResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        resolve({ ok: false, reason: "the streaming recogniser timed out" });
      }, this.finishTimeoutMs);
      this.pending = { resolve, timer };
      try {
        this.socket?.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      } catch (err: unknown) {
        this.settle({
          ok: false,
          reason: `the streaming recogniser could not take the audio: ${String(err)}`,
        });
      }
    });
  }

  reset(): void {
    this.settle({ ok: false, reason: "the utterance was dropped" });
    if (!this.opened || !this.socket) return;
    try {
      this.socket.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
    } catch {
      /* the next finish falls back to the batch recogniser */
    }
  }

  stop(): void {
    this.settle({ ok: false, reason: "the meeting ended" });
    this.opened = false;
    this.connecting = undefined;
    const socket = this.socket;
    this.socket = undefined;
    try {
      socket?.close();
    } catch {
      /* nothing to close */
    }
  }

  private settle(result: TranscribeResult): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.resolve(result);
  }
}
