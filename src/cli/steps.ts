/**
 * The product prerequisites, one step each. Every check is read-only: it probes
 * the machine and returns `ok | missing | failed` plus the exact fix, so
 * `doctor` can describe a machine and the daemon can refuse to boot on the same
 * lines. Only an `apply` writes, and only `setup` calls one — today the
 * signal-cli download and the opencode plugin copy.
 *
 * Command steps take their runner as an argument, so tests can prove the
 * classification and the guidance without Java, signal-cli or opencode.
 */
import { oneLine } from "../oneLine.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveCommand } from "../adapters/spawnCommand.js";
import {
  fileSecretPath,
  secretsDirectory,
  secretStoreKind,
  type SecretStoreKind,
} from "../config/secrets.js";
import {
  installSignalCli,
  installedCopies,
  type ExtractArchive,
  type FetchLike,
  type InstalledSignalCli,
} from "./signalCliInstall.js";
import type { ConfigRead, SetupStep, StepContext, StepReport } from "./setup.js";

/** A command check may take this long before it is reported as failed. */
export const COMMAND_TIMEOUT_MS = 5_000;

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: { code?: string; message: string };
}

/** Stubbable command runner: the argv includes the executable as argv[0]. */
export type RunCommand = (argv: readonly string[]) => CommandResult;

function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

/**
 * The production runner. `resolveCommand` keeps Windows `.cmd`/`.bat` shims
 * (opencode, signal-cli.bat) working; the timeout bounds a probe that hangs.
 */
export function defaultRunCommand(
  argv: readonly string[],
  timeoutMs: number = COMMAND_TIMEOUT_MS,
): CommandResult {
  const [executable, ...args] = argv;
  if (executable === undefined || executable.length === 0) {
    return {
      status: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      error: { code: "ENOENT", message: "empty command" },
    };
  }

  try {
    const resolved = resolveCommand(executable, args);
    const result = spawnSync(resolved.command, resolved.args, {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      shell: resolved.shell,
    });
    const error = result.error;
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      timedOut: code === "ETIMEDOUT",
      ...(error
        ? { error: { ...(code ? { code } : {}), message: error.message } }
        : {}),
    };
  } catch (err: unknown) {
    return {
      status: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      error: { message: err instanceof Error ? err.message : String(err) },
    };
  }
}

type Inspection =
  | { status: "ok"; output: string }
  | { status: "missing"; reason: string }
  | { status: "failed"; reason: string };

const MISSING_TEXT =
  /not recognized as an internal or external command|is not recognized|command not found|no such file or directory|cannot find the file|cannot find the path specified|could not find|classnotfoundexception/i;

/** Classifies a probe without leaking a stack: one line, always. */
function inspect(label: string, result: CommandResult): Inspection {
  if (result.timedOut) {
    return {
      status: "failed",
      reason: `${label} timed out after ${COMMAND_TIMEOUT_MS / 1000}s`,
    };
  }
  if (result.error?.code === "ENOENT") {
    return { status: "missing", reason: `${label} was not found` };
  }
  if (result.status === 0) {
    const output = firstLine(result.stdout) || firstLine(result.stderr);
    return { status: "ok", output: output || `${label} is available` };
  }

  const text = oneLine([result.stderr, result.stdout].filter(Boolean).join(" "));
  if (MISSING_TEXT.test(text)) {
    return { status: "missing", reason: `${label} was not found` };
  }
  return {
    status: "failed",
    reason:
      text.length > 0 ? text : `${label} exited with code ${result.status ?? "unknown"}`,
  };
}

function commandReport(label: string, fix: string, result: CommandResult): StepReport {
  const checked = inspect(label, result);
  if (checked.status === "ok") {
    return { status: "ok", reason: checked.output };
  }
  return { status: checked.status, reason: checked.reason, fix };
}

const JAVA_FIX =
  'run "pwsh scripts/ensure-java.ps1" (or install a JDK 25 from https://adoptium.net)';
const SIGNAL_CLI_FIX =
  'run "node dist/index.js setup" (needs Java 17 or newer; recent releases need the configured ' +
  'JDK) or "pwsh scripts/install-signal-cli.ps1", then set signal.command in config.toml';
const OPENCODE_FIX =
  'install opencode with "npm install -g opencode-ai" (see https://opencode.ai/docs)';
const SECRETS_FIX = "install PowerShell 7 from https://aka.ms/powershell";

/**
 * The configured signal command usually starts with `java.exe` (the wildcard
 * classpath form setup.ps1 writes); otherwise Java must be on PATH.
 */
function javaExecutable(config: StepContext["config"]): string {
  const configured = config?.signal.command?.[0];
  if (configured && /^java(w)?(\.exe)?$/i.test(path.basename(configured))) {
    return configured;
  }
  return "java";
}

/**
 * Every place the check looks for signal-cli, most specific first: the
 * configured full command, then `signal.cliPath`, then PATH. Duplicate argv are
 * dropped so a config that names `signal-cli` probes it once.
 */
function signalCliCandidates(config: StepContext["config"]): string[][] {
  const candidates: string[][] = [];
  const seen = new Set<string>();
  const add = (argv: string[]): void => {
    const key = JSON.stringify(argv);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(argv);
  };

  const command = config?.signal.command;
  if (command && command.length > 0) add([...command, "--version"]);
  if (config?.signal.cliPath) add([config.signal.cliPath, "--version"]);
  add(["signal-cli", "--version"]);
  return candidates;
}

/** A step whose check completes synchronously; the factory's tests rely on it. */
export type SyncSetupStep = SetupStep & {
  check(ctx: StepContext): StepReport;
};

export function javaStep(run: RunCommand = defaultRunCommand): SyncSetupStep {
  return {
    id: "java",
    title: "Java (for signal-cli)",
    check: (ctx) =>
      commandReport("java", JAVA_FIX, run([javaExecutable(ctx.config), "-version"])),
  };
}

export interface SignalCliEnv {
  /** Injectable so the step's apply never reaches the network in a test. */
  fetch?: FetchLike;
  /** Injectable so the step's apply never shells out to `tar` in a test. */
  extract?: ExtractArchive;
  /** Injectable so both launcher conventions are testable on any machine. */
  platform?: NodeJS.Platform;
}

/**
 * The probe for an installed copy. On Windows the release's `.bat` rebuilds a
 * classpath longer than cmd's ~8 KB line limit once the install path is deep,
 * so the copy is started the way the generated config starts it: java with the
 * wildcard classpath. Elsewhere the shipped launcher works as-is.
 */
function installedCopyArgv(
  copy: InstalledSignalCli,
  config: StepContext["config"],
  platform: NodeJS.Platform,
): string[] {
  if (platform === "win32") {
    return [
      javaExecutable(config),
      "-cp",
      path.join(copy.home, "lib", "*"),
      "org.asamk.signal.Main",
      "--version",
    ];
  }
  return [copy.path, "--version"];
}

export function signalCliStep(
  run: RunCommand = defaultRunCommand,
  env: SignalCliEnv = {},
): SyncSetupStep {
  const platform = env.platform ?? process.platform;
  return {
    id: "signal-cli",
    title: "signal-cli",
    check: (ctx) => {
      // A configured command/path or a PATH copy comes first. A failed probe is
      // reported as failed rather than silently replaced by another copy.
      for (const argv of signalCliCandidates(ctx.config)) {
        const checked = inspect("signal-cli", run(argv));
        if (checked.status === "ok") return { status: "ok", reason: checked.output };
        if (checked.status === "failed") {
          return { status: "failed", reason: checked.reason, fix: SIGNAL_CLI_FIX };
        }
      }

      // What the step's own apply installs: a version directory under the data
      // directory. Scanning it is also what proves the download landed.
      for (const copy of installedCopies(ctx.dataDir, platform)) {
        const checked = inspect(
          "signal-cli",
          run(installedCopyArgv(copy, ctx.config, platform)),
        );
        if (checked.status === "ok") {
          return { status: "ok", reason: `signal-cli ${copy.version} at ${copy.path}` };
        }
        if (checked.status === "failed") {
          return { status: "failed", reason: checked.reason, fix: SIGNAL_CLI_FIX };
        }
      }

      return {
        status: "missing",
        reason: `signal-cli was not found in the config, on PATH, or under ${path.join(ctx.dataDir, "signal-cli")}`,
        fix: SIGNAL_CLI_FIX,
      };
    },
    apply: async (ctx) => {
      // Named before the download: a machine without Java cannot run what the
      // step fetches, and the java step's fix is the right next move.
      ctx.print(
        "signal-cli needs Java 17 or newer (recent releases need the configured JDK; the java step checks it)",
      );
      const result = await installSignalCli({
        dataDir: ctx.dataDir,
        print: ctx.print,
        ...(env.fetch ? { fetch: env.fetch } : {}),
        ...(env.extract ? { extract: env.extract } : {}),
      });
      if (!result.downloaded) {
        ctx.print(`signal-cli ${result.version} is already installed at ${result.path}`);
      }
    },
  };
}

export function opencodeStep(run: RunCommand = defaultRunCommand): SyncSetupStep {
  return {
    id: "opencode",
    title: "opencode",
    check: (ctx) =>
      commandReport(
        "opencode",
        OPENCODE_FIX,
        run([ctx.config?.agent.opencodePath || "opencode", "--version"]),
      ),
  };
}

export interface SecretsEnv {
  /** Injectable so every platform branch is testable everywhere. */
  platform?: NodeJS.Platform;
  /** Injectable tool lookup; defaults to a PATH scan. */
  hasCommand?: (command: string) => boolean;
  /** Injectable selection, so a test can name a kind without a keychain. */
  storeKind?: (dir: string) => SecretStoreKind;
}

function nonWindowsSecretReason(
  kind: SecretStoreKind,
  platform: NodeJS.Platform,
  dataDir: string,
): string {
  if (kind === "keyring") {
    return platform === "darwin"
      ? "macOS Keychain (security) holds secrets"
      : "Secret Service (secret-tool) holds secrets";
  }
  const file = fileSecretPath(secretsDirectory(dataDir));
  return `file store at ${file} (plaintext at rest, user-only permissions)`;
}

export function secretsStep(
  run: RunCommand = defaultRunCommand,
  env: SecretsEnv = {},
): SyncSetupStep {
  const platform = env.platform ?? process.platform;
  return {
    id: "secrets",
    title: "secret store",
    check: (ctx) => {
      if (platform !== "win32") {
        const kind =
          env.storeKind?.(ctx.dataDir) ??
          secretStoreKind(ctx.dataDir, {
            platform,
            ...(env.hasCommand ? { hasCommand: env.hasCommand } : {}),
          });
        return { status: "ok", reason: nonWindowsSecretReason(kind, platform, ctx.dataDir) };
      }
      // Windows still needs a PowerShell for DPAPI. The store prefers
      // PowerShell 7 but falls back to Windows PowerShell; either can protect
      // a secret, so neither alone is required.
      let lastReason = "no PowerShell could be started";
      for (const exe of ["pwsh.exe", "powershell.exe"]) {
        const checked = inspect(
          exe,
          run([exe, "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"]),
        );
        if (checked.status === "ok") {
          return {
            status: "ok",
            reason: `${exe} ${checked.output} is available for the DPAPI secret store`,
          };
        }
        lastReason = checked.reason;
      }
      // The secret store needs one of them even when every other tool is fine.
      return { status: "failed", reason: lastReason, fix: SECRETS_FIX };
    },
  };
}

export interface DataDirEnv {
  /** Returns undefined for a missing path; other errors are reported as failed. */
  stat?: (target: string) => fs.Stats | undefined;
  writable?: (target: string) => boolean;
  /** Creates the directory; tests inject a recorder instead of touching disk. */
  mkdir?: (target: string) => void;
}

function statOf(target: string, env: DataDirEnv): fs.Stats | undefined {
  if (env.stat) return env.stat(target);
  try {
    return fs.statSync(target);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

function writable(target: string, env: DataDirEnv): boolean {
  if (env.writable) return env.writable(target);
  try {
    fs.accessSync(target, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const DATA_DIR_FIX = 'create the directory by hand or run "node dist/index.js setup"';

/**
 * Read-only: an absent directory is `missing` when its nearest existing
 * ancestor is writable, and `failed` when permissions make the fix impossible.
 */
export function dataDirStep(env: DataDirEnv = {}): SyncSetupStep {
  return {
    id: "data-directory",
    title: "data directory",
    check: (ctx) => {
      const dir = ctx.dataDir;
      const stat = statOf(dir, env);
      if (stat?.isDirectory()) {
        if (!writable(dir, env)) {
          return { status: "failed", reason: `${dir} exists but is not writable` };
        }
        return { status: "ok", reason: `${dir} exists and is writable` };
      }
      if (stat) {
        return { status: "failed", reason: `${dir} exists but is not a directory` };
      }

      let ancestor = path.dirname(dir);
      let ancestorStat = statOf(ancestor, env);
      while (!ancestorStat) {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
        ancestorStat = statOf(ancestor, env);
      }

      if (ancestorStat && !ancestorStat.isDirectory()) {
        return {
          status: "failed",
          reason: `cannot create ${dir}: ${ancestor} is not a directory`,
        };
      }
      if (!ancestorStat) {
        return {
          status: "failed",
          reason: `cannot create ${dir}: no existing parent directory`,
        };
      }
      if (!writable(ancestor, env)) {
        return {
          status: "failed",
          reason: `cannot create ${dir}: ${ancestor} is not writable`,
        };
      }
      return {
        status: "missing",
        reason: `${dir} does not exist`,
        fix: DATA_DIR_FIX,
      };
    },
    apply: (ctx) => {
      // The rest of setup writes here: the config, the QR image, the voice
      // temp files and the state database. Create it once, user-only.
      const make = env.mkdir ?? ((target: string) => fs.mkdirSync(target, { recursive: true, mode: 0o700 }));
      make(ctx.dataDir);
    },
  };
}

export interface ConfigStepEnv {
  /** Injectable reader; the default imports `readConfig` lazily and never writes. */
  readConfig?: (dir: string) => ConfigRead;
}

export function configStep(
  _run: RunCommand = defaultRunCommand,
  env: ConfigStepEnv = {},
): SetupStep {
  return {
    id: "config",
    title: "config.toml",
    check: async (ctx) => {
      if (ctx.config) {
        return { status: "ok", reason: "config.toml is present and valid" };
      }

      // The context is a snapshot taken before the run; a step that just wrote
      // config.toml (the device link) would otherwise leave this check telling
      // the operator to create the file it already created. Re-reading is still
      // read-only, and the snapshot is the fallback when the read itself fails.
      let read: ConfigRead;
      try {
        if (env.readConfig) {
          read = env.readConfig(ctx.dataDir);
        } else {
          // Dynamic so the doctor static graph stays free of config, toml and zod.
          const { readConfig } = await import("../config/config.js");
          read = readConfig(ctx.dataDir);
        }
      } catch (err: unknown) {
        if (!ctx.configProblem) throw err;
        read = {
          ok: false,
          absent: ctx.configProblem.absent,
          reason: ctx.configProblem.reason,
        };
      }

      if (read.ok) {
        return { status: "ok", reason: "config.toml is present and valid" };
      }
      const file = path.join(ctx.dataDir, "config.toml");
      if (read.absent) {
        return {
          status: "missing",
          reason: oneLine(read.reason),
          fix: `run "node dist/index.js setup" or create ${file}`,
        };
      }
      return {
        status: "failed",
        reason: oneLine(read.reason),
        fix: `fix the error in ${file} and run doctor again`,
      };
    },
  };
}
