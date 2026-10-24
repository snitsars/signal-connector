/**
 * In-memory AgentPort fake for core tests. Records prompts and permissions.
 */
import type { AgentPort, StartTaskInput } from "../../core/ports.js";
import type { AgentEvent, ModelRef, PermissionDecision, Project } from "../../domain/types.js";

export interface StartedTask extends StartTaskInput {
  sessionId: string;
}

export class FakeAgent implements AgentPort {
  readonly started: StartedTask[] = [];
  readonly decisions: { permissionId: string; decision: PermissionDecision }[] = [];
  readonly aborted: string[] = [];
  readonly newSessions: string[] = [];
  private handlers: ((e: AgentEvent) => void)[] = [];
  private seq = 0;
  /** Set to make startTask fail, as a disconnected plugin would. */
  failStart: string | undefined;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async health(): Promise<boolean> {
    return true;
  }

  async startTask(input: StartTaskInput): Promise<{ sessionId: string }> {
    if (this.failStart) throw new Error(this.failStart);
    const sessionId = input.sessionId ?? `session-${++this.seq}`;
    this.started.push({ ...input, sessionId });
    return { sessionId };
  }

  async newSession(project: Project): Promise<{ sessionId: string }> {
    const sessionId = `session-${++this.seq}`;
    this.newSessions.push(project.id);
    return { sessionId };
  }

  /** Test helper: the models this fake offers. */
  readonly models: ModelRef[] = [
    { providerID: "opencode-go", id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    { providerID: "opencode", id: "muse-spark-1.2", name: "Muse Spark 1.2" },
  ];
  readonly modelSwitches: { projectId: string; sessionId: string; model: ModelRef }[] = [];
  /** Set to make model switches fail, as a broken plugin round trip would. */
  failModelSet = false;

  async listModels(): Promise<ModelRef[]> {
    return this.models;
  }

  async setModel(input: { project: Project; sessionId: string; model: ModelRef }): Promise<void> {
    if (this.failModelSet) throw new Error("the plugin could not switch the model");
    this.modelSwitches.push({
      projectId: input.project.id,
      sessionId: input.sessionId,
      model: input.model,
    });
  }

  subscribe(handler: (e: AgentEvent) => void): void {
    this.handlers.push(handler);
  }

  async answerPermission(permissionId: string, decision: PermissionDecision): Promise<void> {
    this.decisions.push({ permissionId, decision });
  }

  async abort(taskId: string): Promise<void> {
    this.aborted.push(taskId);
  }

  /** Test helper: mark a project as connected. */
  isConnected(projectId: string): boolean {
    return this.connected.has(projectId);
  }

  readonly connected = new Set<string>();

  /** Test helper: emit an agent event. */
  emit(event: AgentEvent): void {
    for (const h of this.handlers) h(event);
  }
}
