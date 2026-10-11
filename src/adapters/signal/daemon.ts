/**
 * Manages the local signal-cli JSON-RPC daemon (ticket 2.1).
 * Spawns `signal-cli daemon --http host:port`, checks reachability, and
 * restarts on unexpected exit.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { Logger } from "../../logging/logger.js";
import { resolveCommand } from "../spawnCommand.js";

export interface DaemonOptions {
  cliPath: string;
  host: string;
  port: number;
  account?: string;
  logger: Logger;
  /** Delay before an automatic restart, ms. */
  restartDelayMs?: number;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Pure: the argv passed to signal-cli for daemon mode. */
export function buildDaemonArgs(opts: { host: string; port: number; account?: string }): string[] {
  const args: string[] = [];
  if (opts.account) args.push("-a", opts.account);
  args.push("daemon", "--http", `${opts.host}:${opts.port}`);
  return args;
}

export function rpcEndpoint(host: string, port: number): string {
  return `http://${host}:${port}/api/v1/rpc`;
}

export class SignalCliDaemon {
  private child: ChildProcess | undefined;
  private stopping = false;
  private readonly restartDelayMs: number;

  constructor(private readonly opts: DaemonOptions) {
    this.restartDelayMs = opts.restartDelayMs ?? 2000;
  }

  endpoint(): string {
    return rpcEndpoint(this.opts.host, this.opts.port);
  }

  async isReachable(): Promise<boolean> {
    try {
      await fetch(this.endpoint(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "version", params: {} }),
      });
      return true;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    this.stopping = false;
    if (await this.isReachable()) {
      this.opts.logger.info("signal-cli daemon already reachable");
      return;
    }
    const args = buildDaemonArgs(this.opts);
    this.opts.logger.info("starting signal-cli daemon", { args: args.join(" ") });
    const resolved = resolveCommand(this.opts.cliPath, args);
    this.child = spawn(resolved.command, resolved.args, {
      shell: resolved.shell,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child.stderr?.on("data", (d: Buffer) => {
      this.opts.logger.debug("signal-cli", { line: d.toString().trim() });
    });
    this.child.on("exit", (code) => {
      if (this.stopping) return;
      this.opts.logger.warn("signal-cli daemon exited; restarting", { code });
      void delay(this.restartDelayMs).then(() => this.start());
    });

    for (let i = 0; i < 20; i++) {
      if (await this.isReachable()) {
        this.opts.logger.info("signal-cli daemon is up");
        return;
      }
      await delay(500);
    }
    this.opts.logger.warn("signal-cli daemon did not become reachable in time");
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.child?.kill();
  }
}
