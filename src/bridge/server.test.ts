import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeHub } from "./hub.js";
import { startBridgeServer, type BridgeServer } from "./server.js";
import { createLogger } from "../logging/logger.js";

const logger = createLogger({ level: "error", console: false });
const started: { server: BridgeServer; port: number }[] = [];
const blockers: Server[] = [];

/** Occupy a port, as a second SignalConnector instance would. */
async function occupy(port = 0): Promise<number> {
  const blocker = createServer();
  blockers.push(blocker);
  await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", resolve));
  return (blocker.address() as AddressInfo).port;
}

function start(port: number): BridgeServer {
  const server = startBridgeServer(new BridgeHub(), { host: "127.0.0.1", port, logger });
  started.push({ server, port });
  return server;
}

afterEach(() => {
  for (const { server } of started.splice(0)) server.close();
  for (const blocker of blockers.splice(0)) blocker.close();
});

describe("bridge server", () => {
  it("reports itself ready once the port is bound", async () => {
    // Port 0: the assertion is about binding, not about a particular number.
    const server = start(0);
    await expect(server.ready).resolves.toBeUndefined();
  });

  it("refuses to bind a port another instance holds", async () => {
    const port = await occupy();
    // The port is also the single-instance lock: a second instance has to learn
    // about it here, before it adopts the signal-cli daemon and starts a second
    // receive loop that wedges the daemon.
    await expect(start(port).ready).rejects.toThrow(/EADDRINUSE|already in use/i);
  });
});
