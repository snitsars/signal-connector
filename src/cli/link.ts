/**
 * `npm run link` — start the daemon, render the device-link URI as a QR image,
 * open it, and wait for the operator to scan.
 */
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import QRCode from "qrcode";
import { SignalCliDaemon } from "../adapters/signal/daemon.js";
import { finishLink, linkInstructions, startLink } from "../adapters/signal/link.js";
import { loadConfig } from "../config/config.js";
import { createLogger } from "../logging/logger.js";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function openFile(filePath: string): void {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", filePath], { windowsHide: true, detached: true }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [filePath], { detached: true }).unref();
    } else {
      spawn("xdg-open", [filePath], { detached: true }).unref();
    }
  } catch {
    // opening is best-effort; the path is printed anyway
  }
}

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

  const qrPath = path.join(os.tmpdir(), "signal-link-qr.png");
  await QRCode.toFile(qrPath, uri, { width: 512, margin: 2 });

  process.stdout.write(`${linkInstructions(uri)}\n\n`);
  process.stdout.write(`QR image: ${qrPath}\n`);
  process.stdout.write("Opening the QR image — scan it with Signal.\n");
  openFile(qrPath);

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
