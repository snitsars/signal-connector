import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareVersions,
  installSignalCli,
  installedCopies,
  latestRelease,
  MAX_ARCHIVE_BYTES,
  RELEASE_API,
  type ExtractArchive,
  type FetchLike,
} from "./signalCliInstall.js";

const DOWNLOAD = "https://github.com/AsamK/signal-cli/releases/download/v0.14.9/signal-cli-0.14.9.tar.gz";

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

/** A GitHub release body with the generic archive plus the usual decoys. */
function releaseBody(
  assets: ReleaseAsset[] = [
    { name: "signal-cli-0.14.9-Linux-native.tar.gz", browser_download_url: "https://github.com/AsamK/signal-cli/releases/download/v0.14.9/signal-cli-0.14.9-Linux-native.tar.gz" },
    { name: "signal-cli-0.14.9.tar.gz", browser_download_url: DOWNLOAD },
    { name: "signal-cli-0.14.9.zip", browser_download_url: "https://github.com/AsamK/signal-cli/releases/download/v0.14.9/signal-cli-0.14.9.zip" },
  ],
  tag = "v0.14.9",
): Response {
  return new Response(JSON.stringify({ tag_name: tag, assets }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

interface Scripted {
  fetch: FetchLike;
  urls: string[];
}

/** A fetch whose every call is recorded; the handler can be async. */
function scriptedFetch(
  handler: (url: string) => Response | Promise<Response>,
): Scripted {
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    urls.push(url);
    return handler(url);
  };
  return { fetch: fetchImpl, urls };
}

/** A fetch that answers the release lookup and the archive download. */
function happyFetch(): Scripted {
  return scriptedFetch((url) =>
    url === RELEASE_API
      ? releaseBody()
      : new Response(new Uint8Array([31, 139, 8, 0]), {
          status: 200,
          headers: { "content-length": "4" },
        }),
  );
}

/** Writes the layout the real archive has: `<version>/bin/signal-cli`. */
function fakeExtractor(version = "0.14.9"): ExtractArchive {
  return (_archive, destination) => {
    const bin = path.join(destination, `signal-cli-${version}`, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "signal-cli"), "#!/bin/sh\n");
  };
}

function tempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sc-signal-cli-"));
}

function installedLauncher(dataDir: string, version: string): string {
  const bin = path.join(dataDir, "signal-cli", `signal-cli-${version}`, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const launcher = path.join(bin, "signal-cli");
  fs.writeFileSync(launcher, "#!/bin/sh\n");
  return launcher;
}

function onlyVersionDirs(dataDir: string): string[] {
  const root = path.join(dataDir, "signal-cli");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((name) => name.startsWith("signal-cli-") || name.startsWith(".staging-"));
}

describe("compareVersions", () => {
  it("compares numeric parts, not strings", () => {
    expect(compareVersions("0.14.10", "0.14.9")).toBeGreaterThan(0);
    expect(compareVersions("0.14.9", "0.14.9")).toBe(0);
    expect(compareVersions("0.9", "0.14.9")).toBeLessThan(0);
  });
});

describe("latestRelease", () => {
  it("picks the generic archive and ignores the native build and the zip", async () => {
    const { fetch, urls } = happyFetch();

    const release = await latestRelease(fetch);

    expect(release.version).toBe("0.14.9");
    expect(release.name).toBe("signal-cli-0.14.9.tar.gz");
    expect(release.directory).toBe("signal-cli-0.14.9");
    expect(release.url).toBe(DOWNLOAD);
    expect(release.tag).toBe("v0.14.9");
    expect(urls).toEqual([RELEASE_API]);
  });

  it("chooses the newest generic archive when the release carries several", async () => {
    const { fetch } = scriptedFetch(() =>
      releaseBody([
        { name: "signal-cli-0.14.9.tar.gz", browser_download_url: DOWNLOAD },
        {
          name: "signal-cli-0.14.10.tar.gz",
          browser_download_url:
            "https://github.com/AsamK/signal-cli/releases/download/v0.14.10/signal-cli-0.14.10.tar.gz",
        },
      ]),
    );

    await expect(latestRelease(fetch)).resolves.toMatchObject({ version: "0.14.10" });
  });

  it("names the release when it has no version-shaped archive", async () => {
    const { fetch } = scriptedFetch(() =>
      releaseBody(
        [{ name: "signal-cli-0.14.9.tar.gz.zip", browser_download_url: DOWNLOAD }],
        "v0.15.0",
      ),
    );

    await expect(latestRelease(fetch)).rejects.toThrow(
      /no signal-cli-<version>\.tar\.gz asset.*v0\.15\.0/,
    );
  });

  it("does not trust an asset whose URL names another version", async () => {
    const { fetch } = scriptedFetch(() =>
      releaseBody([
        {
          name: "signal-cli-0.14.9.tar.gz",
          browser_download_url:
            "https://github.com/AsamK/signal-cli/releases/download/v0.13.0/signal-cli-0.13.0.tar.gz",
        },
      ]),
    );

    await expect(latestRelease(fetch)).rejects.toThrow(/no signal-cli-<version>\.tar\.gz asset/);
  });

  it("rejects an asset hosted outside GitHub", async () => {
    const { fetch } = scriptedFetch(() =>
      releaseBody([
        {
          name: "signal-cli-0.14.9.tar.gz",
          browser_download_url: "https://mirror.example/signal-cli-0.14.9.tar.gz",
        },
      ]),
    );

    await expect(latestRelease(fetch)).rejects.toThrow(/no signal-cli-<version>\.tar\.gz asset/);
  });

  it("reports an HTTP failure as one reason", async () => {
    const { fetch } = scriptedFetch(() => new Response("nope", { status: 503 }));

    await expect(latestRelease(fetch)).rejects.toThrow(/HTTP 503/);
  });

  it("reports a non-JSON body without a stack", async () => {
    const { fetch } = scriptedFetch(() => new Response("<html>", { status: 200 }));

    await expect(latestRelease(fetch)).rejects.toThrow(/not valid JSON/);
  });

  it("names the network when GitHub cannot be reached", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("getaddrinfo ENOTFOUND api.github.com");
    };

    const failure = latestRelease(fetchImpl);
    await expect(failure).rejects.toThrow(/GitHub.*ENOTFOUND/);
    await failure.catch((err: Error) => expect(err.message).not.toContain("\n"));
  });

  it("refuses a redirect to a non-GitHub host before following it", async () => {
    const { fetch, urls } = scriptedFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/signal-cli-0.14.9.tar.gz" },
        }),
    );

    await expect(latestRelease(fetch)).rejects.toThrow(/not a GitHub host/);
    expect(urls).toEqual([RELEASE_API]);
  });

  it("stops after too many redirects", async () => {
    const { fetch, urls } = scriptedFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://api.github.com/again" },
        }),
    );

    await expect(latestRelease(fetch)).rejects.toThrow(/redirected more than 5 times/);
    expect(urls).toHaveLength(6);
  });

  it("follows a redirect within GitHub hosts", async () => {
    const { fetch, urls } = scriptedFetch((url) =>
      url === RELEASE_API
        ? new Response(null, {
            status: 302,
            headers: { location: "https://api.github.com/redirected" },
          })
        : releaseBody(),
    );

    await expect(latestRelease(fetch)).resolves.toMatchObject({ version: "0.14.9" });
    expect(urls).toEqual([RELEASE_API, "https://api.github.com/redirected"]);
  });
});

describe("installedCopies", () => {
  it("returns nothing for a data directory without an install", () => {
    const dataDir = tempDataDir();
    try {
      expect(installedCopies(dataDir)).toEqual([]);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("finds copies newest first and ignores staging and stray directories", () => {
    const dataDir = tempDataDir();
    try {
      const oldLauncher = installedLauncher(dataDir, "0.14.9");
      const newLauncher = installedLauncher(dataDir, "0.14.10");
      fs.mkdirSync(path.join(dataDir, "signal-cli", ".staging-123"), { recursive: true });
      fs.mkdirSync(path.join(dataDir, "signal-cli", "not-a-version"), { recursive: true });
      fs.mkdirSync(path.join(dataDir, "signal-cli", "signal-cli-0.1.0"), { recursive: true });

      const copies = installedCopies(dataDir);

      expect(copies.map((copy) => copy.version)).toEqual(["0.14.10", "0.14.9"]);
      expect(copies.map((copy) => copy.path)).toEqual([newLauncher, oldLauncher]);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("prefers the Windows batch launcher on win32 and the script elsewhere", () => {
    const dataDir = tempDataDir();
    try {
      const bin = path.join(dataDir, "signal-cli", "signal-cli-0.14.9", "bin");
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, "signal-cli"), "#!/bin/sh\n");
      fs.writeFileSync(path.join(bin, "signal-cli.bat"), "@echo off\n");

      expect(installedCopies(dataDir, "win32")[0]?.path).toBe(path.join(bin, "signal-cli.bat"));
      expect(installedCopies(dataDir, "linux")[0]?.path).toBe(path.join(bin, "signal-cli"));
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("installSignalCli", () => {
  it("downloads, extracts and leaves the launcher under the data directory", async () => {
    const dataDir = tempDataDir();
    try {
      const { fetch, urls } = happyFetch();
      const lines: string[] = [];

      const result = await installSignalCli({
        dataDir,
        fetch,
        extract: fakeExtractor(),
        print: (line) => lines.push(line),
      });

      expect(result.downloaded).toBe(true);
      expect(result.version).toBe("0.14.9");
      expect(result.path).toBe(
        path.join(dataDir, "signal-cli", "signal-cli-0.14.9", "bin", "signal-cli"),
      );
      expect(fs.existsSync(result.path)).toBe(true);
      expect(urls).toEqual([RELEASE_API, DOWNLOAD]);
      expect(lines.some((line) => line.includes("downloading"))).toBe(true);
      expect(onlyVersionDirs(dataDir)).toEqual(["signal-cli-0.14.9"]);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("downloads nothing when a copy is already installed", async () => {
    const dataDir = tempDataDir();
    try {
      const launcher = installedLauncher(dataDir, "0.14.9");
      const { fetch, urls } = happyFetch();

      const result = await installSignalCli({ dataDir, fetch, extract: fakeExtractor() });

      expect(result).toMatchObject({ downloaded: false, version: "0.14.9", path: launcher });
      expect(urls).toEqual([]);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("leaves nothing half-unpacked when extraction fails", async () => {
    const dataDir = tempDataDir();
    try {
      const { fetch } = happyFetch();
      const extract: ExtractArchive = (_archive, destination) => {
        fs.mkdirSync(path.join(destination, "signal-cli-0.14.9", "bin"), { recursive: true });
        throw new Error("tar extraction failed: truncated archive");
      };

      await expect(installSignalCli({ dataDir, fetch, extract })).rejects.toThrow(
        /truncated archive/,
      );
      expect(onlyVersionDirs(dataDir)).toEqual([]);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects an archive whose top-level directory is another version", async () => {
    const dataDir = tempDataDir();
    try {
      const { fetch } = happyFetch();

      await expect(
        installSignalCli({ dataDir, fetch, extract: fakeExtractor("0.0.1") }),
      ).rejects.toThrow(/did not contain signal-cli-0\.14\.9/);
      expect(onlyVersionDirs(dataDir)).toEqual([]);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects a matching directory that has no launcher", async () => {
    const dataDir = tempDataDir();
    try {
      const { fetch } = happyFetch();
      const extract: ExtractArchive = (_archive, destination) => {
        fs.mkdirSync(path.join(destination, "signal-cli-0.14.9", "lib"), { recursive: true });
      };

      await expect(installSignalCli({ dataDir, fetch, extract })).rejects.toThrow(
        /bin\/signal-cli/,
      );
      expect(onlyVersionDirs(dataDir)).toEqual([]);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("writes nothing when the release has no usable archive", async () => {
    const dataDir = tempDataDir();
    try {
      const { fetch } = scriptedFetch(() => releaseBody([], "v0.15.0"));

      await expect(
        installSignalCli({ dataDir, fetch, extract: fakeExtractor() }),
      ).rejects.toThrow(/v0\.15\.0/);
      expect(fs.existsSync(path.join(dataDir, "signal-cli"))).toBe(false);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("names the network when offline and writes nothing", async () => {
    const dataDir = tempDataDir();
    try {
      const fetchImpl: FetchLike = async () => {
        throw new Error("fetch failed");
      };

      await expect(
        installSignalCli({ dataDir, fetch: fetchImpl, extract: fakeExtractor() }),
      ).rejects.toThrow(/GitHub.*fetch failed/);
      expect(fs.existsSync(path.join(dataDir, "signal-cli"))).toBe(false);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("refuses an archive over the size cap before writing it", async () => {
    const dataDir = tempDataDir();
    try {
      const { fetch } = scriptedFetch((url) =>
        url === RELEASE_API
          ? releaseBody()
          : new Response(new Uint8Array([1]), {
              status: 200,
              headers: { "content-length": String(MAX_ARCHIVE_BYTES + 1) },
            }),
      );

      await expect(
        installSignalCli({ dataDir, fetch, extract: fakeExtractor() }),
      ).rejects.toThrow(/larger than/);
      expect(onlyVersionDirs(dataDir)).toEqual([]);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
