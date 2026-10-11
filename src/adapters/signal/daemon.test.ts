import { describe, expect, it } from "vitest";
import { buildDaemonArgs, rpcEndpoint } from "./daemon.js";
import { linkInstructions } from "./link.js";

describe("signal-cli daemon helpers", () => {
  it("builds daemon argv with an account", () => {
    expect(buildDaemonArgs({ host: "127.0.0.1", port: 8080, account: "+1000" })).toEqual([
      "-a",
      "+1000",
      "daemon",
      "--http",
      "127.0.0.1:8080",
    ]);
  });

  it("builds daemon argv without an account", () => {
    expect(buildDaemonArgs({ host: "127.0.0.1", port: 8080 })).toEqual([
      "daemon",
      "--http",
      "127.0.0.1:8080",
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
