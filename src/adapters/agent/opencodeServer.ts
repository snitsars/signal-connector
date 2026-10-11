/**
 * AgentPort over the opencode v2 HTTP API (spine AD-5, primary path).
 * Endpoints confirmed against the server's OpenAPI document:
 *   POST /api/session                     create (body.location.directory)
 *   POST /api/session/{id}/prompt         send a prompt
 *   GET  /api/session/{id}/permission     list pending permission requests
 *   POST /api/session/{id}/permission/{rid}/reply  {decision}
 *   POST /api/session/{id}/interrupt      abort
 *   GET  /api/session/{id}/diff           file diffs
 *   GET  /api/event                       SSE event stream
 * Auth is HTTP basic (OPENCODE_SERVER_USERNAME / OPENCODE_SERVER_PASSWORD).
 */
import type { AgentPort, StartTaskInput } from "../../core/ports.js";
import type { AgentEvent, PermissionDecision, Project } from "../../domain/types.js";
import type { Logger } from "../../logging/logger.js";
import { mapOpenCodeEvent } from "./eventMapper.js";

export interface OpenCodeServerOptions {
  baseUrl: string;
  username?: string;
  password?: string;
  logger: Logger;
  permissionPollMs?: number;
}

interface SessionInfo {
  id: string;
}

interface PermissionRequestDto {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  message?: string;
}

const SAFE_ACTIONS = new Set(["read", "list", "glob", "grep", "webfetch", "websearch"]);

export class OpenCodeServerAdapter implements AgentPort {
  private readonly opts: Required<Omit<OpenCodeServerOptions, "username" | "password">> & {
    username?: string;
    password?: string;
  };
  private handlers: ((e: AgentEvent) => void)[] = [];
  private running = false;
  private eventsAbort: AbortController | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private readonly taskSession = new Map<string, string>();
  private readonly sessionTask = new Map<string, string>();
  private readonly permissionSession = new Map<string, string>();
  private readonly seenPermissions = new Set<string>();

  constructor(options: OpenCodeServerOptions) {
    this.opts = { permissionPollMs: 3000, ...options };
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json", ...extra };
    const user = this.opts.username ?? process.env.OPENCODE_SERVER_USERNAME;
    const pass = this.opts.password ?? process.env.OPENCODE_SERVER_PASSWORD;
    if (user && pass) {
      headers["authorization"] = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
    }
    return headers;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.opts.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      throw new Error(`opencode ${method} ${path} -> ${response.status}`);
    }
    if (response.status === 204) return undefined as T;
    const json = (await response.json()) as { data?: T } | T;
    if (json && typeof json === "object" && "data" in (json as Record<string, unknown>)) {
      return (json as { data: T }).data;
    }
    return json as T;
  }

  async start(): Promise<void> {
    this.running = true;
    void this.consumeEvents();
    this.pollTimer = setInterval(() => void this.pollPermissions(), this.opts.permissionPollMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.eventsAbort?.abort();
  }

  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.opts.baseUrl}/api/info`, { headers: this.headers() });
      return response.ok;
    } catch {
      return false;
    }
  }

  async startTask(input: StartTaskInput): Promise<{ sessionId: string }> {
    const sessionId = input.sessionId ?? (await this.createSession(input.project)).id;
    this.taskSession.set(input.taskId, sessionId);
    this.sessionTask.set(sessionId, input.taskId);
    await this.request("POST", `/api/session/${sessionId}/prompt`, { text: input.prompt });
    return { sessionId };
  }

  async newSession(project: Project): Promise<{ sessionId: string }> {
    const session = await this.createSession(project);
    return { sessionId: session.id };
  }

  private createSession(project: Project): Promise<SessionInfo> {
    return this.request<SessionInfo>("POST", "/api/session", {
      title: project.name,
      location: { directory: project.path },
    });
  }

  subscribe(handler: (e: AgentEvent) => void): void {
    this.handlers.push(handler);
  }

  async answerPermission(permissionId: string, decision: PermissionDecision): Promise<void> {
    const sessionId = this.permissionSession.get(permissionId);
    if (!sessionId) throw new Error(`unknown permission request ${permissionId}`);
    await this.request("POST", `/api/session/${sessionId}/permission/${permissionId}/reply`, {
      decision,
    });
    this.permissionSession.delete(permissionId);
  }

  async abort(taskId: string): Promise<void> {
    const sessionId = this.taskSession.get(taskId);
    if (sessionId) await this.request("POST", `/api/session/${sessionId}/interrupt`);
  }

  private emit(event: AgentEvent): void {
    for (const handler of this.handlers) handler(event);
  }

  private async consumeEvents(): Promise<void> {
    this.eventsAbort = new AbortController();
    try {
      const response = await fetch(`${this.opts.baseUrl}/api/event`, {
        headers: this.headers({ accept: "text/event-stream" }),
        signal: this.eventsAbort.signal,
      });
      if (!response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (this.running) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line.startsWith("data:")) this.handleEventData(line.slice(5).trim());
          index = buffer.indexOf("\n");
        }
      }
    } catch (err) {
      if (this.running) this.opts.logger.warn("opencode event stream ended", { error: String(err) });
    }
  }

  private handleEventData(payload: string): void {
    if (!payload || payload === "[DONE]") return;
    let raw: unknown;
    try {
      raw = JSON.parse(payload);
    } catch {
      return;
    }
    const record = raw as Record<string, unknown>;
    const sessionId =
      typeof record.sessionID === "string"
        ? record.sessionID
        : typeof (record.properties as Record<string, unknown> | undefined)?.sessionID === "string"
          ? ((record.properties as Record<string, unknown>).sessionID as string)
          : undefined;
    const taskId = sessionId ? this.sessionTask.get(sessionId) : undefined;
    if (!taskId) return;
    const event = mapOpenCodeEvent(raw, taskId);
    if (event?.type === "permission" && event.permission && sessionId) {
      this.permissionSession.set(event.permission.id, sessionId);
    }
    if (event) this.emit(event);
  }

  private async pollPermissions(): Promise<void> {
    for (const [sessionId, taskId] of this.sessionTask) {
      try {
        const requests = await this.request<PermissionRequestDto[]>(
          "GET",
          `/api/session/${sessionId}/permission`,
        );
        for (const request of requests ?? []) {
          if (this.seenPermissions.has(request.id)) continue;
          this.seenPermissions.add(request.id);
          this.permissionSession.set(request.id, sessionId);
          const tool = request.action;
          this.emit({
            type: "permission",
            taskId,
            at: Date.now(),
            permission: {
              id: request.id,
              taskId,
              tool,
              description: request.message ?? `${tool} ${request.resources.join(", ")}`,
              safe: SAFE_ACTIONS.has(tool),
            },
          });
        }
      } catch {
        // session may be gone; ignore
      }
    }
  }
}
