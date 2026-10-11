/**
 * `npm run dry` — exercise the full loop without Signal or opencode.
 * A console SignalPort prints messages; a scripted AgentPort emits a task
 * lifecycle (status -> files changed -> permission -> done + diff). Type
 * commands on stdin: `/use demo`, `/task add a retry`, `approve`, etc.
 */
import readline from "node:readline";
import { writeDiffFile } from "../adapters/agent/diff.js";
import { ConfigSchema } from "../config/config.js";
import type { AgentPort, SignalPort, StartTaskInput } from "../core/ports.js";
import { CoreApp } from "../core/app.js";
import type {
  AgentEvent,
  IncomingMessage,
  OutgoingMessage,
  PermissionDecision,
  Reaction,
} from "../domain/types.js";
import { createLogger } from "../logging/logger.js";
import { openStore } from "../store/store.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class ConsoleSignal implements SignalPort {
  private messageHandlers: ((m: IncomingMessage) => void)[] = [];
  private reactionHandlers: ((r: Reaction) => void)[] = [];
  private seq = 0;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async send(_channelId: string, text: string): Promise<OutgoingMessage> {
    process.stdout.write(`[signal] ${text}\n`);
    return { messageId: `m${++this.seq}` };
  }
  async edit(_channelId: string, messageId: string, text: string): Promise<void> {
    process.stdout.write(`[signal edit ${messageId}] ${text}\n`);
  }
  async attach(_channelId: string, filePath: string, caption?: string): Promise<OutgoingMessage> {
    process.stdout.write(`[signal attach] ${filePath}${caption ? ` (${caption})` : ""}\n`);
    return { messageId: `a${++this.seq}` };
  }
  onMessage(handler: (m: IncomingMessage) => void): void {
    this.messageHandlers.push(handler);
  }
  onReaction(handler: (r: Reaction) => void): void {
    this.reactionHandlers.push(handler);
  }
  emitMessage(message: IncomingMessage): void {
    for (const handler of this.messageHandlers) handler(message);
  }
}

class ScriptedAgent implements AgentPort {
  private handlers: ((e: AgentEvent) => void)[] = [];
  private waiters = new Map<string, (d: PermissionDecision) => void>();
  private seq = 0;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async health(): Promise<boolean> {
    return true;
  }

  async startTask(input: StartTaskInput): Promise<{ sessionId: string }> {
    const sessionId = input.sessionId ?? `dry-${++this.seq}`;
    void this.run(input.taskId);
    return { sessionId };
  }
  async newSession(): Promise<{ sessionId: string }> {
    return { sessionId: `dry-${++this.seq}` };
  }
  subscribe(handler: (e: AgentEvent) => void): void {
    this.handlers.push(handler);
  }
  async answerPermission(permissionId: string, decision: PermissionDecision): Promise<void> {
    const waiter = this.waiters.get(permissionId);
    if (waiter) {
      this.waiters.delete(permissionId);
      waiter(decision);
    }
  }
  async abort(): Promise<void> {}

  private emit(event: AgentEvent): void {
    for (const handler of this.handlers) handler(event);
  }

  private async run(taskId: string): Promise<void> {
    const at = (): number => Date.now();
    this.emit({ type: "status", taskId, at: at(), text: "planning" });
    await sleep(400);
    this.emit({ type: "files-changed", taskId, at: at(), files: ["src/example.ts"] });
    await sleep(400);
    const permissionId = `perm-${taskId}`;
    const decision = await new Promise<PermissionDecision>((resolve) => {
      this.waiters.set(permissionId, resolve);
      this.emit({
        type: "permission",
        taskId,
        at: at(),
        permission: {
          id: permissionId,
          taskId,
          tool: "bash",
          description: "run npm test",
          safe: false,
        },
      });
    });
    if (decision === "reject") {
      this.emit({ type: "error", taskId, at: at(), text: "permission denied" });
      return;
    }
    await sleep(400);
    this.emit({ type: "tests-run", taskId, at: at(), text: "12 passed" });
    this.emit({
      type: "idle",
      taskId,
      at: at(),
      summary: "dry-run complete",
      diffPath: writeDiffFile("--- src/example.ts\n@@ -1 +1 @@\n-a\n+b"),
    });
  }
}

async function main(): Promise<void> {
  const logger = createLogger({ level: "info", console: false });
  const store = openStore(":memory:");
  const signal = new ConsoleSignal();
  const agent = new ScriptedAgent();
  const config = ConfigSchema.parse({
    signal: { account: "+0000" },
    projects: [{ name: "demo", path: process.cwd() }],
  });
  const app = new CoreApp({ store, signal, agent, config, logger });
  await app.start();

  process.stdout.write(
    "dry-run: type `/use demo` then `/task <prompt>`; answer with `approve`/`deny`. Ctrl+C exits.\n",
  );

  const say = (text: string): void =>
    signal.emitMessage({
      id: String(Date.now()),
      channelId: "self",
      sender: "+0000",
      text,
      at: Date.now(),
      inControlChannel: true,
    });

  if (process.argv.includes("--demo")) {
    setTimeout(() => say("/use demo"), 200);
    setTimeout(() => say("/task add a retry to the client"), 600);
    setTimeout(() => say("approve"), 1800);
    setTimeout(() => {
      void app.stop().then(() => {
        store.close();
        process.exit(0);
      });
    }, 3200);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("line", (line) => say(line));
  process.on("SIGINT", () => {
    void app.stop().then(() => {
      store.close();
      process.exit(0);
    });
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`dry-run failed: ${String(err)}\n`);
  process.exit(1);
});
