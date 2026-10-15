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
/** How long an unanswered approval waits before it is rejected. */
const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000;
/** How many task/session bindings to remember across plugin reloads. */
const BINDING_MEMORY = 5;
/** How many polls to keep retrying a permission reply that opencode rejected. */
const REPLY_ATTEMPTS = 20;

const now = (): number => Date.now();

type Decision = "once" | "always" | "reject";

interface AgentEvent {
  type: "status" | "message" | "tool" | "files-changed" | "tests-run" | "permission" | "notice" | "error" | "idle";
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

type BridgeEvent = Omit<AgentEvent, "taskId">;

/** Longest assistant text forwarded as a status line. */
const STATUS_TEXT_LIMIT = 200;

/** Longest assistant text carried into the completion summary. */
const SUMMARY_TEXT_LIMIT = 500;

/**
 * The completion summary is the assistant's own last message, so the operator
 * gets the answer rather than "session idle". Falls back when a task produced no
 * text at all (tool-only work).
 */
export function summarizeIdle(fallback: string, lastText: string | undefined): string {
  const text = (lastText ?? "").trim();
  if (!text) return fallback;
  return text.length > SUMMARY_TEXT_LIMIT ? `${text.slice(0, SUMMARY_TEXT_LIMIT)}…` : text;
}

/**
 * Decide which opencode session a prompt runs in. The service sends a
 * `sessionId` when the project is pinned to a long-lived session (see the
 * project's `session` config), so the command lands in that session — for
 * example the one the operator is watching — instead of a fresh one.
 * Returns `undefined` when a new session was needed but could not be created.
 */
export async function resolvePromptSession(
  sessionId: unknown,
  create: () => Promise<string | undefined>,
): Promise<string | undefined> {
  if (typeof sessionId === "string" && sessionId.trim() !== "") return sessionId;
  return await create();
}

/**
 * Poll targets for pending permissions: the task and the session it runs in.
 * `sessionByTask` is keyed by task id, so read it as [taskId, sessionID] — the
 * two were destructured the wrong way round, which sent a task UUID where a
 * session id belongs and made every poll fail.
 */
export function pollTargets(sessions: Map<string, string>): { taskId: string; sessionID: string }[] {
  return [...sessions].map(([taskId, sessionID]) => ({ taskId, sessionID }));
}

/**
 * The models opencode offers, normalised to provider/id pairs. The list shape is
 * version-dependent, so accept both a flat array and a `{ data }` envelope.
 */
export function modelRefsFrom(result: unknown): { providerID: string; id: string; name?: string }[] {
  const list = Array.isArray(result)
    ? result
    : ((result as { data?: unknown } | null | undefined)?.data as unknown[] | undefined) ?? [];
  const models: { providerID: string; id: string; name?: string }[] = [];
  for (const entry of list) {
    const record = entry as {
      providerID?: string;
      id?: string;
      modelID?: string;
      name?: string;
      provider?: string;
    };
    const providerID = record?.providerID ?? record?.provider;
    const id = record?.id ?? record?.modelID;
    if (typeof providerID !== "string" || typeof id !== "string") continue;
    models.push({ providerID, id, ...(typeof record?.name === "string" ? { name: record.name } : {}) });
  }
  return models;
}

/**
 * Pending permission requests out of a `ctx.permission.list` result. The server
 * answers `{ data: [...] }`; older shapes return the array directly. The plugin
 * used to iterate the envelope object itself, which throws on every poll — and
 * that error was swallowed, so approvals never reached the operator.
 */
export function permissionRequestsFrom(result: unknown): any[] {
  if (Array.isArray(result)) return result;
  const data = (result as { data?: unknown } | null | undefined)?.data;
  return Array.isArray(data) ? (data as any[]) : [];
}

/**
 * A message can send files to the operator by naming them: `<<send: C:\path>>`.
 * The marker is stripped from the text shown in Signal and each path is sent as
 * an attachment — the outbound mirror of an inbound image.
 */
export function extractAttachments(text: string): { text: string; paths: string[] } {
  const paths: string[] = [];
  const cleaned = text.replace(/<<\s*send:\s*([\s\S]*?)>>/gi, (_match, body: string) => {
    for (const entry of body.split("|")) {
      const path = entry.trim();
      if (path) paths.push(path);
    }
    return "";
  });
  return { text: cleaned.trim(), paths };
}

/**
 * An assistant message can offer choices to the operator by ending with
 * `<<options: first | second | third>>`. The marker is stripped from the text
 * shown in Signal; the options become a numbered, tappable menu.
 */
export function extractOptions(text: string): { text: string; options: string[] } {
  const match = /<<\s*options:\s*([\s\S]*?)>>/i.exec(text);
  if (!match) return { text, options: [] };
  const options = (match[1] ?? "")
    .split("|")
    .map((option) => option.trim())
    .filter(Boolean);
  return { text: text.replace(match[0], "").trim(), options };
}

/**
 * Map an opencode V2 server event to a bridge event plus the session it belongs
 * to. V2 events look like `{ id, created, type, location, data, durable? }` —
 * the session id lives in `data.sessionID`, and the event names are
 * `session.*` (for example `session.tool.input.started`), not the V1
 * `message.part.updated` / `session.idle` pair. Returns `undefined` for events
 * the bridge does not forward.
 */
export function mapServerEvent(
  raw: unknown,
  at = Date.now(),
): { sessionID: string; event: BridgeEvent; fullText?: string } | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, any>;
  const data = (record.data ?? record.properties ?? record) as Record<string, any>;
  const sessionID: string | undefined = data.sessionID ?? record.sessionID;
  if (!sessionID) return undefined;

  switch (record.type) {
    case "question.asked":
      // opencode lets only its own client answer a question (no plugin API in
      // this version), so say so instead of going silent while the agent blocks.
      return {
        sessionID,
        event: {
          type: "notice",
          at,
          text: "opencode is asking a question — it has to be answered in the window; the agent is waiting.",
        },
      };
    case "question.replied":
    case "question.rejected":
      return { sessionID, event: { type: "notice", at, text: "question answered" } };
    case "session.idle":
    case "session.execution.succeeded":
      return { sessionID, event: { type: "idle", at, summary: "session idle" } };
    case "session.error":
    case "session.execution.failed":
      return {
        sessionID,
        event: { type: "error", at, text: data.error?.message ?? "session error" },
      };
    case "session.tool.input.started":
      return data.name
        ? { sessionID, event: { type: "tool", at, tool: String(data.name) } }
        : undefined;
    case "session.text.ended": {
      if (!data.text) return undefined;
      // Parse the markers before truncating, so a menu or a file at the end of a
      // long message is still picked up.
      const withOptions = extractOptions(String(data.text));
      const withFiles = extractAttachments(withOptions.text);
      const event: BridgeEvent = {
        type: "status",
        at,
        text: withFiles.text.slice(0, STATUS_TEXT_LIMIT),
      };
      if (withOptions.options.length > 0) event.choices = withOptions.options;
      if (withFiles.paths.length > 0) event.attachPaths = withFiles.paths;
      // The full text is kept for the completion summary — quiet mode sends one
      // message per task, and that message should carry the answer.
      return { sessionID, event, ...(withFiles.text ? { fullText: withFiles.text } : {}) };
    }
    default:
      return undefined;
  }
}

async function setup(ctx: any): Promise<() => void> {
  const directory: string = ctx?.location?.directory ?? process.cwd();
  const canonical: string = ctx?.location?.project?.canonical ?? directory;
  const name: string = basename(canonical);

  const taskBySession = new Map<string, string>();
  const sessionByTask = new Map<string, string>();
  const pendingPermissions = new Map<string, (d: Decision) => void>();
  /** Model the operator chose for this project; applied to every session. */
  let preferredModel: { providerID: string; id: string } | undefined;

  let ws: any;
  let closed = false;

  /**
   * Remember the task/session pairs across reloads. Without this, a plugin
   * reload (which happens on every file change) leaves the permission poll with
   * nothing to watch, so approvals are blind until the operator sends a new
   * message.
   */
  const rememberBindings = (): void => {
    const pairs = [...sessionByTask].slice(-BINDING_MEMORY);
    void Promise.resolve(ctx.storage?.set?.("bindings", Object.fromEntries(pairs))).catch(
      () => undefined,
    );
  };

  const send = (message: unknown): void => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(message));
  };
  const emit = (taskId: string, event: Omit<AgentEvent, "taskId">): void => {
    send({ type: "event", taskId, event: { ...event, taskId } });
  };

  async function handleCommand(message: any): Promise<void> {
    if (message?.type === "command" && message.kind === "prompt") {
      const id = await resolvePromptSession(message.sessionId, async () => {
        const session = await ctx.session.create({ title: String(message.prompt).slice(0, 60) });
        return session?.id ?? session?.data?.id;
      });
      if (!id) return;
      taskBySession.set(id, message.taskId);
      sessionByTask.set(message.taskId, id);
      rememberBindings();
      // Apply the operator's chosen model before the prompt runs.
      if (preferredModel) {
        try {
          await ctx.session.switchModel({ sessionID: id, model: preferredModel });
        } catch (err) {
          send({ type: "diag", detail: `could not apply the selected model: ${String(err)}` });
        }
      }
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
    if (message?.type === "command" && message.kind === "listModels") {
      try {
        const list = await ctx.model.list();
        const models = modelRefsFrom(list);
        send({ type: "models", requestId: message.requestId, models });
      } catch (err) {
        send({
          type: "models",
          requestId: message.requestId,
          models: [],
        });
        send({ type: "diag", detail: `could not list models: ${String(err)}` });
      }
      return;
    }
    if (message?.type === "command" && message.kind === "setModel") {
      const model = { providerID: message.model.providerID, id: message.model.id };
      // Remember it: projects without a pinned session get a fresh session per
      // task, so the choice has to be applied to every session we create.
      preferredModel = model;
      try {
        await ctx.storage?.set?.("model", model);
      } catch {
        /* remember in memory only */
      }

      const targets = new Set<string>();
      if (typeof message.sessionId === "string" && message.sessionId.startsWith("ses")) {
        targets.add(message.sessionId);
      }
      for (const sessionID of sessionByTask.values()) targets.add(sessionID);

      if (targets.size === 0) {
        send({
          type: "model_set",
          requestId: message.requestId,
          ok: true,
          detail: "remembered; it applies to the next session",
        });
        return;
      }
      for (const sessionID of targets) {
        try {
          await ctx.session.switchModel({ sessionID, model });
        } catch (err) {
          send({
            type: "model_set",
            requestId: message.requestId,
            ok: false,
            detail: String(err),
          });
          return;
        }
      }
      send({ type: "model_set", requestId: message.requestId, ok: true });
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
    try {
      ws = new WebSocket(BRIDGE_URL);
    } catch {
      // No WebSocket in this runtime; nothing to stream over.
      return;
    }
    ws.onopen = () => send({ type: "register", project: { name, path: directory }, version: "0.2.1" });
    ws.onmessage = (ev: MessageEvent) => {
      let message: unknown;
      try {
        message = JSON.parse(String(ev.data));
      } catch {
        return; // ignore malformed frames
      }
      void handleCommand(message).catch((err: unknown) =>
        console.error("[signal-connector] command failed", err),
      );
    };
    ws.onclose = () => {
      if (!closed) setTimeout(connect, 2000);
    };
    ws.onerror = () => {
      /* onclose reconnects */
    };
  }
  connect();

  // Restore the last bindings so approvals keep flowing right after a reload.
  void (async () => {
    try {
      const saved = (await ctx.storage?.get?.("bindings")) as Record<string, string> | undefined;
      for (const [taskId, sessionID] of Object.entries(saved ?? {})) {
        if (typeof sessionID === "string" && sessionID.startsWith("ses")) {
          sessionByTask.set(taskId, sessionID);
          taskBySession.set(sessionID, taskId);
        }
      }
      const model = (await ctx.storage?.get?.("model")) as
        | { providerID?: string; id?: string }
        | undefined;
      if (typeof model?.providerID === "string" && typeof model.id === "string") {
        preferredModel = { providerID: model.providerID, id: model.id };
      }
    } catch (err) {
      send({ type: "diag", detail: `could not restore bindings: ${String(err)}` });
    }
  })();

  // Stream session events to the service. Each task is finished once, so a
  // later duplicate terminal event cannot re-send a summary. The last assistant
  // text per task becomes that summary.
  const controller = new AbortController();
  const finished = new Set<string>();
  const lastText = new Map<string, string>();
  void (async () => {
    try {
      for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
        const mapped = mapServerEvent(raw);
        if (!mapped) continue;
        const taskId = taskBySession.get(mapped.sessionID);
        if (!taskId) continue;
        if (mapped.fullText) lastText.set(taskId, mapped.fullText);

        let event = mapped.event;
        if (event.type === "idle" || event.type === "error") {
          if (finished.has(taskId)) continue;
          finished.add(taskId);
          if (event.type === "idle") {
            event = { ...event, summary: summarizeIdle(event.summary ?? "session idle", lastText.get(taskId)) };
          }
          lastText.delete(taskId);
        }
        emit(taskId, event);
      }
    } catch (err) {
      console.error("[signal-connector] event stream ended", err);
    }
  })();

  // Forward permission requests and apply the operator's reply. Each request is
  // asked exactly once: if our reply to opencode does not take effect, it is
  // retried quietly instead of prompting the operator again — otherwise the same
  // request is re-asked every poll, forever.
  const replyAttempts = new Map<string, number>();
  const answered = new Map<string, Decision>();
  const diagSeen = new Map<string, number>();
  let pollReported = false;

  const reportDiag = (detail: string): void => {
    const last = diagSeen.get(detail) ?? 0;
    if (Date.now() - last < 60_000) return; // one report a minute per distinct problem
    diagSeen.set(detail, now());
    send({ type: "diag", detail });
  };

  /**
   * Answer a permission request. The API requires `decision` and rejects unknown
   * keys, while the plugin guide's example shows `reply` — and sending the wrong
   * one is a 400 that leaves the request pending, so the same prompt is asked
   * forever. Try the wire field first, fall back to the documented one.
   */
  const attemptReply = async (
    sessionID: string,
    id: string,
    decision: Decision,
  ): Promise<string | undefined> => {
    try {
      await ctx.permission.reply({ sessionID, requestID: id, decision });
      return undefined;
    } catch (err) {
      try {
        await ctx.permission.reply({ sessionID, requestID: id, reply: decision });
        return undefined;
      } catch (err2) {
        return `${String(err)} | fallback: ${String(err2)}`;
      }
    }
  };

  const timer = setInterval(() => {
    void (async () => {
      for (const { taskId, sessionID } of pollTargets(sessionByTask)) {
        let requests: any[];
        try {
          requests = permissionRequestsFrom(await ctx.permission.list({ sessionID }));
        } catch (err) {
          reportDiag(`permission poll failed: ${String(err)}`);
          continue;
        }
        if (!pollReported) {
          pollReported = true;
          send({ type: "diag", detail: `permission poll ok (${requests.length} pending)` });
        }

        for (const request of requests) {
          const id = request.id ?? request.requestID;
          if (!id) continue;

          // Already answered: retry the reply, never ask again.
          const decided = answered.get(id);
          if (decided) {
            const attempts = (replyAttempts.get(id) ?? 0) + 1;
            replyAttempts.set(id, attempts);
            if (attempts > REPLY_ATTEMPTS) continue;
            const failure = await attemptReply(sessionID, id, decided);
            if (failure) {
              reportDiag(`permission reply rejected for ${id}: ${failure}`);
            } else {
              answered.delete(id);
              replyAttempts.delete(id);
              send({ type: "diag", detail: `permission reply accepted for ${id} (attempt ${attempts})` });
            }
            continue;
          }

          if (pendingPermissions.has(id)) continue;
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
            }, PERMISSION_TIMEOUT_MS);
          });
          answered.set(id, decision);
          const failure = await attemptReply(sessionID, id, decision);
          send({
            type: "diag",
            detail: failure
              ? `permission reply rejected for ${id}: ${failure}`
              : `permission reply accepted for ${id}`,
          });
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
