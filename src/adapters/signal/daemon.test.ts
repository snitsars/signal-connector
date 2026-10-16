import { describe, expect, it } from "vitest";
import { buildDaemonArgv, rpcEndpoint, SignalCliDaemon } from "./daemon.js";
import { linkInstructions } from "./link.js";
import type { Logger } from "../../logging/logger.js";

/** Collects what the daemon logged, so the message itself can be asserted. */
function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const record =
    (level: string) =>
    (msg: string, fields?: Record<string, unknown>): void => {
      lines.push(`${level} ${msg}${fields ? " " + JSON.stringify(fields) : ""}`);
    };
  return { logger: { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") }, lines };
}

describe("signal-cli daemon helpers", () => {
  it("appends daemon flags after a base command with an account", () => {
    expect(
      buildDaemonArgv(["signal-cli"], { host: "127.0.0.1", port: 8080, account: "+1000" }),
    ).toEqual([
      "signal-cli",
      "-a",
      "+1000",
      "daemon",
      "--http",
      "127.0.0.1:8080",
      "--receive-mode",
      "manual",
    ]);
  });

  it("keeps a java wildcard-classpath command intact", () => {
    const argv = buildDaemonArgv(
      ["java", "--enable-native-access=ALL-UNNAMED", "-cp", "C:\\sc\\lib\\*", "org.asamk.signal.Main"],
      { host: "127.0.0.1", port: 8080 },
    );
    expect(argv[0]).toBe("java");
    expect(argv[argv.length - 1]).toBe("manual");
    expect(argv.slice(-5)).toEqual([
      "daemon",
      "--http",
      "127.0.0.1:8080",
      "--receive-mode",
      "manual",
    ]);
  });

  it("computes the JSON-RPC endpoint", () => {
    expect(rpcEndpoint("127.0.0.1", 8080)).toBe("http://127.0.0.1:8080/api/v1/rpc");
  });
});

describe("link instructions", () => {
  it("includes the link URI", () => {
    expect(linkInstructions("sgnl://linkdevice?x=1")).toContain("sgnl://linkdevice?x=1");
  });
});

describe("daemon restart", () => {
  it("tells the operator what to do about a daemon it did not start", async () => {
    const { logger, lines } = recordingLogger();
    const daemon = new SignalCliDaemon({
      command: ["signal-cli"],
      host: "127.0.0.1",
      port: 8080,
      logger,
    });

    // No child was ever spawned: the daemon on that port belongs to somebody
    // else, so it cannot be killed from here (the case that left the connector
    // talking to a wedged daemon for hours).
    await expect(daemon.restart("receive timed out")).resolves.toBeUndefined();
    expect(lines.join("\n")).toContain("did not start it");
    expect(lines.join("\n")).toContain("8080");
  });
});
