/**
 * Core application: wires the ports into command handling, task lifecycle,
 * approval conversation, and progress notifications. Contains no I/O itself —
 * everything goes through SignalPort / AgentPort / Store.
 */
import crypto from "node:crypto";
import type { Config } from "../config/config.js";
import type { Logger } from "../logging/logger.js";
import type { Store, Meeting } from "../store/store.js";
import type {
  AgentEvent,
  IncomingMessage,
  ModelRef,
  OutgoingMessage,
  PermissionDecision,
  PollVote,
  Project,
  Reaction,
  Task,
} from "../domain/types.js";
import type {
  AgentPort,
  LauncherPort,
  MeetingHandle,
  MeetingLeaveResult,
  MeetingPort,
  MeetingPresence,
  MeetingStateEvent,
  MeetingTelemetry,
  QuoteRef,
  SignalPort,
  Utterance,
  VoiceHandle,
  VoicePort,
} from "./ports.js";
import { renderStyled } from "./format.js";
import { decidePaste, PROVIDER_HOSTS, type PasteRefusal } from "./gate.js";
import { MARK } from "./progress.js";
import { HELP_TEXT, KNOWN_COMMANDS, parseInput } from "./router.js";
import {
  choicesText,
  emojiChoice,
  formatDuration,
  milestoneText,
  statusLine,
  summaryText,
} from "./progress.js";

export interface CoreDeps {
  store: Store;
  signal: SignalPort;
  agent: AgentPort;
  config: Config;
  logger: Logger;
  /** Optional: opens a project's window when nothing is connected for it. */
  launcher?: LauncherPort;
  /** Optional: joins a meeting room as the project's avatar. */
  meeting?: MeetingPort;
  /** Optional: hears a room's speech and turns it into text for a project. */
  voice?: VoicePort;
  /**
   * Optional: the one bounded reachability probe before a meeting is claimed.
   * Injectable so tests prove the gate without a network.
   */
  probeRoom?: (link: URL) => Promise<boolean>;
  now?: () => number;
  /**
   * How often the watchdog checks an admitted meeting for telemetry. Injectable
   * so a test needs no fake timers; production follows the telemetry cadence.
   */
  watchdogMs?: number;
}

interface PendingApproval {
  permissionId: string;
  taskId: string;
  projectId: string;
  tool: string;
  number: number;
  messageId: string;
}

/** An option menu sent to Signal, waiting for a tap or a number. */
interface PendingChoice {
  id: string;
  taskId: string;
  projectId: string;
  messageId: string;
  options: string[];
  number: number;
  /** "model" picks switch the session's model instead of running a prompt. */
  action?: "model";
  /** For action "model": the provider/id each option refers to. */
  values?: string[];
}

const PROJECT_ID = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/**
 * Fit a description into the budget reserved for it in a spoken announcement,
 * trimming at a word boundary. The group message keeps the whole text.
 */
function capSpoken(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (maxChars <= 0 || clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  const trimmed = (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
  return `${trimmed}…`;
}

/** One live meeting, between the store claim and the closing summary. */
interface ActiveMeeting {
  projectId: string;
  projectName: string;
  messageId: string;
  startedAt: number;
  /** The join attempt; resolves once the adapter has the browser up. */
  joining?: Promise<MeetingHandle>;
  handle?: MeetingHandle;
  /** While the room is heard: the handle that stops listening. */
  voice?: VoiceHandle;
  /** A terminal path already ran; later states must not repeat it. */
  finished: boolean;
  /** `/meet stop` is under way; adapter state events must not race it. */
  stopping: boolean;
  faceWarned: boolean;
  /** True once the page has positively admitted the avatar. */
  inRoom: boolean;
  /** When telemetry last arrived; the activity window is measured from here. */
  lastTelemetryAt: number;
  /** When audible audio or a track change last restarted the silence clock. */
  lastEpochAt: number;
  /** The page's last audio epoch, so a change can be told from the same track. */
  audioEpoch: number;
  /** The deaf alarm is out; it re-arms only when audible audio returns. */
  deaf: boolean;
  /** Who the page could see at its last report; advisory, never an identity. */
  presence: MeetingPresence;
  /** A second human is here: hearing continues, speaking is over for good. */
  listenOnly: boolean;
  /** The group has been told about listen-only; a failed send is retried. */
  listenOnlyAnnounced: boolean;
}

/** How the presence word appears in the meeting message. */
function presenceText(presence: MeetingPresence): string {
  if (presence === "someone") return "someone here";
  if (presence === "nobody") return "nobody visible";
  return "presence unknown";
}


export class CoreApp {
  private readonly store: Store;
  private readonly signal: SignalPort;
  private readonly agent: AgentPort;
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly launcher: LauncherPort | undefined;
  private readonly meetingPort: MeetingPort | undefined;
  private readonly voicePort: VoicePort | undefined;
  private readonly now: () => number;
  /** One bounded reachability probe; the only I/O between gate and claim. */
  private readonly probeRoom: (link: URL) => Promise<boolean>;
  private controlChannel = "self";
  /** The live meeting, if this process owns one. */
  private activeMeeting: ActiveMeeting | undefined;
  /** The project this message is about (its channel, or the quoted project). */
  private currentProjectId: string | undefined;
  /** Channel the message being handled came from; replies go back there. */
  private conversation = "self";
  /** Serializes handler dispatch so events are processed in arrival order. */
  private chain: Promise<void> = Promise.resolve();
  /** Closes an admitted meeting whose telemetry stopped; cleared on stop. */
  private watchdog: NodeJS.Timeout | undefined;
  private readonly watchdogMs: number;

  constructor(deps: CoreDeps) {
    this.store = deps.store;
    this.signal = deps.signal;
    this.agent = deps.agent;
    this.config = deps.config;
    this.logger = deps.logger;
    this.launcher = deps.launcher;
    this.meetingPort = deps.meeting;
    this.voicePort = deps.voice;
    this.now = deps.now ?? (() => Date.now());
    this.probeRoom = deps.probeRoom ?? ((link) => this.fetchRoom(link));
    // Never check less often than the telemetry it watches for, and never spin.
    this.watchdogMs =
      deps.watchdogMs ?? Math.max(1_000, Math.min(5_000, this.config.meeting.telemetryMs));
  }

  /**
   * The one bounded reachability probe: a single fetch with a three-second
   * timeout and no retries. Redirects are not followed — the gate cleared the
   * host that was pasted, not wherever it points next — and any 3xx counts as
   * reachable. The body is cancelled so the request does not hold a socket.
   */
  private async fetchRoom(link: URL): Promise<boolean> {
    try {
      const response = await fetch(link, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(3000),
      });
      try {
        if (response.status >= 300 && response.status < 400) return true;
        return response.ok;
      } finally {
        try {
          await response.body?.cancel();
        } catch {
          // The decision is already made; a body that will not cancel is noise.
        }
      }
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    for (const p of this.config.projects) {
      const id = PROJECT_ID(p.name);
      this.store.upsertProject({ id, name: p.name, path: p.path });
      // A configured session pins the project to one long-lived session (e.g.
      // the operator's own opencode session) rather than a fresh one per task.
      if (p.session) this.store.setSession(id, p.session);
    }
    this.controlChannel = this.config.channel.id ?? this.config.signal.account ?? "self";
    this.conversation = this.controlChannel;

    this.signal.onMessage((m) => this.enqueue(() => this.handleMessage(m)));
    this.signal.onReaction((r) => this.enqueue(() => this.handleReaction(r)));
    this.signal.onPollVote((v) => this.enqueue(() => this.handlePollVote(v)));
    this.agent.subscribe((e) => this.enqueue(() => this.handleAgentEvent(e)));

    await this.signal.start();
    await this.agent.start();
    // A row a previous process left open would hold the one meeting slot for
    // good; close it and tell the project's group, which is where it would have
    // said so itself had it ended cleanly.
    await this.reconcileMeetings();
    // The room can go quiet without saying so; only an admitted meeting is
    // watched, so the separate admission budget is untouched.
    this.watchdog = setInterval(() => {
      this.enqueue(() => this.checkMeetingActivity());
    }, this.watchdogMs);
    this.watchdog.unref();
    this.logger.info("core started", { channel: this.controlChannel });
  }

  async stop(): Promise<void> {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
    const active = this.activeMeeting;
    if (active && !active.finished) {
      // Leave the room first, then take the same terminal path as any other
      // ending: the row closes, the link is wiped and the group is told why.
      active.stopping = true;
      await this.meetingPort?.stop();
      try {
        await this.finishMeeting(active, "left", "the connector stopped", true);
      } catch (err: unknown) {
        this.logger.warn("meeting: could not announce the shutdown", { error: String(err) });
      }
    } else {
      await this.meetingPort?.stop();
    }
    await this.agent.stop();
    await this.signal.stop();
  }

  // --- incoming ------------------------------------------------------------

  private async handleMessage(msg: IncomingMessage): Promise<void> {
    // Messages are accepted in the control channel (general commands) and in a
    // project's own channel (commands about that project). The project is derived
    // from the channel, or from the message this one quotes.
    const quotedProject = msg.quoteId
      ? this.store.getValue(`msgProject:${msg.quoteId}`)
      : undefined;
    const projectId = this.store.projectForChannel(msg.channelId) ?? quotedProject;
    if (!msg.inControlChannel && !projectId) return;
    this.conversation = msg.channelId;
    this.currentProjectId = projectId;

    const parsed = parseInput(msg.text);
    // The meeting link is a credential: it lives in the meeting row only, so the
    // debug line records the command and never its argument.
    const loggable =
      parsed.kind === "command" && parsed.name === "meet" ? `/${parsed.name}` : msg.text;
    this.logger.debug("control message", { text: loggable, project: projectId });

    if (parsed.kind === "approval") {
      if (this.pending().length > 0) {
        await this.resolveApproval(parsed.decision);
      } else {
        await this.reply("No pending approval.");
      }
      return;
    }
    if (parsed.kind === "command") {
      await this.dispatchCommand(parsed.name, parsed.args, msg);
      return;
    }
    // A number answers the newest open menu; any other text means the operator
    // moved on, so open menus are closed rather than left to block later picks.
    if (await this.pickByNumber(parsed.text)) return;
    // While an approval is pending the agent is blocked, so don't swallow the
    // message as a task — say what the expected words are.
    if (this.pending().length > 0) {
      await this.reply(
        `${this.pending().length} approval(s) waiting. Reply approve, deny or always (or react 👍 / 👎).`,
      );
      return;
    }
    if (this.choices().length > 0) this.setChoices([]);
    await this.startTask(this.withMedia(parsed.text, msg));
  }

  /**
   * Hand saved attachments to the agent as paths in the prompt. The agent runs
   * on this machine and can open the file directly, so no extra protocol is
   * needed to pass the bytes through.
   */
  private withMedia(text: string, msg: IncomingMessage): string {
    const paths = msg.mediaPaths ?? [];
    if (paths.length === 0) return text;
    const lines = paths.map((p) => `[attached file: ${p}]`).join("\n");
    return text ? `${text}\n\n${lines}` : lines;
  }

  private async dispatchCommand(
    name: string,
    args: string,
    msg?: IncomingMessage,
  ): Promise<void> {
    if (!KNOWN_COMMANDS.includes(name as (typeof KNOWN_COMMANDS)[number])) {
      await this.reply(`Unknown command /${name}.\n\n${HELP_TEXT}`);
      return;
    }
    switch (name) {
      case "help":
        await this.reply(HELP_TEXT);
        return;
      case "projects": {
        const projects = this.store.listProjects();
        const text =
          projects.length === 0
            ? "No projects configured. Add them to config.toml."
            : projects
                .map(
                  (p) =>
                    `- ${p.name} (${p.path})${this.agent.isConnected(p.id) ? " [connected]" : ""}`,
                )
                .join("\n");
        await this.reply(text);
        return;
      }
      case "open":
        await this.openProject(args);
        return;
      case "models":
        await this.showModels();
        return;
      case "model":
        await this.selectModel(args);
        return;
      case "task":
        await this.startTask(args);
        return;
      case "status":
        await this.showStatus();
        return;
      case "new":
        await this.forkSession();
        return;
      case "stop":
        await this.stopTask();
        return;
      case "meet":
        await this.meetCommand(args, msg);
        return;
      default:
        await this.reply(HELP_TEXT);
    }
  }

  // --- commands ------------------------------------------------------------

  /**
   * The project this conversation is about: the one owning the channel, or the
   * one a quoted message belongs to. There is no sticky "active project".
   */
  private activeProject(): Project | undefined {
    return this.currentProjectId ? this.store.getProject(this.currentProjectId) : undefined;
  }

  /**
   * The channel a project's output belongs in: its own group once it has one,
   * otherwise the channel the current conversation is happening in.
   */
  private channelFor(projectId: string): string {
    return this.store.getChannel(projectId)?.channelId ?? this.conversation;
  }

  /**
   * Give a project its own Signal group, reusing the one it already has. The
   * group contains only the operator, so nothing is shared with anyone else.
   */
  private async ensureProjectRoom(project: Project): Promise<string | undefined> {
    const existing = this.store.getChannel(project.id);
    if (existing) return `group "${existing.name}"`;
    try {
      const { groupId } = await this.signal.createGroup(project.name);
      this.store.setChannel(project.id, groupId, project.name);
      this.logger.info("created project group", { project: project.name, channel: groupId });
      // Introduce the group itself, once.
      this.store.setValue(`greeted:${project.id}`, "1");
      await this.sendProject(
        project.id,
        `**${project.name}** — this group is for this project.\nSend a task here; progress, approvals and results stay here.`,
        false,
      );
      return `group "${project.name}" created — switch to it`;
    } catch (err: unknown) {
      this.logger.error("could not create project group", {
        project: project.name,
        error: String(err),
      });
      return `could not create its group: ${String(err)}`;
    }
  }

  /**
   * `/open <project>`: give the project its own group if it has none, bring its
   * window forward, and tell the operator where its conversation now lives.
   * There is no `/use` — routing is by channel, not by sticky state.
   */
  private async openProject(name: string): Promise<void> {
    await this.activateProject(name, true);
  }

  /**
   * Open a project: its own group (created on first use), its window in front.
   * Everything the project sends afterwards goes to that group.
   */
  private async activateProject(name: string, opened: boolean): Promise<void> {
    if (!name) {
      await this.reply("Usage: /open <project>");
      return;
    }
    const project = this.store.getProject(name);
    if (!project) {
      await this.reply(`Unknown project "${name}". Try /projects.`);
      return;
    }

    const notes: string[] = [];
    const room = await this.ensureProjectRoom(project);
    if (room) notes.push(room);
    const window = await this.startProjectWindow(project);
    if (window) notes.push(window);
    else if (opened) notes.push("no launch command configured");

    await this.reply(
      `**Opened ${project.name}**${notes.length > 0 ? ` · ${notes.join(" · ")}` : ""}`,
    );
  }

  /**
   * Bring the project's window forward. Only projects with a `launch` config take
   * part, so this stays opt-in; the launcher decides whether that means focusing
   * an existing window or opening a new one.
   */
  private async startProjectWindow(project: Project): Promise<string | undefined> {
    const configured = this.config.projects.find((p) => PROJECT_ID(p.name) === project.id);
    if (!configured?.launch || !this.launcher) return undefined;
    this.logger.info("showing project window", { project: project.name });
    try {
      const result = await this.launcher.launch(project);
      if (!result.started) {
        return `could not start it: ${result.detail ?? "unknown error"}`;
      }
      // Follow the session that window is showing, so the operator sees the work
      // the connector drives instead of a pane sitting on a splash screen.
      if (result.sessionId && this.store.getSession(project.id) !== result.sessionId) {
        this.store.setSession(project.id, result.sessionId);
        this.logger.info("pinned project session", {
          project: project.name,
          session: result.sessionId,
        });
      }
      return result.detail ?? "opened";
    } catch (err: unknown) {
      this.logger.error("launch failed", { project: project.name, error: String(err) });
      return `could not start it: ${String(err)}`;
    }
  }

  private async startTask(prompt: string): Promise<void> {
    if (!prompt) {
      await this.reply("Usage: /task <prompt>");
      return;
    }
    const project = this.activeProject();
    if (!project) {
      await this.reply("No project here. Send /open <project> in the control group.");
      return;
    }
    await this.runTask(project, prompt);
  }

  /**
   * Start a task in a specific project (used by /task, by option picks and by a
   * spoken question). The origin is recorded with the row: only a task a spoken
   * question started is spoken back when it finishes, and only into the meeting
   * that heard it.
   */
  private async runTask(
    project: Project,
    prompt: string,
    origin: "text" | { voice: true; meetingStartedAt: number } = "text",
  ): Promise<Task> {
    const task: Task = {
      id: crypto.randomUUID(),
      projectId: project.id,
      sessionId: "",
      prompt,
      state: "started",
      startedAt: this.now(),
      updatedAt: this.now(),
      ...(typeof origin === "object" ? { voice: true } : {}),
    };
    const sessionId = this.store.getSession(project.id);
    const started = await this.agent.startTask({
      taskId: task.id,
      project,
      prompt,
      ...(sessionId ? { sessionId } : {}),
    });
    task.sessionId = started.sessionId;
    this.store.setSession(project.id, started.sessionId);
    this.store.createTask(task);
    if (typeof origin === "object") {
      // The meeting that heard the question, so a later meeting in the same
      // project does not answer it. Kept in the store, like every other fact.
      this.store.setValue(`voiceMeeting:${task.id}`, String(origin.meetingStartedAt));
    }

    const { messageId } = await this.sendProject(project.id, statusLine(task, "queued"));
    this.store.setValue(`statusMsg:${task.id}`, messageId);
    this.logger.info("task started", { taskId: task.id, project: project.name });
    return task;
  }

  /** List the project's models as a pickable menu (a poll when it fits). */
  private async showModels(): Promise<void> {
    const project = this.activeProject();
    if (!project) {
      await this.reply("No project here. Send /open <project> in the control group.");
      return;
    }
    let models: ModelRef[];
    try {
      models = await this.agent.listModels(project);
    } catch (err: unknown) {
      await this.reply(`Could not read the model list: ${String(err)}`);
      return;
    }
    if (models.length === 0) {
      await this.reply(`${project.name} reported no models.`);
      return;
    }

    const options = models.map((model) => model.name ?? `${model.providerID}/${model.id}`);
    const channel = this.channelFor(project.id);
    const list = this.choices(channel);
    const number = list.length + 1;
    const sent = await this.askChoices(project.id, options, `Model for ${project.name}`);
    list.push({
      id: crypto.randomUUID(),
      taskId: "",
      projectId: project.id,
      messageId: sent.messageId,
      options,
      number,
      action: "model",
      values: models.map((model) => `${model.providerID}/${model.id}`),
    });
    this.setChoices(list, channel);
  }

  /** `/model <number>` picks from the last listing; `/model provider/id` is direct. */
  private async selectModel(arg: string): Promise<void> {
    const project = this.activeProject();
    if (!project) {
      await this.reply("No project here. Send /open <project> in the control group.");
      return;
    }
    const trimmed = arg.trim();
    if (!trimmed) {
      await this.showModels();
      return;
    }

    const choice = this.choices().at(-1);
    if (/^\d{1,2}$/.test(trimmed) && choice?.action === "model") {
      await this.resolveChoices(choice, [Number(trimmed)]);
      return;
    }

    const slash = trimmed.indexOf("/");
    if (slash <= 0 || slash === trimmed.length - 1) {
      await this.reply(
        "Usage: /model <number> after /models, or /model <provider>/<id>.",
      );
      return;
    }
    await this.switchModel(project, {
      providerID: trimmed.slice(0, slash),
      id: trimmed.slice(slash + 1),
    });
  }

  private async switchModel(project: Project, model: ModelRef): Promise<void> {
    const sessionId = this.store.getSession(project.id) ?? "";
    try {
      await this.agent.setModel({ project, sessionId, model });
      await this.sendProject(project.id, `🧠 **Model** · \`${model.providerID}/${model.id}\``);
    } catch (err: unknown) {
      this.logger.error("model switch failed", { project: project.name, error: String(err) });
      await this.reply(`Could not switch the model: ${String(err)}`);
    }
  }

  private async showStatus(): Promise<void> {
    const project = this.activeProject();
    if (!project) {
      await this.reply("No project here.");
      return;
    }
    const task = this.store.getActiveTask(project.id) ?? this.latestTask(project.id);
    if (!task) {
      await this.reply(`No tasks for ${project.name} yet.`);
      return;
    }
    await this.reply(statusLine(task, task.summary));
  }

  private latestTask(projectId: string): Task | undefined {
    const raw = this.store.getValue(`latestTask:${projectId}`);
    return raw ? this.store.getTask(raw) : undefined;
  }

  private async forkSession(): Promise<void> {
    const project = this.activeProject();
    if (!project) {
      await this.reply("No project here.");
      return;
    }
    const { sessionId } = await this.agent.newSession(project);
    this.store.setSession(project.id, sessionId);
    await this.reply(`New session for ${project.name}.`);
  }

  private async stopTask(): Promise<void> {
    const project = this.activeProject();
    if (!project) {
      await this.reply("No project here.");
      return;
    }
    const task = this.store.getActiveTask(project.id);
    if (!task) {
      await this.reply("No running task.");
      return;
    }
    await this.agent.abort(task.id);
    this.store.updateTask(task.id, { state: "aborted", updatedAt: this.now() });
    this.clearPendingForTask(task.id);
    await this.reply(`Aborted task ${task.id}.`);
  }

  // --- meetings ------------------------------------------------------------

  /** `/meet <link>` claims the one meeting slot and joins; `/meet stop` leaves. */
  private async meetCommand(args: string, msg?: IncomingMessage): Promise<void> {
    const trimmed = args.trim();
    if (!trimmed) {
      await this.reply("Usage: /meet <link>, or /meet stop");
      return;
    }
    if (/^stop$/i.test(trimmed)) {
      await this.stopMeeting();
      return;
    }

    const project = this.activeProject();
    if (!project) {
      await this.reply("No project here. Send /meet in a project's group.");
      return;
    }

    // The gate runs before availability, before the claim and before any
    // browser: identity, link shape and provider are decided here first.
    const configured = this.config.projects.find((p) => PROJECT_ID(p.name) === project.id);
    const decision = decidePaste({
      delivery: msg?.delivery ?? "data",
      sender: msg?.sender ?? "",
      ...(msg?.senderUuid ? { senderUuid: msg.senderUuid } : {}),
      allow: configured?.meet?.allow ?? [],
      text: trimmed,
      providerHosts: configured?.meet?.providers ?? PROVIDER_HOSTS,
    });
    if (!decision.ok) {
      // Only the category is logged: the text is the credential and never
      // reaches a log line, a refusal or a group message.
      this.logger.info("meeting: paste refused", {
        project: project.name,
        category: decision.category,
      });
      await this.refusePaste(project.name, decision);
      return;
    }

    if (!this.meetingPort) {
      await this.reply("Meetings are not available in this build.");
      return;
    }

    // A meeting already open is refused here, before the probe spends a request
    // on it. This is not the slot decision — that is still the claim write below,
    // which is what settles a race between two pastes.
    const open = this.store.getOpenMeeting();
    if (open) {
      await this.refuseMeeting(open);
      return;
    }

    // One bounded probe, no retries: a room that cannot be fetched is refused
    // before the slot is claimed.
    const reachable = await this.probeRoom(decision.link);
    if (!reachable) {
      this.logger.info("meeting: room unreachable", { project: project.name });
      await this.refusePaste(project.name, { ok: false, category: "unreachable-room" });
      return;
    }

    const availability = await this.meetingPort.available();
    if (!availability.available) {
      // The refusal comes before any row is claimed, and never echoes the link.
      await this.reply(`Could not join a meeting: ${availability.reason}.`, MARK.attention);
      return;
    }

    const startedAt = this.now();
    try {
      // One atomic write decides who holds the meeting slot: the partial unique
      // index refuses a second open row instead of racing a read-then-write.
      this.store.claimMeeting({ projectId: project.id, link: trimmed, startedAt });
    } catch {
      const holder = this.store.getOpenMeeting();
      if (holder) await this.refuseMeeting(holder);
      else await this.reply("Could not claim the meeting slot. Try again.");
      return;
    }

    // One editable message for the whole meeting; the group is also task traffic.
    let sent: OutgoingMessage;
    try {
      sent = await this.sendProject(
        project.id,
        `${MARK.working} **Meeting** · joining as \`${project.name}\``,
      );
    } catch (err: unknown) {
      // No message means no meeting to watch; free the slot rather than hold it.
      this.store.closeMeeting(project.id, "could not post the meeting message", this.now());
      throw err;
    }
    const active: ActiveMeeting = {
      projectId: project.id,
      projectName: project.name,
      messageId: sent.messageId,
      startedAt,
      finished: false,
      stopping: false,
      faceWarned: false,
      inRoom: false,
      lastTelemetryAt: startedAt,
      lastEpochAt: startedAt,
      audioEpoch: -1,
      deaf: false,
      presence: "unknown",
      listenOnly: false,
      listenOnlyAnnounced: false,
    };
    this.activeMeeting = active;

    const joining = this.meetingPort.join({
      projectId: project.id,
      projectName: project.name,
      link: trimmed,
      onState: (event) => {
        this.enqueue(() => this.onMeetingState(active, event));
      },
      onTelemetry: (telemetry) => {
        this.enqueue(() => this.onTelemetry(active, telemetry));
      },
    });
    active.joining = joining;
    joining.then(
      (handle) => {
        active.handle = handle;
      },
      () => {
        // A failure during a deliberate stop is the stop's story, not a second
        // red "could not start" after the meeting has already ended.
        if (active.stopping) return;
        this.enqueue(() =>
          this.finishMeeting(active, "failed", "could not start the avatar browser", true),
        );
      },
    );
    this.logger.info("meeting: claimed the slot", { project: project.name });
  }

  /**
   * The operator-facing refusal for a gate decision. Every message names its
   * category and never the link; "not authorised" also names the sender so the
   * operator can tell a stranger from a misconfigured entry.
   */
  private async refusePaste(projectName: string, refusal: PasteRefusal): Promise<void> {
    const text = ((): string => {
      switch (refusal.category) {
        case "no-identities":
          return `No accepted identities are configured for **${projectName}**. Add one under \`meet.allow\` in config.toml.`;
        case "not-authorised":
          return `Not authorised${refusal.detail ? `: ${refusal.detail}` : ""}. Only a configured identity may summon a meeting.`;
        case "malformed-link":
          return "Malformed link. Send one https room link for the configured provider.";
        case "foreign-provider":
          return "Not the configured meeting provider.";
        case "unreachable-room":
          return "Could not reach the room.";
      }
    })();
    await this.reply(`Refused — ${text}`, MARK.attention);
  }

  /** Refusal naming who holds the slot and since when — never the link. */
  private async refuseMeeting(meeting: Meeting): Promise<void> {
    const name = this.store.getProject(meeting.projectId)?.name ?? meeting.projectId;
    const started = new Date(meeting.startedAt).toISOString().slice(11, 19);
    await this.reply(
      `A meeting is already open in ${name} (started ${started} UTC). Send /meet stop there first.`,
      MARK.attention,
    );
  }

  /**
   * The adapter's states: joining is already on screen; every later state edits
   * the same message, and a terminal one closes the row and adds one summary.
   */
  private async onMeetingState(
    active: ActiveMeeting,
    event: MeetingStateEvent,
  ): Promise<void> {
    if (active.finished || active.stopping) return;
    if (event.state === "joining") {
      // Progress needs no edit; a problem in the lobby (no join control) does.
      if (event.detail) {
        await this.editMeetingMessage(active, `${MARK.attention} **Meeting** · ${event.detail}`);
      }
      return;
    }

    if (event.state === "in-room") {
      // The avatar is admitted: start hearing the room. A repeated in-room event
      // (the face recovering) must not start a second pump.
      if (!active.inRoom) {
        // Admission, not the claim, starts both clocks: a slow lobby must not
        // count against the silence budget or the activity window.
        const admittedAt = this.now();
        active.inRoom = true;
        active.lastTelemetryAt = admittedAt;
        active.lastEpochAt = admittedAt;
      }
      await this.startListening(active);
      if (event.detail === "face not publishing") {
        if (!active.faceWarned) {
          active.faceWarned = true;
          await this.editMeetingMessage(
            active,
            `${MARK.attention} **Meeting** · in the room, face not publishing`,
          );
        }
        return;
      }
      active.faceWarned = false;
      await this.editMeetingMessage(active, this.inRoomText(active, event));
      return;
    }

    const outcome =
      event.detail ?? (event.state === "left" ? "the room ended" : "the meeting failed");
    await this.finishMeeting(active, event.state, outcome, event.state === "failed");
  }

  /** The in-room message carries presence and the project's task state. */
  private inRoomText(active: ActiveMeeting, event: MeetingStateEvent): string {
    const unverified = event.verified === false ? " · unverified" : "";
    const task =
      this.store.getActiveTask(active.projectId) ?? this.latestTask(active.projectId);
    const taskLine = task
      ? statusLine(task, task.summary)
      : "No task is running. Send one here and the meeting follows it.";
    return `${MARK.ok} **Meeting** · in the room as \`${active.projectName}\`${unverified}\n${presenceText(active.presence)}\n${taskLine}`;
  }

  /**
   * A plain reading from the page: who it can see, how loud the room is, and
   * whether the audio track changed. Core decides what it means — never the
   * adapter, and never an identity. Nothing here can end the meeting; the
   * watchdog owns that.
   */
  private async onTelemetry(active: ActiveMeeting, telemetry: MeetingTelemetry): Promise<void> {
    if (active.finished || active.stopping || !active.inRoom) return;
    const now = this.now();
    active.lastTelemetryAt = now;

    // Presence is advisory: it changes one word in the message and nothing else.
    if (active.presence !== telemetry.presence) {
      active.presence = telemetry.presence;
      if (!active.faceWarned) {
        await this.editMeetingMessage(active, this.inRoomText(active, { state: "in-room" }));
      }
    }

    await this.enterListenOnly(active, telemetry);

    // Silence: audible audio re-arms the alarm and clears its health signal. A
    // track change only restarts the clock — it does not re-arm, or mute/unmute
    // would repost the same silence. The first reading is the baseline.
    const audible = telemetry.level >= this.config.voice.rmsFloor;
    const epochChanged =
      active.audioEpoch !== -1 && telemetry.audioEpoch !== active.audioEpoch;
    active.audioEpoch = telemetry.audioEpoch;
    if (audible) {
      active.lastEpochAt = now;
      active.deaf = false;
      this.clearHealth();
    } else if (epochChanged) {
      active.lastEpochAt = now;
    }

    // A second human is announced after the audible branch so a failed send's
    // health signal is not erased in the same pass; the next report retries.
    await this.announceListenOnly(active);
    if (audible || active.deaf) return;

    const budget = this.config.meeting.silenceBudgetMs;
    if (now - active.lastEpochAt < budget) return;
    active.deaf = true;
    const seconds = Math.round(budget / 1000);
    this.raiseHealth(`the room in ${active.projectName} has been silent for ${seconds} s`);
    await this.sendProject(
      active.projectId,
      `${MARK.attention} **Meeting** · the room has gone silent — no audible audio for ${seconds} s.`,
    );
  }

  /**
   * A second human in the room ends speech for this meeting: the avatar keeps
   * hearing and posting transcripts, but never talks again. The count is of
   * humans besides the avatar, so two means the operator plus one more. A count
   * that later drops does not re-enable speech, and the group hears this once.
   */
  private async enterListenOnly(
    active: ActiveMeeting,
    telemetry: MeetingTelemetry,
  ): Promise<void> {
    // The latch is permanent, but an announcement that failed is retried on the
    // next report: silence is the safe side, yet the group must still be told.
    if (active.listenOnly) return;
    if (typeof telemetry.humans !== "number" || telemetry.humans < 2) return;
    active.listenOnly = true;
    try {
      // A clip already playing would otherwise finish into the room after the
      // decision that the avatar should be silent.
      await active.voice?.stopSpeaking();
    } catch (err: unknown) {
      this.logger.warn("voice: could not stop speech for listen-only", { error: String(err) });
    }
  }

  /**
   * Tell the group about listen-only exactly once. A send that fails is tried
   * again on the next report and raises a health signal meanwhile, so the guard
   * is never quiet even if the meeting ends before a retry.
   */
  private async announceListenOnly(active: ActiveMeeting): Promise<void> {
    if (!active.listenOnly || active.listenOnlyAnnounced) return;
    try {
      await this.sendProject(
        active.projectId,
        `${MARK.attention} **Meeting** · listen-only — another person is in the room, so the avatar will not speak again in this meeting.`,
      );
      active.listenOnlyAnnounced = true;
    } catch (err: unknown) {
      this.raiseHealth(
        `could not announce listen-only in ${active.projectName}: ${String(err)}`,
      );
    }
  }

  /**
   * The store's health signal, for whatever watches this machine, plus an error
   * line. The group post stays the operator's surface; the reason never carries
   * the link.
   */
  private raiseHealth(reason: string): void {
    this.store.setValue("health:meeting", reason);
    this.logger.error("meeting: health signal", { reason });
  }

  /** The problem is over: do not leave a stale reason in the health key. */
  private clearHealth(): void {
    if (!this.store.getValue("health:meeting")) return;
    this.store.setValue("health:meeting", "");
  }

  /**
   * The watchdog: an admitted meeting that has stopped reporting is closed like
   * any other failure — one outcome, the row wiped, a health signal — because a
   * stored meeting must never linger with no terminal story.
   */
  private async checkMeetingActivity(): Promise<void> {
    const active = this.activeMeeting;
    if (!active || active.finished || active.stopping || !active.inRoom) return;
    const windowMs = this.config.meeting.activityWindowMs;
    if (this.now() - active.lastTelemetryAt <= windowMs) return;

    active.stopping = true;
    const seconds = Math.round(windowMs / 1000);
    this.raiseHealth(`no telemetry from ${active.projectName} for ${seconds} s`);
    this.logger.warn("meeting: no telemetry; closing the meeting", {
      project: active.projectName,
    });
    try {
      const handle = active.handle ?? (await active.joining?.catch(() => undefined));
      if (handle) await handle.leave();
    } catch {
      // The terminal outcome below is the story; a failed leave is not a second.
    }
    await this.finishMeeting(
      active,
      "failed",
      `the room stopped reporting activity for ${seconds} s`,
      true,
    );
  }

  /**
   * Begin hearing the room once the avatar is admitted. The transcript is only
   * ever a prompt: the port hands back text and levels, and runTask sets the
   * project explicitly because there is no incoming message to take it from.
   */
  private async startListening(active: ActiveMeeting): Promise<void> {
    if (active.voice || active.finished || !this.voicePort) return;
    try {
      // Listening can start even when the transcriber is not configured: the
      // pump still gates and counts, and the adapter names the reason on the
      // first utterance rather than pretending nothing was said.
      const availability = await this.voicePort.available();
      if (!availability.available) {
        this.logger.warn("voice: transcription is not configured", {
          project: active.projectName,
          reason: availability.reason,
        });
      }
      active.voice = await this.voicePort.start({
        projectId: active.projectId,
        projectName: active.projectName,
        onUtterance: (utterance) => {
          this.enqueue(() => this.onHeard(active, utterance));
        },
        onLevel: () => undefined,
        onFailure: (reason) => {
          this.enqueue(() => this.onVoiceFailure(active, reason));
        },
      });
      this.logger.info("voice: listening to the room", { project: active.projectName });
      // Say hello once the avatar is actually in the room and listening: the
      // operator asked for a sign that the connection is live, not just a face
      // on screen. Fire-and-forget, like every other clip.
      const greeting = this.config.voice.greeting.trim();
      if (greeting && active.voice) {
        void active.voice.speak(greeting).catch((err: unknown) => {
          this.logger.warn("voice: greeting failed", { error: String(err) });
        });
      }
    } catch (err: unknown) {
      this.logger.warn("voice: could not start listening", {
        project: active.projectName,
        error: String(err),
      });
      await this.sendProject(
        active.projectId,
        `${MARK.attention} **Voice** · could not start listening — ${String(err)}`,
      );
    }
  }

  /**
   * A transcript the energy gate let through. It is posted in the project's
   * group before anything else happens, then handed to runTask as a prompt — the
   * same session, status message and summary a typed task uses. The one
   * exception is an approval phrase while a permission is actually pending: the
   * room is told that decisions are typed and no task is started.
   */
  private async onHeard(active: ActiveMeeting, utterance: Utterance): Promise<void> {
    if (active.finished) return;
    const project = this.store.getProject(active.projectId);
    if (!project) return;
    const text = utterance.text.trim();
    if (!text) return;
    // A voice task has no incoming Signal message to derive the project from, so
    // the project is set here, explicitly.
    this.currentProjectId = active.projectId;
    const own = this.store.getChannel(active.projectId);
    if (own) this.conversation = own.channelId;
    // The transcript is always in the record first, even when the words are
    // refused below: the room must see what it said, not only the correction.
    await this.sendProject(active.projectId, `${MARK.info} heard: ${text}`);
    // A spoken approval can only be dangerous while something waits to be
    // approved. Say so aloud and in the group, and start nothing: the typed
    // Signal path stays the only way to decide a permission.
    if (
      parseInput(text).kind === "approval" &&
      this.livePending(this.channelFor(active.projectId)).length > 0
    ) {
      this.speakInMeeting(
        active.projectId,
        "A permission is waiting, but it is decided by typing approve, deny or always in Signal. Nothing was decided by speaking.",
      );
      await this.sendProject(
        active.projectId,
        `${MARK.attention} **Not decided** · a spoken word cannot answer a permission. Type **approve**, **deny** or **always** in Signal.`,
      );
      return;
    }
    await this.runTask(project, text, { voice: true, meetingStartedAt: active.startedAt });
  }

  /** A failure the operator must hear: no transcriber, a failed run. */
  private async onVoiceFailure(active: ActiveMeeting, reason: string): Promise<void> {
    if (active.finished) return;
    await this.sendProject(active.projectId, `${MARK.attention} **Voice** · ${reason}`);
  }

  /** Stop hearing the room and stop talking into it; called on every terminal path. */
  private async stopListening(active: ActiveMeeting): Promise<void> {
    const handle = active.voice;
    active.voice = undefined;
    if (!handle) return;
    try {
      // The room must not keep talking through a meeting that is ending; the
      // adapter drops every clip still queued behind the one playing.
      await handle.stopSpeaking();
    } catch (err: unknown) {
      this.logger.warn("voice: stopping speech failed", { error: String(err) });
    }
    try {
      await handle.stop();
    } catch (err: unknown) {
      this.logger.warn("voice: stopping failed", { error: String(err) });
    }
  }

  /**
   * Say something into the room of the meeting hearing this project. Fire and
   * forget: awaiting synthesis here would block `/meet stop`, approvals and
   * every later event, so a slow or held clip must never hold the chain. A
   * failure is logged and the meeting keeps running.
   */
  private speakInMeeting(projectId: string, text: string): void {
    const active = this.activeMeeting;
    if (!active || active.finished || active.projectId !== projectId) return;
    // A second human made the avatar listen-only: it hears, but never speaks.
    if (active.listenOnly) return;
    const handle = active.voice;
    if (!handle) return;
    // The adapter owns the one final cap (VoiceHandle.speak); the permission
    // announcement has already fitted its description into the budget.
    void handle.speak(text).catch((err: unknown) => {
      this.logger.warn("voice: could not speak into the meeting", { error: String(err) });
    });
  }

  /**
   * Say a voice task's outcome into the room. A task started by typing is never
   * spoken, and the answer goes only to the meeting that heard the question —
   * not a later one in the same project's group. The full text has already gone
   * to the group, and speech is never awaited: it must not block `/meet stop`,
   * approvals or the next agent event.
   */
  private speakOutcome(task: Task): void {
    if (!task.voice) return;
    const active = this.activeMeeting;
    if (!active || active.finished || active.projectId !== task.projectId) return;
    // An answer is never read into a room where the avatar is listen-only.
    if (active.listenOnly) return;
    if (this.store.getValue(`voiceMeeting:${task.id}`) !== String(active.startedAt)) return;
    const handle = active.voice;
    if (!handle) return;
    const text =
      task.state === "failed"
        ? `The task failed: ${task.error ?? "unknown error"}`
        : task.summary ?? "The task is done.";
    void handle.speak(text).catch((err: unknown) => {
      this.logger.warn("voice: could not speak the answer", { error: String(err) });
    });
  }

  private async editMeetingMessage(active: ActiveMeeting, markup: string): Promise<void> {
    const { text, styles } = renderStyled(markup);
    try {
      await this.signal.edit(this.channelFor(active.projectId), active.messageId, text, {
        styles,
      });
    } catch (err: unknown) {
      this.logger.warn("could not edit the meeting message", { error: String(err) });
    }
  }

  /**
   * The single terminal path: close the row (which wipes the link), end the
   * lifecycle message, and post exactly one summary with duration and outcome.
   */
  private async finishMeeting(
    active: ActiveMeeting,
    state: "left" | "failed",
    outcome: string,
    problem: boolean,
  ): Promise<void> {
    if (active.finished) return;
    active.finished = true;
    // Terminal means deaf too: the pump is closed before the row and the group
    // are settled, so no orphan polling outlives the meeting.
    await this.stopListening(active);
    const closedAt = this.now();
    this.store.closeMeeting(active.projectId, outcome, closedAt);
    if (this.activeMeeting === active) this.activeMeeting = undefined;
    // A clean ending resolves the meeting's health; a failed one keeps its reason.
    if (!problem) this.clearHealth();

    const mark = problem ? MARK.attention : MARK.ok;
    await this.editMeetingMessage(active, `${mark} **Meeting** · ${outcome}`);
    await this.sendProject(
      active.projectId,
      `${mark} **Meeting ended** · ${formatDuration(active.startedAt, closedAt)}\n${outcome}`,
    );
    this.logger.info("meeting ended", { project: active.projectName, state, outcome });
  }

  /** `/meet stop`: leave, close and wipe, then say how long it lasted. */
  private async stopMeeting(): Promise<void> {
    const active = this.activeMeeting;
    if (!active) {
      const open = this.store.getOpenMeeting();
      if (!open) {
        await this.reply("No meeting is running.");
        return;
      }
      // A row without a handle (the adapter is gone) must still be freed.
      const closedAt = this.now();
      this.store.closeMeeting(open.projectId, "ended without a live browser", closedAt);
      await this.sendProject(
        open.projectId,
        `${MARK.info} **Meeting ended** · ${formatDuration(open.startedAt, closedAt)}\nended without a live browser`,
      );
      return;
    }

    if (active.stopping) {
      await this.reply("The meeting is already ending.");
      return;
    }
    if (active.finished) {
      await this.reply("No meeting is running.");
      return;
    }

    active.stopping = true;
    this.logger.info("meeting: leaving on request", { project: active.projectName });
    let result: MeetingLeaveResult | undefined;
    try {
      const handle = active.handle ?? (await active.joining?.catch(() => undefined));
      if (handle) result = await handle.leave();
    } catch {
      result = { closed: false, detail: "leaving failed" };
    }
    // No handle means the join never produced a browser; there is nothing to
    // warn about, so a deliberate stop stays a clean ending.
    const survivor = result ? !result.closed : false;
    await this.finishMeeting(
      active,
      "left",
      survivor ? "the browser may still be open" : "left by /meet stop",
      survivor,
    );
  }

  /**
   * Startup reconciliation: a previous process may have died with a row open.
   * Closing it frees the slot and tells the group, so the slot is never locked
   * for good and the operator learns the meeting ended.
   */
  private async reconcileMeetings(): Promise<void> {
    const closedAt = this.now();
    const stale = this.store.closeOpenMeetings("interrupted by a restart", closedAt);
    for (const meeting of stale) {
      this.logger.warn("meeting: closed a row left open by a previous run", {
        project: meeting.projectId,
      });
      try {
        await this.sendProject(
          meeting.projectId,
          `${MARK.info} **Meeting ended** · ${formatDuration(meeting.startedAt, closedAt)}\nA previous run left this meeting open; it is closed now.`,
        );
      } catch (err: unknown) {
        // The row is already free; a Signal hiccup must not stop the service.
        this.logger.warn("meeting: could not announce the closed meeting", {
          project: meeting.projectId,
          error: String(err),
        });
      }
    }
  }

  // --- agent events --------------------------------------------------------

  private async handleAgentEvent(event: AgentEvent): Promise<void> {
    const task = this.store.getTask(event.taskId);
    if (!task) return;
    this.store.setValue(`latestTask:${task.projectId}`, task.id);

    if (event.type === "permission") {
      await this.handlePermission(event, task);
      return;
    }

    if ((event.choices?.length ?? 0) > 0) {
      await this.handleChoices(event, task);
      if (event.type === "choices") return;
    }

    if (event.type === "idle") {
      this.store.updateTask(task.id, {
        state: "done",
        ...(event.summary ? { summary: event.summary } : {}),
        updatedAt: this.now(),
      });
      const done = this.store.getTask(task.id)!;
      this.clearPendingForTask(done.id);
      await this.editStatus(done);
      await this.sendProject(done.projectId, summaryText(done));
      // A spoken question is answered aloud once the work finishes; the group
      // already has the full text, so this never holds up the event chain.
      this.speakOutcome(done);
      if (event.diffPath) {
        await this.signal.attach(this.channelFor(task.projectId), event.diffPath, "📄 Working diff");
      }
      return;
    }

    if (event.type === "error") {
      this.store.updateTask(task.id, {
        state: "failed",
        error: event.text ?? "unknown error",
        updatedAt: this.now(),
      });
      const failed = this.store.getTask(task.id)!;
      this.clearPendingForTask(failed.id);
      await this.editStatus(failed);
      await this.sendProject(failed.projectId, summaryText(failed));
      // A failure of a spoken task is spoken too, so the room is not left
      // waiting for an answer that will not come.
      this.speakOutcome(failed);
      return;
    }

    const milestone = milestoneText(event);
    if (milestone) {
      await this.sendProject(task.projectId, milestone);
    }

    // Files the agent asked to send (opencode -> operator).
    for (const path of event.attachPaths ?? []) {
      try {
        await this.signal.attach(this.channelFor(task.projectId), path, "from opencode");
      } catch (err: unknown) {
        this.logger.warn("could not attach file", { path, error: String(err) });
        await this.reply(`Could not send ${path}: ${String(err)}`);
      }
    }

    // A notice is something to tell the operator but not to act on (opencode's
    // questions can only be answered in its own window).
    if (event.type === "notice" && event.text) {
      const mark = event.severity === "attention" ? MARK.attention : MARK.info;
      await this.sendProject(task.projectId, `${mark} ${event.text}`);
    }

    this.store.updateTask(task.id, { state: "running", updatedAt: this.now() });
    // Only progress goes into the status line. The assistant's text is NOT put
    // here: the operator would then read the same answer twice, once in the
    // status message and once in the completion message that follows it.
    await this.editStatus(this.store.getTask(task.id)!, event.tool);
  }

  /**
   * Rewrite the task's one status message in place: blue while it works, green
   * or red when it ends. `detail` is progress the operator may act on ("bash",
   * "queued") — never the agent's own words, which belong to the completion
   * message and would otherwise appear twice in the chat.
   */
  private async editStatus(task: Task, detail?: string): Promise<void> {
    const messageId = this.store.getValue(`statusMsg:${task.id}`);
    const ownGroup = this.store.getChannel(task.projectId) !== undefined;
    const { text, styles } = renderStyled(statusLine(task, detail));
    if (messageId) {
      await this.signal.edit(this.channelFor(task.projectId), messageId, text, { styles });
    } else {
      const sent = await this.sendProject(task.projectId, text);
      this.store.setValue(`statusMsg:${task.id}`, sent.messageId);
    }
  }

  /** Operator-facing message: markup is rendered into Signal's text styles. */
  private async reply(markup: string, mark: string = MARK.info): Promise<OutgoingMessage> {
    const { text, styles } = renderStyled(`${mark} ${markup}`);
    return await this.signal.send(this.conversation, text, { styles });
  }

  /**
   * Send a project-scoped message. Inside the project's own group it needs no
   * label and no quote — the group is the context, and stacked quotes were the
   * main reason the conversation was hard to read. In a shared channel both are
   * added, so you can still tell which project spoke and reply to route.
   */
  private async sendProject(
    projectId: string,
    markup: string,
    labeled = true,
  ): Promise<OutgoingMessage> {
    const ownGroup = this.store.getChannel(projectId) !== undefined;
    const body = labeled && !ownGroup ? `${this.projectLabel(projectId)}\n${markup}` : markup;
    const { text, styles } = renderStyled(body);
    const sent = await this.signal.send(this.channelFor(projectId), text, { styles });
    this.store.setValue(`msgProject:${sent.messageId}`, projectId);
    return sent;
  }

  /** Header marking which project a message came from, e.g. `Project: appA`. */
  private projectLabel(projectId: string): string {
    return `**Project: ${this.store.getProject(projectId)?.name ?? projectId}**`;
  }

  /** Called when a project's plugin connects: register it, then greet and tag the message. */
  async onProjectConnected(project: Project): Promise<void> {
    this.store.upsertProject(project);
    await this.notifyProjectConnected(project.id);
  }

  /**
   * Introduce a project, once ever. A project with its own group is already
   * introduced by that group, and reconnects (every service restart) must not
   * re-announce anything — that produced a wall of identical greetings.
   */
  async notifyProjectConnected(projectId: string): Promise<void> {
    if (this.store.getChannel(projectId)) return;
    if (this.store.getValue(`greeted:${projectId}`)) return;
    this.store.setValue(`greeted:${projectId}`, "1");

    const name = this.store.getProject(projectId)?.name ?? projectId;
    await this.sendProject(
      projectId,
      `**${name}** is connected. Send **/open ${name}** to work on it in its own group.`,
      false,
    );
  }

  // --- option menus --------------------------------------------------------

  private choices(channel: string = this.conversation): PendingChoice[] {
    const raw = this.store.getValue(`choices:${channel}`);
    return raw ? (JSON.parse(raw) as PendingChoice[]) : [];
  }

  private setChoices(list: PendingChoice[], channel: string = this.conversation): void {
    this.store.setValue(`choices:${channel}`, JSON.stringify(list));
  }

  /** Post an option menu and remember it, so a reaction or number can answer it. */
  private async handleChoices(event: AgentEvent, task: Task): Promise<void> {
    const options = (event.choices ?? []).map((o) => o.trim()).filter(Boolean).slice(0, 10);
    if (options.length === 0) return;
    const channel = this.channelFor(task.projectId);
    const list = this.choices(channel);
    const number = list.length + 1;
    const sent = await this.askChoices(task.projectId, options, this.pollQuestion(task.projectId, number));
    list.push({
      id: crypto.randomUUID(),
      taskId: task.id,
      projectId: task.projectId,
      messageId: sent.messageId,
      options,
      number,
    });
    this.setChoices(list, channel);
  }

  /**
   * Ask with a real Signal poll when it fits (2-10 options), so the operator taps
   * an option instead of typing a number. Polls are single-select on purpose: a
   * multi-select poll sends a vote per tap, which would fire the pick early.
   * Anything else falls back to a numbered text menu.
   */
  private async askChoices(
    projectId: string,
    options: string[],
    question: string,
  ): Promise<OutgoingMessage> {
    if (options.length >= 2 && options.length <= 10) {
      try {
        const marked = `${MARK.attention} ${question}`;
    const poll = await this.signal.sendPoll(this.channelFor(projectId), marked, options, false);
        this.store.setValue(`msgProject:${poll.messageId}`, projectId);
        return poll;
      } catch (err: unknown) {
        this.logger.warn("poll send failed, using a text menu", { error: String(err) });
      }
    }
    return this.sendProject(projectId, choicesText(options, `${MARK.attention} ${question}`));
  }

  /**
   * Poll questions carry the project, since a bare "Option #1" in Note-to-Self
   * gives no clue which project is asking. The number only appears when more
   * than one question is open, and it is what the number reply refers to.
   */
  private pollQuestion(projectId: string, number: number): string {
    const name = this.store.getProject(projectId)?.name ?? projectId;
    const others = this.choices().length;
    return others > 0 ? `${name} (#${number}) — pick one` : `${name} — pick one`;
  }

  /** Resolve one option: send its text into the project's session as the next prompt. */
  private async resolveChoice(choice: PendingChoice, index: number): Promise<void> {
    await this.resolveChoices(choice, [index]);
  }

  /** Resolve one or more picks; each option's text becomes a prompt of its own. */
  private async resolveChoices(choice: PendingChoice, indexes: number[]): Promise<void> {
    const channel = this.channelFor(choice.projectId);
    const bad = indexes.filter((index) => !choice.options[index - 1]);
    if (bad.length > 0) {
      await this.reply(
        `Option #${choice.number} has no choice ${bad.join(", ")}. Reply with 1-${choice.options.length}.`,
      );
      return;
    }
    const chosen = indexes.map((index) => choice.options[index - 1]!) as string[];
    const project = this.store.getProject(choice.projectId);
    if (!project) {
      await this.reply("That project is no longer configured.");
      return;
    }
    this.setChoices(
      this.choices(channel).filter((c) => c.id !== choice.id),
      channel,
    );

    if (choice.action === "model") {
      for (const index of indexes) {
        const ref = choice.values?.[index - 1];
        const slash = ref ? ref.indexOf("/") : -1;
        if (!ref || slash <= 0) {
          await this.reply("That model is no longer available.");
          continue;
        }
        await this.switchModel(project, {
          providerID: ref.slice(0, slash),
          id: ref.slice(slash + 1),
        });
      }
      return;
    }

    for (const option of chosen) {
      await this.sendProject(choice.projectId, `Picked: ${option}`);
      try {
        await this.runTask(project, option);
      } catch (err: unknown) {
        this.logger.error("choice dispatch failed", { error: String(err) });
        await this.reply(`Could not send the choice: ${String(err)}`);
      }
    }
  }

  /**
   * Treat numbers as picks for the newest open menu. Accepts a single number or
   * a list ("2", "1,3", "1 3"), so several options can be picked in one message.
   */
  private async pickByNumber(text: string): Promise<boolean> {
    const list = this.choices();
    if (list.length === 0) return false;
    const choice = list[list.length - 1]!;
    const trimmed = text.trim();
    if (!/^\d{1,2}(?:[,\s;]+\d{1,2})*$/.test(trimmed)) return false;
    const indexes = [...new Set(trimmed.split(/[,\s;]+/).map(Number))];
    await this.resolveChoices(choice, indexes);
    return true;
  }

  /** A poll vote picks the option(s) of the menu that poll was sent for. */
  private async handlePollVote(vote: PollVote): Promise<void> {
    this.conversation = vote.channelId;
    if (vote.indexes.length === 0) return; // retracted vote: leave the menu open
    const choice = this.choices(vote.channelId).find((c) => c.messageId === vote.targetId);
    if (!choice) {
      await this.reportAnsweredPoll(vote);
      return;
    }
    await this.resolveChoices(choice, vote.indexes);
  }

  /**
   * A vote on a question that has already been answered. Signal re-sends a vote
   * whenever the operator changes their pick, so say plainly that it was too
   * late instead of ignoring it silently — once per poll.
   */
  private async reportAnsweredPoll(vote: PollVote): Promise<void> {
    const key = `answeredPoll:${vote.targetId}`;
    if (this.store.getValue(key)) return;
    this.store.setValue(key, "1");
    this.logger.info("poll vote ignored (already answered)", {
      poll: vote.targetId,
      indexes: vote.indexes,
    });
    await this.reply(
      "That question was already answered, so the new pick was ignored. Send the text as a message to change it.",
    );
  }

  // --- approvals -----------------------------------------------------------
  private pending(channel: string = this.conversation): PendingApproval[] {
    const raw = this.store.getValue(`pending:${channel}`);
    return raw ? (JSON.parse(raw) as PendingApproval[]) : [];
  }

  private setPending(list: PendingApproval[], channel: string = this.conversation): void {
    this.store.setValue(`pending:${channel}`, JSON.stringify(list));
  }

  /**
   * The pending approvals that can still be decided: their task is running.
   * A row whose task ended is dropped and the pruned list persisted, so a
   * stale entry can neither refuse speech nor survive a restart.
   */
  private livePending(channel: string): PendingApproval[] {
    const list = this.pending(channel);
    const live = list.filter((p) => {
      const state = this.store.getTask(p.taskId)?.state;
      return state === "started" || state === "running";
    });
    if (live.length !== list.length) this.setPending(live, channel);
    return live;
  }

  /** Drop a task's approvals from every channel's list, and persist the change. */
  private clearPendingForTask(taskId: string): void {
    for (const key of this.store.listKeys("pending:")) {
      const channel = key.slice("pending:".length);
      const list = this.pending(channel);
      const kept = list.filter((p) => p.taskId !== taskId);
      if (kept.length !== list.length) this.setPending(kept, channel);
    }
  }

  /**
   * The permission news read aloud. The head and the typed-decision
   * instruction are always spoken; only the description is fitted into what is
   * left, so a long command cannot swallow the instruction. The adapter applies
   * the one final cap to the clip.
   */
  private permissionAnnouncement(tool: string, description: string): string {
    const instruction = "Decide by typing approve, deny or always in Signal.";
    const head = `Approval needed for ${tool}: `;
    // One space before the instruction, and the ellipsis capSpoken adds.
    const budget = this.config.voice.maxSpeechChars - head.length - instruction.length - 2;
    const detail = budget > 0 ? capSpoken(description, budget) : "";
    return detail ? `${head}${detail} ${instruction}` : `${head}${instruction}`;
  }

  private async handlePermission(event: AgentEvent, task: Task): Promise<void> {
    const channel = this.channelFor(task.projectId);
    const p = event.permission;
    if (!p) return;
    if (p.safe) {
      await this.agent.answerPermission(p.id, "once");
      return;
    }
    if (this.store.getApproval(task.projectId, p.tool) === "always") {
      await this.agent.answerPermission(p.id, "once");
      return;
    }
    // Ask once per request: if opencode re-reports the same permission (because
    // our earlier answer did not take), do not nag the operator again.
    const asked = `permissionAsked:${p.id}`;
    if (this.store.getValue(asked)) return;
    this.store.setValue(asked, "1");
    const list = this.pending(channel);
    const number = list.length + 1;
    const sent = await this.sendProject(
      task.projectId,
      `${MARK.attention} **Approval needed** · \`${p.tool}\`\n${p.description}\n\nReply **approve**, **deny** or **always** — or tap 👍 / 👎.`,
    );
    list.push({
      permissionId: p.id,
      taskId: task.id,
      projectId: task.projectId,
      tool: p.tool,
      number,
      messageId: sent.messageId,
    });
    this.setPending(list, channel);
    // The group has the full prompt; the room gets the same news in a short
    // clip. Speech is fire-and-forget, so a held voice never delays the event.
    this.speakInMeeting(
      task.projectId,
      this.permissionAnnouncement(p.tool, p.description),
    );
  }

  private async resolveApproval(
    decision: PermissionDecision,
    targetMessageId?: string,
    channel: string = this.conversation,
  ): Promise<void> {
    const list = this.pending(channel);
    const index = targetMessageId
      ? list.findIndex((p) => p.messageId === targetMessageId)
      : 0;
    if (index < 0) {
      await this.reply("That message has no pending approval.");
      return;
    }
    const item = list[index]!;
    await this.agent.answerPermission(item.permissionId, decision);
    if (decision === "always") {
      this.store.setApproval(item.projectId, item.tool, "always");
    }
    list.splice(index, 1);
    this.setPending(list, channel);
    const word = decision === "reject" ? "denied" : decision === "always" ? "approved (always)" : "approved";
    await this.reply(`${word}: ${item.tool}`);
  }

  private async handleReaction(reaction: Reaction): Promise<void> {
    // The reaction names its channel, so resolve in that channel's own state.
    this.conversation = reaction.channelId;
    const map: Record<string, PermissionDecision> = { "👍": "once", "👎": "reject" };
    const decision = map[reaction.emoji];
    const list = this.pending(reaction.channelId);
    if (decision && list.some((p) => p.messageId === reaction.targetId)) {
      await this.resolveApproval(decision, reaction.targetId, reaction.channelId);
      return;
    }

    // A reaction on an option menu picks that option.
    const choice = this.choices(reaction.channelId).find(
      (c) => c.messageId === reaction.targetId,
    );
    if (!choice) return;
    const index = emojiChoice(reaction.emoji, choice.options.length);
    if (index) await this.resolveChoice(choice, index);
  }

  /** Queue a handler so dispatch preserves arrival order. */
  private enqueue(task: () => Promise<void>): void {
    this.chain = this.chain.then(task).catch((err: unknown) => {
      this.logger.error("handler error", { error: String(err) });
    });
  }
}
