import { beforeEach, describe, expect, it } from "vitest";
import { FakeAgent } from "../adapters/fakes/fakeAgent.js";
import { FakeSignal } from "../adapters/fakes/fakeSignal.js";
import { ConfigSchema } from "../config/config.js";
import { nullLogger } from "../logging/logger.js";
import { openStore, type Store } from "../store/store.js";
import { CoreApp } from "./app.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function makeApp() {
  const store: Store = openStore(":memory:");
  const signal = new FakeSignal();
  const agent = new FakeAgent();
  const config = ConfigSchema.parse({
    channel: { kind: "note-to-self" },
    signal: { account: "+1000" },
    projects: [{ name: "demo", path: "/tmp/demo" }],
  });
  const app = new CoreApp({ store, signal, agent, config, logger: nullLogger() });
  return { store, signal, agent, app };
}

function incoming(text: string) {
  return {
    id: String(Math.random()),
    channelId: "self",
    sender: "+1000",
    text,
    at: Date.now(),
    inControlChannel: true,
  };
}

describe("CoreApp", () => {
  let ctx: ReturnType<typeof makeApp>;
  beforeEach(async () => {
    ctx = makeApp();
    await ctx.app.start();
  });

  it("sets the active project with /use", async () => {
    ctx.signal.emitMessage(incoming("/use demo"));
    await tick();
    expect(ctx.signal.sent.at(-1)?.text).toBe("Active project: demo");
  });

  it("starts a task from free-form text and posts a status message", async () => {
    ctx.signal.emitMessage(incoming("/use demo"));
    await tick();
    ctx.signal.emitMessage(incoming("add a retry"));
    await tick();
    expect(ctx.agent.started).toHaveLength(1);
    expect(ctx.agent.started[0]?.prompt).toBe("add a retry");
    expect(ctx.signal.sent.some((m) => m.text.startsWith("Task "))).toBe(true);
  });

  it("forwards a permission and resolves it with approve", async () => {
    ctx.signal.emitMessage(incoming("/use demo"));
    ctx.signal.emitMessage(incoming("do work"));
    await tick();
    const taskId = ctx.agent.started[0]!.taskId;

    ctx.agent.emit({
      type: "permission",
      taskId,
      at: Date.now(),
      permission: { id: "p1", taskId, tool: "bash", description: "run ls", safe: false },
    });
    await tick();
    expect(ctx.signal.sent.some((m) => m.text.startsWith("Permission #1"))).toBe(true);

    ctx.signal.emitMessage(incoming("approve"));
    await tick();
    expect(ctx.agent.decisions).toEqual([{ permissionId: "p1", decision: "once" }]);
  });

  it("auto-allows a safe permission without a prompt", async () => {
    ctx.signal.emitMessage(incoming("/use demo"));
    ctx.signal.emitMessage(incoming("do work"));
    await tick();
    const taskId = ctx.agent.started[0]!.taskId;
    ctx.agent.emit({
      type: "permission",
      taskId,
      at: Date.now(),
      permission: { id: "p2", taskId, tool: "read", description: "read a file", safe: true },
    });
    await tick();
    expect(ctx.agent.decisions).toEqual([{ permissionId: "p2", decision: "once" }]);
    expect(ctx.signal.sent.some((m) => m.text.startsWith("Permission"))).toBe(false);
  });

  it("completes a task on idle and edits the status message in place", async () => {
    ctx.signal.emitMessage(incoming("/use demo"));
    ctx.signal.emitMessage(incoming("do work"));
    await tick();
    const taskId = ctx.agent.started[0]!.taskId;
    const statusMsg = ctx.signal.sent.find((m) => m.text.startsWith("Task "))!;

    ctx.agent.emit({ type: "status", taskId, at: Date.now(), text: "editing src/http.ts" });
    await tick();
    expect(ctx.signal.sent.find((m) => m.messageId === statusMsg.messageId)?.edited).toBe(true);

    ctx.agent.emit({ type: "idle", taskId, at: Date.now(), summary: "added retry" });
    await tick();
    expect(ctx.signal.sent.at(-1)?.text).toBe("Done: added retry");
  });

  it("resolves a permission via a reaction", async () => {
    ctx.signal.emitMessage(incoming("/use demo"));
    ctx.signal.emitMessage(incoming("do work"));
    await tick();
    const taskId = ctx.agent.started[0]!.taskId;
    ctx.agent.emit({
      type: "permission",
      taskId,
      at: Date.now(),
      permission: { id: "p3", taskId, tool: "bash", description: "run rm", safe: false },
    });
    await tick();
    const prompt = ctx.signal.sent.find((m) => m.text.startsWith("Permission #1"))!;

    ctx.signal.emitReaction({
      channelId: "self",
      sender: "+1000",
      emoji: "👎",
      targetId: prompt.messageId,
      at: Date.now(),
    });
    await tick();
    expect(ctx.agent.decisions).toEqual([{ permissionId: "p3", decision: "reject" }]);
  });

  it("greets on project connect and routes a quoted reply to that project", async () => {
    await ctx.app.notifyProjectConnected("demo");
    await tick();
    const greeting = ctx.signal.sent.at(-1)!;
    expect(greeting.text).toBe(
      'Project "demo" connected. Reply to this message to address it, or use /use demo.',
    );

    // A reply that quotes the greeting routes the free-form text to demo.
    ctx.signal.emitMessage({ ...incoming("add a retry"), quoteId: greeting.messageId });
    await tick();
    expect(ctx.agent.started).toHaveLength(1);
    expect(ctx.agent.started[0]?.prompt).toBe("add a retry");
    expect(ctx.agent.started[0]?.project.id).toBe("demo");
  });
});
