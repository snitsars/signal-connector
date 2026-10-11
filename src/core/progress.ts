/**
 * Progress rendering. Pure formatting; no I/O.
 */
import type { AgentEvent, Task } from "../domain/types.js";

const LABEL: Record<Task["state"], string> = {
  started: "starting",
  running: "running",
  done: "done",
  failed: "failed",
  aborted: "aborted",
};

export function statusLine(task: Task, detail?: string): string {
  const d = detail ? ` — ${detail}` : "";
  return `Task ${task.id} (${LABEL[task.state]})${d}`;
}

export function milestoneText(event: AgentEvent): string | undefined {
  switch (event.type) {
    case "files-changed": {
      const files = event.files ?? [];
      if (files.length === 0) return undefined;
      const shown = files.slice(0, 5).join(", ");
      const more = files.length > 5 ? ` (+${files.length - 5} more)` : "";
      return `Changed ${files.length} file(s): ${shown}${more}`;
    }
    case "tests-run":
      return event.text ? `Tests run: ${event.text}` : "Tests run";
    case "error":
      return `Error: ${event.text ?? "unknown"}`;
    default:
      return undefined;
  }
}

export function summaryText(task: Task): string {
  switch (task.state) {
    case "done":
      return `Done: ${task.summary ?? task.prompt}`;
    case "failed":
      return `Failed: ${task.error ?? "unknown error"}`;
    case "aborted":
      return `Aborted: ${task.prompt}`;
    default:
      return statusLine(task);
  }
}
