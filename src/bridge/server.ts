/**
 * WebSocket server for the plugin bridge. Decodes frames and delegates to the
 * BridgeHub. Bound to localhost only.
 */
import { WebSocketServer, type WebSocket } from "ws";
import type { Logger } from "../logging/logger.js";
import type { BridgeHub, PluginConnection } from "./hub.js";
import type { BridgeOutbound, PluginToService } from "./protocol.js";

export interface BridgeServerOptions {
  host: string;
  port: number;
  logger: Logger;
}

export function startBridgeServer(hub: BridgeHub, opts: BridgeServerOptions): WebSocketServer {
  const wss = new WebSocketServer({ host: opts.host, port: opts.port });

  wss.on("connection", (socket: WebSocket) => {
    let conn: PluginConnection | undefined;
    const send = (message: BridgeOutbound): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };

    socket.on("message", (data: Buffer | string) => {
      let message: PluginToService;
      try {
        message = JSON.parse(String(data)) as PluginToService;
      } catch {
        return;
      }
      if (!conn) {
        if (message.type === "register") {
          conn = hub.register(send, message);
          opts.logger.info("plugin registered", { project: conn.projectId });
        }
        return;
      }
      hub.dispatch(conn, message);
    });

    socket.on("close", () => {
      if (conn) {
        hub.unregister(conn);
        opts.logger.info("plugin disconnected", { project: conn.projectId });
      }
    });
    socket.on("error", (err) => opts.logger.warn("bridge socket error", { error: String(err) }));
  });

  wss.on("listening", () => opts.logger.info("bridge listening", { host: opts.host, port: opts.port }));
  wss.on("error", (err) => opts.logger.error("bridge server error", { error: String(err) }));
  return wss;
}
