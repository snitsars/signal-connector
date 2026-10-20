import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema, loadConfig, readConfig } from "./config.js";

describe("meeting budgets", () => {
  it("defaults the silence, activity and telemetry budgets", () => {
    const config = ConfigSchema.parse({});
    expect(config.meeting).toEqual({
      silenceBudgetMs: 5_000,
      activityWindowMs: 30_000,
      telemetryMs: 5_000,
    });
  });

  it("keeps configured budgets", () => {
    const config = ConfigSchema.parse({
      meeting: { silenceBudgetMs: 2_000, activityWindowMs: 60_000, telemetryMs: 1_000 },
    });
    expect(config.meeting).toEqual({
      silenceBudgetMs: 2_000,
      activityWindowMs: 60_000,
      telemetryMs: 1_000,
    });
  });

  it("refuses a telemetry cadence that is not inside the activity window", () => {
    for (const telemetryMs of [30_000, 60_000]) {
      const result = ConfigSchema.safeParse({
        meeting: { telemetryMs, activityWindowMs: 30_000 },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain("less than");
      }
    }
    // Exactly one cadence inside the window is fine.
    expect(
      ConfigSchema.safeParse({ meeting: { telemetryMs: 29_999, activityWindowMs: 30_000 } })
        .success,
    ).toBe(true);
  });
});

describe("meet allow-list config", () => {
  it("leaves a project without meet unconfigured, so a paste fails closed", () => {
    const config = ConfigSchema.parse({ projects: [{ name: "demo", path: "/tmp/demo" }] });
    expect(config.projects[0]?.meet).toBeUndefined();
  });

  it("keeps a configured list, with the optional label and revocation date", () => {
    const config = ConfigSchema.parse({
      projects: [
        {
          name: "demo",
          path: "/tmp/demo",
          meet: {
            allow: [{ id: "uuid-1", label: "+1000", revokedAt: "2026-01-01T00:00:00Z" }],
          },
        },
      ],
    });
    expect(config.projects[0]?.meet?.allow).toEqual([
      { id: "uuid-1", label: "+1000", revokedAt: "2026-01-01T00:00:00Z" },
    ]);
  });

  it("defaults an absent allow list to empty when meet is present", () => {
    const config = ConfigSchema.parse({
      projects: [{ name: "demo", path: "/tmp/demo", meet: {} }],
    });
    expect(config.projects[0]?.meet?.allow).toEqual([]);
    expect(config.projects[0]?.meet?.providers).toBeUndefined();
  });

  it("keeps a configured provider host list", () => {
    const config = ConfigSchema.parse({
      projects: [
        {
          name: "demo",
          path: "/tmp/demo",
          meet: { allow: [{ id: "+1000" }], providers: ["meet.example"] },
        },
      ],
    });
    expect(config.projects[0]?.meet?.providers).toEqual(["meet.example"]);
  });

  it("loads the list from a config.toml file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-config-"));
    fs.writeFileSync(
      path.join(dir, "config.toml"),
      [
        "[signal]",
        'account = "+1000"',
        "",
        "[[projects]]",
        'name = "demo"',
        "path = '/tmp/demo'",
        'meet = { allow = [{ id = "+1000", label = "+1000" }] }',
        "",
      ].join("\n"),
      "utf8",
    );

    const config = loadConfig(dir);
    expect(config.projects[0]?.meet?.allow).toEqual([{ id: "+1000", label: "+1000" }]);
  });
});

describe("readConfig", () => {
  it("parses and validates a present config", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-read-config-"));
    try {
      fs.writeFileSync(
        path.join(dir, "config.toml"),
        [
          "[signal]",
          'account = "+1000"',
          "",
          "[[projects]]",
          'name = "demo"',
          "path = '/tmp/demo'",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = readConfig(dir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.signal.account).toBe("+1000");
        expect(result.config.projects[0]?.name).toBe("demo");
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an absent file without creating the directory or a default file", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "sc-read-absent-"));
    const dir = path.join(parent, "not-created");
    try {
      const result = readConfig(dir);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.absent).toBe(true);
        expect(result.reason).toContain("config.toml");
        expect(result.reason).not.toContain("\n");
      }
      expect(fs.existsSync(dir)).toBe(false);
      expect(fs.readdirSync(parent)).toEqual([]);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("reports invalid TOML in one line and never rewrites the file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-read-invalid-"));
    const file = path.join(dir, "config.toml");
    try {
      fs.writeFileSync(file, "[signal\naccount = '+1000'", "utf8");
      const before = fs.readFileSync(file, "utf8");

      const result = readConfig(dir);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.absent).toBe(false);
        expect(result.reason).toContain("not valid TOML");
        expect(result.reason).not.toContain("\n");
      }
      expect(fs.readFileSync(file, "utf8")).toBe(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a schema violation in one line without a stack", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-read-schema-"));
    try {
      fs.writeFileSync(path.join(dir, "config.toml"), '[signal]\ndaemonPort = "nope"\n', "utf8");

      const result = readConfig(dir);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.absent).toBe(false);
        expect(result.reason).toContain("invalid");
        expect(result.reason).toContain("signal.daemonPort");
        expect(result.reason).not.toContain("\n");
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
