import { describe, expect, it } from "vitest";
import { mapOpenCodeEvent } from "./eventMapper.js";

describe("mapOpenCodeEvent", () => {
  it("maps an idle/result event to completion with a summary", () => {
    expect(mapOpenCodeEvent({ type: "result", text: "all done" }, "t1", 1)).toEqual({
      type: "idle",
      taskId: "t1",
      at: 1,
      summary: "all done",
    });
  });

  it("maps a permission request", () => {
    const event = mapOpenCodeEvent(
      { type: "permission.asked", id: "p1", tool: "bash", message: "run ls", safe: false },
      "t1",
      1,
    );
    expect(event?.type).toBe("permission");
    expect(event?.permission).toEqual({
      id: "p1",
      taskId: "t1",
      tool: "bash",
      description: "run ls",
      safe: false,
    });
  });

  it("maps an error event", () => {
    expect(mapOpenCodeEvent({ type: "error", message: "boom" }, "t1", 1)).toEqual({
      type: "error",
      taskId: "t1",
      at: 1,
      text: "boom",
    });
  });

  it("maps a file_change event", () => {
    expect(mapOpenCodeEvent({ type: "file_change", files: ["a.ts", "b.ts"] }, "t1", 1)).toEqual({
      type: "files-changed",
      taskId: "t1",
      at: 1,
      files: ["a.ts", "b.ts"],
    });
  });

  it("degrades an unknown event with text to a status line", () => {
    expect(mapOpenCodeEvent({ type: "mystery", text: "hi" }, "t1", 1)).toEqual({
      type: "status",
      taskId: "t1",
      at: 1,
      text: "hi",
    });
  });

  it("drops a non-object or textless unknown", () => {
    expect(mapOpenCodeEvent(null, "t1")).toBeUndefined();
    expect(mapOpenCodeEvent({ type: "mystery" }, "t1")).toBeUndefined();
  });
});
