/**
 * The install path, end to end: pack this package, install the tarball into a
 * temp prefix, and drive the installed CLI. It proves what unit tests cannot —
 * that `files`/`bin` carry everything the commands need and that the installed
 * entry behaves like the checkout.
 *
 * Network is needed once for the package's own dependencies; the test uses a
 * temp directory and never touches the real data directory or plugin folder.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sc-install-"));
const prefix = path.join(workspace, "app");
const home = path.join(workspace, "home");
const appData = path.join(workspace, "appdata");
fs.mkdirSync(home, { recursive: true });

/** The installed package's entry point and version, once. */
let installed: { entry: string; version: string } | undefined;

function env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    npm_config_update_notifier: "false",
  };
}

function install(): { entry: string; version: string } {
  if (installed) return installed;
  const packDir = path.join(workspace, "pack");
  fs.mkdirSync(packDir, { recursive: true });
  execFileSync(npm, ["pack", "--silent", "--pack-destination", packDir], {
    cwd: root,
    env: env(),
    stdio: "pipe",
    timeout: 120_000,
    shell: process.platform === "win32",
  });
  const tarball = fs
    .readdirSync(packDir)
    .find((name) => name.endsWith(".tgz"));
  if (!tarball) throw new Error("npm pack produced no tarball");
  execFileSync(npm, ["install", "--prefix", prefix, path.join(packDir, tarball)], {
    cwd: workspace,
    env: env(),
    stdio: "pipe",
    timeout: 180_000,
    shell: process.platform === "win32",
  });
  const entry = path.join(prefix, "node_modules", "signal-connector", "dist", "index.js");
  if (!fs.existsSync(entry)) throw new Error(`installed entry is missing: ${entry}`);
  const version = (
    JSON.parse(
      fs.readFileSync(path.join(prefix, "node_modules", "signal-connector", "package.json"), "utf8"),
    ) as { version: string }
  ).version;
  installed = { entry, version };
  return installed;
}

function cli(args: string[]): { code: number; output: string } {
  const { entry } = install();
  const result = spawnSync(process.execPath, [entry, ...args], {
    env: env(),
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("installed package", { timeout: 300_000 }, () => {
  it("answers --version with the manifest version", () => {
    const { version } = install();
    const result = cli(["--version"]);
    expect(result.code).toBe(0);
    expect(result.output.trim()).toBe(version);
  });

  it("doctor reports the missing config without creating one", () => {
    const result = cli(["doctor"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("config");
    // The diagnostic is read-only: no data directory is created in the temp home.
    expect(fs.existsSync(appData)).toBe(false);
  });

  it("plugin status is absent, install writes the packaged file, a second install is a no-op", () => {
    const before = cli(["plugin", "status"]);
    expect(before.code).toBe(1);
    expect(before.output).toContain("absent");

    const first = cli(["plugin", "install"]);
    expect(first.code).toBe(0);
    const target = path.join(home, ".config", "opencode", "plugins", "signal-connector.ts");
    expect(fs.existsSync(target)).toBe(true);

    const mtime = fs.statSync(target).mtimeMs;
    const second = cli(["plugin", "install"]);
    expect(second.code).toBe(0);
    expect(second.output).toContain("already installed");
    expect(fs.statSync(target).mtimeMs).toBe(mtime);
  });

  it("setup --help is rejected and starts nothing", () => {
    const result = cli(["setup", "--help"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("unrecognised arguments");
  });
});
