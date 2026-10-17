/**
 * A small Chrome DevTools Protocol client over `ws` (already a dependency, so
 * browser control costs nothing new). The debugging port is read from the
 * profile's own `DevToolsActivePort` file — never guessed.
 *
 * Nothing here logs: the target's URL is the room link, the port is a way in,
 * and both must stay out of every log line.
 */
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface DevToolsPort {
  port: number;
  wsPath: string;
}

/**
 * Read the port Chrome wrote when it bound its debugging socket. The first line
 * is the port, the second the browser-level websocket path.
 */
export function parseDevToolsActivePort(raw: string): DevToolsPort | undefined {
  const [portLine, wsPath] = raw.split(/\r?\n/);
  const port = Number(portLine);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  if (!wsPath || !wsPath.startsWith("/")) return undefined;
  return { port, wsPath };
}

/** Poll for `DevToolsActivePort` in the profile directory. */
export async function waitForDevToolsPort(
  profileDir: string,
  timeoutMs = 15_000,
  intervalMs = 100,
  alive: () => boolean = () => true,
): Promise<DevToolsPort> {
  const file = path.join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!alive()) throw new Error("the browser exited before the room opened");
    let raw: string | undefined;
    try {
      raw = await fs.promises.readFile(file, "utf8");
    } catch {
      raw = undefined;
    }
    const parsed = raw ? parseDevToolsActivePort(raw) : undefined;
    if (parsed) return parsed;
    await delay(intervalMs);
  }
  throw new Error("the browser did not open a debugging port");
}

type Handler = (params: Record<string, unknown>) => void;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface EventMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
}

export class CdpClient {
  private readonly socket: WebSocket;
  private readonly pending = new Map<number, PendingCall>();
  private readonly listeners = new Map<string, Set<Handler>>();
  private readonly closeHandlers = new Set<() => void>();
  private seq = 0;
  private closed = false;
  private closeNotified = false;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (data: WebSocket.RawData) => {
      this.dispatch(typeof data === "string" ? data : data.toString());
    });
    socket.on("close", () => {
      this.failAll();
      this.notifyClosed();
    });
    socket.on("error", () => {
      this.failAll();
      this.notifyClosed();
    });
  }

  static connect(url: string, timeoutMs = 10_000): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error("the browser did not answer on its debugging port"));
      }, timeoutMs);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve(new CdpClient(socket));
      });
      socket.once("error", () => {
        clearTimeout(timer);
        reject(new Error("the browser's debugging port refused the connection"));
      });
    });
  }

  send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error("the browser connection is closed"));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      const message: Record<string, unknown> = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      try {
        this.socket.send(JSON.stringify(message));
      } catch {
        this.pending.delete(id);
        reject(new Error("could not talk to the browser"));
      }
    });
  }

  on(event: string, handler: Handler): () => void {
    let handlers = this.listeners.get(event);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(event, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }

  /**
   * Fires once when the debugging socket is gone, however it went: a deliberate
   * close, the browser exiting, or a transport error. Late subscribers hear it
   * immediately.
   */
  onClose(handler: () => void): () => void {
    if (this.closeNotified) {
      handler();
      return () => undefined;
    }
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.close();
    } catch {
      /* already closed */
    }
    this.failAll();
    this.notifyClosed();
  }

  private notifyClosed(): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    const handlers = [...this.closeHandlers];
    this.closeHandlers.clear();
    for (const handler of handlers) handler();
  }

  private failAll(): void {
    this.closed = true;
    for (const call of this.pending.values()) {
      call.reject(new Error("the browser connection is closed"));
    }
    this.pending.clear();
  }

  private dispatch(raw: string): void {
    let parsed: EventMessage;
    try {
      parsed = JSON.parse(raw) as EventMessage;
    } catch {
      return;
    }
    if (typeof parsed.id === "number") {
      const call = this.pending.get(parsed.id);
      if (!call) return;
      this.pending.delete(parsed.id);
      if (parsed.error) call.reject(new Error(parsed.error.message ?? "the browser refused the request"));
      else call.resolve(parsed.result);
      return;
    }
    if (!parsed.method) return;
    const handlers = this.listeners.get(parsed.method);
    if (!handlers) return;
    for (const handler of handlers) handler(parsed.params ?? {});
  }
}

export interface AttachedPage {
  client: CdpClient;
  targetId: string;
  sessionId: string;
  evaluate<T>(expression: string): Promise<T>;
  /** Load a URL in this page (the room is opened only after injection). */
  navigate(url: string): Promise<void>;
  /** Fires when this page target goes away (crash, close, navigation to a new target). */
  onDetached(handler: () => void): () => void;
}

/** Attach to the browser's first page target and enable page/runtime domains. */
export async function attachToPage(client: CdpClient): Promise<AttachedPage> {
  const { targetInfos } = await client.send<{
    targetInfos: { targetId: string; type: string; url?: string }[];
  }>("Target.getTargets");
  // Prefer the page showing the room; a new-tab page may be listed beside it.
  const page =
    targetInfos.find(
      (target) =>
        target.type === "page" && !/^(about:|chrome:|chrome-untrusted:|devtools:|edge:)/i.test(target.url ?? ""),
    ) ?? targetInfos.find((target) => target.type === "page");
  if (!page) throw new Error("the browser opened no page");

  const { sessionId } = await client.send<{ sessionId: string }>("Target.attachToTarget", {
    targetId: page.targetId,
    flatten: true,
  });
  await client.send("Page.enable", {}, sessionId);
  await client.send("Runtime.enable", {}, sessionId);

  return {
    client,
    targetId: page.targetId,
    sessionId,
    async evaluate<T>(expression: string): Promise<T> {
      const result = await client.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: false },
        sessionId,
      );
      if (result.exceptionDetails) throw new Error("the page could not run the avatar script");
      return result.result?.value as T;
    },
    async navigate(url: string): Promise<void> {
      await client.send("Page.navigate", { url }, sessionId);
    },
    onDetached(handler: () => void): () => void {
      return client.on("Target.detachedFromTarget", (params) => {
        if (params.sessionId === sessionId) handler();
      });
    },
  };
}
