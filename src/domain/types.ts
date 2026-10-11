/**
 * Domain types. Plain data, no I/O, no framework. Core depends on these only.
 */

export interface Project {
  /** Stable, opaque identifier (config key or generated). */
  id: string;
  /** Human name used in commands, e.g. "signalconnector". */
  name: string;
  /** Absolute path to the project working directory. */
  path: string;
}

export type TaskState = "started" | "running" | "done" | "failed" | "aborted";

export interface Task {
  id: string;
  projectId: string;
  sessionId: string;
  prompt: string;
  state: TaskState;
  startedAt: number;
  updatedAt: number;
  summary?: string;
  error?: string;
}

export type AgentEventType =
  | "status"
  | "message"
  | "tool"
  | "files-changed"
  | "tests-run"
  | "permission"
  | "error"
  | "idle";

export interface PermissionRequest {
  id: string;
  taskId: string;
  tool: string;
  description: string;
  /** Safe = read-only/low-risk; auto-allowed rather than forwarded. */
  safe: boolean;
}

export type PermissionDecision = "once" | "always" | "reject";

export interface AgentEvent {
  type: AgentEventType;
  taskId: string;
  at: number;
  text?: string;
  tool?: string;
  permission?: PermissionRequest;
  /** For "files-changed": the changed paths. */
  files?: string[];
  /** For completion: a short summary of what the task did. */
  summary?: string;
  /** For completion: a path to a diff to attach. */
  diffPath?: string;
}

export interface IncomingMessage {
  id: string;
  channelId: string;
  sender: string;
  text: string;
  at: number;
  /** True when this message belongs to the configured control channel. */
  inControlChannel: boolean;
  quoteId?: string;
}

export interface Reaction {
  channelId: string;
  sender: string;
  emoji: string;
  /** The message the reaction targets. */
  targetId: string;
  at: number;
}

export interface OutgoingMessage {
  messageId: string;
}
