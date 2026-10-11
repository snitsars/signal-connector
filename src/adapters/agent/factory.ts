/**
 * Chooses the AgentPort implementation from config (spine AD-5).
 *
 * Both configured kinds currently use the CLI adapter, which drives the
 * running opencode service via `opencode run --format json`. The v2 server API
 * adapter (live event stream + permission round-trip) is tickets 3.2/3.3 and
 * will slot in here without touching the core.
 */
import type { Config } from "../../config/config.js";
import type { AgentPort } from "../../core/ports.js";
import type { Logger } from "../../logging/logger.js";
import { OpenCodeCliAdapter } from "./opencodeCli.js";

export function createAgentAdapter(config: Config, logger: Logger): AgentPort {
  if (config.agent.kind === "opencode-server") {
    logger.info("agent: opencode server API pending; using CLI adapter (ticket 3.2)");
  }
  return new OpenCodeCliAdapter({ opencodePath: config.agent.opencodePath, logger });
}
