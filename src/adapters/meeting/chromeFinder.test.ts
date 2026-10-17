import path from "node:path";
import { describe, expect, it } from "vitest";
import { candidatePaths, findBrowser } from "./chromeFinder.js";

const WIN_ENV = {
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  LOCALAPPDATA: "C:\\Users\\operator\\AppData\\Local",
};

const chromePath = path.win32.join(
  "C:\\Program Files",
  "Google",
  "Chrome",
  "Application",
  "chrome.exe",
);
const edgePath = path.win32.join(
  "C:\\Program Files (x86)",
  "Microsoft",
  "Edge",
  "Application",
  "msedge.exe",
);

describe("candidatePaths", () => {
  it("probes the standard Chrome and Edge locations on Windows", () => {
    expect(candidatePaths("chrome", "win32", WIN_ENV)[0]).toBe(chromePath);
    expect(candidatePaths("edge", "win32", WIN_ENV)[0]).toBe(edgePath);
    // Chrome also has a per-user install location.
    expect(candidatePaths("chrome", "win32", WIN_ENV)).toContain(
      path.win32.join(
        "C:\\Users\\operator\\AppData\\Local",
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
    );
  });

  it("has a location for the other platforms too", () => {
    expect(candidatePaths("chrome", "darwin", {})).toContain(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
    expect(candidatePaths("edge", "linux", {})).toContain("/usr/bin/microsoft-edge");
  });
});

describe("findBrowser", () => {
  it("prefers Chrome when both are installed", () => {
    const lookup = findBrowser({
      platform: "win32",
      env: WIN_ENV,
      exists: () => true,
    });
    expect(lookup).toEqual({ browser: { kind: "chrome", path: chromePath } });
  });

  it("falls back to Edge", () => {
    const lookup = findBrowser({
      platform: "win32",
      env: WIN_ENV,
      exists: (candidate) => candidate === edgePath,
    });
    expect(lookup).toEqual({ browser: { kind: "edge", path: edgePath } });
  });

  it("returns a reason instead of throwing when neither exists", () => {
    const lookup = findBrowser({
      platform: "win32",
      env: WIN_ENV,
      exists: () => false,
    });
    expect(lookup).toEqual({ reason: "neither Chrome nor Edge was found on this machine" });
  });
});
