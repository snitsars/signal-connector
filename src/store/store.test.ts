import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
