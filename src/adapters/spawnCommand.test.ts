import { describe, expect, it } from "vitest";
import { resolveCommand } from "./spawnCommand.js";

describe("resolveCommand", () => {
  it("runs a bare name through the shell on Windows and quotes spaced args", () => {
    expect(
      resolveCommand("opencode", ["run", "--format", "json", "--", "add a retry"], "win32"),
    ).toEqual({
      command: 'opencode run --format json -- "add a retry"',
      args: [],
      shell: true,
    });
  });

  it("runs a .bat script through the shell on Windows", () => {
    const resolved = resolveCommand("C:\\tools\\signal-cli.bat", ["daemon", "--http", "127.0.0.1:8080"], "win32");
    expect(resolved.shell).toBe(true);
    expect(resolved.command).toContain("signal-cli.bat");
    expect(resolved.command).toContain("daemon --http 127.0.0.1:8080");
  });

  it("execs a full .exe path directly on Windows", () => {
    expect(resolveCommand("C:\\tools\\opencode.exe", ["serve"], "win32")).toEqual({
      command: "C:\\tools\\opencode.exe",
      args: ["serve"],
      shell: false,
    });
  });

  it("passes through untouched on non-Windows", () => {
    expect(resolveCommand("opencode", ["run", "add a retry"], "linux")).toEqual({
      command: "opencode",
      args: ["run", "add a retry"],
      shell: false,
    });
  });
});
