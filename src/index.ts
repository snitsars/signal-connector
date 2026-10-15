#!/usr/bin/env node
/**
 * Composition root. Wires concrete adapters into the core (spine AD-1).
 * This is the only place that knows which adapter implementations exist.
 *
 * Also the `signal-connector` command: --version and --help are answered before
 * anything is started, so they work without a config, a store or a signal-cli.
 */
import { readFileSync, writeSync } from "node:fs";
import path from "node:path";
import { createAgentAdapter } from "./adapters/agent/factory.js";
import { ProjectLaunchers } from "./adapters/launcher/registry.js";
import { SignalCliDaemon } from "./adapters/signal/daemon.js";
import { SignalCliClient } from "./adapters/signal/signalCliClient.js";
import { BridgeHub } from "./bridge/hub.js";
import { startBridgeServer } from "./bridge/server.js";
import { dataDir, loadConfig } from "./config/config.js";
import { defaultSecretStore } from "./config/secrets.js";
import { CoreApp } from "./core/app.js";
import type { LauncherPort } from "./core/ports.js";
import { createLogger } from "./logging/logger.js";
import { openStore } from "./store/store.js";
import { parseArgs, USAGE } from "./cli/args.js";

/** Reads the version from the manifest beside the build output (and the sources). */
function packageVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const version = (parsed as { version?: unknown }).version;
    return typeof version === "string" ? version : "unknown";
  } catch {
    return "unknown";
  }
}

function print(fd: 1 | 2, text: string): void {
  // writeSync, not process.stdout.write: the process exits immediately after and
  // a piped stdout would be cut short by process.exit.
  writeSync(fd, `${text}\n`);
}

async function main(): Promise<void> {
  const dir = dataDir();
  const config = loadConfig(dir);
  const logger = createLogger({
    level: (process.env.LOG_LEVEL as "debug" | "info" | "warn" | "error") ?? "info",
    file: path.join(dir, "logs", "signal-connector.log"),
  });

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
  if (daemon) await daemon.start();

  const hub = new BridgeHub();
  hub.onDiag((projectId, detail) => logger.warn("plugin diagnostic", { project: projectId, detail }));
  const bridge = startBridgeServer(hub, {
    host: config.bridge.host,
    port: config.bridge.port,
    logger,
  });

  const agent = await createAgentAdapter(config, logger, hub);

  // Secrets are resolved lazily by adapters that need them; keep the store ready.
  void secrets;

  const app = new CoreApp({
    store,
    signal,
    agent,
    config,
    logger,
    launcher: new ProjectLaunchers(config, logger),
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
    await app.stop();
    await daemon?.stop();
    bridge.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

const mode = parseArgs(process.argv.slice(2));

if (mode === "version") {
  print(1, packageVersion());
  process.exit(0);
} else if (mode === "help") {
  print(1, USAGE);
  process.exit(0);
} else if (mode === "usage") {
  print(2, `unrecognised arguments: ${process.argv.slice(2).join(" ")}\n\n${USAGE}`);
  process.exit(1);
} else {
  main().catch((err: unknown) => {
    process.stderr.write(`fatal: ${String(err)}\n`);
    process.exit(1);
  });
}
