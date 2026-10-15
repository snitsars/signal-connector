/**
 * Launch a project as a visible Herdr workspace: reuse the workspace that
 * already hosts the project's agent when there is one, otherwise create a
 * workspace focused on the project directory and start opencode in its root
 * pane. Herdr answers its CLI with JSON, so identifiers are read from the
 * response rather than predicted (AD-1: the core only sees the LauncherPort).
 */
import { spawn } from "node:child_process";
import type { LauncherPort, LaunchResult } from "../../core/ports.js";
import type { Project } from "../../domain/types.js";
import type { Logger } from "../../logging/logger.js";
import { resolveCommand } from "../spawnCommand.js";

export interface HerdrLauncherOptions {
  /** Agent kind Herdr starts; opencode is what the bridge expects. */
  kind?: string;
  /** Herdr executable, default `herdr` from PATH. */
  command?: string;
  timeoutMs?: number;
  logger: Logger;
}

export interface HerdrAgentRef {
  name?: string;
  cwd?: string;
  workspaceID?: string;
  /** The opencode session this pane's TUI is attached to, if Herdr saw one. */
  sessionID?: string;
}

/** Ids reported by `herdr workspace create`. */
export function parseWorkspaceCreate(stdout: string): { workspaceID?: string; paneID?: string } {
  try {
    const parsed = JSON.parse(stdout) as {
      result?: {
        workspace?: { workspace_id?: string };
        root_pane?: { pane_id?: string };
      };
    };
    const workspaceID = parsed.result?.workspace?.workspace_id;
    const paneID = parsed.result?.root_pane?.pane_id;
    return {
      ...(workspaceID ? { workspaceID } : {}),
      ...(paneID ? { paneID } : {}),
    };
  } catch {
    return {};
  }
}

/** The live agents Herdr reports, from `herdr agent list`. */
export function parseAgentList(stdout: string): HerdrAgentRef[] {
  try {
    const parsed = JSON.parse(stdout) as {
      result?: {
        agents?: {
          name?: string;
          cwd?: string;
          workspace_id?: string;
          agent_session?: { value?: string };
        }[];
      };
    };
    return (parsed.result?.agents ?? []).map((agent) => {
      const session = agent.agent_session?.value;
      return {
        ...(typeof agent.name === "string" ? { name: agent.name } : {}),
        ...(typeof agent.cwd === "string" ? { cwd: agent.cwd } : {}),
        ...(typeof agent.workspace_id === "string" ? { workspaceID: agent.workspace_id } : {}),
        ...(typeof session === "string" && session.startsWith("ses")
          ? { sessionID: session }
          : {}),
      };
    });
  } catch {
    return [];
  }
}

/** Compare project paths as Herdr reports them (trailing slash, separators, case). */
export function sameCwd(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const norm = (value: string): string =>
    value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/** Herdr requires agent names matching [a-z][a-z0-9_-]{0,31} and unique. */
export function herdrAgentName(project: Project): string {
  const name = project.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/, "");
  return (name.length > 0 ? name : "agent").slice(0, 32);
}

/** A free agent name: the plain one, else `-2`, `-3`, … */
export function freeAgentName(taken: string[], base: string): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const suffix = `-${i}`;
    const candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return base;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export class HerdrLauncher implements LauncherPort {
  constructor(private readonly opts: HerdrLauncherOptions) {}

  async launch(project: Project): Promise<LaunchResult> {
    const agents = parseAgentList((await this.run(["agent", "list"])).stdout);

    // Already open somewhere: bring that workspace forward instead of stacking
    // another one (and colliding on the agent name).
    const open = agents.find((agent) => agent.workspaceID && sameCwd(agent.cwd, project.path));
    if (open?.workspaceID) {
      const focused = await this.run(["workspace", "focus", open.workspaceID]);
      if (focused.code === 0) {
        this.opts.logger.info("focused project workspace", {
          project: project.name,
          workspace: open.workspaceID,
        });
        return {
          started: true,
          detail: open.sessionID
            ? `following the session you have open (${open.sessionID})`
            : "already open, but its window has no session yet — open one and I'll follow it",
          ...(open.sessionID ? { sessionId: open.sessionID } : {}),
        };
      }
    }

    const created = await this.run([
      "workspace",
      "create",
      "--cwd",
      project.path,
      "--label",
      project.name,
      "--focus",
    ]);
    if (created.code !== 0) {
      return { started: false, detail: `herdr workspace create failed: ${this.why(created)}` };
    }
    const { workspaceID, paneID } = parseWorkspaceCreate(created.stdout);
    if (!paneID) {
      return { started: false, detail: "herdr did not report a pane id" };
    }

    const name = freeAgentName(
      agents.map((agent) => agent.name).filter((entry): entry is string => Boolean(entry)),
      herdrAgentName(project),
    );
    const started = await this.run([
      "agent",
      "start",
      name,
      "--kind",
      this.opts.kind ?? "opencode",
      "--pane",
      paneID,
    ]);
    if (started.code !== 0) {
      // Never leave an empty workspace behind.
      if (workspaceID) await this.run(["workspace", "close", workspaceID]);
      return { started: false, detail: `herdr agent start failed: ${this.why(started)}` };
    }

    this.opts.logger.info("launched project", { project: project.name, pane: paneID, agent: name });
    return { started: true, detail: `new workspace ${workspaceID ?? "?"}, agent ${name}` };
  }

  private why(result: RunResult): string {
    const text = (result.stderr || result.stdout).trim().replace(/\s+/g, " ");
    return text.slice(0, 200) || `exit code ${result.code}`;
  }

  private run(args: string[]): Promise<RunResult> {
    const { command, args: resolved, shell } = resolveCommand(this.opts.command ?? "herdr", args);
    return new Promise((resolve) => {
      const child = spawn(command, resolved, {
        shell,
        windowsHide: true,
        timeout: this.opts.timeoutMs ?? 60_000,
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", (err) => resolve({ code: null, stdout, stderr: String(err) }));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }
}
