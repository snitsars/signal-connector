import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Builds dist when it is missing or older than the sources this test covers. */
function builtEntry(): string {
  const dist = path.join(root, "dist", "index.js");
  const sources = [
    "src/index.ts",
    "src/daemon.ts",
    "src/cli/setup.ts",
    "src/cli/steps.ts",
    "src/cli/signalCliInstall.ts",
    "src/cli/plugin.ts",
    "src/config/config.ts",
    "src/store/sqliteDriver.ts",
  ].map((file) => path.join(root, file));
  const stale =
    !fs.existsSync(dist) ||
    sources.some((source) => fs.statSync(source).mtimeMs > fs.statSync(dist).mtimeMs);
  if (stale) {
    execFileSync(
      process.execPath,
      [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"],
      { cwd: root, stdio: "pipe" },
    );
  }
  return dist;
}

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [builtEntry(), ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("src/index.ts", () => {
  it("has no static import of the daemon, store, adapters, core or config", () => {
    const source = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const statics = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)";$/gm)].map(
      (match) => match[1] ?? "",
    );

    // The whole static graph: only the parser, the setup contract and the
    // plugin helpers may load before the mode is known, so doctor and the
    // plugin commands work below the Node floor.
    expect(statics.sort()).toEqual([
      "./cli/args.js",
      "./cli/plugin.js",
      "./cli/setup.js",
      "node:fs",
      "node:os",
    ]);
    expect(source).toContain('import("./daemon.js")');
  });

  it("runs doctor and --version from the built CLI", () => {
    const doctor = run(["doctor"]);
    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain("node-version");
    expect(doctor.stdout).toContain("ok");
    expect(doctor.stdout).not.toContain("fatal");

    const version = run(["--version"]);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
