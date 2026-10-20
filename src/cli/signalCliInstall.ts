/**
 * Getting signal-cli onto the machine without the repo's PowerShell script.
 *
 * The only network calls are GitHub's latest-release lookup and the archive
 * download; both are bounded by a timeout and a byte cap, and every redirect
 * hop must stay on a GitHub host. The generic `signal-cli-<version>.tar.gz` is
 * picked by name (never the Linux-native build or a source zip), its version is
 * taken from that name, and the extracted directory must match it.
 *
 * The archive is unpacked into a staging directory beside its final home and
 * moved into place only after the launcher is found, so a failed download or a
 * partial extraction leaves no half-installed copy. Network and extraction are
 * arguments, so the tests never touch the network or run `tar`.
 *
 * No helper exits the process: each returns its result or throws one reason,
 * and the setup step turns that into a report.
 */
import { oneLine } from "../oneLine.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The release feed; the only API call this module makes. */
export const RELEASE_API = "https://api.github.com/repos/AsamK/signal-cli/releases/latest";

/** A lookup that hangs is a failed step, not a frozen setup run. */
export const API_TIMEOUT_MS = 15_000;

/** The archive is ~40 MB; two minutes is generous without being unbounded. */
export const DOWNLOAD_TIMEOUT_MS = 120_000;

/** A release archive larger than this is not the tool we expect. */
export const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;

/** The directory name the release archive unpacks into. */
const ARCHIVE_ROOT = /^signal-cli-(\d+(?:\.\d+)*)$/;

/** The only asset shape the step accepts: no `-Linux-native`, no source zip. */
const ASSET_NAME = /^signal-cli-(\d+(?:\.\d+)*)\.tar\.gz$/;

/** Redirect targets stay on GitHub; a lookalike host is not accepted. */
const GITHUB_HOST = /^(?:[a-z0-9-]+\.)*(?:github\.com|githubusercontent\.com)$/i;

/** GitHub answers a browser download with a redirect to release assets. */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

const MAX_REDIRECTS = 5;

/** Stubbable HTTP: the global fetch in production, a plain function in tests. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Extracts `archive` into `destination`; the default shells out to `tar`. */
export type ExtractArchive = (archive: string, destination: string) => void;

export interface SignalCliRelease {
  /** Parsed from the asset name, which is the version the archive claims. */
  version: string;
  /** The asset's file name, used for the temp file and the download URL check. */
  name: string;
  /** `signal-cli-<version>`, the top-level directory in the archive. */
  directory: string;
  /** The browser download URL, validated as a GitHub URL for this asset. */
  url: string;
  /** The release tag, for a reason that names what was looked at. */
  tag: string;
}

export interface InstalledSignalCli {
  version: string;
  /** `signal-cli-<version>`, the directory that holds `bin/` and `lib/`. */
  home: string;
  /** The launcher (`bin/signal-cli`, `signal-cli.bat`, ...) to name. */
  path: string;
}

export interface SignalCliInstall extends InstalledSignalCli {
  /** False when a copy was already present and nothing was fetched. */
  downloaded: boolean;
}

export interface SignalCliInstallOptions {
  /** `<dataDir>/signal-cli` is the installation root. */
  dataDir: string;
  /** Defaults to the global fetch. */
  fetch?: FetchLike;
  /** Defaults to `tar -xzf`. */
  extract?: ExtractArchive;
  /** Progress lines; the setup runner passes the operator's sink. */
  print?: (line: string) => void;
}

/** A reason on one line, as every report and failure must be. */
/** Numeric dotted comparison, so `0.14.10` is newer than `0.14.9`. */
function versionParts(version: string): number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** A parsed URL that is allowed to be contacted for signal-cli. */
function githubUrl(raw: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:" || !GITHUB_HOST.test(url.hostname)) {
    throw new Error(`refusing to fetch signal-cli from ${url.hostname} (not a GitHub host)`);
  }
  return url;
}

/** Runs one fetch and names the network when it cannot even start. */
async function request(
  fetchImpl: FetchLike,
  url: string,
  timeoutMs: number,
  label: string,
  init: RequestInit = {},
): Promise<Response> {
  try {
    return await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: unknown) {
    throw new Error(`${label}: ${oneLine(err)}`);
  }
}

/**
 * Fetches a GitHub URL, following redirects by hand so each hop can be checked.
 * A `Location` outside the GitHub hosts is refused before it is contacted.
 */
async function githubFetch(
  fetchImpl: FetchLike,
  url: string,
  timeoutMs: number,
  label: string,
  init: RequestInit = {},
): Promise<Response> {
  let current = githubUrl(url, label);
  for (let hop = 0; ; hop++) {
    const response = await request(fetchImpl, current.href, timeoutMs, label, {
      ...init,
      redirect: "manual",
    });
    if (!REDIRECT_STATUS.has(response.status)) return response;
    if (hop >= MAX_REDIRECTS) {
      throw new Error(`${label} redirected more than ${MAX_REDIRECTS} times`);
    }
    const location = response.headers.get("location");
    if (location === null || location === "") {
      throw new Error(`${label} redirected without a location`);
    }
    current = githubUrl(new URL(location, current).href, `${label} redirect`);
  }
}

interface ReleaseJson {
  tag_name?: unknown;
  assets?: unknown;
}

interface AssetJson {
  name?: unknown;
  browser_download_url?: unknown;
}

/** An asset that looks like the generic archive and points at itself on GitHub. */
function releaseAsset(asset: AssetJson): { version: string; name: string; url: string } | undefined {
  if (typeof asset.name !== "string" || typeof asset.browser_download_url !== "string") {
    return undefined;
  }
  const match = ASSET_NAME.exec(asset.name);
  if (!match?.[1]) return undefined;

  let url: URL;
  try {
    url = githubUrl(asset.browser_download_url, `the download URL for ${asset.name}`);
  } catch {
    return undefined;
  }
  // The URL must name the same archive: a name that disagrees with the bytes it
  // downloads is not trusted.
  if (path.posix.basename(url.pathname) !== asset.name) return undefined;
  return { version: match[1], name: asset.name, url: url.href };
}

/**
 * The latest release's generic archive. Throws one reason when GitHub cannot be
 * reached, the response is not a release, or no version-shaped archive exists.
 */
export async function latestRelease(fetchImpl: FetchLike = fetch): Promise<SignalCliRelease> {
  const response = await githubFetch(
    fetchImpl,
    RELEASE_API,
    API_TIMEOUT_MS,
    "cannot reach GitHub to look up the latest signal-cli release",
    { headers: { Accept: "application/vnd.github+json", "User-Agent": "SignalConnector" } },
  );
  if (!response.ok) {
    throw new Error(`the GitHub release lookup failed (HTTP ${response.status})`);
  }

  let release: ReleaseJson;
  try {
    release = (await response.json()) as ReleaseJson;
  } catch (err: unknown) {
    throw new Error(`the GitHub release response was not valid JSON: ${oneLine(err)}`);
  }
  const tag = typeof release.tag_name === "string" ? release.tag_name : "unknown";
  const assets = Array.isArray(release.assets) ? (release.assets as AssetJson[]) : [];

  let best: { version: string; name: string; url: string } | undefined;
  for (const asset of assets) {
    const candidate = releaseAsset(asset);
    if (!candidate) continue;
    if (!best || compareVersions(candidate.version, best.version) > 0) best = candidate;
  }
  if (!best) {
    throw new Error(
      `no signal-cli-<version>.tar.gz asset in the latest release (${tag})`,
    );
  }

  return {
    ...best,
    directory: `signal-cli-${best.version}`,
    tag,
  };
}

/** One stream read, so a broken body is a reason rather than a raw stack. */
async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>) {
  try {
    return await reader.read();
  } catch (err: unknown) {
    throw new Error(`the signal-cli archive could not be read: ${oneLine(err)}`);
  }
}

/**
 * Reads a response body into memory, stopping at the byte cap instead of after
 * an unbounded download. The declared length is checked first so the common
 * oversized case never reads a body at all.
 */
async function readCapped(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) {
    throw new Error(`the signal-cli archive is larger than ${MAX_ARCHIVE_BYTES} bytes`);
  }

  const body = response.body;
  if (body === null) return Buffer.alloc(0);

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await readChunk(reader);
      if (chunk.done) break;
      const value = chunk.value;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_ARCHIVE_BYTES) {
        await reader.cancel();
        throw new Error(`the signal-cli archive is larger than ${MAX_ARCHIVE_BYTES} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/**
 * Copies a release archive to `destination` within the time and byte bounds.
 */
async function download(
  fetchImpl: FetchLike,
  url: string,
  destination: string,
): Promise<void> {
  const response = await githubFetch(
    fetchImpl,
    url,
    DOWNLOAD_TIMEOUT_MS,
    "cannot download signal-cli from GitHub",
    { headers: { "User-Agent": "SignalConnector" } },
  );
  if (!response.ok) {
    throw new Error(`the signal-cli download failed (HTTP ${response.status})`);
  }

  const bytes = await readCapped(response);
  fs.writeFileSync(destination, bytes);
}

/** The production extractor: the system `tar`, which ships with Windows 10+. */
export function tarExtract(archive: string, destination: string): void {
  const result = spawnSync("tar", ["-xzf", archive, "-C", destination], {
    encoding: "utf8",
    timeout: DOWNLOAD_TIMEOUT_MS,
    windowsHide: true,
  });
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (result.error) {
    throw new Error(
      `cannot run tar: ${code === "ETIMEDOUT" ? "timed out" : oneLine(result.error)}`,
    );
  }
  if (result.status !== 0) {
    const text = oneLine(result.stderr || result.stdout || "");
    throw new Error(
      text.length > 0
        ? `tar extraction failed: ${text}`
        : `tar extraction failed (${result.status ?? "unknown"})`,
    );
  }
}

/** The launcher names a release's `bin/` directory may contain. */
const LAUNCHER = /^signal-cli(\.bat|\.cmd|\.exe)?$/i;

/** What order to prefer launchers in; Windows needs the `.bat` shim. */
function launcherRank(name: string, platform: NodeJS.Platform): number {
  const extension = path.extname(name).toLowerCase();
  if (platform === "win32") {
    if (extension === ".bat") return 0;
    if (extension === ".cmd") return 1;
    if (extension === ".exe") return 2;
    return 3;
  }
  if (extension === "") return 0;
  if (extension === ".exe") return 1;
  return 2;
}

/** The best launcher directly inside `binDir`, or undefined when there is none. */
function launcherIn(
  binDir: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(binDir, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const launchers = entries
    .filter((entry) => entry.isFile() && LAUNCHER.test(entry.name))
    .sort(
      (a, b) =>
        launcherRank(a.name, platform) - launcherRank(b.name, platform) ||
        a.name.localeCompare(b.name),
    );
  const best = launchers[0];
  return best ? path.join(binDir, best.name) : undefined;
}

/**
 * Every usable copy under `<dataDir>/signal-cli/signal-cli-<version>/`, newest
 * first. Read-only: a missing root is simply no copies, and nothing is created.
 */
export function installedCopies(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
): InstalledSignalCli[] {
  const root = path.join(dataDir, "signal-cli");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const copies: InstalledSignalCli[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = ARCHIVE_ROOT.exec(entry.name);
    if (!match?.[1]) continue;
    const home = path.join(root, entry.name);
    const launcher = launcherIn(path.join(home, "bin"), platform);
    if (launcher) copies.push({ version: match[1], home, path: launcher });
  }
  return copies.sort((a, b) => compareVersions(b.version, a.version));
}

function randomSuffix(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Downloads and extracts the latest release under `<dataDir>/signal-cli`.
 *
 * Idempotent: an installed copy short-circuits before any network call. The
 * archive lands in a temp directory, is unpacked into a staging directory on
 * the destination volume, and only the complete `signal-cli-<version>` tree is
 * moved into place; every failure removes both the temp file and the staging
 * directory, so nothing is left half-unpacked.
 */
export async function installSignalCli(
  options: SignalCliInstallOptions,
): Promise<SignalCliInstall> {
  const { dataDir } = options;
  const fetchImpl = options.fetch ?? fetch;
  const extract = options.extract ?? tarExtract;
  const print = options.print ?? ((): void => {});

  const existing = installedCopies(dataDir)[0];
  if (existing) return { ...existing, downloaded: false };

  print("looking up the latest signal-cli release on GitHub...");
  const release = await latestRelease(fetchImpl);

  const root = path.join(dataDir, "signal-cli");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-connector-signal-cli-"));
  const archive = path.join(tempDir, release.name);
  const staging = path.join(root, `.staging-${randomSuffix()}`);

  try {
    print(`downloading ${release.name}...`);
    await download(fetchImpl, release.url, archive);

    print(`extracting ${release.name}...`);
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(staging, { recursive: true });
    extract(archive, staging);

    // The archive's own top-level directory must be the version its name
    // claims, and it must carry a launcher: anything else is not trusted.
    const unpacked = path.join(staging, release.directory);
    if (!fs.existsSync(unpacked) || !fs.statSync(unpacked).isDirectory()) {
      throw new Error(`the archive did not contain ${release.directory}`);
    }
    if (!launcherIn(path.join(unpacked, "bin"))) {
      throw new Error(`the archive did not contain ${release.directory}/bin/signal-cli`);
    }

    const target = path.join(root, release.directory);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(unpacked, target);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const installed = installedCopies(dataDir)[0];
  if (!installed) {
    throw new Error(`signal-cli was extracted but no launcher was found under ${root}`);
  }
  return { ...installed, downloaded: true };
}
