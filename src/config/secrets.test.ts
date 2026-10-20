import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DpapiSecretStore,
  FileSecretStore,
  InMemorySecretStore,
  KeyringSecretStore,
  defaultSecretStore,
  fileSecretPath,
  secretsDirectory,
  secretStoreKind,
  type KeyringCommandResult,
  type KeyringRunner,
} from "./secrets.js";

const created: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-secrets-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function result(overrides: Partial<KeyringCommandResult> = {}): KeyringCommandResult {
  return { status: 0, stdout: "", stderr: "", ...overrides };
}

interface KeyringCall {
  argv: string[];
  input: string;
}

function keyring(
  outcome:
    | KeyringCommandResult
    | ((argv: readonly string[], input: string) => KeyringCommandResult) = result(),
): { run: KeyringRunner; calls: KeyringCall[] } {
  const calls: KeyringCall[] = [];
  const run: KeyringRunner = (argv, input) => {
    calls.push({ argv: [...argv], input });
    return typeof outcome === "function" ? outcome(argv, input) : outcome;
  };
  return { run, calls };
}

function modeOf(target: string): number {
  return fs.statSync(target).mode & 0o777;
}

const posixOnly = it.skipIf(process.platform === "win32");

describe("FileSecretStore", () => {
  it("survives a restart: a second instance reads what the first wrote", async () => {
    const dir = tempDir();
    await new FileSecretStore(dir).set("transcription-api-key", "hunter2");

    const reopened = new FileSecretStore(dir);

    expect(await reopened.get("transcription-api-key")).toBe("hunter2");
  });

  it("keeps a value's own whitespace and newlines exactly", async () => {
    const dir = tempDir();
    const value = "  line one\nline two  ";
    const store = new FileSecretStore(dir);

    await store.set("key", value);

    expect(await new FileSecretStore(dir).get("key")).toBe(value);
  });

  it("returns undefined for a missing key and a missing file", async () => {
    const dir = path.join(tempDir(), "not-created");
    const store = new FileSecretStore(dir);

    expect(await store.get("anything")).toBeUndefined();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("creates the directory and file on the first set, and only then", async () => {
    const dir = path.join(tempDir(), "nested", "secrets");
    const store = new FileSecretStore(dir);

    expect(fs.existsSync(dir)).toBe(false);

    await store.set("key", "value");

    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(fs.readFileSync(fileSecretPath(dir), "utf8")).toContain('"key"');
  });

  posixOnly("gives the directory 0700 and the file 0600", async () => {
    const dir = tempDir();
    await new FileSecretStore(dir).set("key", "value");

    expect(modeOf(dir)).toBe(0o700);
    expect(modeOf(fileSecretPath(dir))).toBe(0o600);
  });

  posixOnly("tightens an existing directory to 0700", async () => {
    const dir = tempDir();
    fs.chmodSync(dir, 0o755);
    expect(modeOf(dir)).toBe(0o755);

    await new FileSecretStore(dir).set("key", "value");

    expect(modeOf(dir)).toBe(0o700);
  });

  it("leaves no temp file behind after an atomic replace", async () => {
    const dir = tempDir();
    const store = new FileSecretStore(dir);
    await store.set("key", "value");
    await store.set("key", "updated");

    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(await store.get("key")).toBe("updated");
  });

  it("fails a read of invalid JSON with the path and a parse reason", async () => {
    const dir = tempDir();
    const file = fileSecretPath(dir);
    fs.writeFileSync(file, '{"token":"hunter2"', "utf8");

    const store = new FileSecretStore(dir);
    const error = await store.get("token").catch((err: unknown) => err);

    expect(String(error)).toContain(file);
    expect(String(error)).toContain("not valid JSON");
    // V8 sometimes quotes the bad input in its own parse message; ours must not.
    expect(String(error)).not.toContain("hunter2");
  });

  it("rejects a JSON store that is not an object of strings", async () => {
    const dir = tempDir();
    fs.writeFileSync(fileSecretPath(dir), "[1,2,3]", "utf8");

    const error = await new FileSecretStore(dir).get("key").catch((err: unknown) => err);

    expect(String(error)).toContain("expected a JSON object");
    expect(String(error)).toContain(fileSecretPath(dir));
  });

  it("does not overwrite a corrupt store on set", async () => {
    const dir = tempDir();
    const file = fileSecretPath(dir);
    const before = '{"token":';
    fs.writeFileSync(file, before, "utf8");

    await expect(new FileSecretStore(dir).set("key", "value")).rejects.toThrow(
      /not valid JSON/,
    );
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("deletes one key, persists the rest, and tolerates a missing key", async () => {
    const dir = tempDir();
    const store = new FileSecretStore(dir);
    await store.set("a", "1");
    await store.set("b", "2");

    await store.delete("a");
    await store.delete("missing");

    expect(await store.get("a")).toBeUndefined();
    expect(await new FileSecretStore(dir).get("b")).toBe("2");
  });
});

describe("KeyringSecretStore with security", () => {
  it("passes a value as an argument and never echoes it", async () => {
    const { run, calls } = keyring();
    const store = new KeyringSecretStore({ tool: "security", run });

    await store.set("token", "hunter2");

    expect(calls[0]?.argv).toEqual([
      "security",
      "add-generic-password",
      "-U",
      "-s",
      "signal-connector",
      "-a",
      "token",
      "-w",
      "hunter2",
    ]);
  });

  it("reads the keychain value and strips only the trailing newline", async () => {
    const { run, calls } = keyring(result({ stdout: "  hunter2  \n" }));

    const value = await new KeyringSecretStore({ tool: "security", run }).get("token");

    expect(value).toBe("  hunter2  ");
    expect(calls[0]?.argv).toEqual([
      "security",
      "find-generic-password",
      "-s",
      "signal-connector",
      "-a",
      "token",
      "-w",
    ]);
  });

  it("treats a missing item as absent and reads the fallback store", async () => {
    const fallback = new InMemorySecretStore();
    await fallback.set("token", "from-file");
    const { run } = keyring(
      result({ status: 44, stderr: "The specified item could not be found in the keychain." }),
    );

    const value = await new KeyringSecretStore({ tool: "security", run, fallback }).get(
      "token",
    );

    expect(value).toBe("from-file");
  });

  it("writes to the fallback store when the keychain command fails", async () => {
    const fallback = new InMemorySecretStore();
    const { run } = keyring(result({ status: 1, stderr: "keychain is locked" }));

    await new KeyringSecretStore({ tool: "security", run, fallback }).set("token", "hunter2");

    expect(await fallback.get("token")).toBe("hunter2");
  });

  it("throws a value-free reason when it fails without a fallback", async () => {
    const { run } = keyring(result({ status: 1, stderr: "hunter2 leaked?" }));

    const error = await new KeyringSecretStore({ tool: "security", run })
      .set("token", "hunter2")
      .catch((err: unknown) => err);

    expect(String(error)).toContain("keyring write failure");
    expect(String(error)).toContain("security");
    expect(String(error)).not.toContain("hunter2");
    expect(String(error)).not.toContain("add-generic-password");
  });

  it("deletes from both the keychain and the fallback", async () => {
    const fallback = new InMemorySecretStore();
    await fallback.set("token", "from-file");
    const { run, calls } = keyring();

    await new KeyringSecretStore({ tool: "security", run, fallback }).delete("token");

    expect(calls[0]?.argv).toEqual([
      "security",
      "delete-generic-password",
      "-s",
      "signal-connector",
      "-a",
      "token",
    ]);
    expect(await fallback.get("token")).toBeUndefined();
  });
});

describe("KeyringSecretStore with secret-tool", () => {
  it("sends the value on stdin, not in argv", async () => {
    const { run, calls } = keyring();

    await new KeyringSecretStore({ tool: "secret-tool", run }).set("token", "hunter2");

    expect(calls[0]?.input).toBe("hunter2");
    expect(calls[0]?.argv).toEqual([
      "secret-tool",
      "store",
      "--label",
      "signal-connector:token",
      "service",
      "signal-connector",
      "key",
      "token",
    ]);
    expect(calls[0]?.argv.join(" ")).not.toContain("hunter2");
  });

  it("looks the value up and strips the trailing newline", async () => {
    const { run, calls } = keyring(result({ stdout: "hunter2\n" }));

    const value = await new KeyringSecretStore({ tool: "secret-tool", run }).get("token");

    expect(value).toBe("hunter2");
    expect(calls[0]?.argv).toEqual([
      "secret-tool",
      "lookup",
      "service",
      "signal-connector",
      "key",
      "token",
    ]);
  });

  it("treats a quiet non-zero lookup as absent", async () => {
    const { run } = keyring(result({ status: 1, stderr: "" }));

    expect(await new KeyringSecretStore({ tool: "secret-tool", run }).get("token")).toBeUndefined();
  });

  it("falls back to the file store on a noisy lookup failure", async () => {
    const fallback = new InMemorySecretStore();
    await fallback.set("token", "from-file");
    const { run } = keyring(result({ status: 1, stderr: "Cannot autolaunch D-Bus" }));

    const value = await new KeyringSecretStore({ tool: "secret-tool", run, fallback }).get(
      "token",
    );

    expect(value).toBe("from-file");
  });

  it("clears the keyring item", async () => {
    const { run, calls } = keyring();

    await new KeyringSecretStore({ tool: "secret-tool", run }).delete("token");

    expect(calls[0]?.argv).toEqual([
      "secret-tool",
      "clear",
      "service",
      "signal-connector",
      "key",
      "token",
    ]);
  });
});

describe("store selection", () => {
  it("keeps DPAPI on Windows", () => {
    const dir = tempDir();

    expect(secretStoreKind(dir, { platform: "win32" })).toBe("dpapi");
    expect(defaultSecretStore(dir, { platform: "win32", hasCommand: () => false })).toBeInstanceOf(
      DpapiSecretStore,
    );
  });

  it("prefers the macOS keychain and falls back to the file store", () => {
    const dir = tempDir();

    expect(
      secretStoreKind(dir, {
        platform: "darwin",
        hasCommand: (command) => command === "security",
      }),
    ).toBe("keyring");
    expect(secretStoreKind(dir, { platform: "darwin", hasCommand: () => false })).toBe("file");
  });

  it("prefers secret-tool on Linux and falls back to the file store", () => {
    const dir = tempDir();

    expect(
      secretStoreKind(dir, {
        platform: "linux",
        hasCommand: (command) => command === "secret-tool",
      }),
    ).toBe("keyring");
    expect(secretStoreKind(dir, { platform: "linux", hasCommand: () => false })).toBe("file");
  });

  it("builds a keyring store whose fallback is the same file path", async () => {
    const dir = tempDir();
    const { run, calls } = keyring(result({ status: 1, stderr: "D-Bus is down" }));

    const store = defaultSecretStore(dir, {
      platform: "linux",
      hasCommand: (command) => command === "secret-tool",
      run,
    });
    await store.set("token", "hunter2");

    expect(store).toBeInstanceOf(KeyringSecretStore);
    expect(calls[0]?.input).toBe("hunter2");
    expect(await new FileSecretStore(secretsDirectory(dir)).get("token")).toBe("hunter2");
  });

  it("builds the persistent file store when the keyring tool is absent", async () => {
    const dir = tempDir();
    const store = defaultSecretStore(dir, { platform: "linux", hasCommand: () => false });

    expect(store).toBeInstanceOf(FileSecretStore);

    await store.set("token", "hunter2");

    expect(await new FileSecretStore(secretsDirectory(dir)).get("token")).toBe("hunter2");
    expect(fs.existsSync(fileSecretPath(secretsDirectory(dir)))).toBe(true);
  });

  it("never selects the in-memory store for a real platform", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      const store = defaultSecretStore(tempDir(), { platform, hasCommand: () => false });
      expect(store).not.toBeInstanceOf(InMemorySecretStore);
    }
  });
});
