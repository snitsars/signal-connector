/**
 * SQLite store — the single source of runtime state (spine AD-3).
 * Uses the Node built-in `node:sqlite` module (no native dependency).
 */
import type { Project, Task, TaskState } from "../domain/types.js";
import { DatabaseSync } from "./sqliteDriver.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  project_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  summary TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS approvals (
  project_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  decision TEXT NOT NULL,
  PRIMARY KEY (project_id, tool)
);
CREATE TABLE IF NOT EXISTS project_channels (
  project_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meetings (
  project_id TEXT NOT NULL,
  link TEXT,
  started_at INTEGER NOT NULL,
  closed_at INTEGER,
  outcome TEXT
);
-- One meeting at a time: every open row has the same key, so the second claim
-- is a failed write rather than a read-then-write race. Closed rows are exempt.
CREATE UNIQUE INDEX IF NOT EXISTS meetings_one_open
  ON meetings ((closed_at IS NULL)) WHERE closed_at IS NULL;
`;

/** A meeting row. The link is the credential and only lives while the row is open. */
export interface Meeting {
  projectId: string;
  link: string;
  startedAt: number;
}

export interface MeetingClaim {
  projectId: string;
  link: string;
  startedAt: number;
}

export interface Store {
  upsertProject(project: Project): void;
  listProjects(): Project[];
  getProject(idOrName: string): Project | undefined;

  setSession(projectId: string, sessionId: string): void;
  getSession(projectId: string): string | undefined;

  /** The Signal channel (group) a project talks in, once it has one. */
  setChannel(projectId: string, channelId: string, name: string): void;
  getChannel(projectId: string): { channelId: string; name: string } | undefined;
  projectForChannel(channelId: string): string | undefined;

  createTask(task: Task): void;
  updateTask(id: string, patch: Partial<Pick<Task, "state" | "summary" | "error" | "updatedAt">>): void;
  getTask(id: string): Task | undefined;
  getActiveTask(projectId: string): Task | undefined;

  setApproval(projectId: string, tool: string, decision: string): void;
  getApproval(projectId: string, tool: string): string | undefined;

  /**
   * Claim the one open meeting slot. Throws when another meeting is open: the
   * partial unique index makes that a failed write, not a race with a read.
   */
  claimMeeting(claim: MeetingClaim): void;
  getOpenMeeting(): Meeting | undefined;
  /** Close the project's open meeting and wipe its link. False when none was open. */
  closeMeeting(projectId: string, outcome: string, closedAt?: number): boolean;
  /** Startup reconciliation: close every row a previous process left open. */
  closeOpenMeetings(outcome: string, closedAt?: number): Meeting[];

  getValue(key: string): string | undefined;
  setValue(key: string, value: string): void;

  close(): void;
}

function rowToProject(row: Record<string, unknown>): Project {
  return { id: String(row.id), name: String(row.name), path: String(row.path) };
}

function rowToTask(row: Record<string, unknown>): Task {
  const task: Task = {
    id: String(row.id),
    projectId: String(row.project_id),
    sessionId: String(row.session_id),
    prompt: String(row.prompt),
    state: String(row.state) as TaskState,
    startedAt: Number(row.started_at),
    updatedAt: Number(row.updated_at),
  };
  if (row.summary != null) task.summary = String(row.summary);
  if (row.error != null) task.error = String(row.error);
  return task;
}

function rowToMeeting(row: Record<string, unknown>): Meeting {
  return {
    projectId: String(row.project_id),
    // An open row always has a link; a wiped one is never returned as open.
    link: row.link == null ? "" : String(row.link),
    startedAt: Number(row.started_at),
  };
}

export function openStore(path: string): Store {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);

  return {
    upsertProject(project) {
      db.prepare(
        `INSERT INTO projects (id, name, path) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, path = excluded.path`,
      ).run(project.id, project.name, project.path);
    },
    listProjects() {
      return db.prepare(`SELECT * FROM projects ORDER BY name`).all().map(rowToProject);
    },
    getProject(idOrName) {
      const row = db
        .prepare(`SELECT * FROM projects WHERE id = ? OR name = ? LIMIT 1`)
        .get(idOrName, idOrName);
      return row ? rowToProject(row) : undefined;
    },

    setSession(projectId, sessionId) {
      db.prepare(
        `INSERT INTO sessions (project_id, session_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
      ).run(projectId, sessionId, Date.now());
    },
    getSession(projectId) {
      const row = db.prepare(`SELECT session_id FROM sessions WHERE project_id = ?`).get(projectId);
      return row ? String(row.session_id) : undefined;
    },

    setChannel(projectId, channelId, name) {
      db.prepare(
        `INSERT INTO project_channels (project_id, channel_id, name) VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET channel_id = excluded.channel_id, name = excluded.name`,
      ).run(projectId, channelId, name);
    },
    getChannel(projectId) {
      const row = db
        .prepare(`SELECT channel_id, name FROM project_channels WHERE project_id = ?`)
        .get(projectId);
      return row ? { channelId: String(row.channel_id), name: String(row.name) } : undefined;
    },
    projectForChannel(channelId) {
      const row = db
        .prepare(`SELECT project_id FROM project_channels WHERE channel_id = ?`)
        .get(channelId);
      return row ? String(row.project_id) : undefined;
    },

    createTask(task) {
      db.prepare(
        `INSERT INTO tasks (id, project_id, session_id, prompt, state, started_at, updated_at, summary, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        task.id,
        task.projectId,
        task.sessionId,
        task.prompt,
        task.state,
        task.startedAt,
        task.updatedAt,
        task.summary ?? null,
        task.error ?? null,
      );
    },
    updateTask(id, patch) {
      const current = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
      if (!current) return;
      const merged = rowToTask(current);
      const next: Task = {
        ...merged,
        ...patch,
        updatedAt: patch.updatedAt ?? Date.now(),
      };
      db.prepare(
        `UPDATE tasks SET state = ?, summary = ?, error = ?, updated_at = ? WHERE id = ?`,
      ).run(next.state, next.summary ?? null, next.error ?? null, next.updatedAt, id);
    },
    getTask(id) {
      const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
      return row ? rowToTask(row) : undefined;
    },
    getActiveTask(projectId) {
      const row = db
        .prepare(
          `SELECT * FROM tasks WHERE project_id = ? AND state IN ('started','running')
           ORDER BY started_at DESC LIMIT 1`,
        )
        .get(projectId);
      return row ? rowToTask(row) : undefined;
    },

    setApproval(projectId, tool, decision) {
      db.prepare(
        `INSERT INTO approvals (project_id, tool, decision) VALUES (?, ?, ?)
         ON CONFLICT(project_id, tool) DO UPDATE SET decision = excluded.decision`,
      ).run(projectId, tool, decision);
    },
    getApproval(projectId, tool) {
      const row = db
        .prepare(`SELECT decision FROM approvals WHERE project_id = ? AND tool = ?`)
        .get(projectId, tool);
      return row ? String(row.decision) : undefined;
    },

    claimMeeting(claim) {
      db.prepare(
        `INSERT INTO meetings (project_id, link, started_at, closed_at, outcome)
         VALUES (?, ?, ?, NULL, NULL)`,
      ).run(claim.projectId, claim.link, claim.startedAt);
    },
    getOpenMeeting() {
      const row = db
        .prepare(`SELECT * FROM meetings WHERE closed_at IS NULL LIMIT 1`)
        .get();
      return row ? rowToMeeting(row) : undefined;
    },
    closeMeeting(projectId, outcome, closedAt = Date.now()) {
      const result = db
        .prepare(
          `UPDATE meetings SET link = NULL, closed_at = ?, outcome = ?
           WHERE project_id = ? AND closed_at IS NULL`,
        )
        .run(closedAt, outcome, projectId);
      return Number((result as { changes?: number }).changes ?? 0) > 0;
    },
    closeOpenMeetings(outcome, closedAt = Date.now()) {
      const open = db
        .prepare(`SELECT * FROM meetings WHERE closed_at IS NULL`)
        .all()
        .map(rowToMeeting);
      db.prepare(
        `UPDATE meetings SET link = NULL, closed_at = ?, outcome = ?
         WHERE closed_at IS NULL`,
      ).run(closedAt, outcome);
      return open;
    },

    getValue(key) {
      const row = db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key);
      return row ? String(row.value) : undefined;
    },
    setValue(key, value) {
      db.prepare(
        `INSERT INTO kv (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(key, value);
    },

    close() {
      db.close();
    },
  };
}
