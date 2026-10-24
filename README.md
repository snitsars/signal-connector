# SignalConnector

Control a local **opencode** coding agent from a **Signal** chat. One operator starts tasks,
watches progress, approves permission prompts, and receives results — from their phone.

Windows-first, cross-platform. TypeScript / ESM / Node ≥ 22.13.

## Status

Stage 1 is implemented and unit-tested. Live Signal verification still needs a linked account.
Planning artifacts live in `_bmad-output/initiative-signal-connector/`.

## Quick start

**What you need:** Node.js 22.13 or newer, a JDK (17 or newer; recent signal-cli releases are
built for 25), opencode, and a phone with Signal. The connector fetches signal-cli itself — do not
install it by hand.

**Windows (PowerShell):**

```powershell
git clone https://github.com/<you>/SignalConnector.git
cd SignalConnector
npm install
npm run build
node dist/index.js doctor     # what is missing, with the exact fix
node dist/index.js setup      # links your phone (QR) and writes config.toml
node dist/index.js            # start the daemon; leave this window open
```

**macOS / Linux:** the same commands in a shell (the packaging is the same; only the scripts in
`scripts/` are PowerShell).

Then open this project in **opencode** (setup installed the plugin into
`~/.config/opencode/plugins`), and from your phone send `/open <project>` in **Note to Self** to give
the project its own group. Send `/task <prompt>` in that group — you will get one status message that
edits itself, approvals as replies, and the final summary.

**What each prerequisite is for:**

| Prerequisite | Why | Fix `doctor` prints |
|---|---|---|
| Node ≥ 22.13 | the daemon and its SQLite store | install from nodejs.org |
| Java 17+ | runs signal-cli | `pwsh scripts/ensure-java.ps1`, or a JDK 25 |
| signal-cli | the Signal transport | `setup` fetches it; `scripts/install-signal-cli.ps1` |
| opencode | the agent this bridges to | install opencode, then open the project |
| data directory | config, store, logs, voice temp files | `setup` creates it |
| config.toml | projects and Signal account | `setup` links and writes it |
| secret store | API/transcription keys, never in the repo | `setup` reports DPAPI/keychain/file |

If `doctor` and `setup` disagree, run `doctor` again after `setup`: it is the read-only view of the
same registry. `setup` is safe to run as often as you like; it skips what already passes.

## Try it without Signal (dry run)

```bash
npm install
npm run dry -- --demo      # scripted walkthrough: task -> permission -> done + diff
npm run dry                # interactive: type /open demo, /task ..., approve
```

The dry run uses an in-memory store and console/scripted ports — no Signal or opencode needed.

## Doctor and setup

```bash
npm run build
node dist/index.js doctor   # report readiness — changes nothing
node dist/index.js setup    # apply what is missing — safe to re-run
node dist/index.js plugin status    # installed | stale | absent | conflict
node dist/index.js plugin install   # copy the plugin into ~/.config/opencode/plugins
```

`doctor` runs every registered check and prints one line per step (`ok`, `missing`, `failed`, with
the exact fix where there is one), exiting non-zero if anything is missing or failed. It never
writes a config, creates the data directory, constructs the secret store or opens the daemon.
`setup` walks the same registry in the same order, skips steps that already pass, applies the rest
and stops at the first failure, so a rerun resumes from there.

The first run needs no hand edit. When `config.toml` does not exist, the device-link step starts
signal-cli, prints a QR image at `<data dir>\link-qr.png` (and the URI), waits for the scan, and
then writes `config.toml` with the linked number, the installed signal-cli command, the plugin
agent and one project named after the current directory. The QR image and the link are injected in
the tests, so the suite never needs a phone. Run `setup` from the project you want to work in:

```bash
cd C:\Sources\myapp
node dist/index.js setup
```

An existing `config.toml` is the operator's work: setup never rewrites, merges or reorders it. If
it has a `signal.account`, the step is `ok` and nothing is linked. If the file exists without an
account, the step stops and prints the exact line to add (`account = "+<your number>"` under
`[signal]`) and leaves the file byte-identical. A refused or timed-out link writes no config and
still stops the daemon; the retry is another `setup` run.

When no signal-cli is configured or on PATH, `setup` fetches one: it asks GitHub for the latest
release, downloads the generic `signal-cli-<version>.tar.gz` (pure Java, not the Linux-native build),
checks that the archive names the version it claims, and extracts it with the system `tar` into
`<data dir>/signal-cli/signal-cli-<version>`. The step then finds that copy, so no config edit is
needed to get it installed. signal-cli needs Java 17 or newer, and recent releases need the
configured JDK (0.14.9 is compiled for Java 25); an already-installed copy is never downloaded
again. On Windows the generated `config.toml` names that JDK with
`-cp <data dir>/signal-cli/signal-cli-<version>/lib/* org.asamk.signal.Main` rather than the
shipped `.bat`, whose long classpath overflows cmd's line limit under a deep data directory (a
hand-written config must do the same). The download is bounded and only GitHub hosts are
contacted, and `doctor` never downloads anything. Offline, the step stays `missing` with a
one-line reason and `scripts/install-signal-cli.ps1` as the manual fallback.

`plugin install` copies the packaged `plugins/signal-connector.ts` into `~/.config/opencode/plugins`
and prints the version it wrote; `plugin status` compares the installed bytes with the packaged ones
and prints `installed`, `stale`, `absent` or `conflict`. A project-local
`.opencode/plugins/signal-connector.ts` shadows the global copy, so it is named as the conflict and
is never overwritten or deleted.

The registry checks, in order: the Node floor (>= 22.13), Java (the configured JDK or `java` on
PATH), signal-cli (the configured `signal.command`/`signal.cliPath`, a PATH copy, or an installed
copy under the data directory), the Signal device link (`config.toml` exists and names an account;
applied only when the file is absent), opencode (the configured `agent.opencodePath` or PATH), the
data directory, `config.toml` (present and valid, read without creating anything), the secret store
(the kind actually in use on this platform), and the opencode plugin (installed and byte-identical
to the package).
The daemon runs the same registry before it opens the store, starts
signal-cli or launches a browser; if any step is missing it prints those lines and exits 1.

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
  config/     config.toml loader, platform secret stores
  cli/        args, setup (doctor/setup), link, dry-run
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
3. Open a project in opencode. The plugin at `plugins/signal-connector.ts` (installed globally by
   `scripts/start-all.ps1` or `signal-connector plugin install`) connects, registers its project,
   and starts handling commands.

**Multi-project quick start** — one command installs the plugin globally, sets plugin mode,
starts the service, and opens each project in opencode:

```powershell
pwsh scripts/start-all.ps1 -Projects C:\Sources\appA, C:\Sources\appB
```

Each project registers and the service sends a Signal greeting you can **reply to**:

```
Project "appA" connected. Everything here is about this project.
```

**Addressing a project:**
- `/open <project>` to give it its own group and window, then send commands there, or
- **reply (quote) any message that belongs to a project** — the service routes that reply to the
  same project automatically (it tracks which project each outgoing message came from).

### Channels: one control group, one group per project

The configured `[channel]` is the **control group**: general commands (`/projects`, `/help`, `/open`) happen there. There is no `/use` — routing is by channel, so no sticky active project.

`/open <project>` gives the project **its own group** — created on first use,
containing only the operator, so nothing is shared with anyone else — and from then on that project's
output, approvals and menus live in that group. Messages sent *in* a project's group are about that
project, whatever the control group's active project is. Each project's group is recorded in the
store (`project_channels`), so it is reused rather than recreated.

Replies are threaded by quoting the project's greeting, which is also what a quoted reply is routed
by. With one group per project this is mostly cosmetic; it still helps if you keep everything in one
channel instead.

```toml
[channel]
kind = "group"
id = "7UHdP8CJ7S+cOc3Qx9RPrVRR8OyaFYfvXWjT1G8SfOI="   # the control group
```

**Working in one session:** by default each `/task` creates a fresh opencode session. To send
commands into a session you already have open, pin the project to it:

```toml
[[projects]]
name = "SignalConnector"
path = 'C:\Sources\SignalConnector'
session = 'ses_ec42cabb8ffe8UkLJmCcd8w06c'   # the id shown in OPENCODE_SESSION_ID
```

Restart the service after editing, and `/new` moves the project off the pin.

### Summoning a meeting

`/meet <link>` in a project's group joins that room as the project's avatar. Who may
summon one is configured per project: `meet.allow` lists the accepted identities (a
Signal uuid/ACI, or the number), and an absent or empty list refuses every paste —
it never accepts by default.

```toml
[[projects]]
name = "SignalConnector"
path = 'C:\Sources\SignalConnector'
meet = { allow = [{ id = "+1000", label = "+1000" }], providers = ["meet.jit.si"] }
# retire an entry without deleting it:
# meet = { allow = [{ id = "+1000", label = "+1000", revokedAt = "2026-01-01T00:00:00Z" }] }
```

The number works today, and a uuid entry is honoured when you know it; when both a uuid
and a number entry could match, the uuid is the identity. A message from the linked phone
is the operator's own device by construction, so it passes regardless of the entry.

A paste is honoured only from a configured identity, and only for a well-formed `https`
room link on an accepted provider host that answers a short reachability probe. No
provider host is assumed: name the hosts your rooms live on with
`meet.providers = ["your.host"]`, or every paste is refused as a foreign provider. Each
refusal names its own category — “not authorised”, “malformed link”, “not the configured
meeting provider”, “could not reach the room”, “already running” — and never echoes the
link.

### Hearing the room

A meeting is also a microphone for the project's session. Once the avatar is admitted,
speech is copied inside the page, gated by energy and transcribed — **locally** by default,
or by the hosted recogniser you configure — and posted in the project's group as
`heard: <text>` before it is sent to the same session a typed task uses.

Nothing heard is ever a command, an approval or a stop: a spoken "approve" decides no
permission — while one waits it is refused aloud and explained in the group, and otherwise it
is an ordinary prompt. Audio that never rises above the noise floor is dropped and counted
instead of being transcribed, so a small model cannot invent an instruction out of room tone. A
missing or failing transcriber is posted in the group with its reason, and the meeting keeps
running.

The tool and models are fetched, never installed from npm and never hosted by this
project; a hosted recogniser is opt-in with your own key. If you prefer a hosted model,
set `transcriber = "http"` (any OpenAI-compatible `/v1/audio/transcriptions`, for example
OpenAI's `gpt-4o-transcribe`) or `transcriber = "nvidia"` (NVIDIA Riva), and store the key
as the `transcription-api-key` secret. `transcriptionPrompt` lists names the recogniser
should spell as typed, which is the cheapest accuracy win for product names.

```powershell
pwsh scripts/install-whisper.ps1 -Model small   # whisper.cpp + small model + Silero VAD
```

The generated `config.toml` already has a `[voice]` table, so put the three printed keys
inside it (these are the defaults for the rest):

```toml
# inside the existing [voice] table
whisperPath = 'C:\Users\you\AppData\Local\SignalConnector\whisper\whisper-cli.exe'
modelPath = 'C:\Users\you\AppData\Local\SignalConnector\whisper\models\ggml-small.bin'
vadPath = 'C:\Users\you\AppData\Local\SignalConnector\whisper\models\ggml-silero-v6.2.0.bin'
language = "uk"          # pin the language you speak; "auto" flips on short clips
rmsFloor = 0.01          # audio below this RMS is room tone, not speech
minUtteranceMs = 300     # a shorter window is a click, not a question
silenceMs = 900          # silence that closes an utterance
maxUtteranceMs = 15000   # the longest single utterance
ackCooldownMs = 4000     # at most one spoken acknowledgement per this window
bargeInMs = 400          # sustained speech before the answer is stopped
```

The VAD model is what keeps room tone from becoming a sentence: whisper skips the segments
Silero says are not speech. Pinning `language` matters too — auto-detection on a two-second
clip will happily switch between Ukrainian, Russian and English.

Every utterance is one short 16 kHz WAV in the data dir, deleted immediately after the local
run; no audio is retained beyond it. With both paths empty, a meeting still joins and shows
the face — it is simply deaf, and says so when someone speaks.

### Talking back

The avatar also answers out loud, through the same synthetic microphone the room already
receives — no new stream, socket or protocol. By default speech is made **locally**: Piper,
a neural voice fetched the way whisper.cpp is, speaks when it is configured; otherwise the
Windows system voice (SAPI) is the fallback. Nothing is hosted and no API key is involved.
A hosted voice is opt-in: `synthesizer = "azure"` uses Azure Speech (native `uk-UA` voices
such as `OstapNeural`, key stored as `azure-speech-key`), `"http"` uses any OpenAI-compatible
`/v1/audio/speech`, and `"edge"` uses the Microsoft Edge voices.

```powershell
pwsh scripts/install-piper.ps1 -Voice oleksa   # male, high; or mykyta, tetiana, ukrainian_tts
```

Paste the two printed keys into the existing `[voice]` table:

```toml
piperPath = 'C:\Users\you\AppData\Local\SignalConnector\piper\piper\piper.exe'
piperVoicePath = 'C:\Users\you\AppData\Local\SignalConnector\piper\voices\uk_UA-oleksa-high.onnx'
```

With both set, the avatar speaks with Piper; with either missing it falls back to SAPI. A
missing voice or a failed run is posted once in the group and the meeting keeps running.

A spoken question gets a short acknowledgement the moment the utterance is cut — that clip is
made once when listening starts, so a cold local run cannot blow the two-second budget — and the
task's summary is spoken when the task finishes. The acknowledgement is rate-limited by
`ackCooldownMs`, so a burst of fragments cannot turn the room into a chorus of acknowledgements. A task
started by **typing** in the group is never spoken.

An answer is spoken in pieces: sentence by sentence, so the room hears the first sentence while
the rest is still being made. With an English Azure voice (`azureVoiceEnglish`), a Latin run
inside a Ukrainian sentence — a product name, a quoted English phrase — goes to that voice,
while the Ukrainian around it stays with `azureVoice`; with a single voice,
`voice.pronunciations` maps names to the spelling that voice reads correctly.

A voice task that has not answered within `workingCueMs` says one short line
(`workingCue`, default "Ще працюю.") instead of leaving the room in silence; the answer
replaces it. Speech is copied to the group first, so the text is always authoritative.

While a meeting is live, a permission waiting for an answer is announced aloud too; the decision
is still typed in Signal (**approve**, **deny** or **always**), never spoken.

Three rules keep it from being a nuisance: the operator's own voice stops the avatar
mid-sentence after `bargeInMs` of sustained speech (a single click or noise spike does not) and
drops the clips still queued behind it; a failure of the voice is posted once in the group and
the meeting keeps running; and a long answer is trimmed to `maxSpeechChars` before it is read —
the full text always stays in the group message.

```toml
# inside the existing [voice] table
voiceName = ""           # a Windows system voice; "" picks the default
rate = 0                 # speaking rate, -10..10
maxSpeechChars = 600     # longest answer read aloud; the group keeps all of it
workingCueMs = 8000      # say workingCue if no answer by now; 0 stays silent
workingCue = "Ще працюю."
freshSession = true      # own session per meeting; false keeps the pinned context
# Azure hosted voice (needs the azure-speech-key secret):
# synthesizer = "azure"
# azureRegion = "northeurope"
# azureVoice = "uk-UA-OstapNeural"
# azureVoiceEnglish = "en-US-JennyNeural"
# azureRate = "-5%"
```

Each spoken clip is one temp WAV in the data dir, deleted as soon as the page has it.

### Message colours

Signal has no coloured text, so state is carried by circles. The language:

| Mark | Means | Used for |
|---|---|---|
| 🔵 | working | a task's live status line (starting, running) |
| 🟢 | all fine | task completed |
| 🔴 | needs attention | task failed, an approval is waiting, opencode asked a question, a launch/model/group operation failed |
| 🟡 | worth knowing | milestones, notices, `/open` confirmations, model switches, approvals answered, general replies |

Text styles run alongside: bold for headers, monospace for ids, paths, tools and
model names, strikethrough and italic where they help.

### Interactive choices (tap instead of type)

Signal messages are plain text, so there are no buttons to send. The equivalent is a **reaction**:
an assistant message can offer options by ending with a marker, and the service posts them as a
numbered, tappable menu.

```
Which approach do you want?
<<options: add a retry loop | revert the change | do both>>
```

In Signal this becomes:

```
Option #1 — tap a reaction or reply with the number:
1. ❤️ add a retry loop
2. 👍 revert the change
3. 👎 do both
```

The operator either taps one of the six reactions in Signal's quick row (❤️ 👍 👎 😂 😮 😢, or the
keycap digits) or replies with the bare number. Either way the option's text is sent into the
project's session as the next prompt. The marker is stripped from the message text. With several
menus open, a reaction targets the menu it was tapped on; a bare number only counts while exactly
one menu is open.

The emoji map lives in `CHOICE_EMOJI` (`src/core/progress.ts`), and the marker grammar in
`extractOptions` (`plugins/signal-connector.ts`). Several picks can be sent at once (`1,3`); numbers
answer the newest open menu, and any other free-form prompt closes open menus. Menus survive the end
of the task that opened them — asking at the end of a turn is the normal case.

### Inbound attachments

An image (or any file) sent to the control channel is fetched from the daemon
(`getAttachment`, base64), written to `<dataDir>/media/<timestamp>-<name>`, and the path is added to
the prompt as `[attached file: …]`. The agent runs on the same machine and opens the file directly,
so no extra plugin protocol is involved. Attachments over 10 MiB are reported and skipped, and file
names are sanitized so a name cannot escape the media dir. Media rides on free-form messages only —
`/task …` does not carry an attachment.

**Outbound** (opencode → operator) uses the same idea as option menus — name the files in the
message:

```
Here is the screenshot you asked for.
<<send: C:\tmp\shot.png>>
```

The marker is stripped from the text shown in Signal and each path is sent as an attachment (several
paths can be `|`-separated). A path that cannot be sent is reported back instead of failing quietly.

### Questions

opencode's own questions (the popup with options) can only be answered by its own client: this build
exposes no question API to plugins, so the connector cannot answer them from Signal. It does the next
best thing — it tells you a question is waiting, so the agent is not left blocking in silence:

```
Project: Phoenix
opencode is asking a question — it has to be answered in the window; the agent is waiting.
```

Project-scoped output (status, milestones, summaries, errors, permission prompts) is prefixed with
the project it came from, so you always know the source:

```
Project: appA
Task 3f9c… (running) — editing src/http.ts
```

```
Signal  <->  service (Signal + router)  <--WebSocket-->  plugin (per project)  <->  opencode
```

Message flow: the service receives a Signal command, routes it to the active project's plugin;
the plugin runs it via the SDK `client`; progress/permissions flow back as bridge events and are
rendered to Signal. Approvals are answered from Signal and relayed to the plugin.

## Host setup (Windows, scripted)

Prerequisites: Windows 10+, Node ≥ 22.13. The scripts install the rest.

```powershell
# 1. Java 25 + signal-cli + device link + config.toml, with next steps printed
npm install
npm run build
node dist/index.js setup                     # scan the QR; safe to re-run

# 2. Start the opencode v2 server (background)
pwsh scripts/start-opencode.ps1

# 3. Run the daemon
pwsh scripts/run.ps1                         # = npm run dev
```

`scripts/setup.ps1` remains the PowerShell-only alternative for the Java and signal-cli install;
it stops before the device link and never rewrites an existing config. If you use it, link with
`pwsh scripts/link-device.ps1` (or `npm run link`) and add the printed number to `signal.account`
by hand.

Scripts:

| Script | Does |
|---|---|
| `scripts/setup.ps1` | ensure Java 25, install signal-cli, write `%APPDATA%\SignalConnector\config.toml`, print next steps |
| `scripts/ensure-java.ps1` | verify/install Microsoft OpenJDK 25 via winget |
| `scripts/install-signal-cli.ps1` | download latest signal-cli into `%LOCALAPPDATA%\SignalConnector\signal-cli`, print `signal-cli.bat` |
| `scripts/install-whisper.ps1` | download whisper.cpp, a multilingual model and the Silero VAD model into `%LOCALAPPDATA%\SignalConnector\whisper`, print the `[voice]` paths |
| `scripts/install-piper.ps1` | download Piper and a Ukrainian neural voice into `%LOCALAPPDATA%\SignalConnector\piper`, print `piperPath` / `piperVoicePath` |
| `scripts/start-opencode.ps1` | start `opencode serve` on `127.0.0.1:4096` if not already up |
| `scripts/link-device.ps1` | run `npm run link` (device QR) |
| `scripts/run.ps1` | run the daemon (`npm run dev`) |
| `scripts/start-all.ps1` | plugin mode: install plugin globally, set `agent.kind=plugin`, start service, open projects |
| `scripts/stop.ps1` | stop the service + signal-cli daemon (`-All` also stops opencode serve) |
| `scripts/restart.ps1` | stop then start the service |

A reference config lives at `scripts/config.example.toml`.

### Manual equivalent

1. `npm install && npm run build`.
2. `node dist/index.js setup` — it installs Java 25 and signal-cli if needed, shows the QR to link
   the device, and writes `config.toml` with the linked number and one project (the current
   directory). Run it from the project you want to work in.
3. `opencode serve` (or set `agent.serverUrl` to your server).
4. `npm run dev`.

To add more projects later, edit `[[projects]]` by hand; setup never rewrites an existing config.

Then, in Signal Note-to-Self:

```
/projects
/open myproject
/task add a retry to the HTTP client
approve        # when a permission prompt appears
```

## Commands

| Command | Effect |
|---|---|
| `/projects` | list configured projects |
| `/open <project>` | give the project its own group, open its window, start following it |
| `/models` | list this project's models and pick one (tap the poll or reply with a number) |
| `/model <provider/id>` | switch the session's model directly |
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

## Troubleshooting

Start with `doctor`. Its lines map to the fix:

| What you see | What to do |
|---|---|
| The daemon prints doctor lines and exits 1 | A prerequisite is missing; run `setup`, then `doctor` again. |
| `signal-cli … missing` | `setup` downloads it under the data directory; without network run `scripts/install-signal-cli.ps1`. |
| `config … missing` | `setup` links the phone and writes `config.toml`; it never overwrites an existing file. |
| `config.toml has no account` | Add the `account = "+…"` line `setup` printed, or rerun `setup` after moving the old file away. |
| `plugin stale` | `node dist/index.js plugin install`, then restart opencode. |
| `plugin conflict` | Remove `<project>/.opencode/plugins/signal-connector.ts` — the global copy in `~/.config/opencode/plugins` is the one to keep. |
| A task says the agent is unavailable | opencode is not running or the project is not open; open it, then retry. |
| `heard:` is followed by a dropped-utterance note | The room was too quiet or the transcriber is not configured; check the `[voice]` section. |
| A meeting refuses the link | `meet.providers` must name the host, and `meet.allow` must contain your identity; an empty list refuses everyone. |
| No sound in a meeting | `doctor` for the voice binaries, check `synthesizer`, and confirm `voice.bargeIn` is not fighting you. |

## Upgrade

```bash
npm install -g .          # or: npm install -g signal-connector, once published
signal-connector plugin install   # replace a stale plugin copy
signal-connector doctor           # confirm every step is ok
```

Then restart the daemon (and opencode, so it reloads the plugin). Config, the store and secrets stay
where they were; `setup` only adds what is missing.

## Uninstall

1. Stop the daemon (Ctrl+C, or `pwsh scripts/stop.ps1` on Windows).
2. `npm uninstall -g signal-connector` (or remove the checkout).
3. Delete `~/.config/opencode/plugins/signal-connector.ts` (and any project copy).
4. Delete the data directory: `%APPDATA%\SignalConnector` on Windows,
   `~/.config/SignalConnector` elsewhere. This removes the store, logs and secrets; export anything
   you want to keep first.

## Releasing

One tag produces both artifacts: the npm package and a GitHub release with the same tarball and its
SHA-256.

1. Bump `version` in `package.json` and commit it.
2. Push a matching tag: `git tag v0.1.0 && git push origin v0.1.0`.
3. `release.yml` checks the tag against the manifest, runs typecheck, tests and build, publishes to
   npm with provenance, and creates the release with `signal-connector-<version>.tgz` and its
   checksum.

The workflow needs an `NPM_TOKEN` repository secret (an npm automation token). Without it the publish
step fails before anything is uploaded; the checksum and the GitHub release are still produced only
after a successful publish, so a failed run leaves no half-release.

## Security

Secrets (Signal account credentials, API keys) go through `src/config/secrets.ts`. They are never
written to the repo, the config file, a log line or an error message. See AD-9.

Where they live, per platform:

| Platform | Store | Location |
|---|---|---|
| Windows | DPAPI, per-user | `<data dir>\secrets\<key>.dat` |
| macOS | Keychain (`security`) | service `signal-connector`, account is the key |
| Linux | Secret Service (`secret-tool`) | attributes `service=signal-connector`, `key=<key>` |
| Any platform without the keyring tool | JSON file | `<data dir>/secrets/secrets.json` |

The data directory is `%APPDATA%\SignalConnector` on Windows and
`~/.config/SignalConnector` elsewhere. On macOS and Linux the keyring is used when its tool is
installed; if the tool is absent or a keyring command fails, the store falls back to the file.
The file is **plaintext at rest**: the directory is created `0700` and the file `0600`, and every
write replaces the file atomically, so only the current user can read it. On Windows the existing
DPAPI files and their format are unchanged.

`node dist/index.js doctor` names the store actually selected, and `src/config/secrets.ts` exposes
the same choice as `secretStoreKind(dir)`.
