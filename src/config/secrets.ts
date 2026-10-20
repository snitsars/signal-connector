/**
 * Secrets (spine AD-9). Secrets never touch the repo or a log line.
 *
 * Windows keeps the existing DPAPI files under <data>/secrets/*.dat. Every
 * other platform prefers the OS keystore (`security` on macOS, `secret-tool`
 * on Linux) and falls back to a user-only JSON file, so a value survives a
 * restart even on a headless box with no keyring. The file is plaintext at
 * rest: the directory is 0700 and the file 0600.
 *
 * The interface is unchanged, and every durable store is injectable, so tests
 * need neither a keychain nor a linked account.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** What `defaultSecretStore` will use for a given directory and platform. */
export type SecretStoreKind = "dpapi" | "keyring" | "file";

export class InMemorySecretStore implements SecretStore {
  private readonly map = new Map<string, string>();
  async get(key: string): Promise<string | undefined> {
    return this.map.get(key);
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

function runPowerShell(script: string, input: string): string {
  const result = spawnSync(
    powershell(),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { input, encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(`secret store failure: ${result.stderr || result.status}`);
  }
  return (result.stdout || "").trim();
}

/**
 * Prefer PowerShell 7. Windows PowerShell 5.1 can fail to autoload its Security
 * module when spawned from a service or a test runner ("ConvertTo-SecureString
 * ... could not be loaded"), and that breaks every secret. `pwsh` ships the
 * module in-box; the probe runs once and the result is cached.
 */
let shell: string | undefined;
function powershell(): string {
  if (shell) return shell;
  const probe = spawnSync(
    "pwsh.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"],
    { encoding: "utf8", windowsHide: true },
  );
  shell = probe.status === 0 ? "pwsh.exe" : "powershell.exe";
  return shell;
}

const PROTECT =
  "$p=[Console]::In.ReadToEnd();" +
  "$s=ConvertTo-SecureString -String $p -AsPlainText -Force;" +
  "ConvertFrom-SecureString -SecureString $s";
const UNPROTECT =
  "$c=[Console]::In.ReadToEnd();" +
  "$s=ConvertTo-SecureString -String $c;" +
  "$b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);" +
  "[Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)";

/**
 * Stores DPAPI-protected values in files under <data>/secrets. Protection is
 * bound to the current Windows user; the files are useless elsewhere.
 */
export class DpapiSecretStore implements SecretStore {
  constructor(private readonly dir: string) {
    fs.mkdirSync(this.dir, { recursive: true });
  }
  private fileFor(key: string): string {
    const safe = key.replace(/[^a-zA-Z0-9._-]/g, "_");
    return path.join(this.dir, `${safe}.dat`);
  }
  async get(key: string): Promise<string | undefined> {
    const file = this.fileFor(key);
    if (!fs.existsSync(file)) return undefined;
    const protectedValue = fs.readFileSync(file, "utf8");
    return runPowerShell(UNPROTECT, protectedValue);
  }
  async set(key: string, value: string): Promise<void> {
    const protectedValue = runPowerShell(PROTECT, value);
    fs.writeFileSync(this.fileFor(key), protectedValue, { encoding: "utf8", mode: 0o600 });
  }
  async delete(key: string): Promise<void> {
    const file = this.fileFor(key);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

/** The directory the durable stores live in, under the data directory. */
export function secretsDirectory(dir: string): string {
  return path.join(dir, "secrets");
}

/** The plaintext fallback file inside the secrets directory. */
export function fileSecretPath(dir: string): string {
  return path.join(dir, "secrets.json");
}

/** The file-system reason without ever touching file contents. */
function fileError(action: string, file: string, err: unknown): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return new Error(
    `secret store failure: cannot ${action} ${file}${code ? ` (${code})` : ""}`,
  );
}

function emptyStore(): Record<string, string> {
  // No prototype, so a key such as `__proto__` is stored as ordinary data.
  return Object.create(null) as Record<string, string>;
}

function parseStore(file: string, text: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    // Deliberately not the parser's message: newer V8 versions quote a snippet
    // of the input, which may be a secret. The path and the reason are enough.
    throw new Error(`secret store ${file} is corrupt: not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`secret store ${file} is corrupt: expected a JSON object`);
  }
  const map = emptyStore();
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error(`secret store ${file} is corrupt: every value must be a string`);
    }
    map[key] = value;
  }
  return map;
}

/** Atomic replace: a crash never leaves a half-written JSON that breaks reads. */
function writeAtomic(file: string, data: string): void {
  const dir = path.dirname(file);
  const temp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, data, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (process.platform !== "win32") fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
  } catch (err: unknown) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // The original failure is the one worth reporting.
      }
    }
    try {
      fs.unlinkSync(temp);
    } catch {
      // The temp file may not exist; never mask the original failure.
    }
    throw fileError("write", file, err);
  }
}

/**
 * Plaintext JSON fallback. The first `set` creates the directory 0700 and the
 * file 0600; every write goes through a same-directory temp file and a rename.
 */
export class FileSecretStore implements SecretStore {
  private readonly file: string;

  constructor(private readonly dir: string) {
    this.file = fileSecretPath(dir);
  }

  private ensureDir(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      // mkdir's mode is masked by the umask, and an existing directory keeps
      // whatever mode it had. Secret material demands the exact mode.
      if (
        process.platform !== "win32" &&
        (fs.statSync(this.dir).mode & 0o777) !== 0o700
      ) {
        fs.chmodSync(this.dir, 0o700);
      }
    } catch (err: unknown) {
      throw fileError("create", this.dir, err);
    }
  }

  private readAll(): Record<string, string> {
    let text: string;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
      throw fileError("read", this.file, err);
    }
    return parseStore(this.file, text);
  }

  async get(key: string): Promise<string | undefined> {
    return this.readAll()[key];
  }

  async set(key: string, value: string): Promise<void> {
    this.ensureDir();
    const map = this.readAll();
    map[key] = value;
    writeAtomic(this.file, `${JSON.stringify(map, null, 2)}\n`);
  }

  async delete(key: string): Promise<void> {
    const map = this.readAll();
    if (!(key in map)) return;
    delete map[key];
    writeAtomic(this.file, `${JSON.stringify(map, null, 2)}\n`);
  }
}

/** The two keystore helpers this module knows how to drive. */
export type KeyringTool = "security" | "secret-tool";

export interface KeyringCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: { code?: string };
}

/**
 * Stubbable keystore runner. The argv includes the executable as argv[0];
 * `input` is written to stdin. Tests never touch the real keychain.
 */
export type KeyringRunner = (argv: readonly string[], input: string) => KeyringCommandResult;

function runKeyringCommand(argv: readonly string[], input: string): KeyringCommandResult {
  const [command, ...args] = argv;
  if (command === undefined) {
    return {
      status: null,
      stdout: "",
      stderr: "",
      error: { code: "ENOENT" },
    };
  }
  const result = spawnSync(command, args, {
    input,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: { ...(code ? { code } : {}) } } : {}),
  };
}

export interface KeyringSecretStoreOptions {
  tool: KeyringTool;
  /** Keychain service / Secret Service attribute owner. */
  service?: string;
  /** Injectable runner, so tests never touch a real keychain. */
  run?: KeyringRunner;
  /** Used when the tool is absent or a command fails at runtime. */
  fallback?: SecretStore;
}

const DEFAULT_KEYRING_SERVICE = "signal-connector";

/**
 * Drives the platform keystore. A value reaches `security` as an argument and
 * `secret-tool` on stdin; neither command echoes it and no error here includes
 * a value or the argv that carried one.
 */
export class KeyringSecretStore implements SecretStore {
  private readonly tool: KeyringTool;
  private readonly service: string;
  private readonly run: KeyringRunner;
  private readonly fallback: SecretStore | undefined;

  constructor(options: KeyringSecretStoreOptions) {
    this.tool = options.tool;
    this.service = options.service ?? DEFAULT_KEYRING_SERVICE;
    this.run = options.run ?? runKeyringCommand;
    this.fallback = options.fallback;
  }

  private getArgv(key: string): string[] {
    if (this.tool === "security") {
      return [
        "security",
        "find-generic-password",
        "-s",
        this.service,
        "-a",
        key,
        "-w",
      ];
    }
    return ["secret-tool", "lookup", "service", this.service, "key", key];
  }

  private setArgv(key: string, value: string): { argv: string[]; input: string } {
    if (this.tool === "security") {
      return {
        argv: [
          "security",
          "add-generic-password",
          "-U",
          "-s",
          this.service,
          "-a",
          key,
          "-w",
          value,
        ],
        input: "",
      };
    }
    return {
      argv: [
        "secret-tool",
        "store",
        "--label",
        `${this.service}:${key}`,
        "service",
        this.service,
        "key",
        key,
      ],
      input: value,
    };
  }

  private deleteArgv(key: string): string[] {
    if (this.tool === "security") {
      return ["security", "delete-generic-password", "-s", this.service, "-a", key];
    }
    return ["secret-tool", "clear", "service", this.service, "key", key];
  }

  /** `security` reports a missing item as exit 44; `secret-tool` as a quiet 1. */
  private isNotFound(result: KeyringCommandResult): boolean {
    if (this.tool === "security") {
      return result.status === 44 || /could not be found/i.test(result.stderr);
    }
    return result.status !== 0 && result.stderr.trim() === "";
  }

  /**
   * A runner that throws is a command failure too: report it as a failed
   * result so the file fallback still gets its chance.
   */
  private invoke(argv: readonly string[], input: string): KeyringCommandResult {
    try {
      return this.run(argv, input);
    } catch {
      return { status: null, stdout: "", stderr: "" };
    }
  }

  private failure(action: string, result: KeyringCommandResult): Error {
    if (result.error?.code === "ENOENT") {
      return new Error(`keyring ${action} failure: ${this.tool} is not available`);
    }
    return new Error(
      `keyring ${action} failure: ${this.tool} exited with code ${
        result.status ?? "unknown"
      }`,
    );
  }

  async get(key: string): Promise<string | undefined> {
    const result = this.invoke(this.getArgv(key), "");
    if (result.status === 0) {
      const value = result.stdout;
      // `security -w` and `secret-tool lookup` append one newline; a value's
      // own leading or trailing spaces are data and must survive.
      if (value.endsWith("\r\n")) return value.slice(0, -2);
      if (value.endsWith("\n")) return value.slice(0, -1);
      return value;
    }
    if (!this.isNotFound(result) && !this.fallback) {
      throw this.failure("read", result);
    }
    return this.fallback?.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    const { argv, input } = this.setArgv(key, value);
    const result = this.invoke(argv, input);
    if (result.status === 0) return;
    if (this.fallback) return this.fallback.set(key, value);
    throw this.failure("write", result);
  }

  async delete(key: string): Promise<void> {
    const result = this.invoke(this.deleteArgv(key), "");
    if (!this.isNotFound(result) && result.status !== 0 && !this.fallback) {
      throw this.failure("delete", result);
    }
    // Remove the fallback copy too, so a value cannot come back from a stale
    // file after it was deleted from the keyring.
    await this.fallback?.delete(key);
  }
}

/** Looks for an executable on PATH; no shell and no execution. */
function commandExists(command: string, platform: NodeJS.Platform): boolean {
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  const names =
    platform === "win32"
      ? [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`]
      : [command];
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir.length === 0) continue;
    for (const name of names) {
      try {
        fs.accessSync(path.join(dir, name), fs.constants.X_OK);
        return true;
      } catch {
        // Keep looking: the next PATH entry may hold the tool.
      }
    }
  }
  return false;
}

export interface SecretStoreOptions {
  /** Injectable platform; defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Injectable tool lookup; defaults to a PATH scan. */
  hasCommand?: (command: string) => boolean;
  /** Injectable keystore runner. */
  run?: KeyringRunner;
}

interface Selection {
  kind: SecretStoreKind;
  tool?: KeyringTool;
}

function selectStore(_dir: string, options: SecretStoreOptions): Selection {
  const platform = options.platform ?? process.platform;
  // Windows keeps the existing DPAPI files exactly as they are.
  if (platform === "win32") return { kind: "dpapi" };

  const tool: KeyringTool = platform === "darwin" ? "security" : "secret-tool";
  const hasCommand = options.hasCommand ?? ((command: string) => commandExists(command, platform));
  // The choice is platform and tool availability; `_dir` names the store being
  // asked about (the file fallback lives there) and keeps the daemon and
  // doctor asking the same question.
  return hasCommand(tool) ? { kind: "keyring", tool } : { kind: "file" };
}

/** The kind doctor should report for the store rooted at `dir`. */
export function secretStoreKind(
  dir: string,
  options: SecretStoreOptions = {},
): SecretStoreKind {
  return selectStore(dir, options).kind;
}

/**
 * DPAPI on Windows; otherwise the platform keyring when its tool exists, with
 * the user-only file store behind it and as the choice when the tool is absent.
 */
export function defaultSecretStore(
  dir: string,
  options: SecretStoreOptions = {},
): SecretStore {
  const selection = selectStore(dir, options);
  const storeDir = secretsDirectory(dir);
  const file = new FileSecretStore(storeDir);

  switch (selection.kind) {
    case "dpapi":
      return new DpapiSecretStore(storeDir);
    case "keyring":
      return new KeyringSecretStore({
        tool: selection.tool ?? "security",
        ...(options.run ? { run: options.run } : {}),
        fallback: file,
      });
    case "file":
      return file;
  }
}
