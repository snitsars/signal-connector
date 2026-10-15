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

function msg(text: string, channelId = "self") {
  return {
    id: String(Math.random()),
    channelId,
    sender: "+1000",
    text,
    at: Date.now(),
    inControlChannel: channelId === "self",
  };
}

/** The channel a project talks in (its own group), once it has one. */
function projectChannel(signal: FakeSignal): string {
  return signal.createdGroups.length > 0 ? `group-1-demo` : "self";
}

const texts = (signal: FakeSignal): string[] =>
  signal.ops.flatMap((o) => (o.op === "send" ? [o.text] : []));

describe("end-to-end notification flow", () => {
  it("drives a full task lifecycle from agent events to Signal output", async () => {
    const { signal, agent, app } = setup();
    await app.start();

    signal.emitMessage(msg("/open demo"));
    await tick();
    signal.emitMessage(msg("add a retry", projectChannel(signal)));
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
    signal.emitMessage(msg("approve", projectChannel(signal)));
    await tick();
    agent.emit({ type: "idle", taskId, at: Date.now(), summary: "added retry", diffPath: "C:/tmp/x.patch" });
    await tick();

    // The project's own group is introduced, then the /open confirmation.
    expect(texts(signal).some((t) => t.includes("this group is for this project"))).toBe(true);
    expect(signal.ops.some((o) => o.op === "send" && o.text.includes("Opened demo"))).toBe(
      true,
    );
    // Exactly one status message, edited in place (never duplicated).
    const statusSend = signal.ops.find((o) => o.op === "send" && o.text.includes("Task "))!;
    const edits = signal.ops.filter((o) => o.op === "edit");
    expect(edits.length).toBeGreaterThan(0);
    expect(edits.every((o) => o.op === "edit" && o.messageId === statusSend.messageId)).toBe(true);
    expect(signal.ops.filter((o) => o.op === "send" && o.text.includes("Task "))).toHaveLength(1);

    const all = texts(signal);
    expect(all.some((t) => t.includes("Changed 1 file(s)"))).toBe(true);
    expect(all.some((t) => t.includes("Approval needed"))).toBe(true);
    expect(all.some((t) => t.includes("approved: bash"))).toBe(true);
    expect(all.some((t) => t.includes("added retry"))).toBe(true);
    expect(signal.ops.at(-1)).toMatchObject({ op: "attach", filePath: "C:/tmp/x.patch" });
  });

  it("reports a failure and attaches nothing", async () => {
    const { signal, agent, app } = setup();
    await app.start();

    signal.emitMessage(msg("/open demo"));
    await tick();
    signal.emitMessage(msg("do work", projectChannel(signal)));
    await tick();
    const taskId = agent.started[0]!.taskId;

    agent.emit({ type: "error", taskId, at: Date.now(), text: "boom" });
    await tick();

    const all = texts(signal);
    expect(all.at(-1)).toContain("boom");
    expect(signal.ops.some((o) => o.op === "attach")).toBe(false);
  });
});
