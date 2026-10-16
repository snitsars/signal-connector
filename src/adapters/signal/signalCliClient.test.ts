import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../logging/logger.js";
import {
  attachmentData,
  inboundMedia,
  mediaFileName,
  pollVoteFrom,
  SignalCliClient,
} from "./signalCliClient.js";
import { isGroupId, quoteParams, targetParams } from "./signalCliClient.js";

describe("targetParams", () => {
  const account = "+1000";
  const group = "Pmpi+EfPWmsxiomLe9Nx2XF9HOE483p6iKiFj65iMwI=";

  it("addresses Note-to-Self as ourselves", () => {
    expect(targetParams("self", account, "note-to-self")).toEqual({ recipient: account });
    expect(targetParams(account, account, "note-to-self")).toEqual({ recipient: account });
  });

  it("addresses a group by groupId, not recipient", () => {
    expect(targetParams(group, account, "group")).toEqual({ groupId: group });
  });

  it("recognises a group id even when the kind is not configured", () => {
    expect(isGroupId(group)).toBe(true);
    expect(isGroupId(account)).toBe(false);
    expect(targetParams(group, account)).toEqual({ groupId: group });
  });

  it("addresses a person by recipient", () => {
    expect(targetParams("+2000", account, "note-to-self")).toEqual({ recipient: "+2000" });
  });
});

describe("quoteParams", () => {
  it("turns a quote into signal-cli's parameters", () => {
    expect(quoteParams({ id: "1792000000000", text: 'Project "demo"' }, "+1000")).toEqual({
      quoteTimestamp: 1792000000000,
      quoteAuthor: "+1000",
      quoteMessage: 'Project "demo"',
    });
  });

  it("ignores a quote without a usable id", () => {
    expect(quoteParams(undefined, "+1000")).toEqual({});
    expect(quoteParams({ id: "not-a-timestamp" }, "+1000")).toEqual({});
  });
});

describe("inboundMedia", () => {
  const ref = { id: "abc123", contentType: "image/jpeg", filename: "photo.jpg", size: 1234 };

  it("finds an attachment on a data message", () => {
    expect(
      inboundMedia({ sourceNumber: "+1000", dataMessage: { attachments: [ref] } }),
    ).toEqual({ attachments: [ref], sender: "+1000" });
  });

  it("finds an attachment on a Note-to-Self sync message", () => {
    // The phone's own messages arrive as syncMessage.sentMessage — the branch
    // that used to drop images.
    expect(
      inboundMedia({
        sourceNumber: "+1000",
        syncMessage: { sentMessage: { destinationNumber: "+1000", attachments: [ref] } },
      }),
    ).toEqual({ attachments: [ref], sender: "+1000" });
  });

  it("reports nothing when there is no attachment", () => {
    expect(inboundMedia({ dataMessage: { message: "hi" } })).toBeUndefined();
    expect(inboundMedia({ dataMessage: { attachments: [] } })).toBeUndefined();
    expect(inboundMedia({ syncMessage: { sentMessage: {} } })).toBeUndefined();
  });
});

describe("mediaFileName", () => {
  it("prefixes the timestamp and keeps a safe name", () => {
    expect(mediaFileName({ filename: "my photo (1).PNG" }, 42)).toBe("42-my_photo__1_.PNG");
  });

  it("strips directories so a path cannot escape the media dir", () => {
    expect(mediaFileName({ filename: "..\\..\\evil.png" }, 42)).toBe("42-evil.png");
    expect(mediaFileName({ filename: "/etc/passwd" }, 42)).toBe("42-passwd");
  });

  it("falls back to the content type for an extension", () => {
    expect(mediaFileName({ filename: "photo", contentType: "image/jpeg" }, 42)).toBe("42-photo.jpg");
    expect(mediaFileName({ contentType: "image/png" }, 42)).toBe("42-attachment.png");
    expect(mediaFileName({}, 42)).toBe("42-attachment");
  });
});

describe("attachmentData", () => {
  it("accepts a plain base64 string", () => {
    expect(attachmentData("aGVsbG8=")).toBe("aGVsbG8=");
  });

  it("strips a data URL prefix", () => {
    expect(attachmentData("data:image/png;base64,aGVsbG8=")).toBe("aGVsbG8=");
  });

  it("accepts the object shapes", () => {
    expect(attachmentData({ data: "aGVsbG8=" })).toBe("aGVsbG8=");
    expect(attachmentData({ base64: "aGVsbG8=" })).toBe("aGVsbG8=");
  });

  it("rejects anything it cannot decode", () => {
    expect(attachmentData(undefined)).toBeUndefined();
    expect(attachmentData({ nope: 1 })).toBeUndefined();
    expect(attachmentData("")).toBeUndefined();
  });
});

describe("pollVoteFrom", () => {
  it("maps a vote to 1-based option numbers", () => {
    expect(
      pollVoteFrom({ targetSentTimestamp: 1792000000000, optionIndexes: [0, 2] }, "+1000", 5),
    ).toEqual({ channelId: "+1000", targetId: "1792000000000", indexes: [1, 3], at: 5 });
  });

  it("keeps a retracted vote as an empty pick list", () => {
    expect(
      pollVoteFrom({ targetSentTimestamp: 1792000000000, optionIndexes: [] }, "+1000", 5),
    ).toEqual({ channelId: "+1000", targetId: "1792000000000", indexes: [], at: 5 });
  });

  it("ignores a vote that does not name the poll", () => {
    expect(pollVoteFrom({ optionIndexes: [0] }, "+1000", 5)).toBeUndefined();
    expect(pollVoteFrom(undefined, "+1000", 5)).toBeUndefined();
  });
});

describe("long messages", () => {
  it("sends a long answer as numbered parts and returns the last id", async () => {
    const sent: { message?: string }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const call = JSON.parse(body) as { id: number; method: string; params: { message?: string } };
        if (call.method === "send") sent.push(call.params);
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: call.id,
            result: { timestamp: 1792000000000 + sent.length },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const client = new SignalCliClient({
      endpoint: `http://127.0.0.1:${port}/api/v1/rpc`,
      account: "+1000",
      channelId: "self",
      minIntervalMs: 1,
      logger: createLogger({ level: "error", console: false }),
    });

    // 3000 characters: signal-cli would turn this into an attachment the server
    // refuses, so it has to arrive as parts.
    const answer = "word ".repeat(600).trim();
    const last = await client.send("self", answer);
    server.closeAllConnections();
    server.close();

    expect(sent.length).toBeGreaterThan(1);
    expect(sent[0]!.message?.startsWith(`(1/${sent.length}) `)).toBe(true);
    const rejoined = sent.map((s) => s.message!.replace(/^\(\d+\/\d+\) /, "")).join("");
    expect(rejoined).toBe(answer);
    expect(last.messageId).toBe(String(1792000000000 + sent.length));
  });
});

describe("receive watchdog", () => {
  it("reports a wedged daemon unhealthy, once per outage", async () => {
    // The daemon this incident was about: `version` answers at once, `receive`
    // never answers at all.
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const call = JSON.parse(body) as { id: number; method: string };
        if (call.method === "receive") return; // held open forever
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: { version: "0.14.9" } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const client = new SignalCliClient({
      endpoint: `http://127.0.0.1:${port}/api/v1/rpc`,
      account: "+1000",
      channelId: "self",
      pollIntervalMs: 10,
      receiveTimeoutMs: 40,
      unhealthyAfter: 2,
      logger: createLogger({ level: "error", console: false }),
    });
    const reasons: string[] = [];
    client.onUnhealthy((reason) => reasons.push(reason));

    await client.start();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await client.stop();
    server.closeAllConnections();
    server.close();

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/timeout/i);
  });
});
