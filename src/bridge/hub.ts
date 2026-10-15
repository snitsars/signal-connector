/**
 * Transport-agnostic registry + router for plugin connections (spine AD-5).
 * The ws server in server.ts feeds decoded messages here; the AgentPort
 * adapter in ../adapters/agent/pluginBridge.ts drives commands out.
 */
import type { AgentEvent, ModelRef } from "../domain/types.js";
import {
  projectIdFor,
  type BridgeOutbound,
  type DiagMessage,
  type EventMessage,
  type ModelsMessage,
  type ModelSetMessage,
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
  private readonly modelWaiters = new Map<string, (models: ModelRef[]) => void>();
  private readonly modelSetWaiters = new Map<string, (reply: ModelSetMessage) => void>();
  private readonly connectHandlers: ((c: PluginConnection) => void)[] = [];
  private readonly disconnectHandlers: ((c: PluginConnection) => void)[] = [];
  private readonly diagHandlers: ((projectId: string, detail: string) => void)[] = [];

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
    for (const handler of this.connectHandlers) handler(conn);
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
      case "diag": {
        for (const handler of this.diagHandlers) handler(conn.projectId, (msg as DiagMessage).detail);
        return;
      }
      case "models": {
        const { requestId, models } = msg as ModelsMessage;
        const waiter = this.modelWaiters.get(requestId);
        if (waiter) {
          this.modelWaiters.delete(requestId);
          waiter(models);
        }
        return;
      }
      case "model_set": {
        const reply = msg as ModelSetMessage;
        const waiter = this.modelSetWaiters.get(reply.requestId);
        if (waiter) {
          this.modelSetWaiters.delete(reply.requestId);
          waiter(reply);
        }
        return;
      }
      default:
        return;
    }
  }

  unregister(conn: PluginConnection): void {
    if (this.connections.get(conn.projectId) === conn) {
      this.connections.delete(conn.projectId);
      for (const handler of this.disconnectHandlers) handler(conn);
    }
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

  onConnect(handler: (c: PluginConnection) => void): void {
    this.connectHandlers.push(handler);
  }

  onDisconnect(handler: (c: PluginConnection) => void): void {
    this.disconnectHandlers.push(handler);
  }

  /** Plugin-side diagnostics, e.g. a broken API call the plugin would otherwise swallow. */
  onDiag(handler: (projectId: string, detail: string) => void): void {
    this.diagHandlers.push(handler);
  }

  requestModels(projectId: string, requestId: string, timeoutMs = 10_000): Promise<ModelRef[]> {
    const conn = this.connections.get(projectId);
    if (!conn) return Promise.reject(new Error(`no plugin connected for project ${projectId}`));
    return new Promise<ModelRef[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.modelWaiters.delete(requestId);
        reject(new Error("model list timed out"));
      }, timeoutMs);
      this.modelWaiters.set(requestId, (models) => {
        clearTimeout(timer);
        resolve(models);
      });
      conn.send({ type: "command", kind: "listModels", requestId });
    });
  }

  /** Send a model switch and wait for the plugin to confirm it took effect. */
  async requestSetModel(
    projectId: string,
    requestId: string,
    sessionId: string,
    model: ModelRef,
    timeoutMs = 10_000,
  ): Promise<ModelSetMessage> {
    const conn = this.connections.get(projectId);
    if (!conn) throw new Error(`no plugin connected for project ${projectId}`);
    return await new Promise<ModelSetMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.modelSetWaiters.delete(requestId);
        reject(new Error("model switch timed out"));
      }, timeoutMs);
      this.modelSetWaiters.set(requestId, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      conn.send({ type: "command", kind: "setModel", requestId, sessionId, model });
    });
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
