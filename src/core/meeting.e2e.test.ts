/**
 * The meeting epic's closing end-to-end suite.
 *
 * One real `CoreApp` and one real SQLite file, with only the boundaries faked:
 * Signal, the agent, the browser, the reachability probe and voice. Every
 * Done-when check is asserted on what the operator would see (the group and the
 * room), on stored state, or on a database reopened after the process closes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAgent } from "../adapters/fakes/fakeAgent.js";
import { FakeMeeting } from "../adapters/fakes/fakeMeeting.js";
import { FakeSignal } from "../adapters/fakes/fakeSignal.js";
import { FakeVoice } from "../adapters/fakes/fakeVoice.js";
import { ConfigSchema } from "../config/config.js";
import type { IncomingMessage } from "../domain/types.js";
import type { Logger } from "../logging/logger.js";
import { DatabaseSync } from "../store/sqliteDriver.js";
import { openStore, type Store } from "../store/store.js";
import { CoreApp } from "./app.js";

const LINK = "https://meet.jit.si/room-abc";
const HOST = "meet.jit.si";
const ROOM_TOKEN = "room-abc";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Let the app's serialized chain drain; every boundary fake resolves at once. */
async function settle(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) await tick();
}

/** A logger that keeps every line, so the link can be hunted through all of them. */
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

/** The demo project: the operator is listed, and the session is pinned. */
const DEFAULT_PROJECTS = [
  {
    name: "demo",
    path: "C:/tmp/demo",
    session: "ses_pinned",
    meet: { allow: [{ id: "+1000", label: "+1000" }], providers: [HOST] },
  },
];

interface HarnessOptions {
  /** The configured projects; defaults to the demo project above. */
  projects?: unknown[];
  /** The one reachability probe; defaults to a reachable room. */
  probeRoom?: (link: URL) => Promise<boolean>;
  /** The watchdog cadence; small when a test waits for it in real time. */
  watchdogMs?: number;
}

/**
 * One app on one temp-file database, with a manual clock. A file (not
 * `:memory:`) is deliberate: only reopening it can prove a credential was
 * wiped rather than hidden from the open-row query.
 */
class MeetingHarness {
  readonly dir: string;
  readonly file: string;
  readonly store: Store;
  readonly signal = new FakeSignal();
  readonly agent = new FakeAgent();
  readonly meeting = new FakeMeeting();
  readonly voice = new FakeVoice();
  readonly logger = new CapturingLogger();
  readonly app: CoreApp;
  clock = 1_000_000;
  /** How many room probes the command spent; a refusal should spend none. */
  probeCalls = 0;
  private appStopped = false;
  private storeClosed = false;
  private seq = 0;

  constructor(options: HarnessOptions = {}) {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "signalconnector-meeting-e2e-"));
    this.file = path.join(this.dir, "state.db");
    this.store = openStore(this.file);
    const config = ConfigSchema.parse({
      channel: { kind: "note-to-self" },
      signal: { account: "+1000" },
      voice: { rmsFloor: 0.01, maxSpeechChars: 600 },
      // The budgets are explicit, so a case never depends on a default.
      meeting: {
        silenceBudgetMs: 5_000,
        activityWindowMs: 30_000,
        telemetryMs: 5_000,
      },
      projects: options.projects ?? DEFAULT_PROJECTS,
    });
    this.app = new CoreApp({
      store: this.store,
      signal: this.signal,
      agent: this.agent,
      config,
      logger: this.logger,
      meeting: this.meeting,
      voice: this.voice,
      probeRoom: async (link) => {
        this.probeCalls += 1;
        return (options.probeRoom ?? (async () => true))(link);
      },
      now: () => this.clock,
      ...(options.watchdogMs !== undefined ? { watchdogMs: options.watchdogMs } : {}),
    });
  }

  advance(ms: number): void {
    this.clock += ms;
  }

  /** The channel a project talks in, once `/open` has made it a group. */
  projectChannel(project = "demo"): string {
    return this.store.getChannel(project)?.channelId ?? "self";
  }

  message(
    text: string,
    options: {
      channelId?: string;
      inControl?: boolean;
      delivery?: "data" | "sync";
      sender?: string;
      senderUuid?: string;
    } = {},
  ): IncomingMessage {
    const channelId = options.channelId ?? this.projectChannel();
    this.seq += 1;
    return {
      id: `e2e-${this.seq}`,
      channelId,
      sender: options.sender ?? "+1000",
      text,
      at: this.clock,
      inControlChannel: options.inControl ?? channelId === "self",
      delivery: options.delivery ?? "data",
      ...(options.senderUuid ? { senderUuid: options.senderUuid } : {}),
    };
  }

  async start(): Promise<void> {
    await this.app.start();
  }

  /** `/open demo`: the project gets its own group, where its traffic lives. */
  async openProject(name = "demo"): Promise<void> {
    this.signal.emitMessage(
      this.message(`/open ${name}`, { channelId: "self", inControl: true }),
    );
    await settle();
  }

  /** Paste a room link into the project's group and let the claim settle. */
  async meet(
    options: {
      link?: string;
      channelId?: string;
      delivery?: "data" | "sync";
      sender?: string;
    } = {},
  ): Promise<void> {
    this.signal.emitMessage(
      this.message(`/meet ${options.link ?? LINK}`, {
        ...(options.channelId ? { channelId: options.channelId } : {}),
        ...(options.delivery ? { delivery: options.delivery } : {}),
        ...(options.sender ? { sender: options.sender } : {}),
      }),
    );
    await settle();
  }

  /** The room admits the avatar. */
  async admit(): Promise<void> {
    this.meeting.admit();
    await settle();
  }

  meetingMessage() {
    return this.signal.sent.find((m) => m.text.includes("Meeting ·"));
  }

  /** Every text the core sent or edited, in order. */
  outboundTexts(): string[] {
    return this.signal.ops.flatMap((op) =>
      op.op === "send" || op.op === "edit" ? [op.text] : [],
    );
  }

  logText(): string {
    return this.logger.lines.join("\n");
  }

  async stopApp(): Promise<void> {
    if (this.appStopped) return;
    await this.app.stop();
    this.appStopped = true;
  }

  closeStore(): void {
    if (this.storeClosed) return;
    this.store.close();
    this.storeClosed = true;
  }

  async close(): Promise<void> {
    await this.stopApp();
    this.closeStore();
  }

  /** Read the meeting rows with a fresh connection: the store is closed first. */
  meetingRows(): Record<string, unknown>[] {
    const db = new DatabaseSync(this.file);
    try {
      return db
        .prepare(`SELECT project_id, link, started_at, closed_at, outcome FROM meetings`)
        .all();
    } finally {
      db.close();
    }
  }
}

let active: MeetingHarness | undefined;
const dirs: string[] = [];

function newHarness(options: HarnessOptions = {}): MeetingHarness {
  const harness = new MeetingHarness(options);
  dirs.push(harness.dir);
  active = harness;
  return harness;
}

afterEach(async () => {
  await active?.close();
  active = undefined;
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

interface RefusalCase {
  name: string;
  paste: string;
  expected: string;
  /** Strings that must appear in no message, refusal or log line. */
  forbidden: string[];
  projects?: unknown[];
  sender?: string;
  probe?: (link: URL) => Promise<boolean>;
  /** How many probes this refusal may spend; the gate stops most before one. */
  probes?: number;
  before?: (harness: MeetingHarness) => void;
  /** For the slot case: the refused row already open, and therefore unchanged. */
  existingLink?: string;
}

/**
 * The closed refusal set plus the open slot. Every row must be stopped before a
 * claim, before availability and before any browser.
 */
const REFUSALS: RefusalCase[] = [
  {
    name: "no configured identities",
    paste: LINK,
    expected: "No accepted identities are configured for demo",
    forbidden: [HOST, ROOM_TOKEN],
    projects: [
      { name: "demo", path: "C:/tmp/demo", meet: { allow: [], providers: [HOST] } },
    ],
  },
  {
    name: "a sender who is not configured",
    paste: LINK,
    expected: "Not authorised: +2000",
    forbidden: [HOST, ROOM_TOKEN],
    sender: "+2000",
  },
  {
    name: "a malformed link",
    paste: "not-a-link",
    expected: "Malformed link",
    forbidden: ["not-a-link"],
  },
  {
    name: "a foreign provider",
    paste: "https://zoom.us/j/secret",
    expected: "Not the configured meeting provider",
    forbidden: ["zoom.us", "secret"],
  },
  {
    name: "an unreachable room",
    paste: LINK,
    expected: "Could not reach the room",
    forbidden: [HOST, ROOM_TOKEN],
    probe: async () => false,
    probes: 1,
  },
  {
    name: "a slot already open",
    paste: "https://meet.jit.si/another-room",
    expected: "already open in demo",
    forbidden: [HOST, ROOM_TOKEN, "another-room"],
    existingLink: LINK,
    before: (harness) => {
      harness.store.claimMeeting({
        projectId: "demo",
        link: LINK,
        startedAt: harness.clock,
      });
    },
  },
];

describe("meeting end-to-end suite", () => {
  for (const refusal of REFUSALS) {
    it(`refuses ${refusal.name} without claiming the slot or joining`, async () => {
      const harness = newHarness({
        ...(refusal.projects ? { projects: refusal.projects } : {}),
        ...(refusal.probe ? { probeRoom: refusal.probe } : {}),
      });
      await harness.start();
      await harness.openProject();
      refusal.before?.(harness);

      harness.signal.emitMessage(
        harness.message(`/meet ${refusal.paste}`, {
          ...(refusal.sender ? { sender: refusal.sender } : {}),
        }),
      );
      await settle();

      // The refusal is named and never carries the room.
      const message = harness.signal.sent.at(-1)!;
      expect(message.text).toContain(refusal.expected);

      // Nothing reached the probe, availability check or browser.
      expect(harness.probeCalls).toBe(refusal.probes ?? 0);
      expect(harness.meeting.availableCalls).toBe(0);
      expect(harness.meeting.joins).toHaveLength(0);

      if (refusal.existingLink) {
        expect(harness.store.getOpenMeeting()).toEqual({
          projectId: "demo",
          link: refusal.existingLink,
          startedAt: harness.clock,
        });
      } else {
        expect(harness.store.getOpenMeeting()).toBeUndefined();
      }

      const outbound = harness.outboundTexts();
      for (const secret of refusal.forbidden) {
        expect(outbound.every((text) => !text.includes(secret))).toBe(true);
        expect(harness.logText()).not.toContain(secret);
      }
    });
  }

  it("joins, speaks, refuses a spoken approval, obeys a typed one and speaks the answer", async () => {
    const harness = newHarness();
    await harness.start();
    await harness.openProject();

    await harness.meet();
    expect(harness.meeting.joins).toEqual([
      { projectId: "demo", projectName: "demo", link: LINK },
    ]);
    expect(harness.store.getOpenMeeting()).toEqual({
      projectId: "demo",
      link: LINK,
      startedAt: harness.clock,
    });

    // One message carries the whole lifecycle, in the project's own group.
    const meetingMessage = harness.meetingMessage()!;
    expect(meetingMessage.channelId).toBe("group-1-demo");
    expect(meetingMessage.text).toContain("joining as demo");
    expect(harness.signal.sent.filter((m) => m.text.includes("Meeting ·"))).toHaveLength(1);

    await harness.admit();
    expect(meetingMessage.edited).toBe(true);
    expect(meetingMessage.text).toContain("in the room as demo");
    expect(harness.voice.started).toEqual([{ projectId: "demo", projectName: "demo" }]);

    // A typed task in the group owns the permission that follows.
    harness.signal.emitMessage(harness.message("do work"));
    await settle();
    const typedTask = harness.agent.started[0]!;
    expect(typedTask.sessionId).toBe("ses_pinned");

    harness.agent.emit({
      type: "permission",
      taskId: typedTask.taskId,
      at: harness.clock,
      permission: {
        id: "p1",
        taskId: typedTask.taskId,
        tool: "bash",
        description: "run ls",
        safe: false,
      },
    });
    await settle();

    expect(harness.signal.sent.some((m) => m.text.includes("Approval needed"))).toBe(true);
    const announcement = harness.voice.spoken.at(-1)!;
    expect(announcement).toContain("bash");
    expect(announcement).toContain("run ls");
    expect(announcement).toContain("typing approve");

    // A spoken question is posted once and runs in the pinned session.
    harness.voice.utterance("what does the parser do");
    await settle();

    const heard = harness.signal.sent.filter((m) =>
      m.text.includes("heard: what does the parser do"),
    );
    expect(heard).toHaveLength(1);
    expect(heard[0]!.channelId).toBe("group-1-demo");

    const spokenTask = harness.agent.started.at(-1)!;
    expect(spokenTask.prompt).toBe("what does the parser do");
    expect(spokenTask.sessionId).toBe("ses_pinned");
    expect(harness.store.getSession("demo")).toBe("ses_pinned");
    expect(harness.store.getTask(spokenTask.taskId)?.voice).toBe(true);
    expect(harness.agent.decisions).toHaveLength(0);

    // A spoken approval decides nothing while the permission waits.
    harness.voice.utterance("approve");
    await settle();

    expect(
      harness.signal.sent.filter((m) => m.text.includes("heard: approve")),
    ).toHaveLength(1);
    expect(harness.agent.decisions).toHaveLength(0);
    expect(harness.agent.started).toHaveLength(2);
    expect(harness.voice.spoken.at(-1)).toContain("decided by typing");
    expect(
      harness.signal.sent.some((m) =>
        m.text.includes("spoken word cannot answer a permission"),
      ),
    ).toBe(true);

    // A typed approval in the project's group is obeyed.
    harness.signal.emitMessage(harness.message("approve"));
    await settle();
    expect(harness.agent.decisions).toEqual([{ permissionId: "p1", decision: "once" }]);
    expect(harness.signal.sent.some((m) => m.text.includes("approved: bash"))).toBe(true);

    // The answer is posted in the group once and read into the room.
    harness.agent.emit({
      type: "idle",
      taskId: spokenTask.taskId,
      at: harness.clock,
      summary: "the parser now handles quoted strings",
    });
    await settle();

    const answer = harness.signal.sent.filter((m) =>
      m.text.includes("the parser now handles quoted strings"),
    );
    expect(answer).toHaveLength(1);
    expect(answer[0]!.channelId).toBe("group-1-demo");
    expect(harness.voice.spoken.at(-1)).toContain("the parser now handles quoted strings");

    // No message in the whole meeting carried the room link.
    expect(harness.outboundTexts().every((text) => !text.includes(HOST))).toBe(true);
  });

  it("goes listen-only once for a second human and never re-enables speech", async () => {
    const harness = newHarness();
    await harness.start();
    await harness.openProject();
    await harness.meet();
    await harness.admit();

    // humans counts the people beside the avatar: two is the operator plus one.
    harness.meeting.telemetry({ presence: "someone", humans: 2, level: 0.3, audioEpoch: 1 });
    await settle();

    expect(harness.signal.sent.filter((m) => m.text.includes("listen-only"))).toHaveLength(1);
    expect(harness.voice.stoppedSpeaking).toBe(1);

    // Hearing continues: the transcript and the answer both reach the group.
    harness.voice.utterance("what happens now");
    await settle();
    const taskId = harness.agent.started.at(-1)!.taskId;
    harness.agent.emit({
      type: "idle",
      taskId,
      at: harness.clock,
      summary: "the answer in the group",
    });
    await settle();

    expect(
      harness.signal.sent.some((m) => m.text.includes("heard: what happens now")),
    ).toBe(true);
    expect(
      harness.signal.sent.some((m) => m.text.includes("the answer in the group")),
    ).toBe(true);
    expect(harness.voice.spoken).toHaveLength(0);

    // A permission announcement is silent too.
    harness.signal.emitMessage(harness.message("do work"));
    await settle();
    const secondTask = harness.agent.started.at(-1)!.taskId;
    harness.agent.emit({
      type: "permission",
      taskId: secondTask,
      at: harness.clock,
      permission: {
        id: "p1",
        taskId: secondTask,
        tool: "bash",
        description: "run ls",
        safe: false,
      },
    });
    await settle();

    expect(harness.signal.sent.some((m) => m.text.includes("Approval needed"))).toBe(true);
    expect(harness.voice.spoken).toHaveLength(0);

    // A count that drops does not re-enable speech or announce again.
    harness.meeting.telemetry({ presence: "someone", humans: 1, level: 0.3, audioEpoch: 1 });
    await settle();
    harness.voice.utterance("a later question");
    await settle();
    const thirdTask = harness.agent.started.at(-1)!.taskId;
    harness.agent.emit({
      type: "idle",
      taskId: thirdTask,
      at: harness.clock,
      summary: "still silent",
    });
    await settle();

    expect(harness.voice.spoken).toHaveLength(0);
    expect(harness.signal.sent.filter((m) => m.text.includes("listen-only"))).toHaveLength(1);
  });

  it("treats a spoken stop as a prompt and keeps the meeting open", async () => {
    const harness = newHarness();
    await harness.start();
    await harness.openProject();
    await harness.meet();
    await harness.admit();
    const before = harness.agent.started.length;

    for (const words of ["/meet stop", "stop"]) {
      harness.voice.utterance(words);
      await settle();

      expect(harness.agent.started.at(-1)?.prompt).toBe(words);
      expect(harness.signal.sent.some((m) => m.text.includes(`heard: ${words}`))).toBe(true);
      expect(harness.store.getOpenMeeting()).not.toBeUndefined();
      expect(harness.meeting.leaves).toHaveLength(0);
    }

    // Both utterances became tasks; neither ran a command.
    expect(harness.agent.started).toHaveLength(before + 2);
    expect(harness.agent.aborted).toHaveLength(0);
    expect(harness.signal.sent.some((m) => m.text.includes("Meeting ended"))).toBe(false);
  });

  it("raises one deaf alarm per silence spell and re-arms only on audio", async () => {
    const harness = newHarness();
    await harness.start();
    await harness.openProject();
    await harness.meet();
    await harness.admit();

    // Silent from admission: the first reading at the budget alarms once.
    harness.advance(5_000);
    harness.meeting.telemetry({ presence: "someone", humans: 1, level: 0, audioEpoch: 1 });
    await settle();

    const alarms = harness.signal.sent.filter((m) => m.text.includes("gone silent"));
    expect(alarms).toHaveLength(1);
    expect(alarms[0]!.channelId).toBe("group-1-demo");
    expect(harness.store.getValue("health:meeting")).toContain("silent");

    // The same spell does not nag again.
    harness.advance(5_001);
    harness.meeting.telemetry({ level: 0, audioEpoch: 1 });
    await settle();
    expect(harness.signal.sent.filter((m) => m.text.includes("gone silent"))).toHaveLength(1);

    // Audible audio clears the alarm and its health key.
    harness.meeting.telemetry({ level: 0.4, audioEpoch: 1 });
    await settle();
    expect(harness.store.getValue("health:meeting")).toBe("");

    // A later silence is a new spell.
    harness.advance(5_001);
    harness.meeting.telemetry({ level: 0, audioEpoch: 1 });
    await settle();
    expect(harness.signal.sent.filter((m) => m.text.includes("gone silent"))).toHaveLength(2);
    expect(harness.store.getValue("health:meeting")).toContain("silent");
  });

  it("closes a stale meeting once with the watchdog and ignores a late report", async () => {
    const harness = newHarness({ watchdogMs: 5 });
    await harness.start();
    await harness.openProject();
    await harness.meet();
    await harness.admit();

    // A reading inside the activity window keeps the meeting open.
    harness.advance(10_000);
    harness.meeting.telemetry({ presence: "someone", humans: 1, level: 0.3, audioEpoch: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await settle();
    expect(harness.store.getOpenMeeting()).not.toBeUndefined();

    // Nothing arrives past the window: the watchdog closes it exactly once.
    harness.advance(30_001);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await settle();

    expect(harness.store.getOpenMeeting()).toBeUndefined();
    expect(harness.meeting.leaves).toEqual(["demo"]);
    expect(harness.voice.stoppedSpeaking).toBe(1);
    expect(harness.voice.stops).toEqual(["demo"]);
    expect(harness.store.getValue("health:meeting")).toContain("no telemetry");
    const summaries = harness.signal.sent.filter((m) => m.text.includes("Meeting ended"));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.text).toContain("stopped reporting activity");
    expect(summaries[0]!.text.startsWith("🔴")).toBe(true);

    // A late state report from an adapter that should already be gone adds no
    // second outcome; the fake retains the handler for exactly this case.
    harness.meeting.lateState({ state: "left", detail: "the call ended late" });
    await settle();
    expect(harness.signal.sent.filter((m) => m.text.includes("Meeting ended"))).toHaveLength(1);
  });

  it("ends on /meet stop with one summary and a wiped link in the reopened database", async () => {
    const harness = newHarness();
    await harness.start();
    await harness.openProject();
    await harness.meet();
    await harness.admit();

    // A second paste is refused while the room is open, and echoes neither link.
    harness.signal.emitMessage(
      harness.message("/meet https://meet.jit.si/another-room"),
    );
    await settle();
    expect(harness.signal.sent.at(-1)?.text).toContain("already open in demo");
    expect(harness.meeting.joins).toHaveLength(1);

    const meetingMessage = harness.meetingMessage()!;
    harness.signal.emitMessage(harness.message("/meet stop"));
    await settle();

    // The browser left, the room's audio was released, the row closed and
    // exactly one summary was posted.
    expect(harness.meeting.leaves).toEqual(["demo"]);
    expect(harness.voice.stoppedSpeaking).toBe(1);
    expect(harness.voice.stops).toEqual(["demo"]);
    expect(harness.store.getOpenMeeting()).toBeUndefined();
    expect(meetingMessage.text).toContain("left by /meet stop");

    const summaries = harness.signal.sent.filter((m) => m.text.includes("Meeting ended"));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.text).toContain("left by /meet stop");
    expect(summaries[0]!.text).toMatch(/\d+s/);
    expect(summaries[0]!.text.startsWith("🟢")).toBe(true);

    // A second stop only reports that it is over: no second summary or leave.
    harness.signal.emitMessage(harness.message("/meet stop"));
    await settle();
    expect(harness.signal.sent.at(-1)?.text).toContain("No meeting is running");
    expect(harness.signal.sent.filter((m) => m.text.includes("Meeting ended"))).toHaveLength(1);

    // Reopen the file: the credential is wiped, not hidden by the open-row query.
    await harness.stopApp();
    harness.closeStore();
    expect(harness.meetingRows()).toEqual([
      {
        project_id: "demo",
        link: null,
        started_at: harness.clock,
        closed_at: harness.clock,
        outcome: "left by /meet stop",
      },
    ]);

    // No link in any sent message, edit or log line for the whole lifecycle.
    const outbound = harness.outboundTexts();
    const log = harness.logText();
    for (const secret of [HOST, ROOM_TOKEN, "another-room"]) {
      expect(outbound.every((text) => !text.includes(secret))).toBe(true);
      expect(log).not.toContain(secret);
    }
  });
});
