import { describe, expect, it } from "vitest";
import { FakeAgent } from "../adapters/fakes/fakeAgent.js";
import { FakeSignal } from "../adapters/fakes/fakeSignal.js";
import { ConfigSchema } from "../config/config.js";
import { nullLogger } from "../logging/logger.js";
import { openStore } from "../store/store.js";
import { CoreApp } from "./app.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function setup() {
  const store = openStore(":memory:");
  const signal = new FakeSignal();
  const agent = new FakeAgent();
  const config = ConfigSchema.parse({
    signal: { account: "+1000" },
    projects: [{ name: "demo", path: "/tmp/demo" }],
  });
  const app = new CoreApp({ store, signal, agent, config, logger: nullLogger() });
  return { store, signal, agent, app };
}

function msg(text: string) {
  return {
    id: String(Math.random()),
    channelId: "self",
    sender: "+1000",
    text,
    at: Date.now(),
    inControlChannel: true,
  };
}

const texts = (signal: FakeSignal): string[] =>
  signal.ops.flatMap((o) => (o.op === "send" ? [o.text] : []));

describe("end-to-end notification flow", () => {
  it("drives a full task lifecycle from agent events to Signal output", async () => {
    const { signal, agent, app } = setup();
    await app.start();

    signal.emitMessage(msg("/use demo"));
    await tick();
    signal.emitMessage(msg("add a retry"));
    await tick();
    const taskId = agent.started[0]!.taskId;

    agent.emit({ type: "status", taskId, at: Date.now(), text: "planning" });
    await tick();
    agent.emit({ type: "files-changed", taskId, at: Date.now(), files: ["a.ts"] });
    await tick();
    agent.emit({
      type: "permission",
      taskId,
      at: Date.now(),
      permission: { id: "p1", taskId, tool: "bash", description: "run ls", safe: false },
    });
    await tick();
    signal.emitMessage(msg("approve"));
    await tick();
    agent.emit({ type: "idle", taskId, at: Date.now(), summary: "added retry", diffPath: "C:/tmp/x.patch" });
    await tick();

    // First op: the active-project confirmation.
    expect(signal.ops[0]).toMatchObject({ op: "send", text: "Active project: demo" });
    // Exactly one status message, edited in place (never duplicated).
    const statusSend = signal.ops.find((o) => o.op === "send" && o.text.startsWith("Task "))!;
    const edits = signal.ops.filter((o) => o.op === "edit");
    expect(edits.length).toBeGreaterThan(0);
    expect(edits.every((o) => o.op === "edit" && o.messageId === statusSend.messageId)).toBe(true);
    expect(signal.ops.filter((o) => o.op === "send" && o.text.startsWith("Task "))).toHaveLength(1);

    const all = texts(signal);
    expect(all).toContain("Changed 1 file(s): a.ts");
    expect(all.some((t) => t.startsWith("Permission #1"))).toBe(true);
    expect(all).toContain("approved: bash");
    expect(all).toContain("Done: added retry");
    expect(signal.ops.at(-1)).toMatchObject({ op: "attach", filePath: "C:/tmp/x.patch" });
  });

  it("reports a failure and attaches nothing", async () => {
    const { signal, agent, app } = setup();
    await app.start();

    signal.emitMessage(msg("/use demo"));
    await tick();
    signal.emitMessage(msg("do work"));
    await tick();
    const taskId = agent.started[0]!.taskId;

    agent.emit({ type: "error", taskId, at: Date.now(), text: "boom" });
    await tick();

    const all = texts(signal);
    expect(all.at(-1)).toBe("Failed: boom");
    expect(signal.ops.some((o) => o.op === "attach")).toBe(false);
  });
});
