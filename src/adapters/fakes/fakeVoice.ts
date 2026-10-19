/**
 * In-memory VoicePort fake for core tests. Records starts/stops and lets a test
 * make the room utter something, report a level, or fail with a reason.
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

  /** Test helper: the pipeline dropped an utterance and names its reason. */
  drop(reason: string): void {
    this.drops += 1;
    this.failures.push(reason);
    this.current?.onFailure?.(reason);
  }
}
