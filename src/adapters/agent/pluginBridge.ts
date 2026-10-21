/**
 * AgentPort backed by per-project opencode plugins over the bridge (spine AD-5).
 * The service core calls this exactly like any other agent adapter; commands go
 * out to the plugin for the project, and events/permissions come back.
 */
import crypto from "node:crypto";
import type { Logger } from "../../logging/logger.js";
import type { AgentEvent, ModelRef, PermissionDecision, Project } from "../../domain/types.js";
import type { BridgeHub } from "../../bridge/hub.js";
import type { AgentPort, StartTaskInput } from "../../core/ports.js";
import { writeDiffFile } from "./diff.js";

export class PluginBridgeAgent implements AgentPort {
  private readonly handlers: ((e: AgentEvent) => void)[] = [];
  private readonly taskProject = new Map<string, string>();
  private readonly permissionProject = new Map<string, string>();

  constructor(
    private readonly hub: BridgeHub,
    private readonly logger: Logger,
  ) {
    this.hub.onEvent((envelope) => {
      this.taskProject.set(envelope.taskId, envelope.projectId);
      if (envelope.event.type === "permission" && envelope.event.permission) {
        this.permissionProject.set(envelope.event.permission.id, envelope.projectId);
      }
      // The plugin sends the patch text; writing the file and attaching it stays
      // on this side of the bridge (AD-7: the core only sees a path).
      const event = envelope.diffText
        ? { ...envelope.event, diffPath: writeDiffFile(envelope.diffText) }
        : envelope.event;
      for (const handler of this.handlers) handler(event);
    });
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async health(): Promise<boolean> {
    return this.hub.any();
  }

  async startTask(input: StartTaskInput): Promise<{ sessionId: string }> {
    const conn = this.hub.get(input.project.id);
    if (!conn) throw new Error(`no plugin connected for project ${input.project.id}`);
    // Ask the plugin for the session before the prompt: then the service knows
    // which session ran the task, can reuse it, and never leaks one session per
    // utterance. Without a sessionId the plugin used to create an unreported one.
    const sessionId = input.sessionId ?? (await this.newSession(input.project)).sessionId;
    conn.send({
      type: "command",
      kind: "prompt",
      taskId: input.taskId,
      prompt: input.prompt,
      ...(sessionId ? { sessionId } : {}),
    });
    this.taskProject.set(input.taskId, input.project.id);
    return { sessionId };
  }

  async newSession(project: Project): Promise<{ sessionId: string }> {
    const requestId = crypto.randomUUID();
    const sessionId = await this.hub.requestSession(project.id, requestId);
    return { sessionId };
  }

  async listModels(project: Project): Promise<ModelRef[]> {
    const conn = this.hub.get(project.id);
    if (!conn) throw new Error(`no plugin connected for project ${project.id}`);
    return await this.hub.requestModels(project.id, crypto.randomUUID());
  }

  async setModel(input: { project: Project; sessionId: string; model: ModelRef }): Promise<void> {
    const conn = this.hub.get(input.project.id);
    if (!conn) throw new Error(`no plugin connected for project ${input.project.id}`);
    const reply = await this.hub.requestSetModel(
      input.project.id,
      crypto.randomUUID(),
      input.sessionId,
      input.model,
    );
    if (!reply.ok) throw new Error(reply.detail ?? "the plugin could not switch the model");
  }

  subscribe(handler: (e: AgentEvent) => void): void {
    this.handlers.push(handler);
  }

  async answerPermission(permissionId: string, decision: PermissionDecision): Promise<void> {
    const projectId = this.permissionProject.get(permissionId);
    if (!projectId) throw new Error(`unknown permission request ${permissionId}`);
    const conn = this.hub.get(projectId);
    if (!conn) throw new Error(`no plugin connected for project ${projectId}`);
    conn.send({ type: "permission_reply", permissionId, decision });
    this.permissionProject.delete(permissionId);
  }

  async abort(taskId: string): Promise<void> {
    const projectId = this.taskProject.get(taskId);
    if (!projectId) return;
    this.hub.get(projectId)?.send({ type: "command", kind: "stop", taskId });
  }

  /** A project needs launching exactly when no plugin is connected for it. */
  isConnected(projectId: string): boolean {
    return this.hub.get(projectId) !== undefined;
  }
}
