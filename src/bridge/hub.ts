/**
 * Transport-agnostic registry + router for plugin connections (spine AD-5).
 * The ws server in server.ts feeds decoded messages here; the AgentPort
 * adapter in ../adapters/agent/pluginBridge.ts drives commands out.
 */
import type { AgentEvent } from "../domain/types.js";
import {
  projectIdFor,
  type BridgeOutbound,
  type EventMessage,
  type PluginToService,
  type RegisterMessage,
  type SessionCreatedMessage,
} from "./protocol.js";

export interface PluginConnection {
  projectId: string;
  projectName: string;
  projectPath: string;
  send(message: BridgeOutbound): void;
}

export interface EventEnvelope {
  projectId: string;
  taskId: string;
  event: AgentEvent;
}

export class BridgeHub {
  private readonly connections = new Map<string, PluginConnection>();
  private readonly eventHandlers: ((e: EventEnvelope) => void)[] = [];
  private readonly sessionWaiters = new Map<string, (sessionId: string) => void>();

  register(send: (m: BridgeOutbound) => void, msg: RegisterMessage): PluginConnection {
    const projectId = projectIdFor(msg.project);
    const conn: PluginConnection = {
      projectId,
      projectName: msg.project.name,
      projectPath: msg.project.path,
      send,
    };
    this.connections.set(projectId, conn);
    send({ type: "registered", projectId, projectName: msg.project.name });
    return conn;
  }

  dispatch(conn: PluginConnection | undefined, msg: PluginToService): void {
    if (!conn) return;
    switch (msg.type) {
      case "event": {
        const envelope: EventEnvelope = { projectId: conn.projectId, taskId: (msg as EventMessage).taskId, event: (msg as EventMessage).event };
        for (const handler of this.eventHandlers) handler(envelope);
        return;
      }
      case "session_created": {
        const { requestId, sessionId } = msg as SessionCreatedMessage;
        const waiter = this.sessionWaiters.get(requestId);
        if (waiter) {
          this.sessionWaiters.delete(requestId);
          waiter(sessionId);
        }
        return;
      }
      default:
        return;
    }
  }

  unregister(conn: PluginConnection): void {
    if (this.connections.get(conn.projectId) === conn) this.connections.delete(conn.projectId);
  }

  get(projectId: string): PluginConnection | undefined {
    return this.connections.get(projectId);
  }

  any(): boolean {
    return this.connections.size > 0;
  }

  list(): PluginConnection[] {
    return [...this.connections.values()];
  }

  onEvent(handler: (e: EventEnvelope) => void): void {
    this.eventHandlers.push(handler);
  }

  requestSession(projectId: string, requestId: string, timeoutMs = 10_000): Promise<string> {
    const conn = this.connections.get(projectId);
    if (!conn) return Promise.reject(new Error(`no plugin connected for project ${projectId}`));
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.sessionWaiters.delete(requestId);
        reject(new Error("newSession timed out"));
      }, timeoutMs);
      this.sessionWaiters.set(requestId, (sessionId) => {
        clearTimeout(timer);
        resolve(sessionId);
      });
      conn.send({ type: "command", kind: "newSession", requestId });
    });
  }
}
