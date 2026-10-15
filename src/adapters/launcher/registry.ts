/**
 * Picks the launcher for a project from its config, so the core depends on one
 * LauncherPort and knows nothing about Herdr or command templates.
 */
import type { Config } from "../../config/config.js";
import type { LauncherPort, LaunchResult } from "../../core/ports.js";
import type { Project } from "../../domain/types.js";
import type { Logger } from "../../logging/logger.js";
import { CommandLauncher } from "./command.js";
import { HerdrLauncher } from "./herdr.js";

export function projectIdFor(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

export class ProjectLaunchers implements LauncherPort {
  private readonly byProject = new Map<string, LauncherPort>();

  constructor(config: Config, logger: Logger) {
    for (const entry of config.projects) {
      if (!entry.launch) continue;
      const port: LauncherPort =
        entry.launch.kind === "command"
          ? new CommandLauncher({ argv: entry.launch.argv ?? [], logger })
          : new HerdrLauncher({ kind: entry.launch.agent, logger });
      this.byProject.set(projectIdFor(entry.name), port);
    }
  }

  launch(project: Project): Promise<LaunchResult> {
    const port = this.byProject.get(project.id);
    if (!port) return Promise.resolve({ started: false, detail: "no launch command configured" });
    return port.launch(project);
  }
}
