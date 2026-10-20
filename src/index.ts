#!/usr/bin/env node
/**
 * Entry point. Its static graph is deliberately tiny — the arg parser and the
 * setup contract only — so `--version`, `--help`, doctor and setup work below
 * the Node floor, where `node:sqlite` and the adapters cannot even be loaded.
 * The daemon path (config, store, secrets, adapters) is imported dynamically
 * inside its branch and nowhere else.
 */
import { readFileSync, writeSync } from "node:fs";
import { parseArgs, USAGE } from "./cli/args.js";
import { registry, runDoctor, runSetup } from "./cli/setup.js";

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

const mode = parseArgs(process.argv.slice(2));

if (mode === "version") {
  print(1, packageVersion());
  process.exit(0);
} else if (mode === "help") {
  print(1, USAGE);
  process.exit(0);
} else if (mode === "doctor" || mode === "setup") {
  // Before the daemon import: doctor must stay read-only, so no config, data
  // directory, secret store, store or daemon may be touched on this path.
  const runner = mode === "doctor" ? runDoctor : runSetup;
  runner(registry(), (line) => print(1, line))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      print(2, `fatal: ${String(err)}`);
      process.exit(1);
    });
} else if (mode === "usage") {
  print(2, `unrecognised arguments: ${process.argv.slice(2).join(" ")}\n\n${USAGE}`);
  process.exit(1);
} else {
  import("./daemon.js")
    .then(({ runDaemon }) => runDaemon())
    .catch((err: unknown) => {
      process.stderr.write(`fatal: ${String(err)}\n`);
      process.exit(1);
    });
}
