/**
 * Structured logger. Writes JSON lines to a file and human lines to console.
 * Never log secrets: redaction is the caller's job; this only shapes output.
 */
import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(opts: {
  level?: LogLevel;
  file?: string;
  console?: boolean;
}): Logger {
  const level = opts.level ?? "info";
  const toConsole = opts.console ?? true;
  let stream: fs.WriteStream | undefined;
  if (opts.file) {
    fs.mkdirSync(path.dirname(opts.file), { recursive: true });
    stream = fs.createWriteStream(opts.file, { flags: "a" });
  }

  function write(lvl: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (ORDER[lvl] < ORDER[level]) return;
    const entry = { ts: new Date().toISOString(), level: lvl, msg, ...fields };
    stream?.write(`${JSON.stringify(entry)}\n`);
    if (toConsole) {
      const suffix = fields ? ` ${JSON.stringify(fields)}` : "";
      process.stderr.write(`[${lvl}] ${msg}${suffix}\n`);
    }
  }

  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}

export function nullLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}
