/**
 * The opencode plugin this package ships, and the two places opencode loads a
 * plugin from: the global `~/.config/opencode/plugins` and a project-local
 * `<cwd>/.opencode/plugins`. opencode keys a plugin by its id, so a project copy
 * of this file shadows the global one instead of living beside it.
 *
 * Everything here is pure over the filesystem, with the package root, the home
 * directory and the working directory injected, so a test can prove a conflict
 * without touching the real machine. The packaged file and its manifest are the
 * source of truth: the version comes from `package.json`, the bytes from
 * `plugins/`. A copy is `installed` only when its bytes still match the package,
 * which catches a hand-edited file that kept the old banner.
 *
 * No helper exits the process: each returns its outcome (or throws one clear
 * reason for a broken package) and `src/index.ts` prints it and owns the code.
 */
import { oneLine } from "../oneLine.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The file name opencode keys the plugin by; a second copy is a duplicate id. */
export const PLUGIN_FILE = "signal-connector.ts";

/** The packaged copy, relative to the package root (`files` in package.json). */
const PACKAGED = path.join("plugins", PLUGIN_FILE);

/**
 * The package root: the directory holding `package.json` and `plugins/`. It is
 * two levels up from this module, which is `src/cli/plugin.ts` in a checkout and
 * `dist/cli/plugin.js` in the published package — both resolve to the root.
 */
export function packageRoot(): string {
  return fileURLToPath(new URL("../..", import.meta.url));
}

/** Where the global copy goes. Spelled the way opencode reads it on every OS. */
export function pluginsDir(home: string): string {
  return path.join(home, ".config", "opencode", "plugins");
}

/** A project-local copy of the same file, which opencode would load as well. */
export function projectPlugin(cwd: string): string {
  return path.join(cwd, ".opencode", "plugins", PLUGIN_FILE);
}

/** The three directories a helper needs; tests pass temp ones, the CLI real ones. */
export interface PluginPaths {
  /** The package root: holds `package.json` and `plugins/`. */
  root: string;
  /** The operator's home directory, under which the global copy lives. */
  home: string;
  /** Where the command ran; a project-local copy here shadows the global one. */
  cwd: string;
}

export type PluginState = "installed" | "stale" | "absent" | "conflict";

/** The comparison result `plugin status` prints, with the CLI's exit code. */
export interface PluginStatus {
  state: PluginState;
  /** The packaged version, from `package.json`. */
  version: string;
  /** The global install target, whether or not it exists. */
  path: string;
  /** Present only for a conflict: the project copy that shadows the global one. */
  conflict?: string;
  /** 0 only when installed, so `status` can be used in a script. */
  code: number;
}

/** What `plugin install` did. `code` is the CLI exit code, never a process exit. */
export interface PluginInstall {
  code: number;
  /** One line for the operator: what was written, or why nothing was. */
  message: string;
  status: PluginStatus;
}

/** Reports stay one line even when a filesystem error is multi-line. */
/**
 * The bytes at `file`, or undefined when it does not exist. Any other failure is
 * a real problem (a directory in its place, a denied read) and is rethrown with
 * the path attached, so no caller has to guess where it happened.
 */
function bytesOrUndefined(file: string): Buffer | undefined {
  try {
    return fs.readFileSync(file);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // A parent that is a file means the path cannot exist either (ENOTDIR); it
    // is a missing install, not a read failure worth throwing at the operator.
    if ((err as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
    throw new Error(`cannot read ${file}: ${oneLine(err)}`);
  }
}

/** The version opencode users will see, read from the packaged manifest. */
function packageVersion(root: string): string {
  const manifest = path.join(root, "package.json");
  const raw = bytesOrUndefined(manifest);
  if (raw === undefined) {
    throw new Error(`the package manifest is missing: ${manifest}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (err: unknown) {
    throw new Error(`the package manifest is not valid JSON: ${manifest} (${oneLine(err)})`);
  }
  const version = (parsed as { version?: unknown } | null)?.version;
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error(`the package manifest has no version: ${manifest}`);
  }
  return version;
}

/** The packaged plugin's bytes; a package without it cannot be installed. */
function packagedBytes(root: string): Buffer {
  const source = path.join(root, PACKAGED);
  const bytes = bytesOrUndefined(source);
  if (bytes === undefined) {
    throw new Error(`the packaged plugin is missing: ${source} — reinstall signal-connector`);
  }
  return bytes;
}

/**
 * Read-only: compares the installed copy with the packaged one and names a
 * project copy that shadows it. Never writes, and never creates the plugins
 * directory just to look inside it.
 *
 * A conflict wins over `installed`: when both copies exist opencode loads both,
 * so the pair is the problem the operator has to fix first.
 */
export function pluginStatus(paths: PluginPaths): PluginStatus {
  const version = packageVersion(paths.root);
  const packaged = packagedBytes(paths.root);
  const target = path.join(pluginsDir(paths.home), PLUGIN_FILE);

  const conflict = projectPlugin(paths.cwd);
  if (bytesOrUndefined(conflict) !== undefined) {
    return { state: "conflict", version, path: target, conflict, code: 1 };
  }

  const installed = bytesOrUndefined(target);
  if (installed === undefined) {
    return { state: "absent", version, path: target, code: 1 };
  }
  const state: PluginState = packaged.equals(installed) ? "installed" : "stale";
  return { state, version, path: target, code: state === "installed" ? 0 : 1 };
}

/**
 * Copies the packaged file into the global plugins directory, creating that
 * directory and nothing else. Idempotent: a byte-identical copy is left alone
 * (a rewrite would bump its mtime and look like an upgrade), a stale copy is
 * replaced, and a project-local copy is refused rather than overwritten or
 * deleted.
 */
export function installPlugin(paths: PluginPaths): PluginInstall {
  const status = pluginStatus(paths);

  if (status.state === "conflict") {
    return {
      code: 1,
      status,
      message: `refusing to install: ${status.conflict} shadows the global plugin; remove that copy first`,
    };
  }
  if (status.state === "installed") {
    return {
      code: 0,
      status,
      message: `plugin ${status.version} is already installed at ${status.path}`,
    };
  }

  try {
    fs.mkdirSync(pluginsDir(paths.home), { recursive: true });
    fs.writeFileSync(status.path, packagedBytes(paths.root));
  } catch (err: unknown) {
    return {
      code: 1,
      status,
      message: `could not install the plugin at ${status.path}: ${oneLine(err)}`,
    };
  }
  return {
    code: 0,
    status,
    message: `plugin ${status.version} installed at ${status.path}`,
  };
}

/**
 * The one-line report `plugin status` prints: the state and the version first,
 * then the path — or, for a conflict, the project copy to remove.
 */
export function describeStatus(status: PluginStatus): string {
  switch (status.state) {
    case "installed":
      return `plugin installed ${status.version} (${status.path})`;
    case "stale":
      return `plugin stale ${status.version} (${status.path}) — the packaged file changed; run "signal-connector plugin install"`;
    case "absent":
      return `plugin absent ${status.version} (${status.path}) — run "signal-connector plugin install"`;
    case "conflict":
      return `plugin conflict ${status.version} — ${status.conflict} shadows ${status.path}; remove that copy`;
  }
}
