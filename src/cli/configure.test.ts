import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readConfig } from "../config/config.js";
import {
  linkDevice,
  linkStep,
  signalCommandFor,
  writeInitialConfig,
  type DeviceLink,
  type SignalCommand,
} from "./configure.js";
import { runSetup, type Print, type StepContext } from "./setup.js";

const ACCOUNT = "+15550001111";

function tempDir(prefix = "sc-configure-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function context(dataDir: string, print: Print = () => {}): StepContext {
  return { dataDir, print };
}

function sink(): { print: Print; output: string[] } {
  const output: string[] = [];
  return { output, print: (line) => output.push(line) };
}

interface FakeLink extends DeviceLink {
  calls: string[];
  stops: number;
}

/** A linker that needs no phone, daemon or QR renderer. */
function fakeLink(account = ACCOUNT): FakeLink {
  const calls: string[] = [];
  return {
    calls,
    stops: 0,
    async start() {
      calls.push("start");
      return "sgnl://linkdevice?fake=1";
    },
    async qr(uri) {
      calls.push(`qr:${uri}`);
      return path.join(os.tmpdir(), "fake-link-qr.png");
    },
    async finish(uri) {
      calls.push(`finish:${uri}`);
      return account;
    },
    async stop() {
      calls.push("stop");
      this.stops += 1;
    },
  };
}

const SIGNAL: SignalCommand = {
  cliPath: "C:\\tools\\signal-cli.bat",
  command: [
    "C:\\Program Files\\Microsoft\\jdk-25\\bin\\java.exe",
    "--enable-native-access=ALL-UNNAMED",
    "-cp",
    "C:\\tools\\lib\\*",
    "org.asamk.signal.Main",
  ],
};

const savedPath = process.env.PATH;

afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
});

describe("writeInitialConfig", () => {
  it("creates a parseable config with the account, signal command and one project", () => {
    const dir = tempDir();
    const projectPath = path.join(dir, "my-project");
    try {
      const result = writeInitialConfig({
        dir,
        account: ACCOUNT,
        projectPath,
        signal: SIGNAL,
      });

      expect(result.written).toBe(true);
      expect(result.path).toBe(path.join(dir, "config.toml"));

      const read = readConfig(dir);
      expect(read.ok).toBe(true);
      if (!read.ok) throw new Error(read.reason);
      expect(read.config.channel.kind).toBe("note-to-self");
      expect(read.config.signal.account).toBe(ACCOUNT);
      expect(read.config.signal.cliPath).toBe(SIGNAL.cliPath);
      expect(read.config.signal.command).toEqual(SIGNAL.command);
      expect(read.config.signal.manageDaemon).toBe(true);
      expect(read.config.agent.kind).toBe("plugin");
      expect(read.config.projects).toHaveLength(1);
      expect(read.config.projects[0]).toMatchObject({
        name: "my-project",
        path: projectPath,
      });

      if (process.platform !== "win32") {
        expect(fs.statSync(result.path).mode & 0o777).toBe(0o600);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never overwrites a file that already exists", () => {
    const dir = tempDir();
    const file = path.join(dir, "config.toml");
    try {
      fs.writeFileSync(file, "# the operator's own config\n");
      const before = fs.readFileSync(file);

      const result = writeInitialConfig({
        dir,
        account: ACCOUNT,
        projectPath: dir,
        signal: SIGNAL,
      });

      expect(result).toEqual({ path: file, written: false });
      expect(fs.readFileSync(file)).toEqual(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails without a partial file when the target is not a writable file", () => {
    const dir = tempDir();
    try {
      // A directory where the file belongs is a bad data directory; nothing may
      // be written and the existing entry must stay untouched.
      fs.mkdirSync(path.join(dir, "config.toml"));

      expect(() =>
        writeInitialConfig({
          dir,
          account: ACCOUNT,
          projectPath: dir,
          signal: SIGNAL,
        }),
      ).toThrow(/not a file/);
      expect(fs.statSync(path.join(dir, "config.toml")).isDirectory()).toBe(true);

      const fileAsDir = path.join(dir, "state");
      fs.writeFileSync(fileAsDir, "not a directory");
      expect(() =>
        writeInitialConfig({
          dir: fileAsDir,
          account: ACCOUNT,
          projectPath: dir,
          signal: SIGNAL,
        }),
      ).toThrow();
      expect(fs.existsSync(path.join(fileAsDir, "config.toml"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("linkDevice", () => {
  it("writes the config from the linked number and stops the daemon", async () => {
    const dir = tempDir();
    const print = sink();
    const link = fakeLink();
    try {
      const outcome = await linkDevice({
        dataDir: dir,
        config: { signal: SIGNAL, projectPath: dir },
        link,
        print: print.print,
      });

      expect(outcome).toMatchObject({ account: ACCOUNT, written: true });
      expect(link.calls).toEqual([
        "start",
        `qr:sgnl://linkdevice?fake=1`,
        `finish:sgnl://linkdevice?fake=1`,
        "stop",
      ]);
      expect(link.stops).toBe(1);
      expect(print.output.some((line) => line.includes("QR image:"))).toBe(true);
      expect(print.output.some((line) => line.includes("wrote"))).toBe(true);
      expect(readConfig(dir)).toMatchObject({ ok: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a refused link, writes no config and still stops the daemon", async () => {
    const dir = tempDir();
    const link = fakeLink();
    link.finish = async () => {
      throw new Error("link refused");
    };
    try {
      await expect(
        linkDevice({
          dataDir: dir,
          config: { signal: SIGNAL, projectPath: dir },
          link,
          print: () => {},
        }),
      ).rejects.toThrow("link refused");

      expect(fs.existsSync(path.join(dir, "config.toml"))).toBe(false);
      expect(link.stops).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("times out with the retry line and no config", async () => {
    const dir = tempDir();
    const link = fakeLink();
    link.finish = async () => "";
    try {
      await expect(
        linkDevice({
          dataDir: dir,
          config: { signal: SIGNAL, projectPath: dir },
          link,
          print: () => {},
          attempts: 2,
          intervalMs: 0,
        }),
      ).rejects.toThrow(/timed out/);

      expect(fs.existsSync(path.join(dir, "config.toml"))).toBe(false);
      expect(link.stops).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("linkStep", () => {
  it("publishes the device-link step after signal-cli and reports the linked account", async () => {
    const dir = tempDir();
    const print = sink();
    const link = fakeLink();
    let factoryCalls = 0;
    const step = linkStep((options) => {
      factoryCalls += 1;
      expect(options.projectPath).toBe(process.cwd());
      return link;
    });
    try {
      const before = await step.check(context(dir));
      expect(before.status).toBe("missing");
      expect(before.fix).toContain("setup");

      expect(await runSetup([step], context(dir, print.print))).toBe(0);
      expect(factoryCalls).toBe(1);
      expect(print.output.some((line) => line.startsWith("ok"))).toBe(true);

      const after = await step.check(context(dir));
      expect(after.status).toBe("ok");
      expect(after.reason).toContain(ACCOUNT);

      const read = readConfig(dir);
      if (!read.ok) throw new Error(read.reason);
      expect(read.config.projects[0]?.name).toBe(path.basename(process.cwd()));
      expect(read.config.projects[0]?.path).toBe(process.cwd());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("links once: a second apply is skipped and the file is byte-identical", async () => {
    const dir = tempDir();
    const link = fakeLink();
    let factoryCalls = 0;
    const step = linkStep(() => {
      factoryCalls += 1;
      return link;
    });
    try {
      const first = sink();
      expect(await runSetup([step], context(dir, first.print))).toBe(0);
      expect(first.output.some((line) => line.startsWith("apply"))).toBe(true);

      const file = path.join(dir, "config.toml");
      const before = fs.readFileSync(file);

      const second = sink();
      expect(await runSetup([step], context(dir, second.print))).toBe(0);
      expect(second.output[0]).toContain("skip");
      expect(second.output.some((line) => line.startsWith("apply"))).toBe(false);
      expect(factoryCalls).toBe(1);
      expect(fs.readFileSync(file)).toEqual(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops on an existing config without an account and leaves it untouched", async () => {
    const dir = tempDir();
    const file = path.join(dir, "config.toml");
    const original = '[signal]\ncliPath = "signal-cli"\n';
    try {
      fs.writeFileSync(file, original);
      let factoryCalls = 0;
      const step = linkStep(() => {
        factoryCalls += 1;
        return fakeLink();
      });

      const report = await step.check(context(dir));
      expect(report.status).toBe("failed");
      expect(report.reason).toContain('account = "+<your number>"');

      const print = sink();
      expect(await runSetup([step], context(dir, print.print))).toBe(1);
      expect(print.output.some((line) => line.startsWith("apply"))).toBe(false);
      expect(factoryCalls).toBe(0);
      expect(fs.readFileSync(file, "utf8")).toBe(original);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names setup and Java when signal-cli is absent", async () => {
    const dir = tempDir();
    try {
      process.env.PATH = dir;
      const report = await linkStep(() => fakeLink()).check(context(dir));

      expect(report.status).toBe("missing");
      expect(report.fix).toContain("setup");
      expect(report.fix).toContain("Java");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("signalCommandFor", () => {
  function installedCopy(dir: string): void {
    const home = path.join(dir, "signal-cli", "signal-cli-0.14.9");
    fs.mkdirSync(path.join(home, "bin"), { recursive: true });
    fs.mkdirSync(path.join(home, "lib"), { recursive: true });
    fs.writeFileSync(path.join(home, "bin", "signal-cli"), "#!/bin/sh\n");
  }

  it("falls back to signal-cli on PATH when no copy is installed", () => {
    const dir = tempDir();
    try {
      expect(signalCommandFor(dir, "linux")).toEqual({
        cliPath: "signal-cli",
        command: ["signal-cli"],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the installed launcher, and on Windows java with the wildcard classpath", () => {
    const dir = tempDir();
    try {
      installedCopy(dir);

      const linux = signalCommandFor(dir, "linux");
      expect(linux.cliPath).toBe(
        path.join(dir, "signal-cli", "signal-cli-0.14.9", "bin", "signal-cli"),
      );
      expect(linux.command).toEqual([linux.cliPath]);

      const windows = signalCommandFor(dir, "win32");
      expect(windows.command).toContain(path.join(dir, "signal-cli", "signal-cli-0.14.9", "lib", "*"));
      expect(windows.command).toContain("org.asamk.signal.Main");
      expect(windows.command[0]).toMatch(/java(\.exe)?$/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
