import { describe, expect, it } from "vitest";
import { expandArgv } from "./command.js";
import {
  freeAgentName,
  herdrAgentName,
  parseAgentList,
  parseWorkspaceCreate,
  sameCwd,
} from "./herdr.js";

const CREATE_OUTPUT = JSON.stringify({
  id: "cli:workspace:create",
  result: {
    root_pane: { pane_id: "w2:p1", workspace_id: "w2" },
    workspace: { workspace_id: "w2", label: "Phoenix" },
    type: "workspace_created",
  },
});

describe("parseWorkspaceCreate", () => {
  it("reads the workspace and pane ids from Herdr's JSON", () => {
    expect(parseWorkspaceCreate(CREATE_OUTPUT)).toEqual({ workspaceID: "w2", paneID: "w2:p1" });
  });

  it("returns nothing rather than throwing on unexpected output", () => {
    expect(parseWorkspaceCreate("")).toEqual({});
    expect(parseWorkspaceCreate("herdr: command not found")).toEqual({});
    expect(parseWorkspaceCreate("{}")).toEqual({});
  });
});

const AGENT_LIST = JSON.stringify({
  result: {
    agents: [
      {
        agent: "opencode",
        name: "phoenix",
        cwd: "C:\\Sources\\Phoenix",
        workspace_id: "w5",
        agent_session: { agent: "opencode", kind: "id", value: "ses_abc123" },
      },
      { agent: "opencode", cwd: "C:\\Sources\\SignalConnector", workspace_id: "w1" },
    ],
  },
});

describe("parseAgentList", () => {
  it("reads names, cwds, workspaces and the session the pane shows", () => {
    expect(parseAgentList(AGENT_LIST)).toEqual([
      { name: "phoenix", cwd: "C:\\Sources\\Phoenix", workspaceID: "w5", sessionID: "ses_abc123" },
      { cwd: "C:\\Sources\\SignalConnector", workspaceID: "w1" },
    ]);
  });

  it("returns nothing rather than throwing", () => {
    expect(parseAgentList("not json")).toEqual([]);
    expect(parseAgentList("{}")).toEqual([]);
  });
});

describe("sameCwd", () => {
  it("ignores separators, trailing slashes and case", () => {
    expect(sameCwd("C:\\Sources\\Phoenix\\", "C:/Sources/Phoenix")).toBe(true);
    expect(sameCwd("C:\\Sources\\Phoenix", "C:\\Sources\\Other")).toBe(false);
    expect(sameCwd(undefined, "C:\\Sources\\Phoenix")).toBe(false);
  });
});

describe("freeAgentName", () => {
  it("keeps the plain name when it is free", () => {
    expect(freeAgentName(["other"], "phoenix")).toBe("phoenix");
  });

  it("suffixes when the name is taken, and stays within 32 chars", () => {
    expect(freeAgentName(["phoenix"], "phoenix")).toBe("phoenix-2");
    expect(freeAgentName(["phoenix", "phoenix-2"], "phoenix")).toBe("phoenix-3");
    const long = freeAgentName(["a".repeat(32)], "a".repeat(32));
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long).not.toBe("a".repeat(32));
  });
});

describe("herdrAgentName", () => {
  it("satisfies Herdr's name rules", () => {
    expect(herdrAgentName({ id: "phoenix", name: "Phoenix", path: "/p" })).toBe("phoenix");
    expect(herdrAgentName({ id: "x", name: "My App!", path: "/p" })).toBe("my-app-");
    expect(herdrAgentName({ id: "x", name: "Ünïcode", path: "/p" })).toBe("n-code");
    expect(herdrAgentName({ id: "x", name: "!!!", path: "/p" })).toBe("agent");
  });

  it("truncates to 32 characters", () => {
    const long = herdrAgentName({ id: "x", name: "a".repeat(50), path: "/p" });
    expect(long.length).toBeLessThanOrEqual(32);
  });
});

describe("expandArgv", () => {
  it("substitutes the project placeholders", () => {
    expect(expandArgv(["opencode", "{path}"], { id: "p", name: "Phoenix", path: "C:\\Src\\Phx" })).toEqual([
      "opencode",
      "C:\\Src\\Phx",
    ]);
    expect(expandArgv(["--label={name}"], { id: "p", name: "Phoenix", path: "/p" })).toEqual([
      "--label=Phoenix",
    ]);
  });
});
