import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { CdpClient, parseDevToolsActivePort, waitForDevToolsPort } from "./cdp.js";

describe("parseDevToolsActivePort", () => {
  it("reads the port and the browser websocket path", () => {
    expect(parseDevToolsActivePort("51234\n/devtools/browser/abc\n")).toEqual({
      port: 51234,
      wsPath: "/devtools/browser/abc",
    });
  });

  it("rejects junk instead of guessing a port", () => {
    expect(parseDevToolsActivePort("")).toBeUndefined();
    expect(parseDevToolsActivePort("not-a-port\n/devtools/browser/abc")).toBeUndefined();
    expect(parseDevToolsActivePort("0\n/devtools/browser/abc")).toBeUndefined();
    expect(parseDevToolsActivePort("51234")).toBeUndefined();
    expect(parseDevToolsActivePort("51234\nnot-a-path")).toBeUndefined();
  });
});

describe("CdpClient", () => {
  it("reports a lost socket once through onClose", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;

    const until = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    const client = await CdpClient.connect(`ws://127.0.0.1:${port}`);
    try {
      let closed = 0;
      client.onClose(() => {
        closed += 1;
      });

      for (const socket of server.clients) socket.close();
      // Wait for the event itself, never for a guessed interval: a loaded machine
      // closes the socket slower than a fixed sleep assumes.
      await until(() => closed === 1);

      expect(closed).toBe(1);
      // A late subscriber is told immediately, and closing again adds nothing.
      client.onClose(() => {
        closed += 1;
      });
      expect(closed).toBe(2);
      client.close();
      expect(closed).toBe(2);
    } finally {
      client.close();
      server.close();
    }
  });
});

describe("waitForDevToolsPort", () => {
  it("reads the file the browser wrote", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signalconnector-cdp-"));
    try {
      fs.writeFileSync(
        path.join(dir, "DevToolsActivePort"),
        "9222\n/devtools/browser/abc\n",
        "utf8",
      );
      await expect(waitForDevToolsPort(dir, 500, 10)).resolves.toEqual({
        port: 9222,
        wsPath: "/devtools/browser/abc",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops waiting as soon as the browser has exited", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signalconnector-cdp-"));
    try {
      await expect(waitForDevToolsPort(dir, 5_000, 10, () => false)).rejects.toThrow(
        "the browser exited before the room opened",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
