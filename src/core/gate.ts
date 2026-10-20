/**
 * The gate that decides whether a pasted meeting link may be honoured.
 *
 * Pure: no fetch, no store, no logger. It resolves the sender's identity, parses
 * the link canonically, checks the provider host allow-list, and returns either
 * the parsed link or one named refusal category. The reachability probe is the
 * only I/O on this path and it lives in `app.ts`, deliberately outside this
 * module so every rule here is testable with no Signal, browser or network.
 *
 * The link is a credential: no refusal ever carries it, only its category and,
 * where useful, the sender the refusal is about.
 */

/** An accepted identity for a project's meetings. */
export interface MeetIdentity {
  /** The Signal uuid/ACI, or the phone number when the operator configures one. */
  id: string;
  /** A recognisable name for the refusal, typically the number. */
  label?: string;
  /** ISO-8601 instant after which the entry is retired. */
  revokedAt?: string;
}

/**
 * The closed set of reasons a paste is refused, plus the reachability probe's
 * own refusal. Every refusal on the `/meet` path is exactly one of these.
 */
export type RefusalCategory =
  | "no-identities"
  | "not-authorised"
  | "malformed-link"
  | "foreign-provider"
  | "unreachable-room";

export interface PasteRefusal {
  ok: false;
  category: RefusalCategory;
  /** Operator-safe context (never the link), e.g. the sender that was refused. */
  detail?: string;
}

export type PasteDecision = { ok: true; link: URL } | PasteRefusal;

export interface PasteInput {
  /** How the message arrived: the operator's own device, or the network. */
  delivery: "data" | "sync";
  /** The sender as the transport presents it: a number on the data path. */
  sender: string;
  /** The sender's uuid/ACI, when the envelope carries one. */
  senderUuid?: string;
  /** The project's accepted identities; empty means fail-closed. */
  allow: ReadonlyArray<MeetIdentity>;
  /** The text of the paste (the `/meet` argument). */
  text: string;
  /** Hosts a room link may point at, e.g. `meet.jit.si`. */
  providerHosts: ReadonlyArray<string>;
  /** Clock for `revokedAt`, injectable for tests. Defaults to `Date.now()`. */
  now?: number;
}

/**
 * No provider is baked in: an operator names the hosts their rooms live on in
 * the project's `meet.providers`. Until they do, every host is foreign and every
 * paste is refused, which is the fail-closed default the gate wants.
 */
export const PROVIDER_HOSTS: ReadonlyArray<string> = [];

/**
 * Pull the first usable meeting link out of a pasted message. Operators forward
 * invitations whole ("Натисніть це посилання…", a dial-in block and a service
 * page), so the link is rarely a bare URL. Service pages are skipped: the
 * dial-in info page is on the provider's host but is not a room.
 */
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
const SERVICE_PATH = /\/(static|dialin|dial-in|tel|invite)(\/|$)|dialininfo|\.html?$/i;

function cleanUrl(raw: string): string {
  return raw.replace(/[.,;:!?)\]}'"]+$/g, "");
}

export function extractMeetingLink(
  text: string,
  providerHosts: ReadonlyArray<string> = [],
): string | undefined {
  const candidates: string[] = [];
  for (const raw of text.match(URL_PATTERN) ?? []) {
    const url = cleanUrl(raw);
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") continue;
      if (SERVICE_PATH.test(parsed.pathname)) continue;
      candidates.push(url);
    } catch {
      /* not a URL after all */
    }
  }
  const allowed = new Set(providerHosts.map((host) => host.trim().toLowerCase()));
  const preferred = candidates.find((url) => allowed.has(new URL(url).hostname.toLowerCase()));
  return preferred ?? candidates[0];
}

/** Decide whether a paste may proceed to the probe and the claim. */
export function decidePaste(input: PasteInput): PasteDecision {
  const allow = input.allow ?? [];
  // Fail-closed: an unset or empty list refuses everyone, the operator included.
  if (allow.length === 0) return { ok: false, category: "no-identities" };

  const identity = resolveIdentity(input, allow);
  if (!identity.ok) return { ok: false, category: "not-authorised", ...(identity.detail ? { detail: identity.detail } : {}) };

  const link = parseLink(extractMeetingLink(input.text, input.providerHosts) ?? input.text);
  if (!link) return { ok: false, category: "malformed-link" };

  if (!isAllowedHost(link, input.providerHosts)) {
    return { ok: false, category: "foreign-provider" };
  }

  return { ok: true, link };
}

/** Whether a sender may act for a project's meetings; the same rule as a paste. */
export function isAllowedIdentity(input: {
  delivery: "data" | "sync";
  sender: string;
  senderUuid?: string;
  allow: ReadonlyArray<MeetIdentity>;
  now?: number;
}): boolean {
  return resolveIdentity(input, input.allow).ok;
}

/**
 * Identity: the sync path is the operator's own linked device by construction;
 * on the data path the sender must match a configured entry. The uuid is
 * resolved across the whole list first and the number is only consulted when no
 * uuid matches at all, so the order of `allow` entries cannot decide the result.
 */
function resolveIdentity(
  input: Pick<PasteInput, "delivery" | "sender" | "senderUuid" | "allow" | "now">,
  allow: ReadonlyArray<MeetIdentity>,
): { ok: true } | { ok: false; detail?: string } {
  if (input.delivery === "sync") return { ok: true };

  const byUuid =
    input.senderUuid !== undefined
      ? allow.find((entry) => entry.id === input.senderUuid)
      : undefined;
  const byNumber = input.sender ? allow.find((entry) => entry.id === input.sender) : undefined;
  const matched = byUuid ?? byNumber;
  if (!matched) {
    return { ok: false, ...(input.sender ? { detail: input.sender } : {}) };
  }

  // A retired entry is refused as not authorised, so "revoked" and "never
  // listed" read the same to a stranger while the label still names them.
  if (isRevoked(matched, input.now ?? Date.now())) {
    const detail = matched.label ?? input.sender;
    return { ok: false, ...(detail ? { detail } : {}) };
  }
  return { ok: true };
}

/**
 * Whether an entry is retired. An `revokedAt` that cannot be parsed is treated
 * as revoked: a typo or an empty value must not quietly restore an identity.
 */
function isRevoked(entry: MeetIdentity, now: number): boolean {
  if (entry.revokedAt === undefined) return false;
  const revokedAt = Date.parse(entry.revokedAt);
  if (!Number.isFinite(revokedAt)) return true;
  return revokedAt <= now;
}

/**
 * Canonical parse: https, a real host, and no credentials embedded in the URL,
 * which would leak them into the browser's own history and requests.
 */
function parseLink(text: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  if (!url.hostname) return undefined;
  if (url.username || url.password) return undefined;
  return url;
}

/** Host match is exact and case-insensitive; a configured host is a policy. */
function isAllowedHost(link: URL, providerHosts: ReadonlyArray<string>): boolean {
  const host = link.hostname.toLowerCase();
  return providerHosts.some((allowed) => allowed.trim().toLowerCase() === host);
}
