/**
 * Loads the Node built-in `node:sqlite` at runtime via createRequire.
 * Vite/vitest does not recognize node:sqlite as a builtin, so a static import
 * breaks the test transform; a runtime require is invisible to it.
 *
 * The require happens inside `DatabaseSync`, not at module scope: `node:sqlite`
 * only exists from Node 22.5 (usable floor 22.13), and importing this module
 * below the floor must not kill the process before `doctor` can report the fix.
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

function loadSqlite(): SqliteModule {
  try {
    return require("node:sqlite") as SqliteModule;
  } catch {
    throw new Error(
      `cannot open the state database: node:sqlite is unavailable in Node.js ${process.versions.node}. ` +
        `SignalConnector needs Node.js 22.13 or newer; run "signal-connector doctor" for the fix.`,
    );
  }
}

/** The driver handle: same shape as node:sqlite's `DatabaseSync`, loaded lazily. */
export class DatabaseSync implements DatabaseLike {
  readonly #db: DatabaseLike;

  constructor(file: string) {
    this.#db = new (loadSqlite().DatabaseSync)(file);
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  prepare(sql: string): StatementLike {
    return this.#db.prepare(sql);
  }

  close(): void {
    this.#db.close();
  }
}
