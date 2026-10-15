/**
 * Core ports. The core talks to the outside world only through these interfaces.
 * Implementations live in src/adapters/**; core must not import them.
 */
import type { StyleRange } from "./format.js";
import type {
  AgentEvent,
  IncomingMessage,
  ModelRef,
  OutgoingMessage,
  PermissionDecision,
  PollVote,
  Project,
  Reaction,
} from "../domain/types.js";

/** A message another one replies to (Signal's quote), used to thread by project. */
export interface QuoteRef {
  /** The quoted message's id (its Signal timestamp). */
  id: string;
  author?: string;
  text?: string;
}

export interface SendOptions {
  /** Send as a reply to this message. */
  quote?: QuoteRef;
  /** Styled ranges of the (already rendered) text. */
  styles?: StyleRange[];
}

export interface SignalPort {
  /** Begin receiving. Resolves once the transport is ready. */
  start(): Promise<void>;
  stop(): Promise<void>;
  send(channelId: string, text: string, options?: SendOptions): Promise<OutgoingMessage>;
  edit(
    channelId: string,
    messageId: string,
    text: string,
    options?: SendOptions,
  ): Promise<void>;
  attach(
    channelId: string,
    filePath: string,
    caption?: string,
    quote?: QuoteRef,
  ): Promise<OutgoingMessage>;
  /**
   * Send a Signal poll (2-10 options). Rejects when the transport cannot send
   * polls, so the core can fall back to a numbered text menu.
   */
  sendPoll(
    channelId: string,
    question: string,
    options: string[],
    allowMultiple?: boolean,
    quote?: QuoteRef,
  ): Promise<OutgoingMessage>;
  /**
   * Create a Signal group containing just the operator, for use as a project's
   * own conversation. Returns the new group's id.
   */
  createGroup(name: string): Promise<{ groupId: string }>;
  onMessage(handler: (message: IncomingMessage) => void): void;
  onReaction(handler: (reaction: Reaction) => void): void;
  onPollVote(handler: (vote: PollVote) => void): void;
}

export interface StartTaskInput {
  taskId: string;
  project: Project;
  prompt: string;
  /** Continue this session when provided; otherwise the adapter chooses. */
  sessionId?: string;
}

export interface LaunchResult {
  started: boolean;
  /** Human-readable outcome, shown to the operator when something went wrong. */
  detail?: string;
  /**
   * Session the launched/ focused window is showing, when the launcher can see
   * it. Pinning it makes the connector drive the session the operator watches.
   */
  sessionId?: string;
}

/**
 * Starts a project's agent so it can connect to the bridge. A launcher may open
 * a visible window (e.g. a Herdr workspace) — that is the whole point of it.
 */
export interface LauncherPort {
  launch(project: Project): Promise<LaunchResult>;
}

export interface AgentPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<boolean>;
  /** Start a task and return the session it runs in. */
  startTask(input: StartTaskInput): Promise<{ sessionId: string }>;
  /** Fork a fresh session for the project, returning its id. */
  newSession(project: Project): Promise<{ sessionId: string }>;
  /** Models this agent can run for the project (plugin mode asks opencode). */
  listModels(project: Project): Promise<ModelRef[]>;
  /** Switch the session's model; later tasks run on the new one. */
  setModel(input: { project: Project; sessionId: string; model: ModelRef }): Promise<void>;
  subscribe(handler: (event: AgentEvent) => void): void;
  answerPermission(permissionId: string, decision: PermissionDecision): Promise<void>;
  abort(taskId: string): Promise<void>;
  /** False when this project has no agent attached, so it may need launching. */
  isConnected(projectId: string): boolean;
}
