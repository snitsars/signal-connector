import { describe, expect, it } from "vitest";
import { base64ToInt16 } from "../voice/pcm.js";
import {
  ADMISSION_EXPRESSION,
  AUDIO_STATE_EXPRESSION,
  AVATAR_GLOBAL,
  buildAvatarScript,
  FACE_COLOURS,
  guestNameScript,
  JOIN_CLICK_EXPRESSION,
  LIVENESS_EXPRESSION,
  PRESENCE_EXPRESSION,
  setMoodExpression,
  setStateExpression,
  SPEECH_STATE_EXPRESSION,
  speakExpression,
  STOP_SPEAKING_EXPRESSION,
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
    expect(script).toMatch(/setInterval/);
    for (const mood of ["listening", "thinking", "reading", "writing"]) {
      expect(script).toContain(mood);
    }
    expect(script).toContain("setMood");
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

  it("clicks a provider's own pre-join button (Jitsi says \"Join meeting\")", () => {
    let clicks = 0;
    const control = {
      disabled: false,
      textContent: "Join meeting",
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
  const run = new Function("document", `return ${ADMISSION_EXPRESSION};`) as (
    page: unknown,
  ) => string;
  const page = (text: string, buttons: Array<{ text?: string; label?: string }> = []) => ({
    body: { innerText: text },
    querySelector: () => null,
    querySelectorAll: () =>
      buttons.map((b) => ({
        textContent: b.text ?? "",
        getAttribute: (name: string) => (name === "aria-label" ? (b.label ?? "") : null),
      })),
  });

  it("is a self-contained page probe", () => {
    expect(ADMISSION_EXPRESSION).toContain("in-room");
    expect(ADMISSION_EXPRESSION).toContain("joining");
    expect(ADMISSION_EXPRESSION).toContain("ended");
    expect(ADMISSION_EXPRESSION).toContain("unknown");
  });

  it("returns unknown on a page with no matching markup", () => {
    expect(run(page(""))).toBe("unknown");
  });

  it("reads a queued knock as the lobby, not as the end", () => {
    // Google Meet's waiting room says this and offers "Return to home screen";
    // treating that button as an ending killed the room seconds after joining.
    expect(run(page("Asking to be let in…\nReturn to home screen"))).toBe("joining");
  });

  it("reads an unambiguous ending as ended even with the lobby's button present", () => {
    expect(run(page("You left the call\nRejoin\nReturn to home screen"))).toBe("ended");
  });

  it("admits only the call's own leave control", () => {    expect(run(page("", [{ label: "Leave call" }]))).toBe("in-room");
    // Jitsi's wording carries "the"; missing it left the avatar stuck outside.
    expect(run(page("", [{ label: "Leave the call" }]))).toBe("in-room");
    expect(run(page("", [{ label: "Leave the meeting" }]))).toBe("in-room");
  });

  it("does not mistake Jitsi's pre-join back button for the room", () => {
    // The pre-join screen offers "Join meeting" and also a "Leave the meeting"
    // back arrow; the avatar was latched as in-room and never clicked join.
    const prejoin = page("Join meeting\nYour devices are working properly", [
      { label: "Join meeting", text: "Join meeting" },
      { label: "Leave the meeting" },
    ]);
    expect(run(prejoin)).toBe("joining");
  });

  it("names a hard refusal instead of waiting for a knock that cannot come", () => {
    expect(run(page("You can't join this video call\nReturn to home screen"))).toBe("refused");
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

/** A decoded-clip source, just real enough for the playback path. */
interface FakeBufferSource {
  buffer: unknown;
  connected: unknown;
  started: number;
  stopped: number;
  onended: (() => void) | null;
  connect: (destination: unknown) => void;
  start: (when?: number) => void;
  stop: () => void;
  disconnect: () => void;
}

/** A decode a test can hold open, to prove a clip is dropped before it plays. */
interface PendingDecode {
  bytes: number;
  resolve: (buffer: unknown) => void;
  reject: (error: unknown) => void;
}

/** An audio track that a test can end, mute or unmute, as a remote track can. */
function fakeAudioTrack() {
  const handlers: Record<string, (() => void)[]> = {};
  const fire = (type: string) => {
    for (const fn of handlers[type] ?? []) fn();
  };
  return {
    kind: "audio",
    addEventListener: (type: string, fn: () => void) => {
      (handlers[type] ||= []).push(fn);
    },
    end: () => fire("ended"),
    mute: () => fire("mute"),
    unmute: () => fire("unmute"),
  };
}

/**
 * A page with a stub RTCPeerConnection and a fake Web Audio graph, so the
 * injected script's audio hook and its playback path can be driven without a
 * browser. `manualDecode` holds decodeAudioData open until a test resolves it.
 */
function hearingPage(options: { manualDecode?: boolean; suspended?: boolean } = {}) {
  const processors: FakeProcessor[] = [];
  const sources: FakeSource[] = [];
  const bufferSources: FakeBufferSource[] = [];
  const destinations: unknown[] = [];
  const decodes: PendingDecode[] = [];
  const contexts: FakeAudioContext[] = [];
  class FakeAudioContext {
    sampleRate = 48_000;
    destination = { kind: "speakers" };
    state = "running";
    resumed = 0;
    constructor() {
      contexts.push(this);
      if (options.suspended) this.state = "suspended";
    }
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
      const destination = { stream: { getAudioTracks: () => [] } };
      destinations.push(destination);
      return destination;
    }
    resume() {
      this.resumed += 1;
      return Promise.resolve();
    }
    decodeAudioData(
      bytes: ArrayBuffer,
      success?: (buffer: unknown) => void,
      failure?: (error: unknown) => void,
    ): Promise<unknown> {
      if (!options.manualDecode) return Promise.resolve({ frames: bytes.byteLength / 2 });
      return new Promise((resolve, reject) => {
        decodes.push({
          bytes: bytes.byteLength,
          resolve: (buffer) => {
            resolve(buffer);
            success?.(buffer);
          },
          reject: (error) => {
            reject(error);
            failure?.(error);
          },
        });
      });
    }
    createBufferSource() {
      const source: FakeBufferSource = {
        buffer: null,
        connected: undefined,
        started: 0,
        stopped: 0,
        onended: null,
        connect: (destination: unknown) => {
          source.connected = destination;
        },
        start: () => {
          source.started += 1;
        },
        stop: () => {
          source.stopped += 1;
          source.onended?.();
        },
        disconnect: () => undefined,
      };
      bufferSources.push(source);
      return source;
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
  return {
    window,
    processors,
    sources,
    bufferSources,
    destinations,
    decodes,
    contexts,
    FakePeerConnection,
  };
}

/** Let the page's decode/play microtask chain settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** One base64 clip, as the connector would send it. */
const clip = (label = "RIFFfakeWAVE"): string => Buffer.from(label).toString("base64");

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

interface FakeAvatar {
  speak(base64: string): { queued: boolean; speaking: boolean };
  stopSpeaking(): { speaking: boolean; queued: number };
  speech(): { speaking: boolean; queued: number };
}

describe("speaking into the synthetic microphone", () => {
  it("decodes a clip and plays it into the microphone's own destination", async () => {
    const { window, bufferSources, destinations } = hearingPage();
    const avatar = window[AVATAR_GLOBAL] as unknown as FakeAvatar;

    expect(avatar.speech()).toEqual({ speaking: false, queued: 0 });
    expect(avatar.speak(clip())).toEqual({ queued: true, speaking: true });
    // Decoding is asynchronous: the clip starts on a later tick, not now.
    expect(bufferSources).toHaveLength(0);
    await flush();

    expect(destinations).toHaveLength(1);
    expect(bufferSources).toHaveLength(1);
    expect(bufferSources[0]!.started).toBe(1);
    expect(bufferSources[0]!.buffer).not.toBeNull();
    // The very destination the silent track carries, so the room hears it.
    expect(bufferSources[0]!.connected).toBe(destinations[0]);
    expect(avatar.speech()).toEqual({ speaking: true, queued: 0 });
  });

  it("plays queued clips one after another, in order", async () => {
    const { window, bufferSources } = hearingPage();
    const avatar = window[AVATAR_GLOBAL] as unknown as FakeAvatar;

    avatar.speak(clip("first"));
    avatar.speak(clip("second"));
    await flush();
    expect(bufferSources).toHaveLength(1);
    expect(avatar.speech()).toEqual({ speaking: true, queued: 1 });

    // The first clip ends: the waiting one starts and the room is speaking again.
    bufferSources[0]!.onended?.();
    await flush();
    expect(bufferSources).toHaveLength(2);
    expect(bufferSources[1]!.started).toBe(1);
    expect(avatar.speech()).toEqual({ speaking: true, queued: 0 });
  });

  it("stops the clip playing and drops everything queued behind it", async () => {
    const { window, bufferSources } = hearingPage();
    const avatar = window[AVATAR_GLOBAL] as unknown as FakeAvatar;

    avatar.speak(clip("first"));
    avatar.speak(clip("second"));
    await flush();
    expect(bufferSources).toHaveLength(1);

    expect(avatar.stopSpeaking()).toEqual({ speaking: false, queued: 0 });
    expect(bufferSources[0]!.stopped).toBe(1);
    expect(avatar.speech()).toEqual({ speaking: false, queued: 0 });

    // The stopped clip's own end must not revive the queue.
    bufferSources[0]!.onended?.();
    await flush();
    expect(bufferSources).toHaveLength(1);
    expect(bufferSources[0]!.started).toBe(1);
  });

  it("drops a clip that was still decoding when speech stopped", async () => {
    const { window, bufferSources, decodes } = hearingPage({ manualDecode: true });
    const avatar = window[AVATAR_GLOBAL] as unknown as FakeAvatar;

    avatar.speak(clip());
    expect(decodes).toHaveLength(1);
    avatar.stopSpeaking();

    decodes[0]!.resolve({ frames: 2 });
    await flush();
    // The clip never reached a source: the generation check refused it.
    expect(bufferSources).toHaveLength(0);
    expect(avatar.speech()).toEqual({ speaking: false, queued: 0 });
  });

  it("resumes a suspended context on the first clip", async () => {
    const page = hearingPage({ suspended: true });
    const avatar = page.window[AVATAR_GLOBAL] as unknown as FakeAvatar;
    avatar.speak(clip());
    await flush();
    expect(page.contexts).toHaveLength(1);
    expect(page.contexts[0]!.resumed).toBe(1);
    expect(page.bufferSources).toHaveLength(1);
  });
});

describe("speakExpression", () => {
  const run = (window: unknown) =>
    (new Function("window", `return ${speakExpression("AAA=")};`) as (w: unknown) => {
      queued: boolean;
      speaking: boolean;
    })(window);

  it("asks the page to play the clip it is given", () => {
    const calls: string[] = [];
    const window = {
      [AVATAR_GLOBAL]: {
        speak: (base64: string) => {
          calls.push(base64);
          return { queued: true, speaking: true };
        },
      },
    };
    expect(run(window)).toEqual({ queued: true, speaking: true });
    expect(calls).toEqual(["AAA="]);
  });

  it("reports a page with no avatar as unable to speak", () => {
    expect(run({})).toEqual({ queued: false, speaking: false });
  });
});

describe("STOP_SPEAKING_EXPRESSION", () => {
  const run = (window: unknown) =>
    (new Function("window", `return ${STOP_SPEAKING_EXPRESSION};`) as (w: unknown) => {
      speaking: boolean;
      queued: number;
    })(window);

  it("stops the page's speech", () => {
    let stops = 0;
    const window = {
      [AVATAR_GLOBAL]: {
        stopSpeaking: () => {
          stops += 1;
          return { speaking: false, queued: 0 };
        },
      },
    };
    expect(run(window)).toEqual({ speaking: false, queued: 0 });
    expect(stops).toBe(1);
  });

  it("reports silence when there is no avatar", () => {
    expect(run({})).toEqual({ speaking: false, queued: 0 });
  });
});

describe("SPEECH_STATE_EXPRESSION", () => {
  const run = (window: unknown) =>
    (new Function("window", `return ${SPEECH_STATE_EXPRESSION};`) as (w: unknown) => {
      speaking: boolean;
      queued: number;
    })(window);

  it("reports what the page is playing", () => {
    expect(run({ [AVATAR_GLOBAL]: { speech: () => ({ speaking: true, queued: 2 }) } })).toEqual({
      speaking: true,
      queued: 2,
    });
  });

  it("reports silence when there is no avatar or the page throws", () => {
    expect(run({})).toEqual({ speaking: false, queued: 0 });
    expect(
      run({
        [AVATAR_GLOBAL]: {
          speech: () => {
            throw new Error("gone");
          },
        },
      }),
    ).toEqual({ speaking: false, queued: 0 });
  });
});

interface PresenceReading {
  presence: string;
  humans?: number;
}

describe("presence in the room", () => {
  const avatarOf = (page: ReturnType<typeof hearingPage>) =>
    page.window[AVATAR_GLOBAL] as unknown as { presence(): PresenceReading };

  it("counts the humans beside the avatar from Jitsi's member list", () => {
    const page = hearingPage();
    expect(avatarOf(page).presence()).toEqual({ presence: "unknown" });

    page.window.APP = {
      conference: {
        listMembers: () => [
          { id: "human-1", displayName: "+1000" },
        ],
      },
    };
    expect(avatarOf(page).presence()).toEqual({ presence: "someone", humans: 1 });
  });

  it("ignores hidden participants, who are not people in the room", () => {
    const page = hearingPage();
    page.window.APP = {
      conference: {
        listMembers: () => [
          { id: "human-1", displayName: "+1000" },
          { id: "jibri", isHidden: () => true },
        ],
      },
    };
    expect(avatarOf(page).presence()).toEqual({ presence: "someone", humans: 1 });
  });

  it("says nobody when the avatar is the only member", () => {
    const page = hearingPage();
    // listMembers() excludes the local user, so an empty list is an empty room.
    page.window.APP = { conference: { listMembers: () => [] } };
    expect(avatarOf(page).presence()).toEqual({ presence: "nobody", humans: 0 });
  });

  it("is unknown when the page cannot enumerate participants", () => {
    // No provider API at all.
    const page = hearingPage();
    expect(avatarOf(page).presence()).toEqual({ presence: "unknown" });

    // A provider API with no conference, or no member list.
    page.window.APP = {};
    expect(avatarOf(page).presence()).toEqual({ presence: "unknown" });
    page.window.APP = { conference: {} };
    expect(avatarOf(page).presence()).toEqual({ presence: "unknown" });
    page.window.APP = { conference: { listMembers: () => null } };
    expect(avatarOf(page).presence()).toEqual({ presence: "unknown" });

    // A member list that throws is still unknown, never guessed.
    page.window.APP = {
      conference: {
        listMembers: () => {
          throw new Error("conference gone");
        },
      },
    };
    expect(avatarOf(page).presence()).toEqual({ presence: "unknown" });
  });
});

describe("PRESENCE_EXPRESSION", () => {
  const run = (window: unknown) =>
    (new Function("window", `return ${PRESENCE_EXPRESSION};`) as (w: unknown) => PresenceReading)(
      window,
    );

  it("returns unknown when there is no avatar", () => {
    expect(run({})).toEqual({ presence: "unknown" });
  });

  it("returns the presence word and a count, never an identity", () => {
    const page = hearingPage();
    page.window.APP = {
      conference: {
        listMembers: () => [{ id: "human-1", displayName: "+15550001111" }],
      },
    };
    const reading = run(page.window);
    expect(reading).toEqual({ presence: "someone", humans: 1 });
    expect(JSON.stringify(reading)).not.toContain("+15550001111");
  });

  it("survives a presence reader that throws", () => {
    expect(
      run({
        [AVATAR_GLOBAL]: {
          presence: () => {
            throw new Error("gone");
          },
        },
      }),
    ).toEqual({ presence: "unknown" });
  });
});

describe("AUDIO_STATE_EXPRESSION", () => {
  const run = (window: unknown) =>
    (new Function("window", `return ${AUDIO_STATE_EXPRESSION};`) as (w: unknown) => {
      present: boolean;
      active: boolean;
      level: number;
      epoch: number;
    })(window);

  it("reports nothing when there is no avatar", () => {
    expect(run({})).toEqual({ present: false, active: false, level: 0, epoch: 0 });
  });

  it("reports the hook's state without draining the PCM pump", () => {
    const page = hearingPage();
    const avatar = page.window[AVATAR_GLOBAL] as {
      takePcm(): { pcm: string };
    };
    const pc = new (page.window.RTCPeerConnection as new () => {
      dispatch(type: string, event: unknown): void;
    })();
    pc.dispatch("track", { track: fakeAudioTrack(), streams: [] });
    page.processors[0]!.onaudioprocess!({
      inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.25) },
    });

    const reading = run(page.window);
    expect(reading.present).toBe(true);
    expect(reading.active).toBe(true);
    expect(reading.level).toBeCloseTo(0.25, 3);
    expect(reading.epoch).toBe(1);

    // The voice pump still gets the audio: telemetry is a separate read.
    expect(avatar.takePcm().pcm.length).toBeGreaterThan(0);
  });
});

describe("the audio epoch", () => {
  it("changes when a track attaches, is muted, unmuted or ends", () => {
    const page = hearingPage();
    const avatar = page.window[AVATAR_GLOBAL] as { hearing(): { epoch: number } };
    const pc = new (page.window.RTCPeerConnection as new () => {
      dispatch(type: string, event: unknown): void;
    })();
    expect(avatar.hearing().epoch).toBe(0);

    const track = fakeAudioTrack();
    pc.dispatch("track", { track, streams: [] });
    expect(avatar.hearing().epoch).toBe(1);

    track.mute();
    expect(avatar.hearing().epoch).toBe(2);
    track.unmute();
    expect(avatar.hearing().epoch).toBe(3);
    track.end();
    expect(avatar.hearing().epoch).toBe(4);
  });
});

describe("the audio level between reads", () => {
  it("reports the peak since the last read, resets it, and tracks attached sources", () => {
    const page = hearingPage();
    const avatar = page.window[AVATAR_GLOBAL] as {
      hearing(): { active: boolean; level: number };
    };
    const pc = new (page.window.RTCPeerConnection as new () => {
      dispatch(type: string, event: unknown): void;
    })();

    // No remote track yet: a processor that exists is not a live room.
    expect(avatar.hearing()).toEqual({ active: false, level: 0, epoch: 0 });

    const track = fakeAudioTrack();
    pc.dispatch("track", { track, streams: [] });
    expect(avatar.hearing().active).toBe(true);

    // A loud block followed by a quiet one: the loud one must survive the read.
    page.processors[0]!.onaudioprocess!({
      inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.5) },
    });
    page.processors[0]!.onaudioprocess!({
      inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.1) },
    });
    expect(avatar.hearing().level).toBeCloseTo(0.5, 3);
    // Reading the peak clears it, so the next spell starts from silence.
    expect(avatar.hearing().level).toBe(0);

    // A track that ended is no longer a live room, even though the processor lives.
    track.end();
    expect(avatar.hearing().active).toBe(false);
  });
});

describe("setMoodExpression", () => {
  const run = (mood: string, window: unknown) =>
    (new Function("window", `return ${setMoodExpression(mood as never)};`) as (w: unknown) => string)(window);

  it("sets a known mood on the avatar", () => {
    const moods: string[] = [];
    const avatar = { setMood: (m: string) => { moods.push(m); return m; } };
    expect(run("reading", { __signalConnectorAvatar: avatar })).toBe("reading");
    expect(moods).toEqual(["reading"]);
  });

  it("falls back to listening when the page no longer has the avatar", () => {
    expect(run("writing", {})).toBe("listening");
  });
});
