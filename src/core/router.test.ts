import { describe, expect, it } from "vitest";
import { parseInput } from "./router.js";

describe("parseInput", () => {
  it("parses a slash command with args", () => {
    expect(parseInput("/use demo")).toEqual({ kind: "command", name: "use", args: "demo" });
  });

  it("maps /approve and /deny to decisions", () => {
    expect(parseInput("/approve")).toEqual({ kind: "approval", decision: "once" });
    expect(parseInput("/deny")).toEqual({ kind: "approval", decision: "reject" });
  });

  it("maps bare keywords to decisions", () => {
    expect(parseInput("yes")).toEqual({ kind: "approval", decision: "once" });
    expect(parseInput("always")).toEqual({ kind: "approval", decision: "always" });
  });

  it("accepts the wording clients use in the approval dialog", () => {
    expect(parseInput("Allow")).toEqual({ kind: "approval", decision: "once" });
    expect(parseInput("Allow once")).toEqual({ kind: "approval", decision: "once" });
    expect(parseInput("Approve always")).toEqual({ kind: "approval", decision: "always" });
    expect(parseInput("Always allow")).toEqual({ kind: "approval", decision: "always" });
    expect(parseInput("always.")).toEqual({ kind: "approval", decision: "always" });
    expect(parseInput("Reject")).toEqual({ kind: "approval", decision: "reject" });
  });

  it("keeps unrelated text a prompt", () => {
    expect(parseInput("allow me to explain the plan")).toEqual({
      kind: "prompt",
      text: "allow me to explain the plan",
    });
  });

  it("treats other text as a prompt", () => {
    expect(parseInput("add a retry to the client")).toEqual({
      kind: "prompt",
      text: "add a retry to the client",
    });
  });

  it("keeps an unknown slash command as a command", () => {
    expect(parseInput("/bogus x")).toEqual({ kind: "command", name: "bogus", args: "x" });
  });
});
