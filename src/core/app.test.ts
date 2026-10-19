import { beforeEach, describe, expect, it } from "vitest";
import { FakeAgent } from "../adapters/fakes/fakeAgent.js";
import { FakeMeeting } from "../adapters/fakes/fakeMeeting.js";
import { FakeSignal } from "../adapters/fakes/fakeSignal.js";
import { FakeVoice } from "../adapters/fakes/fakeVoice.js";
import { ConfigSchema } from "../config/config.js";
import type { LauncherPort, MeetingPort, VoicePort } from "./ports.js";
import { nullLogger, type Logger } from "../logging/logger.js";
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
  meeting?: MeetingPort,
  probeRoom?: (link: URL) => Promise<boolean>,
  logger?: Logger,
  voice?: VoicePort,
  options: { now?: () => number; watchdogMs?: number } = {},
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
    logger: logger ?? nullLogger(),
    ...(launcher ? { launcher } : {}),
    ...(meeting ? { meeting } : {}),
    ...(probeRoom ? { probeRoom } : {}),
    ...(voice ? { voice } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.watchdogMs !== undefined ? { watchdogMs: options.watchdogMs } : {}),
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

/** A logger that keeps every line, so a test can inspect what was written. */
class CapturingLogger implements Logger {
  readonly lines: string[] = [];
  private record(level: string, msg: string, fields?: Record<string, unknown>): void {
    this.lines.push(JSON.stringify({ level, msg, ...fields }));
  }
  debug(msg: string, fields?: Record<string, unknown>): void {
    this.record("debug", msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.record("info", msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.record("warn", msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.record("error", msg, fields);
  }
}

/**
 * A message arriving in a specific channel — used for answers that belong to a
 * project's own group (menus, approvals) rather than the control channel.
 */
function incomingIn(
  channelId: string,
  text: string,
  inControlChannel = false,
  delivery: "data" | "sync" = "data",
) {
  return {
    id: String(Math.random()),
    channelId,
    sender: "+1000",
    text,
    at: Date.now(),
    inControlChannel,
    delivery,
  };
}

/**
 * A message from the operator. Control commands arrive in the control channel;
 * everything else arrives where the project's conversation lives — its own group
 * once `/open` has created one, which is how the operator actually works now.
 * `delivery` defaults to the network path; a phone paste is "sync".
 */
function incoming(text: string, delivery: "data" | "sync" = "data") {
  const general = /^\/(open|projects|help)\b/.test(text.trim());
  const channelId = general ? "self" : storeRef?.getChannel("demo")?.channelId ?? "self";
  return {
    id: String(Math.random()),
    channelId,
    sender: "+1000",
    text,
    at: Date.now(),
    inControlChannel: channelId === "self",
    delivery,
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
    const status = ctx.signal.sent.find((m) => m.text.includes("Task "))!;
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
    expect(ctx.signal.sent.some((m) => m.text.includes("Task "))).toBe(true);
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
    expect(poll.question).toContain("demo — pick one");

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
    const statusMsg = ctx.signal.sent.find((m) => m.text.includes("Task "))!;

    ctx.agent.emit({ type: "status", taskId, at: Date.now(), text: "editing src/http.ts" });
    await tick();
    expect(ctx.signal.sent.find((m) => m.messageId === statusMsg.messageId)?.edited).toBe(true);

    ctx.agent.emit({ type: "idle", taskId, at: Date.now(), summary: "added retry" });
    await tick();
    expect(ctx.signal.sent.at(-1)?.text).toContain("added retry");
    expect(ctx.signal.sent.at(-1)?.text).toContain("Done");
  });

  it("keeps the agent's words out of the status line, so the answer is read once", async () => {
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "do work"));
    await tick();
    const taskId = ctx.agent.started[0]!.taskId;
    const answer = "added a retry with backoff";

    ctx.agent.emit({ type: "status", taskId, at: Date.now(), text: answer });
    await tick();
    ctx.agent.emit({ type: "idle", taskId, at: Date.now(), summary: answer });
    await tick();

    // The answer travels in one new completion message and nowhere else: a copy
    // inside the status message made the operator read the same text twice.
    const carrying = ctx.signal.ops.filter((op) => "text" in op && op.text.includes(answer));
    expect(carrying.map((op) => op.op)).toEqual(["send"]);
    const messages = ctx.signal.sent.filter((m) => m.text.includes(answer));
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toContain("Done");
  });

  it("still shows the tool the agent is running in the status line", async () => {
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "do work"));
    await tick();
    const taskId = ctx.agent.started[0]!.taskId;
    const statusMsg = ctx.signal.sent.find((m) => m.text.includes("Task "))!;

    ctx.agent.emit({ type: "tool", taskId, at: Date.now(), tool: "bash" });
    await tick();

    const edited = ctx.signal.sent.find((m) => m.messageId === statusMsg.messageId)!;
    expect(edited.text).toContain("bash");
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
    const status = ctx.signal.sent.find((m) => m.text.includes("Task "))!;
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

describe("meetings", () => {
  const LINK = "https://meet.jit.si/room-abc";
  /** The demo project, with the operator listed so a paste may be honoured. */
  const PROJECTS = [
    { name: "demo", path: "/tmp/demo", meet: { allow: [{ id: "+1000", label: "+1000" }], providers: ["meet.jit.si"] } },
  ];
  /** The reachability probe is faked: the gate's tests never touch the network. */
  const reachable = async (): Promise<boolean> => true;
  let meeting: FakeMeeting;
  let ctx: ReturnType<typeof makeApp>;

  /** A started app whose demo project already owns its own group. */
  async function openProject(): Promise<void> {
    meeting = new FakeMeeting();
    ctx = makeApp(PROJECTS, {}, undefined, meeting, reachable);
    await ctx.app.start();
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
  }

  const meetingMessage = () =>
    ctx.signal.sent.find((m) => m.text.includes("Meeting ·"));

  it("joins the link, holds it in the row and edits one message through the lifecycle", async () => {
    await openProject();

    ctx.signal.emitMessage(incoming(`/meet ${LINK}`));
    await tick();
    await tick();

    expect(meeting.joins).toEqual([{ projectId: "demo", projectName: "demo", link: LINK }]);
    expect(ctx.store.getOpenMeeting()).toEqual({
      projectId: "demo",
      link: LINK,
      startedAt: expect.any(Number),
    });

    // One message, in the project's own group, and it never carries the link.
    const message = meetingMessage()!;
    expect(message.channelId).toBe("group-1-demo");
    expect(message.text).toContain("joining as demo");
    expect(ctx.signal.sent.filter((m) => m.text.includes("Meeting ·"))).toHaveLength(1);
    expect(ctx.signal.sent.every((m) => !m.text.includes("meet.jit.si"))).toBe(true);

    meeting.admit();
    await tick();

    // The same message is edited in place, not repeated.
    expect(meetingMessage()).toBe(message);
    expect(message.edited).toBe(true);
    expect(message.text).toContain("in the room as demo");
    expect(ctx.signal.sent.filter((m) => m.text.includes("Meeting ·"))).toHaveLength(1);

    await ctx.app.stop();
  });

  it("shows the project's current task state in the in-room message", async () => {
    await openProject();
    ctx.signal.emitMessage(incoming("add a retry"));
    await tick();
    const taskId = ctx.agent.started[0]!.taskId;

    ctx.signal.emitMessage(incoming(`/meet ${LINK}`));
    await tick();
    await tick();
    meeting.admit();
    await tick();

    const text = meetingMessage()?.text ?? "";
    expect(text).toContain("in the room");
    expect(text).toContain(taskId.slice(0, 8));
    await ctx.app.stop();
  });

  it("refuses a second link with the holding project and its start time", async () => {
    await openProject();
    ctx.signal.emitMessage(incoming(`/meet ${LINK}`));
    await tick();
    await tick();
    const joins = meeting.joins.length;

    ctx.signal.emitMessage(incoming("/meet https://meet.jit.si/second"));
    await tick();

    expect(meeting.joins).toHaveLength(joins);
    const refusal = ctx.signal.sent.at(-1)!;
    expect(refusal.text).toContain("already open in demo");
    expect(refusal.text).toMatch(/started \d{2}:\d{2}:\d{2}/);
    expect(refusal.text).not.toContain("meet.jit.si");
    expect(ctx.store.getOpenMeeting()?.link).toBe(LINK);
    await ctx.app.stop();
  });

  it("refuses the same link twice as one paste, without a second join", async () => {
    await openProject();
    ctx.signal.emitMessage(incoming(`/meet ${LINK}`));
    await tick();
    await tick();

    ctx.signal.emitMessage(incoming(`/meet ${LINK}`));
    await tick();

    expect(meeting.joins).toHaveLength(1);
    const refusal = ctx.signal.sent.at(-1)!;
    expect(refusal.text).toContain("already open in demo");
    expect(refusal.text).not.toContain("meet.jit.si");
    expect(ctx.store.getOpenMeeting()?.link).toBe(LINK);
    await ctx.app.stop();
  });

  it("names the open meeting before probing an unreachable link", async () => {
    meeting = new FakeMeeting();
    // The probe would refuse this link as unreachable; the open meeting must win.
    ctx = makeApp(PROJECTS, {}, undefined, meeting, async () => false);
    await ctx.app.start();
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.store.claimMeeting({ projectId: "demo", link: LINK, startedAt: Date.now() });

    ctx.signal.emitMessage(incoming(`/meet ${LINK}`));
    await tick();

    const refusal = ctx.signal.sent.at(-1)!;
    expect(refusal.text).toContain("already open in demo");
    expect(refusal.text).not.toContain("Could not reach the room");
    expect(meeting.joins).toHaveLength(0);
    expect(meeting.availableCalls).toBe(0);
    await ctx.app.stop();
  });

  it("refuses a link sent from another project while a meeting is open", async () => {
    meeting = new FakeMeeting();
    ctx = makeApp(
      [
        { name: "demo", path: "/tmp/demo", meet: { allow: [{ id: "+1000" }], providers: ["meet.jit.si"] } },
        { name: "other", path: "/tmp/other", meet: { allow: [{ id: "+1000" }], providers: ["meet.jit.si"] } },
      ],
      {},
      undefined,
      meeting,
      reachable,
    );
    await ctx.app.start();
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incoming(`/meet ${LINK}`));
    await tick();
    await tick();
    ctx.signal.emitMessage(incoming("/open other"));
    await tick();

    ctx.signal.emitMessage(
      incomingIn("group-2-other", "/meet https://meet.jit.si/third"),
    );
    await tick();

    expect(meeting.joins).toHaveLength(1);
    const refusal = ctx.signal.sent.at(-1)!;
    expect(refusal.channelId).toBe("group-2-other");
    expect(refusal.text).toContain("already open in demo");
    expect(ctx.store.getOpenMeeting()?.link).toBe(LINK);
    await ctx.app.stop();
  });

  it("asks for usage on a bare /meet and writes no row", async () => {
    await openProject();
    ctx.signal.emitMessage(incoming("/meet"));
    await tick();
    expect(ctx.signal.sent.at(-1)?.text).toContain("Usage: /meet");
    expect(ctx.store.getOpenMeeting()).toBeUndefined();
    expect(meeting.joins).toHaveLength(0);
  });

  it("asks for a project before joining", async () => {
    meeting = new FakeMeeting();
    ctx = makeApp(undefined, {}, undefined, meeting);
    await ctx.app.start();

    ctx.signal.emitMessage(incomingIn("self", `/meet ${LINK}`, true));
    await tick();
    expect(ctx.signal.sent.at(-1)?.text).toContain("No project here");
    expect(meeting.joins).toHaveLength(0);
    expect(ctx.store.getOpenMeeting()).toBeUndefined();
  });

  it("refuses before claiming a row when no browser is installed", async () => {
    meeting = new FakeMeeting();
    meeting.unavailableReason = "neither Chrome nor Edge was found on this machine";
    ctx = makeApp(PROJECTS, {}, undefined, meeting, reachable);
    await ctx.app.start();
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();

    ctx.signal.emitMessage(incoming(`/meet ${LINK}`));
    await tick();

    expect(ctx.signal.sent.at(-1)?.text).toContain("neither Chrome nor Edge was found");
    expect(meeting.joins).toHaveLength(0);
    expect(ctx.store.getOpenMeeting()).toBeUndefined();
  });

  it("refuses a paste from a sender who is not configured, naming them", async () => {
    await openProject();

    ctx.signal.emitMessage({
      id: "stranger-1",
      channelId: projectChannel(ctx),
      sender: "+2000",
      text: `/meet ${LINK}`,
      at: Date.now(),
      inControlChannel: false,
      delivery: "data",
    });
    await tick();

    const refusal = ctx.signal.sent.at(-1)!;
    expect(refusal.text).toContain("Not authorised");
    expect(refusal.text).toContain("+2000");
    expect(refusal.text).not.toContain("meet.jit.si");
    expect(ctx.store.getOpenMeeting()).toBeUndefined();
    expect(meeting.joins).toHaveLength(0);
    // A refused paste must not even ask whether a browser is available.
    expect(meeting.availableCalls).toBe(0);
  });

  it("refuses every paste when no identities are configured, never accepting by default", async () => {
    meeting = new FakeMeeting();
    // The default project carries no `meet.allow`, so the gate must fail closed.
    ctx = makeApp(undefined, {}, undefined, meeting, reachable);
    await ctx.app.start();
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();

    ctx.signal.emitMessage(incoming(`/meet ${LINK}`, "sync"));
    await tick();

    expect(ctx.signal.sent.at(-1)?.text).toContain(
      "No accepted identities are configured for demo",
    );
    expect(ctx.signal.sent.at(-1)?.text).not.toContain("meet.jit.si");
    expect(ctx.store.getOpenMeeting()).toBeUndefined();
    expect(meeting.joins).toHaveLength(0);
  });

  it("refuses a revoked identity as not authorised", async () => {
    meeting = new FakeMeeting();
    ctx = makeApp(
      [
        {
          name: "demo",
          path: "/tmp/demo",
          meet: { allow: [{ id: "+1000", label: "+1000", revokedAt: "2000-01-01T00:00:00Z" }], providers: ["meet.jit.si"] },
        },
      ],
      {},
      undefined,
      meeting,
      reachable,
    );
    await ctx.app.start();
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();

    ctx.signal.emitMessage(incoming(`/meet ${LINK}`));
    await tick();

    expect(ctx.signal.sent.at(-1)?.text).toContain("Not authorised");
    expect(ctx.store.getOpenMeeting()).toBeUndefined();
    expect(meeting.joins).toHaveLength(0);
  });

  it("refuses a malformed link and a foreign provider with their own categories", async () => {
    await openProject();

    ctx.signal.emitMessage(incoming("/meet not-a-link"));
    await tick();
    expect(ctx.signal.sent.at(-1)?.text).toContain("Malformed link");

    ctx.signal.emitMessage(incoming("/meet http://meet.jit.si/room"));
    await tick();
    expect(ctx.signal.sent.at(-1)?.text).toContain("Malformed link");

    ctx.signal.emitMessage(incoming("/meet https://zoom.us/j/secret"));
    await tick();
    const foreign = ctx.signal.sent.at(-1)!;
    expect(foreign.text).toContain("Not the configured meeting provider");
    expect(foreign.text).not.toContain("zoom.us");

    expect(ctx.store.getOpenMeeting()).toBeUndefined();
    expect(meeting.joins).toHaveLength(0);
    expect(ctx.signal.sent.every((m) => !m.text.includes("zoom.us"))).toBe(true);
  });

  it("refuses an unreachable room without claiming the slot", async () => {
    meeting = new FakeMeeting();
    ctx = makeApp(PROJECTS, {}, undefined, meeting, async () => false);
    await ctx.app.start();
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();

    ctx.signal.emitMessage(incoming(`/meet ${LINK}`));
    await tick();

    const refusal = ctx.signal.sent.at(-1)!;
    expect(refusal.text).toContain("Could not reach the room");
    expect(refusal.text).not.toContain("meet.jit.si");
    expect(ctx.store.getOpenMeeting()).toBeUndefined();
    expect(meeting.joins).toHaveLength(0);
  });

  it("checks the gate before the browser, so a stranger is named first", async () => {
    meeting = new FakeMeeting();
    meeting.unavailableReason = "neither Chrome nor Edge was found on this machine";
    ctx = makeApp(PROJECTS, {}, undefined, meeting, reachable);
    await ctx.app.start();
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();

    ctx.signal.emitMessage({
      id: "stranger-2",
      channelId: projectChannel(ctx),
      sender: "+2000",
      text: `/meet ${LINK}`,
      at: Date.now(),
      inControlChannel: false,
      delivery: "data",
    });
    await tick();

    const refusal = ctx.signal.sent.at(-1)!;
    expect(refusal.text).toContain("Not authorised");
    expect(refusal.text).not.toContain("neither Chrome nor Edge");
    expect(meeting.joins).toHaveLength(0);
  });

  it("accepts a sync paste as the operator's own device", async () => {
    meeting = new FakeMeeting();
    // The configured entry is a different number: the sync path is trusted by
    // construction, so it must still pass.
    ctx = makeApp(
      [{ name: "demo", path: "/tmp/demo", meet: { allow: [{ id: "+9999" }], providers: ["meet.jit.si"] } }],
      {},
      undefined,
      meeting,
      reachable,
    );
    await ctx.app.start();
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();

    ctx.signal.emitMessage(incoming(`/meet ${LINK}`, "sync"));
    await tick();
    await tick();

    expect(meeting.joins.at(-1)?.link).toBe(LINK);
    await ctx.app.stop();
  });

  it("honours a project's configured provider hosts", async () => {
    meeting = new FakeMeeting();
    ctx = makeApp(
      [
        {
          name: "demo",
          path: "/tmp/demo",
          meet: { allow: [{ id: "+1000" }], providers: ["meet.example"] },
        },
      ],
      {},
      undefined,
      meeting,
      reachable,
    );
    await ctx.app.start();
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();

    ctx.signal.emitMessage(incoming("/meet https://meet.example/room"));
    await tick();
    await tick();

    expect(meeting.joins.at(-1)?.link).toBe("https://meet.example/room");
    await ctx.app.stop();
  });

  it("keeps the link out of the log as well as out of the group", async () => {
    const logger = new CapturingLogger();
    meeting = new FakeMeeting();
    ctx = makeApp(PROJECTS, {}, undefined, meeting, reachable, logger);
    await ctx.app.start();
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();

    ctx.signal.emitMessage(incoming(`/meet ${LINK}`, "sync"));
    await tick();
    await tick();
    ctx.signal.emitMessage(incoming("/meet https://zoom.us/j/secret"));
    await tick();

    const log = logger.lines.join("\n");
    expect(log).not.toContain("meet.jit.si");
    expect(log).not.toContain("zoom.us");
    expect(ctx.signal.sent.every((m) => !m.text.includes("meet.jit.si"))).toBe(true);
    expect(ctx.signal.sent.every((m) => !m.text.includes("zoom.us"))).toBe(true);
    await ctx.app.stop();
  });

  it("leaves on /meet stop, wipes the link and posts exactly one summary", async () => {
    await openProject();
    ctx.signal.emitMessage(incoming(`/meet ${LINK}`));
    await tick();
    await tick();
    meeting.admit();
    await tick();
    const message = meetingMessage()!;

    ctx.signal.emitMessage(incoming("/meet stop"));
    await tick();
    await tick();

    expect(meeting.leaves).toEqual(["demo"]);
    expect(ctx.store.getOpenMeeting()).toBeUndefined();
    expect(message.text).toContain("left by /meet stop");

    const summaries = ctx.signal.sent.filter((m) => m.text.includes("Meeting ended"));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.text).toContain("left by /meet stop");
    expect(summaries[0]!.text).toMatch(/\d+s/);
    expect(summaries[0]!.text.startsWith("🟢")).toBe(true);

    // A later stop only says it is over: no second summary, no second leave.
    ctx.signal.emitMessage(incoming("/meet stop"));
    await tick();
    expect(ctx.signal.sent.at(-1)?.text).toContain("No meeting is running");
    expect(ctx.signal.sent.filter((m) => m.text.includes("Meeting ended"))).toHaveLength(1);
    await ctx.app.stop();
  });

  it("says the room may still be open when the browser survives leave", async () => {
    await openProject();
    meeting.surviveLeave = true;
    ctx.signal.emitMessage(incoming(`/meet ${LINK}`));
    await tick();
    await tick();
    ctx.signal.emitMessage(incoming("/meet stop"));
    await tick();
    await tick();

    const summary = ctx.signal.sent.find((m) => m.text.includes("Meeting ended"))!;
    expect(summary.text).toContain("the browser may still be open");
    expect(summary.text.startsWith("🔴")).toBe(true);
    expect(ctx.store.getOpenMeeting()).toBeUndefined();
    await ctx.app.stop();
  });

  it("closes a stale row on stop even when no handle is left", async () => {
    await openProject();
    ctx.store.claimMeeting({
      projectId: "demo",
      link: LINK,
      startedAt: Date.now() - 5_000,
    });

    ctx.signal.emitMessage(incoming("/meet stop"));
    await tick();

    expect(ctx.store.getOpenMeeting()).toBeUndefined();
    const summary = ctx.signal.sent.at(-1)!;
    expect(summary.text).toContain("ended without a live browser");
    expect(summary.text).not.toContain("meet.jit.si");
    expect(meeting.leaves).toHaveLength(0);
  });

  it("closes the row and names the reason when the join fails", async () => {
    await openProject();
    meeting.failJoin = true;

    ctx.signal.emitMessage(incoming(`/meet ${LINK}`));
    await tick();
    await tick();

    expect(ctx.store.getOpenMeeting()).toBeUndefined();
    expect(meetingMessage()?.text).toContain("could not start the avatar browser");
    const summary = ctx.signal.sent.find((m) => m.text.includes("Meeting ended"))!;
    expect(summary.text).toContain("could not start the avatar browser");
    expect(summary.text.startsWith("🔴")).toBe(true);
    await ctx.app.stop();
  });

  it("takes the same terminal path when the browser ends by itself", async () => {
    await openProject();
    ctx.signal.emitMessage(incoming(`/meet ${LINK}`));
    await tick();
    await tick();
    meeting.admit();
    await tick();

    meeting.die("the call ended");
    await tick();
    await tick();

    expect(ctx.store.getOpenMeeting()).toBeUndefined();
    const summaries = ctx.signal.sent.filter((m) => m.text.includes("Meeting ended"));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.text).toContain("the call ended");
    expect(summaries[0]!.text).toMatch(/\d+s/);
    await ctx.app.stop();
  });

  it("reports the admission timeout as one terminal outcome", async () => {
    await openProject();
    ctx.signal.emitMessage(incoming(`/meet ${LINK}`));
    await tick();
    await tick();

    meeting.fail("nobody admitted the avatar within 90 s");
    await tick();
    await tick();

    expect(ctx.store.getOpenMeeting()).toBeUndefined();
    const summary = ctx.signal.sent.find((m) => m.text.includes("Meeting ended"))!;
    expect(summary.text).toContain("nobody admitted the avatar within 90 s");
    expect(summary.text.startsWith("🔴")).toBe(true);
    await ctx.app.stop();
  });

  it("reports a face that stops publishing without ending the meeting", async () => {
    await openProject();
    ctx.signal.emitMessage(incoming(`/meet ${LINK}`));
    await tick();
    await tick();
    meeting.admit();
    await tick();

    meeting.faceStopped();
    await tick();

    expect(meetingMessage()?.text).toContain("face not publishing");
    expect(ctx.store.getOpenMeeting()).not.toBeUndefined();
    expect(ctx.signal.sent.some((m) => m.text.includes("Meeting ended"))).toBe(false);
    await ctx.app.stop();
  });

  it("says when the room offered no join control, and keeps the meeting open", async () => {
    await openProject();
    ctx.signal.emitMessage(incoming(`/meet ${LINK}`));
    await tick();
    await tick();

    meeting.joinNeedsHelp();
    await tick();

    expect(meetingMessage()?.text).toContain("could not find the join control");
    expect(ctx.store.getOpenMeeting()).not.toBeUndefined();
    expect(ctx.signal.sent.some((m) => m.text.includes("Meeting ended"))).toBe(false);
    await ctx.app.stop();
  });

  it("does not report a failed start when the operator stops while joining", async () => {
    await openProject();
    meeting.failJoin = true;
    meeting.joinDelayMs = 30;

    ctx.signal.emitMessage(incoming(`/meet ${LINK}`));
    await tick(); // the claim is written and the join is still in flight
    ctx.signal.emitMessage(incoming("/meet stop"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    await tick();

    expect(
      ctx.signal.sent.some((m) => m.text.includes("could not start the avatar browser")),
    ).toBe(false);
    expect(ctx.store.getOpenMeeting()).toBeUndefined();
    const summaries = ctx.signal.sent.filter((m) => m.text.includes("Meeting ended"));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.text).toContain("left by /meet stop");
    expect(summaries[0]!.text.startsWith("🟢")).toBe(true);
  });

  it("ends the meeting out loud when the connector stops", async () => {
    await openProject();
    ctx.signal.emitMessage(incoming(`/meet ${LINK}`));
    await tick();
    await tick();
    meeting.admit();
    await tick();

    await ctx.app.stop();

    expect(meeting.leaves).toHaveLength(0); // the adapter's own stop path closed it
    expect(ctx.store.getOpenMeeting()).toBeUndefined();
    const summary = ctx.signal.sent.find((m) => m.text.includes("Meeting ended"));
    expect(summary?.text).toContain("the connector stopped");
    expect(summary?.text).toMatch(/\d+s/);
  });

  it("closes a row a previous run left open and says so in the project's group", async () => {
    meeting = new FakeMeeting();
    ctx = makeApp(PROJECTS, {}, undefined, meeting, reachable);
    ctx.store.upsertProject({ id: "demo", name: "demo", path: "/tmp/demo" });
    ctx.store.setChannel("demo", "group-stale", "demo");
    ctx.store.claimMeeting({
      projectId: "demo",
      link: LINK,
      startedAt: Date.now() - 60_000,
    });

    await ctx.app.start();

    expect(ctx.store.getOpenMeeting()).toBeUndefined();
    const notice = ctx.signal.sent.find((m) =>
      m.text.includes("previous run left this meeting open"),
    );
    expect(notice?.channelId).toBe("group-stale");
    expect(notice?.text).not.toContain("meet.jit.si");

    // The slot is free again in the same run.
    ctx.signal.emitMessage({
      id: "stale-1",
      channelId: "group-stale",
      sender: "+1000",
      text: `/meet ${LINK}`,
      at: Date.now(),
      inControlChannel: false,
      delivery: "sync",
    });
    await tick();
    await tick();
    expect(meeting.joins.at(-1)?.link).toBe(LINK);
    await ctx.app.stop();
  });
});

describe("voice in the meeting", () => {
  const LINK = "https://meet.jit.si/room-abc";
  /** Pinned to a session, so "the session in the store" is a fact, not a guess. */
  const PROJECTS = [
    {
      name: "demo",
      path: "/tmp/demo",
      session: "ses_pinned",
      meet: { allow: [{ id: "+1000", label: "+1000" }], providers: ["meet.jit.si"] },
    },
  ];
  const reachable = async (): Promise<boolean> => true;
  let meeting: FakeMeeting;
  let voice: FakeVoice;
  let ctx: ReturnType<typeof makeApp>;

  /** A started app whose demo project is open and whose avatar is in the room. */
  async function inRoom(options: { keepGreeting?: boolean } = {}): Promise<void> {
    meeting = new FakeMeeting();
    voice = new FakeVoice();
    ctx = makeApp(PROJECTS, {}, undefined, meeting, reachable, undefined, voice);
    await ctx.app.start();
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incoming(`/meet ${LINK}`));
    await tick();
    await tick();
    meeting.admit();
    await tick();
    await tick();
    // The join greeting is the baseline; the tests below measure what the
    // avatar says afterwards.
    if (!options.keepGreeting) voice.spoken.length = 0;
  }

  /** Everything spoken except the join greeting, which starts every meeting. */
  const said = (): string[] => voice.spoken.filter((text) => !text.startsWith("Привіт") && !text.startsWith("До зустрічі"));

  it("greets the room once it is listening", async () => {
    await inRoom({ keepGreeting: true });
    expect(voice.spoken[0]).toContain("під'єднався");
    await ctx.app.stop();
  });

  it("says goodbye when the operator stops the meeting", async () => {
    await inRoom();
    ctx.signal.emitMessage(incoming("/meet stop"));
    await tick();
    await tick();
    expect(voice.spoken).toContain("До зустрічі!");
    await ctx.app.stop();
  });

  it("shows the agent's work on the avatar", async () => {
    await inRoom();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "do work"));
    await tick();
    const taskId = ctx.agent.started.at(-1)!.taskId;

    ctx.agent.emit({ type: "tool", taskId, at: Date.now(), tool: "read" });
    await tick();
    ctx.agent.emit({ type: "tool", taskId, at: Date.now(), tool: "edit" });
    await tick();
    ctx.agent.emit({ type: "idle", taskId, at: Date.now(), summary: "done" });
    await tick();

    expect(meeting.moods).toEqual(["thinking", "reading", "writing", "listening"]);
    await ctx.app.stop();
  });

  it("starts listening when the avatar is in the room", async () => {
    await inRoom();
    expect(voice.started).toEqual([{ projectId: "demo", projectName: "demo" }]);
    await ctx.app.stop();
  });

  it("posts a transcript and runs it in the session stored for the project", async () => {
    await inRoom();
    // The session a typed task reaches, for comparison.
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "a typed question"));
    await tick();
    expect(ctx.agent.started.at(-1)?.sessionId).toBe("ses_pinned");

    voice.utterance("what does the parser do");
    await tick();
    await tick();

    const heard = ctx.signal.sent.find((m) =>
      m.text.includes("heard: what does the parser do"),
    );
    expect(heard?.channelId).toBe("group-1-demo");

    const task = ctx.agent.started.at(-1)!;
    expect(task.prompt).toBe("what does the parser do");
    expect(task.sessionId).toBe("ses_pinned");
    expect(ctx.store.getSession("demo")).toBe("ses_pinned");

    // The group learns what was heard before the task's status line appears.
    const heardIndex = ctx.signal.sent.indexOf(heard!);
    const statusIndex = ctx.signal.sent.findIndex(
      (m, i) => i > heardIndex && m.text.includes("Task "),
    );
    expect(statusIndex).toBeGreaterThan(heardIndex);
    await ctx.app.stop();
  });

  it("speaks a waiting permission and leaves the group prompt unchanged", async () => {
    await inRoom();
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
    await tick();

    const prompt = ctx.signal.sent.find((m) => m.text.includes("Approval needed"))!;
    expect(prompt.channelId).toBe("group-1-demo");
    expect(prompt.text).toContain("bash");
    expect(prompt.text).toContain("run ls");
    expect(prompt.text).toContain("Reply approve");

    // The room hears what is needed and that the decision is typed.
    const spoken = voice.spoken.at(-1)!;
    expect(spoken).toContain("bash");
    expect(spoken).toContain("run ls");
    expect(spoken).toContain("typing approve");
    expect(ctx.agent.decisions).toHaveLength(0);
    await ctx.app.stop();
  });

  it("refuses a spoken approval while a permission waits, and says why", async () => {
    await inRoom();
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
    const tasksBefore = ctx.agent.started.length;

    voice.utterance("approve");
    await tick();
    await tick();

    // The transcript stays in the record, but decides nothing and starts nothing.
    expect(ctx.agent.decisions).toHaveLength(0);
    expect(ctx.agent.aborted).toHaveLength(0);
    expect(ctx.agent.started).toHaveLength(tasksBefore);
    expect(ctx.signal.sent.some((m) => m.text.includes("heard: approve"))).toBe(true);
    expect(voice.spoken.at(-1)).toContain("decided by typing");
    const note = ctx.signal.sent.at(-1)!;
    expect(note.channelId).toBe("group-1-demo");
    expect(note.text).toContain("spoken word cannot answer a permission");
    expect(note.text).toContain("approve");
    expect(note.text).toContain("deny");
    expect(note.text).toContain("always");
    await ctx.app.stop();
  });

  it("still treats a spoken yes as a prompt when nothing is pending", async () => {
    await inRoom();
    const tasksBefore = ctx.agent.started.length;

    voice.utterance("yes");
    await tick();
    await tick();

    expect(ctx.agent.started).toHaveLength(tasksBefore + 1);
    expect(ctx.agent.started.at(-1)?.prompt).toBe("yes");
    expect(ctx.signal.sent.some((m) => m.text.includes("heard: yes"))).toBe(true);
    expect(ctx.signal.sent.some((m) => m.text.includes("spoken word cannot"))).toBe(false);
    expect(said()).toHaveLength(0);
    await ctx.app.stop();
  });

  it("does not let a held permission announcement delay the prompt or the next event", async () => {
    await inRoom();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "do work"));
    await tick();
    const taskId = ctx.agent.started[0]!.taskId;

    voice.holdSpeech();
    ctx.agent.emit({
      type: "permission",
      taskId,
      at: Date.now(),
      permission: { id: "p1", taskId, tool: "bash", description: "run ls", safe: false },
    });
    await tick();

    // The prompt is in the group while the clip is still held in flight.
    expect(ctx.signal.sent.some((m) => m.text.includes("Approval needed"))).toBe(true);

    ctx.agent.emit({ type: "idle", taskId, at: Date.now(), summary: "done while held" });
    await tick();
    await tick();
    expect(ctx.store.getTask(taskId)?.state).toBe("done");

    voice.releaseSpeech();
    await ctx.app.stop();
  });

  it("lets ordinary speech run again after a task is stopped", async () => {
    await inRoom();
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

    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "/stop"));
    await tick();
    expect(ctx.store.getTask(taskId)?.state).toBe("aborted");
    expect(ctx.store.getValue("pending:group-1-demo")).toBe("[]");

    const tasksBefore = ctx.agent.started.length;
    voice.utterance("yes");
    await tick();
    await tick();

    // The stopped task's stale approval no longer refuses ordinary speech.
    expect(ctx.agent.started).toHaveLength(tasksBefore + 1);
    expect(ctx.agent.started.at(-1)?.prompt).toBe("yes");
    expect(ctx.agent.decisions).toHaveLength(0);
    await ctx.app.stop();
  });

  it("does not refuse speech for a pending approval whose task already ended", async () => {
    await inRoom();
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

    // The task ends without a terminal event, so the pending row is still there.
    ctx.store.updateTask(taskId, { state: "done", updatedAt: Date.now() });
    expect(ctx.store.getValue("pending:group-1-demo")).not.toBe("[]");

    voice.utterance("yes");
    await tick();
    await tick();

    expect(ctx.agent.started.at(-1)?.prompt).toBe("yes");
    expect(ctx.agent.decisions).toHaveLength(0);
    // The stale row is dropped and the pruned list persisted.
    expect(ctx.store.getValue("pending:group-1-demo")).toBe("[]");
    await ctx.app.stop();
  });

  it("caps a long permission description aloud but keeps it whole in the group", async () => {
    await inRoom();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "do work"));
    await tick();
    const taskId = ctx.agent.started[0]!.taskId;
    const description = "a very long command ".repeat(80).trim();

    ctx.agent.emit({
      type: "permission",
      taskId,
      at: Date.now(),
      permission: { id: "p1", taskId, tool: "bash", description, safe: false },
    });
    await tick();
    await tick();

    const spoken = voice.spoken.at(-1)!;
    // The description is trimmed, but the typed instruction always survives.
    expect(spoken.length).toBeLessThanOrEqual(600);
    expect(spoken).not.toContain(description);
    expect(spoken).toContain("typing approve");
    expect(spoken.endsWith("Signal.")).toBe(true);
    const prompt = ctx.signal.sent.find((m) => m.text.includes("Approval needed"))!;
    expect(prompt.text).toContain(description);
    await ctx.app.stop();
  });

  it("does not speak a permission into a meeting hearing another project", async () => {
    const projects = [
      {
        name: "demo",
        path: "/tmp/demo",
        session: "ses_pinned",
        meet: { allow: [{ id: "+1000", label: "+1000" }], providers: ["meet.jit.si"] },
      },
      { name: "other", path: "/tmp/other" },
    ];
    meeting = new FakeMeeting();
    voice = new FakeVoice();
    ctx = makeApp(projects, {}, undefined, meeting, reachable, undefined, voice);
    await ctx.app.start();
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incoming(`/meet ${LINK}`));
    await tick();
    await tick();
    meeting.admit();
    await tick();
    await tick();

    ctx.signal.emitMessage(incoming("/open other"));
    await tick();
    ctx.signal.emitMessage(incomingIn("group-2-other", "work in the other project"));
    await tick();
    const taskId = ctx.agent.started.at(-1)!.taskId;
    ctx.agent.emit({
      type: "permission",
      taskId,
      at: Date.now(),
      permission: { id: "p1", taskId, tool: "bash", description: "run ls", safe: false },
    });
    await tick();
    await tick();

    expect(ctx.signal.sent.some((m) => m.text.includes("Approval needed"))).toBe(true);
    expect(said()).toHaveLength(0);
    await ctx.app.stop();
  });

  it("treats a spoken /stop as a prompt and aborts nothing", async () => {
    await inRoom();
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "do work"));
    await tick();
    const before = ctx.agent.started.length;

    voice.utterance("/stop");
    await tick();
    await tick();

    expect(ctx.agent.aborted).toHaveLength(0);
    expect(ctx.agent.started.length).toBe(before + 1);
    expect(ctx.agent.started.at(-1)?.prompt).toBe("/stop");
    await ctx.app.stop();
  });

  it("counts a dropped utterance, posts its reason and keeps the meeting", async () => {
    await inRoom();
    const tasks = ctx.agent.started.length;

    voice.drop("the transcriber timed out");
    await tick();
    await tick();

    expect(voice.drops).toBe(1);
    const notice = ctx.signal.sent.at(-1)!;
    expect(notice.channelId).toBe("group-1-demo");
    expect(notice.text).toContain("the transcriber timed out");
    expect(ctx.agent.started).toHaveLength(tasks);
    expect(ctx.store.getOpenMeeting()).not.toBeUndefined();
    expect(ctx.signal.sent.some((m) => m.text.includes("Meeting ended"))).toBe(false);
    await ctx.app.stop();
  });

  it("stops listening on /meet stop", async () => {
    await inRoom();
    expect(voice.started).toHaveLength(1);

    ctx.signal.emitMessage(incoming("/meet stop"));
    await tick();
    await tick();

    expect(voice.stops).toEqual(["demo"]);
    expect(ctx.store.getOpenMeeting()).toBeUndefined();
    await ctx.app.stop();
  });

  it("stops listening when the room ends by itself", async () => {
    await inRoom();
    meeting.die("the call ended");
    await tick();
    await tick();

    expect(voice.stops).toEqual(["demo"]);
    expect(ctx.store.getOpenMeeting()).toBeUndefined();
    await ctx.app.stop();
  });

  it("stops listening when the connector shuts down", async () => {
    await inRoom();
    await ctx.app.stop();
    expect(voice.stops).toEqual(["demo"]);
    expect(voice.started).toHaveLength(1);
  });

  it("never starts listening when the join fails", async () => {
    meeting = new FakeMeeting();
    voice = new FakeVoice();
    ctx = makeApp(PROJECTS, {}, undefined, meeting, reachable, undefined, voice);
    await ctx.app.start();
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    meeting.failJoin = true;

    ctx.signal.emitMessage(incoming(`/meet ${LINK}`));
    await tick();
    await tick();

    expect(voice.started).toHaveLength(0);
    expect(voice.stops).toHaveLength(0);
    expect(ctx.store.getOpenMeeting()).toBeUndefined();
    const ended = ctx.signal.sent.find((m) => m.text.includes("Meeting ended"));
    expect(ended?.text).toContain("could not start the avatar browser");
    await ctx.app.stop();
  });

  it("speaks the summary of a task a spoken question started", async () => {
    await inRoom();

    voice.utterance("what does the parser do");
    await tick();
    await tick();
    const taskId = ctx.agent.started.at(-1)!.taskId;
    // The row says it was a spoken question, so a restart still knows.
    expect(ctx.store.getTask(taskId)?.voice).toBe(true);

    ctx.agent.emit({
      type: "idle",
      taskId,
      at: Date.now(),
      summary: "the parser now handles quoted strings",
    });
    await tick();
    await tick();

    expect(voice.spoken.at(-1)).toContain("the parser now handles quoted strings");
    // The full text stays in the group regardless of the cap.
    const done = ctx.signal.sent.find((m) => m.text.includes("quoted strings"));
    expect(done?.channelId).toBe("group-1-demo");
    await ctx.app.stop();
  });

  it("never speaks the summary of a task started by typing in the group", async () => {
    await inRoom();

    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "a typed question"));
    await tick();
    const taskId = ctx.agent.started.at(-1)!.taskId;
    expect(ctx.store.getTask(taskId)?.voice).toBeUndefined();

    ctx.agent.emit({ type: "idle", taskId, at: Date.now(), summary: "done quietly" });
    await tick();
    await tick();

    expect(said()).toHaveLength(0);
    await ctx.app.stop();
  });

  it("speaks the failure of a voice task", async () => {
    await inRoom();

    voice.utterance("do the thing");
    await tick();
    await tick();
    const taskId = ctx.agent.started.at(-1)!.taskId;

    ctx.agent.emit({ type: "error", taskId, at: Date.now(), text: "the build broke" });
    await tick();
    await tick();

    expect(voice.spoken.at(-1)).toContain("the build broke");
    await ctx.app.stop();
  });

  it("stops speaking when the meeting ends", async () => {
    await inRoom();
    expect(voice.stoppedSpeaking).toBe(0);

    ctx.signal.emitMessage(incoming("/meet stop"));
    await tick();
    await tick();

    expect(voice.stoppedSpeaking).toBe(1);
    await ctx.app.stop();
  });

  it("does not speak an earlier meeting's answer into a later meeting", async () => {
    await inRoom();
    voice.utterance("a question for the first meeting");
    await tick();
    await tick();
    const taskId = ctx.agent.started.at(-1)!.taskId;

    ctx.signal.emitMessage(incoming("/meet stop"));
    await tick();
    await tick();
    expect(said()).toHaveLength(0);

    // A second meeting in the same project's group is now the live one.
    ctx.signal.emitMessage(incoming(`/meet ${LINK}`));
    await tick();
    await tick();
    meeting.admit();
    await tick();
    await tick();
    expect(voice.started).toHaveLength(2);

    ctx.agent.emit({
      type: "idle",
      taskId,
      at: Date.now(),
      summary: "an answer for the old room",
    });
    await tick();
    await tick();

    // The answer stays in the group; it is not read into the new room.
    expect(ctx.signal.sent.some((m) => m.text.includes("an answer for the old room"))).toBe(
      true,
    );
    expect(said()).toHaveLength(0);
    await ctx.app.stop();
  });

  it("does not let speech block the rest of the event chain", async () => {
    await inRoom();
    voice.utterance("a question whose answer will be slow");
    await tick();
    await tick();
    const first = ctx.agent.started.at(-1)!.taskId;

    voice.holdSpeech();
    ctx.agent.emit({ type: "idle", taskId: first, at: Date.now(), summary: "held answer" });
    await tick();

    // The next task still runs and completes while the first clip is held.
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "a second question"));
    await tick();
    const second = ctx.agent.started.at(-1)!.taskId;
    ctx.agent.emit({ type: "idle", taskId: second, at: Date.now(), summary: "second done" });
    await tick();
    await tick();

    expect(ctx.store.getTask(second)?.state).toBe("done");
    voice.releaseSpeech();
    await ctx.app.stop();
  });
});

describe("meeting telemetry, presence and the watchdog", () => {
  const LINK = "https://meet.jit.si/room-abc";
  const PROJECTS = [
    {
      name: "demo",
      path: "/tmp/demo",
      session: "ses_pinned",
      meet: { allow: [{ id: "+1000", label: "+1000" }], providers: ["meet.jit.si"] },
    },
  ];
  const reachable = async (): Promise<boolean> => true;
  let meeting: FakeMeeting;
  let voice: FakeVoice;
  let clock: number;
  let ctx: ReturnType<typeof makeApp>;

  /** Everything spoken except the join greeting, which starts every meeting. */
  const said = (): string[] => voice.spoken.filter((text) => !text.startsWith("Привіт") && !text.startsWith("До зустрічі"));

  /** An admitted meeting on a clock the test moves by hand. */
  async function admitted(options: { watchdogMs?: number } = {}): Promise<void> {
    clock = 1_000_000;
    meeting = new FakeMeeting();
    voice = new FakeVoice();
    ctx = makeApp(PROJECTS, {}, undefined, meeting, reachable, undefined, voice, {
      now: () => clock,
      ...(options.watchdogMs !== undefined ? { watchdogMs: options.watchdogMs } : {}),
    });
    await ctx.app.start();
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incoming(`/meet ${LINK}`));
    await tick();
    await tick();
    meeting.admit();
    await tick();
    await tick();
    // The first reading arrives one telemetry cadence after admission.
    clock += 5_000;
  }

  const meetingMessage = () => ctx.signal.sent.find((m) => m.text.includes("Meeting ·"));
  const alarms = () => ctx.signal.sent.filter((m) => m.text.includes("gone silent"));

  it("posts one deaf alarm per silence spell and re-arms when audio returns", async () => {
    await admitted();
    // A room silent from admission alarms at the first budget, not the second.
    meeting.telemetry({ presence: "someone", humans: 1, level: 0, audioEpoch: 1 });
    await tick();
    await tick();

    expect(alarms()).toHaveLength(1);
    expect(alarms()[0]!.text).toContain("gone silent");
    expect(alarms()[0]!.channelId).toBe("group-1-demo");
    expect(ctx.store.getValue("health:meeting")).toContain("silent");

    // A mute/unmute track change restarts the clock but does not repost the spell.
    clock += 5_001;
    meeting.telemetry({ level: 0, audioEpoch: 2 });
    await tick();
    expect(alarms()).toHaveLength(1);

    // The same silence does not nag again.
    clock += 5_001;
    meeting.telemetry({ level: 0, audioEpoch: 2 });
    await tick();
    expect(alarms()).toHaveLength(1);

    // Audible audio clears the alarm and its health signal.
    meeting.telemetry({ level: 0.4, audioEpoch: 2 });
    await tick();
    expect(ctx.store.getValue("health:meeting")).toBe("");

    // A later silence is a new spell.
    clock += 5_001;
    meeting.telemetry({ level: 0, audioEpoch: 2 });
    await tick();
    await tick();
    expect(alarms()).toHaveLength(2);
    expect(ctx.store.getValue("health:meeting")).toContain("silent");
    await ctx.app.stop();
  });

  it("clears the health signal on a clean ending", async () => {
    await admitted();
    meeting.telemetry({ level: 0, audioEpoch: 1 });
    await tick();
    await tick();
    expect(ctx.store.getValue("health:meeting")).toContain("silent");

    ctx.signal.emitMessage(incoming("/meet stop"));
    await tick();
    await tick();

    expect(ctx.store.getOpenMeeting()).toBeUndefined();
    expect(ctx.store.getValue("health:meeting")).toBe("");
    await ctx.app.stop();
  });

  it("alarms on silence even when nobody is visibly present", async () => {
    await admitted();
    meeting.telemetry({ presence: "nobody", humans: 0, level: 0, audioEpoch: 1 });
    await tick();
    clock += 5_001;
    meeting.telemetry({ presence: "nobody", humans: 0, level: 0, audioEpoch: 1 });
    await tick();
    await tick();
    expect(alarms()).toHaveLength(1);
    await ctx.app.stop();
  });

  it("names someone, nobody or unknown in the meeting message, with no identity", async () => {
    await admitted();

    meeting.telemetry({ presence: "someone", humans: 1, level: 0.3, audioEpoch: 1 });
    await tick();
    expect(meetingMessage()?.text).toContain("someone here");

    meeting.telemetry({ presence: "nobody", humans: 0, level: 0.3, audioEpoch: 1 });
    await tick();
    expect(meetingMessage()?.text).toContain("nobody visible");

    meeting.telemetry({ presence: "unknown", level: 0.3, audioEpoch: 1 });
    await tick();
    expect(meetingMessage()?.text).toContain("presence unknown");

    // No identity ever reaches the group, and unknown never makes it listen-only.
    expect(ctx.signal.sent.every((m) => !m.text.includes("+1000"))).toBe(true);
    expect(ctx.signal.sent.some((m) => m.text.includes("listen-only"))).toBe(false);
    await ctx.app.stop();
  });

  it("goes listen-only once for a second human and never speaks again", async () => {
    await admitted();
    // humans counts the people beside the avatar: two is the operator plus one.
    meeting.telemetry({ presence: "someone", humans: 2, level: 0.3, audioEpoch: 1 });
    await tick();
    await tick();

    expect(ctx.signal.sent.filter((m) => m.text.includes("listen-only"))).toHaveLength(1);
    expect(voice.stoppedSpeaking).toBe(1);

    // Hearing continues: the transcript and the answer both reach the group.
    voice.utterance("what happens now");
    await tick();
    await tick();
    const taskId = ctx.agent.started.at(-1)!.taskId;
    ctx.agent.emit({ type: "idle", taskId, at: Date.now(), summary: "the answer in the group" });
    await tick();
    await tick();
    expect(ctx.signal.sent.some((m) => m.text.includes("heard: what happens now"))).toBe(true);
    expect(ctx.signal.sent.some((m) => m.text.includes("the answer in the group"))).toBe(true);
    expect(said()).toHaveLength(0);

    // A permission announcement is silent too.
    ctx.signal.emitMessage(incomingIn(projectChannel(ctx), "do work"));
    await tick();
    const secondTask = ctx.agent.started.at(-1)!.taskId;
    ctx.agent.emit({
      type: "permission",
      taskId: secondTask,
      at: Date.now(),
      permission: { id: "p1", taskId: secondTask, tool: "bash", description: "run ls", safe: false },
    });
    await tick();
    await tick();
    expect(ctx.signal.sent.some((m) => m.text.includes("Approval needed"))).toBe(true);
    expect(said()).toHaveLength(0);

    // A count that drops does not re-enable speech.
    meeting.telemetry({ presence: "someone", humans: 1, level: 0.3, audioEpoch: 1 });
    await tick();
    voice.utterance("a later question");
    await tick();
    await tick();
    const thirdTask = ctx.agent.started.at(-1)!.taskId;
    ctx.agent.emit({ type: "idle", taskId: thirdTask, at: Date.now(), summary: "still silent" });
    await tick();
    await tick();
    expect(said()).toHaveLength(0);
    expect(ctx.signal.sent.filter((m) => m.text.includes("listen-only"))).toHaveLength(1);
    await ctx.app.stop();
  });

  it("retries the listen-only announcement when the first send fails", async () => {
    await admitted();
    // The group is told even when the transport refuses the first attempt.
    ctx.signal.failNextSend = true;
    meeting.telemetry({ presence: "someone", humans: 2, level: 0.3, audioEpoch: 1 });
    await tick();
    await tick();

    // Speech is off at once, the group has not been told, and the guard is loud.
    expect(voice.stoppedSpeaking).toBe(1);
    expect(ctx.signal.sent.filter((m) => m.text.includes("listen-only"))).toHaveLength(0);
    expect(ctx.store.getValue("health:meeting")).toContain("listen-only");

    // The next report retries and succeeds exactly once.
    meeting.telemetry({ presence: "someone", humans: 2, level: 0.3, audioEpoch: 1 });
    await tick();
    await tick();
    expect(ctx.signal.sent.filter((m) => m.text.includes("listen-only"))).toHaveLength(1);
    expect(ctx.store.getValue("health:meeting")).toBe("");

    // A third report does not announce it again.
    meeting.telemetry({ presence: "someone", humans: 2, level: 0.3, audioEpoch: 1 });
    await tick();
    expect(ctx.signal.sent.filter((m) => m.text.includes("listen-only"))).toHaveLength(1);
    await ctx.app.stop();
  });

  it("closes an admitted meeting that stops reporting, with one outcome and health", async () => {
    await admitted({ watchdogMs: 5 });

    // A reading inside the window keeps the meeting open.
    clock += 10_000;
    meeting.telemetry({ presence: "someone", humans: 1, level: 0.3, audioEpoch: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    expect(ctx.store.getOpenMeeting()).not.toBeUndefined();

    // Nothing arrives past the activity window: the watchdog closes it once.
    clock += 30_001;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    await tick();

    expect(ctx.store.getOpenMeeting()).toBeUndefined();
    expect(meeting.leaves).toEqual(["demo"]);
    expect(ctx.store.getValue("health:meeting")).toContain("no telemetry");
    const summaries = ctx.signal.sent.filter((m) => m.text.includes("Meeting ended"));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.text).toContain("stopped reporting activity");
    expect(summaries[0]!.text.startsWith("🔴")).toBe(true);

    // A late adapter report cannot produce a second outcome.
    meeting.telemetry({ level: 0.5, audioEpoch: 2 });
    meeting.die("the call ended late");
    await tick();
    expect(ctx.signal.sent.filter((m) => m.text.includes("Meeting ended"))).toHaveLength(1);
    await ctx.app.stop();
  });

  it("leaves a meeting that has not been admitted alone", async () => {
    clock = 1_000_000;
    meeting = new FakeMeeting();
    voice = new FakeVoice();
    ctx = makeApp(PROJECTS, {}, undefined, meeting, reachable, undefined, voice, {
      now: () => clock,
      watchdogMs: 5,
    });
    await ctx.app.start();
    ctx.signal.emitMessage(incoming("/open demo"));
    await tick();
    ctx.signal.emitMessage(incoming(`/meet ${LINK}`));
    await tick();
    await tick();

    // The admission budget, not the activity window, owns an unadmitted room.
    clock += 60_000;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick();

    expect(ctx.store.getOpenMeeting()).not.toBeUndefined();
    expect(ctx.signal.sent.some((m) => m.text.includes("Meeting ended"))).toBe(false);
    await ctx.app.stop();
  });
});
