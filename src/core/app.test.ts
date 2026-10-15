import { beforeEach, describe, expect, it } from "vitest";
import { FakeAgent } from "../adapters/fakes/fakeAgent.js";
import { FakeSignal } from "../adapters/fakes/fakeSignal.js";
import { ConfigSchema } from "../config/config.js";
import type { LauncherPort } from "./ports.js";
import { nullLogger } from "../logging/logger.js";
import { openStore, type Store } from "../store/store.js";
import { CoreApp } from "./app.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** The channel a project's output and menus go to (its own group). */
const projectChannel = (ctx: { store: { getChannel(id: string): { channelId: string } | undefined } }): string =>
  ctx.store.getChannel("demo")?.channelId ?? "self";

function makeApp(
  projects = [{ name: "demo", path: "/tmp/demo" }],
  outbound: Record<string, unknown> = {},
  launcher?: LauncherPort,
) {
  const store: Store = openStore(":memory:");
  storeRef = store;
  const signal = new FakeSignal();
  const agent = new FakeAgent();
  const config = ConfigSchema.parse({
    channel: { kind: "note-to-self" },
    signal: { account: "+1000" },
    projects,
    outbound,
  });
  const app = new CoreApp({
    store,
    signal,
    agent,
    config,
    logger: nullLogger(),
    ...(launcher ? { launcher } : {}),
  });
  return { store, signal, agent, app };
}

/** The store of the app under test, so `incoming` can pick the right channel. */
let storeRef: Store | undefined;

class FakeLauncher implements LauncherPort {
  readonly launched: string[] = [];
  started = true;
  sessionId?: string;
  async launch(project: { id: string }) {
    this.launched.push(project.id);
    return {
      started: this.started,
      detail: this.started ? "pane w2:p1" : "herdr exploded",
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
    };
  }
}

/**
 * A message arriving in a specific channel — used for answers that belong to a
 * project's own group (menus, approvals) rather than the control channel.
 */
function incomingIn(channelId: string, text: string, inControlChannel = false) {
  return {
    id: String(Math.random()),
    channelId,
    sender: "+1000",
    text,
    at: Date.now(),
    inControlChannel,
  };
}

/**
 * A message from the operator. Control commands arrive in the control channel;
 * everything else arrives where the project's conversation lives — its own group
 * once `/open` has created one, which is how the operator actually works now.
 */
function incoming(text: string) {
  const general = /^\/(open|projects|help)\b/.test(text.trim());
  const channelId = general ? "self" : storeRef?.getChannel("demo")?.channelId ?? "self";
  return {
    id: String(Math.random()),
    channelId,
    sender: "+1000",
    text,
    at: Date.now(),
    inControlChannel: channelId === "self",
  };
}

describe("CoreApp", () => {
  let ctx: ReturnType<typeof makeApp>;
  beforeEach(async () => {
    ctx = makeApp();
    await ctx.app.start();
  });

  it("asks you to open a project when a task arrives in the control group", async () => {
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incomingIn("self", "do work", true));
    await tick();
    expect(ctx.agent.started).toHaveLength(0);
    expect(ctx.signal.sent.at(-1)?.text).toContain("No project here");
  });

  it("gives a project its own group once, then reuses it", async () => {
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    expect(ctx.signal.createdGroups).toEqual(["demo"]);
    expect(ctx.store.getChannel("demo")?.channelId).toBe("group-1-demo");
    expect(ctx.signal.sent.at(-1)?.text).toContain('group "demo" created');

    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    expect(ctx.signal.createdGroups).toEqual(["demo"]); // reused, not recreated

    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "do work"));
    await tick();
    const status = ctx.signal.sent.find((m) => m.text.startsWith("Task "))!;
    expect(status.channelId).toBe("group-1-demo");
  });

  it("routes a message in a project's group to that project", async () => {
    ctx = makeApp([
      { name: "demo", path: "/tmp/demo" },
      { name: "other", path: "/tmp/other" },
    ]);
    await ctx.app.start();
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incoming("/open other"));
    await tick();

    // Speaking in demo's group is about demo, whatever the control channel's active project is.
    ctx.signal.emitMessage(incomingIn("group-1-demo", "fix the parser"));
    await tick();
    expect(ctx.agent.started.at(-1)?.prompt).toBe("fix the parser");
    expect(ctx.agent.started.at(-1)?.project.id).toBe("demo");
  });

  it("starts a project's window on /use when it has a launch config", async () => {
    const launcher = new FakeLauncher();
    ctx = makeApp([{ name: "demo", path: "/tmp/demo", launch: { kind: "herdr" } }], {}, launcher);
    await ctx.app.start();

    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    expect(launcher.launched).toEqual(["demo"]);
    expect(ctx.signal.sent.at(-1)?.text).toContain("Opened demo");
  });

  it("says so when a project has no launch command", async () => {
    const launcher = new FakeLauncher();
    ctx = makeApp([{ name: "demo", path: "/tmp/demo" }], {}, launcher);
    await ctx.app.start();

    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    expect(launcher.launched).toEqual([]);
    expect(ctx.signal.sent.at(-1)?.text).toContain("Opened demo");
  });

  it("pins the session the project's window is showing", async () => {
    const launcher = new FakeLauncher();
    launcher.sessionId = "ses_visible";
    ctx = makeApp([{ name: "demo", path: "/tmp/demo", launch: { kind: "herdr" } }], {}, launcher);
    await ctx.app.start();

    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    expect(ctx.store.getSession("demo")).toBe("ses_visible");

    // The next task therefore runs in the session being watched.
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "do work"));
    await tick();
    expect(ctx.agent.started.at(-1)?.sessionId).toBe("ses_visible");
  });

  it("starts a project's window on /use when nothing is connected for it", async () => {
    const launcher = new FakeLauncher();
    ctx = makeApp([{ name: "demo", path: "/tmp/demo", launch: { kind: "herdr" } }], {}, launcher);
    await ctx.app.start();

    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    expect(launcher.launched).toEqual(["demo"]);
    expect(ctx.signal.sent.at(-1)?.text).toContain("Opened demo");
  });

  it("brings the project's window forward on /use, even when it is connected", async () => {
    const launcher = new FakeLauncher();
    ctx = makeApp([{ name: "demo", path: "/tmp/demo", launch: { kind: "herdr" } }], {}, launcher);
    await ctx.app.start();
    ctx.agent.connected.add("demo");

    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    expect(launcher.launched).toEqual(["demo"]);
    expect(ctx.signal.sent.at(-1)?.text).toContain("Opened demo");
  });

  it("marks connected projects in /projects", async () => {
    ctx = makeApp([
      { name: "demo", path: "/tmp/demo" },
      { name: "other", path: "/tmp/other" },
    ]);
    await ctx.app.start();
    ctx.agent.connected.add("demo");

    ctx.signal.emitMessage(incoming("/projects"));
    await tick();
    const text = ctx.signal.sent.at(-1)?.text ?? "";
    expect(text).toContain("- demo (/tmp/demo) [connected]");
    expect(text).toContain("- other (/tmp/other)");
    expect(text).not.toContain("- other (/tmp/other) [connected]");
  });

  it("reports a failed launch instead of pretending it started", async () => {
    const launcher = new FakeLauncher();
    launcher.started = false;
    ctx = makeApp([{ name: "demo", path: "/tmp/demo", launch: { kind: "herdr" } }], {}, launcher);
    await ctx.app.start();

    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    expect(ctx.signal.sent.at(-1)?.text).toContain("Opened demo");
  });

  it("opens a project's window on /open even when a plugin is already connected", async () => {
    const launcher = new FakeLauncher();
    ctx = makeApp([{ name: "demo", path: "/tmp/demo", launch: { kind: "herdr" } }], {}, launcher);
    await ctx.app.start();
    ctx.agent.connected.add("demo");

    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    expect(launcher.launched).toEqual(["demo"]);
    expect(ctx.signal.sent.at(-1)?.text).toContain("Opened demo");
  });

  it("says so when a project has no launch command", async () => {
    const launcher = new FakeLauncher();
    ctx = makeApp([{ name: "demo", path: "/tmp/demo" }], {}, launcher);
    await ctx.app.start();

    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    expect(launcher.launched).toEqual([]);
    expect(ctx.signal.sent.at(-1)?.text).toContain("Opened demo");
  });

  it("sets the active project with /use", async () => {
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    expect(ctx.signal.sent.at(-1)?.text).toContain("Opened demo");
  });

  it("starts a task from free-form text and posts a status message", async () => {
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "add a retry"));
    await tick();
    expect(ctx.agent.started).toHaveLength(1);
    expect(ctx.agent.started[0]?.prompt).toBe("add a retry");
    expect(ctx.signal.sent.some((m) => m.text.startsWith("Task "))).toBe(true);
  });

  it("hands saved attachments to the agent as file paths", async () => {
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage({
      ...incoming("what is wrong here?"),
      mediaPaths: ["C:\\media\\shot.png"],
    });
    await tick();
    expect(ctx.agent.started[0]?.prompt).toBe(
      "what is wrong here?\n\n[attached file: C:\\media\\shot.png]",
    );
  });

  it("starts a task for an image sent without any text", async () => {
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage({ ...incoming(""), mediaPaths: ["C:\\media\\shot.png"] });
    await tick();
    expect(ctx.agent.started[0]?.prompt).toBe("[attached file: C:\\media\\shot.png]");
  });

  it("routes a task into a project's pinned session", async () => {
    ctx = makeApp([{ name: "demo", path: "/tmp/demo", session: "ses_pinned" }]);
    await ctx.app.start();
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "add a retry"));
    await tick();
    expect(ctx.agent.started[0]?.sessionId).toBe("ses_pinned");
  });

  it("asks with a Signal poll and resolves a vote into a prompt", async () => {
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "do work"));
    await tick();
    const taskId = ctx.agent.started[0]!.taskId;

    ctx.agent.emit({ type: "choices", taskId, at: Date.now(), choices: ["retry", "revert"] });
    await tick();
    const poll = ctx.signal.polls.at(-1)!;
    expect(poll.options).toEqual(["retry", "revert"]);
    expect(poll.question).toContain("demo");
    expect(poll.question).toContain("pick one");

    ctx.signal.emitPollVote({
      channelId: projectChannel(ctx),
      targetId: poll.messageId,
      indexes: [2],
      at: Date.now(),
    });
    await tick();
    expect(ctx.agent.started.at(-1)?.prompt).toBe("revert");
  });

  it("takes several poll options at once", async () => {
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "do work"));
    await tick();
    const taskId = ctx.agent.started[0]!.taskId;
    ctx.agent.emit({
      type: "choices",
      taskId,
      at: Date.now(),
      choices: ["one", "two", "three"],
    });
    await tick();
    const poll = ctx.signal.polls.at(-1)!;

    ctx.signal.emitPollVote({
      channelId: projectChannel(ctx),
      targetId: poll.messageId,
      indexes: [1, 3],
      at: Date.now(),
    });
    await tick();
    expect(ctx.agent.started.slice(1).map((t) => t.prompt)).toEqual(["one", "three"]);
  });

  it("ignores a vote on a question that was already answered, with a warning once", async () => {
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "do work"));
    await tick();
    const taskId = ctx.agent.started[0]!.taskId;
    ctx.agent.emit({ type: "choices", taskId, at: Date.now(), choices: ["one", "two"] });
    await tick();
    const poll = ctx.signal.polls.at(-1)!;

    ctx.signal.emitPollVote({
      channelId: projectChannel(ctx),
      targetId: poll.messageId,
      indexes: [1],
      at: Date.now(),
    });
    await tick();
    const started = ctx.agent.started.length;

    // Changing the pick afterwards must not start anything else, but must say so.
    ctx.signal.emitPollVote({
      channelId: projectChannel(ctx),
      targetId: poll.messageId,
      indexes: [2],
      at: Date.now(),
    });
    ctx.signal.emitPollVote({
      channelId: projectChannel(ctx),
      targetId: poll.messageId,
      indexes: [2],
      at: Date.now(),
    });
    await tick();
    expect(ctx.agent.started).toHaveLength(started);
    const notices = ctx.signal.sent.filter((m) => m.text.includes("already answered"));
    expect(notices).toHaveLength(1);
  });

  it("leaves the menu open when a vote is retracted", async () => {
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "do work"));
    await tick();
    const taskId = ctx.agent.started[0]!.taskId;
    ctx.agent.emit({ type: "choices", taskId, at: Date.now(), choices: ["one", "two"] });
    await tick();
    const poll = ctx.signal.polls.at(-1)!;

    ctx.signal.emitPollVote({
      channelId: projectChannel(ctx),
      targetId: poll.messageId,
      indexes: [],
      at: Date.now(),
    });
    await tick();
    expect(ctx.agent.started).toHaveLength(1);

    // Still answerable afterwards.
    ctx.signal.emitPollVote({
      channelId: projectChannel(ctx),
      targetId: poll.messageId,
      indexes: [1],
      at: Date.now(),
    });
    await tick();
    expect(ctx.agent.started.at(-1)?.prompt).toBe("one");
  });

  it("falls back to a text menu when the transport cannot send polls", async () => {
    ctx.signal.failPolls = true;
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "do work"));
    await tick();
    const taskId = ctx.agent.started[0]!.taskId;

    ctx.agent.emit({ type: "choices", taskId, at: Date.now(), choices: ["retry", "revert"] });
    await tick();
    expect(ctx.signal.polls).toHaveLength(0);
    const menu = ctx.signal.sent.find((m) => m.text.includes("tap a reaction"));
    expect(menu?.text).toContain("1. ❤️ retry");

    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "2"));
    await tick();
    expect(ctx.agent.started.at(-1)?.prompt).toBe("revert");
  });

  it("resolves a reaction on a poll menu into a prompt", async () => {
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "do work"));
    await tick();
    const taskId = ctx.agent.started[0]!.taskId;

    ctx.agent.emit({ type: "choices", taskId, at: Date.now(), choices: ["retry", "revert"] });
    await tick();
    const poll = ctx.signal.polls.at(-1)!;
    expect(poll.question).toBe("demo — pick one");

    // Reacting to the poll message still picks an option.
    ctx.signal.emitReaction({
      channelId: projectChannel(ctx),
      sender: "+1000",
      emoji: "👍",
      targetId: poll.messageId,
      at: Date.now(),
    });
    await tick();
    expect(ctx.agent.started).toHaveLength(2);
    expect(ctx.agent.started[1]?.prompt).toBe("revert");
  });

  it("accepts a bare number as a pick while exactly one menu is open", async () => {
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "do work"));
    await tick();
    const taskId = ctx.agent.started[0]!.taskId;
    ctx.agent.emit({ type: "choices", taskId, at: Date.now(), choices: ["retry", "revert"] });
    await tick();

    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "1"));
    await tick();
    expect(ctx.agent.started[1]?.prompt).toBe("retry");
  });

  it("accepts a list of numbers as multiple picks", async () => {
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "do work"));
    await tick();
    const taskId = ctx.agent.started[0]!.taskId;
    ctx.agent.emit({
      type: "choices",
      taskId,
      at: Date.now(),
      choices: ["one", "two", "three", "four"],
    });
    await tick();

    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "1, 3 4"));
    await tick();
    expect(ctx.agent.started.slice(1).map((t) => t.prompt)).toEqual(["one", "three", "four"]);
  });

  it("reports a number list entry that is out of range instead of starting a task", async () => {
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "do work"));
    await tick();
    const taskId = ctx.agent.started[0]!.taskId;
    ctx.agent.emit({ type: "choices", taskId, at: Date.now(), choices: ["one", "two"] });
    await tick();

    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "1,9"));
    await tick();
    expect(ctx.agent.started).toHaveLength(1);
    expect(ctx.signal.sent.at(-1)?.text).toContain("has no choice 9");
  });

  it("leaves digits alone when no menu is open", async () => {
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "7"));
    await tick();
    expect(ctx.agent.started[0]?.prompt).toBe("7");
  });

  it("resolves numbers against the newest menu and closes menus when you move on", async () => {
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "do work"));
    await tick();
    const taskId = ctx.agent.started[0]!.taskId;

    // A menu on a finished task must survive, or asking at the end of a turn
    // would delete the menu the operator is about to tap.
    ctx.agent.emit({ type: "choices", taskId, at: Date.now(), choices: ["one", "two"] });
    await tick();
    ctx.agent.emit({ type: "idle", taskId, at: Date.now(), summary: "done" });
    await tick();

    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "2"));
    await tick();
    expect(ctx.agent.started.at(-1)?.prompt).toBe("two");

    // More than one menu open: numbers answer the newest.
    const second = ctx.agent.started.at(-1)!.taskId;
    ctx.agent.emit({ type: "choices", taskId, at: Date.now(), choices: ["alpha", "beta"] });
    ctx.agent.emit({ type: "choices", taskId: second, at: Date.now(), choices: ["gamma", "delta"] });
    await tick();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "1"));
    await tick();
    expect(ctx.agent.started.at(-1)?.prompt).toBe("gamma");

    // Free-form text closes any remaining menu.
    ctx.agent.emit({ type: "choices", taskId: second, at: Date.now(), choices: ["one", "two"] });
    await tick();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "unrelated prompt"));
    await tick();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "1"));
    await tick();
    expect(ctx.agent.started.at(-1)?.prompt).toBe("1");
  });

  it("ignores a reaction that is not a choice", async () => {
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "do work"));
    await tick();
    const taskId = ctx.agent.started[0]!.taskId;
    ctx.agent.emit({ type: "choices", taskId, at: Date.now(), choices: ["retry", "revert"] });
    await tick();
    const poll = ctx.signal.polls.at(-1)!;

    ctx.signal.emitReaction({
      channelId: projectChannel(ctx),
      sender: "+1000",
      emoji: "🎉",
      targetId: poll.messageId,
      at: Date.now(),
    });
    await tick();
    expect(ctx.agent.started).toHaveLength(1);
  });

  it("asks for a decision instead of starting a task while an approval waits", async () => {
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "do work"));
    await tick();
    const taskId = ctx.agent.started[0]!.taskId;
    ctx.agent.emit({
      type: "permission",
      taskId,
      at: Date.now(),
      permission: { id: "p1", taskId, tool: "websearch", description: "search", safe: false },
    });
    await tick();

    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "Approve always"));
    await tick();
    // The dialog's wording is understood as an approval, not a new task.
    expect(ctx.agent.decisions).toEqual([{ permissionId: "p1", decision: "always" }]);
    expect(ctx.agent.started).toHaveLength(1);
  });

  it("asks once per permission request, even if opencode re-reports it", async () => {
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "do work"));
    await tick();
    const taskId = ctx.agent.started[0]!.taskId;
    const permission = {
      type: "permission" as const,
      taskId,
      at: Date.now(),
      permission: { id: "p1", taskId, tool: "webfetch", description: "fetch", safe: false },
    };

    ctx.agent.emit(permission);
    await tick();
    ctx.agent.emit({ ...permission, at: Date.now() });
    ctx.agent.emit({ ...permission, at: Date.now() });
    await tick();

    expect(ctx.signal.sent.filter((m) => m.text.includes("Approval needed"))).toHaveLength(1);
  });

  it("lists models as a poll and switches the session on a pick", async () => {
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "/models"));
    await tick();

    const poll = ctx.signal.polls.at(-1)!;
    expect(poll.options).toEqual(["DeepSeek V4.1 Flash", "Muse Spark 1.2"]);
    expect(poll.question).toContain("demo");

    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "2"));
    await tick();
    expect(ctx.agent.modelSwitches).toEqual([
      { projectId: "demo", sessionId: "", model: { providerID: "opencode", id: "muse-spark-1.2" } },
    ]);
    expect(ctx.signal.sent.some((m) => m.text.includes("opencode/muse-spark-1.2"))).toBe(true);
  });

  it("switches directly with /model provider/id", async () => {
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "/model opencode-go/deepseek-v4.1-flash"));
    await tick();
    expect(ctx.agent.modelSwitches.at(-1)?.model).toEqual({
      providerID: "opencode-go",
      id: "deepseek-v4.1-flash",
    });
  });

  it("does not claim a model switch that the plugin rejected", async () => {
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.agent.failModelSet = true;
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "/model opencode/muse-spark-1.2"));
    await tick();
    expect(ctx.signal.sent.at(-1)?.text).toContain("Could not switch the model");
    expect(ctx.signal.sent.some((m) => m.text.includes("Model: opencode/"))).toBe(false);
  });

  it("reports a model list it cannot read instead of going quiet", async () => {
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.agent.listModels = async () => {
      throw new Error("model selection needs the plugin agent mode");
    };
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "/models"));
    await tick();
    expect(ctx.signal.sent.at(-1)?.text).toContain("Could not read the model list");
  });

  it("rejects a /model argument that is not a provider/id pair", async () => {
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "/model nonsense"));
    await tick();
    expect(ctx.signal.sent.at(-1)?.text).toContain("Usage: /model");
  });

  it("forwards a permission and resolves it with approve", async () => {
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "do work"));
    await tick();
    const taskId = ctx.agent.started[0]!.taskId;

    ctx.agent.emit({
      type: "permission",
      taskId,
      at: Date.now(),
      permission: { id: "p1", taskId, tool: "bash", description: "run ls", safe: false },
    });
    await tick();
    expect(ctx.signal.sent.some((m) => m.text.includes("Approval needed"))).toBe(true);

    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "approve"));
    await tick();
    expect(ctx.agent.decisions).toEqual([{ permissionId: "p1", decision: "once" }]);
  });

  it("auto-allows a safe permission without a prompt", async () => {
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "do work"));
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
    expect(ctx.signal.sent.some((m) => m.text.includes("Permission"))).toBe(false);
  });

  it("completes a task on idle and edits the status message in place", async () => {
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "do work"));
    await tick();
    const taskId = ctx.agent.started[0]!.taskId;
    const statusMsg = ctx.signal.sent.find((m) => m.text.startsWith("Task "))!;

    ctx.agent.emit({ type: "status", taskId, at: Date.now(), text: "editing src/http.ts" });
    await tick();
    expect(ctx.signal.sent.find((m) => m.messageId === statusMsg.messageId)?.edited).toBe(true);

    ctx.agent.emit({ type: "idle", taskId, at: Date.now(), summary: "added retry" });
    await tick();
    expect(ctx.signal.sent.at(-1)?.text).toContain("added retry");
    expect(ctx.signal.sent.at(-1)?.text).toContain("Done");
  });

  it("resolves a permission via a reaction", async () => {
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "do work"));
    await tick();
    const taskId = ctx.agent.started[0]!.taskId;
    ctx.agent.emit({
      type: "permission",
      taskId,
      at: Date.now(),
      permission: { id: "p3", taskId, tool: "bash", description: "run rm", safe: false },
    });
    await tick();
    const prompt = ctx.signal.sent.find((m) => m.text.includes("Approval needed"))!;

    ctx.signal.emitReaction({
      channelId: projectChannel(ctx),
      sender: "+1000",
      emoji: "👎",
      targetId: prompt.messageId,
      at: Date.now(),
    });
    await tick();
    expect(ctx.agent.decisions).toEqual([{ permissionId: "p3", decision: "reject" }]);
  });

  it("introduces a project's group once, and sends its work with no quote", async () => {
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    const greeting = ctx.signal.sent.find((m) => m.text.includes("this group is for this project"))!;
    expect(greeting.channelId).toBe("group-1-demo");

    ctx.signal.emitMessage(incoming("do work"));
    await tick();
    const status = ctx.signal.sent.find((m) => m.text.startsWith("Task "))!;
    expect(status.quote).toBeUndefined();
    expect(status.text).not.toContain("Project:");
  });

  it("greets on project connect and routes a quoted reply to that project", async () => {
    await ctx.app.notifyProjectConnected("demo");
    await tick();
    const greeting = ctx.signal.sent.at(-1)!;
    expect(greeting.text).toBe("demo is connected. Send /open demo to work on it in its own group.");

    // A reply that quotes the greeting routes the free-form text to demo.
    ctx.signal.emitMessage({ ...incoming("add a retry"), quoteId: greeting.messageId });
    await tick();
    expect(ctx.agent.started).toHaveLength(1);
    expect(ctx.agent.started[0]?.prompt).toBe("add a retry");
    expect(ctx.agent.started[0]?.project.id).toBe("demo");
  });
});
