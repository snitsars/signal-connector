/**
 * IPC protocol between the SignalConnector service and per-project opencode
 * plugins (spine AD-5: the agent boundary). One shared Signal channel; each
 * plugin owns exactly one project.
 */
import type { AgentEvent, ModelRef, PermissionDecision } from "../domain/types.js";

export interface ProjectRef {
  name: string;
  path: string;
}

// --- plugin -> service ------------------------------------------------------

export interface RegisterMessage {
  type: "register";
  project: ProjectRef;
  pid?: number;
  version?: string;
}

export interface EventMessage {
  type: "event";
  taskId: string;
  event: AgentEvent;
  /** Working-tree patch text to attach on completion (adapter writes it). */
  diffText?: string;
}

export interface SessionCreatedMessage {
  type: "session_created";
  requestId: string;
  sessionId: string;
}

export interface ModelsMessage {
  type: "models";
  requestId: string;
  models: ModelRef[];
}

export interface PongMessage {
  type: "pong";
}

/** A plugin reporting its own trouble, so it lands in the service log. */
export interface DiagMessage {
  type: "diag";
  detail: string;
}

export type PluginToService =
  | RegisterMessage
  | EventMessage
  | SessionCreatedMessage
  | ModelsMessage
  | ModelSetMessage
  | PongMessage
  | DiagMessage;

// --- service -> plugin ------------------------------------------------------

export interface PromptCommand {
  type: "command";
  kind: "prompt";
  taskId: string;
  prompt: string;
  sessionId?: string;
}

export interface StopCommand {
  type: "command";
  kind: "stop";
  taskId: string;
}

export interface NewSessionCommand {
  type: "command";
  kind: "newSession";
  requestId: string;
}

export interface ListModelsCommand {
  type: "command";
  kind: "listModels";
  requestId: string;
}

export interface SetModelCommand {
  type: "command";
  kind: "setModel";
  requestId: string;
  sessionId: string;
  model: ModelRef;
}

export interface ModelSetMessage {
  type: "model_set";
  requestId: string;
  ok: boolean;
  detail?: string;
}

export interface PermissionReplyMessage {
  type: "permission_reply";
  permissionId: string;
  decision: PermissionDecision;
}

export interface PingMessage {
  type: "ping";
}

export type ServiceToPlugin =
  | PromptCommand
  | StopCommand
  | NewSessionCommand
  | ListModelsCommand
  | SetModelCommand
  | PermissionReplyMessage
  | PingMessage;

export interface RegisteredMessage {
  type: "registered";
  projectId: string;
  projectName: string;
}

export type ServiceToPluginAck = RegisteredMessage;

/** Everything the service can send to a plugin. */
export type BridgeOutbound = ServiceToPlugin | RegisteredMessage;

export function projectIdFor(ref: ProjectRef): string {
  return ref.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
