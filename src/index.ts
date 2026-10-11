/**
 * Composition root. Wires concrete adapters into the core (spine AD-1).
 * This is the only place that knows which adapter implementations exist.
 */
import path from "node:path";
import { OpenCodeCliAdapter } from "./adapters/agent/opencodeCli.js";
import { SignalCliDaemon } from "./adapters/signal/daemon.js";
import { SignalCliClient } from "./adapters/signal/signalCliClient.js";
import { dataDir, loadConfig } from "./config/config.js";
import { defaultSecretStore } from "./config/secrets.js";
import { CoreApp } from "./core/app.js";
import { createLogger } from "./logging/logger.js";
import { openStore } from "./store/store.js";

async function main(): Promise<void> {
  const dir = dataDir();
  const config = loadConfig(dir);
  const logger = createLogger({
    level: "info",
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
    logger,
  });

  const daemon = config.signal.manageDaemon
    ? new SignalCliDaemon({
        cliPath: config.signal.cliPath,
        host: config.signal.daemonHost,
        port: config.signal.daemonPort,
        ...(config.signal.account ? { account: config.signal.account } : {}),
        logger,
      })
    : undefined;
  if (daemon) await daemon.start();

  const agent = new OpenCodeCliAdapter({
    opencodePath: config.agent.opencodePath,
    logger,
  });

  // Secrets are resolved lazily by adapters that need them; keep the store ready.
  void secrets;

  const app = new CoreApp({ store, signal, agent, config, logger });
  await app.start();
  logger.info("SignalConnector is running");

  const shutdown = async (): Promise<void> => {
    logger.info("shutting down");
    await app.stop();
    await daemon?.stop();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${String(err)}\n`);
  process.exit(1);
});
