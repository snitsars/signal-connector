/**
 * Loads the Node built-in `node:sqlite` at runtime via createRequire.
 * Vite/vitest does not recognize node:sqlite as a builtin, so a static import
 * breaks the test transform; a runtime require is invisible to it.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface StatementLike {
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): unknown;
}

export interface DatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): StatementLike;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => DatabaseLike;
}

const sqlite = require("node:sqlite") as SqliteModule;

export const DatabaseSync = sqlite.DatabaseSync;
