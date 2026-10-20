/**
 * Argument handling for the `signal-connector` command. Pure and dependency-free
 * so it can be tested without starting the daemon (see args.test.ts). The
 * composition root (`src/index.ts`) turns the mode into behaviour.
 */

export type CliMode =
  | "daemon"
  | "doctor"
  | "setup"
  | "plugin-install"
  | "plugin-status"
  | "version"
  | "help"
  | "usage";

export const USAGE = [
  "signal-connector — bridge a Signal chat to a local opencode coding agent",
  "",
  "Usage:",
  "  signal-connector                 start the daemon (default)",
  "  signal-connector doctor          report whether this machine is ready (read-only)",
  "  signal-connector setup           prepare this machine, skipping what is already ready",
  "  signal-connector plugin install  copy the opencode plugin into ~/.config/opencode/plugins",
  "  signal-connector plugin status   report the installed plugin: installed, stale, absent, conflict",
  "  signal-connector -v, --version   print the package version and exit",
  "  signal-connector -h, --help      print this help and exit",
  "",
  "Configuration lives in config.toml inside the SignalConnector data directory",
  "(%APPDATA%\\SignalConnector on Windows, ~/.config/SignalConnector elsewhere).",
  "Run setup to install what is missing, link a Signal device and write config.toml",
  "with one project named after the current directory; an existing config is kept.",
].join("\n");

/**
 * Only the first argument is significant: running the daemon takes no options,
 * and a stray argument is a mistake worth reporting rather than ignoring.
 */
export function parseArgs(argv: readonly string[]): CliMode {
  const [first] = argv;
  if (first === undefined) return "daemon";
  // These modes take no options: `setup --help` must not install anything.
  if (first === "doctor") return argv.length === 1 ? "doctor" : "usage";
  if (first === "setup") return argv.length === 1 ? "setup" : "usage";
  // A two-word command: `plugin install` or `plugin status`, and nothing after.
  if (first === "plugin") {
    if (argv.length !== 2) return "usage";
    if (argv[1] === "install") return "plugin-install";
    if (argv[1] === "status") return "plugin-status";
    return "usage";
  }
  if (first === "--version" || first === "-v") return "version";
  if (first === "--help" || first === "-h") return "help";
  return "usage";
}
