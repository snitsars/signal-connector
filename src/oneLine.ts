/**
 * Collapse any error or message to one printable line. Every CLI report is one
 * line, and an OS error can otherwise carry a stack or a multi-line shell dump.
 * An empty message still names something, so a line never disappears.
 */
export function oneLine(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text.replace(/\s*\r?\n\s*/g, " ").trim() || "unknown error";
}
