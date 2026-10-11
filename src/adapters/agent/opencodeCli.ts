/**
 * SignalPort over `opencode run --format json` (spine AD-5, fallback path).
 * Spawns opencode per task in the project directory and maps its JSON lines to
 * AgentEvents. This is the working adapter until the v2 server API is confirmed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { AgentPort, StartTaskInput } from "../../core/ports.js";
import type { AgentEvent, PermissionDecision, Project } from "../../domain/types.js";
import type { Logger } from "../../logging/logger.js";
import { mapOpenCodeEvent } from "./eventMapper.js";

export interface OpenCodeCliOptions {
  opencodePath: string;
  logger: Logger;
}

interface RunningTask {
  child: ChildProcess;
  project: Project;
}

export class OpenCodeCliAdapter implements AgentPort {
  private readonly opts: OpenCodeCliOptions;
  private handlers: ((e: AgentEvent) => void)[] = [];
  private running = new Map<string, RunningTask>();

  constructor(options: OpenCodeCliOptions) {
    this.opts = options;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {
    for (const { child } of this.running.values()) child.kill();
    this.running.clear();
  }

  async health(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.opts.opencodePath, ["--version"], { windowsHide: true });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
    });
  }

  async startTask(input: StartTaskInput): Promise<{ sessionId: string }> {
    const sessionId = input.sessionId ?? `${input.project.id}-${Date.now()}`;
    const args = ["run", "--format", "json", "--session", sessionId, "--", input.prompt];
    const child = spawn(this.opts.opencodePath, args, {
      cwd: input.project.path,
      windowsHide: true,
    });
    this.running.set(input.taskId, { child, project: input.project });
    this.pump(input.taskId, child);
    return { sessionId };
  }

  async newSession(project: Project): Promise<{ sessionId: string }> {
    return { sessionId: `${project.id}-${Date.now()}` };
  }

  private pump(taskId: string, child: ChildProcess): void {
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) this.emitLine(taskId, line);
        index = buffer.indexOf("\n");
      }
    });
    child.on("exit", (code) => {
      this.running.delete(taskId);
      this.emit({ type: "idle", taskId, at: Date.now(), summary: `exited ${code ?? 0}` });
    });
    child.on("error", (err) => {
      this.emit({ type: "error", taskId, at: Date.now(), text: String(err) });
    });
  }

  private emitLine(taskId: string, line: string): void {
    try {
      const event = mapOpenCodeEvent(JSON.parse(line), taskId);
      if (event) this.emit(event);
    } catch {
      this.emit({ type: "status", taskId, at: Date.now(), text: line.slice(0, 200) });
    }
  }

  subscribe(handler: (e: AgentEvent) => void): void {
    this.handlers.push(handler);
  }

  async answerPermission(_permissionId: string, _decision: PermissionDecision): Promise<void> {
    // The CLI path runs with the session's permission config; interactive
    // round-trips are a server-API feature (ticket 3.3).
  }

  async abort(taskId: string): Promise<void> {
    const task = this.running.get(taskId);
    if (task) task.child.kill();
  }

  private emit(event: AgentEvent): void {
    for (const h of this.handlers) h(event);
  }
}
