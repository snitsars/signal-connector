/**
 * Config loader (spine AD-9). Non-secret config lives in
 * %APPDATA%/SignalConnector/config.toml, created with defaults on first run.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import { z } from "zod";

export function dataDir(): string {
  const base = process.env.APPDATA ?? path.join(os.homedir(), ".config");
  return path.join(base, "SignalConnector");
}

export const ConfigSchema = z.object({
  channel: z
    .object({
      kind: z.enum(["note-to-self", "group"]).default("note-to-self"),
      id: z.string().optional(),
    })
    .default({ kind: "note-to-self" }),
  signal: z
    .object({
      cliPath: z.string().default("signal-cli"),
      account: z.string().optional(),
      daemonHost: z.string().default("127.0.0.1"),
      daemonPort: z.number().int().default(8080),
    })
    .default({ cliPath: "signal-cli", daemonHost: "127.0.0.1", daemonPort: 8080 }),
  agent: z
    .object({
      kind: z.enum(["opencode-server", "opencode-cli"]).default("opencode-server"),
      serverUrl: z.string().optional(),
      opencodePath: z.string().default("opencode"),
    })
    .default({ kind: "opencode-server", opencodePath: "opencode" }),
  projects: z
    .array(z.object({ name: z.string(), path: z.string() }))
    .default([]),
  outbound: z
    .object({
      minIntervalMs: z.number().int().default(1500),
      maxPerMinute: z.number().int().default(20),
    })
    .default({ minIntervalMs: 1500, maxPerMinute: 20 }),
});

export type Config = z.infer<typeof ConfigSchema>;

const DEFAULT_CONFIG: Config = ConfigSchema.parse({});

export function configPath(dir = dataDir()): string {
  return path.join(dir, "config.toml");
}

export function loadConfig(dir = dataDir()): Config {
  fs.mkdirSync(dir, { recursive: true });
  const file = configPath(dir);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, stringify(DEFAULT_CONFIG), "utf8");
    return DEFAULT_CONFIG;
  }
  const raw = parse(fs.readFileSync(file, "utf8"));
  return ConfigSchema.parse(raw);
}
