/**
 * Pure mapping from opencode JSON event shapes to domain AgentEvents.
 * Shared by the CLI and server adapters so both speak one vocabulary.
 * Shapes are defensive: unknown events degrade to a status line or are dropped.
 */
import type { AgentEvent, PermissionRequest } from "../../domain/types.js";

function firstString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function mapOpenCodeEvent(raw: unknown, taskId: string, at = Date.now()): AgentEvent | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const e = raw as Record<string, unknown>;
  const type = typeof e.type === "string" ? e.type : undefined;
  const text = firstString(e, ["text", "message", "content", "summary"]);

  switch (type) {
    case "error":
      return { type: "error", taskId, at, ...(text ? { text } : {}) };

    case "permission":
    case "permission.asked": {
      const tool = firstString(e, ["tool", "name"]) ?? "unknown";
      const id = firstString(e, ["id", "permissionID", "permissionId"]) ?? "";
      const permission: PermissionRequest = {
        id,
        taskId,
        tool,
        description: text ?? tool,
        safe: e.safe === true,
      };
      return { type: "permission", taskId, at, permission };
    }

    case "result":
    case "done":
    case "idle":
    case "session.idle":
      return {
        type: "idle",
        taskId,
        at,
        ...(text ? { summary: text } : {}),
        ...(typeof e.diffPath === "string" ? { diffPath: e.diffPath } : {}),
      };

    case "tool":
    case "tool_use": {
      const tool = firstString(e, ["tool", "name"]);
      return { type: "tool", taskId, at, ...(tool ? { tool } : {}), ...(text ? { text } : {}) };
    }

    case "file_change":
    case "files-changed": {
      const files = Array.isArray(e.files) ? e.files.map((f) => String(f)) : [];
      return { type: "files-changed", taskId, at, files };
    }

    default:
      return text ? { type: "status", taskId, at, text } : undefined;
  }
}
