import { describe, expect, it } from "vitest";
import { BridgeHub } from "./hub.js";
import type { ServiceToPlugin } from "./protocol.js";

describe("BridgeHub", () => {
  it("registers a plugin and acknowledges it", () => {
    const hub = new BridgeHub();
    const sent: ServiceToPlugin[] = [];
    const conn = hub.register((m) => sent.push(m), {
      type: "register",
      project: { name: "My App", path: "C:/app" },
    });
    expect(conn.projectId).toBe("my-app");
    expect(sent[0]).toEqual({ type: "registered", projectId: "my-app", projectName: "My App" });
    expect(hub.any()).toBe(true);
  });

  it("routes events tagged with the project id", () => {
    const hub = new BridgeHub();
    const conn = hub.register(() => {}, { type: "register", project: { name: "app", path: "/a" } });
    const got: { projectId: string; event: { text?: string } }[] = [];
    hub.onEvent((e) => got.push(e as never));
    hub.dispatch(conn, {
      type: "event",
      taskId: "t1",
      event: { type: "status", taskId: "t1", at: 1, text: "hi" },
    });
    expect(got[0]?.projectId).toBe("app");
    expect(got[0]?.event.text).toBe("hi");
  });

  it("waits for the plugin to confirm a model switch", async () => {
    const hub = new BridgeHub();
    const conn = hub.register(() => {}, { type: "register", project: { name: "app", path: "/a" } });
    const pending = hub.requestSetModel("app", "r1", "", { providerID: "p", id: "m" });
    hub.dispatch(conn, { type: "model_set", requestId: "r1", ok: false, detail: "nope" });
    await expect(pending).resolves.toEqual({ type: "model_set", requestId: "r1", ok: false, detail: "nope" });
  });

  it("resolves a newSession request from the plugin", async () => {    const hub = new BridgeHub();
    const sent: ServiceToPlugin[] = [];
    const conn = hub.register((m) => sent.push(m), {
      type: "register",
      project: { name: "app", path: "/a" },
    });
    const pending = hub.requestSession("app", "req1");
    hub.dispatch(conn, { type: "session_created", requestId: "req1", sessionId: "ses_x" });
    await expect(pending).resolves.toBe("ses_x");
    expect(sent.some((m) => m.type === "command" && m.kind === "newSession")).toBe(true);
  });

  it("rejects a request when no plugin is connected", async () => {
    const hub = new BridgeHub();
    await expect(hub.requestSession("nope", "r")).rejects.toThrow(/no plugin/);
  });

  it("routes plugin diagnostics to a handler", () => {
    const hub = new BridgeHub();
    const conn = hub.register(() => {}, { type: "register", project: { name: "app", path: "/a" } });
    const seen: string[] = [];
    hub.onDiag((projectId, detail) => seen.push(`${projectId}: ${detail}`));
    hub.dispatch(conn, { type: "diag", detail: "permission poll failed: boom" });
    expect(seen).toEqual(["app: permission poll failed: boom"]);
  });

  it("unregisters on disconnect", () => {
    const hub = new BridgeHub();
    const conn = hub.register(() => {}, { type: "register", project: { name: "app", path: "/a" } });
    hub.unregister(conn);
    expect(hub.any()).toBe(false);
  });
});
