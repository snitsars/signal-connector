import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeStatus,
  installPlugin,
  packageRoot,
  PLUGIN_FILE,
  pluginsDir,
  pluginStatus,
  projectPlugin,
  type PluginPaths,
} from "./plugin.js";

const PACKAGED = '// packaged plugin\nexport default { id: "signal-connector" };\n';
const EPOCH = new Date(1_000_000);

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A package root with a manifest and a packaged plugin, plus temp home and cwd. */
function filesOf(version: string = "0.1.0", content: string = PACKAGED): PluginPaths {
  const root = tempDir("signal-connector-pkg-");
  fs.mkdirSync(path.join(root, "plugins"));
  fs.writeFileSync(path.join(root, "plugins", PLUGIN_FILE), content);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "signal-connector", version }, null, 2),
  );
  return { root, home: tempDir("signal-connector-home-"), cwd: tempDir("signal-connector-cwd-") };
}

/** The global target the helpers compute; tests never spell the path twice. */
function targetOf(paths: PluginPaths): string {
  return path.join(pluginsDir(paths.home), PLUGIN_FILE);
}

describe("paths", () => {
  it("puts the global copy in the opencode plugins directory under home", () => {
    const home = path.join(os.tmpdir(), "someone");
    expect(pluginsDir(home)).toBe(path.join(home, ".config", "opencode", "plugins"));
  });

  it("puts a project copy at .opencode/plugins in the working directory", () => {
    const cwd = path.join(os.tmpdir(), "a-project");
    expect(projectPlugin(cwd)).toBe(path.join(cwd, ".opencode", "plugins", PLUGIN_FILE));
  });

  it("resolves the package root that ships the manifest and the plugin", () => {
    const root = packageRoot();
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      name?: string;
    };
    expect(manifest.name).toBe("signal-connector");
    expect(fs.existsSync(path.join(root, "plugins", PLUGIN_FILE))).toBe(true);
  });
});

describe("pluginStatus", () => {
  it("reports absent, with the packaged version, when no copy exists", () => {
    const paths = filesOf("1.2.3");
    const status = pluginStatus(paths);

    expect(status.state).toBe("absent");
    expect(status.version).toBe("1.2.3");
    expect(status.path).toBe(targetOf(paths));
    expect(status.conflict).toBeUndefined();
    expect(status.code).toBe(1);
    expect(describeStatus(status)).toContain("absent");
    expect(describeStatus(status)).toContain("1.2.3");
  });

  it("reports installed when the bytes equal the packaged file", () => {
    const paths = filesOf();
    fs.mkdirSync(pluginsDir(paths.home), { recursive: true });
    fs.writeFileSync(targetOf(paths), PACKAGED);

    const status = pluginStatus(paths);
    expect(status.state).toBe("installed");
    expect(status.code).toBe(0);
    expect(describeStatus(status)).toContain("installed");
    expect(describeStatus(status)).toContain(status.version);
  });

  it("reports stale when the installed bytes differ", () => {
    const paths = filesOf();
    fs.mkdirSync(pluginsDir(paths.home), { recursive: true });
    fs.writeFileSync(targetOf(paths), `${PACKAGED}// hand-edited but the banner is old\n`);

    const status = pluginStatus(paths);
    expect(status.state).toBe("stale");
    expect(status.code).toBe(1);
    expect(describeStatus(status)).toContain("stale");
  });

  it("reports a project copy as a conflict and names its path", () => {
    const paths = filesOf();
    fs.mkdirSync(pluginsDir(paths.home), { recursive: true });
    fs.writeFileSync(targetOf(paths), PACKAGED);
    const local = projectPlugin(paths.cwd);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, `${PACKAGED}// project copy\n`);

    const status = pluginStatus(paths);
    expect(status.state).toBe("conflict");
    expect(status.conflict).toBe(local);
    expect(status.path).toBe(targetOf(paths));
    expect(status.code).toBe(1);
    expect(describeStatus(status)).toContain(local);
  });

  it("never writes and never creates the plugins directory", () => {
    const paths = filesOf();
    const before = [fs.readdirSync(paths.home), fs.readdirSync(paths.cwd)];

    pluginStatus(paths);

    expect([fs.readdirSync(paths.home), fs.readdirSync(paths.cwd)]).toEqual(before);
    expect(fs.existsSync(pluginsDir(paths.home))).toBe(false);
  });

  it("throws one clear reason when the packaged plugin is missing", () => {
    const paths = filesOf();
    fs.rmSync(path.join(paths.root, "plugins", PLUGIN_FILE));

    expect(() => pluginStatus(paths)).toThrow(/packaged plugin is missing/);
    expect(() => pluginStatus(paths)).toThrow(PLUGIN_FILE);
  });

  it("throws one clear reason when the manifest is missing", () => {
    const paths = filesOf();
    fs.rmSync(path.join(paths.root, "package.json"));

    expect(() => pluginStatus(paths)).toThrow(/package manifest is missing/);
  });
});

describe("installPlugin", () => {
  it("creates the plugins directory and writes the packaged bytes", () => {
    const paths = filesOf("2.0.0");

    const install = installPlugin(paths);

    expect(install.code).toBe(0);
    expect(install.status.state).toBe("absent");
    expect(fs.readFileSync(targetOf(paths), "utf8")).toBe(PACKAGED);
    expect(fs.statSync(pluginsDir(paths.home)).isDirectory()).toBe(true);
    expect(install.message).toContain("2.0.0");
    expect(install.message).toContain(targetOf(paths));
    expect(pluginStatus(paths).state).toBe("installed");
  });

  it("creates only the plugins directory under home", () => {
    const paths = filesOf();

    installPlugin(paths);

    expect(fs.readdirSync(paths.home)).toEqual([".config"]);
    expect(fs.readdirSync(path.join(paths.home, ".config"))).toEqual(["opencode"]);
    expect(fs.readdirSync(path.join(paths.home, ".config", "opencode"))).toEqual(["plugins"]);
    expect(fs.readdirSync(pluginsDir(paths.home))).toEqual([PLUGIN_FILE]);
    expect(fs.readdirSync(paths.cwd)).toEqual([]);
  });

  it("leaves a byte-identical install completely untouched", () => {
    const paths = filesOf();
    installPlugin(paths);
    fs.utimesSync(targetOf(paths), EPOCH, EPOCH);

    const second = installPlugin(paths);

    expect(second.code).toBe(0);
    expect(second.status.state).toBe("installed");
    expect(fs.statSync(targetOf(paths)).mtimeMs).toBeCloseTo(EPOCH.getTime(), 0);
    expect(fs.readFileSync(targetOf(paths), "utf8")).toBe(PACKAGED);
  });

  it("replaces a stale copy after the packaged file changes", () => {
    const paths = filesOf("0.1.0");
    installPlugin(paths);

    const changed = `${PACKAGED}// 0.2.0\n`;
    fs.writeFileSync(path.join(paths.root, "plugins", PLUGIN_FILE), changed);
    expect(pluginStatus(paths).state).toBe("stale");

    const install = installPlugin(paths);
    expect(install.code).toBe(0);
    expect(fs.readFileSync(targetOf(paths), "utf8")).toBe(changed);
    expect(pluginStatus(paths).state).toBe("installed");
  });

  it("writes the file when it is absent but the directory already exists", () => {
    const paths = filesOf();
    fs.mkdirSync(pluginsDir(paths.home), { recursive: true });

    expect(pluginStatus(paths).state).toBe("absent");
    expect(installPlugin(paths).code).toBe(0);
    expect(fs.readFileSync(targetOf(paths), "utf8")).toBe(PACKAGED);
  });

  it("refuses a project copy, names it, and overwrites nothing", () => {
    const paths = filesOf();
    const local = projectPlugin(paths.cwd);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, "// the operator's own copy\n");

    const install = installPlugin(paths);

    expect(install.code).toBe(1);
    expect(install.status.state).toBe("conflict");
    expect(install.message).toContain(local);
    expect(fs.readFileSync(local, "utf8")).toBe("// the operator's own copy\n");
    expect(fs.existsSync(targetOf(paths))).toBe(false);
  });

  it("leaves a stale global copy alone when a project copy conflicts", () => {
    const paths = filesOf();
    fs.mkdirSync(pluginsDir(paths.home), { recursive: true });
    fs.writeFileSync(targetOf(paths), "// older global copy\n");
    const local = projectPlugin(paths.cwd);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, "// project copy\n");

    expect(installPlugin(paths).code).toBe(1);
    expect(fs.readFileSync(targetOf(paths), "utf8")).toBe("// older global copy\n");
  });

  it("throws instead of installing when the packaged plugin is missing", () => {
    const paths = filesOf();
    fs.rmSync(path.join(paths.root, "plugins", PLUGIN_FILE));

    expect(() => installPlugin(paths)).toThrow(/packaged plugin is missing/);
    expect(fs.existsSync(targetOf(paths))).toBe(false);
  });

  it("reports a filesystem error as a message, not a throw", () => {
    const paths = filesOf();
    // A file where the directory chain has to be: mkdir cannot create it.
    fs.writeFileSync(path.join(paths.home, ".config"), "not a directory");

    const install = installPlugin(paths);

    expect(install.code).toBe(1);
    expect(install.message).toContain("could not install the plugin at");
    expect(install.message).toContain(targetOf(paths));
    expect(fs.existsSync(targetOf(paths))).toBe(false);
  });
});
