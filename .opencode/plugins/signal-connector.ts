/**
 * SignalConnector — opencode v2 plugin (per-project bridge).
 *
 * v2 API: the module default-exports { id, setup }. `ctx` is an opencode server
 * client plus plugin methods. The service owns Signal and the router; this
 * plugin runs inside opencode for one project, receives commands, executes them
 * via ctx.session.*, and streams events/permissions back over a local WebSocket.
 *
 * Enable: `agent.kind = "plugin"` in the service config, run the service, open
 * this project in opencode. Bridge URL defaults to ws://127.0.0.1:8790
 * (override with SIGNAL_CONNECTOR_BRIDGE).
 */
const BRIDGE_URL = process.env.SIGNAL_CONNECTOR_BRIDGE ?? "ws://127.0.0.1:8790";
const PERMISSION_POLL_MS = 3000;

type Decision = "once" | "always" | "reject";

interface AgentEvent {
  type: "status" | "message" | "tool" | "files-changed" | "tests-run" | "permission" | "error" | "idle";
  taskId: string;
  at: number;
  text?: string;
  tool?: string;
  files?: string[];
  summary?: string;
  permission?: { id: string; taskId: string; tool: string; description: string; safe: boolean };
}

function basename(dir: string): string {
  const parts = dir.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || "project";
}

async function setup(ctx: any): Promise<() => void> {
  const directory: string = ctx?.location?.directory ?? process.cwd();
  const name: string = ctx?.location?.project?.canonical ?? basename(directory);

  const taskBySession = new Map<string, string>();
  const sessionByTask = new Map<string, string>();
  const pendingPermissions = new Map<string, (d: Decision) => void>();

  let ws: any;
  let closed = false;

  const send = (message: unknown): void => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(message));
  };
  const emit = (taskId: string, event: Omit<AgentEvent, "taskId">): void => {
    send({ type: "event", taskId, event: { ...event, taskId } });
  };

  async function handleCommand(message: any): Promise<void> {
    if (message?.type === "command" && message.kind === "prompt") {
      const session = await ctx.session.create({ title: String(message.prompt).slice(0, 60) });
      const id = session?.id ?? session?.data?.id;
      if (!id) return;
      taskBySession.set(id, message.taskId);
      sessionByTask.set(message.taskId, id);
      await ctx.session.prompt({ sessionID: id, text: message.prompt });
      return;
    }
    if (message?.type === "command" && message.kind === "stop") {
      const id = sessionByTask.get(message.taskId);
      if (id) await ctx.session.interrupt({ sessionID: id, continue: false });
      return;
    }
    if (message?.type === "command" && message.kind === "newSession") {
      const session = await ctx.session.create({ title: "signal-connector" });
      const id = session?.id ?? session?.data?.id ?? "";
      send({ type: "session_created", requestId: message.requestId, sessionId: id });
      return;
    }
    if (message?.type === "permission_reply") {
      const resolve = pendingPermissions.get(message.permissionId);
      if (resolve) {
        pendingPermissions.delete(message.permissionId);
        resolve(message.decision as Decision);
      }
    }
  }

  function connect(): void {
    if (closed) return;
    ws = new WebSocket(BRIDGE_URL);
    ws.onopen = () => send({ type: "register", project: { name, path: directory }, version: "0.2.0" });
    ws.onmessage = (ev: MessageEvent) => {
      try {
        void handleCommand(JSON.parse(String(ev.data)));
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (!closed) setTimeout(connect, 2000);
    };
    ws.onerror = () => {
      /* onclose reconnects */
    };
  }
  connect();

  // Stream session events to the service.
  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const props = event?.properties ?? event ?? {};
        const sessionID: string | undefined = props.sessionID ?? event?.sessionID;
        const taskId = sessionID ? taskBySession.get(sessionID) : undefined;
        if (!taskId) continue;
        switch (event?.type) {
          case "session.idle":
            emit(taskId, { type: "idle", at: Date.now(), summary: "session idle" });
            break;
          case "session.error":
            emit(taskId, { type: "error", at: Date.now(), text: props.error?.message ?? "session error" });
            break;
          case "message.part.updated": {
            const part = props.part;
            if (part?.type === "tool" && part.tool) emit(taskId, { type: "tool", at: Date.now(), tool: part.tool });
            else if (part?.type === "text" && part.text) emit(taskId, { type: "status", at: Date.now(), text: String(part.text).slice(0, 200) });
            break;
          }
          default:
            break;
        }
      }
    } catch {
      /* aborted on cleanup */
    }
  })();

  // Forward permission requests and apply the operator's reply.
  const timer = setInterval(() => {
    void (async () => {
      for (const [sessionID, taskId] of sessionByTask) {
        try {
          const list = await ctx.permission.list({ sessionID });
          for (const request of list ?? []) {
            const id = request.id ?? request.requestID;
            if (!id || pendingPermissions.has(id)) continue;
            const tool = request.action ?? "tool";
            const decision = await new Promise<Decision>((resolve) => {
              pendingPermissions.set(id, resolve);
              emit(taskId, {
                type: "permission",
                at: Date.now(),
                tool,
                permission: {
                  id,
                  taskId,
                  tool,
                  description: request.message ?? `${tool} ${(request.resources ?? []).join(", ")}`,
                  safe: false,
                },
              });
              setTimeout(() => {
                if (pendingPermissions.delete(id)) resolve("reject");
              }, 120_000);
            });
            try {
              await ctx.permission.reply({ sessionID, requestID: id, reply: decision });
            } catch {
              /* reply shape may differ across versions */
            }
          }
        } catch {
          /* session may be gone */
        }
      }
    })();
  }, PERMISSION_POLL_MS);

  return () => {
    closed = true;
    controller.abort();
    clearInterval(timer);
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  };
}

export default {
  id: "signal-connector",
  setup,
  // Some opencode builds use a v1-style loader that requires a `server`
  // function; the v2 loader reads id/setup and ignores this. No-op there.
  server: () => ({}),
};
