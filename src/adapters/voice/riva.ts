/**
 * NVIDIA's hosted Whisper large-v3, over Riva gRPC.
 *
 * build.nvidia.com documents this model as a gRPC service (there is no REST
 * route): `grpc.nvcf.nvidia.com:443` with the `function-id` and bearer-key
 * metadata. The request is the ordinary unary `Recognize`, so the whole
 * utterance rides in one message and no streaming state is needed.
 *
 * Only the fields this adapter sends are declared; their numbers are the wire
 * contract, so they must not change. The service's `model` field stays empty:
 * the hosted function rejected every explicit model name and serves its own.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { TranscribeResult, Transcriber } from "./whisper.js";

const PROTO = `syntax = "proto3";
package nvidia.riva.asr;

service RivaSpeechRecognition {
  rpc Recognize(RecognizeRequest) returns (RecognizeResponse);
}

message RecognizeRequest {
  RecognitionConfig config = 1;
  bytes audio = 2;
}

message RecognitionConfig {
  int32 encoding = 1;
  int32 sample_rate_hertz = 2;
  string language_code = 3;
  int32 max_alternatives = 4;
  bool enable_automatic_punctuation = 11;
  string model = 13;
}

message RecognizeResponse {
  repeated SpeechRecognitionResult results = 1;
}

message SpeechRecognitionResult {
  repeated SpeechRecognitionAlternative alternatives = 1;
}

message SpeechRecognitionAlternative {
  string transcript = 1;
  float confidence = 2;
}
`;

/** LINEAR_PCM in riva_audio.proto; the utterance WAV is 16 kHz mono 16-bit. */
const LINEAR_PCM = 1;

export interface RivaInput {
  host: string;
  apiKey: string;
  functionId: string;
  language: string;
  audio: Buffer;
  timeoutMs: number;
}

export interface RivaResponse {
  results?: Array<{ alternatives?: Array<{ transcript?: string }> }>;
}

export interface RivaOptions {
  host: string;
  functionId: string;
  language: string;
  apiKey: string;
  timeoutMs?: number;
  /** Injectable for tests; production talks gRPC to NVIDIA. */
  recognize?: (input: RivaInput) => Promise<RivaResponse>;
}

let protoPath: string | undefined;
function rivaProto(): string {
  if (protoPath) return protoPath;
  const file = path.join(os.tmpdir(), "signalconnector-riva-asr.proto");
  if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== PROTO) {
    fs.writeFileSync(file, PROTO, "utf8");
  }
  protoPath = file;
  return file;
}

interface RivaClient {
  recognize(
    request: unknown,
    metadata: grpc.Metadata,
    options: { deadline: number },
    callback: (err: grpc.ServiceError | null, response?: RivaResponse) => void,
  ): void;
  close(): void;
}

type RivaService = new (host: string, credentials: grpc.ChannelCredentials) => RivaClient;

let service: RivaService | undefined;
function rivaService(): RivaService {
  if (service) return service;
  const definition = protoLoader.loadSync(rivaProto(), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(definition) as unknown as {
    nvidia: { riva: { asr: { RivaSpeechRecognition: RivaService } } };
  };
  service = loaded.nvidia.riva.asr.RivaSpeechRecognition;
  return service;
}

async function recognizeWithNvidia(input: RivaInput): Promise<RivaResponse> {
  const Service = rivaService();
  const client = new Service(input.host, grpc.credentials.createSsl());
  try {
    const metadata = new grpc.Metadata();
    metadata.set("authorization", `Bearer ${input.apiKey}`);
    metadata.set("function-id", input.functionId);
    return await new Promise<RivaResponse>((resolve, reject) => {
      client.recognize(
        {
          config: {
            encoding: LINEAR_PCM,
            sample_rate_hertz: 16000,
            language_code: input.language,
            max_alternatives: 1,
            enable_automatic_punctuation: true,
            model: "",
          },
          audio: input.audio,
        },
        metadata,
        { deadline: Date.now() + input.timeoutMs },
        (err, response) => {
          if (err) reject(err);
          else resolve(response ?? {});
        },
      );
    });
  } finally {
    client.close();
  }
}

export class RivaTranscriber implements Transcriber {
  private readonly options: RivaOptions;
  private readonly timeoutMs: number;

  constructor(options: RivaOptions) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  get configured(): boolean {
    return (
      this.options.host.trim().length > 0 && this.options.apiKey.trim().length > 0
    );
  }

  async transcribe(wavPath: string): Promise<TranscribeResult> {
    if (!this.configured) {
      return {
        ok: false,
        reason:
          "no NVIDIA key is configured (the transcription-api-key secret or TRANSCRIPTION_API_KEY)",
      };
    }
    let audio: Buffer;
    try {
      audio = fs.readFileSync(wavPath);
    } catch (err: unknown) {
      return { ok: false, reason: `could not read the utterance: ${String(err)}` };
    }

    let response: RivaResponse;
    try {
      const run = this.options.recognize ?? recognizeWithNvidia;
      response = await run({
        host: this.options.host,
        apiKey: this.options.apiKey,
        functionId: this.options.functionId,
        language: this.options.language,
        audio,
        timeoutMs: this.timeoutMs,
      });
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      const timedOut = (err as { code?: number }).code === grpc.status.DEADLINE_EXCEEDED;
      return {
        ok: false,
        reason: timedOut ? "the NVIDIA recogniser timed out" : `the NVIDIA recogniser failed: ${detail}`,
      };
    }

    const text = (response.results ?? [])
      .flatMap((result) => result.alternatives ?? [])
      .map((alternative) => alternative.transcript ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return { ok: false, reason: "blank transcript" };
    return { ok: true, text };
  }
}
