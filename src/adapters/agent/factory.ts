/**
 * Chooses the AgentPort implementation from config (spine AD-5).
 *
 * Prefers the opencode v2 server API (live events + permission round-trip)
 * when the configured server is reachable; otherwise falls back to the CLI
 * adapter so notifications still work.
 */
import type { Config } from "../../config/config.js";
import type { AgentPort } from "../../core/ports.js";
import type { Logger } from "../../logging/logger.js";
import { OpenCodeCliAdapter } from "./opencodeCli.js";
import { OpenCodeServerAdapter } from "./opencodeServer.js";

export async function createAgentAdapter(config: Config, logger: Logger): Promise<AgentPort> {
  if (config.agent.kind === "opencode-server") {
    const server = new OpenCodeServerAdapter({
      baseUrl: config.agent.serverUrl,
      logger,
    });
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
