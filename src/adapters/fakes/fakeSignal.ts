/**
 * In-memory SignalPort fake for core tests. Records everything it sends.
 */
import type { QuoteRef, SendOptions, SignalPort } from "../../core/ports.js"
import type {
  IncomingMessage,
  OutgoingMessage,
  PollVote,
  Reaction,
} from "../../domain/types.js";

export interface SentMessage {
  channelId: string;
  messageId: string;
  text: string;
  edited?: boolean;
  /** Set when the message was sent as a reply (threading). */
  quote?: QuoteRef;
}

export type SignalOp =
  | { op: "send"; messageId: string; text: string }
  | { op: "edit"; messageId: string; text: string }
  | { op: "attach"; filePath: string; caption?: string }
  | { op: "poll"; messageId: string; question: string; options: string[] };

export class FakeSignal implements SignalPort {
  readonly sent: SentMessage[] = [];
  readonly attachments: { channelId: string; filePath: string; caption?: string }[] = [];
  readonly polls: { channelId: string; messageId: string; question: string; options: string[] }[] = [];
  readonly ops: SignalOp[] = [];
  /** Set to make sendPoll reject, as a transport without poll support would. */
  failPolls = false;
  /** Set to make the next send reject once, as a transport hiccup would. */
  failNextSend = false;
  private messageHandlers: ((m: IncomingMessage) => void)[] = [];
  private reactionHandlers: ((r: Reaction) => void)[] = [];
  private pollVoteHandlers: ((v: PollVote) => void)[] = [];
  private seq = 0;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async send(channelId: string, text: string, options?: SendOptions): Promise<OutgoingMessage> {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error("the transport is unavailable");
    }
    const messageId = `msg-${++this.seq}`;
    this.sent.push({ channelId, messageId, text, ...(options?.quote ? { quote: options.quote } : {}) });
    this.ops.push({ op: "send", messageId, text });
    return { messageId };
  }

  async edit(channelId: string, messageId: string, text: string, options?: SendOptions): Promise<void> {
    const existing = this.sent.find((m) => m.messageId === messageId);
    if (existing) {
      existing.text = text;
      existing.edited = true;
    } else {
      this.sent.push({ channelId, messageId, text, edited: true });
    }
    this.ops.push({ op: "edit", messageId, text });
  }

  async attach(
    channelId: string,
    filePath: string,
    caption?: string,
    quote?: QuoteRef,
  ): Promise<OutgoingMessage> {
    const messageId = `att-${++this.seq}`;
    this.attachments.push({ channelId, filePath, caption });
    this.ops.push({ op: "attach", filePath, ...(caption ? { caption } : {}) });
    return { messageId };
  }

  /** Test helper: groups this fake created. */
  readonly createdGroups: string[] = [];

  async createGroup(name: string): Promise<{ groupId: string }> {
    this.createdGroups.push(name);
    return { groupId: `group-${this.createdGroups.length}-${name.toLowerCase().replace(/\W+/g, "-")}` };
  }

  async sendPoll(
    channelId: string,
    question: string,
    options: string[],
    _allowMultiple = false,
    _quote?: QuoteRef,
  ): Promise<OutgoingMessage> {
    if (this.failPolls) throw new Error("polls are not supported here");
    const messageId = `poll-${++this.seq}`;
    this.polls.push({ channelId, messageId, question, options });
    this.ops.push({ op: "poll", messageId, question, options });
    return { messageId };
  }

  onMessage(handler: (m: IncomingMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onReaction(handler: (r: Reaction) => void): void {
    this.reactionHandlers.push(handler);
  }

  onPollVote(handler: (v: PollVote) => void): void {
    this.pollVoteHandlers.push(handler);
  }

  /** Test helper: deliver an incoming message. */
  emitMessage(message: IncomingMessage): void {
    for (const h of this.messageHandlers) h(message);
  }

  /** Test helper: deliver a reaction. */
  emitReaction(reaction: Reaction): void {
    for (const h of this.reactionHandlers) h(reaction);
  }

  /** Test helper: deliver a poll vote. */
  emitPollVote(vote: PollVote): void {
    for (const h of this.pollVoteHandlers) h(vote);
  }
}
