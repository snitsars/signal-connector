/**
 * Core ports. The core talks to the outside world only through these interfaces.
 * Implementations live in src/adapters/**; core must not import them.
 */
import type {
  AgentEvent,
  IncomingMessage,
  OutgoingMessage,
  PermissionDecision,
  Project,
  Reaction,
} from "../domain/types.js";

export interface SignalPort {
  /** Begin receiving. Resolves once the transport is ready. */
  start(): Promise<void>;
  stop(): Promise<void>;
  send(channelId: string, text: string): Promise<OutgoingMessage>;
  edit(channelId: string, messageId: string, text: string): Promise<void>;
  attach(channelId: string, filePath: string, caption?: string): Promise<OutgoingMessage>;
  onMessage(handler: (message: IncomingMessage) => void): void;
  onReaction(handler: (reaction: Reaction) => void): void;
}

export interface StartTaskInput {
  taskId: string;
  project: Project;
  prompt: string;
  /** Continue this session when provided; otherwise the adapter chooses. */
  sessionId?: string;
}

export interface AgentPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<boolean>;
  /** Start a task and return the session it runs in. */
  startTask(input: StartTaskInput): Promise<{ sessionId: string }>;
  /** Fork a fresh session for the project, returning its id. */
  newSession(project: Project): Promise<{ sessionId: string }>;
  subscribe(handler: (event: AgentEvent) => void): void;
  answerPermission(permissionId: string, decision: PermissionDecision): Promise<void>;
  abort(taskId: string): Promise<void>;
}
