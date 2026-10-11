import { describe, expect, it } from "vitest";
import { buildDaemonArgv, rpcEndpoint } from "./daemon.js";
import { linkInstructions } from "./link.js";

describe("signal-cli daemon helpers", () => {
  it("appends daemon flags after a base command with an account", () => {
    expect(
      buildDaemonArgv(["signal-cli"], { host: "127.0.0.1", port: 8080, account: "+1000" }),
    ).toEqual(["signal-cli", "-a", "+1000", "daemon", "--http", "127.0.0.1:8080"]);
  });

  it("keeps a java wildcard-classpath command intact", () => {
    const argv = buildDaemonArgv(
      ["java", "--enable-native-access=ALL-UNNAMED", "-cp", "C:\\sc\\lib\\*", "org.asamk.signal.Main"],
      { host: "127.0.0.1", port: 8080 },
    );
    expect(argv[0]).toBe("java");
    expect(argv[argv.length - 1]).toBe("127.0.0.1:8080");
    expect(argv.slice(-3)).toEqual(["daemon", "--http", "127.0.0.1:8080"]);
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
