/**
 * Input parsing. Pure; no I/O. Recognizes slash commands, bare approval
 * keywords, and everything else as a free-form prompt.
 */

export type ParsedInput =
  | { kind: "command"; name: string; args: string }
  | { kind: "approval"; decision: "once" | "always" | "reject" }
  | { kind: "prompt"; text: string };

/** Words the operator can send to answer a permission prompt. */
export const APPROVAL_DECISIONS: Record<string, "once" | "always" | "reject"> = {
  approve: "once",
  approved: "once",
  allow: "once",
  allowed: "once",
  ok: "once",
  yes: "once",
  "approve once": "once",
  "allow once": "once",
  always: "always",
  "approve always": "always",
  "allow always": "always",
  "always allow": "always",
  "always approve": "always",
  deny: "reject",
  denied: "reject",
  reject: "reject",
  rejected: "reject",
  no: "reject",
  block: "reject",
};

const APPROVAL_PHRASES = new Set(Object.keys(APPROVAL_DECISIONS));

export const KNOWN_COMMANDS = [
  "open",
  "task",
  "models",
  "model",
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
  "/projects — list configured projects and which have their own group",
  "/open <project> — give the project its own group and open its window",
  "/task <prompt> — start a task (in a project's group, for that project)",
  "/status — show the latest task state",
  "/new — fork a fresh session for the project",
  "/stop — abort the running task",
  "/approve | /deny | /always — answer a permission prompt",
  "/models — list this project's models and pick one",
  "/model <number|provider/id> — switch this session's model",
  "/help — this message",
  "Each project talks in its own group; anything you send there is about that project.",
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
  const lower = trimmed.toLowerCase().replace(/[.!]+$/, "");
  // Accept the wording clients use for approvals, not just the terse keywords:
  // the dialog says "Approve once / Always allow / Reject".
  if (APPROVAL_PHRASES.has(lower)) return { kind: "approval", decision: APPROVAL_DECISIONS[lower]! };
  return { kind: "prompt", text: trimmed };
}
