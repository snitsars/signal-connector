import { describe, expect, it } from "vitest";
import { attachmentData, inboundMedia, mediaFileName, pollVoteFrom } from "./signalCliClient.js";
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
