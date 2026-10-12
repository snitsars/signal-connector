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

## Integration modes

The service owns Signal, the command router, and state. The **agent side** has two modes:

- **Standalone** (`agent.kind = "opencode-server"` or `"opencode-cli"`): the service drives opencode
  directly (server API with CLI fallback). Good for a single project / agent-agnostic use.
- **Plugin** (`agent.kind = "plugin"`): the service routes commands to a per-project **opencode
  plugin** over a local WebSocket; the plugin executes them inside opencode and streams events and
  permission requests back. Use this for **multiple projects** — one Signal channel, no race.

### Plugin mode

The plugin targets **opencode v2** (`export default { id, setup }`; `ctx` is a server
client with `ctx.session.*`, `ctx.permission.*`, `ctx.event.subscribe`).

1. Set `agent.kind = "plugin"` in `config.toml` (bridge defaults to `127.0.0.1:8790`).
2. Run the service (`pwsh scripts/run.ps1`).
3. Open a project in opencode. The plugin at `.opencode/plugins/signal-connector.ts` connects,
   registers its project, and starts handling commands.

**Multi-project quick start** — one command installs the plugin globally, sets plugin mode,
starts the service, and opens each project in opencode:

```powershell
pwsh scripts/start-all.ps1 -Projects C:\Sources\appA, C:\Sources\appB
```

Each project registers and the service sends a Signal greeting you can **reply to**:

```
Project "appA" connected. Reply to this message to address it, or use /use appA.
```

**Addressing a project:**
- `/use <project>` then send commands, or
- **reply (quote) any message that belongs to a project** — the service routes that reply to the
  same project automatically (it tracks which project each outgoing message came from).

```
Signal  <->  service (Signal + router)  <--WebSocket-->  plugin (per project)  <->  opencode
```

Message flow: the service receives a Signal command, routes it to the active project's plugin;
the plugin runs it via the SDK `client`; progress/permissions flow back as bridge events and are
rendered to Signal. Approvals are answered from Signal and relayed to the plugin.

## Host setup (Windows, scripted)

Prerequisites: Windows 10+, Node ≥ 20. The scripts install the rest.

```powershell
# 1. Java 25 + signal-cli + config.toml, with next steps printed
pwsh scripts/setup.ps1                       # add -ProjectName myapp -ProjectPath C:\Sources\myapp

# 2. Start the opencode v2 server (background)
pwsh scripts/start-opencode.ps1

# 3. Link your Signal account (scan the QR shown in the terminal)
pwsh scripts/link-device.ps1                 # = npm run link

# 4. Put the printed number into signal.account, then run
pwsh scripts/run.ps1                         # = npm run dev
```

Scripts:

| Script | Does |
|---|---|
| `scripts/setup.ps1` | ensure Java 25, install signal-cli, write `%APPDATA%\SignalConnector\config.toml`, print next steps |
| `scripts/ensure-java.ps1` | verify/install Microsoft OpenJDK 25 via winget |
| `scripts/install-signal-cli.ps1` | download latest signal-cli into `%LOCALAPPDATA%\SignalConnector\signal-cli`, print `signal-cli.bat` |
| `scripts/start-opencode.ps1` | start `opencode serve` on `127.0.0.1:4096` if not already up |
| `scripts/link-device.ps1` | run `npm run link` (device QR) |
| `scripts/run.ps1` | run the daemon (`npm run dev`) |
| `scripts/start-all.ps1` | plugin mode: install plugin globally, set `agent.kind=plugin`, start service, open projects |
| `scripts/stop.ps1` | stop the service + signal-cli daemon (`-All` also stops opencode serve) |
| `scripts/restart.ps1` | stop then start the service |

A reference config lives at `scripts/config.example.toml`.

### Manual equivalent

1. Install Java 25 and signal-cli; set `signal.cliPath` to `signal-cli.bat`.
2. `opencode serve` (or set `agent.serverUrl` to your server).
3. `npm run link` — scan the QR; set `signal.account`.
4. `npm run dev`.

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
