import { describe, expect, it } from "vitest";
import { base64ToInt16 } from "../voice/pcm.js";
import {
  ADMISSION_EXPRESSION,
  AVATAR_GLOBAL,
  buildAvatarScript,
  FACE_COLOURS,
  guestNameScript,
  JOIN_CLICK_EXPRESSION,
  LIVENESS_EXPRESSION,
  setStateExpression,
  TAKE_PCM_EXPRESSION,
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

/** A canvas just real enough for the face's one draw call. */
function canvasStub() {
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
  };
}

interface FakeProcessor {
  onaudioprocess: ((event: unknown) => void) | null;
  connect: () => void;
}

interface FakeSource {
  connected: number;
  disconnected: number;
  connect: () => void;
  disconnect: () => void;
}

/** An audio track that a test can end, as a browser's remote track can. */
function fakeAudioTrack() {
  const handlers: Record<string, (() => void)[]> = {};
  return {
    kind: "audio",
    addEventListener: (type: string, fn: () => void) => {
      (handlers[type] ||= []).push(fn);
    },
    end: () => {
      for (const fn of handlers["ended"] ?? []) fn();
    },
  };
}

/**
 * A page with a stub RTCPeerConnection and a fake Web Audio graph, so the
 * injected script's audio hook can be driven without a browser.
 */
function hearingPage() {
  const processors: FakeProcessor[] = [];
  const sources: FakeSource[] = [];
  class FakeAudioContext {
    sampleRate = 48_000;
    destination = {};
    createMediaStreamSource() {
      const source: FakeSource = {
        connected: 0,
        disconnected: 0,
        connect: () => {
          source.connected += 1;
        },
        disconnect: () => {
          source.disconnected += 1;
        },
      };
      sources.push(source);
      return source;
    }
    createScriptProcessor() {
      const processor: FakeProcessor = { onaudioprocess: null, connect: () => undefined };
      processors.push(processor);
      return processor;
    }
    createGain() {
      return { gain: { value: 1 }, connect: () => undefined };
    }
    createMediaStreamDestination() {
      return { stream: { getAudioTracks: () => [] } };
    }
  }
  class FakePeerConnection {
    private readonly listeners: Record<string, ((event: unknown) => void)[]> = {};
    addEventListener(type: string, fn: (event: unknown) => void) {
      (this.listeners[type] ||= []).push(fn);
    }
    dispatch(type: string, event: unknown) {
      for (const fn of this.listeners[type] ?? []) fn(event);
    }
  }
  const document = {
    createElement: canvasStub,
    body: { appendChild: () => undefined },
  };
  const navigator = { mediaDevices: { getUserMedia: async () => ({}) } };
  const window: Record<string, unknown> = {
    AudioContext: FakeAudioContext,
    RTCPeerConnection: FakePeerConnection,
    MediaStream: class {
      constructor(readonly tracks: unknown[]) {}
    },
  };
  new Function("window", "document", "navigator", buildAvatarScript())(
    window,
    document,
    navigator,
  );
  return { window, processors, sources, FakePeerConnection };
}

describe("the room's audio hook", () => {
  it("copies a remote track, downsamples to 16 kHz and exposes a pump", () => {
    const { window, processors } = hearingPage();
    const avatar = window[AVATAR_GLOBAL] as {
      takePcm(): { pcm: string; rms: number; active: boolean };
      hearing(): { active: boolean; level: number };
    };
    // Nothing has been heard yet.
    expect(avatar.takePcm()).toEqual({ pcm: "", rms: 0, active: false });
    expect(avatar.hearing().active).toBe(false);

    const pc = new (window.RTCPeerConnection as new () => {
      dispatch(type: string, event: unknown): void;
    })();
    pc.dispatch("track", { track: { kind: "audio", readyState: "live" }, streams: [] });
    expect(processors).toHaveLength(1);
    expect(avatar.hearing().active).toBe(true);

    // 4096 frames at 48 kHz is 1365 samples at 16 kHz.
    const input = new Float32Array(4096).fill(0.5);
    processors[0]!.onaudioprocess!({ inputBuffer: { getChannelData: () => input } });

    const frame = avatar.takePcm();
    expect(frame.active).toBe(true);
    expect(frame.rms).toBeCloseTo(0.5, 3);
    const samples = base64ToInt16(frame.pcm);
    expect(samples.length).toBe(1365);
    expect(samples[0]).toBe(Math.round(0.5 * 32767));

    // Draining resets the pump: the same audio is not sent twice.
    expect(avatar.takePcm().pcm).toBe("");
    expect(avatar.hearing().level).toBeCloseTo(0.5, 3);
  });

  it("feeds every audio track into one processor and re-attaches after a track ends", () => {
    const { window, processors, sources } = hearingPage();
    const pc = new (window.RTCPeerConnection as new () => {
      dispatch(type: string, event: unknown): void;
    })();

    // A video track is not audio and is left alone.
    pc.dispatch("track", { track: { kind: "video" }, streams: [] });
    expect(sources).toHaveLength(0);

    const first = fakeAudioTrack();
    const second = fakeAudioTrack();
    pc.dispatch("track", { track: first, streams: [] });
    pc.dispatch("track", { track: second, streams: [] });
    // One shared processor, but both remote tracks are captured.
    expect(processors).toHaveLength(1);
    expect(sources).toHaveLength(2);
    expect(sources.every((source) => source.connected === 1)).toBe(true);

    // A track that ends frees its slot, so its replacement is heard too.
    first.end();
    expect(sources[0]!.disconnected).toBe(1);
    const third = fakeAudioTrack();
    pc.dispatch("track", { track: third, streams: [] });
    expect(sources).toHaveLength(3);
    expect(sources[2]!.connected).toBe(1);
    expect(processors).toHaveLength(1);
  });

  it("clips samples outside the Int16 range instead of wrapping", () => {
    const { window, processors } = hearingPage();
    const pc = new (window.RTCPeerConnection as new () => {
      dispatch(type: string, event: unknown): void;
    })();
    pc.dispatch("track", { track: { kind: "audio" }, streams: [] });
    processors[0]!.onaudioprocess!({
      inputBuffer: { getChannelData: () => new Float32Array(480).fill(3) },
    });
    const avatar = window[AVATAR_GLOBAL] as { takePcm(): { pcm: string } };
    const samples = base64ToInt16(avatar.takePcm().pcm);
    expect([...samples]).toEqual(new Array(samples.length).fill(32767));
  });
});

describe("TAKE_PCM_EXPRESSION", () => {
  const run = (window: unknown) =>
    (new Function("window", `return ${TAKE_PCM_EXPRESSION};`) as (w: unknown) => {
      pcm: string;
      rms: number;
      active: boolean;
    })(window);

  it("returns an empty frame when there is no avatar", () => {
    expect(run({})).toEqual({ pcm: "", rms: 0, active: false });
  });

  it("hands back whatever the page's pump collected", () => {
    const frame = { pcm: "AAA=", rms: 0.2, active: true };
    expect(run({ [AVATAR_GLOBAL]: { takePcm: () => frame } })).toEqual(frame);
  });

  it("survives a pump that throws", () => {
    const window = {
      [AVATAR_GLOBAL]: {
        takePcm: () => {
          throw new Error("no audio context");
        },
      },
    };
    expect(run(window)).toEqual({ pcm: "", rms: 0, active: false });
  });
});
