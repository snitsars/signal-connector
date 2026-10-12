/**
 * Chooses the AgentPort implementation from config (spine AD-5).
 *
 * - "plugin":           per-project opencode plugins over the bridge (multi-project).
 * - "opencode-server":  the v2 server API when reachable, else the CLI fallback.
 * - "opencode-cli":     the CLI adapter.
 */
import type { BridgeHub } from "../../bridge/hub.js";
import type { Config } from "../../config/config.js";
import type { AgentPort } from "../../core/ports.js";
import type { Logger } from "../../logging/logger.js";
import { OpenCodeCliAdapter } from "./opencodeCli.js";
import { OpenCodeServerAdapter } from "./opencodeServer.js";
import { PluginBridgeAgent } from "./pluginBridge.js";

export async function createAgentAdapter(
  config: Config,
  logger: Logger,
  hub: BridgeHub,
): Promise<AgentPort> {
  if (config.agent.kind === "plugin") {
    logger.info("agent: using plugin bridge (multi-project)");
    return new PluginBridgeAgent(hub, logger);
  }

  if (config.agent.kind === "opencode-server") {
    const server = new OpenCodeServerAdapter({ baseUrl: config.agent.serverUrl, logger });
    if (await server.health()) {
      logger.info("agent: using opencode server API", { baseUrl: config.agent.serverUrl });
      return server;
    }
    logger.warn("agent: opencode server not reachable; falling back to CLI adapter", {
      baseUrl: config.agent.serverUrl,
    });
  }
  return new OpenCodeCliAdapter({ opencodePath: config.agent.opencodePath, logger });
}
