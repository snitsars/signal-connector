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

/**
 * Lifecycle of one meeting. The face in the room and the message in the group
 * both follow this sequence: blue joining, green in the room, red on a problem.
 */
export type MeetingState = "joining" | "in-room" | "left" | "failed";

export interface MeetingStateEvent {
  state: MeetingState;
  /** Why the state changed, in words fit for the operator. Never the link. */
  detail?: string;
  /**
   * False when the room was inferred from a weak signal (the face publishing,
   * or the page's own DOM changing) rather than positively detected.
   */
  verified?: boolean;
}

export interface JoinMeetingInput {
  projectId: string;
  projectName: string;
  /** The room link. It must never reach a log line, a refusal or a group message. */
  link: string;
  onState: (event: MeetingStateEvent) => void;
}

export interface MeetingLeaveResult {
  /** False when the browser survived the kill attempt and may still be in the room. */
  closed: boolean;
  detail?: string;
}

/** What a join returns: one handle that can take the avatar out of the room. */
export interface MeetingHandle {
  leave(): Promise<MeetingLeaveResult>;
}

export type MeetingAvailability =
  | { available: true }
  | { available: false; reason: string };

/**
 * Joins a meeting room as a drawn avatar. The core passes ids and names only;
 * no browser, audio or provider type crosses this boundary (spine AD-1).
 */
export interface MeetingPort {
  /** Can this machine join at all (a Chromium-based browser exists)? */
  available(): Promise<MeetingAvailability>;
  join(input: JoinMeetingInput): Promise<MeetingHandle>;
  /** Shutdown: leave any room this adapter still holds, without reporting. */
  stop(): Promise<void>;
}

export type VoiceAvailability = { available: true } | { available: false; reason: string };

/** One thing the room said, already gated by energy and transcribed locally. */
export interface Utterance {
  /** What was heard, as text. A prompt like any other — never a command. */
  text: string;
  /** How long the audio lasted, in milliseconds. */
  durationMs: number;
}

export interface StartListeningInput {
  projectId: string;
  projectName: string;
  /** A transcript that passed the energy gate; core offers it to the session. */
  onUtterance: (utterance: Utterance) => void;
  /** The room audio's current RMS, 0..1. */
  onLevel?: (level: number) => void;
  /** A failure the operator must hear: no transcriber, a failed run. */
  onFailure?: (reason: string) => void;
}

/** One handle that can stop listening for the meeting and speak into it. */
export interface VoiceHandle {
  /** Stop hearing the room; called on every terminal path. */
  stop(): Promise<void>;
  /**
   * Say this text into the room, through the same synthetic microphone. A long
   * text is capped by the adapter; the full text belongs in the group. Speech
   * queued behind an earlier clip waits its turn, and is dropped if the operator
   * speaks first.
   */
  speak(text: string): Promise<void>;
  /** Stop speaking at once and drop every clip still queued. */
  stopSpeaking(): Promise<void>;
}

/**
 * Hears a room and turns speech into text for a project's session. Core passes
 * ids and names only: no PCM, browser or model type crosses this boundary
 * (spine AD-1), so a transcript can only ever become a prompt.
 */
export interface VoicePort {
  /** Can this machine listen at all (a transcriber is configured)? */
  available(): Promise<VoiceAvailability>;
  /** Begin hearing the room. Resolves once the pump is running. */
  start(input: StartListeningInput): Promise<VoiceHandle>;
  /** Shutdown: stop listening without reporting. */
  stop(): Promise<void>;
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
