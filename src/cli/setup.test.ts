import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  meetsNodeFloor,
  NODE_FLOOR,
  nodeVersionStep,
  registry,
  runDoctor,
  runSetup,
  type Print,
  type SetupStep,
  type StepReport,
} from "./setup.js";

/** A step whose behaviour each test scripts inline. */
function stepOf(id: string, check: () => StepReport, apply?: () => void): SetupStep {
  return { id, title: id, check, ...(apply ? { apply } : {}) };
}

function sink(): { print: Print; output: string[] } {
  const output: string[] = [];
  return { output, print: (line) => output.push(line) };
}

const ctx = { print: (): void => {} };

/** Every file and directory under `root`, with size, mtime and contents. */
function snapshot(root: string): string[] {
  const entries: string[] = [];
  const walk = (dir: string): void => {
    const children = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of children) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        entries.push(`D ${rel}`);
        walk(full);
      } else {
        const stat = fs.statSync(full);
        entries.push(`F ${rel} ${stat.size} ${stat.mtimeMs} ${fs.readFileSync(full, "utf8")}`);
      }
    }
  };
  walk(root);
  return entries;
}

describe("runDoctor", () => {
  it("prints one line per step in registry order and exits 0 when all are ok", async () => {
    const { print, output } = sink();
    const code = await runDoctor(
      [
        stepOf("alpha", () => ({ status: "ok", reason: "fine" })),
        stepOf("beta", () => ({ status: "ok", reason: "also fine" })),
      ],
      print,
    );

    expect(code).toBe(0);
    expect(output).toHaveLength(2);
    expect(output[0]).toContain("alpha");
    expect(output[0]).toContain("fine");
    expect(output[1]).toContain("beta");
    expect(output[1]).toContain("also fine");
  });

  it("names a missing step's reason and fix, exits 1, and still checks later steps", async () => {
    const { print, output } = sink();
    const code = await runDoctor(
      [
        stepOf("ready", () => ({ status: "ok", reason: "ready" })),
        stepOf("absent", () => ({
          status: "missing",
          reason: "not installed",
          fix: "run install-absent",
        })),
        stepOf("later", () => ({ status: "ok", reason: "ready too" })),
      ],
      print,
    );

    expect(code).toBe(1);
    expect(output[1]).toContain("missing");
    expect(output[1]).toContain("not installed");
    expect(output[1]).toContain("fix: run install-absent");
    expect(output).toHaveLength(3);
    expect(output[2]).toContain("later");
  });

  it("treats a throwing check as failed, without a stack, and keeps going", async () => {
    const { print, output } = sink();
    const code = await runDoctor(
      [
        stepOf("broken", () => {
          throw new Error("boom");
        }),
        stepOf("after", () => ({ status: "ok", reason: "fine" })),
      ],
      print,
    );

    expect(code).toBe(1);
    expect(output[0]).toContain("failed");
    expect(output[0]).toContain("boom");
    expect(output[0]).not.toContain("setup.test");
    expect(output[1]).toContain("after");
  });

  it("reports an empty registry without failing", async () => {
    const { print, output } = sink();
    const code = await runDoctor([], print);

    expect(code).toBe(0);
    expect(output).toHaveLength(1);
    expect(output[0]).toContain("no setup steps are registered");
  });

  it("changes nothing between runs", async () => {
    let checks = 0;
    const step = stepOf("counted", () => {
      checks++;
      return { status: "ok", reason: "fine" };
    });
    const first = sink();
    const second = sink();

    expect(await runDoctor([step], first.print)).toBe(0);
    expect(await runDoctor([step], second.print)).toBe(0);
    expect(first.output).toEqual(second.output);
    expect(checks).toBe(2);
  });

  it("never applies a step and never creates or changes a file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-connector-doctor-"));
    try {
      fs.writeFileSync(path.join(root, "sentinel.txt"), "unchanged");
      fs.mkdirSync(path.join(root, "nested"));
      fs.writeFileSync(path.join(root, "nested", "state.db"), "not really a database");
      const before = snapshot(root);

      const print = vi.fn<Print>();
      let applied = 0;
      const write = (): void => {
        applied++;
        fs.writeFileSync(path.join(root, "applied.txt"), "should not exist");
      };
      const code = await runDoctor(
        [
          stepOf("ready", () => ({ status: "ok", reason: "fine" }), write),
          stepOf("absent", () => ({ status: "missing", reason: "absent", fix: "install it" }), write),
        ],
        print,
      );

      expect(code).toBe(1);
      expect(applied).toBe(0);
      expect(print).toHaveBeenCalledTimes(2);
      expect(print.mock.calls.some(([line]) => line.startsWith("apply"))).toBe(false);
      expect(snapshot(root)).toEqual(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runSetup", () => {
  it("skips a satisfied step and never applies it", async () => {
    const { print, output } = sink();
    let applied = 0;
    const code = await runSetup(
      [stepOf("ready", () => ({ status: "ok", reason: "already fine" }), () => applied++)],
      print,
    );

    expect(code).toBe(0);
    expect(applied).toBe(0);
    expect(output[0]).toContain("skip");
    expect(output[0]).toContain("already fine");
    expect(output.at(-1)).toContain("all steps satisfied");
  });

  it("applies a missing step, re-checks it, and is a no-op on the second run", async () => {
    let installed = false;
    let applied = 0;
    const step = stepOf(
      "installable",
      () => (installed ? { status: "ok", reason: "installed" } : { status: "missing", reason: "absent" }),
      () => {
        applied++;
        installed = true;
      },
    );

    const first = sink();
    expect(await runSetup([step], first.print)).toBe(0);
    expect(applied).toBe(1);
    expect(first.output[0]).toContain("apply");
    expect(first.output[1]).toContain("ok");
    expect(first.output[1]).toContain("installed");

    const second = sink();
    expect(await runSetup([step], second.print)).toBe(0);
    expect(applied).toBe(1);
    expect(second.output[0]).toContain("skip");
    expect(second.output.some((line) => line.startsWith("apply"))).toBe(false);
  });

  it("stops at the first failure and resumes there on the next run", async () => {
    let installed = false;
    let installerFails = true;
    const applied: string[] = [];
    const steps = [
      stepOf("one", () => ({ status: "ok", reason: "ready" }), () => applied.push("one")),
      stepOf("two", () => ({ status: "ok", reason: "ready" }), () => applied.push("two")),
      stepOf(
        "three",
        () => (installed ? { status: "ok", reason: "ready" } : { status: "missing", reason: "absent" }),
        () => {
          if (installerFails) throw new Error("installer unavailable");
          installed = true;
          applied.push("three");
        },
      ),
    ];

    const first = sink();
    expect(await runSetup(steps, first.print)).toBe(1);
    expect(applied).toEqual([]);
    expect(first.output.some((line) => line.includes("installer unavailable"))).toBe(true);
    expect(first.output.some((line) => line.includes('setup stopped at "three"'))).toBe(true);
    expect(first.output.some((line) => line.startsWith("ok") && line.includes("three"))).toBe(false);

    installerFails = false;
    const second = sink();
    expect(await runSetup(steps, second.print)).toBe(0);
    expect(applied).toEqual(["three"]);
    expect(second.output[0]).toContain("skip");
    expect(second.output[1]).toContain("skip");
    expect(second.output[2]).toContain("apply");
  });

  it("keeps the check's fix when apply throws", async () => {
    const { print, output } = sink();
    const code = await runSetup(
      [
        stepOf(
          "failing",
          () => ({ status: "missing", reason: "absent", fix: "run install-failing" }),
          () => {
            throw new Error("installer exploded");
          },
        ),
      ],
      print,
    );

    expect(code).toBe(1);
    const line = output.find((entry) => entry.includes("absent"));
    expect(line).toContain("failed");
    expect(line).toContain("installer exploded");
    expect(line).toContain("fix: run install-failing");
    expect(output.at(-1)).toContain('setup stopped at "failing"');
  });

  it("reports a missing step that has no apply, with its fix, and stops", async () => {
    const { print, output } = sink();
    let laterChecks = 0;
    const code = await runSetup(
      [
        stepOf("manual", () => ({
          status: "missing",
          reason: "needs a manual install",
          fix: "follow https://example.test/install",
        })),
        stepOf("later", () => {
          laterChecks++;
          return { status: "ok", reason: "fine" };
        }),
      ],
      print,
    );

    expect(code).toBe(1);
    expect(laterChecks).toBe(0);
    expect(output[0]).toContain("needs a manual install");
    expect(output[0]).toContain("follow https://example.test/install");
  });

  it("fails when apply returns but the check is still missing", async () => {
    const { print, output } = sink();
    const code = await runSetup(
      [
        stepOf(
          "stuck",
          () => ({ status: "missing", reason: "still absent", fix: "fix it by hand" }),
          () => {},
        ),
      ],
      print,
    );

    expect(code).toBe(1);
    expect(output[0]).toContain("apply");
    expect(output[1]).toContain("failed");
    expect(output[1]).toContain("still absent");
    expect(output[1]).toContain("fix: fix it by hand");
  });

  it("fails without applying when the check itself throws", async () => {
    const { print, output } = sink();
    let applied = 0;
    const code = await runSetup(
      [
        stepOf(
          "broken",
          () => {
            throw new Error("cannot check");
          },
          () => applied++,
        ),
      ],
      print,
    );

    expect(code).toBe(1);
    expect(applied).toBe(0);
    expect(output[0]).toContain("failed");
    expect(output[0]).toContain("cannot check");
  });

  it("reports an empty registry and exits 0", async () => {
    const { print, output } = sink();
    expect(await runSetup([], print)).toBe(0);
    expect(output[0]).toContain("no setup steps are registered");
  });
});

describe("registry", () => {
  it("starts with the Node step, in a stable order with unique ids", () => {
    const steps = registry();
    expect(steps.map((step) => step.id)).toEqual(["node-version"]);
    expect(new Set(steps.map((step) => step.id)).size).toBe(steps.length);
  });

  it("keeps the Node floor in step with engines.node in package.json", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { engines?: { node?: string } };
    const floor = /(\d+\.\d+\.\d+)/.exec(manifest.engines?.node ?? "")?.[1];
    expect(floor).toBe(NODE_FLOOR);
  });
});

describe("nodeVersionStep", () => {
  it("reports the running Node version as ok", () => {
    const report = nodeVersionStep.check(ctx);
    expect(report.status).toBe("ok");
    expect(report.reason).toContain(process.versions.node);
    expect(report.fix).toBeUndefined();
  });

  it("compares dotted versions", () => {
    expect(meetsNodeFloor("22.13.0")).toBe(true);
    expect(meetsNodeFloor("22.13.1")).toBe(true);
    expect(meetsNodeFloor("24.0.0")).toBe(true);
    expect(meetsNodeFloor("22.12.9")).toBe(false);
    expect(meetsNodeFloor("20.19.0")).toBe(false);
    expect(meetsNodeFloor("22.13.0", "22.13.0")).toBe(true);
  });
});
