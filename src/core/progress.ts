/**
 * Progress rendering. Pure formatting; no I/O.
 */
import type { AgentEvent, Task } from "../domain/types.js";

/**
 * The colour language for messages. Signal has no coloured text, so state is
 * carried by circles: blue = working, green = fine, red = needs attention
 * (a failure or a question blocking the process), yellow = worth knowing.
 */
export const MARK = {
  working: "🔵",
  ok: "🟢",
  attention: "🔴",
  info: "🟡",
} as const;

const MARK_BY_STATE: Record<Task["state"], string> = {
  started: MARK.working,
  running: MARK.working,
  done: MARK.ok,
  failed: MARK.attention,
  aborted: MARK.info,
};

const LABEL: Record<Task["state"], string> = {
  started: "starting",
  running: "running",
  done: "done",
  failed: "failed",
  aborted: "aborted",
};

export function statusLine(task: Task, detail?: string): string {
  const head = `${MARK_BY_STATE[task.state]} **Task** \`${shortId(task.id)}\` · ${LABEL[task.state]}`;
  return detail ? `${head}\n${detail}` : head;
}

/** First 8 characters of a task id: enough to match, short enough to read. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** How long something took, for a completion or closing line. */
export function formatDuration(startedAt: number, endedAt: number): string {
  const seconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

/** How long the task took, for the completion line. */
export function duration(task: Task): string {
  return formatDuration(task.startedAt, task.updatedAt);
}

export function milestoneText(event: AgentEvent): string | undefined {
  switch (event.type) {
    case "files-changed": {
      const files = event.files ?? [];
      if (files.length === 0) return undefined;
      const shown = files.slice(0, 5).map((file) => `\`${file}\``).join(", ");
      const more = files.length > 5 ? ` (+${files.length - 5} more)` : "";
      return `${MARK.info} Changed ${files.length} file(s): ${shown}${more}`;
    }
    case "tests-run":
      return event.text ? `${MARK.info} Tests: ${event.text}` : `${MARK.info} Tests run`;
    case "error":
      return `${MARK.attention} Error: ${event.text ?? "unknown"}`;
    default:
      return undefined;
  }
}

export function summaryText(task: Task): string {
  switch (task.state) {
    case "done":
      return `${MARK.ok} **Done** · ${duration(task)}\n\n${task.summary ?? task.prompt}`;
    case "failed":
      return `${MARK.attention} **Failed** · ${duration(task)}\n\n${task.error ?? "unknown error"}`;
    case "aborted":
      return `${MARK.info} **Aborted**\n\n${task.prompt}`;
    default:
      return statusLine(task);
  }
}

/**
 * Signal messages are plain text — there are no buttons to send. The closest
 * thing to "tap an option instead of typing" is a reaction, so an option list is
 * rendered numbered and paired with emoji. These are the six reactions Signal
 * clients put in the quick row, so one tap is enough (no picker hunting); the
 * keycap digits are accepted too for clients that offer them.
 */
export const CHOICE_EMOJI = ["❤️", "👍", "👎", "😂", "😮", "😢"];

const KEYCAPS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];

/** Variation selectors and joiners differ between clients; ignore them. */
function fold(emoji: string): string {
  return emoji.replace(/[\uFE0E\uFE0F\u200D]/g, "");
}

const FOLDED_CHOICE = CHOICE_EMOJI.map(fold);
const FOLDED_KEYCAPS = KEYCAPS.map(fold);

/** The reaction that selects option `index` (1-based), if the row is long enough. */
export function choiceEmoji(index: number): string | undefined {
  return CHOICE_EMOJI[index - 1];
}

/** Which option a tapped reaction selects, or undefined if it is not a choice. */
export function emojiChoice(emoji: string, count: number): number | undefined {
  const tapped = fold(emoji);
  const keycap = FOLDED_KEYCAPS.indexOf(tapped) + 1;
  const index = keycap > 0 ? keycap : FOLDED_CHOICE.indexOf(tapped) + 1;
  return index > 0 && index <= count ? index : undefined;
}

/** Render an option menu for Signal. */
export function choicesText(options: string[], label?: string): string {
  const lines = options.map((option, i) => {
    const emoji = choiceEmoji(i + 1);
    return `${i + 1}. ${emoji ? `${emoji} ` : ""}${option}`;
  });
  return [
    `**${label ?? "Options"}** — tap a reaction or reply with the number:`,
    ...lines,
  ].join("\n");
}
