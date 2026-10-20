/**
 * Config loader (spine AD-9). Non-secret config lives in
 * %APPDATA%/SignalConnector/config.toml, created with defaults on first run.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import { z } from "zod";

export function dataDir(): string {
  const base = process.env.APPDATA ?? path.join(os.homedir(), ".config");
  return path.join(base, "SignalConnector");
}

export const ConfigSchema = z.object({
  channel: z
    .object({
      kind: z.enum(["note-to-self", "group"]).default("note-to-self"),
      id: z.string().optional(),
    })
    .default({ kind: "note-to-self" }),
  signal: z
    .object({
      cliPath: z.string().default("signal-cli"),
      /** Full argv for signal-cli (preferred over cliPath when set). */
      command: z.array(z.string()).optional(),
      account: z.string().optional(),
      daemonHost: z.string().default("127.0.0.1"),
      daemonPort: z.number().int().default(8080),
      manageDaemon: z.boolean().default(false),
    })
    .default({
      cliPath: "signal-cli",
      daemonHost: "127.0.0.1",
      daemonPort: 8080,
      manageDaemon: false,
    }),
  agent: z
    .object({
      kind: z.enum(["opencode-server", "opencode-cli", "plugin"]).default("opencode-server"),
      serverUrl: z.string().default("http://127.0.0.1:4096"),
      opencodePath: z.string().default("opencode"),
    })
    .default({ kind: "opencode-server", serverUrl: "http://127.0.0.1:4096", opencodePath: "opencode" }),
  bridge: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().default(8790),
    })
    .default({ host: "127.0.0.1", port: 8790 }),
  /**
   * Hearing the room and talking back (spine AD-1: core sees text and levels
   * only). The transcriber is fetched by `scripts/install-whisper.ps1`; speech
   * uses the Windows system voice, so nothing is downloaded or hosted.
   */
  voice: z
    .object({
      /** The fetched whisper.cpp binary. Empty disables transcription. */
      whisperPath: z.string().default(""),
      /** The multilingual model file the binary loads. */
      modelPath: z.string().default(""),
      /**
       * The optional Silero VAD model. When set, whisper drops non-speech
       * segments before transcribing, which is the strongest guard against
       * invented sentences over room tone.
       */
      vadPath: z.string().default(""),
      /** The fetched Piper binary; with piperVoicePath, it speaks instead of SAPI. */
      piperPath: z.string().default(""),
      /** The Piper `.onnx` speaker model; its `.onnx.json` sits beside it. */
      piperVoicePath: z.string().default(""),
    /** Piper's speaking pace; 1 is the model's own, higher is slower. */
    piperLengthScale: z.number().positive().default(1.0),
    /** Which voice: auto (Piper if fetched, else SAPI), piper, sapi, edge or http. */
    synthesizer: z.enum(["auto", "piper", "sapi", "edge", "http"]).default("auto"),
    /** Microsoft Edge neural voice for the "edge" synthesizer. */
    edgeVoice: z.string().default("uk-UA-OstapNeural"),
    /** Edge prosody, e.g. "+0%". */
    edgeRate: z.string().default("+0%"),
    /** OpenAI-compatible /v1/audio/speech endpoint and its settings. */
    ttsUrl: z.string().default(""),
    ttsModel: z.string().default("gpt-4o-mini-tts"),
    ttsVoice: z.string().default("alloy"),
    ttsFormat: z.enum(["wav", "mp3"]).default("wav"),
    /** Which recogniser to use: auto (sherpa, else whisper), or a forced one. */
    transcriber: z.enum(["auto", "whisper", "sherpa", "http", "nvidia"]).default("auto"),
    /** NVIDIA Riva gRPC host and the hosted whisper-large-v3 function. */
    rivaHost: z.string().default("grpc.nvcf.nvidia.com:443"),
    rivaFunctionId: z.string().default("b702f636-f60c-4a3d-a6f4-f3568c13bd7d"),
    /** Riva language code; Ukrainian is uk-UA. */
    rivaLanguage: z.string().default("uk-UA"),
    /** OpenAI-compatible /v1/audio/transcriptions endpoint; `${model}` not needed. */
    httpTranscriptionUrl: z.string().default(""),
    /** Model field sent to that endpoint, e.g. openai/whisper-large-v3. */
    httpTranscriptionModel: z.string().default("openai/whisper-large-v3"),
    /** Language hint for that endpoint; "auto" sends none. */
    httpTranscriptionLanguage: z.string().default("uk"),
    /** sherpa-onnx's offline recogniser; with sherpaModelDir it replaces whisper. */
    sherpaPath: z.string().default(""),
    /** Directory with encoder_model.ort, decoder_model_merged.ort and tokens.txt. */
    sherpaModelDir: z.string().default(""),
      /** Spoken language; "auto" lets the model decide. */
      language: z.string().default("auto"),
    /** Said once when the avatar is in the room and listening. Empty says nothing. */
    greeting: z.string().default("Привіт, я під'єднався. Готовий до роботи."),
    /** Said once when the operator asks the meeting to stop. Empty says nothing. */
    farewell: z.string().default("До зустрічі!"),
      /** RMS below which audio counts as room tone, not speech (0..1). */
      rmsFloor: z.number().default(0.01),
      /** A window shorter than this is noise, not an utterance to answer. */
      minUtteranceMs: z.number().int().positive().default(300),
      /** Silence after speech that closes an utterance, in milliseconds. */
      silenceMs: z.number().int().default(900),
      /** The longest single utterance, so a stuck room cannot grow without end. */
      maxUtteranceMs: z.number().int().default(15_000),
      /** At most one acknowledgement per this window, so fragments do not nag. */
      ackCooldownMs: z.number().int().nonnegative().default(4_000),
      /** Sustained operator speech before the answer is stopped, in milliseconds. */
      bargeInMs: z.number().int().positive().default(900),
      /** The Windows system voice to speak with; empty picks the default. */
      voiceName: z.string().default(""),
      /** SAPI speaking rate, -10..10; 0 is the voice's own pace. */
      rate: z.number().int().min(-10).max(10).default(0),
      /** The longest answer read aloud; the full text stays in the group. */
      maxSpeechChars: z.number().int().positive().default(600),
    })
    .default({
      whisperPath: "",
      modelPath: "",
      vadPath: "",
      piperPath: "",
      piperVoicePath: "",
      language: "auto",
      rmsFloor: 0.01,
      minUtteranceMs: 300,
      silenceMs: 900,
      maxUtteranceMs: 15_000,
      ackCooldownMs: 4_000,
      bargeInMs: 900,
      voiceName: "",
      rate: 0,
      maxSpeechChars: 600,
    }),
  /**
   * The meeting's own budgets (spine AD-1: core sees telemetry only). Presence
   * is advisory, the silence budget turns repeated silence into one alarm, and
   * the activity window closes a room that stopped reporting at all.
   */
  meeting: z
    .object({
      /** How long the room may be inaudible before the deaf alarm fires. */
      silenceBudgetMs: z.number().int().positive().default(5_000),
      /** How long an admitted meeting may go without telemetry before it is closed. */
      activityWindowMs: z.number().int().positive().default(30_000),
      /** How often the adapter reads presence and audio from the page. */
      telemetryMs: z.number().int().positive().default(5_000),
    })
    .refine((value) => value.telemetryMs < value.activityWindowMs, {
      // A cadence at or past the window means the watchdog can fire before the
      // adapter has had a chance to report, closing a healthy meeting.
      message: "meeting.telemetryMs must be less than meeting.activityWindowMs",
      path: ["telemetryMs"],
    })
    .default({ silenceBudgetMs: 5_000, activityWindowMs: 30_000, telemetryMs: 5_000 }),
  projects: z
    .array(
      z.object({
        name: z.string(),
        path: z.string(),
        /**
         * Optional opencode session id to pin the project to. When set, tasks go
         * into that existing session (for example the operator's own session)
         * instead of a fresh one per task.
         */
        session: z.string().optional(),
        /**
         * How to start this project when nothing is connected: a visible Herdr
         * workspace by default, or an arbitrary command with {path}/{name}.
         */
        launch: z
          .object({
            kind: z.enum(["herdr", "command"]).default("herdr"),
            /** Agent kind Herdr starts (only for kind = "herdr"). */
            agent: z.string().default("opencode"),
            /** argv template (only for kind = "command"). */
            argv: z.array(z.string()).optional(),
          })
          .optional(),
        /**
         * Who may summon a meeting for this project. `allow` is the accepted
         * identities (a Signal uuid/ACI, with the number as a label); an absent
         * or empty list refuses everyone, so a paste is never accepted by
         * default. `revokedAt` (ISO-8601) retires an entry without deleting it.
         * `providers` overrides the accepted provider hosts; absent uses the
         * build's default list.
         */
        meet: z
          .object({
            allow: z
              .array(
                z.object({
                  id: z.string(),
                  label: z.string().optional(),
                  revokedAt: z.string().optional(),
                }),
              )
              .optional()
              .default([]),
            providers: z.array(z.string()).optional(),
          })
          .optional(),
      }),
    )
    .default([]),
  outbound: z
    .object({
      minIntervalMs: z.number().int().default(1500),
      maxPerMinute: z.number().int().default(20),
    })
    .default({ minIntervalMs: 1500, maxPerMinute: 20 }),
});

export type Config = z.infer<typeof ConfigSchema>;

const DEFAULT_CONFIG: Config = ConfigSchema.parse({});

export function configPath(dir = dataDir()): string {
  return path.join(dir, "config.toml");
}

export function loadConfig(dir = dataDir()): Config {
  fs.mkdirSync(dir, { recursive: true });
  const file = configPath(dir);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, stringify(DEFAULT_CONFIG), "utf8");
    return DEFAULT_CONFIG;
  }
  const raw = parse(fs.readFileSync(file, "utf8"));
  return ConfigSchema.parse(raw);
}
