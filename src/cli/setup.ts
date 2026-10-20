/**
 * The shared setup contract. A `SetupStep` is one checkable prerequisite:
 * `doctor` only reports it, `setup` also applies it when it is missing.
 *
 * Both runners are pure apart from the print sink they are given: they never
 * touch config, the store, the secret store or the daemon, so a diagnostic can
 * never change the machine it describes. Each returns the exit code; only the
 * composition root (`src/index.ts`) calls `process.exit`.
 */
import { oneLine } from "../oneLine.js";
import os from "node:os";
import { linkStep } from "./configure.js";
import { installPlugin, packageRoot, pluginStatus, type PluginPaths } from "./plugin.js";
import {
  configStep,
  dataDirStep,
  javaStep,
  opencodeStep,
  secretsStep,
  signalCliStep,
} from "./steps.js";

export type StepStatus = "ok" | "missing" | "failed";

/** The one-line result of checking a step. `fix` is the exact thing to do. */
export interface StepReport {
  status: StepStatus;
  reason: string;
  fix?: string;
}

/**
 * The config fields the prerequisite steps read. The loader's full `Config` is
 * assignable to it, so `setup.ts` never imports config or touches disk.
 */
export interface SetupConfig {
  signal: {
    cliPath: string;
    command?: string[];
    /** The linked number; a config without it is not ready to run. */
    account?: string;
  };
  agent: {
    opencodePath: string;
  };
}

/** Why there is no usable config: absent is a setup problem, invalid is not. */
export interface ConfigProblem {
  absent: boolean;
  reason: string;
}

/** The read-only outcome `readConfig` produces, structurally. */
export type ConfigRead =
  | { ok: true; config: SetupConfig }
  | { ok: false; absent: boolean; reason: string };

/** What a step may use while it runs. Deliberately no store and no side effects. */
export interface StepContext {
  /** Writes one progress line through the runner's sink. */
  print(line: string): void;
  /** The data directory the daemon would use; steps never create it. */
  dataDir: string;
  /** Present only when config.toml exists and validates. */
  config?: SetupConfig;
  /** Present only when config.toml is absent or invalid. */
  configProblem?: ConfigProblem;
}

/** Composes the context once, so doctor/setup and the daemon agree on it. */
export function stepContext(dataDir: string, read: ConfigRead, print: Print): StepContext {
  if (read.ok) {
    return { print, dataDir, config: read.config };
  }
  return { print, dataDir, configProblem: { absent: read.absent, reason: read.reason } };
}

export interface SetupStep {
  /** Stable, human-readable id; the registry order is the run order. */
  readonly id: string;
  readonly title: string;
  check(ctx: StepContext): StepReport | Promise<StepReport>;
  /** Omitted when the step cannot be fixed automatically (e.g. Node itself). */
  apply?(ctx: StepContext): void | Promise<void>;
}

export type Print = (line: string) => void;

const STATUS_WIDTH = 7;
const ID_WIDTH = 14;

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** Reports must stay one line even when a shell or network error is multi-line. */
function reasonOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const reason = oneLine(text);
  return reason.length > 0 ? reason : "unknown error";
}

/**
 * Prints one report line. `label` defaults to the report's status so a caller
 * can say "failed" for a missing step that could not be repaired.
 */
export function printReport(
  step: SetupStep,
  report: StepReport,
  print: Print,
  label: string = report.status,
): void {
  const fix = report.fix ? ` — fix: ${oneLine(report.fix)}` : "";
  print(`${pad(label, STATUS_WIDTH)} ${pad(step.id, ID_WIDTH)} ${oneLine(report.reason)}${fix}`);
}

async function checkStep(step: SetupStep, ctx: StepContext): Promise<StepReport> {
  try {
    return await step.check(ctx);
  } catch (err: unknown) {
    // A throwing check is a failed step, not a crash: the other steps still run.
    return { status: "failed", reason: reasonOf(err) };
  }
}

/**
 * Read-only: checks every step in registry order and exits non-zero when any
 * step is missing or failed. Nothing is applied and nothing is written.
 */
export async function runDoctor(steps: readonly SetupStep[], ctx: StepContext): Promise<number> {
  if (steps.length === 0) {
    ctx.print("no setup steps are registered.");
    return 0;
  }

  let healthy = true;
  for (const step of steps) {
    const report = await checkStep(step, ctx);
    printReport(step, report, ctx.print);
    if (report.status !== "ok") healthy = false;
  }
  return healthy ? 0 : 1;
}

/**
 * Resumable and idempotent: satisfied steps are skipped, missing ones with an
 * `apply` are applied and re-checked, and the run stops at the first failure so
 * a rerun resumes exactly there.
 */
export async function runSetup(steps: readonly SetupStep[], ctx: StepContext): Promise<number> {
  if (steps.length === 0) {
    ctx.print("no setup steps are registered; nothing to do.");
    return 0;
  }

  const { print } = ctx;
  for (const step of steps) {
    const before = await checkStep(step, ctx);
    if (before.status === "ok") {
      printReport(step, before, print, "skip");
      continue;
    }
    if (before.status === "failed" || step.apply === undefined) {
      printReport(step, before, print);
      print(`setup stopped at "${step.id}"; fix it and run setup again.`);
      return 1;
    }

    print(`apply   ${pad(step.id, ID_WIDTH)} ${step.title}`);
    try {
      await step.apply(ctx);
    } catch (err: unknown) {
      // Keep the check's fix: the apply error alone would leave the operator
      // without the guidance that the step already knows.
      printReport(
        step,
        { ...before, status: "failed", reason: `${before.reason} — apply failed: ${reasonOf(err)}` },
        print,
      );
      print(`setup stopped at "${step.id}"; fix it and run setup again.`);
      return 1;
    }

    // Trust the check, not the apply: a step that ran without error but left
    // the prerequisite unmet is still a failure.
    const after = await checkStep(step, ctx);
    if (after.status !== "ok") {
      printReport(step, after, print, "failed");
      print(`setup stopped at "${step.id}"; fix it and run setup again.`);
      return 1;
    }
    printReport(step, after, print);
  }
  print("setup: all steps satisfied.");
  return 0;
}

/**
 * The floor taken from `engines.node` in package.json. Kept as a constant so a
 * check never reads the manifest; setup.test.ts fails if the two drift apart.
 */
export const NODE_FLOOR = "22.13.0";

function versionParts(version: string): [number, number, number] {
  const [major, minor, patch] = version
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  return [major ?? 0, minor ?? 0, patch ?? 0];
}

/** True when `actual` is at least `floor` (a plain dotted numeric version). */
export function meetsNodeFloor(actual: string, floor: string = NODE_FLOOR): boolean {
  const a = versionParts(actual);
  const f = versionParts(floor);
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0;
    const fv = f[i] ?? 0;
    if (av !== fv) return av > fv;
  }
  return true;
}

/** The one prerequisite that already exists: the runtime doing the checking. */
export const nodeVersionStep: SetupStep = {
  id: "node-version",
  title: "Node.js",
  check: () => {
    const version = process.versions.node;
    if (meetsNodeFloor(version)) {
      return { status: "ok", reason: `Node.js ${version} (needs >= ${NODE_FLOOR})` };
    }
    return {
      status: "missing",
      reason: `Node.js ${version} is older than ${NODE_FLOOR}`,
      fix: `install Node.js ${NODE_FLOOR} or newer from https://nodejs.org/en/download`,
    };
  },
};

/**
 * The opencode plugin. The check is `plugin status`, the apply is
 * `plugin install` — the same helpers the commands use, so a step can never
 * disagree with what the CLI would do. Paths default to this machine's; a test
 * passes temp ones.
 */
export function pluginStep(env: Partial<PluginPaths> = {}): SetupStep {
  const paths = (): PluginPaths => ({
    root: env.root ?? packageRoot(),
    home: env.home ?? os.homedir(),
    cwd: env.cwd ?? process.cwd(),
  });

  return {
    id: "plugin",
    title: "opencode plugin",
    check: () => {
      const status = pluginStatus(paths());
      switch (status.state) {
        case "installed":
          return {
            status: "ok",
            reason: `signal-connector ${status.version} is installed at ${status.path}`,
          };
        case "absent":
          return {
            status: "missing",
            reason: `${status.path} does not exist`,
            fix: 'run "signal-connector plugin install"',
          };
        case "stale":
          return {
            status: "missing",
            reason: `${status.path} differs from the packaged copy of ${status.version}`,
            fix: 'run "signal-connector plugin install"',
          };
        case "conflict":
          // Applying would either double the plugin or destroy the operator's
          // copy, so this is a failure the step refuses to repair on its own.
          return {
            status: "failed",
            reason: `${status.conflict} shadows the global plugin`,
            fix: `remove ${status.conflict}, then run "signal-connector plugin install"`,
          };
      }
    },
    apply: () => {
      const install = installPlugin(paths());
      if (install.code !== 0) throw new Error(install.message);
    },
  };
}

/**
 * The ordered product registry. Later stories append their steps; order and ids
 * are decisions in code, never something a half-written config could drop.
 */
export function registry(): readonly SetupStep[] {
  return [
    nodeVersionStep,
    dataDirStep(),
    javaStep(),
    signalCliStep(),
    opencodeStep(),
    linkStep(),
    configStep(),
    secretsStep(),
    pluginStep(),
  ];
}
