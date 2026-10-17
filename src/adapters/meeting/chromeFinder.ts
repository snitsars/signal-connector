/**
 * Finds the Chromium-based browser the avatar can drive: Chrome first, Edge as
 * the fallback, at the standard install locations for this platform. Pure apart
 * from the injected existence check, so the decision is testable without either
 * browser being installed.
 */
import fs from "node:fs";
import path from "node:path";

export type BrowserKind = "chrome" | "edge";

export interface FoundBrowser {
  kind: BrowserKind;
  path: string;
}

export type BrowserLookup = { browser: FoundBrowser } | { reason: string };

export interface BrowserProbeOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Defaults to fs.existsSync; tests inject a pretend filesystem. */
  exists?: (candidate: string) => boolean;
}

function envValue(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value) return value;
  }
  return undefined;
}

/** Standard install locations, most likely first, for the given platform. */
export function candidatePaths(
  kind: BrowserKind,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === "win32") {
    const join = path.win32.join;
    const programFiles =
      envValue(env, "ProgramFiles", "PROGRAMFILES") ?? "C:\\Program Files";
    const programFilesX86 =
      envValue(env, "ProgramFiles(x86)", "PROGRAMFILES_X86", "ProgramFiles(X86)") ??
      "C:\\Program Files (x86)";
    const localAppData = envValue(env, "LOCALAPPDATA", "LocalAppData");

    if (kind === "chrome") {
      const paths = [
        join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
        join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      ];
      if (localAppData) {
        paths.push(join(localAppData, "Google", "Chrome", "Application", "chrome.exe"));
      }
      return paths;
    }
    return [
      join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    ];
  }

  if (platform === "darwin") {
    return kind === "chrome"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"];
  }

  return kind === "chrome"
    ? ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"]
    : ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"];
}

/**
 * The first installed browser, Chrome before Edge. A missing browser is a
 * refusal with a reason, never a crash.
 */
export function findBrowser(options: BrowserProbeOptions = {}): BrowserLookup {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? ((candidate: string) => fs.existsSync(candidate));

  for (const kind of ["chrome", "edge"] as const) {
    for (const candidate of candidatePaths(kind, platform, env)) {
      if (exists(candidate)) return { browser: { kind, path: candidate } };
    }
  }
  return { reason: "neither Chrome nor Edge was found on this machine" };
}
