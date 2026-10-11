/**
 * Input parsing. Pure; no I/O. Recognizes slash commands, bare approval
 * keywords, and everything else as a free-form prompt.
 */

export type ParsedInput =
  | { kind: "command"; name: string; args: string }
  | { kind: "approval"; decision: "once" | "always" | "reject" }
  | { kind: "prompt"; text: string };

export const KNOWN_COMMANDS = [
  "use",
  "task",
  "status",
  "approve",
  "deny",
  "stop",
  "new",
  "projects",
  "help",
] as const;

export const HELP_TEXT = [
  "SignalConnector commands:",
  "/projects — list configured projects",
  "/use <project> — set the active project",
  "/task <prompt> — start a task in the active project",
  "/status — show the latest task state",
  "/new — fork a fresh session for the active project",
  "/stop — abort the running task",
  "/approve | /deny | /always — answer a permission prompt",
  "/help — this message",
  "Any other text is sent to the active project's session.",
].join("\n");

export function parseInput(text: string): ParsedInput {
  const trimmed = text.trim();
  if (trimmed.startsWith("/")) {
    const match = /^\/([a-zA-Z]+)\s*([\s\S]*)$/.exec(trimmed);
    if (match && match[1]) {
      const name = match[1].toLowerCase();
      const args = (match[2] ?? "").trim();
      if (name === "approve") return { kind: "approval", decision: "once" };
      if (name === "deny") return { kind: "approval", decision: "reject" };
      if (name === "always") return { kind: "approval", decision: "always" };
      return { kind: "command", name, args };
    }
  }
  const lower = trimmed.toLowerCase();
  if (lower === "approve" || lower === "yes") return { kind: "approval", decision: "once" };
  if (lower === "deny" || lower === "no") return { kind: "approval", decision: "reject" };
  if (lower === "always") return { kind: "approval", decision: "always" };
  return { kind: "prompt", text: trimmed };
}
