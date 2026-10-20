/**
 * The live device-link driver, shared by `npm run link` and the setup step.
 *
 * `signalLinker` is the four-phase `DeviceLink` the step can fake: it starts
 * the signal-cli daemon, renders the QR image under the data directory, polls
 * `finishLink` and stops the daemon. `linkWithQr` is the script's whole flow
 * over the same phases, so setup and `npm run link` cannot drift apart.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { SignalCliDaemon } from "../adapters/signal/daemon.js";
import { finishLink, startLink } from "../adapters/signal/link.js";
import { dataDir, loadConfig } from "../config/config.js";
import { createLogger, type Logger } from "../logging/logger.js";
import {
  driveLink,
  LINK_HOST,
  LINK_PORT,
  type DeviceLink,
  type SignalCommand,
} from "./configure.js";
import type { Print } from "./setup.js";

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

export interface SignalLinkerOptions {
  dataDir: string;
  signal: SignalCommand;
  host?: string;
  port?: number;
  /** Passed to the daemon when config.toml already names an account. */
  account?: string;
  logger?: Logger;
}

/** The production phases. The QR image lives under the data directory. */
export function signalLinker(options: SignalLinkerOptions): DeviceLink {
  const host = options.host ?? LINK_HOST;
  const port = options.port ?? LINK_PORT;
  const daemon = new SignalCliDaemon({
    command: options.signal.command,
    host,
    port,
    ...(options.account ? { account: options.account } : {}),
    logger: options.logger ?? createLogger({ level: "info" }),
  });
  let endpoint = "";

  return {
    async start() {
      await daemon.start();
      endpoint = daemon.endpoint();
      return startLink(endpoint);
    },

    async qr(uri) {
      fs.mkdirSync(options.dataDir, { recursive: true });
      const qrPath = path.join(options.dataDir, "link-qr.png");
      await QRCode.toFile(qrPath, uri, { width: 512, margin: 2 });
      return qrPath;
    },

    async finish(uri) {
      try {
        return await finishLink(endpoint, uri);
      } catch {
        // not scanned yet; keep waiting, exactly as the old loop did
        return "";
      }
    },

    async stop() {
      await daemon.stop();
    },
  };
}

export interface LinkWithQrOptions {
  dataDir: string;
  signal: SignalCommand;
  host?: string;
  port?: number;
  account?: string;
  print: Print;
  open?: (qrPath: string) => void;
  attempts?: number;
  intervalMs?: number;
  logger?: Logger;
}

/** The script's flow over the shared phases; returns the linked number. */
export async function linkWithQr(options: LinkWithQrOptions): Promise<string> {
  const link = signalLinker(options);
  const progress = await driveLink(link, {
    print: options.print,
    ...(options.open ? { open: options.open } : {}),
    ...(options.attempts !== undefined ? { attempts: options.attempts } : {}),
    ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
  });
  return progress.number;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const number = await linkWithQr({
    dataDir: dataDir(),
    signal: {
      cliPath: config.signal.cliPath,
      command: config.signal.command ?? [config.signal.cliPath],
    },
    host: config.signal.daemonHost,
    port: config.signal.daemonPort,
    ...(config.signal.account ? { account: config.signal.account } : {}),
    print: (line) => process.stdout.write(`${line}\n`),
    open: openFile,
  });
  process.stdout.write(`Linked as ${number}. Set signal.account in config.toml.\n`);
}

/**
 * `npm run link` runs this file; the setup step imports it for `signalLinker`.
 * The guard keeps the import from starting a second daemon.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const left = path.resolve(entry);
  const right = path.resolve(fileURLToPath(import.meta.url));
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

if (invokedDirectly()) {
  main().catch((err: unknown) => {
    process.stderr.write(`link failed: ${String(err)}\n`);
    process.exit(1);
  });
}
