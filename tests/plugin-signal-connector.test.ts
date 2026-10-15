import { describe, expect, it, vi } from "vitest";
import {
  extractAttachments,
  extractOptions,
  mapServerEvent,
  modelRefsFrom,
  permissionRequestsFrom,
  pollTargets,
  resolvePromptSession,
  summarizeIdle,
} from "../plugins/signal-connector";

// Fixtures are trimmed copies of real opencode v2.0.25 SSE payloads: the session
// id lives in `data.sessionID`, not `properties.sessionID`.
const SESSION = "ses_ed102c021ffeS6PCgWfe4ZK21v";

const event = (type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: "evt_1",
  created: 1791789712016,
  type,
  location: { directory: "C:\\Sources\\SignalConnector" },
  data: { sessionID: SESSION, ...data },
  ...extra,
});

describe("mapServerEvent", () => {
  it("maps a successful execution to idle", () => {
    expect(mapServerEvent(event("session.execution.succeeded", {}), 1)).toEqual({
      sessionID: SESSION,
      event: { type: "idle", at: 1, summary: "session idle" },
    });
  });

  it("maps a failed execution to an error carrying the provider message", () => {
    expect(
      mapServerEvent(
        event("session.execution.failed", { error: { type: "provider.auth", message: "x-api-key header is required" } }),
        1,
      ),
    ).toEqual({
      sessionID: SESSION,
      event: { type: "error", at: 1, text: "x-api-key header is required" },
    });
  });

  it("maps a started tool to a tool event using the tool name", () => {
    expect(mapServerEvent(event("session.tool.input.started", { name: "shell" }), 1)).toEqual({
      sessionID: SESSION,
      event: { type: "tool", at: 1, tool: "shell" },
    });
  });

  it("maps a finished text part to a status line and truncates it", () => {
    const long = "x".repeat(500);
    const mapped = mapServerEvent(event("session.text.ended", { text: long }), 1);
    expect(mapped?.event).toEqual({ type: "status", at: 1, text: "x".repeat(200) });
    // The untruncated text is kept for the completion summary.
    expect(mapped?.fullText).toBe(long);
  });

  it("keeps an option menu even when it sits past the truncation point", () => {
    const text = `${"x".repeat(400)}\n<<options: retry | revert>>`;
    const mapped = mapServerEvent(event("session.text.ended", { text }), 1);
    expect(mapped?.event.text).toBe("x".repeat(200));
    expect(mapped?.event.choices).toEqual(["retry", "revert"]);
    expect(mapped?.fullText).toBe("x".repeat(400));
  });

  it("ignores events the bridge does not forward", () => {
    expect(mapServerEvent(event("session.tool.called", { id: "call_1" }), 1)).toBeUndefined();
    expect(mapServerEvent({ type: "provider.updated", data: {} }, 1)).toBeUndefined();
  });

  it("ignores events without a session id", () => {
    expect(mapServerEvent({ type: "session.execution.succeeded", data: {} }, 1)).toBeUndefined();
    expect(mapServerEvent("nope", 1)).toBeUndefined();
  });

  it("still accepts a top-level sessionID for compatibility", () => {
    expect(
      mapServerEvent({ type: "session.execution.succeeded", sessionID: SESSION }, 1),
    ).toEqual({
      sessionID: SESSION,
      event: { type: "idle", at: 1, summary: "session idle" },
    });
  });
});

describe("resolvePromptSession", () => {
  it("reuses the pinned session from the service", async () => {
    const create = vi.fn(async () => "ses_created");
    expect(await resolvePromptSession(SESSION, create)).toBe(SESSION);
    expect(create).not.toHaveBeenCalled();
  });

  it("creates a session when none is pinned", async () => {
    expect(await resolvePromptSession(undefined, async () => "ses_created")).toBe("ses_created");
    expect(await resolvePromptSession("   ", async () => "ses_created")).toBe("ses_created");
    expect(await resolvePromptSession(42, async () => "ses_created")).toBe("ses_created");
  });

  it("returns undefined when a needed session could not be created", async () => {
    expect(await resolvePromptSession(undefined, async () => undefined)).toBeUndefined();
  });
});

describe("pollTargets", () => {
  it("pairs each task with its session, not the other way round", () => {
    const sessions = new Map([
      ["task-uuid-1", "ses_abc"],
      ["task-uuid-2", "ses_def"],
    ]);
    expect(pollTargets(sessions)).toEqual([
      { taskId: "task-uuid-1", sessionID: "ses_abc" },
      { taskId: "task-uuid-2", sessionID: "ses_def" },
    ]);
    // The regression: the session id must be the one a permission call accepts.
    for (const target of pollTargets(sessions)) {
      expect(target.sessionID.startsWith("ses")).toBe(true);
    }
  });
});

describe("extractAttachments", () => {
  it("pulls files out of the message and leaves the text", () => {
    expect(extractAttachments("Here it is.\n<<send: C:\\tmp\\shot.png>>")).toEqual({
      text: "Here it is.",
      paths: ["C:\\tmp\\shot.png"],
    });
  });

  it("accepts several files in one marker", () => {
    expect(extractAttachments("<<send: a.png | b.pdf>> done")).toEqual({
      text: "done",
      paths: ["a.png", "b.pdf"],
    });
  });

  it("leaves ordinary text alone", () => {
    expect(extractAttachments("no markers")).toEqual({ text: "no markers", paths: [] });
  });
});

describe("modelRefsFrom", () => {
  it("reads a flat list", () => {
    expect(modelRefsFrom([{ providerID: "a", id: "b", name: "Bee" }])).toEqual([
      { providerID: "a", id: "b", name: "Bee" },
    ]);
  });

  it("unwraps a { data } envelope and tolerates alternate field names", () => {
    expect(modelRefsFrom({ data: [{ provider: "p", modelID: "m" }] })).toEqual([
      { providerID: "p", id: "m" },
    ]);
  });

  it("skips entries it cannot use", () => {
    expect(modelRefsFrom({ data: [{ id: "no-provider" }, null, "junk"] })).toEqual([]);
    expect(modelRefsFrom(undefined)).toEqual([]);
  });
});

describe("permissionRequestsFrom", () => {
  it("unwraps the server's { data } envelope", () => {
    expect(permissionRequestsFrom({ data: [{ id: "p1" }] })).toEqual([{ id: "p1" }]);
  });

  it("accepts a bare array", () => {
    expect(permissionRequestsFrom([{ id: "p1" }])).toEqual([{ id: "p1" }]);
  });

  it("never throws on an unexpected shape", () => {
    expect(permissionRequestsFrom(undefined)).toEqual([]);
    expect(permissionRequestsFrom({})).toEqual([]);
    expect(permissionRequestsFrom("nope")).toEqual([]);
  });
});

describe("extractOptions", () => {  it("pulls an option menu out of an assistant message", () => {
    expect(extractOptions("Pick one.\n<<options: add retry | revert | both>>")).toEqual({
      text: "Pick one.",
      options: ["add retry", "revert", "both"],
    });
  });

  it("leaves ordinary text alone", () => {
    expect(extractOptions("All done")).toEqual({ text: "All done", options: [] });
  });

  it("ignores an empty marker", () => {
    expect(extractOptions("Hmm <<options:  | >>")).toEqual({ text: "Hmm", options: [] });
  });
});

describe("summarizeIdle", () => {
  it("carries the assistant's last message into the summary", () => {
    expect(summarizeIdle("session idle", "  All tests pass, 3 files changed  ")).toBe(
      "All tests pass, 3 files changed",
    );
  });

  it("falls back when a task produced no text", () => {
    expect(summarizeIdle("session idle", undefined)).toBe("session idle");
    expect(summarizeIdle("session idle", "   ")).toBe("session idle");
  });

  it("caps a long answer", () => {
    const summary = summarizeIdle("session idle", "y".repeat(900));
    expect(summary).toBe(`${"y".repeat(500)}…`);
  });
});
