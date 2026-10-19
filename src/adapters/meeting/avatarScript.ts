/**
 * The avatar the room sees as its camera.
 *
 * A canvas face is drawn on every state change and, while the avatar is in the
 * room, eight times a second so the mood reads as motion: thought bubbles,
 * a turning book, a laptop, sound waves, and a mouth that moves while the
 * avatar speaks. `setState` repaints in the connector's colours (blue joining,
 * green in the room, red on a problem) and asks the capture track for one frame.
 * The script also replaces `getUserMedia`: video is answered with
 * `canvas.captureStream()` and audio with a silent synthetic track, so the room
 * gets a face and a microphone that never touches the machine's own camera or
 * microphone.
 */
import type { AvatarMood, MeetingState } from "../../core/ports.js";

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

/** What the avatar shows while the agent works; the page draws each one. */
export const AVATAR_MOODS: ReadonlyArray<AvatarMood> = ["listening", "thinking", "reading", "writing"];

/**
 * The script injected with `Page.addScriptToEvaluateOnNewDocument`, so it runs
 * before the room's own scripts can ask for a camera.
 */
export function buildAvatarScript(): string {
  return `(() => {
  if (window.${AVATAR_GLOBAL}) return;

  const COLOURS = ${JSON.stringify(FACE_COLOURS)};
  const state = {
    name: "joining",
    mood: "listening",
    tick: 0,
    timer: null,
    track: null,
    live: false,
    canvas: null,
    ctx: null,
    audio: null,
    audioContext: null,
    audioDestination: null,
  };

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

  const MOODS = ["listening", "thinking", "reading", "writing"];

  const draw = () => {
    const canvas = ensureCanvas();
    const ctx = state.ctx;
    if (!ctx) return;
    const colour = COLOURS[state.name] || COLOURS.joining;
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const tick = state.tick;
    const speaking = typeof speech !== "undefined" && !!speech.playing;
    const mood =
      state.name === "in-room" ? (speaking ? "speaking" : state.mood) : state.name;

    // Shoulders.
    ctx.fillStyle = "rgba(15,23,42,0.25)";
    ctx.beginPath();
    ctx.arc(320, 330, 140, 0, Math.PI * 2);
    ctx.fill();

    // Head.
    ctx.fillStyle = "#f8fafc";
    ctx.beginPath();
    ctx.arc(320, 150, 84, 0, Math.PI * 2);
    ctx.fill();

    // Eyes: looking down at a book or a keyboard.
    ctx.fillStyle = "#0f172a";
    const down = mood === "reading" || mood === "writing";
    for (const x of [292, 348]) {
      ctx.beginPath();
      ctx.arc(x, down ? 148 : 138, down ? 8 : 11, 0, Math.PI * 2);
      ctx.fill();
    }

    // Mouth: the answer moves it, a failure frowns.
    ctx.lineCap = "round";
    if (state.name === "failed") {
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.arc(320, 226, 40, 1.15 * Math.PI, 1.85 * Math.PI);
      ctx.stroke();
    } else if (mood === "speaking") {
      ctx.fillStyle = "#0f172a";
      ctx.beginPath();
      const open = 7 + (tick % 4) * 4;
      if (typeof ctx.ellipse === "function") {
        ctx.ellipse(320, 196, 26, open, 0, 0, Math.PI * 2);
      } else {
        ctx.arc(320, 196, open, 0, Math.PI * 2);
      }
      ctx.fill();
    } else {
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.arc(320, 180, 38, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
    }

    // The scene tells the state at a glance.
    if (mood === "thinking") {
      for (let i = 0; i < 3; i++) {
        const phase = (tick + i * 2) % 6;
        ctx.fillStyle = "rgba(248,250,252," + (0.25 + (phase / 6) * 0.75) + ")";
        ctx.beginPath();
        ctx.arc(430 + i * 34, 92 - i * 20, 9 + i * 4, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (mood === "reading") {
      // An open book, its pages turning.
      ctx.fillStyle = "#fef3c7";
      ctx.fillRect(230, 258, 180, 76);
      ctx.fillStyle = "#f59e0b";
      ctx.fillRect(tick % 4 < 2 ? 232 : 320, 260, 88, 72);
      ctx.strokeStyle = "#92400e";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(320, 258);
      ctx.lineTo(320, 334);
      ctx.stroke();
    } else if (mood === "writing") {
      // A laptop whose keys light in turn.
      ctx.fillStyle = "#1e293b";
      ctx.fillRect(238, 292, 164, 56);
      ctx.fillStyle = "#0ea5e9";
      ctx.fillRect(250, 268, 140, 24);
      for (let i = 0; i < 6; i++) {
        ctx.fillStyle = (tick + i) % 3 === 0 ? "#f8fafc" : "#64748b";
        ctx.fillRect(252 + i * 22, 310, 14, 8);
      }
    } else if (mood === "listening") {
      // Sound waves reaching the avatar.
      for (let i = 1; i <= 3; i++) {
        const phase = (tick + i * 2) % 6;
        ctx.strokeStyle = "rgba(248,250,252," + (0.15 + (phase / 6) * 0.5) + ")";
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.arc(320, 150, 110 + i * 18, -0.5, 0.5);
        ctx.stroke();
      }
    }
  };

  const frame = () => {
    if (!state.track || typeof state.track.requestFrame !== "function") return;
    try { state.track.requestFrame(); } catch (err) { /* a stopped track cannot be asked for a frame */ }
  };

  const stopAnimation = () => {
    if (!state.timer) return;
    clearInterval(state.timer);
    state.timer = null;
  };

  const startAnimation = () => {
    if (state.timer) return;
    // Eight frames a second is enough for a face; the track publishes only the
    // frames this loop asks for (captureStream(0)).
    state.timer = setInterval(() => {
      if (state.name !== "in-room") { stopAnimation(); return; }
      state.tick += 1;
      draw();
      frame();
    }, 125);
  };

  const setState = (next) => {
    state.name = next === "in-room" || next === "failed" ? next : "joining";
    if (state.name === "in-room") startAnimation(); else stopAnimation();
    draw();
    frame();
  };

  const setMood = (next) => {
    state.mood = MOODS.indexOf(next) >= 0 ? next : "listening";
    draw();
    frame();
    return state.mood;
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
  //
  // The context and destination are kept: that same destination is what the
  // avatar later plays into, so the room hears a spoken clip through the
  // microphone stream it already receives.
  const ensureSpeaker = () => {
    if (state.audio && state.audioContext && state.audioDestination) {
      return { ctx: state.audioContext, destination: state.audioDestination };
    }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      const ctx = new Ctx();
      const destination = ctx.createMediaStreamDestination();
      state.audioContext = ctx;
      state.audioDestination = destination;
      state.audio = destination.stream;
    } catch (err) {
      state.audio = null;
      state.audioContext = null;
      state.audioDestination = null;
    }
    return state.audio ? { ctx: state.audioContext, destination: state.audioDestination } : null;
  };

  const silentStream = () => {
    const graph = ensureSpeaker();
    return graph ? state.audio : null;
  };

  // --- talking back ----------------------------------------------------------
  // The room hears only what the synthetic microphone publishes, so a clip is
  // decoded in this page and played into the destination above. One clip at a
  // time, in order; stopSpeaking() drops the queue and silences the one playing.
  const speech = { queue: [], current: null, playing: false, generation: 0 };

  const decodeClip = (base64) => {
    return new Promise((resolve, reject) => {
      const graph = ensureSpeaker();
      if (!graph || typeof graph.ctx.decodeAudioData !== "function") {
        reject(new Error("no audio context to decode with"));
        return;
      }
      try {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        // Chrome resolves the promise; the callback form is kept for a page
        // whose decodeAudioData only takes success/error handlers.
        const decoded = graph.ctx.decodeAudioData(bytes.buffer, resolve, reject);
        if (decoded && typeof decoded.then === "function") decoded.then(resolve, reject);
      } catch (err) {
        reject(err);
      }
    });
  };

  const pumpSpeech = () => {
    if (speech.playing) return;
    const next = speech.queue.shift();
    if (!next) return;
    // A clip queued before a barge-in is dropped rather than played late.
    if (next.generation !== speech.generation) return pumpSpeech();
    speech.playing = true;
    decodeClip(next.base64).then(
      (buffer) => {
        if (next.generation !== speech.generation) {
          speech.playing = false;
          return pumpSpeech();
        }
        const graph = ensureSpeaker();
        if (!graph || typeof graph.ctx.createBufferSource !== "function") {
          speech.playing = false;
          return;
        }
        const source = graph.ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(graph.destination);
        source.onended = () => {
          if (speech.current !== source) return;
          speech.current = null;
          speech.playing = false;
          pumpSpeech();
        };
        speech.current = source;
        try {
          source.start(0);
        } catch (err) {
          speech.current = null;
          speech.playing = false;
          pumpSpeech();
        }
      },
      () => {
        speech.current = null;
        speech.playing = false;
        pumpSpeech();
      },
    );
  };

  const speak = (base64) => {
    if (!base64) return { queued: false, speaking: speech.playing };
    const graph = ensureSpeaker();
    if (!graph) return { queued: false, speaking: false };
    // A provider may mute the synthetic microphone (Jitsi disables the track on
    // join), and a disabled track carries silence no matter what the graph
    // plays. Asking to speak is asking to be heard, so re-enable it here.
    try {
      if (state.audio) {
        state.audio.getAudioTracks().forEach((track) => {
          if (!track.enabled) track.enabled = true;
        });
      }
    } catch (err) {
      /* a track that cannot be touched is reported by the room itself */
    }
    // A context suspended by the autoplay policy is resumed on the first clip
    // instead of failing silently. The browser is started with
    // --autoplay-policy=no-user-gesture-required, so this is a safety net.
    if (typeof graph.ctx.resume === "function" && graph.ctx.state === "suspended") {
      try { graph.ctx.resume(); } catch (err) { /* the clip may still play */ }
    }
    speech.queue.push({ base64: base64, generation: speech.generation });
    pumpSpeech();
    return { queued: true, speaking: true };
  };

  const stopSpeaking = () => {
    // Bumping the generation invalidates a clip still decoding, and every clip
    // still queued behind it.
    speech.generation += 1;
    speech.queue.length = 0;
    const current = speech.current;
    speech.current = null;
    speech.playing = false;
    if (current) {
      try { current.onended = null; } catch (err) { /* assigning is best effort */ }
      try { current.stop(); } catch (err) { /* already finished */ }
      try { current.disconnect(); } catch (err) { /* already detached */ }
    }
    return { speaking: false, queued: 0 };
  };

  const speechState = () => ({ speaking: speech.playing, queued: speech.queue.length });

  // --- hearing the room ------------------------------------------------------
  // The room plays the operator's voice through a peer connection. That audio
  // exists only in this page, so a hook on RTCPeerConnection copies every remote
  // audio track into one ScriptProcessorNode, averages it down to 16 kHz mono and
  // parks the PCM on this global. The connector drains it over the CDP channel it
  // already owns and does the transcription locally.
  const hearing = { ctx: null, processor: null, sources: [], chunks: [], level: 0, peak: 0, epoch: 0 };

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
        // A level read every few seconds must not miss a short remark between
        // reads: keep the loudest block until the connector asks.
        if (hearing.level > hearing.peak) hearing.peak = hearing.level;
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
      // A track arriving is a change the connector must see: it resets the
      // silence clock, because a fresh track is not the same silence as before.
      hearing.epoch += 1;
      // A track can end and be replaced (a reconnect or a device change): detach
      // it so the room is not heard twice, and let a new track attach again.
      const detach = () => {
        try { source.disconnect(); } catch (err) { /* already gone */ }
        hearing.sources = hearing.sources.filter((entry) => entry.track !== track);
        hearing.epoch += 1;
      };
      // A provider mutes the operator's track while they are muted; that is a
      // change too, not evidence that the room has gone deaf for good.
      const bumpEpoch = () => { hearing.epoch += 1; };
      if (typeof track.addEventListener === "function") {
        track.addEventListener("ended", detach);
        track.addEventListener("mute", bumpEpoch);
        track.addEventListener("unmute", bumpEpoch);
      }
    } catch (err) { /* no audio: the group hears no transcript rather than a crash */ }
  };

  // --- who is here -----------------------------------------------------------
  // Presence is deliberately weak. Only the provider's own member list can say
  // how many humans are in the room; everywhere else the answer is "unknown",
  // never guessed from audio or from the page's markup. No identity leaves this
  // page: just a count of the humans besides the avatar.
  const presence = () => {
    try {
      const app = window.APP;
      const conference = app && app.conference;
      if (!conference || typeof conference.listMembers !== "function") {
        return { presence: "unknown" };
      }
      // Jitsi documents listMembers() as every participant except the local
      // user, so the avatar itself is already out of the count.
      const members = conference.listMembers();
      if (!Array.isArray(members)) return { presence: "unknown" };
      let humans = 0;
      for (let i = 0; i < members.length; i++) {
        const member = members[i];
        if (!member) continue;
        // Hidden participants (recorders, transcribers) are not people in the
        // room, so they must not make the avatar listen-only.
        try {
          if (typeof member.isHidden === "function" && member.isHidden()) continue;
        } catch (err) { /* an unreadable flag is still a member */ }
        humans += 1;
      }
      return { presence: humans > 0 ? "someone" : "nobody", humans: humans };
    } catch (err) {
      return { presence: "unknown" };
    }
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
    const active = hearing.sources.length > 0;
    if (chunks.length === 0) return { pcm: "", rms: 0, active: active };
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
    return { pcm: btoa(binary), rms: level, active: active };
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
    setMood: setMood,
    mood: () => state.mood,
    state: () => state.name,
    liveness: () => ({
      publishing: state.live && !!state.track && state.track.readyState === "live",
      state: state.name,
    }),
    takePcm: takePcm,
    hearing: () => {
      // The peak since the last read, then reset: a short remark between two
      // telemetry reads must still count as audible room audio. "Active" means
      // a remote track is still attached, not that a processor once existed.
      const level = hearing.peak;
      hearing.peak = 0;
      return {
        active: hearing.sources.length > 0,
        level: level,
        epoch: hearing.epoch,
      };
    },
    presence: presence,
    speak: speak,
    stopSpeaking: stopSpeaking,
    speech: speechState,
  };

  hookPeerConnection();
  draw();
})();`;
}

/** Set the face's state (joining, in-room or failed). */
/** How long the avatar holds a mood, and how it is set. */
export function setMoodExpression(mood: AvatarMood): string {
  return `(() => {
  const avatar = window.${AVATAR_GLOBAL};
  if (!avatar || typeof avatar.setMood !== "function") return "listening";
  try { return avatar.setMood(${JSON.stringify(mood)}); } catch (err) { return "listening"; }
})()`;
}

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
 * Reports whether the room's audio hook is attached and how loud it is, plus
 * the epoch that changes when a track is attached, ended, muted or unmuted.
 * Neither this nor the presence probe drains the PCM the voice pump needs.
 */
export const AUDIO_STATE_EXPRESSION = `(() => {
  const avatar = window.${AVATAR_GLOBAL};
  if (!avatar || typeof avatar.hearing !== "function") {
    return { present: false, active: false, level: 0, epoch: 0 };
  }
  try {
    const now = avatar.hearing() || {};
    const level = typeof now.level === "number" && isFinite(now.level) ? now.level : 0;
    const epoch = typeof now.epoch === "number" && isFinite(now.epoch) ? now.epoch : 0;
    return { present: true, active: !!now.active, level: level, epoch: epoch };
  } catch (err) {
    return { present: false, active: false, level: 0, epoch: 0 };
  }
})()`;

/**
 * Asks the page who it can see. Jitsi answers from its own member list; every
 * other page is "unknown". No identity is ever returned, only the count of
 * humans besides the avatar, and only when the provider itself can say it.
 */
export const PRESENCE_EXPRESSION = `(() => {
  const avatar = window.${AVATAR_GLOBAL};
  if (!avatar || typeof avatar.presence !== "function") return { presence: "unknown" };
  try {
    const now = avatar.presence() || {};
    const presence =
      now.presence === "someone" || now.presence === "nobody" ? now.presence : "unknown";
    if (typeof now.humans !== "number" || !isFinite(now.humans)) return { presence: presence };
    return { presence: presence, humans: now.humans };
  } catch (err) {
    return { presence: "unknown" };
  }
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
 * Play one base64 WAV through the page's synthetic microphone: the room hears
 * it through the microphone stream it already receives. Reports whether the
 * clip was queued; a clip queued behind another waits its turn.
 */
export function speakExpression(wavBase64: string): string {
  return `(() => {
    const avatar = window.${AVATAR_GLOBAL};
    if (!avatar || typeof avatar.speak !== "function") return { queued: false, speaking: false };
    try { return avatar.speak(${JSON.stringify(wavBase64)}); }
    catch (err) { return { queued: false, speaking: false }; }
  })()`;
}

/** Stop the clip playing and drop every clip queued behind it. */
export const STOP_SPEAKING_EXPRESSION = `(() => {
  const avatar = window.${AVATAR_GLOBAL};
  if (!avatar || typeof avatar.stopSpeaking !== "function") return { speaking: false, queued: 0 };
  try { return avatar.stopSpeaking(); }
  catch (err) { return { speaking: false, queued: 0 }; }
})()`;

/**
 * Whether the page is still playing a clip and how many wait behind it. Used
 * to tell a real barge-in from room tone before stopping speech.
 */
export const SPEECH_STATE_EXPRESSION = `(() => {
  const avatar = window.${AVATAR_GLOBAL};
  if (!avatar || typeof avatar.speech !== "function") return { speaking: false, queued: 0 };
  try {
    const now = avatar.speech();
    return { speaking: !!now.speaking, queued: Number(now.queued) || 0 };
  } catch (err) {
    return { speaking: false, queued: 0 };
  }
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
  // A hard refusal is terminal: no knock, no lobby, no admission to wait for.
  if (/you can't join this video call|you can\u2019t join this video call|no one can join a meeting unless/.test(pageText)) return "refused";
  // Unambiguous endings only. "Return to home screen" is also the way out of
  // the waiting room, so it cannot decide that the call is over.
  if (/you left the call|you've left the call|the meeting ended|the call ended|you were removed/.test(pageText)) return "ended";
  // The lobby, however the provider words it: a knock that is queued, or the
  // waiting room's own "Return to home screen" control.
  if (/asking to be let in|waiting to be (admitted|let in)|someone will let you in|you are waiting|you're waiting|you'll be let in|will let you in|waiting for a moderator|return to home screen/.test(pageText)) return "joining";
  // The pre-join screen has a "Leave the meeting" back button of its own, so a
  // leave control alone proves nothing: the join control has to be gone first.
  const joinControl = buttons.some((b) => /join meeting|join now|ask to join|request to join|join the call/.test(label(b)));
  if (!joinControl && buttons.some((b) => /leave|hang ?up|end (the )?call/.test(label(b)))) return "in-room";
  const nameField = document.querySelector('input[aria-label*="name" i], input[placeholder*="name" i]');
  if (nameField) return "joining";
  if (joinControl) return "joining";
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
  const control = buttons.find((b) => /ask to join|join now|request to join|join the call|join meeting/.test(label(b)));
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
