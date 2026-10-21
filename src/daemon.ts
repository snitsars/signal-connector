/**
 * The daemon path: everything that needs config, the store, secrets and the
 * adapters. `src/index.ts` imports this module dynamically, inside the daemon
 * branch only, so `--version`, `--help`, doctor and setup never evaluate it —
 * below the Node floor `node:sqlite` cannot even be resolved.
 */
import { writeSync } from "node:fs";
import path from "node:path";
import { createAgentAdapter } from "./adapters/agent/factory.js";
import { ProjectLaunchers } from "./adapters/launcher/registry.js";
import { BrowserMeeting } from "./adapters/meeting/browserMeeting.js";
import { SignalCliDaemon } from "./adapters/signal/daemon.js";
import { SignalCliClient } from "./adapters/signal/signalCliClient.js";
import { BrowserVoice } from "./adapters/voice/browserVoice.js";
import { BridgeHub } from "./bridge/hub.js";
import { startBridgeServer } from "./bridge/server.js";
import { registry, runDoctor, stepContext } from "./cli/setup.js";
import { dataDir, loadConfig, readConfig } from "./config/config.js";
import { defaultSecretStore } from "./config/secrets.js";
import { CoreApp } from "./core/app.js";
import { createLogger } from "./logging/logger.js";
import { openStore } from "./store/store.js";

export async function runDaemon(): Promise<number> {
  const dir = dataDir();

  // Same registry and same lines as doctor, before the logger, store, daemon or
  // browser exists: a missing prerequisite is a refusal, never a late crash.
  const preflight = await runDoctor(
    registry(),
    stepContext(dir, readConfig(dir), (line) => writeSync(1, `${line}\n`)),
  );
  if (preflight !== 0) {
    writeSync(1, "SignalConnector is not ready; fix the steps above and start again.\n");
    return 1;
  }

  const config = loadConfig(dir);
  const logger = createLogger({
    level: (process.env.LOG_LEVEL as "debug" | "info" | "warn" | "error") ?? "info",
    file: path.join(dir, "logs", "signal-connector.log"),
  });

  // Bind the bridge port before anything else. That port is this service's
  // single-instance lock: a second instance must stop here, because if it
  // carries on it adopts the same signal-cli daemon and its own `receive` loop
  // competes with ours, which wedges the daemon's message intake.
  const hub = new BridgeHub();
  hub.onDiag((projectId, detail) => logger.warn("plugin diagnostic", { project: projectId, detail }));
  const bridge = startBridgeServer(hub, {
    host: config.bridge.host,
    port: config.bridge.port,
    logger,
  });
  try {
    await bridge.ready;
  } catch (err: unknown) {
    logger.error("another SignalConnector is already running on this port; exiting", {
      port: config.bridge.port,
      error: String(err),
    });
    // The file logger writes asynchronously; without this pause the reason for
    // exiting is lost with the process and the log shows nothing at all.
    await new Promise((resolve) => setTimeout(resolve, 250));
    process.exit(1);
  }

  const store = openStore(path.join(dir, "state.db"));
  const secrets = defaultSecretStore(dir);

  const account = config.signal.account ?? "";
  if (!account) {
    logger.warn("no signal.account configured; link a device and set it in config.toml");
  }

  const signal = new SignalCliClient({
    endpoint: `http://${config.signal.daemonHost}:${config.signal.daemonPort}/api/v1/rpc`,
    account,
    channelId: config.channel.id ?? "self",
    channelKind: config.channel.kind,
    mediaDir: path.join(dir, "media"),
    logger,
  });

  const daemon = config.signal.manageDaemon
    ? new SignalCliDaemon({
        command: config.signal.command ?? [config.signal.cliPath],
        host: config.signal.daemonHost,
        port: config.signal.daemonPort,
        ...(config.signal.account ? { account: config.signal.account } : {}),
        logger,
      })
    : undefined;
  // A daemon that stopped serving `receive` is replaced, not waited for.
  signal.onUnhealthy((reason) => {
    void daemon?.restart(reason);
  });
  if (daemon) await daemon.start();

  const agent = await createAgentAdapter(config, logger, hub);

  // Secrets are resolved lazily by adapters that need them; keep the store ready.
  void secrets;

  // The one temp audio directory: an utterance WAV and a spoken clip, each
  // deleted the moment its consumer has it.
  const voiceDir = path.join(dir, "voice");

  // The meeting page is the only thing that can make the room hear, and the
  // voice pump is the only thing that decides what to say, so the two are wired
  // to each other: audio out of the room goes to the pump, spoken clips go back
  // through the same page.
  let voice: BrowserVoice | undefined;
  const meeting = new BrowserMeeting({
    // The browser's only footprint: its own profile under the data dir, never
    // the operator's, and safe to delete at any time.
    profileDir: path.join(dir, "meeting-profile"),
    logger,
    // The room's audio rides the CDP channel the meeting already owns.
    onAudio: (frame) => voice?.push(frame),
    // Presence and audio readings are plain telemetry; core owns the budgets.
    telemetryMs: config.meeting.telemetryMs,
  });
  // The hosted transcription key is a secret: the DPAPI store is the durable
  // place, and an environment variable is a convenience for a quick trial.
  // It never reaches the config file, a log line or an error message.
  const transcriptionKey =
    (await secrets.get(config.voice.transcriptionKeySecret)) ??
    process.env.TRANSCRIPTION_API_KEY ??
    "";
  const ttsKey = (await secrets.get("tts-api-key")) ?? process.env.TTS_API_KEY ?? "";
  const azureKey =
    (await secrets.get("azure-speech-key")) ?? process.env.AZURE_SPEECH_KEY ?? "";
  logger.info("voice: transcriber", { kind: config.voice.transcriber });
  logger.info("voice: synthesizer", { kind: config.voice.synthesizer });

  voice = new BrowserVoice({
    config: config.voice,
    logger,
    workDir: voiceDir,
    ...(transcriptionKey ? { transcriptionKey } : {}),
    ...(ttsKey ? { ttsKey } : {}),
    ...(azureKey ? { azureKey } : {}),
    // Speech goes back into the room's own synthetic microphone, over the CDP
    // session the meeting already has open.
    sink: {
      play: (wavBase64, epoch) => meeting.playAudio(wavBase64, epoch),
      stop: () => meeting.stopAudio(),
      state: () => meeting.speechState(),
      epoch: () => meeting.speechEpoch(),
    },
  });

  const app = new CoreApp({
    store,
    signal,
    agent,
    config,
    logger,
    launcher: new ProjectLaunchers(config, logger),
    meeting,
    voice,
  });
  await app.start();

  // When a project's plugin connects, register it and greet the operator on its
  // behalf — once per project (plugins may reconnect or reload).
  const greeted = new Set<string>();
  hub.onConnect((conn) => {
    if (greeted.has(conn.projectId)) return;
    greeted.add(conn.projectId);
    void app
      .onProjectConnected({ id: conn.projectId, name: conn.projectName, path: conn.projectPath })
      .catch((err: unknown) => logger.warn("connect notify failed", { error: String(err) }));
  });
  logger.info("SignalConnector is running");

  const shutdown = async (): Promise<void> => {
    logger.info("shutting down");
    try {
      await app.stop();
    } finally {
      // Even if leaving the room threw, no clip may outlive the process.
      await voice?.stop();
    }
    await daemon?.stop();
    bridge.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  return 0;
}
