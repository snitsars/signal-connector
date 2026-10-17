/**
 * In-memory MeetingPort fake for core tests. Records joins, can refuse to open a
 * browser, can be admitted on its own, and can die mid-meeting.
 */
import type {
  JoinMeetingInput,
  MeetingAvailability,
  MeetingHandle,
  MeetingLeaveResult,
  MeetingPort,
  MeetingStateEvent,
} from "../../core/ports.js";

export interface FakeJoin {
  projectId: string;
  projectName: string;
  link: string;
}

export class FakeMeeting implements MeetingPort {
  readonly joins: FakeJoin[] = [];
  readonly leaves: string[] = [];
  /** Set to refuse availability, as a machine without Chrome or Edge would. */
  unavailableReason?: string;
  /** Set to make join throw, as a browser that cannot be started would. */
  failJoin = false;
  /** Delay the join result, so a stop can land while it is still in flight. */
  joinDelayMs = 0;
  /** Admit the avatar on the next tick instead of waiting for a test to call admit(). */
  skipAdmission = false;
  /** Make leave() report a browser that survived the kill. */
  surviveLeave = false;
  private handler: ((event: MeetingStateEvent) => void) | undefined;
  private open = false;

  async available(): Promise<MeetingAvailability> {
    return this.unavailableReason
      ? { available: false, reason: this.unavailableReason }
      : { available: true };
  }

  async join(input: JoinMeetingInput): Promise<MeetingHandle> {
    if (this.joinDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.joinDelayMs));
    }
    if (this.failJoin) throw new Error("the browser could not start");
    this.joins.push({
      projectId: input.projectId,
      projectName: input.projectName,
      link: input.link,
    });
    this.handler = input.onState;
    this.open = true;
    if (this.skipAdmission) {
      queueMicrotask(() => {
        if (this.open) input.onState({ state: "in-room" });
      });
    }
    return {
      leave: async (): Promise<MeetingLeaveResult> => {
        this.leaves.push(input.projectId);
        this.open = false;
        this.handler = undefined;
        return this.surviveLeave
          ? { closed: false, detail: "the browser did not exit; the room may still be open" }
          : { closed: true };
      },
    };
  }

  async stop(): Promise<void> {
    this.open = false;
    this.handler = undefined;
  }

  /** Test helper: the room admitted the avatar. */
  admit(): void {
    this.handler?.({ state: "in-room" });
  }

  /** Test helper: the lobby offered no join control, so it needs a hand. */
  joinNeedsHelp(
    detail = "could not find the join control; the name is filled — join by hand",
  ): void {
    this.handler?.({ state: "joining", detail });
  }

  /** Test helper: the face stopped publishing. */
  faceStopped(): void {
    this.handler?.({ state: "in-room", detail: "face not publishing" });
  }

  /** Test helper: the browser or the call ended on its own. */
  die(detail = "the browser exited"): void {
    if (!this.open) return;
    this.open = false;
    this.handler?.({ state: "left", detail });
    this.handler = undefined;
  }

  /** Test helper: the adapter gave up (for example, nobody admitted the avatar). */
  fail(detail: string): void {
    if (!this.open) return;
    this.open = false;
    this.handler?.({ state: "failed", detail });
    this.handler = undefined;
  }
}
