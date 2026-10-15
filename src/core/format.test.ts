import { describe, expect, it } from "vitest";
import { renderStyled, styleParam } from "./format.js";

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
