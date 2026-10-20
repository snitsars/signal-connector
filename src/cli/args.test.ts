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

  it("recognises the doctor and setup modes", () => {
    expect(parseArgs(["doctor"])).toBe("doctor");
    expect(parseArgs(["setup"])).toBe("setup");
  });

  it("rejects trailing arguments to doctor and setup", () => {
    expect(parseArgs(["setup", "--help"])).toBe("usage");
    expect(parseArgs(["doctor", "extra"])).toBe("usage");
    expect(parseArgs(["doctor", "-v"])).toBe("usage");
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

  it("documented usage names the command and its modes", () => {
    expect(USAGE).toContain("signal-connector");
    expect(USAGE).toContain("--version");
    expect(USAGE).toContain("--help");
    expect(USAGE).toContain("doctor");
    expect(USAGE).toContain("setup");
    expect(USAGE).toContain("default");
  });
});
