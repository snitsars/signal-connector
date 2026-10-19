/**
 * The avatar the room sees as its camera.
 *
 * A canvas face is drawn once per state change — no animation loop, because a
 * covered window throttles timers and motion would then be a lie. `setState`
 * repaints in the connector's colours (blue joining, green in the room, red on
 * a problem) and asks the capture track for one frame. The script also replaces
 * `getUserMedia`: video is answered with `canvas.captureStream()` and audio with
 * a silent synthetic track, so the room gets a face and a microphone that never
 * touches the machine's own camera or microphone.
 */
import type { MeetingState } from "../../core/ports.js";

/** The states the face can paint; "left" has no face because the window is gone. */
export type FaceState = Extract<MeetingState, "joining" | "in-room" | "failed">;

/** The face's colours, matching the group message's circles. */
export const FACE_COLOURS: Record<FaceState, string> = {
  joining: "#2563eb",
  "in-room": "#16a34a",
  failed: "#dc2626",
};

/** Where the injected script parks its API on the page. */
export const AVATAR_GLOBAL = "__signalConnectorAvatar";

/**
 * The script injected with `Page.addScriptToEvaluateOnNewDocument`, so it runs
 * before the room's own scripts can ask for a camera.
 */
export function buildAvatarScript(): string {
  return `(() => {
  if (window.${AVATAR_GLOBAL}) return;

  const COLOURS = ${JSON.stringify(FACE_COLOURS)};
  const state = { name: "joining", track: null, live: false, canvas: null, ctx: null, audio: null };

  const ensureCanvas = () => {
    if (state.canvas) return state.canvas;
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    canvas.setAttribute("data-signalconnector-avatar", "1");
    // Present and capturable, but out of the way of the room's own layout.
    canvas.style.cssText = "position:fixed;left:-10000px;top:0;width:640px;height:360px;pointer-events:none;";
    (document.body || document.documentElement).appendChild(canvas);
    state.canvas = canvas;
    state.ctx = canvas.getContext("2d");
    return canvas;
  };

  const draw = () => {
    const canvas = ensureCanvas();
    const ctx = state.ctx;
    if (!ctx) return;
    const colour = COLOURS[state.name] || COLOURS.joining;
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Head.
    ctx.fillStyle = "#f8fafc";
    ctx.beginPath();
    ctx.arc(320, 158, 92, 0, Math.PI * 2);
    ctx.fill();

    // Eyes.
    ctx.fillStyle = "#0f172a";
    ctx.beginPath();
    ctx.arc(288, 142, 12, 0, Math.PI * 2);
    ctx.arc(352, 142, 12, 0, Math.PI * 2);
    ctx.fill();

    // The mouth carries the state: waiting, in the room, or a problem.
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 8;
    ctx.lineCap = "round";
    ctx.beginPath();
    if (state.name === "in-room") {
      ctx.arc(320, 186, 42, 0.15 * Math.PI, 0.85 * Math.PI);
    } else if (state.name === "failed") {
      ctx.arc(320, 236, 42, 1.15 * Math.PI, 1.85 * Math.PI);
    } else {
      ctx.moveTo(284, 206);
      ctx.lineTo(356, 206);
    }
    ctx.stroke();
  };

  const frame = () => {
    if (!state.track || typeof state.track.requestFrame !== "function") return;
    try { state.track.requestFrame(); } catch (err) { /* a stopped track cannot be asked for a frame */ }
  };

  const setState = (next) => {
    state.name = next === "in-room" || next === "failed" ? next : "joining";
    draw();
    frame();
  };

  const publish = () => {
    const canvas = ensureCanvas();
    if (typeof canvas.captureStream !== "function") return null;
    // Frame rate 0 means "only the frames I ask for": no timer, no loop.
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0] || null;
    state.track = track;
    state.live = !!track && track.readyState === "live";
    if (track) {
      track.addEventListener("ended", () => { state.live = false; });
      try { track.requestFrame(); } catch (err) { /* the first frame is optional */ }
    }
    return stream;
  };

  // The room asks for a microphone and a camera. Answer both with streams we
  // construct: the face for video, and a silent Web Audio destination for audio.
  // The machine's own camera and microphone are never opened — a room that asks
  // for audio must not be able to listen to whatever is in this room.
  const silentStream = () => {
    if (state.audio) return state.audio;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      const ctx = new Ctx();
      const destination = ctx.createMediaStreamDestination();
      state.audio = destination.stream;
    } catch (err) {
      state.audio = null;
    }
    return state.audio;
  };

  // --- hearing the room ------------------------------------------------------
  // The room plays the operator's voice through a peer connection. That audio
  // exists only in this page, so a hook on RTCPeerConnection copies every remote
  // audio track into one ScriptProcessorNode, averages it down to 16 kHz mono and
  // parks the PCM on this global. The connector drains it over the CDP channel it
  // already owns and does the transcription locally.
  const hearing = { active: false, ctx: null, processor: null, sources: [], chunks: [], level: 0 };

  // One shared processor: several remote tracks must not be heard twice, and a
  // track that ends must free its slot for its replacement.
  const ensureHearing = () => {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!hearing.ctx) hearing.ctx = new Ctx();
    const ctx = hearing.ctx;
    if (!hearing.processor) {
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      const rate = ctx.sampleRate || 48000;
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        const outLength = Math.floor((input.length * 16000) / rate);
        if (outLength <= 0) return;
        const out = new Int16Array(outLength);
        const step = rate / 16000;
        let sum = 0;
        for (let i = 0; i < outLength; i++) {
          // Average each group (not just the first sample), so decimation does
          // not alias speech into a different pitch.
          const start = Math.floor(i * step);
          const end = Math.min(input.length, Math.floor((i + 1) * step));
          let acc = 0;
          for (let j = start; j < end; j++) acc += input[j] || 0;
          const raw = acc / Math.max(1, end - start);
          const sample = raw > 1 ? 1 : raw < -1 ? -1 : raw;
          out[i] = Math.round(sample * 32767);
          sum += sample * sample;
        }
        hearing.level = Math.sqrt(sum / outLength);
        hearing.chunks.push(out);
        // A silent stretch must not grow the buffer without bound; the connector
        // drains far more often than this ever fills.
        if (hearing.chunks.length > 400) hearing.chunks.shift();
      };
      // A ScriptProcessorNode only runs while connected; a zero-gain node keeps
      // it silent on the way to the destination.
      const gain = ctx.createGain();
      gain.gain.value = 0;
      processor.connect(gain);
      gain.connect(ctx.destination);
      hearing.processor = processor;
      hearing.active = true;
    }
    return hearing.processor;
  };

  const attachRoomAudio = (track) => {
    if (!track || track.kind !== "audio") return;
    try {
      // MediaStream is reached through window for the same reason as every other
      // browser global here: the script also runs outside a page in tests.
      const MS = window.MediaStream;
      if (typeof MS !== "function") return;
      const processor = ensureHearing();
      if (!processor) return;
      const source = hearing.ctx.createMediaStreamSource(new MS([track]));
      source.connect(processor);
      hearing.sources.push({ track: track, source: source });
      // A track can end and be replaced (a reconnect or a device change): detach
      // it so the room is not heard twice, and let a new track attach again.
      const detach = () => {
        try { source.disconnect(); } catch (err) { /* already gone */ }
        hearing.sources = hearing.sources.filter((entry) => entry.track !== track);
      };
      if (typeof track.addEventListener === "function") {
        track.addEventListener("ended", detach);
      }
    } catch (err) { /* no audio: the group hears no transcript rather than a crash */ }
  };

  // Patch the constructor before the room builds one, so its own peer
  // connection is the hooked one.
  const hookPeerConnection = () => {
    const Original = window.RTCPeerConnection;
    if (typeof Original !== "function" || Original.__signalConnectorHooked) return;
    const Hooked = function (...args) {
      const pc = new Original(...args);
      pc.addEventListener("track", (event) => {
        if (event && event.track) attachRoomAudio(event.track);
        else if (event && event.streams && event.streams[0] && event.streams[0].getAudioTracks) {
          event.streams[0].getAudioTracks().forEach(attachRoomAudio);
        }
      });
      return pc;
    };
    Hooked.prototype = Original.prototype;
    Hooked.__signalConnectorHooked = true;
    try { window.RTCPeerConnection = Hooked; } catch (err) { return; }
    const Prefixed = window.webkitRTCPeerConnection;
    if (typeof Prefixed === "function" && !Prefixed.__signalConnectorHooked) {
      try { window.webkitRTCPeerConnection = Hooked; } catch (err) { /* best effort */ }
    }
  };

  // Drain the audio collected since the last call. "pcm" is base64 Int16 at
  // 16 kHz; an empty frame means nothing was heard.
  const takePcm = () => {
    const chunks = hearing.chunks;
    hearing.chunks = [];
    const level = hearing.level;
    if (chunks.length === 0) return { pcm: "", rms: 0, active: hearing.active };
    let total = 0;
    for (let i = 0; i < chunks.length; i++) total += chunks[i].length;
    const merged = new Int16Array(total);
    let offset = 0;
    for (let i = 0; i < chunks.length; i++) {
      merged.set(chunks[i], offset);
      offset += chunks[i].length;
    }
    const bytes = new Uint8Array(merged.buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return { pcm: btoa(binary), rms: level, active: hearing.active };
  };

  const media = navigator.mediaDevices;
  if (media && typeof media.getUserMedia === "function") {
    const original = media.getUserMedia.bind(media);
    try {
      media.getUserMedia = (constraints) => {
        const wantsVideo = !!constraints && constraints.video !== undefined && constraints.video !== false;
        const wantsAudio = !!constraints && !!constraints.audio;
        if (!wantsVideo && !wantsAudio) return original(constraints);
        if (!wantsVideo) {
          const audio = silentStream();
          return audio
            ? Promise.resolve(audio)
            : Promise.reject(new Error("audio cannot be synthesised; the machine microphone is never used"));
        }
        const stream = publish();
        if (!stream) return Promise.reject(new Error("the avatar canvas cannot publish a stream"));
        if (wantsAudio) {
          const audio = silentStream();
          const track = audio && audio.getAudioTracks()[0];
          if (track) stream.addTrack(track);
        }
        return Promise.resolve(stream);
      };
    } catch (err) { /* an unpatchable instance is reported by the liveness flag */ }
  }

  window.${AVATAR_GLOBAL} = {
    setState: setState,
    state: () => state.name,
    liveness: () => ({
      publishing: state.live && !!state.track && state.track.readyState === "live",
      state: state.name,
    }),
    takePcm: takePcm,
    hearing: () => ({ active: hearing.active, level: hearing.level }),
  };

  hookPeerConnection();
  draw();
})();`;
}

/** Set the face's state (joining, in-room or failed). */
export function setStateExpression(state: FaceState): string {
  return `(() => {
    const avatar = window.${AVATAR_GLOBAL};
    if (avatar && typeof avatar.setState === "function") avatar.setState(${JSON.stringify(state)});
  })()`;
}

/**
 * Reports whether the face is still publishing. The connector checks this
 * rather than assuming the canvas is enough: a vanished track is the first
 * symptom of a room that can see nothing.
 */
export const LIVENESS_EXPRESSION = `(() => {
  const avatar = window.${AVATAR_GLOBAL};
  if (!avatar || typeof avatar.liveness !== "function") {
    return { present: false, publishing: false, state: "none" };
  }
  const now = avatar.liveness();
  return { present: true, publishing: !!now.publishing, state: String(now.state || "") };
})()`;

/**
 * Drains the room audio the injected script collected. The result is the frame
 * the voice pipeline consumes: base64 Int16 at 16 kHz and its RMS. Nothing is
 * returned when the page has no avatar or has heard nothing.
 */
export const TAKE_PCM_EXPRESSION = `(() => {
  const avatar = window.${AVATAR_GLOBAL};
  if (!avatar || typeof avatar.takePcm !== "function") return { pcm: "", rms: 0, active: false };
  try { return avatar.takePcm(); } catch (err) { return { pcm: "", rms: 0, active: false }; }
})()`;

/**
 * A cheap DOM read of where the page thinks it is: "in-room" when the call's own
 * leave control exists, "joining" while the name / ask-to-join / waiting lobby
 * is shown, "ended" when the page says the call is over, and "unknown" when the
 * page is unrecognisable. Only "in-room" admits the avatar; "unknown" keeps the
 * join waiting until the admission budget ends it with a reason.
 */
export const ADMISSION_EXPRESSION = `(() => {
  const label = (el) => ((el.getAttribute("aria-label") || "") + " " + (el.textContent || "")).toLowerCase();
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
  const pageText = (document.body ? document.body.innerText : "").toLowerCase();
  if (/waiting to be (admitted|let in)|someone will let you in|you are waiting|you're waiting/.test(pageText)) return "joining";
  if (buttons.some((b) => /leave call|end call|hang up/.test(label(b)))) return "in-room";
  if (/you left the call|rejoin|return to home screen/.test(pageText)) return "ended";
  const nameField = document.querySelector('input[aria-label*="name" i], input[placeholder*="name" i]');
  if (nameField) return "joining";
  if (buttons.some((b) => /ask to join|join now/.test(label(b)))) return "joining";
  return "unknown";
})()`;

/**
 * Best-effort click on the room's own join control. A host-locked room never
 * lets the avatar in until somebody knocks, so the connector knocks itself.
 * Reports whether the control existed and whether the click went through, so
 * the operator can be told to join by hand when the page offers no control.
 */
export const JOIN_CLICK_EXPRESSION = `(() => {
  const label = (el) => ((el.getAttribute("aria-label") || "") + " " + (el.textContent || "")).toLowerCase();
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
  const control = buttons.find((b) => /ask to join|join now|request to join|join the call/.test(label(b)));
  if (!control) return { found: false, clicked: false };
  if (control.disabled || control.getAttribute("aria-disabled") === "true") {
    return { found: true, clicked: false };
  }
  try {
    control.click();
    return { found: true, clicked: true };
  } catch (err) {
    return { found: true, clicked: false };
  }
})()`;

/**
 * Pre-fills the anonymous guest's name with the project's name, so the person
 * admitting the avatar sees which project is knocking. It only touches a
 * name field, never a chat box, and stops itself after the first fill.
 */
export function guestNameScript(projectName: string): string {
  return `(() => {
  const NAME = ${JSON.stringify(projectName)};
  let attempts = 0;
  const fill = () => {
    attempts += 1;
    const input = document.querySelector('input[aria-label*="name" i], input[placeholder*="name" i]');
    if (input) {
      if (input.value !== NAME) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        if (descriptor && descriptor.set) descriptor.set.call(input, NAME);
        else input.value = NAME;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      clearInterval(timer);
      return;
    }
    if (attempts > 120) clearInterval(timer);
  };
  const timer = setInterval(fill, 500);
  fill();
})();`;
}
