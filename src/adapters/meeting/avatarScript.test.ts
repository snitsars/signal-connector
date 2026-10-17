import { describe, expect, it } from "vitest";
import {
  ADMISSION_EXPRESSION,
  AVATAR_GLOBAL,
  buildAvatarScript,
  FACE_COLOURS,
  guestNameScript,
  JOIN_CLICK_EXPRESSION,
  LIVENESS_EXPRESSION,
  setStateExpression,
} from "./avatarScript.js";

describe("buildAvatarScript", () => {
  it("publishes a canvas as the camera without asking for a device", () => {
    const script = buildAvatarScript();
    expect(script).toContain("captureStream(0)");
    expect(script).toContain("getUserMedia");
    expect(script).toContain("getVideoTracks");
    expect(script).toContain(AVATAR_GLOBAL);
  });

  it("draws the three connector states in their colours", () => {
    const script = buildAvatarScript();
    expect(FACE_COLOURS.joining).toBe("#2563eb");
    expect(FACE_COLOURS["in-room"]).toBe("#16a34a");
    expect(FACE_COLOURS.failed).toBe("#dc2626");
    // No dead fourth colour: the face is gone before "left" could be painted.
    expect(Object.keys(FACE_COLOURS)).toEqual(["joining", "in-room", "failed"]);
    expect(script).toContain(JSON.stringify(FACE_COLOURS));
  });

  it("does not animate: state changes alone repaint the face", () => {
    const script = buildAvatarScript();
    expect(script).not.toMatch(/requestAnimationFrame/);
    expect(script).not.toMatch(/setInterval|setTimeout/);
  });

  it("publishes a liveness flag the connector can check", () => {
    const script = buildAvatarScript();
    expect(script).toContain("liveness:");
    expect(script).toContain("requestFrame");

    const liveness = new Function("window", `return ${LIVENESS_EXPRESSION};`) as (
      w: unknown,
    ) => { present: boolean; publishing: boolean };
    // No page: absent rather than a crash.
    expect(liveness({})).toEqual({ present: false, publishing: false, state: "none" });
  });

  it("installs a working camera and microphone override, touching no device", async () => {
    const frames: number[] = [];
    const videoTrack = {
      kind: "video",
      readyState: "live",
      requestFrame: () => frames.push(1),
      addEventListener: () => undefined,
    };
    const audioTrack = { kind: "audio", readyState: "live" };
    const stream = {
      tracks: [videoTrack] as unknown[],
      getVideoTracks: () => [videoTrack],
      getAudioTracks: () => stream.tracks.filter((track) => track === audioTrack),
      addTrack: (track: unknown) => stream.tracks.push(track),
    };
    const canvas = () => {
      return {
        width: 0,
        height: 0,
        style: { cssText: "" },
        setAttribute: () => undefined,
        getContext: () => ({
          fillStyle: "",
          strokeStyle: "",
          lineWidth: 0,
          lineCap: "",
          fillRect() {},
          beginPath() {},
          arc() {},
          fill() {},
          moveTo() {},
          lineTo() {},
          stroke() {},
        }),
        captureStream: () => stream,
      };
    };
    const doc = {
      createElement: canvas,
      body: { appendChild: () => undefined },
    };
    const calls: unknown[] = [];
    const original = async (constraints: unknown) => {
      calls.push(constraints);
      return { audio: true };
    };
    const nav = { mediaDevices: { getUserMedia: original } };
    /** The synthetic microphone: a destination nobody feeds, so its track is silence. */
    class FakeAudioContext {
      createMediaStreamDestination() {
        return { stream: { getAudioTracks: () => [audioTrack] } };
      }
    }
    const win: Record<string, unknown> = { AudioContext: FakeAudioContext };

    new Function("window", "document", "navigator", buildAvatarScript())(win, doc, nav);

    const avatar = win[AVATAR_GLOBAL] as {
      setState(state: string): void;
      state(): string;
      liveness(): { publishing: boolean; state: string };
    };
    expect(avatar.liveness()).toEqual({ publishing: false, state: "joining" });

    // A camera request is answered by the canvas, plus a silent synthetic track.
    const combined = (await nav.mediaDevices.getUserMedia({ video: true, audio: true })) as {
      getVideoTracks(): unknown[];
      getAudioTracks(): unknown[];
    };
    expect(combined.getVideoTracks()).toHaveLength(1);
    expect(combined.getAudioTracks()).toHaveLength(1);
    expect(calls).toHaveLength(0);
    expect(avatar.liveness().publishing).toBe(true);

    // An audio-only request gets the silent stream too: the machine's microphone
    // is never opened, so the room cannot listen to this room.
    const audioOnly = (await nav.mediaDevices.getUserMedia({ audio: true })) as {
      getAudioTracks(): unknown[];
    };
    expect(audioOnly.getAudioTracks()).toHaveLength(1);
    expect(calls).toHaveLength(0);

    avatar.setState("failed");
    expect(avatar.state()).toBe("failed");
    expect(frames.length).toBeGreaterThan(0);
  });
});

describe("setStateExpression", () => {
  it("calls the injected setState with a quoted state", () => {
    expect(setStateExpression("in-room")).toBe(
      `(() => {
    const avatar = window.${AVATAR_GLOBAL};
    if (avatar && typeof avatar.setState === "function") avatar.setState("in-room");
  })()`,
    );
  });

  it("drives an injected face through every state", () => {
    const calls: string[] = [];
    const window = { [AVATAR_GLOBAL]: { setState: (state: string) => calls.push(state) } };
    const run = new Function("window", setStateExpression("failed")) as (w: unknown) => void;
    run(window);
    run(window);
    expect(calls).toEqual(["failed", "failed"]);
  });
});

describe("guestNameScript", () => {
  it("pre-fills the project's name and then stops looking", () => {
    const script = guestNameScript("demo");
    expect(script).toContain('const NAME = "demo"');
    expect(script).toContain("clearInterval");
    expect(script).toContain('aria-label*="name"');
  });

  it("escapes a name that tries to break out of the string", () => {
    const script = guestNameScript('a"b</script>\n(c)');
    expect(script).toContain('const NAME = "a\\"b</script>\\n(c)"');
    expect(script.split("\n").length).toBeGreaterThan(1);
  });
});

describe("JOIN_CLICK_EXPRESSION", () => {
  const click = (page: unknown) =>
    (new Function("document", `return ${JOIN_CLICK_EXPRESSION};`) as (
      doc: unknown,
    ) => { found: boolean; clicked: boolean })(page);

  it("clicks the room's own join control", () => {
    let clicks = 0;
    const control = {
      disabled: false,
      textContent: "Ask to join",
      getAttribute: () => null,
      click: () => {
        clicks += 1;
      },
    };
    expect(click({ querySelectorAll: () => [control] })).toEqual({
      found: true,
      clicked: true,
    });
    expect(clicks).toBe(1);
  });

  it("reports when the page offers no join control", () => {
    expect(click({ querySelectorAll: () => [] })).toEqual({ found: false, clicked: false });
  });

  it("finds a disabled control but does not click it", () => {
    let clicks = 0;
    const control = {
      disabled: true,
      textContent: "Ask to join",
      getAttribute: () => null,
      click: () => {
        clicks += 1;
      },
    };
    expect(click({ querySelectorAll: () => [control] })).toEqual({
      found: true,
      clicked: false,
    });
    expect(clicks).toBe(0);
  });
});

describe("ADMISSION_EXPRESSION", () => {
  it("is a self-contained page probe", () => {
    expect(ADMISSION_EXPRESSION).toContain("in-room");
    expect(ADMISSION_EXPRESSION).toContain("joining");
    expect(ADMISSION_EXPRESSION).toContain("ended");
    expect(ADMISSION_EXPRESSION).toContain("unknown");
  });

  it("returns unknown on a page with no matching markup", () => {
    const run = new Function("document", `return ${ADMISSION_EXPRESSION};`) as (
      page: unknown,
    ) => string;
    // A document with no matching markup.
    const page = {
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    expect(run(page)).toBe("unknown");
  });
});
