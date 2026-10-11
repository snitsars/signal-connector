/**
 * In-memory AgentPort fake for core tests. Records prompts and permissions.
 */
import type { AgentPort, StartTaskInput } from "../../core/ports.js";
import type { AgentEvent, PermissionDecision, Project } from "../../domain/types.js";

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

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async health(): Promise<boolean> {
    return true;
  }

  async startTask(input: StartTaskInput): Promise<{ sessionId: string }> {
    const sessionId = input.sessionId ?? `session-${++this.seq}`;
    this.started.push({ ...input, sessionId });
    return { sessionId };
  }

  async newSession(project: Project): Promise<{ sessionId: string }> {
    const sessionId = `session-${++this.seq}`;
    this.newSessions.push(project.id);
    return { sessionId };
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

  /** Test helper: emit an agent event. */
  emit(event: AgentEvent): void {
    for (const h of this.handlers) h(event);
  }
}
