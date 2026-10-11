/**
 * SignalPort over a signal-cli JSON-RPC daemon (spine AD-4).
 * Talks HTTP JSON-RPC; polls `receive` for incoming messages.
 *
 * NOTE: exact JSON-RPC method/params for the installed signal-cli version must
 * be confirmed on the host (see ticket 2.2). This client is written to the
 * documented v0.14 surface and fails loudly when the daemon disagrees.
 */
import type { SignalPort } from "../../core/ports.js";
import type { IncomingMessage, OutgoingMessage, Reaction } from "../../domain/types.js";
import type { Logger } from "../../logging/logger.js";
import { RateLimiter } from "./rateLimiter.js";

interface RpcResponse<T> {
  jsonrpc: "2.0";
  id: string | number;
  result?: T;
  error?: { code: number; message: string };
}

interface Envelope {
  sourceNumber?: string;
  source?: string;
  timestamp?: number;
  dataMessage?: {
    message?: string;
    groupInfo?: { groupId?: string };
    quote?: { id?: number };
    reaction?: { emoji?: string; targetSentTimestamp?: number };
    attachments?: { filename?: string }[];
  };
}

export interface SignalCliOptions {
  endpoint: string;
  account: string;
  /** Restrict to this channel id (own number for note-to-self, or a group id). */
  channelId: string;
  pollIntervalMs?: number;
  minIntervalMs?: number;
  maxPerMinute?: number;
  logger: Logger;
}

export class SignalCliClient implements SignalPort {
  private readonly opts: Required<Omit<SignalCliOptions, "logger">> & { logger: Logger };
  private readonly limiter: RateLimiter;
  private messageHandlers: ((m: IncomingMessage) => void)[] = [];
  private reactionHandlers: ((r: Reaction) => void)[] = [];
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private rpcId = 0;

  constructor(options: SignalCliOptions) {
    this.opts = {
      pollIntervalMs: 2000,
      minIntervalMs: 1500,
      maxPerMinute: 20,
      ...options,
    } as Required<Omit<SignalCliOptions, "logger">> & { logger: Logger };
    this.limiter = new RateLimiter({
      minIntervalMs: this.opts.minIntervalMs,
      maxPerMinute: this.opts.maxPerMinute,
    });
  }

  private async rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = ++this.rpcId;
    const response = await fetch(this.opts.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const body = (await response.json()) as RpcResponse<T>;
    if (body.error) {
      throw new Error(`signal-cli ${method} failed: ${body.error.message}`);
    }
    return body.result as T;
  }

  async start(): Promise<void> {
    this.running = true;
    const tick = async (): Promise<void> => {
      if (!this.running) return;
      try {
        const envelopes = await this.rpc<Envelope[]>("receive", {
          account: this.opts.account,
          timeout: 1,
        });
        for (const env of envelopes ?? []) this.dispatch(env);
      } catch (err) {
        this.opts.logger.warn("signal receive failed", { error: String(err) });
      } finally {
        if (this.running) {
          this.timer = setTimeout(() => void tick(), this.opts.pollIntervalMs);
        }
      }
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  private dispatch(env: Envelope): void {
    const data = env.dataMessage;
    if (!data) return;
    const channelId = data.groupInfo?.groupId ?? env.sourceNumber ?? env.source ?? "";
    const sender = env.sourceNumber ?? env.source ?? "";
    const at = env.timestamp ?? Date.now();

    if (data.reaction) {
      const reaction: Reaction = {
        channelId,
        sender,
        emoji: data.reaction.emoji ?? "",
        targetId: String(data.reaction.targetSentTimestamp ?? ""),
        at,
      };
      for (const h of this.reactionHandlers) h(reaction);
      return;
    }

    const message: IncomingMessage = {
      id: String(at),
      channelId,
      sender,
      text: data.message ?? "",
      at,
      inControlChannel: this.isControlChannel(channelId),
    };
    if (data.quote?.id != null) message.quoteId = String(data.quote.id);
    for (const h of this.messageHandlers) h(message);
  }

  private isControlChannel(channelId: string): boolean {
    if (this.opts.channelId === "self") return true;
    return channelId === this.opts.channelId;
  }

  async send(channelId: string, text: string): Promise<OutgoingMessage> {
    await this.limiter.acquire();
    const result = await this.rpc<{ timestamp?: number }>("send", {
      account: this.opts.account,
      recipient: this.recipientFor(channelId),
      message: text,
    });
    return { messageId: String(result.timestamp ?? Date.now()) };
  }

  async edit(channelId: string, messageId: string, text: string): Promise<void> {
    await this.limiter.acquire();
    await this.rpc("send", {
      account: this.opts.account,
      recipient: this.recipientFor(channelId),
      message: text,
      editTimestamp: Number(messageId),
    });
  }

  async attach(channelId: string, filePath: string, caption?: string): Promise<OutgoingMessage> {
    await this.limiter.acquire();
    const result = await this.rpc<{ timestamp?: number }>("send", {
      account: this.opts.account,
      recipient: this.recipientFor(channelId),
      message: caption ?? "",
      attachment: [filePath],
    });
    return { messageId: String(result.timestamp ?? Date.now()) };
  }

  private recipientFor(channelId: string): string {
    if (channelId === "self" || channelId === this.opts.account) return this.opts.account;
    return channelId;
  }

  onMessage(handler: (m: IncomingMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onReaction(handler: (r: Reaction) => void): void {
    this.reactionHandlers.push(handler);
  }
}
