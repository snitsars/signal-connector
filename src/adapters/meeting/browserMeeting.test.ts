import { describe, expect, it } from "vitest";
import { admissionStep, browserArguments } from "./browserMeeting.js";

describe("browserArguments", () => {
  it("starts on about:blank so the media override exists before the room", () => {
    const args = browserArguments("C:\\data\\meeting-profile");
    expect(args.at(-1)).toBe("about:blank");
    expect(args.some((argument) => /^https?:/i.test(argument))).toBe(false);
    expect(args).toContain("--incognito");
    expect(args).toContain("--remote-debugging-port=0");
    expect(args).toContain("--user-data-dir=C:\\data\\meeting-profile");
  });
});

describe("admissionStep", () => {
  const budgetSeconds = 90;

  it("admits only when the page itself says in-room", () => {
    expect(
      admissionStep({ admission: "in-room", publishing: false, expired: false, budgetSeconds }),
    ).toEqual({ kind: "in-room" });
  });

  it("does not treat a publishing canvas as admission", () => {
    // The pre-join preview publishes the face too, so publishing alone is not proof.
    expect(
      admissionStep({ admission: "joining", publishing: true, expired: false, budgetSeconds }),
    ).toEqual({ kind: "wait" });
    expect(
      admissionStep({ admission: "unknown", publishing: true, expired: false, budgetSeconds }),
    ).toEqual({ kind: "wait" });
  });

  it("keeps waiting while the budget runs", () => {
    expect(
      admissionStep({ admission: "unknown", publishing: false, expired: false, budgetSeconds }),
    ).toEqual({ kind: "wait" });
  });

  it("ends an unverified join when the budget runs out, with the reason", () => {
    expect(
      admissionStep({ admission: "joining", publishing: true, expired: true, budgetSeconds }),
    ).toEqual({
      kind: "failed",
      detail: "the room never confirmed the avatar's admission within 90 s",
    });
    expect(
      admissionStep({ admission: "unknown", publishing: false, expired: true, budgetSeconds }),
    ).toEqual({
      kind: "failed",
      detail: "nobody admitted the avatar within 90 s",
    });
  });
});
