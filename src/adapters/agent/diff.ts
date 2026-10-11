/**
 * Diff helpers for result delivery (ticket 5.4).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface FileDiff {
  file: string;
  patch: string;
  additions?: number;
  deletions?: number;
  status?: string;
}

export function combineDiffs(diffs: FileDiff[]): string {
  return diffs.map((d) => `--- ${d.file}\n${d.patch}`).join("\n\n");
}

export function writeDiffFile(patch: string): string {
  const file = path.join(os.tmpdir(), `signalconnector-diff-${Date.now()}.patch`);
  fs.writeFileSync(file, patch, "utf8");
  return file;
}
