import { afterEach, describe, expect, it, vi } from "vitest";
import { nullLogger } from "../../logging/logger.js";
import { OpenCodeServerAdapter } from "./opencodeServer.js";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  } as unknown as Response;
}

const project = { id: "demo", name: "demo", path: "C:/work/demo" };

describe("OpenCodeServerAdapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates a session in the project directory and sends the prompt", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        if (String(url).endsWith("/api/session")) return jsonResponse({ data: { id: "ses_1" } });
        return jsonResponse({ data: {} });
      }),
    );
    const adapter = new OpenCodeServerAdapter({
      baseUrl: "http://x",
      username: "u",
      password: "p",
      logger: nullLogger(),
    });

    const { sessionId } = await adapter.startTask({ taskId: "t1", project, prompt: "do it" });
    expect(sessionId).toBe("ses_1");

    const create = calls.find((c) => c.url.endsWith("/api/session"))!;
    expect(JSON.parse(String(create.init.body))).toEqual({
      title: "demo",
      location: { directory: "C:/work/demo" },
    });
    expect((create.init.headers as Record<string, string>)["authorization"]).toMatch(/^Basic /);

    const prompt = calls.find((c) => c.url.includes("/prompt"))!;
    expect(prompt.url).toBe("http://x/api/session/ses_1/prompt");
    expect(JSON.parse(String(prompt.init.body))).toEqual({ text: "do it" });
  });

  it("health() is false when the server refuses the connection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("refused");
      }),
    );
    const adapter = new OpenCodeServerAdapter({ baseUrl: "http://x", logger: nullLogger() });
    expect(await adapter.health()).toBe(false);
  });

  it("rejects a reply to an unknown permission", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: { id: "ses_2" } })));
    const adapter = new OpenCodeServerAdapter({ baseUrl: "http://x", logger: nullLogger() });
    await adapter.startTask({ taskId: "t2", project, prompt: "x" });
    await expect(adapter.answerPermission("per_1", "once")).rejects.toThrow(/unknown permission/);
  });
});
