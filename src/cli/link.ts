/**
 * `npm run link` — start the daemon, print the device-link URI, and wait for
 * the operator to scan it.
 */
import { SignalCliDaemon } from "../adapters/signal/daemon.js";
import { finishLink, linkInstructions, startLink } from "../adapters/signal/link.js";
import { loadConfig } from "../config/config.js";
import { createLogger } from "../logging/logger.js";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: "info" });
  const daemon = new SignalCliDaemon({
    command: config.signal.command ?? [config.signal.cliPath],
    host: config.signal.daemonHost,
    port: config.signal.daemonPort,
    ...(config.signal.account ? { account: config.signal.account } : {}),
    logger,
  });
  await daemon.start();

  const endpoint = daemon.endpoint();
  const uri = await startLink(endpoint);
  process.stdout.write(`${linkInstructions(uri)}\n`);

  for (let i = 0; i < 60; i++) {
    await delay(3000);
    try {
      const number = await finishLink(endpoint, uri);
      if (number) {
        process.stdout.write(`Linked as ${number}. Set signal.account in config.toml.\n`);
        await daemon.stop();
        return;
      }
    } catch {
      // not scanned yet; keep waiting
    }
  }
  process.stderr.write("Link timed out; run `npm run link` again.\n");
  await daemon.stop();
}

main().catch((err: unknown) => {
  process.stderr.write(`link failed: ${String(err)}\n`);
  process.exit(1);
});
