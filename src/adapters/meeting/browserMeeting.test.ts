import { describe, expect, it } from "vitest";
import { nullLogger } from "../../logging/logger.js";
import {
  admissionStep,
  audioStateFrom,
  BrowserMeeting,
  browserArguments,
  presenceFrom,
} from "./browserMeeting.js";

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

describe("speaking without a meeting", () => {
  it("reports silence and refuses a clip when no room is open", async () => {
    const meeting = new BrowserMeeting({ profileDir: ".", logger: nullLogger() });
    expect(await meeting.playAudio("AAA=")).toBe(false);
    expect(await meeting.speechState()).toEqual({ speaking: false, queued: 0 });
    // Stopping silence is a no-op, not an error.
    await meeting.stopAudio();
  });
});

describe("presence and audio readings", () => {
  it("keeps only the three presence words", () => {
    expect(presenceFrom("someone")).toBe("someone");
    expect(presenceFrom("nobody")).toBe("nobody");
    expect(presenceFrom("unknown")).toBe("unknown");
    expect(presenceFrom("a name")).toBe("unknown");
    expect(presenceFrom(undefined)).toBe("unknown");
  });

  it("makes a malformed audio reading harmless", () => {
    expect(audioStateFrom(undefined)).toEqual({ active: false, level: 0, epoch: 0 });
    expect(audioStateFrom({ active: true, level: 0.2, epoch: 3 })).toEqual({
      active: true,
      level: 0.2,
      epoch: 3,
    });
    expect(audioStateFrom({ active: 1, level: "loud", epoch: NaN })).toEqual({
      active: true,
      level: 0,
      epoch: 0,
    });
  });
});
