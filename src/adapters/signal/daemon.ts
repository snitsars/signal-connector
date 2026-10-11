/**
 * Manages the local signal-cli JSON-RPC daemon (ticket 2.1).
 * Spawns `signal-cli daemon --http host:port`, checks reachability, and
 * restarts on unexpected exit.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { Logger } from "../../logging/logger.js";
import { resolveCommand } from "../spawnCommand.js";

export interface DaemonOptions {
  /**
   * Base argv to invoke signal-cli. Either `["signal-cli"]`, or a java
   * wildcard-classpath form:
   * ["java", "--enable-native-access=ALL-UNNAMED", "-cp", "<dir>\\lib\\*", "org.asamk.signal.Main"].
   * The latter avoids the Windows command-line length limit that breaks
   * signal-cli.bat when the install path is long.
   */
  command: string[];
  host: string;
  port: number;
  account?: string;
  logger: Logger;
  /** Delay before an automatic restart, ms. */
  restartDelayMs?: number;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Pure: the full argv passed to signal-cli for daemon mode. */
export function buildDaemonArgv(
  command: string[],
  opts: { host: string; port: number; account?: string },
): string[] {
  const argv = [...command];
  if (opts.account) argv.push("-a", opts.account);
  argv.push("daemon", "--http", `${opts.host}:${opts.port}`);
  return argv;
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
    const argv = buildDaemonArgv(this.opts.command, this.opts);
    const bin = argv[0];
    if (!bin) throw new Error("signal.command is empty");
    this.opts.logger.info("starting signal-cli daemon", { command: argv.join(" ") });
    const resolved = resolveCommand(bin, argv.slice(1));
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
