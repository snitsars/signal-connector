import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { BridgeHub } from "../../bridge/hub.js";
import type { AgentEvent } from "../../domain/types.js";
import { nullLogger } from "../../logging/logger.js";
import { PluginBridgeAgent } from "./pluginBridge.js";

describe("PluginBridgeAgent", () => {
  it("writes patch text from the plugin and hands the core a file path", () => {
    const hub = new BridgeHub();
    const agent = new PluginBridgeAgent(hub, nullLogger());
    const seen: AgentEvent[] = [];
    agent.subscribe((event) => seen.push(event));

    const conn = hub.register(() => {}, { type: "register", project: { name: "app", path: "/a" } });
    hub.dispatch(conn, {
      type: "event",
      taskId: "t1",
      event: { type: "idle", taskId: "t1", at: 1, summary: "done" },
      diffText: "@@ -1 +1 @@\n-a\n+b",
    });

    const diffPath = seen[0]?.diffPath;
    expect(diffPath).toBeDefined();
    expect(fs.readFileSync(diffPath!, "utf8")).toContain("+b");
    fs.unlinkSync(diffPath!);
  });

  it("passes events through untouched when there is no patch", () => {
    const hub = new BridgeHub();
    const agent = new PluginBridgeAgent(hub, nullLogger());
    const seen: AgentEvent[] = [];
    agent.subscribe((event) => seen.push(event));

    const conn = hub.register(() => {}, { type: "register", project: { name: "app", path: "/a" } });
    hub.dispatch(conn, {
      type: "event",
      taskId: "t1",
      event: { type: "status", taskId: "t1", at: 1, text: "working" },
    });

    expect(seen[0]).toEqual({ type: "status", taskId: "t1", at: 1, text: "working" });
    expect(seen[0]?.diffPath).toBeUndefined();
  });
});
