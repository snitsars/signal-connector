# SignalConnector

Control a local **opencode** coding agent from a **Signal** chat. One operator starts tasks,
watches progress, approves permission prompts, and receives results — from their phone.

Windows-first, cross-platform. TypeScript / ESM / Node ≥ 20.

## Status

Stage 1 is implemented and unit-tested (32 tests). Live Signal verification still needs a linked
account. Planning artifacts live in `_bmad-output/initiative-signal-connector/`.

## Try it without Signal (dry run)

```bash
npm install
npm run dry -- --demo      # scripted walkthrough: task -> permission -> done + diff
npm run dry                # interactive: type /use demo, /task ..., approve
```

The dry run uses an in-memory store and console/scripted ports — no Signal or opencode needed.

## Architecture

Ports & adapters (hexagonal). `src/core/` depends only on `SignalPort` / `AgentPort`; adapters
live in `src/adapters/`. One SQLite DB is the single source of runtime state. See
`_bmad-output/initiative-signal-connector/architecture-signal-connector/` (AD-1..AD-9).

```
src/
  core/       router, task lifecycle, progress, ports, CoreApp
  adapters/
    signal/   signal-cli JSON-RPC client, daemon manager, device link, rate limiter
    agent/    opencode v2 server adapter, CLI fallback, event mapper, diff
    fakes/    in-memory ports for tests
  store/      SQLite
  config/     config.toml loader, DPAPI secrets
  cli/        link, dry-run
```

## Host setup (live Signal)

Prerequisites:

- **Java 25** and **signal-cli** on PATH (or set `signal.cliPath`).
- **opencode v2** installed and authenticated (`opencode auth login`).

Steps:

1. `npm install`
2. `npm run link` — prints a `sgnl://linkdevice?...` URI; scan it in Signal →
   Settings → Linked Devices → Link New Device. The account is printed when linked.
3. Edit `%APPDATA%\SignalConnector\config.toml`:
   ```toml
   [signal]
   account = "+1..."        # the linked number
   manageDaemon = true      # let the service start signal-cli itself
   [channel]
   kind = "note-to-self"
   [agent]
   kind = "opencode-server"
   serverUrl = "http://127.0.0.1:4096"
   [[projects]]
   name = "myproject"
   path = "C:\\Sources\\myproject"
   ```
4. `npm run dev`

Then, in Signal Note-to-Self:

```
/projects
/use myproject
/task add a retry to the HTTP client
approve        # when a permission prompt appears
```

## Commands

| Command | Effect |
|---|---|
| `/projects` | list configured projects |
| `/use <project>` | set the active project |
| `/task <prompt>` | start a task in the active project |
| `/status` | show the latest task state |
| `/new` | fork a fresh session for the active project |
| `/stop` | abort the running task |
| `/approve` `/deny` `/always` | answer a permission prompt (or react 👍/👎) |
| `/help` | help |

Free-form text is sent to the active project's session.

## Scripts

- `npm run build` — compile to `dist/`
- `npm run typecheck` — `tsc --noEmit`
- `npm test` — vitest
- `npm run dev` — run the daemon
- `npm run dry -- --demo` — offline walkthrough

## Security

Secrets (Signal account credentials, API keys) go through `src/config/secrets.ts`
(Windows DPAPI, per-user). They are never written to the repo or to a log line. See AD-9.
