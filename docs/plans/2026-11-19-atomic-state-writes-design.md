# Atomic state writes: a reader never sees a half-written file, and never writes "empty" back

## Why

State files that the daemon, its service processes and the CLI read are written in place with `writeFileSync`. A
write in place truncates the file first and fills it after, so a reader in another process (or the same process after
a crash) can read an empty or half-written file. Most readers catch the parse error as "no file yet", start from an
empty value, and on their next change write that empty value back over the file. The data is then gone for good:
pinned machines, the trust group's roster, paired clients, the remote-password lockout, the recap history.

Found by a read-only audit of `main` at `e948919b33` (session e2e-flakes). The atomic helper already exists
(`atomicWriteJson`, `cli/src/lib/registry.ts:589`) but most state writers do not use it, and the readers have no
shared rule for a parse error.

## Goals

1. Every write of a file another reader or process can read is atomic: temporary file in the same folder, written,
   `fchmod` to its mode, `fsync`, closed, renamed over the target, folder flushed (where the platform can). Same mode as
   today (`0600` for secrets and state, `0700` for the scripts that are run). On every platform, Windows included.
2. A reader that finds a file it cannot parse never treats it as empty and writes empty state back.
3. One helper, one way: the existing `atomicWriteJson` becomes that helper (moved, not copied); every state writer
   listed below uses it; the in-place paths are removed in the same pull request.
4. A guard test fails when a module that owns a listed state file writes it outside the helper.
5. A red-then-green test that reproduces the torn read (or torn write) for each serious item.

## Non-goals

- **Lost updates** between two processes that both read, modify and write the same file (gateway and CLI pinning a
  peer at the same moment). A different cause; the orchestrator opens a follow-up after this lands.
- Moving any state to another store, or changing a file's format, name or location.
- Changing the registry's own persistence (`registryPersistence.ts`), which is already atomic.

## Anti-goals

- A broken trust file that silently resets trust: a machine that was blocked trusted again, an identity replaced.
- A broken cache file that leaves a feature broken until the person deletes a file by hand.
- A full path, file content or secret in a log line.

## The two kinds of state file (decided by the orchestrator, 2026-11-19)

The helper takes one flag per file that says which kind it is. One mechanism, two outcomes:

| Kind | Files | A file that cannot be parsed |
|---|---|---|
| **Trust** (fail closed) | `e2e/identity.json`, `e2e/paired.json`, `e2e/remotePassword.json`, `e2e/group.json`, `e2e/group-blocked.json`, `e2e/machinePeers.json`, `e2e/machinePeers-gone.json`, the device key log store, the per-account copies under `e2e/accounts/<account>/`, the auth session, the hook credential | Left exactly as it is. Reads give the fail-closed value (nobody paired, no peer trusted, the group cannot merge); every write that would replace it throws a named `StateFileUnreadable` instead. One log line per file per process names the file's base name, the kind of failure and how to fix it (move the file aside). `harness status` reads the same files through the same reader and prints one line per unreadable one, with its full path and the fix. The next read tries again, so a file that becomes good heals on its own. |
| **Cache** (set aside) | Everything else in this spec: the recap files, the machine list, the host theme, pid files (see below), the runtime pointer, the browser shim, the ZDOTDIR `.zshenv`, the Hermes boot file, the uninstall marker, the machine name, the computer id | Renamed to `<name>.unreadable` (one copy kept: a newer one replaces the older), one log line (base name and kind), then read as missing and carried on as empty. |

Before either outcome, a parse error is retried a bounded number of times (a few tries over well under a second):
an older build that still writes in place can be mid-write during an update handover. A file missing is "missing",
never an error.

### Fail-closed details for the trust stores

- `E2eeStore` (`paired.json`, `remotePassword.json`, `identity.json`): an unreadable `paired.json` leaves the paired
  set empty in memory and every pair, unpair or clear throws. An unreadable `remotePassword.json` means no password
  is set for verifying (nobody can join over it) and set, clear and failure-recording throw. An unreadable
  `identity.json` is never replaced by a new key: `init()` throws `StateFileUnreadable`; today it mints a new identity
  after 10 × 20 ms, which loses the root of trust.
- `MachinePeerStore`: an unreadable `machinePeers.json` makes `get` answer "not pinned"; `pin` and `unlink` throw. An
  unreadable `machinePeers-gone.json` keeps the in-memory marks as today and refuses to rewrite the file.
- `TrustGroupStore`: an unreadable `group.json` makes `merge`, `add` and `remove` throw (no write back);
  `list` is empty. An unreadable `group-blocked.json` makes `blocked()` throw, so `merge`, `block` and `unblock`
  throw too. Its other readers (builder's call, 2026-11-19):
  - `groupSyncer.apply`/`applyAll` (`lib/e2ee/groupSyncer.ts`): pins and trusts nobody new while the block list
    cannot be read, and logs it; trust already in place stays.
  - The device log's `isBlocked` (through `gateway/start.ts`): "cannot tell" is not "blocked", so it answers as for
    a machine that is not blocked and every NEW DEVICE alert is still shown. A failure never hides an alert.
- The callers (gateway, fleet, CLI commands) already handle a throw from these stores; the plan checks each one and
  makes sure a throw is logged, not swallowed into "empty".

- The auth session (`auth/session.json`): fail closed for every reader and writer but two. `harness login` and
  `harness logout` are the person replacing it on purpose, so they set an unreadable one aside to
  `session.json.unreadable` and go on (login writes a fresh session). Orchestrator, 2026-11-19.

### Pid files

`harnessd/master.ts`, `core/main.ts` (two writers) and `lib/daemonState.ts` `readPid`. Writes become atomic. A read
gives one of three answers: a pid, missing, or unreadable. Unreadable is never "not running". Every existing check
needs a pid, so an unreadable pid file asks the daemon itself (builder's call, 2026-11-19): its local status already
answers with the master's pid (`core/main.ts:2184`), and that pid is used as if read from the file. When no daemon
answers and the spawn lock is free, the file is set aside like any cache file and the caller goes on as for a missing
one. No new process-table search. This covers every `readPid` caller (`start`, `start --if-down`, `stop`, `status`,
the re-exec handover, `daemonLaunch`, `platformDaemon`); the plan lists each.

## Same cause found in recon (agreed by the orchestrator)

- `e2ee/store.ts` `identity.json` is created with `wx` and filled after, and a reader that still finds it unparsable
  after 10 × 20 ms replaces it. Fix: write a temporary file, then publish it with `link` (an exclusive and atomic
  create); `EEXIST` means another process won, and its complete file is read.
- `lib/hookAuth.ts` creates the credential with `O_EXCL` and writes after: the same race, the same fix.
- `atomicWriteJson(..., exclusive = true)` checks for the file and then renames, which is not exclusive. It becomes
  the same `link` publish.
- Where `link` is refused (`EPERM`, `ENOTSUP`, `EXDEV`, `ENOSYS`: a FAT, exFAT or network data folder on Windows, some
  container mounts), the exclusive publish copies the complete temporary file with `COPYFILE_EXCL` instead: still
  exclusive, and the short window in which a reader can see it unfinished is covered by the bounded read retry and
  the fail-closed rule (an identity is never replaced). Builder's call, 2026-11-19: a refusal would leave such a
  machine with no relay.
- The check of an existing file's owner and mode (`hardenPrivateStateFileIfPresent`: refuse one another account could
  write) stays for trust files. A cache file is replaced whole by the rename with a new file of its own mode, so the
  old one's mode does not matter: pid files and the machine name written `0664` under Ubuntu's umask by today's code
  do not fail forever, and the browser shim keeps `0700` (builder's call, 2026-11-19).
- `group-blocked.json`: read as empty, then `block()` writes one entry, which un-blocks the others.
- `lib/commander.ts` already has an atomic path (`strict`) but the 200 ms timer path writes in place. The timer path
  goes through the helper too; one path.
- Windows: renaming over a file another process holds open (an antivirus, an indexer) fails with `EPERM`, `EACCES` or
  `EBUSY` for a moment. The helper retries the rename a bounded number of times there, then throws.

## The sites

Serious (a parse error becomes empty, and empty is written back):

1. `lib/e2ee/machinePeers.ts:55,60` (`machinePeers.json`, `-gone`): `readAll()` is re-read on every get, pin and
   unlink in the gateway, the fleet and the CLI.
2. `lib/e2ee/trustGroup.ts:162,210` (`group.json`, `group-blocked.json`).
3. `lib/e2ee/store.ts:88-91` `writeSecure` (`paired.json`, `remotePassword.json`, `identity.json`); the CLI writes the
   same files from another process. (`accountTrust.ts:46` already writes `paired.json` atomically.)
4. `lib/commander.ts:1239-1242` (`summaries*.json`) on a 200 ms timer; a new core loads once at handover.
5. Pid files: `harnessd/master.ts:287`, `core/main.ts:371,2334`, read by `lib/daemonState.ts` `readPid`.
6. `lib/hookAuth.ts:86`: credential created exclusive, then written.

Minor (in place, read by another process): `device/machineList.ts:310`, `lib/runtimeInstall.ts:275`,
`lib/engineLaunch.ts:537` (`.zshenv`), `lib/windows/hermesLaunch.ts:113,116`, `lib/browserShim.ts:44` (mode `0700`),
`lib/uninstall/deps.ts:52`, `core/main.ts:3324` (machine name), `lib/hostTheme.ts:58`, `lib/computerIdentity.ts:70`.

Already renamed, but a parse error is still read as empty and written back, or the writer has no `fsync` (a power
loss can leave a zero-length file) or a fixed temporary name (two writers collide). Trust kind, and their writers move
to the helper (orchestrator, 2026-11-19):
- `lib/e2ee/deviceLogStore.ts` (`read()` returns `empty()`, which drops the freeze and the rollback protection).
- `lib/e2ee/accountTrust.ts` (`writeAtomic`, no `fsync`, fixed temporary name; `unstashTrust` reads `paired.json` as
  `?? []` and writes over a broken one), and the per-account copies under `e2e/accounts/<account>/`.
- The auth session's store (`authSession`).
- Any other hand-written atomic writer that lacks `fsync` or uses a fixed temporary name, and the duplicate
  `atomicWriteJson` in `codexProfiles.ts`.

Hand-written atomic writers that are already correct (unique temporary name, `fsync`, rename) stay as they are in
this pull request; the plan lists them and the pull request carries that list for a follow-up that moves them to the
helper.

Same cause elsewhere: the plan sweeps `cli/src` for other in-place writes of a file another process or a later start
reads, and lists each one it finds with a decision (fixed here, or why not). There are about 300 `writeFile` calls in
`cli/src`; most write files nobody reads back (exports, temp files, test fixtures).

## Approaches

1. **One helper in `lib/secureState.ts`** (chosen): `atomicWriteJson` moves from `registry.ts` into `secureState.ts`
   beside the checks it already uses (`hardenPrivateStateFileIfPresent`, `syncStateDirectory`), grows a text form, a
   mode, the `link` exclusive publish and the Windows rename retry; a reader beside it applies the two kinds. Every
   caller, `registry.ts` included, imports it from there. `secureState.ts` is already in the core's process, so the
   core loads no new file.
2. A new module `lib/stateFile.ts`: the same code, but one more line in `architecture.coreFiles.txt` for no gain.
3. A dependency (`write-file-atomic`): a new package for ~40 lines we already own, and it has no fail-closed reader.

## Design (docs/feature-design-rules.md)

Reviewed revision: spec v1  Reviewer: builder check  Each line: answered / N/A because …

1. **Growth**: no new record. The only new file is `<name>.unreadable`, at most one per cache file, replaced by a
   newer one, so it never grows. Temporary files are removed when a write fails before its rename; a crash between
   create and rename can leave one `<name>.<pid>.<uuid>.tmp` (as `atomicWriteJson` can today), which nothing reads.
2. **Concurrency**: the unit is one file. The invariant "a reader sees the old complete file or the new complete one"
   is kept by rename (and by `link` for a create-once file) on every path: the daemon, its services, the CLI, an
   older build writing in place during a handover (the bounded read retry). Two writers racing (lost update) is a
   non-goal, listed for the follow-up.
3. **Read cost**: unchanged; the same files are read as often as today. A parse error adds a few bounded retries.
4. **Scale**: the files are small (largest: the recap history, bounded by its own caps). A rename and an `fsync` per
   write; the recap timer (200 ms debounce) already pays it on its strict path. The plan measures the recap save's
   time before and after on a full history.
5. **Compatibility**: formats, names and folders are unchanged, so an older build reads what this one writes and the
   other way round. An older build still writes in place during a handover: the bounded read retry rides it out.
6. **Migration and rollback**: none. A rollback returns to in-place writes; the files stay readable by it.
7. **Audience**: N/A because nothing is sent anywhere; every file keeps its owner-only mode (`0600`, `0700` for the
   run scripts), and the temporary file is created with that mode before any byte is written.
8. **Identity**: N/A because nothing runs as anyone new; files are written by the process that writes them today.
9. **Failure**: a trust file that cannot be read: one log line per file per process (base name, kind, the fix), a
   `StateFileUnreadable` from every write, and a line in `harness status` with the full path. A cache file: one log
   line, and the bytes kept in `<name>.unreadable`. A write that cannot complete (full disk) throws as today and leaves
   the old file whole. A rename unconfirmed by the folder flush keeps today's `AtomicWriteUnconfirmed`.
10. **Platforms**: macOS, Linux, Windows. Windows has no `O_NOFOLLOW` and cannot flush a folder (as today:
    `syncStateDirectory` skips it); rename over an open file can fail for a moment (bounded retry); `link` needs NTFS,
    which the user profile is. The helper's spec joins the Windows CI spec list (`.github/workflows/windows.yml`).

## Tests

- Each serious item: a test that fails on `main` first. A torn read: the file holds a truncated JSON (what a reader saw
  mid-write), the store is used, and the test checks the file was not overwritten with empty or partial state (trust:
  it throws `StateFileUnreadable` and the bytes are unchanged; cache: the bytes are in `<name>.unreadable`). A torn
  write: the write fails part way (the file system call throws), and the target still holds the old complete file.
- The helper: mode on the new file, exclusive create through `link` (two creators, one wins, the other reads the
  winner's), the Windows rename retry (bounded, then throws), no temporary file left after a failed write.
- Pid: an unreadable pid file with a master running is "running"; with none, it is set aside and the start goes on.
- The guard test: a source scan, like `config/harnessHome.guard.spec.ts`, that fails on a `writeFileSync`,
  `fs.writeFile` or `fs.promises.writeFile` call in any module that owns a listed state file, outside the helper.
- Core touched: `npm run test:core` at 100% before the push; `npm run test:harnessd` too (`harnessd/master.ts`).

## Delivery

One pull request, unless the diff passes about 1,500 changed lines: then two, stacked and merged in order: (1) the
helper, the reader, the guard and the e2ee stores (with the auth session); (2) everything else. The plan orders its
tasks so that (1) is a prefix of the branch. `feat/linux-xdg-paths` (PR #4469) touches some
of the same files; whichever merges second rebases.

## Left to the builder

- The exact retry counts and delays (bounded, sub-second for reads, about a second at most for the Windows rename).
- How each caller of a trust store surfaces `StateFileUnreadable` (log and refuse, never swallow into empty).
- The guard's list of modules, as long as it covers every file in this spec.
