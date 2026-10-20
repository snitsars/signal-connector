import { describe, expect, it } from "vitest";
import { decidePaste, extractMeetingLink, isAllowedIdentity, PROVIDER_HOSTS, type PasteInput } from "./gate.js";

const LINK = "https://meet.jit.si/room-abc";
const ALLOW = [{ id: "+1000", label: "+1000" }];
const HOSTS = ["meet.jit.si", "meet.google.com"];

function paste(overrides: Partial<PasteInput> = {}): PasteInput {
  return {
    delivery: "data",
    sender: "+1000",
    allow: ALLOW,
    text: LINK,
    providerHosts: HOSTS,
    ...overrides,
  };
}

describe("decidePaste identity", () => {
  it("passes the operator's own linked device even when the number differs", () => {
    const decision = decidePaste(paste({ delivery: "sync", sender: "+0000", allow: [{ id: "+9999" }] }));
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.link.href).toBe(LINK);
  });

  it("matches a configured number on the data path", () => {
    const decision = decidePaste(paste());
    expect(decision.ok).toBe(true);
  });

  it("prefers the uuid when both sides carry one", () => {
    const allow = [{ id: "uuid-1", label: "+1000" }, { id: "+1000" }];
    const decision = decidePaste(paste({ allow, sender: "+1000", senderUuid: "uuid-1" }));
    expect(decision.ok).toBe(true);
  });

  it("refuses a sender who is not listed, naming them", () => {
    const decision = decidePaste(paste({ sender: "+2000" }));
    expect(decision).toEqual({ ok: false, category: "not-authorised", detail: "+2000" });
  });

  it("does not fall back to the number when a uuid is present but differs", () => {
    const allow = [{ id: "uuid-1" }];
    const decision = decidePaste(paste({ allow, sender: "+1000", senderUuid: "uuid-2" }));
    expect(decision).toEqual({ ok: false, category: "not-authorised", detail: "+1000" });
  });

  it("refuses everyone when the allow-list is empty, even on the sync path", () => {
    expect(decidePaste(paste({ allow: [] }))).toEqual({ ok: false, category: "no-identities" });
    expect(
      decidePaste(paste({ allow: [], delivery: "sync" })),
    ).toEqual({ ok: false, category: "no-identities" });
  });

  it("refuses an entry whose revocation date has passed", () => {
    const allow = [{ id: "+1000", label: "+1000", revokedAt: "2000-01-01T00:00:00Z" }];
    const decision = decidePaste(paste({ allow }));
    expect(decision).toEqual({ ok: false, category: "not-authorised", detail: "+1000" });
  });

  it("applies a revoked uuid even when a live number entry comes first", () => {
    const allow = [
      { id: "+1000" },
      { id: "uuid-1", label: "+1000", revokedAt: "2000-01-01T00:00:00Z" },
    ];
    const decision = decidePaste(paste({ allow, sender: "+1000", senderUuid: "uuid-1" }));
    expect(decision).toEqual({ ok: false, category: "not-authorised", detail: "+1000" });
  });

  it("honours a live uuid even when a revoked number entry comes first", () => {
    const allow = [
      { id: "+1000", revokedAt: "2000-01-01T00:00:00Z" },
      { id: "uuid-1" },
    ];
    const decision = decidePaste(paste({ allow, sender: "+1000", senderUuid: "uuid-1" }));
    expect(decision.ok).toBe(true);
  });

  it("treats an unparseable revocation date as revoked", () => {
    for (const revokedAt of ["", "not a date"]) {
      const allow = [{ id: "+1000", label: "+1000", revokedAt }];
      expect(decidePaste(paste({ allow }))).toEqual({
        ok: false,
        category: "not-authorised",
        detail: "+1000",
      });
    }
  });

  it("accepts an entry whose revocation date is still in the future", () => {
    const allow = [{ id: "+1000", revokedAt: "2999-01-01T00:00:00Z" }];
    expect(decidePaste(paste({ allow })).ok).toBe(true);
  });
});

describe("decidePaste link shape and provider", () => {
  it("refuses a non-https link as malformed", () => {
    expect(decidePaste(paste({ text: "http://meet.jit.si/room" }))).toEqual({
      ok: false,
      category: "malformed-link",
    });
  });

  it("refuses junk with no host as malformed", () => {
    expect(decidePaste(paste({ text: "not a link" }))).toEqual({
      ok: false,
      category: "malformed-link",
    });
    expect(decidePaste(paste({ text: "https://" }))).toEqual({
      ok: false,
      category: "malformed-link",
    });
  });

  it("refuses a link that embeds credentials as malformed", () => {
    expect(decidePaste(paste({ text: "https://user:secret@meet.jit.si/room" }))).toEqual({
      ok: false,
      category: "malformed-link",
    });
  });

  it("refuses a host that is not the configured provider", () => {
    expect(decidePaste(paste({ text: "https://zoom.us/j/123" }))).toEqual({
      ok: false,
      category: "foreign-provider",
    });
  });

  it("matches the provider host case-insensitively", () => {
    expect(decidePaste(paste({ text: "https://Meet.Jit.SI/room" })).ok).toBe(true);
  });

  it("never echoes the link in a refusal", () => {
    for (const text of ["https://zoom.us/j/secret", "not a link"]) {
      const decision = decidePaste(paste({ text, sender: "+2000" }));
      expect(JSON.stringify(decision)).not.toContain("zoom.us");
      expect(JSON.stringify(decision)).not.toContain("secret");
    }
  });
});

describe("PROVIDER_HOSTS", () => {
  it("bakes in no provider, so an unconfigured project refuses every host", () => {
    expect(PROVIDER_HOSTS).toEqual([]);
    const decision = decidePaste(
      paste({ text: "https://meet.jit.si/room", providerHosts: PROVIDER_HOSTS }),
    );
    expect(decision).toEqual({ ok: false, category: "foreign-provider" });
  });
});

describe("extractMeetingLink", () => {
  const INVITATION = [
    "Натисніть це посилання, щоб приєднатися до зустрічі:",
    "https://meet.jit.si/signalconnectortalks",
    "",
    "=====",
    "",
    "Хочете приєднатися телефоном?",
    "",
    "Телефон: +1.512.647.1431 PIN: 3819584065#",
    "",
    "Натисніть це посилання, щоб переглянути номери телефонів для цієї зустрічі",
    "https://meet.jit.si/static/dialInInfo.html?room=signalconnectortalks",
  ].join("\n");

  it("finds the room in a forwarded invitation and skips the dial-in page", () => {
    expect(extractMeetingLink(INVITATION, HOSTS)).toBe(
      "https://meet.jit.si/signalconnectortalks",
    );
  });

  it("returns nothing when the message only carries the service page", () => {
    const onlyInfo =
      "Номери телефонів: https://meet.jit.si/static/dialInInfo.html?room=room-abc";
    expect(extractMeetingLink(onlyInfo, HOSTS)).toBeUndefined();
    // The gate must not fall back to parsing the raw text after extraction fails.
    expect(decidePaste(paste({ text: onlyInfo, providerHosts: HOSTS }))).toEqual({
      ok: false,
      category: "malformed-link",
    });
  });

  it("refuses an empty allow-list on the sync path too", () => {
    expect(
      isAllowedIdentity({ delivery: "sync", sender: "+1000", allow: [] }),
    ).toBe(false);
  });

  it("drops trailing punctuation around a bare link", () => {
    expect(extractMeetingLink("Join here: https://meet.jit.si/room-abc.")).toBe(
      "https://meet.jit.si/room-abc",
    );
  });

  it("prefers the configured provider when a message contains several links", () => {
    const text = "docs https://example.com/help and room https://meet.jit.si/room-abc";
    expect(extractMeetingLink(text, HOSTS)).toBe("https://meet.jit.si/room-abc");
  });

  it("still lets the gate refuse a foreign host from a forwarded message", () => {
    const decision = decidePaste(
      paste({ text: "Join us: https://zoom.us/j/12345", providerHosts: HOSTS }),
    );
    expect(decision).toEqual({ ok: false, category: "foreign-provider" });
  });

  it("joins a room pasted together with the invitation prose", () => {
    const decision = decidePaste(paste({ text: INVITATION, delivery: "sync" }));
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.link.href).toBe("https://meet.jit.si/signalconnectortalks");
  });
});
