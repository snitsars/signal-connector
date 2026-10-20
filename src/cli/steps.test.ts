import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandResult, RunCommand } from "./steps.js";
import {
  configStep,
  dataDirStep,
  defaultRunCommand,
  javaStep,
  opencodeStep,
  secretsStep,
  signalCliStep,
} from "./steps.js";
import { RELEASE_API, type ExtractArchive, type FetchLike } from "./signalCliInstall.js";
import { runSetup, type StepContext } from "./setup.js";

type Config = NonNullable<StepContext["config"]>;

function context(overrides: Partial<StepContext> = {}): StepContext {
  return { print: (): void => {}, dataDir: os.tmpdir(), ...overrides };
}

function output(overrides: Partial<CommandResult> = {}): CommandResult {
  return { status: 0, stdout: "", stderr: "", timedOut: false, ...overrides };
}

function recorder(result: CommandResult | ((argv: string[]) => CommandResult)): {
  run: RunCommand;
  calls: string[][];
} {
  const calls: string[][] = [];
  const run: RunCommand = (argv) => {
    calls.push([...argv]);
    return typeof result === "function" ? result(argv) : result;
  };
  return { calls, run };
}

const config: Config = {
  signal: {
    cliPath: "C:\\tools\\signal-cli.bat",
    command: [
      "C:\\Program Files\\Microsoft\\jdk-25\\bin\\java.exe",
      "--enable-native-access=ALL-UNNAMED",
      "-cp",
      "C:\\tools\\lib\\*",
      "org.asamk.signal.Main",
    ],
  },
  agent: { opencodePath: "C:\\tools\\opencode.cmd" },
};

describe("javaStep", () => {
  it("reports the configured JDK version as ok", () => {
    const { run, calls } = recorder(
      output({ stderr: 'openjdk version "25.0.1" 2025-10-21\nOpenJDK Runtime Environment' }),
    );

    const report = javaStep(run).check(context({ config }));

    expect(report).toMatchObject({ status: "ok" });
    expect(report.reason).toContain("25.0.1");
    expect(calls[0]).toEqual(["C:\\Program Files\\Microsoft\\jdk-25\\bin\\java.exe", "-version"]);
  });

  it("falls back to java on PATH and names the installer when it is missing", () => {
    const { run, calls } = recorder(
      output({
        status: null,
        error: { code: "ENOENT", message: "spawn java ENOENT" },
      }),
    );

    const report = javaStep(run).check(context());

    expect(report.status).toBe("missing");
    expect(report.fix).toContain("scripts/ensure-java.ps1");
    expect(calls[0]).toEqual(["java", "-version"]);
  });

  it("reports a timeout as failed with a one-line reason", () => {
    const report = javaStep(recorder(output({ status: null, timedOut: true })).run).check(
      context(),
    );

    expect(report.status).toBe("failed");
    expect(report.reason).toContain("timed out after 5s");
    expect(report.reason).not.toContain("\n");
  });

  it("reports a non-zero probe as failed with its own message", () => {
    const report = javaStep(
      recorder(output({ status: 1, stderr: "Unrecognized option: --bad\nTry again" })).run,
    ).check(context());

    expect(report.status).toBe("failed");
    expect(report.reason).toContain("Unrecognized option");
    expect(report.reason).not.toContain("\n");
  });
});

describe("signalCliStep", () => {
  function emptyDataDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "sc-signal-cli-step-"));
  }

  function missing(): CommandResult {
    return output({
      status: null,
      error: { code: "ENOENT", message: "spawn signal-cli ENOENT" },
    });
  }

  function releaseFetch(): { fetch: FetchLike; downloads: string[] } {
    const downloads: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      downloads.push(url);
      if (url === RELEASE_API) {
        return new Response(
          JSON.stringify({
            tag_name: "v0.14.9",
            assets: [
              {
                name: "signal-cli-0.14.9.tar.gz",
                browser_download_url:
                  "https://github.com/AsamK/signal-cli/releases/download/v0.14.9/signal-cli-0.14.9.tar.gz",
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(new Uint8Array([31, 139, 8, 0]), { status: 200 });
    };
    return { fetch: fetchImpl, downloads };
  }

  function fakeExtractor(version = "0.14.9"): ExtractArchive {
    return (_archive, destination) => {
      const bin = path.join(destination, `signal-cli-${version}`, "bin");
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, "signal-cli"), "#!/bin/sh\n");
    };
  }

  function launcherOf(dataDir: string, version = "0.14.9"): string {
    return path.join(dataDir, "signal-cli", `signal-cli-${version}`, "bin", "signal-cli");
  }

  it("prefers the configured full command and asks it for its version", () => {
    const { run, calls } = recorder(output({ stdout: "signal-cli 0.14.9\n" }));

    const report = signalCliStep(run).check(context({ config }));

    expect(report.status).toBe("ok");
    expect(report.reason).toContain("0.14.9");
    expect(calls[0]).toEqual([...config.signal.command!, "--version"]);
  });

  it("falls back to cliPath, then to PATH, and names the installer", () => {
    const dataDir = emptyDataDir();
    try {
      const withPath = recorder(output({ stdout: "signal-cli 0.14.9" }));
      signalCliStep(withPath.run).check(
        context({
          dataDir,
          config: {
            signal: { cliPath: "C:\\tools\\signal-cli.bat" },
            agent: { opencodePath: "opencode" },
          },
        }),
      );
      expect(withPath.calls[0]).toEqual(["C:\\tools\\signal-cli.bat", "--version"]);

      const missingStep = signalCliStep(
        recorder(output({ status: 1, stderr: "'signal-cli' is not recognized as an internal or external command" }))
          .run,
      ).check(context({ dataDir }));
      expect(missingStep.status).toBe("missing");
      expect(missingStep.fix).toContain("scripts/install-signal-cli.ps1");

      const fromPath = recorder(output({ stdout: "signal-cli 0.14.9" }));
      signalCliStep(fromPath.run).check(context({ dataDir }));
      expect(fromPath.calls[0]).toEqual(["signal-cli", "--version"]);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("finds a copy under the data directory and names the newest one", () => {
    const dataDir = emptyDataDir();
    try {
      const bin = path.dirname(launcherOf(dataDir));
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(launcherOf(dataDir), "#!/bin/sh\n");
      const launcher = launcherOf(dataDir);

      const { run, calls } = recorder((argv) =>
        argv[0] === launcher ? output({ stdout: "signal-cli 0.14.9" }) : missing(),
      );

      const report = signalCliStep(run, { platform: "linux" }).check(context({ dataDir }));

      expect(report.status).toBe("ok");
      expect(report.reason).toContain("0.14.9");
      expect(report.reason).toContain(launcher);
      expect(calls[0]).toEqual(["signal-cli", "--version"]);
      expect(calls.at(-1)).toEqual([launcher, "--version"]);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("falls through a configured command whose main class is gone to the installed copy", () => {
    const dataDir = emptyDataDir();
    try {
      fs.mkdirSync(path.dirname(launcherOf(dataDir)), { recursive: true });
      fs.writeFileSync(launcherOf(dataDir), "#!/bin/sh\n");
      const launcher = launcherOf(dataDir);

      const { run } = recorder((argv) => {
        if (argv[0] === launcher) return output({ stdout: "signal-cli 0.14.9" });
        if (argv[0] === "C:\\tools\\signal-cli.bat") {
          return output({ status: 1, stderr: "The system cannot find the path specified." });
        }
        if (argv.includes("org.asamk.signal.Main")) {
          return output({
            status: 1,
            stderr:
              "Error: Could not find or load main class org.asamk.signal.Main\nCaused by: java.lang.ClassNotFoundException",
          });
        }
        return missing();
      });

      const report = signalCliStep(run, { platform: "linux" }).check(
        context({ dataDir, config }),
      );

      expect(report.status).toBe("ok");
      expect(report.reason).toContain(launcher);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")("probes a Windows copy through java, not the .bat that exceeds cmd's line limit", () => {
    const dataDir = emptyDataDir();
    try {
      const home = path.join(dataDir, "signal-cli", "signal-cli-0.14.9");
      fs.mkdirSync(path.join(home, "bin"), { recursive: true });
      fs.mkdirSync(path.join(home, "lib"), { recursive: true });
      fs.writeFileSync(path.join(home, "bin", "signal-cli.bat"), "@echo off\n");

      const expected = [
        "C:\\Program Files\\Microsoft\\jdk-25\\bin\\java.exe",
        "-cp",
        path.join(home, "lib", "*"),
        "org.asamk.signal.Main",
        "--version",
      ];
      const { run, calls } = recorder((argv) =>
        JSON.stringify(argv) === JSON.stringify(expected)
          ? output({ stdout: "signal-cli 0.14.9" })
          : missing(),
      );

      const report = signalCliStep(run, { platform: "win32" }).check(
        context({ dataDir, config }),
      );

      expect(report.status).toBe("ok");
      expect(report.reason).toContain("0.14.9");
      expect(calls.at(-1)).toEqual(expected);
      expect(
        calls.some((argv) => argv[0] === path.join(home, "bin", "signal-cli.bat")),
      ).toBe(false);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("reports a configured copy that times out as failed instead of using another copy", () => {
    const dataDir = emptyDataDir();
    try {
      fs.mkdirSync(path.dirname(launcherOf(dataDir)), { recursive: true });
      fs.writeFileSync(launcherOf(dataDir), "#!/bin/sh\n");

      const report = signalCliStep(
        recorder(output({ status: null, timedOut: true })).run,
      ).check(context({ dataDir, config }));

      expect(report.status).toBe("failed");
      expect(report.reason).toContain("timed out after 5s");
      expect(report.reason).not.toContain("\n");
      expect(report.fix).toContain("scripts/install-signal-cli.ps1");
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("installs under the data directory and the post-check finds the launcher", async () => {
    const dataDir = emptyDataDir();
    try {
      const { fetch, downloads } = releaseFetch();
      const launcher = launcherOf(dataDir);
      const run: RunCommand = (argv) =>
        argv[0] === launcher ? output({ stdout: "signal-cli 0.14.9" }) : missing();
      const lines: string[] = [];
      const step = signalCliStep(run, { fetch, extract: fakeExtractor(), platform: "linux" });
      const ctx = context({ dataDir, print: (line) => lines.push(line) });

      const before = step.check(ctx);
      expect(before.status).toBe("missing");
      expect(before.reason).toContain(path.join(dataDir, "signal-cli"));
      expect(before.fix).toContain("Java 17");
      expect(before.fix).toContain("scripts/install-signal-cli.ps1");

      await step.apply?.(ctx);

      const after = step.check(ctx);
      expect(after.status).toBe("ok");
      expect(after.reason).toContain("0.14.9");
      expect(after.reason).toContain(launcher);
      expect(fs.existsSync(launcher)).toBe(true);
      expect(downloads).toEqual([
        RELEASE_API,
        "https://github.com/AsamK/signal-cli/releases/download/v0.14.9/signal-cli-0.14.9.tar.gz",
      ]);
      expect(lines.some((line) => line.includes("Java 17"))).toBe(true);
      expect(lines.some((line) => line.includes("downloading"))).toBe(true);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("downloads nothing on a second apply", async () => {
    const dataDir = emptyDataDir();
    try {
      const { fetch, downloads } = releaseFetch();
      const launcher = launcherOf(dataDir);
      const run: RunCommand = (argv) =>
        argv[0] === launcher ? output({ stdout: "signal-cli 0.14.9" }) : missing();
      const lines: string[] = [];
      const step = signalCliStep(run, { fetch, extract: fakeExtractor(), platform: "linux" });
      const ctx = context({ dataDir, print: (line) => lines.push(line) });

      await step.apply?.(ctx);
      lines.length = 0;
      await step.apply?.(ctx);

      expect(downloads).toHaveLength(2);
      expect(lines.some((line) => line.includes("already installed"))).toBe(true);
      expect(lines.some((line) => line.includes("downloading"))).toBe(false);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("installs once under setup and is skipped on the second run", async () => {
    const dataDir = emptyDataDir();
    try {
      const { fetch, downloads } = releaseFetch();
      const launcher = launcherOf(dataDir);
      const run: RunCommand = (argv) =>
        argv[0] === launcher ? output({ stdout: "signal-cli 0.14.9" }) : missing();
      const step = signalCliStep(run, { fetch, extract: fakeExtractor(), platform: "linux" });

      const first: string[] = [];
      expect(
        await runSetup([step], context({ dataDir, print: (line) => first.push(line) })),
      ).toBe(0);
      expect(first.some((line) => line.startsWith("apply"))).toBe(true);
      expect(first.some((line) => line.startsWith("ok") && line.includes("signal-cli"))).toBe(true);

      const second: string[] = [];
      expect(
        await runSetup([step], context({ dataDir, print: (line) => second.push(line) })),
      ).toBe(0);
      expect(second[0]).toContain("skip");
      expect(second.some((line) => line.startsWith("apply"))).toBe(false);
      expect(downloads).toHaveLength(2);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps the missing status offline, with one line naming the manual fallback", async () => {
    const dataDir = emptyDataDir();
    try {
      const fetchImpl: FetchLike = async () => {
        throw new Error("getaddrinfo ENOTFOUND api.github.com");
      };
      const step = signalCliStep((): CommandResult => missing(), {
        fetch: fetchImpl,
        extract: fakeExtractor(),
      });
      const ctx = context({ dataDir });

      let reason = "";
      try {
        await step.apply?.(ctx);
      } catch (err: unknown) {
        reason = err instanceof Error ? err.message : String(err);
      }

      expect(reason).toContain("GitHub");
      expect(reason).toContain("ENOTFOUND");
      expect(reason).not.toContain("\n");
      const report = step.check(ctx);
      expect(report.status).toBe("missing");
      expect(report.fix).toContain("scripts/install-signal-cli.ps1");
      expect(fs.existsSync(path.join(dataDir, "signal-cli"))).toBe(false);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("writes nothing when the release has no usable archive, and names it", async () => {
    const dataDir = emptyDataDir();
    try {
      const fetchImpl: FetchLike = async () =>
        new Response(JSON.stringify({ tag_name: "v0.15.0", assets: [] }), { status: 200 });
      const step = signalCliStep((): CommandResult => missing(), {
        fetch: fetchImpl,
        extract: fakeExtractor(),
      });
      const ctx = context({ dataDir });

      await expect(step.apply?.(ctx)).rejects.toThrow(/v0\.15\.0/);
      expect(fs.existsSync(path.join(dataDir, "signal-cli"))).toBe(false);
      expect(step.check(ctx).status).toBe("missing");
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("opencodeStep", () => {
  it("probes the configured binary", () => {
    const { run, calls } = recorder(output({ stdout: "2.0.25" }));

    const report = opencodeStep(run).check(context({ config }));

    expect(report.status).toBe("ok");
    expect(calls[0]).toEqual(["C:\\tools\\opencode.cmd", "--version"]);
  });

  it("names the install command when the binary is absent", () => {
    const report = opencodeStep(
      recorder(output({ status: null, error: { code: "ENOENT", message: "spawn opencode ENOENT" } }))
        .run,
    ).check(context());

    expect(report.status).toBe("missing");
    expect(report.fix).toContain("npm install -g opencode-ai");
    expect(report.fix).toContain("https://opencode.ai/docs");
  });
});

describe("dataDirStep", () => {
  it("reports an existing directory as ok", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-data-ok-"));
    try {
      expect(dataDirStep().check(context({ dataDir: dir })).status).toBe("ok");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a missing directory without creating it", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "sc-data-missing-"));
    const dir = path.join(parent, "nested", "SignalConnector");
    try {
      const report = dataDirStep().check(context({ dataDir: dir }));

      expect(report.status).toBe("missing");
      expect(report.reason).toContain(dir);
      expect(report.fix).toBeTruthy();
      expect(fs.existsSync(path.join(parent, "nested"))).toBe(false);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("reports an existing directory that is not writable as failed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-data-readonly-"));
    try {
      const report = dataDirStep({ writable: () => false }).check(context({ dataDir: dir }));

      expect(report.status).toBe("failed");
      expect(report.reason).toContain("not writable");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a path that is a file as failed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sc-data-file-"));
    const dir = path.join(root, "state.db");
    try {
      fs.writeFileSync(dir, "not a directory");
      const report = dataDirStep().check(context({ dataDir: dir }));

      expect(report.status).toBe("failed");
      expect(report.reason).toContain("not a directory");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports an unwritable parent as failed instead of missing", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "sc-data-denied-"));
    const dir = path.join(parent, "SignalConnector");
    try {
      const report = dataDirStep({ writable: () => false }).check(context({ dataDir: dir }));

      expect(report.status).toBe("failed");
      expect(report.reason).toContain("not writable");
      expect(fs.existsSync(dir)).toBe(false);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("configStep", () => {
  it("reports a parsed config as ok", async () => {
    const report = await configStep().check(context({ config }));
    expect(report.status).toBe("ok");
  });

  it("reports an absent config as missing, with the setup fix and no file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-config-missing-"));
    const file = path.join(dir, "config.toml");
    try {
      const report = await configStep().check(
        context({ dataDir: dir, configProblem: { absent: true, reason: "config.toml not found" } }),
      );

      expect(report.status).toBe("missing");
      expect(report.fix).toContain("node dist/index.js setup");
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an invalid config as failed, one line, and does not rewrite it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-config-invalid-"));
    const file = path.join(dir, "config.toml");
    try {
      fs.writeFileSync(file, "[signal", "utf8");
      const before = fs.readFileSync(file, "utf8");

      const report = await configStep().check(
        context({
          dataDir: dir,
          configProblem: { absent: false, reason: "config.toml is not valid TOML: bad\nline" },
        }),
      );

      expect(report.status).toBe("failed");
      expect(report.reason).toContain("not valid TOML");
      expect(report.reason).not.toContain("\n");
      expect(fs.readFileSync(file, "utf8")).toBe(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts an injected reader for absent and invalid files", async () => {
    const absent = await configStep(undefined, {
      readConfig: () => ({ ok: false, absent: true, reason: "config.toml not found" }),
    }).check(context());
    expect(absent.status).toBe("missing");

    const invalid = await configStep(undefined, {
      readConfig: () => ({ ok: false, absent: false, reason: "config.toml is invalid: x" }),
    }).check(context());
    expect(invalid.status).toBe("failed");
    expect(invalid.reason).toContain("invalid");
  });

  it("reads the real file lazily and still creates nothing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-config-lazy-"));
    try {
      const report = await configStep().check(context({ dataDir: dir }));

      expect(report.status).toBe("missing");
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("secretsStep", () => {
  it("reports the persistent file store when no keyring tool exists", () => {
    const report = secretsStep(undefined, {
      platform: "linux",
      hasCommand: () => false,
    }).check(context());

    expect(report.status).toBe("ok");
    expect(report.reason).toContain("file store");
    expect(report.reason).toContain("secrets.json");
    expect(report.reason).toContain("user-only");
    expect(report.reason).not.toContain("in memory");
  });

  it("names the Linux keyring when secret-tool is present", () => {
    const report = secretsStep(undefined, {
      platform: "linux",
      hasCommand: (command) => command === "secret-tool",
    }).check(context());

    expect(report.status).toBe("ok");
    expect(report.reason).toContain("secret-tool");
  });

  it("names the macOS keychain when security is present", () => {
    const report = secretsStep(undefined, {
      platform: "darwin",
      hasCommand: (command) => command === "security",
    }).check(context());

    expect(report.status).toBe("ok");
    expect(report.reason).toContain("Keychain");
  });

  it("accepts an injected store kind without probing tools", () => {
    let probed = false;
    const report = secretsStep(undefined, {
      platform: "linux",
      hasCommand: () => {
        probed = true;
        return false;
      },
      storeKind: () => "file",
    }).check(context());

    expect(report.status).toBe("ok");
    expect(report.reason).toContain("file store");
    expect(probed).toBe(false);
  });

  it("reports PowerShell as ok on Windows", () => {
    const { run, calls } = recorder(output({ stdout: "7\n" }));
    const report = secretsStep(run, { platform: "win32" }).check(context());

    expect(report.status).toBe("ok");
    expect(report.reason).toContain("7");
    expect(calls[0]?.[0]).toBe("pwsh.exe");
  });

  it("accepts Windows PowerShell when PowerShell 7 is absent", () => {
    const { run, calls } = recorder((command) =>
      command[0] === "pwsh.exe"
        ? output({ status: null, error: { code: "ENOENT", message: "spawn pwsh ENOENT" } })
        : output({ stdout: "5\n" }),
    );
    const report = secretsStep(run, { platform: "win32" }).check(context());

    expect(report.status).toBe("ok");
    expect(report.reason).toContain("powershell.exe");
    expect(calls.map((c) => c[0])).toEqual(["pwsh.exe", "powershell.exe"]);
  });

  it("reports both PowerShells missing as failed with the installer link", () => {
    const report = secretsStep(
      recorder(output({ status: null, error: { code: "ENOENT", message: "spawn ENOENT" } })).run,
      { platform: "win32" },
    ).check(context());

    expect(report.status).toBe("failed");
    expect(report.fix).toContain("https://aka.ms/powershell");
  });
});

describe("defaultRunCommand", () => {
  it("runs a real command through the resolver", () => {
    const result = defaultRunCommand([process.execPath, "--version"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toContain(process.version);
    expect(result.timedOut).toBe(false);
  });

  it("surfaces a missing executable as ENOENT", () => {
    const missing = path.join(os.tmpdir(), "signal-connector-not-a-real-command.exe");
    const result = defaultRunCommand([missing]);

    expect(result.error?.code).toBe("ENOENT");
  });
});
