---
title: 'Secrets that persist on every platform'
type: 'feature'
ticket: '7'
created: '2026-10-20'
status: 'built'
baseline_revision: '2f06b0d408369f88aeaf167886d7206d53847dd4'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['{project-root}/AGENTS.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `defaultSecretStore` returns DPAPI on Windows and an **in-memory** store everywhere
else, so a macOS or Linux operator loses every secret on restart — the distribution spec requires
credentials to survive a restart on all three platforms.

**Approach:** add a user-scoped file store (JSON, directory 0700, file 0600, atomic replace) as the
portable fallback, and an OS-keystore store that shells out to `security` on macOS and `secret-tool`
on Linux when the tool exists. Windows keeps DPAPI exactly as it is. `defaultSecretStore` picks
DPAPI → keychain → file, each injectable so tests need neither a keychain nor a linked account.

## Boundaries & Constraints

**Always:** no secret value in a log line, an error message, the repository or the config; file
writes are atomic (temp file in the same directory, then rename) and the directory is 0700; the
file fallback is documented as plaintext-at-rest with user-only permissions; a corrupt store fails
with a clear reason instead of silently returning nothing; the interface (`get/set/delete`) is
unchanged so every caller keeps working.

**Never:** no new dependency; no network; no secret printed by a command helper (the keyring command
receives the value on stdin or an argument but never echoes it); no change to the DPAPI format or
to existing Windows secrets.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Behavior | Error Handling |
|----------|--------------|-------------------|----------------|
| Restart | Value written by one store instance | A new instance reads it back | — |
| New file | No secrets file | First `set` creates the directory (0700) and the file (0600) | FS error → clear reason |
| Corrupt file | Invalid JSON | Read fails with the path and a parse reason | No silent empty value |
| Keyring present | `security` (macOS) or `secret-tool` (Linux) | Store uses it; value not echoed | Command failure → fall back to the file store |
| No keyring | Tool absent | File store is chosen and documented | — |
| Windows | win32 | DPAPI, unchanged | — |

</frozen-after-approval>

## Code Map

- `src/config/secrets.ts` -- `SecretStore` (9-13), `defaultSecretStore` (96-101), DPAPI (54-76):
  add `FileSecretStore`, `KeyringSecretStore`, `secretStoreKind`, and the selection chain.
- `src/config/secrets.test.ts` -- temp dirs: persistence across instances, 0700/0600 on POSIX,
  corrupt file, delete, keyring commands with an injected runner, selection with injected env.
- `src/cli/steps.ts` -- the secrets step reports the store kind from `secretStoreKind` instead of
  requiring PowerShell on every platform (Windows still needs one of the PowerShells).
- `README.md` -- where secrets live per platform and the file fallback's permissions.

## Tasks & Acceptance

**Execution:**
- [x] `secrets.ts` -- `FileSecretStore` (atomic JSON, 0700/0600), `KeyringSecretStore` for
  `security`/`secret-tool` with an injectable runner, `secretStoreKind(dir)`.
- [x] `secrets.ts` -- `defaultSecretStore`: win32 DPAPI; darwin keychain with file fallback; linux
  `secret-tool` when available, else file.
- [x] `secrets.test.ts` -- every matrix row; a restart is a second instance reading the same dir.
- [x] `steps.ts` -- the secrets step names the store kind and stops demanding PowerShell off Windows.
- [x] `README.md` -- the per-platform locations and permissions.

**Acceptance Criteria:**
- Given a value written on a POSIX platform, when a new process opens the same directory, then the
  value is read back.
- Given no keystore tool, then the file store is used and its permissions are user-only.
- Given a corrupt store, then the read fails with a reason that names the file, not a silent miss.
- Given Windows, then DPAPI is still used and existing secrets still read.
- Given the file store, then no secret appears in a log line or an error message.

## Implementation Notes

- `FileSecretStore` takes the secrets directory (`<data dir>/secrets`) and owns the file
  `secrets.json`. It is lazy: `get` on a missing directory returns `undefined`, and only the first
  `set` creates the directory. `ensureDir` re-applies `0700` with `chmod` when the umask or an
  existing directory left another mode, but only on POSIX.
- Writes are `open(temp, "wx", 0600)` → write → `fsync` → `chmod 0600` → `rename` in the same
  directory, with the temp file removed on any failure. The JSON map has a null prototype, so a key
  such as `__proto__` is data rather than a prototype write.
- A corrupt store fails every operation with the path and a fixed reason. The parser's own message
  is deliberately not reused: newer V8 versions quote part of the input, which may be a secret.
  File-system errors report the path and errno only. A `set` against a corrupt store refuses rather
  than overwriting values it could not read.
- `KeyringSecretStore` drives `security` (`find/add/delete-generic-password`, service
  `signal-connector`) or `secret-tool` (`lookup/store/clear`, attributes `service`/`key`). A value
  reaches `security` as an argument and `secret-tool` on stdin; no error includes the value or the
  argv that carried it. `security` exit 44 and a quiet `secret-tool` exit 1 mean absent; any other
  failure falls back to the injected `FileSecretStore`, and a thrown runner is treated the same.
- `secretStoreKind(dir, options)` and `defaultSecretStore(dir, options)` share one selection:
  win32 → DPAPI; darwin → `security` when present; other POSIX → `secret-tool` when present; else the
  file store. `hasCommand`, `platform` and `run` are injectable, so tests never touch a real
  keychain or linked account. The keyring's fallback is the same file path the daemon would use.
- `secretsStep` keeps the Windows PowerShell probe and reports DPAPI; off Windows it reports the
  selected kind (and the file path when that is the choice) and never probes PowerShell.
- Tests: `src/config/secrets.test.ts` (28; 2 POSIX-only permission cases skipped on this Windows
  host) covers restart across instances, first-set creation, 0700/0600, existing-directory tightening,
  atomic replace with no temp left, corrupt JSON/shape with no value in the message, delete,
  both keyring tools' argv/stdin/not-found/fallback paths, and selection for all three platforms.
  `src/cli/steps.test.ts` covers file/keyring selection and keeps the Windows PowerShell cases.
- Verified on this machine: `npm run typecheck` clean, `npm test` 561 passed / 2 skipped across 41
  files, `npm run build` clean, `node dist/index.js doctor` exit 0 with
  `secrets  pwsh.exe 7 is available for the DPAPI secret store`. A manual DPAPI write/read through
  two store instances and a file-store write/read both matched without printing a value.
- Residual: the live `security` and `secret-tool` commands were exercised only through injected
  runners, and the POSIX `0700`/`0600` assertions were skipped on this Windows host; both are marked
  for a POSIX manual check.

## Plan Change Log

## Review Triage Log

## Design Notes

- **Why a file before a keystore:** the keystore tools are not always installed (headless Linux);
  the file store is the one path that always works, and the keystore is preferred when present.
- **Why atomic replace:** a crash mid-write must not leave a half-written JSON that makes every
  later read fail.
- **Why the kind is a function:** doctor reports what is actually in use, and tests can assert the
  selection without touching the real keychain.

## Verification

**Commands:**
- `npm run typecheck` -- expected: exits 0
- `npm test` -- expected: all suites pass
- `npm run build` -- expected: exits 0
- `node dist/index.js doctor` -- expected: the secrets line names the store kind and exits 0

**Manual checks:**
- Write and read a value through the store on this machine; confirm no value appears in the log.
- Inspect the file's permissions on a POSIX host.
