import { describe, expect, it } from "vitest";
import type { RealtimeSocket } from "./realtimeTranscriber.js";
import { OpenAiStreamingTranscriber, upsample16To24 } from "./realtimeTranscriber.js";

class FakeSocket implements RealtimeSocket {
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.emit("close", {});
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  message(payload: unknown): void {
    this.emit("message", { data: JSON.stringify(payload) });
  }
}

const OPTIONS = {
  apiKey: "secret-key",
  model: "gpt-live-transcribe",
  language: "uk",
  prompt: "SignalConnector, opencode",
  connectTimeoutMs: 200,
  finishTimeoutMs: 200,
};

function setup(options: Partial<typeof OPTIONS> = {}) {
  const socket = new FakeSocket();
  const urls: string[] = [];
  const protocols: string[][] = [];
  const transcriber = new OpenAiStreamingTranscriber({
    ...OPTIONS,
    ...options,
    factory: (url, offered) => {
      urls.push(url);
      protocols.push(offered);
      return socket;
    },
  });
  return { socket, urls, protocols, transcriber };
}

function frame(samples: number[]): string {
  return Buffer.from(new Int16Array(samples).buffer).toString("base64");
}

describe("upsample16To24", () => {
  it("produces one and a half samples per input sample", () => {
    expect(upsample16To24(Buffer.alloc(320)).length).toBe(480);
  });

  it("keeps the first value and interpolates towards the next", () => {
    const input = Buffer.from(new Int16Array([0, 300]).buffer);
    const output = Buffer.from(upsample16To24(input));
    expect(output.readInt16LE(0)).toBe(0);
    expect(output.readInt16LE(2)).toBe(200);
    expect(output.readInt16LE(4)).toBe(300);
  });

  it("returns nothing for an empty frame", () => {
    expect(upsample16To24(Buffer.alloc(0)).length).toBe(0);
  });
});

describe("OpenAiStreamingTranscriber", () => {
  it("opens a transcription session with the model, language and prompt", async () => {
    const { socket, urls, protocols, transcriber } = setup();
    const started = transcriber.start();

    socket.emit("open", {});
    expect(urls[0]).toContain("/v1/realtime");
    expect(protocols[0]).toEqual(["realtime", "openai-insecure-api-key.secret-key"]);
    const update = JSON.parse(socket.sent[0]!) as {
      type: string;
      session: {
        type: string;
        audio: {
          input: {
            format: { type: string; rate: number };
            transcription: { model: string; language?: string; prompt?: string };
            turn_detection: unknown;
          };
        };
      };
    };
    expect(update.type).toBe("session.update");
    expect(update.session.type).toBe("transcription");
    expect(update.session.audio.input.format).toEqual({ type: "audio/pcm", rate: 24000 });
    expect(update.session.audio.input.transcription.model).toBe("gpt-live-transcribe");
    expect(update.session.audio.input.transcription.language).toBe("uk");
    expect(update.session.audio.input.transcription.prompt).toContain("SignalConnector");
    expect(update.session.audio.input.turn_detection).toBeNull();

    socket.message({ type: "session.updated" });
    await expect(started).resolves.toBe(true);
    expect(transcriber.ready).toBe(true);
  });

  it("appends the room frame, upsampled to the socket rate", async () => {
    const { socket, transcriber } = setup();
    const started = transcriber.start();
    socket.emit("open", {});
    socket.message({ type: "session.updated" });
    await started;

    transcriber.append(frame([0, 300]));

    const append = JSON.parse(socket.sent.at(-1)!) as { type: string; audio: string };
    expect(append.type).toBe("input_audio_buffer.append");
    const pcm = Buffer.from(append.audio, "base64");
    expect(pcm.length).toBe(6); // two 16 kHz samples become three 24 kHz samples
  });

  it("commits the utterance and returns the final transcript", async () => {
    const { socket, transcriber } = setup();
    const started = transcriber.start();
    socket.emit("open", {});
    socket.message({ type: "session.updated" });
    await started;

    const finished = transcriber.finish();
    expect(JSON.parse(socket.sent.at(-1)!).type).toBe("input_audio_buffer.commit");
    socket.message({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "  відкрий SignalConnector  ",
    });

    await expect(finished).resolves.toEqual({ ok: true, text: "відкрий SignalConnector" });
  });

  it("treats a blank final as a dropped utterance", async () => {
    const { socket, transcriber } = setup();
    const started = transcriber.start();
    socket.emit("open", {});
    socket.message({ type: "session.updated" });
    await started;

    const finished = transcriber.finish();
    socket.message({ type: "conversation.item.input_audio_transcription.completed", transcript: " " });

    await expect(finished).resolves.toEqual({ ok: false, reason: "blank transcript" });
  });

  it("refuses to start without a key", async () => {
    const { transcriber } = setup({ apiKey: "" });
    expect(transcriber.configured).toBe(false);
    await expect(transcriber.start()).resolves.toBe(false);
    await expect(transcriber.finish()).resolves.toEqual({
      ok: false,
      reason: "the streaming recogniser is not connected",
    });
  });

  it("fails the start when the service reports an error", async () => {
    const { socket, transcriber } = setup();
    const started = transcriber.start();
    socket.emit("open", {});
    socket.message({ type: "error", error: { message: "model not found" } });

    await expect(started).resolves.toBe(false);
    expect(transcriber.ready).toBe(false);
  });

  it("returns a reason instead of waiting when the meeting ends mid-utterance", async () => {
    const { socket, transcriber } = setup();
    const started = transcriber.start();
    socket.emit("open", {});
    socket.message({ type: "session.updated" });
    await started;

    const finished = transcriber.finish();
    transcriber.stop();

    await expect(finished).resolves.toEqual({
      ok: false,
      reason: "the meeting ended",
    });
    expect(socket.closed).toBe(true);
  });

  it("clears the buffer when an utterance is dropped", async () => {
    const { socket, transcriber } = setup();
    const started = transcriber.start();
    socket.emit("open", {});
    socket.message({ type: "session.updated" });
    await started;

    transcriber.reset();

    expect(JSON.parse(socket.sent.at(-1)!).type).toBe("input_audio_buffer.clear");
  });
});
