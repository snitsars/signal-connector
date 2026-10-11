/**
 * Secrets (spine AD-9). Secrets never touch the repo or a log line.
 * Windows uses DPAPI (per-user) via PowerShell; other platforms/tests use memory.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

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
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { input, encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(`secret store failure: ${result.stderr || result.status}`);
  }
  return (result.stdout || "").trim();
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
 * Stores DPAPI-protected values in files under <dir>/secrets. Protection is
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

export function defaultSecretStore(dir: string): SecretStore {
  if (process.platform === "win32") {
    return new DpapiSecretStore(path.join(dir, "secrets"));
  }
  return new InMemorySecretStore();
}
