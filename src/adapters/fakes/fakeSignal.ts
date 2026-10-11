/**
 * In-memory SignalPort fake for core tests. Records everything it sends.
 */
import type { SignalPort } from "../../core/ports.js";
import type { IncomingMessage, OutgoingMessage, Reaction } from "../../domain/types.js";

export interface SentMessage {
  channelId: string;
  messageId: string;
  text: string;
  edited?: boolean;
}

export type SignalOp =
  | { op: "send"; messageId: string; text: string }
  | { op: "edit"; messageId: string; text: string }
  | { op: "attach"; filePath: string; caption?: string };

export class FakeSignal implements SignalPort {
  readonly sent: SentMessage[] = [];
  readonly attachments: { channelId: string; filePath: string; caption?: string }[] = [];
  readonly ops: SignalOp[] = [];
  private messageHandlers: ((m: IncomingMessage) => void)[] = [];
  private reactionHandlers: ((r: Reaction) => void)[] = [];
  private seq = 0;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async send(channelId: string, text: string): Promise<OutgoingMessage> {
    const messageId = `msg-${++this.seq}`;
    this.sent.push({ channelId, messageId, text });
    this.ops.push({ op: "send", messageId, text });
    return { messageId };
  }

  async edit(channelId: string, messageId: string, text: string): Promise<void> {
    const existing = this.sent.find((m) => m.messageId === messageId);
    if (existing) {
      existing.text = text;
      existing.edited = true;
    } else {
      this.sent.push({ channelId, messageId, text, edited: true });
    }
    this.ops.push({ op: "edit", messageId, text });
  }

  async attach(channelId: string, filePath: string, caption?: string): Promise<OutgoingMessage> {
    const messageId = `att-${++this.seq}`;
    this.attachments.push({ channelId, filePath, caption });
    this.ops.push({ op: "attach", filePath, ...(caption ? { caption } : {}) });
    return { messageId };
  }

  onMessage(handler: (m: IncomingMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onReaction(handler: (r: Reaction) => void): void {
    this.reactionHandlers.push(handler);
  }

  /** Test helper: deliver an incoming message. */
  emitMessage(message: IncomingMessage): void {
    for (const h of this.messageHandlers) h(message);
  }

  /** Test helper: deliver a reaction. */
  emitReaction(reaction: Reaction): void {
    for (const h of this.reactionHandlers) h(reaction);
  }
}
