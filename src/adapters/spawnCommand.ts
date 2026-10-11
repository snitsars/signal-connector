/**
 * Cross-platform command resolution. On Windows a bare name (e.g. `opencode`)
 * or a `.bat`/`.cmd` script must run through the shell; Node cannot exec them
 * directly. On other platforms the command is passed through untouched.
 */
export interface ResolvedCommand {
  command: string;
  args: string[];
  shell: boolean;
}

function quoteWin(value: string): string {
  if (value === "") return '""';
  if (/[\s"&|<>^()%!]/.test(value)) return `"${value.replace(/"/g, '\\"')}"`;
  return value;
}

export function resolveCommand(
  executable: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): ResolvedCommand {
  if (platform === "win32") {
    const isScript = /\.(bat|cmd|ps1)$/i.test(executable);
    const isBareName = !/[\\/]/.test(executable);
    if (isScript || isBareName) {
      const command = [executable, ...args].map(quoteWin).join(" ");
      return { command, args: [], shell: true };
    }
  }
  return { command: executable, args, shell: false };
}
