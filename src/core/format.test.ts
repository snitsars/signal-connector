import { describe, expect, it } from "vitest";
import { renderStyled, splitStyled, styleParam } from "./format.js";

describe("renderStyled", () => {
  it("renders bold, monospace, strikethrough and spoiler with correct offsets", () => {
    expect(renderStyled("**Done** · `a1b2c3` in 12s")).toEqual({
      text: "Done · a1b2c3 in 12s",
      styles: [
        { start: 0, length: 4, style: "BOLD" },
        { start: 7, length: 6, style: "MONOSPACE" },
      ],
    });
  });

  it("keeps unclosed markers literal", () => {
    expect(renderStyled("2 * 3 = 6 and `open")).toEqual({
      text: "2 * 3 = 6 and `open",
      styles: [],
    });
  });

  it("handles markers at the start, end and adjacent to each other", () => {
    expect(renderStyled("**a**`b`").styles).toEqual([
      { start: 0, length: 1, style: "BOLD" },
      { start: 1, length: 1, style: "MONOSPACE" },
    ]);
    expect(renderStyled("**a**").text).toBe("a");
  });

  it("ignores empty markers", () => {
    expect(renderStyled("****")).toEqual({ text: "", styles: [] });
  });

  it("uses UTF-16 offsets, as signal-cli expects", () => {
    const rendered = renderStyled("🎉 **done**");
    expect(rendered.styles).toEqual([{ start: 3, length: 4, style: "BOLD" }]);
  });
});

describe("styleParam", () => {
  it("formats a range the way signal-cli wants it", () => {
    expect(styleParam({ start: 0, length: 4, style: "BOLD" })).toBe("0:4:BOLD");
  });
});

describe("splitStyled", () => {
  const withoutMarkers = (parts: { text: string }[]): string =>
    parts.map((part) => part.text.replace(/^\(\d+\/\d+\) /, "")).join("");

  it("leaves text that fits alone", () => {
    const styles = [{ start: 0, length: 4, style: "BOLD" as const }];
    expect(splitStyled("Done · 12s", styles, 100)).toEqual([{ text: "Done · 12s", styles }]);
  });

  it("cuts a long answer into numbered parts that keep every character", () => {
    const text = Array.from({ length: 60 }, (_, i) => `line ${i} of a long report`).join("\n");
    const parts = splitStyled(text, [], 200);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]!.text.startsWith("(1/" + parts.length + ") ")).toBe(true);
    expect(withoutMarkers(parts)).toBe(text);
    // Signal's rejection is about length, so no part may exceed the limit.
    for (const part of parts) expect(part.text.length).toBeLessThanOrEqual(200);
  });

  it("rebases style ranges onto the part that holds them", () => {
    const text = `plain ${"x".repeat(200)} **bold bit** tail`;
    const styled = renderStyled(text);
    const parts = splitStyled(styled.text, styled.styles, 120);

    const bolded = parts.flatMap((part) =>
      part.styles.map((s) => part.text.slice(s.start, s.start + s.length)),
    );
    expect(bolded).toEqual(["bold bit"]);
  });

  it("never cuts a surrogate pair in half", () => {
    const text = "🎉".repeat(80);
    const parts = splitStyled(text, [], 40);

    expect(parts.length).toBeGreaterThan(1);
    expect(withoutMarkers(parts)).toBe(text);
    for (const part of parts) {
      const body = part.text.replace(/^\(\d+\/\d+\) /, "");
      expect(isHighSurrogate(body.charCodeAt(body.length - 1))).toBe(false);
    }
  });

  it("prefers a line break over cutting mid-sentence", () => {
    const text = `${"a".repeat(50)}\n${"b".repeat(50)}`;
    const parts = splitStyled(text, [], 60);

    expect(parts).toHaveLength(2);
    expect(parts[0]!.text.endsWith("a\n")).toBe(true);
    expect(parts[1]!.text.endsWith("b".repeat(50))).toBe(true);
  });
});

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
