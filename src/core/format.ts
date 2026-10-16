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

/**
 * Signal refuses very long text: signal-cli turns it into a "long text
 * attachment" and the server rejects the send, which is how long reports
 * disappeared without a trace. Text past this many characters is therefore cut
 * into numbered parts.
 */
export const MESSAGE_PART_LIMIT = 1500;

/** Room for a `(12/34) ` prefix so a part never grows past the limit. */
const MARKER_RESERVE = 10;

export interface StyledPart {
  text: string;
  styles: StyleRange[];
}

/**
 * Cut styled text into parts Signal will accept, numbering each part and
 * rebasing its style ranges onto that part, so bold or monospace runs survive
 * the cut. Text that already fits is returned untouched.
 */
export function splitStyled(
  text: string,
  styles: StyleRange[] = [],
  limit = MESSAGE_PART_LIMIT,
): StyledPart[] {
  if (text.length <= limit) return [{ text, styles }];

  const ranges = cutRanges(text, Math.max(1, limit - MARKER_RESERVE));
  const count = ranges.length;
  return ranges.map(([start, end], index) => {
    const marker = `(${index + 1}/${count}) `;
    return {
      text: marker + text.slice(start, end),
      styles: styles
        .filter((s) => s.start < end && s.start + s.length > start)
        .map((s) => {
          const from = Math.max(s.start, start);
          const to = Math.min(s.start + s.length, end);
          return { start: from - start + marker.length, length: to - from, style: s.style };
        }),
    };
  });
}

/**
 * Half-open [start, end) ranges covering the text, each at most `budget`
 * characters and preferring a paragraph, line or space boundary. A surrogate
 * pair is never cut in half: a split emoji arrives as a broken glyph.
 */
function cutRanges(text: string, budget: number): [number, number][] {
  const ranges: [number, number][] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + budget);
    if (end < text.length) {
      // One character past the budget too, so a break that lands exactly on the
      // boundary is still seen instead of being cut through.
      const window = text.slice(start, Math.min(text.length, end + 1));
      const boundary = Math.max(
        window.lastIndexOf("\n\n") + 2,
        window.lastIndexOf("\n") + 1,
        window.lastIndexOf(" ") + 1,
      );
      if (boundary > budget * 0.5) end = start + boundary;
      if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
    }
    ranges.push([start, end]);
    start = end;
  }
  return ranges;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

