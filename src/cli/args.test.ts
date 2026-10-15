import { describe, expect, it } from "vitest";
import { parseArgs, USAGE } from "./args.js";

describe("parseArgs", () => {
  it("runs the daemon when given no arguments", () => {
    expect(parseArgs([])).toBe("daemon");
  });

  it("answers --version and its short form", () => {
    expect(parseArgs(["--version"])).toBe("version");
    expect(parseArgs(["-v"])).toBe("version");
  });

  it("answers --help and its short form", () => {
    expect(parseArgs(["--help"])).toBe("help");
    expect(parseArgs(["-h"])).toBe("help");
  });

  it("treats anything else as a usage error", () => {
    expect(parseArgs(["--nope"])).toBe("usage");
    expect(parseArgs(["start"])).toBe("usage");
    expect(parseArgs(["--port", "8080"])).toBe("usage");
  });

  it("lets the first argument win", () => {
    expect(parseArgs(["--version", "--help"])).toBe("version");
    expect(parseArgs(["--help", "--version"])).toBe("help");
  });

  it("documented usage names the command and its three modes", () => {
    expect(USAGE).toContain("signal-connector");
    expect(USAGE).toContain("--version");
    expect(USAGE).toContain("--help");
    expect(USAGE).toContain("default");
  });
});
