/**
 * SignalPort over a signal-cli JSON-RPC daemon (spine AD-4).
 * Talks HTTP JSON-RPC; polls `receive` for incoming messages.
 *
 * NOTE: exact JSON-RPC method/params for the installed signal-cli version must
 * be confirmed on the host (see ticket 2.2). This client is written to the
 * documented v0.14 surface and fails loudly when the daemon disagrees.
 */
import { styleParam, type StyleRange } from "../../core/format.js";
import type { QuoteRef, SendOptions, SignalPort } from "../../core/ports.js"
import type { IncomingMessage, OutgoingMessage, PollVote, Reaction } from "../../domain/types.js";
import type { Logger } from "../../logging/logger.js";
import { splitStyled } from "../../core/format.js";
import { RateLimiter } from "./rateLimiter.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface RpcResponse<T> {
  jsonrpc: "2.0";
  id: string | number;
  result?: T;
  error?: { code: number; message: string };
}

interface SentMessage {
  destination?: string;
  destinationNumber?: string;
  /** Set when the synced message was sent to a group rather than a person. */
  groupInfo?: { groupId?: string };
  message?: string;
  timestamp?: number;
  reaction?: { emoji?: string; targetSentTimestamp?: number };
  pollVote?: { targetSentTimestamp?: number; optionIndexes?: number[] };
  attachments?: AttachmentRef[];
  /** Set when the message edits an earlier one: an edit is not a new command. */
  editTimestamp?: number;
  /** Set when the message deletes an earlier one. */
  remoteDelete?: { timestamp?: number } | number;
}

interface AttachmentRef {
  id?: string;
  contentType?: string;
  filename?: string;
  size?: number;
  caption?: string;
}

interface Envelope {
  envelope?: Envelope;
  sourceNumber?: string;
  source?: string;
  timestamp?: number;
  dataMessage?: {
    message?: string;
    groupInfo?: { groupId?: string };
    quote?: { id?: number };
    reaction?: { emoji?: string; targetSentTimestamp?: number };
    attachments?: AttachmentRef[];
    /** A poll the operator answered in the Signal app. */
    pollVote?: { targetSentTimestamp?: number; optionIndexes?: number[] };
    /** Edits and deletions arrive as ordinary data messages carrying these. */
    editTimestamp?: number;
    remoteDelete?: { timestamp?: number } | number;
  };
  /** Note-to-Self messages from the linked phone arrive here. */
  syncMessage?: {
    sentMessage?: SentMessage;
  };
}

/** Attachments larger than this are reported but not fetched. */
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "application/pdf": ".pdf",
};

/** A safe, collision-free file name for a downloaded attachment. */
export function mediaFileName(
  attachment: { filename?: string; contentType?: string },
  at: number,
): string {
  const raw = (attachment.filename ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(-80);
  const fallbackExt = EXTENSION_BY_TYPE[attachment.contentType ?? ""] ?? "";
  const ext = cleaned.includes(".") ? "" : fallbackExt;
  return cleaned ? `${at}-${cleaned}${ext}` : `${at}-attachment${fallbackExt}`;
}

/**
 * Pull the base64 payload out of a `getAttachment` result. signal-cli documents
 * the result as base64; the exact JSON wrapping is version-dependent, so accept
 * the plain string and the object shapes seen in the wild.
 */
export function attachmentData(result: unknown): string | undefined {
  if (typeof result === "string") {
    return result.replace(/^data:[^;]+;base64,/, "") || undefined;
  }
  if (typeof result === "object" && result !== null) {
    for (const key of ["data", "base64", "attachment", "value"]) {
      const value = (result as Record<string, unknown>)[key];
      if (typeof value === "string" && value.length > 0) {
        return value.replace(/^data:[^;]+;base64,/, "");
      }
    }
  }
  return undefined;
}

/**
 * The attachments in an envelope plus who sent them, for either delivery path.
 * Note-to-Self messages from the linked phone arrive as
 * `syncMessage.sentMessage`, not `dataMessage` — which is easy to miss, and did
 * mean images from the phone were dropped on the floor.
 */
export function inboundMedia(
  env: Envelope,
): { attachments: AttachmentRef[]; sender: string } | undefined {
  const sender = env.sourceNumber ?? env.source ?? "";
  const data = env.dataMessage;
  if (data?.attachments && data.attachments.length > 0) {
    return { attachments: data.attachments, sender };
  }
  const sent = env.syncMessage?.sentMessage;
  if (sent?.attachments && sent.attachments.length > 0) {
    return { attachments: sent.attachments, sender };
  }
  return undefined;
}

/**
 * A message whose text is a `/meet` command carries the room link as its
 * argument, so it must never be written to the log file verbatim.
 */
function isMeetCommand(text: string | undefined): boolean {
  return typeof text === "string" && /^\/meet\b/i.test(text.trim());
}

/** Replace the command's argument while leaving the rest of the text intact. */
const REDACTED_MEET = "/meet [redacted]";

/**
 * The envelope as it may be logged: a `/meet` command's text is replaced in
 * both the ordinary and the note-to-self delivery paths. Every other field —
 * source, timestamp, group, reactions, attachments — is untouched.
 */
export function redactEnvelope(envelope: Envelope): Envelope {
  const redactData = isMeetCommand(envelope.dataMessage?.message);
  const redactSent = isMeetCommand(envelope.syncMessage?.sentMessage?.message);
  if (!redactData && !redactSent) return envelope;

  const copy: Envelope = { ...envelope };
  if (redactData && envelope.dataMessage) {
    copy.dataMessage = { ...envelope.dataMessage, message: REDACTED_MEET };
  }
  if (redactSent && envelope.syncMessage?.sentMessage) {
    copy.syncMessage = {
      ...envelope.syncMessage,
      sentMessage: { ...envelope.syncMessage.sentMessage, message: REDACTED_MEET },
    };
  }
  return copy;
}

/**
 * Map a raw poll vote to the domain vote. Signal reports 0-based option indexes;
 * the domain keeps them 1-based so the core can match the order it sent.
 */
export function pollVoteFrom(
  vote: { targetSentTimestamp?: number; optionIndexes?: number[] } | undefined,
  channelId: string,
  at: number,
): PollVote | undefined {
  const target = vote?.targetSentTimestamp;
  if (target == null) return undefined;
  const indexes = (vote?.optionIndexes ?? []).map((index) => index + 1).filter((index) => index > 0);
  return { channelId, targetId: String(target), indexes, at };
}

export interface SignalCliOptions {
  endpoint: string;
  account: string;
  /** Restrict to this channel id (own number for note-to-self, or a group id). */
  channelId: string;
  /** "group" makes the client address the channel by group id instead of recipient. */
  channelKind?: "note-to-self" | "group";
  /** Where inbound attachments are written. Defaults to the OS temp dir. */
  mediaDir?: string;
  pollIntervalMs?: number;
  /** Hard limit for one `receive` call, ms. A wedged daemon answers `version` forever but never this. */
  receiveTimeoutMs?: number;
  /** Where the sent-message timestamps live, so a restart keeps ignoring echoes. Defaults to the media dir. */
  sentLogFile?: string;
  /** Consecutive receive failures after which the daemon is reported unhealthy. */
  unhealthyAfter?: number;
  minIntervalMs?: number;
  maxPerMinute?: number;
  logger: Logger;
}

/** Signal group ids are base64 and end with '='; phone numbers do not. */
export function isGroupId(value: string): boolean {
  return /^[A-Za-z0-9+/]+=*$/.test(value) && value.includes("=");
}

/**
 * How signal-cli should address a channel: `groupId` for groups, `recipient`
 * for a person (or ourselves, for Note-to-Self — a group id would be sent as a
 * recipient otherwise, which the daemon rejects).
 */
export function targetParams(
  channelId: string,
  account: string,
  kind?: "note-to-self" | "group",
): Record<string, string> {
  if (channelId === "self" || channelId === account) return { recipient: account };
  if (kind === "group" || isGroupId(channelId)) return { groupId: channelId };
  return { recipient: channelId };
}

/** Quote parameters that make a message render as a reply to another one. */
export function quoteParams(
  quote: { id: string; author?: string; text?: string } | undefined,
  account: string,
): Record<string, unknown> {
  if (!quote) return {};
  const timestamp = Number(quote.id);
  if (!Number.isFinite(timestamp)) return {};
  return {
    quoteTimestamp: timestamp,
    quoteAuthor: quote.author ?? account,
    ...(quote.text ? { quoteMessage: quote.text.slice(0, 200) } : {}),
  };
}

export class SignalCliClient implements SignalPort {
  private readonly opts: Required<Omit<SignalCliOptions, "logger">> & { logger: Logger };
  private readonly limiter: RateLimiter;
  private messageHandlers: ((m: IncomingMessage) => void)[] = [];
  private reactionHandlers: ((r: Reaction) => void)[] = [];
  private pollVoteHandlers: ((v: PollVote) => void)[] = [];
  private unhealthyHandlers: ((reason: string) => void)[] = [];
  private receiveFailures = 0;
  private reportedUnhealthy = false;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private rpcId = 0;
  /** Timestamps of messages we sent, to ignore their Note-to-Self sync echo. */
  private readonly sentTimestamps = new Set<string>();
  private sentOrder: string[] = [];
  private readonly sentLogFile: string;

  constructor(options: SignalCliOptions) {
    this.opts = {
      mediaDir: path.join(os.tmpdir(), "signal-connector-media"),
      pollIntervalMs: 2000,
      receiveTimeoutMs: 15_000,
      unhealthyAfter: 2,
      sentLogFile: "",
      minIntervalMs: 1500,
      maxPerMinute: 20,
      ...options,
    } as Required<Omit<SignalCliOptions, "logger">> & { logger: Logger };
    this.sentLogFile =
      this.opts.sentLogFile !== ""
        ? this.opts.sentLogFile
        : path.join(this.opts.mediaDir, "sent-timestamps.json");
    this.loadSentLog();
    this.limiter = new RateLimiter({
      minIntervalMs: this.opts.minIntervalMs,
      maxPerMinute: this.opts.maxPerMinute,
    });
  }

  private async rpc<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 60_000,
  ): Promise<T> {
    const id = ++this.rpcId;
    const response = await fetch(this.opts.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      // Without this, a wedged daemon holds the call for undici's five-minute
      // timeout, which hides the failure and delays recovery.
      signal: AbortSignal.timeout(timeoutMs),
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
        const envelopes = await this.rpc<Envelope[]>(
          "receive",
          { timeout: 1 },
          this.opts.receiveTimeoutMs,
        );
        this.receiveFailures = 0;
        this.reportedUnhealthy = false;
        for (const env of envelopes ?? []) await this.dispatch(env);
      } catch (err) {
        this.receiveFailures += 1;
        this.opts.logger.warn("signal receive failed", {
          error: String(err),
          failures: this.receiveFailures,
        });
        if (this.receiveFailures >= this.opts.unhealthyAfter && !this.reportedUnhealthy) {
          this.reportedUnhealthy = true;
          for (const h of this.unhealthyHandlers) h(String(err));
        }
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

  /**
   * Fetch inbound attachments from the daemon (base64) and write them to the
   * media dir, so the agent can open them by path. Failures are logged and the
   * text still goes through — a lost image never blocks a message.
   */
  private async saveAttachments(
    attachments: AttachmentRef[] | undefined,
    recipient: string,
    at: number,
  ): Promise<string[]> {
    const saved: string[] = [];
    for (const attachment of attachments ?? []) {
      if (!attachment.id) continue;
      if (attachment.size != null && attachment.size > MAX_MEDIA_BYTES) {
        this.opts.logger.warn("attachment too large, skipped", {
          size: attachment.size,
          limit: MAX_MEDIA_BYTES,
        });
        continue;
      }
      try {
        const result = await this.rpc<unknown>("getAttachment", {
          id: attachment.id,
          recipient,
        });
        const data = attachmentData(result);
        if (!data) {
          this.opts.logger.warn("unexpected getAttachment result", {
            shape: typeof result === "object" && result !== null ? Object.keys(result).join(",") : typeof result,
          });
          continue;
        }
        const file = path.join(this.opts.mediaDir, mediaFileName(attachment, at));
        fs.mkdirSync(this.opts.mediaDir, { recursive: true });
        fs.writeFileSync(file, Buffer.from(data, "base64"));
        saved.push(file);
      } catch (err) {
        this.opts.logger.warn("could not fetch attachment", { error: String(err) });
      }
    }
    return saved;
  }

  private async dispatch(raw: Envelope): Promise<void> {
    const env = raw.envelope ?? raw;
    this.opts.logger.debug("signal envelope", { envelope: redactEnvelope(env) });

    const data = env.dataMessage;
    if (data) {
      const channelId = data.groupInfo?.groupId ?? env.sourceNumber ?? env.source ?? "";
      const sender = env.sourceNumber ?? env.source ?? "";
      const at = env.timestamp ?? Date.now();
      if (data.pollVote) {
        const vote = pollVoteFrom(data.pollVote, channelId, at);
        if (vote) this.emitPollVote(vote);
        return;
      }
      if (data.reaction) {
        this.emitReaction({
          channelId,
          sender,
          emoji: data.reaction.emoji ?? "",
          targetId: String(data.reaction.targetSentTimestamp ?? ""),
          at,
        });
        return;
      }
      // An edit or a deletion is not a new instruction, whoever made it.
      if (data.editTimestamp !== undefined || data.remoteDelete !== undefined) return;
      const mediaPaths = await this.saveAttachments(data.attachments, sender, at);      const message: IncomingMessage = {
        id: String(at),
        channelId,
        sender,
        text: data.message ?? "",
        at,
        inControlChannel: this.isControlChannel(channelId),
      };
      if (data.quote?.id != null) message.quoteId = String(data.quote.id);
      if (mediaPaths.length > 0) message.mediaPaths = mediaPaths;
      if (!message.text && mediaPaths.length === 0) return;
      for (const h of this.messageHandlers) h(message);
      return;
    }

    // Messages the operator sends from the linked phone arrive as a sync message:
    // Note-to-Self addressed to us, or a group send addressed to the group.
    const sent = env.syncMessage?.sentMessage;
    if (sent) {
      const groupId = sent.groupInfo?.groupId;
      const destination = sent.destinationNumber ?? sent.destination ?? "";
      if (!groupId && destination !== this.opts.account) return;
      // Ignore the sync echo of our own outgoing messages (prevents a loop).
      if (this.sentTimestamps.has(String(sent.timestamp ?? env.timestamp ?? ""))) return;
      const at = sent.timestamp ?? env.timestamp ?? Date.now();
      const channelId = groupId ?? this.opts.account;
      if (sent.pollVote) {
        const vote = pollVoteFrom(sent.pollVote, channelId, at);
        if (vote) this.emitPollVote(vote);
        return;
      }
      if (sent.reaction) {
        this.emitReaction({
          channelId,
          sender: channelId,
          emoji: sent.reaction.emoji ?? "",
          targetId: String(sent.reaction.targetSentTimestamp ?? ""),
          at,
        });
        return;
      }
      // An edit of an earlier message (ours or the operator's) is not a command;
      // treating it as one made the connector answer its own edits.
      if (sent.editTimestamp !== undefined || sent.remoteDelete !== undefined) return;
      const media = inboundMedia(env);
      const mediaPaths = media ? await this.saveAttachments(media.attachments, media.sender, at) : [];
      const message: IncomingMessage = {
        id: String(at),
        channelId,
        sender: channelId,
        text: sent.message ?? "",
        at,
        inControlChannel: this.isControlChannel(channelId),
      };
      if (mediaPaths.length > 0) message.mediaPaths = mediaPaths;
      if (!message.text && mediaPaths.length === 0) return;
      for (const h of this.messageHandlers) h(message);
    }
  }

  private emitReaction(reaction: Reaction): void {
    for (const h of this.reactionHandlers) h(reaction);
  }

  private emitPollVote(vote: PollVote): void {
    for (const h of this.pollVoteHandlers) h(vote);
  }

  private isControlChannel(channelId: string): boolean {
    if (this.opts.channelId === "self") return channelId === this.opts.account;
    return channelId === this.opts.channelId;
  }

  async send(channelId: string, text: string, options?: SendOptions): Promise<OutgoingMessage> {
    // Long answers are cut into numbered parts: sent whole, signal-cli turns
    // them into a "long text attachment" that the server rejects, and the
    // operator sees nothing at all.
    const parts = splitStyled(text, options?.styles ?? []);
    let sent: OutgoingMessage | undefined;
    for (const part of parts) {
      sent = await this.sendPart(channelId, part.text, {
        ...options,
        styles: part.styles,
      });
    }
    if (!sent) throw new Error("nothing to send");
    return sent;
  }

  private async sendPart(
    channelId: string,
    text: string,
    options?: SendOptions,
  ): Promise<OutgoingMessage> {
    await this.limiter.acquire();
    this.opts.logger.debug("signal send", { text });
    const result = await this.rpc<{ timestamp?: number }>("send", {
      ...this.targetFor(channelId),
      message: text,
      ...this.quotesFor(options?.quote),
      ...this.stylesFor(options?.styles),
    });
    this.rememberSent(result.timestamp);
    return { messageId: String(result.timestamp ?? Date.now()) };
  }

  /** Create a private group (only this account) to serve as a project's room. */
  async createGroup(name: string): Promise<{ groupId: string }> {
    await this.limiter.acquire();
    const result = await this.rpc<{ groupId?: string }>("updateGroup", { name });
    const groupId = result.groupId;
    if (!groupId) throw new Error("signal-cli did not return a group id");
    return { groupId };
  }

  async edit(
    channelId: string,
    messageId: string,
    text: string,
    options?: SendOptions,
  ): Promise<void> {
    await this.limiter.acquire();
    const result = await this.rpc<{ timestamp?: number }>("send", {
      ...this.targetFor(channelId),
      message: text,
      editTimestamp: Number(messageId),
      ...this.quotesFor(options?.quote),
      ...this.stylesFor(options?.styles),
    });
    // The daemon echoes an edit like any other send, so remember it too:
    // otherwise the edited text comes back as a fresh command.
    this.rememberSent(result.timestamp);
  }

  /**
   * Send a poll. signal-cli rejects fewer than two or more than ten options, so
   * the core falls back to a numbered text menu when that does not fit.
   */
  async sendPoll(
    channelId: string,
    question: string,
    options: string[],
    allowMultiple = false,
    quote?: QuoteRef,
  ): Promise<OutgoingMessage> {
    if (options.length < 2 || options.length > 10) {
      throw new Error(`a poll needs 2-10 options, got ${options.length}`);
    }
    await this.limiter.acquire();
    const result = await this.rpc<{ timestamp?: number }>("sendPollCreate", {
      ...this.targetFor(channelId),
      question,
      option: options,
      ...(allowMultiple ? {} : { noMulti: true }),
      ...this.quotesFor(quote),
    });
    this.rememberSent(result.timestamp);
    return { messageId: String(result.timestamp ?? Date.now()) };
  }

  async attach(
    channelId: string,
    filePath: string,
    caption?: string,
    quote?: QuoteRef,
  ): Promise<OutgoingMessage> {    await this.limiter.acquire();
    const result = await this.rpc<{ timestamp?: number }>("send", {
      ...this.targetFor(channelId),
      message: caption ?? "",
      attachment: [filePath],
    });
    this.rememberSent(result.timestamp);
    return { messageId: String(result.timestamp ?? Date.now()) };
  }

  private targetFor(channelId: string): Record<string, string> {
    return targetParams(channelId, this.opts.account, this.opts.channelKind);
  }

  private quotesFor(quote?: QuoteRef): Record<string, unknown> {
    return quoteParams(quote, this.opts.account);
  }

  /** Styled ranges, as signal-cli's start:length:STYLE strings. */
  private stylesFor(styles?: StyleRange[]): Record<string, unknown> {
    if (!styles || styles.length === 0) return {};
    return { textStyle: styles.map(styleParam) };
  }

  private rememberSent(timestamp: number | undefined): void {
    if (timestamp == null) return;
    const key = String(timestamp);
    this.sentTimestamps.add(key);
    this.sentOrder.push(key);
    if (this.sentOrder.length > 100) {
      const oldest = this.sentOrder.shift();
      if (oldest) this.sentTimestamps.delete(oldest);
    }
    this.saveSentLog();
  }

  /**
   * Keep the sent timestamps on disk. A restart empties an in-memory set, and a
   * daemon that comes back after an outage replays what it queued — including
   * the sync echo of our own messages, which would then be run as commands.
   * Best effort: a missing or unreadable file only costs that protection.
   */
  private saveSentLog(): void {
    try {
      fs.mkdirSync(path.dirname(this.sentLogFile), { recursive: true });
      fs.writeFileSync(this.sentLogFile, JSON.stringify(this.sentOrder));
    } catch (err) {
      this.opts.logger.debug("could not persist sent timestamps", { error: String(err) });
    }
  }

  private loadSentLog(): void {
    try {
      const raw = fs.readFileSync(this.sentLogFile, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      for (const entry of parsed.slice(-100)) {
        const key = String(entry);
        this.sentTimestamps.add(key);
        this.sentOrder.push(key);
      }
    } catch {
      // No file yet, or it was damaged: start with an empty set.
    }
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

  /**
   * Called once per outage when `receive` keeps failing: the daemon is up but
   * not serving, so it has to be replaced rather than waited for.
   */
  onUnhealthy(handler: (reason: string) => void): void {
    this.unhealthyHandlers.push(handler);
  }
}
