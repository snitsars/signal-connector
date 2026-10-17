import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema, loadConfig } from "./config.js";

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
