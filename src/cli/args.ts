/**
 * Argument handling for the `signal-connector` command. Pure and dependency-free
 * so it can be tested without starting the daemon (see args.test.ts). The
 * composition root (`src/index.ts`) turns the mode into behaviour.
 */

export type CliMode = "daemon" | "version" | "help" | "usage";

export const USAGE = [
  "signal-connector — bridge a Signal chat to a local opencode coding agent",
  "",
  "Usage:",
  "  signal-connector                 start the daemon (default)",
  "  signal-connector -v, --version   print the package version and exit",
  "  signal-connector -h, --help      print this help and exit",
  "",
  "Configuration lives in config.toml inside the SignalConnector data directory",
  "(%APPDATA%\\SignalConnector on Windows, ~/.config/SignalConnector elsewhere).",
  "Link a Signal device, then set signal.account and at least one project before",
  "starting.",
].join("\n");

/**
 * Only the first argument is significant: running the daemon takes no options,
 * and a stray argument is a mistake worth reporting rather than ignoring.
 */
export function parseArgs(argv: readonly string[]): CliMode {
  const [first] = argv;
  if (first === undefined) return "daemon";
  if (first === "--version" || first === "-v") return "version";
  if (first === "--help" || first === "-h") return "help";
  return "usage";
}
