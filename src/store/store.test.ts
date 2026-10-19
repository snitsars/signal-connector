import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Task } from "../domain/types.js";
import { DatabaseSync } from "./sqliteDriver.js";
import { openStore } from "./store.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A store on a real file, so the stored row can be inspected after it closes. */
function fileStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signalconnector-store-"));
  dirs.push(dir);
  const file = path.join(dir, "state.db");
  return { file, store: openStore(file) };
}

function rows(file: string): Record<string, unknown>[] {
  const db = new DatabaseSync(file);
  try {
    return db.prepare(`SELECT project_id, link, started_at, closed_at, outcome FROM meetings`).all();
  } finally {
    db.close();
  }
}

describe("meetings", () => {
  it("claims the one open slot and returns the link while it is open", () => {
    const store = openStore(":memory:");
    store.claimMeeting({ projectId: "demo", link: "https://room/one", startedAt: 1000 });

    expect(store.getOpenMeeting()).toEqual({
      projectId: "demo",
      link: "https://room/one",
      startedAt: 1000,
    });
    store.close();
  });

  it("fails a second claim on the store's uniqueness, not a read", () => {
    const store = openStore(":memory:");
    store.claimMeeting({ projectId: "demo", link: "https://room/one", startedAt: 1000 });

    expect(() =>
      store.claimMeeting({ projectId: "other", link: "https://room/two", startedAt: 2000 }),
    ).toThrow();
    expect(store.getOpenMeeting()?.link).toBe("https://room/one");
    store.close();
  });

  it("closes the row, wipes the link and frees the slot", () => {
    const { file, store } = fileStore();
    store.claimMeeting({ projectId: "demo", link: "https://room/secret", startedAt: 1000 });

    expect(store.closeMeeting("demo", "left by /meet stop", 5000)).toBe(true);
    expect(store.getOpenMeeting()).toBeUndefined();
    store.close();

    expect(rows(file)).toEqual([
      {
        project_id: "demo",
        link: null,
        started_at: 1000,
        closed_at: 5000,
        outcome: "left by /meet stop",
      },
    ]);

    // The slot can be claimed again, and the second meeting gets its own row.
    const reopened = openStore(file);
    reopened.claimMeeting({ projectId: "other", link: "https://room/two", startedAt: 6000 });
    expect(reopened.getOpenMeeting()?.projectId).toBe("other");
    reopened.close();
  });

  it("says false when there was no open meeting to close", () => {
    const store = openStore(":memory:");
    expect(store.closeMeeting("demo", "nothing")).toBe(false);
    store.close();
  });

  it("closes every row a previous process left open and wipes their links", () => {
    const { file, store } = fileStore();
    store.claimMeeting({ projectId: "demo", link: "https://room/secret", startedAt: 1000 });

    expect(store.closeOpenMeetings("interrupted by a restart", 9000)).toEqual([
      { projectId: "demo", link: "https://room/secret", startedAt: 1000 },
    ]);
    expect(store.getOpenMeeting()).toBeUndefined();
    store.close();

    expect(rows(file)).toEqual([
      {
        project_id: "demo",
        link: null,
        started_at: 1000,
        closed_at: 9000,
        outcome: "interrupted by a restart",
      },
    ]);
  });
});

function task(patch: Partial<Task> = {}): Task {
  return {
    id: "t1",
    projectId: "demo",
    sessionId: "s1",
    prompt: "do it",
    state: "done",
    startedAt: 1000,
    updatedAt: 2000,
    ...patch,
  };
}

describe("task voice flag", () => {
  it("keeps a voice task recognisable after a restart", () => {
    const { file, store } = fileStore();
    store.createTask(task({ voice: true }));
    store.close();

    const reopened = openStore(file);
    expect(reopened.getTask("t1")?.voice).toBe(true);
    // A typed task has no flag: absent means "do not speak this one".
    reopened.createTask(task({ id: "t2" }));
    expect(reopened.getTask("t2")?.voice).toBeUndefined();
    reopened.close();
  });

  it("adds the column to a database created before the flag existed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signalconnector-store-"));
    dirs.push(dir);
    const file = path.join(dir, "state.db");

    // The tasks table as it looked before this story: no voice column.
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE tasks (
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
      INSERT INTO tasks (id, project_id, session_id, prompt, state, started_at, updated_at)
        VALUES ('old', 'demo', 's1', 'written before the change', 'done', 1, 2);
    `);
    old.close();

    const store = openStore(file);
    // The existing row survives the guarded ALTER and is not a voice task.
    expect(store.getTask("old")?.prompt).toBe("written before the change");
    expect(store.getTask("old")?.voice).toBeUndefined();

    store.createTask(task({ id: "new", voice: true }));
    expect(store.getTask("new")?.voice).toBe(true);
    store.updateTask("new", { summary: "still spoken", updatedAt: 3000 });
    expect(store.getTask("new")?.voice).toBe(true);
    store.close();
  });
});
