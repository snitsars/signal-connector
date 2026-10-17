/**
 * One meeting room, driven through a real browser.
 *
 * Chrome (or Edge) starts with its own incognito profile under the data dir and
 * a debugging port of the operating system's choosing, on `about:blank`. The
 * avatar script is installed first and only then is the room navigated to, so
 * the room can never be handed the machine's real camera or microphone. Once
 * there, the guest's name is pre-filled with the project's, the join control is
 * clicked best-effort, and the adapter watches admission and the face's
 * liveness until the room ends. `leave()` closes the browser, waits, and
 * force-kills the process tree if the room would otherwise stay open.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  JoinMeetingInput,
  MeetingAvailability,
  MeetingHandle,
  MeetingLeaveResult,
  MeetingPort,
} from "../../core/ports.js";
import type { Logger } from "../../logging/logger.js";
import { resolveCommand } from "../spawnCommand.js";
import {
  ADMISSION_EXPRESSION,
  buildAvatarScript,
  guestNameScript,
  JOIN_CLICK_EXPRESSION,
  LIVENESS_EXPRESSION,
  setStateExpression,
} from "./avatarScript.js";
import { attachToPage, CdpClient, waitForDevToolsPort, type AttachedPage } from "./cdp.js";
import { findBrowser, type BrowserLookup } from "./chromeFinder.js";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The browser's argv: never the room URL, which is navigated to after injection. */
export function browserArguments(profileDir: string): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    // Let the operating system pick the port; never a guessed one.
    "--remote-debugging-port=0",
    // The link must not land in browser history, where it would outlive the row.
    "--incognito",
    "--no-first-run",
    "--no-default-browser-check",
    // The avatar supplies its own streams; no real device permission is needed.
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    // A blank page buys the time to install the media override before the room loads.
    "about:blank",
  ];
}

export type AdmissionStep =
  | { kind: "in-room" }
  | { kind: "wait" }
  | { kind: "failed"; detail: string };

/**
 * What one pre-admission poll means. Only the page saying "in-room" admits the
 * avatar: a publishing canvas can be the pre-join preview, so it must not count.
 * When the budget runs out, the failure names which of the two happened.
 */
export function admissionStep(input: {
  admission: string;
  publishing: boolean;
  expired: boolean;
  budgetSeconds: number;
}): AdmissionStep {
  if (input.admission === "in-room") return { kind: "in-room" };
  if (!input.expired) return { kind: "wait" };
  return {
    kind: "failed",
    detail: input.publishing
      ? `the room never confirmed the avatar's admission within ${input.budgetSeconds} s`
      : `nobody admitted the avatar within ${input.budgetSeconds} s`,
  };
}

export interface BrowserMeetingOptions {
  /** The browser's own profile directory (under the data dir, never the operator's). */
  profileDir: string;
  logger: Logger;
  /** Injectable for tests; production probes the standard install paths. */
  findBrowser?: () => BrowserLookup;
  /** How long to wait for the browser and its debugging port. */
  launchTimeoutMs?: number;
  /** How long to wait for somebody to admit the avatar. */
  admissionTimeoutMs?: number;
  /** How often to read the page's state. */
  pollMs?: number;
  /** How long to wait for the browser to exit after asking it to close. */
  leaveTimeoutMs?: number;
}

interface Session {
  input: JoinMeetingInput;
  child: ChildProcess;
  client?: CdpClient;
  page?: AttachedPage;
  timer?: NodeJS.Timeout;
  leaving: boolean;
  /** False until join() has attached and is ready to report states. */
  ready: boolean;
  inRoom: boolean;
  faceWarned: boolean;
  /** The join control was clicked; do not knock twice. */
  joinClicked: boolean;
  /** Polls spent looking for the join control. */
  joinAttempts: number;
  /** The missing join control was already reported. */
  joinWarned: boolean;
  /** Consecutive polls that looked like the join lobby again. */
  backInLobby: number;
  admissionDeadline: number;
}

interface Liveness {
  present?: boolean;
  publishing?: boolean;
  state?: string;
}

/** Force-kill a process and its children; the browser must not outlive the meeting. */
export function killTree(pid: number, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export class BrowserMeeting implements MeetingPort {
  private readonly options: BrowserMeetingOptions;
  private readonly launchTimeoutMs: number;
  private readonly admissionTimeoutMs: number;
  private readonly pollMs: number;
  private readonly leaveTimeoutMs: number;
  private session: Session | undefined;

  constructor(options: BrowserMeetingOptions) {
    this.options = options;
    this.launchTimeoutMs = options.launchTimeoutMs ?? 15_000;
    this.admissionTimeoutMs = options.admissionTimeoutMs ?? 90_000;
    this.pollMs = options.pollMs ?? 1_000;
    this.leaveTimeoutMs = options.leaveTimeoutMs ?? 5_000;
  }

  async available(): Promise<MeetingAvailability> {
    const lookup = this.options.findBrowser?.() ?? findBrowser();
    return "reason" in lookup
      ? { available: false, reason: lookup.reason }
      : { available: true };
  }

  async join(input: JoinMeetingInput): Promise<MeetingHandle> {
    if (this.session) throw new Error("a meeting is already open");
    const lookup = this.options.findBrowser?.() ?? findBrowser();
    if ("reason" in lookup) throw new Error(lookup.reason);
    const browser = lookup.browser;

    fs.mkdirSync(this.options.profileDir, { recursive: true });
    // A stale port file from a previous run would be read before the new one.
    fs.rmSync(path.join(this.options.profileDir, "DevToolsActivePort"), { force: true });

    const resolved = resolveCommand(browser.path, browserArguments(this.options.profileDir));

    const child = spawn(resolved.command, resolved.args, {
      shell: resolved.shell,
      // The room is meant to be watched: the window stays visible.
      windowsHide: false,
      stdio: "ignore",
    });

    const session: Session = {
      input,
      child,
      leaving: false,
      ready: false,
      inRoom: false,
      faceWarned: false,
      joinClicked: false,
      joinAttempts: 0,
      joinWarned: false,
      backInLobby: 0,
      admissionDeadline: Date.now() + this.admissionTimeoutMs,
    };
    this.session = session;
    child.on("exit", () => {
      void this.onBrowserExit(session);
    });
    child.on("error", () => {
      void this.onBrowserExit(session);
    });

    this.options.logger.info("meeting: starting the avatar browser", {
      project: input.projectName,
      browser: browser.kind,
    });

    try {
      const devtools = await waitForDevToolsPort(
        this.options.profileDir,
        this.launchTimeoutMs,
        100,
        () => child.exitCode === null && child.signalCode === null,
      );
      const client = await CdpClient.connect(`ws://127.0.0.1:${devtools.port}${devtools.wsPath}`);
      session.client = client;
      const page = await this.attach(client);
      session.page = page;
      // A lost DevTools socket means the meeting is over; say why instead of
      // polling a dead connection forever.
      client.onClose(() => {
        void this.onConnectionLost(session);
      });
      page.onDetached(() => {
        void this.onPageLost(session);
      });
      // A navigation loads a new document with the injected script; repaint the
      // face so the room never shows a stale colour after a reload.
      page.client.on("Page.frameNavigated", (params) => {
        const frame = params.frame as { parentId?: string } | undefined;
        if (frame?.parentId) return;
        void this.paint(session, session.inRoom ? "in-room" : "joining");
      });

      const avatar = buildAvatarScript();
      const guest = guestNameScript(input.projectName);
      await client.send("Page.addScriptToEvaluateOnNewDocument", { source: avatar }, page.sessionId);
      await client.send("Page.addScriptToEvaluateOnNewDocument", { source: guest }, page.sessionId);
      // The browser is on about:blank: install the overrides there, then load the
      // room, so its first camera/microphone request already meets the avatar.
      await page.evaluate(avatar);
      await page.evaluate(guest);
      await this.paint(session, "joining");
      await page.navigate(input.link);
    } catch {
      // Shut the window down rather than leave a browser the operator did not ask
      // for; the reason is reported by the caller, never the room's address.
      await this.shutdown(session, false);
      throw new Error("the avatar browser did not open");
    }

    this.options.logger.info("meeting: waiting for admission", { project: input.projectName });
    session.ready = true;
    session.timer = setInterval(() => {
      void this.poll(session);
    }, this.pollMs);

    return { leave: () => this.leave(session) };
  }

  async stop(): Promise<void> {
    const session = this.session;
    if (!session) return;
    await this.leave(session);
  }

  /** Attach to the page, tolerating the moment before the browser lists it. */
  private async attach(client: CdpClient): Promise<AttachedPage> {
    const deadline = Date.now() + this.launchTimeoutMs;
    let lastError: Error = new Error("the browser opened no page");
    while (Date.now() <= deadline) {
      try {
        return await attachToPage(client);
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : lastError;
        await delay(100);
      }
    }
    throw lastError;
  }

  private async poll(session: Session): Promise<void> {
    if (this.session !== session || session.leaving) return;
    const page = session.page;
    if (!page) return;

    try {
      const admission = await page.evaluate<string>(ADMISSION_EXPRESSION);

      // The room says the call is over, whether or not we were admitted.
      if (admission === "ended") {
        await this.end(session, "left", "the call ended");
        return;
      }

      if (!session.inRoom) {
        const expired = Date.now() >= session.admissionDeadline;
        let publishing = false;
        if (admission !== "in-room" && expired) {
          try {
            const liveness = await page.evaluate<Liveness>(LIVENESS_EXPRESSION);
            publishing = !!liveness.publishing;
          } catch {
            // The page may be gone; the failure is still reported below.
          }
        }
        const step = admissionStep({
          admission,
          publishing,
          expired,
          budgetSeconds: Math.round(this.admissionTimeoutMs / 1000),
        });

        if (step.kind === "in-room") {
          // Only the page naming the room admits the avatar. Publishing alone is
          // the pre-join preview, so it must not latch the meeting as in-room.
          session.inRoom = true;
          await this.paint(session, "in-room");
          session.input.onState({ state: "in-room" });
        } else if (step.kind === "failed") {
          this.options.logger.warn("meeting: nobody admitted the avatar", {
            project: session.input.projectName,
          });
          await this.paint(session, "failed");
          await this.shutdown(session, true);
          session.input.onState({ state: "failed", detail: step.detail });
        } else {
          // Best effort: click the room's own join control if it offers one.
          await this.tryJoin(session, page);
        }
        return;
      }

      // In the room: notice the call ending from the other side. One odd poll is
      // noise; three in a row mean the page is back at the join lobby.
      if (admission === "joining") {
        session.backInLobby += 1;
        if (session.backInLobby >= 3) {
          await this.end(session, "left", "the call ended");
          return;
        }
      } else {
        session.backInLobby = 0;
      }

      const liveness = await page.evaluate<Liveness>(LIVENESS_EXPRESSION);
      const publishing = !!liveness.publishing;
      if (!publishing && !session.faceWarned) {
        session.faceWarned = true;
        session.input.onState({ state: "in-room", detail: "face not publishing" });
      } else if (publishing && session.faceWarned) {
        session.faceWarned = false;
        session.input.onState({ state: "in-room" });
      }
    } catch {
      // A navigating page has no execution context for a moment. The next poll
      // retries; only a lost target or a dead process is terminal.
    }
  }

  /**
   * Best effort: click the room's own join control. Retried while the control is
   * disabled (the name is still being filled). A page that offers no control at
   * all is reported once, so the operator knows to join by hand.
   */
  private async tryJoin(session: Session, page: AttachedPage): Promise<void> {
    if (session.joinClicked) return;
    session.joinAttempts += 1;

    const result = await page.evaluate<{ found: boolean; clicked: boolean }>(
      JOIN_CLICK_EXPRESSION,
    );
    if (result.clicked) {
      session.joinClicked = true;
      this.options.logger.info("meeting: clicked the room's join control", {
        project: session.input.projectName,
      });
      return;
    }
    if (result.found) return; // disabled while the name fills: retry next poll

    const limit = Math.max(1, Math.round(20_000 / this.pollMs));
    if (session.joinAttempts >= limit && !session.joinWarned) {
      session.joinWarned = true;
      session.input.onState({
        state: "joining",
        detail: "could not find the join control; the name is filled — join by hand",
      });
    }
  }

  /** A lost debugging socket is terminal; the meeting must not sit silent. */
  private async onConnectionLost(session: Session): Promise<void> {
    if (this.session !== session || session.leaving || !session.ready) return;
    this.options.logger.warn("meeting: the browser connection was lost", {
      project: session.input.projectName,
    });
    await this.end(session, "failed", "the browser connection was lost");
  }

  private async onPageLost(session: Session): Promise<void> {
    if (this.session !== session || session.leaving || !session.ready) return;
    await this.end(session, "left", "the page left the room");
  }

  private async onBrowserExit(session: Session): Promise<void> {
    if (this.session !== session) return;
    if (session.timer) {
      clearInterval(session.timer);
      session.timer = undefined;
    }
    this.session = undefined;
    if (session.leaving) return;
    session.leaving = true;
    session.client?.close();
    session.client = undefined;
    if (!session.ready) {
      // A process that died during launch is reported by join()'s rejection,
      // so the operator hears "could not start" rather than "the room ended".
      return;
    }
    this.options.logger.warn("meeting: the browser exited", { project: session.input.projectName });
    session.input.onState({ state: "left", detail: "the browser exited" });
  }

  /** Report a terminal state the page caused, then clean the browser up. */
  private async end(
    session: Session,
    state: "left" | "failed",
    detail: string,
  ): Promise<void> {
    if (this.session !== session || session.leaving) return;
    session.leaving = true;
    session.input.onState({ state, detail });
    await this.shutdown(session, false);
  }

  private async paint(session: Session, state: "joining" | "in-room" | "failed"): Promise<void> {
    try {
      await session.page?.evaluate(setStateExpression(state));
    } catch {
      // The face is best-effort; the group message still carries the state.
    }
  }

  private async leave(session: Session): Promise<MeetingLeaveResult> {
    if (this.session !== session) return { closed: true };
    session.leaving = true;
    return await this.shutdown(session, true);
  }

  /**
   * Close the browser and make sure it is gone. `askBrowser` sends the protocol's
   * own close first; a process tree that outlives it is force-killed, and one
   * that survives even that is reported rather than swallowed.
   */
  private async shutdown(session: Session, askBrowser: boolean): Promise<MeetingLeaveResult> {
    session.leaving = true;
    if (session.timer) {
      clearInterval(session.timer);
      session.timer = undefined;
    }

    if (askBrowser && session.client) {
      try {
        await session.client.send("Browser.close");
      } catch {
        /* the connection may already be gone; the kill below still applies */
      }
    }

    let closed = await this.waitForExit(session.child, askBrowser ? this.leaveTimeoutMs : 0);
    if (!closed && session.child.pid) {
      killTree(session.child.pid);
      closed = await this.waitForExit(session.child, this.leaveTimeoutMs);
    }

    session.client?.close();
    session.client = undefined;
    session.page = undefined;
    if (this.session === session) this.session = undefined;

    if (!closed) {
      this.options.logger.warn("meeting: the browser may still be open", {
        project: session.input.projectName,
      });
      return { closed: false, detail: "the browser did not exit; the room may still be open" };
    }
    return { closed: true };
  }

  private waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("exit", onExit);
        resolve(value);
      };
      const onExit = (): void => finish(true);
      child.on("exit", onExit);
      const timer = setTimeout(
        () => finish(child.exitCode !== null || child.signalCode !== null),
        timeoutMs,
      );
    });
  }
}
