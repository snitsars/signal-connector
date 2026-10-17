/**
 * `npm run dry` — exercise the full loop without Signal or opencode.
 * A console SignalPort prints messages; a scripted AgentPort emits a task
 * lifecycle (status -> files changed -> permission -> done + diff). Type
 * commands on stdin: `/use demo`, `/task add a retry`, `approve`, etc.
 */
import readline from "node:readline";
import { writeDiffFile } from "../adapters/agent/diff.js";
import { ConfigSchema } from "../config/config.js";
import type { AgentPort, QuoteRef, SendOptions, SignalPort, StartTaskInput } from "../core/ports.js"
import { CoreApp } from "../core/app.js";
import type {
  AgentEvent,
  IncomingMessage,
  OutgoingMessage,
  ModelRef,
  PermissionDecision,
  PollVote,
  Reaction,
} from "../domain/types.js";
import { createLogger } from "../logging/logger.js";
import { openStore } from "../store/store.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class ConsoleSignal implements SignalPort {
  private messageHandlers: ((m: IncomingMessage) => void)[] = [];
  private reactionHandlers: ((r: Reaction) => void)[] = [];
  private pollVoteHandlers: ((v: PollVote) => void)[] = [];
  private seq = 0;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async createGroup(name: string): Promise<{ groupId: string }> {
    return { groupId: `group-${name.toLowerCase()}` };
  }

  async send(_channelId: string, text: string, options?: SendOptions): Promise<OutgoingMessage> {
    process.stdout.write(`[signal] ${text}\n`);
    return { messageId: `m${++this.seq}` };
  }
  async sendPoll(
    _channelId: string,
    question: string,
    options: string[],
    _allowMultiple = false,
    _quote?: QuoteRef,
  ): Promise<OutgoingMessage> {
    process.stdout.write(
      `[signal poll] ${question}\n${options.map((o, i) => `  ${i + 1}. ${o}`).join("\n")}\n`,
    );
    return { messageId: `poll${++this.seq}` };
  }
  onPollVote(handler: (v: PollVote) => void): void {
    this.pollVoteHandlers.push(handler);
  }
  async edit(_channelId: string, messageId: string, text: string, _options?: SendOptions): Promise<void> {
    process.stdout.write(`[signal edit ${messageId}] ${text}\n`);
  }
  async attach(
    _channelId: string,
    filePath: string,
    caption?: string,
    _quote?: QuoteRef,
  ): Promise<OutgoingMessage> {
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

  async listModels(): Promise<ModelRef[]> {    return [
      { providerID: "demo", id: "model-a", name: "demo/model-a" },
      { providerID: "demo", id: "model-b", name: "demo/model-b" },
    ];
  }

  async setModel(): Promise<void> {}
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
  isConnected(): boolean {
    return true;
  }
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
    [
      "dry-run: the console stands in for Signal. Type a command and press Enter:",
      "  /open demo                     give the project its own group and open it",
      "  then anything you type goes to that group as a task about the project",
      "  approve | deny                 answer a permission prompt",
      "Ctrl+C exits. `--demo` runs the whole sequence by itself.",
      "",
    ].join("\n"),
  );

  /** Emit a message into a channel; the control channel is the default. */
  const say = (text: string, channelId = "self", inControlChannel = true): void =>
    signal.emitMessage({
      id: String(Date.now()),
      channelId,
      sender: "+0000",
      text,
      at: Date.now(),
      inControlChannel,
      delivery: "data",
    });

  if (process.argv.includes("--demo")) {
    // The project's own group is where its tasks run, so the demo opens the
    // group first and then talks in it — the flow the phone uses.
    const group = "group-demo";
    setTimeout(() => say("/open demo"), 200);
    setTimeout(() => say("add a retry to the client", group, false), 900);
    setTimeout(() => say("approve", group, false), 2000);
    setTimeout(() => {
      void app.stop().then(() => {
        store.close();
        process.exit(0);
      });
    }, 3600);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // Anything typed after /open demo belongs to that project's group.
  rl.on("line", (line) => {
    const group = store.getChannel("demo")?.channelId ?? "self";
    say(line, group, group === "self");
  });
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
