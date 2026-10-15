/**
 * Core application: wires the ports into command handling, task lifecycle,
 * approval conversation, and progress notifications. Contains no I/O itself —
 * everything goes through SignalPort / AgentPort / Store.
 */
import crypto from "node:crypto";
import type { Config } from "../config/config.js";
import type { Logger } from "../logging/logger.js";
import type { Store } from "../store/store.js";
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
import type { AgentPort, LauncherPort, QuoteRef, SignalPort } from "./ports.js";
import { renderStyled } from "./format.js";
import { MARK } from "./progress.js";
import { HELP_TEXT, KNOWN_COMMANDS, parseInput } from "./router.js";
import {
  choicesText,
  emojiChoice,
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
  now?: () => number;
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


export class CoreApp {
  private readonly store: Store;
  private readonly signal: SignalPort;
  private readonly agent: AgentPort;
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly launcher: LauncherPort | undefined;
  private readonly now: () => number;
  private controlChannel = "self";
  /** The project this message is about (its channel, or the quoted project). */
  private currentProjectId: string | undefined;
  /** Channel the message being handled came from; replies go back there. */
  private conversation = "self";
  /** Serializes handler dispatch so events are processed in arrival order. */
  private chain: Promise<void> = Promise.resolve();

  constructor(deps: CoreDeps) {
    this.store = deps.store;
    this.signal = deps.signal;
    this.agent = deps.agent;
    this.config = deps.config;
    this.logger = deps.logger;
    this.launcher = deps.launcher;
    this.now = deps.now ?? (() => Date.now());
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
    this.logger.info("core started", { channel: this.controlChannel });
  }

  async stop(): Promise<void> {
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
    this.logger.debug("control message", { text: msg.text, project: projectId });

    const parsed = parseInput(msg.text);

    if (parsed.kind === "approval") {
      if (this.pending().length > 0) {
        await this.resolveApproval(parsed.decision);
      } else {
        await this.reply("No pending approval.");
      }
      return;
    }
    if (parsed.kind === "command") {
      await this.dispatchCommand(parsed.name, parsed.args);
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

  private async dispatchCommand(name: string, args: string): Promise<void> {
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

  /** Start a task in a specific project (used by /task and by option picks). */
  private async runTask(project: Project, prompt: string): Promise<Task> {
    const task: Task = {
      id: crypto.randomUUID(),
      projectId: project.id,
      sessionId: "",
      prompt,
      state: "started",
      startedAt: this.now(),
      updatedAt: this.now(),
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
    await this.reply(`Aborted task ${task.id}.`);
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
      await this.editStatus(done, event.summary);
      await this.sendProject(done.projectId, summaryText(done));
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
      await this.editStatus(failed, event.text);
      await this.sendProject(failed.projectId, summaryText(failed));
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
    await this.editStatus(this.store.getTask(task.id)!, event.text ?? event.tool);
  }

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
