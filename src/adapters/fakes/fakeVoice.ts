/**
 * In-memory VoicePort fake for core tests. Records starts/stops and lets a test
 * make the room utter something, report a level, or fail with a reason. It also
 * records what the avatar was asked to say, so the speaking path is testable
 * without audio, a synthesiser or a browser.
 */
import type {
  StartListeningInput,
  Utterance,
  VoiceAvailability,
  VoiceHandle,
  VoicePort,
} from "../../core/ports.js";

export interface FakeListening {
  projectId: string;
  projectName: string;
}

export class FakeVoice implements VoicePort {
  readonly started: FakeListening[] = [];
  readonly stops: string[] = [];
  /** Set to make available() refuse, as an unconfigured transcriber would. */
  unavailableReason?: string;
  /** Utterances the room "said", in order. */
  readonly utterances: Utterance[] = [];
  readonly levels: number[] = [];
  readonly failures: string[] = [];
  /** How many utterances this fake counted as dropped. */
  drops = 0;
  /** Every clip the avatar said into the room, in order. */
  readonly spoken: string[] = [];
  /** How many times speech was stopped: a barge-in or the end of the meeting. */
  stoppedSpeaking = 0;
  /** Set to hold speak() open, as a page still playing a long clip would. */
  private held: Promise<void> | undefined;
  private release: (() => void) | undefined;
  private current: StartListeningInput | undefined;

  async available(): Promise<VoiceAvailability> {
    return this.unavailableReason
      ? { available: false, reason: this.unavailableReason }
      : { available: true };
  }

  async start(input: StartListeningInput): Promise<VoiceHandle> {
    this.started.push({ projectId: input.projectId, projectName: input.projectName });
    this.current = input;
    return {
      stop: async (): Promise<void> => {
        this.stops.push(input.projectId);
        if (this.current === input) this.current = undefined;
      },
      speak: async (text: string): Promise<void> => {
        this.spoken.push(text);
        // A held clip stays in flight, so a test can interrupt mid-sentence.
        if (this.held) await this.held;
      },
      stopSpeaking: async (): Promise<void> => {
        this.stoppedSpeaking += 1;
        this.releaseSpeech();
      },
    };
  }

  async stop(): Promise<void> {
    this.current = undefined;
  }

  /** Test helper: the room said this. */
  utterance(text: string, durationMs = 1000): void {
    this.utterances.push({ text, durationMs });
    this.current?.onUtterance({ text, durationMs });
  }

  /** Test helper: the room's current level, as the pump would report it. */
  level(rms: number): void {
    this.levels.push(rms);
    this.current?.onLevel?.(rms);
  }

  /** Test helper: the operator spoke, so the level rose above the gate. */
  operatorSpeaks(rms = 0.2): void {
    this.level(rms);
  }

  /** Test helper: pipeline dropped an utterance and names its reason. */
  drop(reason: string): void {
    this.drops += 1;
    this.failures.push(reason);
    this.current?.onFailure?.(reason);
  }

  /** Test helper: hold the next speak() until releaseSpeech(). */
  holdSpeech(): void {
    this.held = new Promise((resolve) => {
      this.release = resolve;
    });
  }

  /** Test helper: let a held speak() finish. */
  releaseSpeech(): void {
    const release = this.release;
    this.release = undefined;
    this.held = undefined;
    release?.();
  }
}
