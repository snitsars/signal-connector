/**
 * Signal supports styled text: bold, italic, monospace, strikethrough, spoiler.
 * Messages are written with a tiny markup and rendered into plain text plus the
 * style ranges Signal expects. Offsets are UTF-16 code units, which is what
 * signal-cli's `start:length:STYLE` wants (and what JS string indices are).
 */

export type TextStyleName = "BOLD" | "ITALIC" | "MONOSPACE" | "STRIKETHROUGH" | "SPOILER";

export interface StyleRange {
  start: number;
  length: number;
  style: TextStyleName;
}

export interface StyledText {
  text: string;
  styles: StyleRange[];
}

const MARKERS: { marker: string; style: TextStyleName }[] = [
  { marker: "**", style: "BOLD" },
  { marker: "`", style: "MONOSPACE" },
  { marker: "~~", style: "STRIKETHROUGH" },
  { marker: "||", style: "SPOILER" },
  { marker: "__", style: "ITALIC" },
];

/** Unclosed markers stay literal, so a stray `*` never eats the message. */
export function renderStyled(markup: string): StyledText {
  let text = "";
  const styles: StyleRange[] = [];
  let index = 0;

  while (index < markup.length) {
    const hit = MARKERS.find((entry) => markup.startsWith(entry.marker, index));
    if (!hit) {
      text += markup[index];
      index += 1;
      continue;
    }
    const end = markup.indexOf(hit.marker, index + hit.marker.length);
    if (end < 0) {
      text += markup[index];
      index += 1;
      continue;
    }
    const inner = markup.slice(index + hit.marker.length, end);
    if (inner.length > 0) {
      styles.push({ start: text.length, length: inner.length, style: hit.style });
    }
    text += inner;
    index = end + hit.marker.length;
  }

  return { text, styles };
}

/** signal-cli's wire form for one style range. */
export function styleParam(range: StyleRange): string {
  return `${range.start}:${range.length}:${range.style}`;
}
