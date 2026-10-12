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
  PermissionDecision,
  Project,
  Reaction,
  Task,
} from "../domain/types.js";
import type { AgentPort, SignalPort } from "./ports.js";
import { HELP_TEXT, KNOWN_COMMANDS, parseInput } from "./router.js";
import { milestoneText, statusLine, summaryText } from "./progress.js";

export interface CoreDeps {
  store: Store;
  signal: SignalPort;
  agent: AgentPort;
  config: Config;
  logger: Logger;
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

const PROJECT_ID = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

export class CoreApp {
  private readonly store: Store;
  private readonly signal: SignalPort;
  private readonly agent: AgentPort;
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly now: () => number;
  private controlChannel = "self";
  /** Serializes handler dispatch so events are processed in arrival order. */
  private chain: Promise<void> = Promise.resolve();

  constructor(deps: CoreDeps) {
    this.store = deps.store;
    this.signal = deps.signal;
    this.agent = deps.agent;
    this.config = deps.config;
    this.logger = deps.logger;
    this.now = deps.now ?? (() => Date.now());
  }

  async start(): Promise<void> {
    for (const p of this.config.projects) {
      this.store.upsertProject({ id: PROJECT_ID(p.name), name: p.name, path: p.path });
    }
    this.controlChannel = this.config.channel.id ?? this.config.signal.account ?? "self";

    this.signal.onMessage((m) => this.enqueue(() => this.handleMessage(m)));
    this.signal.onReaction((r) => this.enqueue(() => this.handleReaction(r)));
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
    if (!msg.inControlChannel) return;
    this.controlChannel = msg.channelId;
    this.logger.debug("control message", { text: msg.text });
    const parsed = parseInput(msg.text);

    if (parsed.kind === "approval") {
      if (this.pending().length > 0) {
        await this.resolveApproval(parsed.decision);
      } else {
        await this.signal.send(this.controlChannel, "No pending approval.");
      }
      return;
    }
    if (parsed.kind === "command") {
      await this.dispatchCommand(parsed.name, parsed.args);
      return;
    }
    await this.startTask(parsed.text);
  }

  private async dispatchCommand(name: string, args: string): Promise<void> {
    if (!KNOWN_COMMANDS.includes(name as (typeof KNOWN_COMMANDS)[number])) {
      await this.signal.send(this.controlChannel, `Unknown command /${name}.\n\n${HELP_TEXT}`);
      return;
    }
    switch (name) {
      case "help":
        await this.signal.send(this.controlChannel, HELP_TEXT);
        return;
      case "projects": {
        const projects = this.store.listProjects();
        const text =
          projects.length === 0
            ? "No projects configured. Add them to config.toml."
            : projects.map((p) => `- ${p.name} (${p.path})`).join("\n");
        await this.signal.send(this.controlChannel, text);
        return;
      }
      case "use":
        await this.useProject(args);
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
        await this.signal.send(this.controlChannel, HELP_TEXT);
    }
  }

  // --- commands ------------------------------------------------------------

  private activeProject(): Project | undefined {
    const id = this.store.getValue(`activeProject:${this.controlChannel}`);
    return id ? this.store.getProject(id) : undefined;
  }

  private async useProject(name: string): Promise<void> {
    if (!name) {
      await this.signal.send(this.controlChannel, "Usage: /use <project>");
      return;
    }
    const project = this.store.getProject(name);
    if (!project) {
      await this.signal.send(this.controlChannel, `Unknown project "${name}". Try /projects.`);
      return;
    }
    this.store.setValue(`activeProject:${this.controlChannel}`, project.id);
    await this.signal.send(this.controlChannel, `Active project: ${project.name}`);
  }

  private async startTask(prompt: string): Promise<void> {
    if (!prompt) {
      await this.signal.send(this.controlChannel, "Usage: /task <prompt>");
      return;
    }
    const project = this.activeProject();
    if (!project) {
      await this.signal.send(this.controlChannel, "No active project. Use /use <project> first.");
      return;
    }
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

    const { messageId } = await this.signal.send(
      this.controlChannel,
      statusLine(task, "queued"),
    );
    this.store.setValue(`statusMsg:${task.id}`, messageId);
    this.logger.info("task started", { taskId: task.id, project: project.name });
  }

  private async showStatus(): Promise<void> {
    const project = this.activeProject();
    if (!project) {
      await this.signal.send(this.controlChannel, "No active project.");
      return;
    }
    const task = this.store.getActiveTask(project.id) ?? this.latestTask(project.id);
    if (!task) {
      await this.signal.send(this.controlChannel, `No tasks for ${project.name} yet.`);
      return;
    }
    await this.signal.send(this.controlChannel, statusLine(task, task.summary));
  }

  private latestTask(projectId: string): Task | undefined {
    const raw = this.store.getValue(`latestTask:${projectId}`);
    return raw ? this.store.getTask(raw) : undefined;
  }

  private async forkSession(): Promise<void> {
    const project = this.activeProject();
    if (!project) {
      await this.signal.send(this.controlChannel, "No active project.");
      return;
    }
    const { sessionId } = await this.agent.newSession(project);
    this.store.setSession(project.id, sessionId);
    await this.signal.send(this.controlChannel, `New session for ${project.name}.`);
  }

  private async stopTask(): Promise<void> {
    const project = this.activeProject();
    if (!project) {
      await this.signal.send(this.controlChannel, "No active project.");
      return;
    }
    const task = this.store.getActiveTask(project.id);
    if (!task) {
      await this.signal.send(this.controlChannel, "No running task.");
      return;
    }
    await this.agent.abort(task.id);
    this.store.updateTask(task.id, { state: "aborted", updatedAt: this.now() });
    await this.signal.send(this.controlChannel, `Aborted task ${task.id}.`);
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

    if (event.type === "idle") {
      this.store.updateTask(task.id, {
        state: "done",
        ...(event.summary ? { summary: event.summary } : {}),
        updatedAt: this.now(),
      });
      const done = this.store.getTask(task.id)!;
      await this.editStatus(done, event.summary);
      await this.signal.send(this.controlChannel, summaryText(done));
      if (event.diffPath) {
        await this.signal.attach(this.controlChannel, event.diffPath, "diff");
      }
      return;
    }

    if (event.type === "error") {
      this.store.updateTask(task.id, {
        state: "failed",
        error: event.text ?? "unknown error",
        updatedAt: this.now(),
      });
      await this.editStatus(this.store.getTask(task.id)!, event.text);
      await this.signal.send(this.controlChannel, summaryText(this.store.getTask(task.id)!));
      return;
    }

    const milestone = milestoneText(event);
    if (milestone) {
      await this.signal.send(this.controlChannel, milestone);
    }

    this.store.updateTask(task.id, { state: "running", updatedAt: this.now() });
    await this.editStatus(this.store.getTask(task.id)!, event.text ?? event.tool);
  }

  private async editStatus(task: Task, detail?: string): Promise<void> {
    const messageId = this.store.getValue(`statusMsg:${task.id}`);
    const text = statusLine(task, detail);
    if (messageId) {
      await this.signal.edit(this.controlChannel, messageId, text);
    } else {
      const sent = await this.signal.send(this.controlChannel, text);
      this.store.setValue(`statusMsg:${task.id}`, sent.messageId);
    }
  }

  // --- approvals -----------------------------------------------------------

  private pending(): PendingApproval[] {
    const raw = this.store.getValue(`pending:${this.controlChannel}`);
    return raw ? (JSON.parse(raw) as PendingApproval[]) : [];
  }

  private setPending(list: PendingApproval[]): void {
    this.store.setValue(`pending:${this.controlChannel}`, JSON.stringify(list));
  }

  private async handlePermission(event: AgentEvent, task: Task): Promise<void> {
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
    const list = this.pending();
    const number = list.length + 1;
    const sent = await this.signal.send(
      this.controlChannel,
      `Permission #${number}: ${p.tool}\n${p.description}\nReply approve / deny / always, or react.`,
    );
    list.push({
      permissionId: p.id,
      taskId: task.id,
      projectId: task.projectId,
      tool: p.tool,
      number,
      messageId: sent.messageId,
    });
    this.setPending(list);
  }

  private async resolveApproval(decision: PermissionDecision, targetMessageId?: string): Promise<void> {
    const list = this.pending();
    const index = targetMessageId
      ? list.findIndex((p) => p.messageId === targetMessageId)
      : 0;
    if (index < 0) {
      await this.signal.send(this.controlChannel, "That message has no pending approval.");
      return;
    }
    const item = list[index]!;
    await this.agent.answerPermission(item.permissionId, decision);
    if (decision === "always") {
      this.store.setApproval(item.projectId, item.tool, "always");
    }
    list.splice(index, 1);
    this.setPending(list);
    const word = decision === "reject" ? "denied" : decision === "always" ? "approved (always)" : "approved";
    await this.signal.send(this.controlChannel, `${word}: ${item.tool}`);
  }

  private async handleReaction(reaction: Reaction): Promise<void> {
    const map: Record<string, PermissionDecision> = { "👍": "once", "👎": "reject" };
    const decision = map[reaction.emoji];
    if (!decision) return;
    const list = this.pending();
    if (!list.some((p) => p.messageId === reaction.targetId)) return;
    await this.resolveApproval(decision, reaction.targetId);
  }

  /** Queue a handler so dispatch preserves arrival order. */
  private enqueue(task: () => Promise<void>): void {
    this.chain = this.chain.then(task).catch((err: unknown) => {
      this.logger.error("handler error", { error: String(err) });
    });
  }
}
