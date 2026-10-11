import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { combineDiffs, writeDiffFile } from "./diff.js";

describe("diff helpers", () => {
  it("combines file diffs into one patch", () => {
    const patch = combineDiffs([
      { file: "a.ts", patch: "@@ -1 +1 @@\n-a\n+b" },
      { file: "b.ts", patch: "@@ -1 +1 @@\n-c\n+d" },
    ]);
    expect(patch).toContain("--- a.ts");
    expect(patch).toContain("--- b.ts");
  });

  it("writes a patch file and returns its path", () => {
    const file = writeDiffFile("--- x\n@@ -1 +1 @@\n-a\n+b");
    expect(file.endsWith(".patch")).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain("@@ -1 +1 @@");
    fs.unlinkSync(file);
  });
});
