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
  | "choices"
  /** Something the operator should know but cannot act on (e.g. a question). */
  | "notice"  | "error"
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

/** A model an agent can run: `providerID/id`, e.g. `opencode-go/deepseek-v4.1-flash`. */
export interface ModelRef {
  providerID: string;
  id: string;
  name?: string;
}

export interface AgentEvent {
  type: AgentEventType;
  taskId: string;
  at: number;
  text?: string;
  tool?: string;
  permission?: PermissionRequest;
  /** For "files-changed": the changed paths. */
  files?: string[];
  /** For "choices": the options the operator can pick from. */
  choices?: string[];
  /** Local files to send to Signal (opencode -> operator). */
  attachPaths?: string[];
  /** For completion: a short summary of what the task did. */
  summary?: string;
  /** For completion: a path to a diff to attach. */
  diffPath?: string;
  /** "attention" means the agent is blocked until someone acts. */
  severity?: "info" | "attention";
}

export interface IncomingMessage {
  id: string;
  channelId: string;
  sender: string;
  text: string;
  at: number;
  /** True when this message belongs to the configured control channel. */
  inControlChannel: boolean;
  /**
   * How the message arrived. "sync" is the operator's own linked device (the
   * phone's Note-to-Self echo); "data" is a message that came over the network.
   * The gate treats them differently because only the sync path is the operator
   * by construction.
   */
  delivery: "data" | "sync";
  /** The sender's Signal uuid/ACI, when the envelope carries one. */
  senderUuid?: string;
  quoteId?: string;
  /** Local paths of inbound attachments, saved so the agent can open them. */
  mediaPaths?: string[];
}

export interface Reaction {
  channelId: string;
  sender: string;
  emoji: string;
  /** The message the reaction targets. */
  targetId: string;
  at: number;
}

/** An option a poll recipient picked. */
export interface PollVote {
  channelId: string;
  /** The poll message the vote belongs to. */
  targetId: string;
  /** 1-based option numbers, matching the order the options were sent in. */
  indexes: number[];
  at: number;
}

export interface OutgoingMessage {
  messageId: string;
}
