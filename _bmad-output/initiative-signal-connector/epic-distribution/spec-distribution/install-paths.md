# Install paths and prerequisites

Companion to `spec-distribution.md`. The channels the product ships through, what
each one requires of the newcomer, and what the product must handle itself.

## Channels

| Channel | What the user gets | What they must have | Product must handle |
|---|---|---|---|
| npm (`npx <pkg>` / `npm i -g <pkg>`) | the daemon, the CLI, the plugin file | Node ≥ 20 | post-install hint, `--version`, guided first run |
| GitHub release zip | the same tree, no registry round trip | Node ≥ 20 | a single documented command, per-OS archive naming |
| Git clone (today, and stays) | the development tree | Node ≥ 20, git | unchanged scripts; the reference path for contributors |

## External prerequisites

| Piece | Needed for | Detected by | If missing |
|---|---|---|---|
| Node ≥ 20 | everything | `process.versions.node` | refuse to start, name the minimum |
| Java (25 today) | running signal-cli | `java -version` / configured path | `/doctor` names it, `install-signal-cli` explains; first run may fetch |
| signal-cli | Signal transport | configured `signal.cliPath`/`command`, else PATH | fetch the release for the current OS and Java major, or instruct |
| opencode | the agent side | `opencode` on PATH, or `agent.kind = plugin` with a connected plugin | install path documented for plugin mode; `opencode serve` for server mode |
| A Signal account + phone | linking the secondary device | `signal.account` present and the daemon answering | the first run prints the QR and waits, then persists the linked account |

## Platform notes

- **Windows** — works today. `%APPDATA%\SignalConnector` for config, DPAPI for secrets, `signal-cli.bat` or a direct `java -cp` invocation (the `.bat` overflows the command-line limit on long install paths, hence `signal.command`).
- **macOS / Linux** — the same code paths except the install scripts (PowerShell only) and secrets (DPAPI only, with an in-memory fallback that loses credentials on restart). `XDG_CONFIG_HOME`/`~/.config` is already the fallback for the data directory.
- **Data directory** — `%APPDATA%/SignalConnector` on Windows, `~/.config/SignalConnector` elsewhere, so both paths must stay supported equally.

## What the product must not require

- A repository clone, a specific shell, a Windows-only facility, elevation, a native toolchain, or hand-editing `config.toml`.
- Any secret in a file the user is asked to write: the Signal account is linked interactively, never typed into configuration.
