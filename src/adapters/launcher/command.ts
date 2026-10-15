/**
 * Launch a project by running a configured command, e.g. a terminal that opens
 * opencode in the project directory. `{path}` and `{name}` are substituted.
 */
import { spawn } from "node:child_process";
import type { LauncherPort, LaunchResult } from "../../core/ports.js";
import type { Project } from "../../domain/types.js";
import type { Logger } from "../../logging/logger.js";
import { resolveCommand } from "../spawnCommand.js";

export interface CommandLauncherOptions {
  argv: string[];
  timeoutMs?: number;
  logger: Logger;
}

/** Substitute the project's placeholders into a configured argv. */
export function expandArgv(argv: string[], project: Project): string[] {
  return argv.map((part) => part.replaceAll("{path}", project.path).replaceAll("{name}", project.name));
}

export class CommandLauncher implements LauncherPort {
  constructor(private readonly opts: CommandLauncherOptions) {}

  async launch(project: Project): Promise<LaunchResult> {
    const argv = expandArgv(this.opts.argv, project);
    const [executable, ...args] = argv;
    if (!executable) return { started: false, detail: "no launch command configured" };

    const resolved = resolveCommand(executable, args);
    return await new Promise<LaunchResult>((resolve) => {
      try {
        const child = spawn(resolved.command, resolved.args, {
          shell: resolved.shell,
          windowsHide: true,
          detached: true,
          stdio: "ignore",
          timeout: this.opts.timeoutMs ?? 15_000,
        });
        child.on("error", (err) =>
          resolve({ started: false, detail: String(err).slice(0, 200) }),
        );
        // A window that stays open is the success case, so do not wait for exit.
        child.unref();
        this.opts.logger.info("launched project", { project: project.name, command: executable });
        resolve({ started: true, detail: argv.join(" ").slice(0, 200) });
      } catch (err) {
        resolve({ started: false, detail: String(err).slice(0, 200) });
      }
    });
  }
}
