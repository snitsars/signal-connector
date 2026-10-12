/**
 * SignalConnector — opencode plugin (per-project bridge).
 *
 * The SignalConnector service owns Signal and the command router; this plugin
 * runs inside opencode for one project, receives commands for that project,
 * executes them via the SDK `client`, and streams events/permission requests
 * back to the service over a local WebSocket.
 *
 * Enable: set `agent.kind = "plugin"` in the service config, run the service,
 * then open this project in opencode. Bridge URL defaults to
 * ws://127.0.0.1:8790 (override with SIGNAL_CONNECTOR_BRIDGE).
 */
import type { Plugin } from "@opencode-ai/plugin";

const BRIDGE_URL = process.env.SIGNAL_CONNECTOR_BRIDGE ?? "ws://127.0.0.1:8790";
const PERMISSION_TIMEOUT_MS = 120_000;

type Decision = "once" | "always" | "reject";

interface AgentEvent {
  type: "status" | "message" | "tool" | "files-changed" | "tests-run" | "permission" | "error" | "idle";
  taskId: string;
  at: number;
  text?: string;
  tool?: string;
  files?: string[];
  summary?: string;
  diffPath?: string;
  permission?: { id: string; taskId: string; tool: string; description: string; safe: boolean };
}

function projectNameFrom(dir: string): string {
  const parts = dir.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || "project";
}

export const SignalConnector: Plugin = async ({ project, client, directory }) => {
  const name = project?.name ?? projectNameFrom(directory);
  const taskBySession = new Map<string, string>();
  const sessionByTask = new Map<string, string>();
  const pendingPermissions = new Map<string, (d: Decision) => void>();

  let ws: WebSocket | undefined;
  let closed = false;

  const send = (message: unknown): void => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };

  const emit = (taskId: string, event: Omit<AgentEvent, "taskId">): void => {
    send({ type: "event", taskId, event: { ...event, taskId } });
  };

  async function handleCommand(message: any): Promise<void> {
    if (message?.type === "command" && message.kind === "prompt") {
      const session = await client.session.create({ body: { title: message.prompt.slice(0, 60) } });
      const id = (session as any)?.data?.id ?? (session as any)?.id;
      if (!id) return;
      taskBySession.set(id, message.taskId);
      sessionByTask.set(message.taskId, id);
      await client.session.prompt({
        path: { id },
        body: { parts: [{ type: "text", text: message.prompt }] },
      });
      return;
    }
    if (message?.type === "command" && message.kind === "stop") {
      const id = sessionByTask.get(message.taskId);
      if (id) await client.session.abort({ path: { id } });
      return;
    }
    if (message?.type === "command" && message.kind === "newSession") {
      const session = await client.session.create({ body: { title: "signal-connector" } });
      const id = (session as any)?.data?.id ?? (session as any)?.id;
      send({ type: "session_created", requestId: message.requestId, sessionId: id ?? "" });
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
    ws.onopen = () => send({ type: "register", project: { name, path: directory }, version: "0.1.0" });
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
      /* onclose handles reconnect */
    };
  }

  connect();

  return {
    event: async ({ event }: { event: any }) => {
      const props = event?.properties ?? {};
      const sessionID: string | undefined = props.sessionID ?? props.sessionId;
      const taskId = sessionID ? taskBySession.get(sessionID) : undefined;

      switch (event?.type) {
        case "permission.asked": {
          if (!sessionID || !taskId) return;
          const id = props.id ?? props.permissionID ?? props.requestID ?? "";
          const tool = props.tool ?? props.action ?? "tool";
          const description = props.message ?? props.description ?? tool;
          const decision = await new Promise<Decision>((resolve) => {
            pendingPermissions.set(id, resolve);
            emit(taskId, {
              type: "permission",
              at: Date.now(),
              tool,
              permission: { id, taskId, tool, description, safe: false },
            });
            setTimeout(() => {
              if (pendingPermissions.delete(id)) resolve("reject");
            }, PERMISSION_TIMEOUT_MS);
          });
          try {
            await (client as any).postSessionByIdPermissionsByPermissionId({
              path: { id: sessionID, permissionId: id },
              body: { response: decision },
            });
          } catch {
            /* reply shape may differ across versions */
          }
          return;
        }
        case "session.idle":
          if (taskId) emit(taskId, { type: "idle", at: Date.now(), summary: "session idle" });
          return;
        case "session.error":
          if (taskId) emit(taskId, { type: "error", at: Date.now(), text: props.error?.message ?? "session error" });
          return;
        case "session.diff":
          if (taskId) emit(taskId, { type: "files-changed", at: Date.now(), files: props.files ?? [] });
          return;
        case "message.part.updated": {
          if (!taskId) return;
          const part = props.part;
          if (part?.type === "tool" && part.tool) emit(taskId, { type: "tool", at: Date.now(), tool: part.tool });
          else if (part?.type === "text" && part.text) emit(taskId, { type: "status", at: Date.now(), text: String(part.text).slice(0, 200) });
          return;
        }
        default:
          return;
      }
    },
  };
};
