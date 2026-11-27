# Atomic state writes: a reader never sees a half-written file, and never writes "empty" back — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(state): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message.

**Goal:** Every state file the daemon, its services and the CLI share is written whole or not at all, on macOS, Linux and Windows, and a file that cannot be parsed is never read as empty and written back: a trust file fails closed, a cache file is set aside.

**Architecture:**
- **One helper, one reader** in `cli/src/lib/secureState.ts` (already in the core's process, so `architecture.coreFiles.txt` gains no line): `atomicWriteFile` / `atomicWriteJson` (moved out of `registry.ts`, grown with a mode, an exclusive publish and a Windows rename retry) and `readState` (bounded retry, then the file's kind decides).
- **Two kinds, one flag:** `'trust'` (left as it is, the store refuses to write, `harness status` names it) and `'cache'` (renamed to `<name>.unreadable`, read as missing).
- **Each store keeps its shape:** same files, names, folders and bytes. Only how they are written, and what a parse error means, changes.
- **The pid file** is read three ways (a pid, missing, unreadable); a command that needs a pid from an unreadable file asks the daemon's local status.
- **The registry lock** is built in a temporary folder with its owner already in it, then renamed into place: no lock is ever there without its owner (Task 33, Decision 16).

**Tech Stack:** TypeScript (Node 22+, vitest), `cli/`. No new dependency.

**Spec:** `docs/plans/2026-11-19-atomic-state-writes-design.md`. Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md` (Protect the core) and `cli/src/harnessd/AGENTS.md`.

## Base

- Branch `fix/atomic-state-writes`, at `0323a0b812` (the spec and this plan, on `e948919b33`), worktree `/Users/nqhieu84/orca/workspaces/openharness/atomic-writes`.
- **Before the first task, once:** `cd cli && npm ci --no-audit --no-fund` (this worktree's `cli/` has no `node_modules`). One process runs it, never two tasks at once.
- The tasks name functions, never lines. Line numbers in the tables are the audit's, at the base. If a name differs, the implementer follows the code and says so in its report.
- `feat/linux-xdg-paths` (PR #4469) touches some of the same files; whichever merges second rebases.
- The spec and this plan are committed. A change to either is the main session's to commit; no task commits one.
- Fault injection in tests wraps `node:fs` with pass-through functions and hoisted flags, as `cli/src/lib/registry.persistenceCost.spec.ts` and `registry.diskFailure.spec.ts` do. No fixed sleeps.

## Tasks at a glance

| Task | Files (specs beside them) | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| **Part 1: the prefix (pull request 1)** | | | | |
| 1 The helper moves and grows | `lib/secureState.ts`, `lib/registry.ts`, `lib/registryPersistence.ts`, their importers, `.github/workflows/windows.yml` | none | xhigh | `lib/secureState.spec.ts` |
| 2 The reader | `lib/secureState.ts` | 1 | xhigh | `lib/secureState.spec.ts` |
| 3 Pinned machines | `lib/e2ee/machinePeers.ts`, `lib/remoteRelay.ts` | 2 | xhigh | `machinePeers.spec.ts`, `remoteRelay.spec.ts` |
| 4 The trust group and its block list | `lib/e2ee/trustGroup.ts`, `lib/e2ee/groupSyncer.ts` | 2 | xhigh | `trustGroup.spec.ts`, `groupSyncer.spec.ts` |
| 5 Identity, paired clients, remote password | `lib/e2ee/store.ts`, `lib/e2ee/manager.ts` | 2 | xhigh | `store.spec.ts`, `manager.test.ts` |
| 6 The device key log | `lib/e2ee/deviceLogStore.ts`, `lib/e2ee/deviceLogSyncer.ts` | 2 | xhigh | `deviceLogStore.spec.ts`, `deviceLogSyncer.spec.ts` |
| 7 Per-account trust | `lib/e2ee/accountTrust.ts` | 2 | xhigh | `accountTrust.spec.ts` |
| 8 The auth session | `lib/authSession.ts`, `cli.ts` (the two sign-in writes), `authCommand.spec.ts` | 2 | xhigh | `authSession.spec.ts`, `authCommand.spec.ts` |
| 9 `harness status` names an unreadable trust file | `lib/trustFiles.ts` (new), `cli.ts`, `lib/daemonState.ts`, `cli/e2e/stateFiles.e2e.ts` (new), `docs/cli.md` | 3, 4, 5, 6, 7, 8 | high | `lib/trustFiles.spec.ts`, `cli/e2e/stateFiles.e2e.ts` |
| 10 The guard, part 1 | `lib/stateWrites.guard.spec.ts` (new), `cli/AGENTS.md` | 3, 4, 5, 6, 7, 8 | high | `lib/stateWrites.guard.spec.ts` |
| **Part 2: the rest of the spec (pull request 2)** | | | | |
| 11 The hook credential | `lib/hookAuth.ts`, `lib/trustFiles.ts` | 9, 10 | xhigh | `hookAuth.spec.ts` |
| 12 The recap files, and the save's cost | `lib/commander.ts`, `lib/commander.saveCost.spec.ts` (new) | 9, 10 | high | `commander.spec.ts` |
| 13 The pid file: three answers, one writer | `lib/daemonState.ts`, `lib/unreachable.ts`, `lib/programDaemon.ts`, `testing/spawnedRuns.ts` | 9, 10 | xhigh | `daemonState.pidFile.spec.ts` |
| 14 The pid file's writers, and the machine name | `core/main.ts`, `harnessd/master.ts`, `masterProcess.ts` | 13 | xhigh | `harnessd/master.spec.ts`, `masterProcess.spec.ts` |
| 15 An unreadable pid file asks the daemon | `lib/pidFileSettle.ts` (new), `lib/daemonSpawnLock.ts`, `lib/daemonStop.ts`, `lib/startIfDown.ts`, `lib/serviceCommand.ts`, `lib/uninstall/command.ts`, `lib/uninstall/deps.ts`, `cli.ts`, `cli/e2e/stateFiles.e2e.ts` | 9, 13 | xhigh | `pidFileSettle.spec.ts`, `cli/e2e/stateFiles.e2e.ts` |
| 16 Scripts and launch files | `lib/engineLaunch.ts`, `lib/browserShim.ts`, `lib/windows/hermesLaunch.ts` | 9, 10 | high | their three specs |
| 17 Pointers, markers and the computer id | `lib/runtimeInstall.ts`, `lib/uninstall/deps.ts`, `lib/computerIdentity.ts` | 9, 10 | high | `runtimeInstall.spec.ts`, `computerIdentity.spec.ts`, `uninstall/command.spec.ts` |
| 18 JSON caches | `device/machineList.ts`, `lib/hostTheme.ts`, `lib/codexProfiles.ts` | 9, 10 | high | `machineList.spec.ts`, `hostTheme.spec.ts`, `codexProfiles.test.ts` |
| 33 The registry lock is made with its owner in it | `lib/registryPersistence.ts`, `lib/registryPersistence.spec.ts`, `lib/registry.persistence.spec.ts`, `lib/__fixtures__/registryCrashWriter.ts`, `lib/registryLock.publish.spec.ts` (new), `.github/workflows/windows.yml` | 1 | xhigh | `registry.persistence.spec.ts`, `registryPersistence.spec.ts` |
| 19 The guard, part 2 | `lib/stateWrites.guard.spec.ts` | 11, 12, 14, 15, 16, 17, 18, 33 | medium | none (a list grows, one commit) |
| **Part 3: what the sweep found (pull request 3)** | | | | |
| 20 to 30 Writers found by the sweep, and their readers, by area | see [Part 3](#part-3-the-writers-the-sweep-found-and-their-readers) | 19 | high each | each module's spec |
| 31 The profile lists and the dial skill record: readers | `lib/codexProfiles.ts`, `lib/claudeHomes.ts`, `devices/dialSkillFiles.ts` | 19 | high | `codexProfiles.test.ts`, `claudeProfiles.test.ts`, `dialSkillFiles.spec.ts` |
| 32 The guard, part 3 | `lib/stateWrites.guard.spec.ts` | 20 to 30 | medium | none (a list grows, one commit) |

All paths are under `cli/src/` unless they start with `cli/`, `docs/` or `.github/`.

Longest chain: 1 → 2 → 3 → 9 → 13 → 15 → 19 → 20 → 32, nine tasks.

- **Tasks 3 to 8 share no file** and start together once Task 2 is done; so do 9 and 10 after them, and 11, 12, 13, 16, 17, 18 after those.
- **"9, 10" is the delivery order the brief asks for:** Part 1 must stand alone as a prefix of the branch, so no Part 2 commit lands before both. Tasks 9 and 15 also extend `cli.ts` after Task 8; Tasks 11 and 15 extend Task 9's files. Tasks 15 and 17 both change `lib/uninstall/deps.ts`, so they never run together; neither needs the other.
- **Task 33 depends on Task 1 only** (it shares `lib/registryPersistence.ts` and `windows.yml` with it) and shares no file with any other task, so it runs beside Tasks 2 to 8. Its two commits belong to Part 2: when the branch is cut into pull requests they move after Task 10 (they touch only Task 33's files, so the move does not conflict). Task 19 waits for it, so Part 2 stays a prefix.
- **Part 3 waits for Task 19** so Part 2 is a prefix too (Decision 10). Task 31 changes `lib/codexProfiles.ts` after Task 18, which Task 19 already orders. Tasks 20 to 31 share no file.
- **Three pull requests, stacked and merged in order** (Decision 10): Part 1 (the helper, the reader, the e2ee stores and the auth session), Part 2, Part 3.

## Layers and gates

| Files | Process | Gate |
|---|---|---|
| `lib/secureState.ts`, `lib/daemonState.ts`, `lib/registry.ts`, `lib/registryPersistence.ts`, `lib/hookAuth.ts`, `lib/engineLaunch.ts`, `lib/browserShim.ts`, `lib/hostTheme.ts`, `lib/computerIdentity.ts`, `lib/windows/hermesLaunch.ts`, `lib/claudeHomes.ts`, `lib/nodeMigration.ts`, `core/main.ts` | the core's (and others') | their specs in PR CI `cli-tests`; `src/architecture.spec.ts` (no new line in `architecture.coreFiles.txt`); `core/main.ts` by the end-to-end suite |
| `lib/e2ee/*`, `lib/remoteRelay.ts` | the gateway, the fleet, the CLI | their specs (PR CI) |
| `lib/commander.ts` | the edge host (recaps) | its specs (PR CI) |
| `harnessd/master.ts` | the master | 100% per file, `npm run test:harnessd` (local) |
| `masterProcess.ts`, `lib/pidFileSettle.ts`, `lib/daemonStop.ts`, `lib/startIfDown.ts`, `lib/serviceCommand.ts`, `lib/uninstall/*`, `lib/trustFiles.ts`, `cli.ts` | the master's entry, the CLI | their specs (PR CI); `lib/uninstall` and `lib/windows` also on Windows (`windows.yml`) |
| `services/*`, `core/*` (Part 3) | services, the core | 100% per file, `npm run test:core` (local) |
| `sharing/*`, `orchestrator/*`, `lib/localModels.ts`, `dsh/*.ts` (Part 3) | experiments, models, the Store | `test:sharing`, `test:orchestrator`, `test:local-models`, `test:portability` (local) |

The local gates run once, at the final commit, with `python3 scripts/local-checks.py --run` ([Verification](#verification)).

Not changed, and a diff in any is a finding: `cli/src/architecture.coreFiles.txt`; the master's import rule in `cli/src/architecture.spec.ts`; the write queue in `lib/registryPersistence.ts` (only `AtomicWriteUnconfirmed` moves out of it), and its lock beyond how Task 33 makes it (the takeover, the ownerless rule, `removeLockNow`, `checkOwner`, the bytes of `owner.json`, `LOCK_MS` and `OWNERLESS_MS`); any file's name, folder or serialized bytes; `desktop/`, `mobile/`, `backend/`, `device-app/`.

## Global Constraints

- **Atomic, in this order:** a temporary file in the target's folder (`<file>.<pid>.<uuid>.tmp`, opened `O_EXCL | O_NOFOLLOW` with its mode), written, `fchmod` to its mode, `fsync`, closed, renamed over the target, folder flushed where the platform can (`syncStateDirectory`). A temporary file never outlives a failed call.
- **Modes as today:** `0600` for secrets and state, `0700` for the scripts that are run. A site that passes no mode today gets `0600`.
- **Same bytes as today.** `atomicWriteJson` only where today's bytes are `JSON.stringify(value, null, 2)`; every other site passes its exact string to `atomicWriteFile`.
- **Trust files:** `e2e/identity.json`, `e2e/paired.json`, `e2e/remotePassword.json`, `e2e/group.json`, `e2e/group-blocked.json`, `e2e/machinePeers.json`, `e2e/machinePeers-gone.json`, `e2e/devlog.json`, `e2e/devlog.archive.json`, the copies under `e2e/accounts/<account>/`, `auth/session.json`, `hook-credential`, `hook-token`. Everything else in the spec is a cache file.
- **Unreadable** means: a read error other than `ENOENT`, text that is not valid JSON, or a top-level value of the wrong type (an array where an object is expected, and the reverse). A well-formed file of a shape or version this build does not know reads as it does today. Missing is missing, never an error.
- **Trust, unreadable:** the file's bytes do not change; reads give the fail-closed value named in the store's task; every write that would replace it throws `StateFileUnreadable`; the next read tries again. One exception: `harness login`, `harness logout` and `harness reset` set an unreadable `session.json` aside (Decision 8).
- **Cache, unreadable:** renamed to `<name>.unreadable` (one copy: a newer one replaces the older), then read as missing.
- **Read retry before either:** `READ_TRIES = 5` reads, `READ_WAIT_MS = 20` apart.
- **Windows rename retry:** `RENAME_TRIES = 10`, `RENAME_WAIT_MS = 100` apart, on `EPERM`, `EACCES`, `EBUSY` only, on `win32` only; then it throws.
- **Exclusive create:** published with `link`; `EEXIST` means another process won and its complete file is read. Where `link` is refused (`EPERM`, `ENOTSUP`, `EXDEV`, `ENOSYS`) the complete temporary file is copied with `COPYFILE_EXCL`.
- **Owner and mode of an existing target** are checked for a `'trust'` write only (`hardenPrivateStateFileIfPresent`).
- **Log lines, exact:**
  - trust, once per file per process: `[state] <base name> cannot be read (<failure>); left as it is. Move it aside to start over.`
  - cache: `[state] <base name> could not be read (<failure>); kept as <base name>.unreadable, starting empty.`
  - `<failure>` is `not valid JSON`, `unexpected content`, or the read's errno code (`EACCES`, `EISDIR`; `unreadable` when it has none). Never an error's message: `JSON.parse` quotes the file in it.
  - No full path, file content or secret in any log line or error message.
- **`harness status`, one line per unreadable trust file, after the info block:** `  ! <full path> cannot be read (<failure>) · move it aside to start over`.
- **No new file in the core's process**, no import added to `src/harnessd/` beyond Node, its own folder and `../lib/log.js`.
- **Out of scope:** a lost update between two processes that read, modify and write the same file.
- **Platforms:** macOS, Linux, Windows.

## Decisions

1 to 7 and 14 to 15 are the builder's calls. 8 to 13 are the orchestrator's answers to the draft's questions (2026-11-19). 16 is the orchestrator's case (2026-11-19); its platform details are the builder's.

1. **`kind` is a required argument** of both writers. The callers that exist today (the registry's files, checkpoints, stopped agents, the safe-mode marker) pass `'trust'`, which is exactly what they do today: the existing target's owner and mode are checked. Their readers are not touched.
2. **The reader is the gate.** A trust store's write path reads first (`requireState`), or carries a flag from its last load and reads again before it writes. The writer does not parse.
3. **`AtomicWriteUnconfirmed` moves** to `secureState.ts` with the writer that throws it (`registryPersistence.ts` imports `secureState.ts`, so the other way would be a cycle); every importer names the new module.
4. **An unreadable file is remembered by its stat** (`dev:ino:size:mtimeMs`): while that is unchanged, later reads answer "unreadable" after one `stat`, with no retry and no second log line. Without it, a broken `machinePeers.json` would stall the gateway 80 ms on every relay dial.
5. **The device key log has no safe empty value,** so its reads throw `StateFileUnreadable` instead of answering one.
6. **A pairing that cannot be saved fails as `TIMEOUT`,** the existing code that does not count as a wrong guess. No new code on the wire.
7. **The master is handed its pid writer** (`MasterConfig.writePidFile`), as it is handed everything else that touches the system: `src/harnessd/` cannot import the helper.
8. **`harness login` over an unparsable `session.json` does not fail.** The person is signing in again on purpose: login sets the file aside to `session.json.unreadable` and writes a fresh session. `harness logout` sets it aside the same way, where it removed it (and so does `harness reset`, the other door onto the same removal, `removeSignIn`). Every other reader and writer of `session.json` stays fail closed. This is the spec's "Fail-closed details for the trust stores".
9. **Part 3 fixes the readers too (was Q2; changed from the draft's default).** Every Part 3 file marked `E` in Table B, and `codex-profiles.json`, `claude-profiles.json` and `dial-skill.json` (with `dial-setup.json`, which shares its reader), reads through the shared reader as a **cache** file: set aside to `<name>.unreadable`, logged, carried on as missing. Each with its red test, in the task that owns its module (Tasks 20 to 31).
10. **Part 3 ships as a third stacked pull request, after Part 2 (was Q1).** Pull request 1 is Part 1, the e2ee stores first. Tasks 20 to 31 depend on Task 19.
11. **The pid file when nobody answers and another process holds the spawn lock (was Q3, default kept):** the file is left, that one read has no pid (`busy`), and a command that changes the daemon settles again under its own lock. `harness status` prints what it prints today during a start.
12. **Table B's "not here" rows stay for the follow-up (was Q4, default kept):** the four `src/harnessd/` writers (its import rule stays: no `../lib/secureState.js`), the folder and binary swaps, the files of an engine or the person, and the inbox file. Only the master's pid writer is injected (Decision 7).
13. **A full recap history for the measurement is 200 sessions, measured on the developer's Mac only (was Q5, default kept).**
14. **Part 3's async readers call the synchronous `readState`.** Each reads one small file once per load (the largest is bounded at 512 KiB, `session-git-history`), and the retry's wait is paid only for a file that cannot be parsed, once, since the file is then set aside. One reader, not a second async one.
15. **A reader that bounds its read keeps its bound** (`cable/noticeFile.ts`, `devices/dialSkillFiles.ts`): a file within the bound that is not valid JSON or not a JSON object is handed to `readState(file, 'cache', jsonObject)`, which reads it again with the retry, sets it aside and logs the cache line; its answer is used. A file past the bound reads as today: the bound is what keeps the read small.
16. **The registry lock comes into existence with its owner in it (Task 33).** Today `registryFileLock` makes `registry.json.lock` with `mkdir`, then writes `owner.json` into it; a process killed between the two leaves a lock with no owner, which the next core waits `OWNERLESS_MS` (5 s) for, past its `LOCK_MS` (2 s): `registry lock is busy`, and safe mode (`master.e2e.ts`, Linux CI run 44406838335, shard 7). The owner is now written in a temporary folder that is renamed onto the lock's path. A folder cannot be hard-linked, and a symbolic link would break the protocol older builds still speak, so the publish is a rename, with a look first: a rename replaces an empty folder on macOS and Linux, and Windows refuses a folder over any folder. The protocol on disk is unchanged (`registry.json.lock`, `0700`, holding only `owner.json`, `0600`), so older builds keep working beside this one.

## The sweep

About 300 `writeFile*` calls in `cli/src`. The 201 write sites outside specs and test helpers were read one by one. Table A is every write in place (or created exclusive and filled after) of a file another process or a later start reads, beyond the sites the spec names. Table B is every hand-written temporary-file-and-rename writer with no `fsync`, or with a temporary name that is fixed or made of the pid alone. The rest write files nobody reads back, and stay: append-only logs (`harness.log`, `dial.log`, `started.jsonl`, transcripts, install logs), one-shot inputs in a fresh private folder that a child consumes once (the guest helper's stage, elevated scripts, build contexts, canary bundles, payload archives, the VS Code package), exports and backups for a person, test fixtures and fakes, and hits that are not writes (imports, `stderr`, a FIFO).

### Table A: written in place, read by another process or a later start

| Site | File | Decision |
|---|---|---|
| the spec's sites (`machinePeers.ts`, `trustGroup.ts`, `store.ts`, `commander.ts`, the pid writers, `hookAuth.ts`, and the nine minor ones) | | fixed here: Tasks 3, 4, 5, 11, 12, 14, 16, 17, 18 |
| `lib/runtimeInstall.ts:269` | `<runtime>/<name>-…/.unrunnable` | fixed here (Task 17): the module is guarded, one line |
| `lib/gridConfigDir.ts:94` | `grid-engine-config/<key>/<name>`, read by the engine | fixed here (Task 21) |
| `lib/apiInstructions.ts:37` | a Harness-made project's `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`, read and rewritten | fixed here (Task 21): a torn write loses the earlier text |
| `lib/flash.ts:124` | `flasher/flash-circle.sh` or `.ps1`, run and reused offline | fixed here (Task 22): a truncated copy would be run |
| `lib/engineLaunch.ts:583` | `launch/<uuid>.sh` | not here: a fresh name, complete before tmux is started with it |
| `lib/runtimeInstall.ts:243` | the downloaded archive in a staging folder | not here: one-shot, unpacked and removed |
| `lib/pasteDropFiles.ts:58,68`, `agentClient/commands.ts:2330` | a pasted image, a dropped file, a task file | not here: a fresh name, complete before its path is handed out |
| `orchestrator/service.ts:208,271` | `ORCHESTRATOR.md`, `ORCHESTRATOR_TASK.md` | not here: written before the agent that reads it is told |
| `lib/gitProject.ts:329`, `harnessd/leanBundle.ts:155` | `.metadata_never_index`, `.claim-<pid>` | not here: empty markers, only their name is read |
| `lib/log.ts:76`, `services/devices.ts:993` | the log trim, the old log's pointer line | not here: logs; the trim is in place on purpose (the daemon's descriptor is `O_APPEND`) |
| `cable/fwPush.ts:133` | `firmware/<key>-<version>.bin` | not here: its size and sha256 are checked on every use, then fetched again |
| `lib/daemonSpawnLock.ts:189`, `agentClient/program.ts:216`, `agentClient/ledger.ts:295` | lock owner records | not here: a lock being made reads as busy, and an ownerless one is cleared; the directory or `O_EXCL` create is the atomic step |
| `lib/registryPersistence.ts` `registryFileLock` | `registry.json.lock/owner.json` | fixed here (Task 33, Decision 16): a kill between `mkdir` and the owner write leaves a lock the next core waits 5 s for, past its 2 s budget, and it goes to safe mode |
| `dsh/lock.ts:31` | `.lock-<owner>_<name>/pid` | not here, follow-up: a crash between `mkdir` and the write leaves a lock nobody reaps, which a file write cannot close |
| `lib/agentCreationReceipt.ts:571` (exclusive), `lib/autonomous-device/store.ts:107` (exclusive), `lib/stoppedAgents.ts:195`, `engines/resumeRepairs.ts:59` | reservations made exclusive, filled, flushed | not here, follow-up: each fails closed on a partial file by design; the `link` publish would remove the window |
| `lib/piSessionHome.ts:28` | a Pi transcript copied exclusive to its final path | not here, follow-up: a file copy; it should copy to a temporary name and `link` |
| `dsh/runtime.ts:90` | `legacy-AGENTS.md` | not here: a backup nobody reads |

### Table B: renamed into place, but no `fsync` or a fixed temporary name

`F` = no `fsync`. `N` = the temporary name is fixed or the pid alone. `E` = the reader turns a parse error into empty and a later write keeps it (its reader is fixed here as a cache file, Decision 9).

| Site | File | Gap | Decision |
|---|---|---|---|
| `lib/e2ee/deviceLogStore.ts`, `accountTrust.ts`, `lib/authSession.ts` | the spec's three | F N E | Tasks 6, 7, 8 (readers too) |
| `lib/codexProfiles.ts:49` | `codex-profiles.json` (the duplicate `atomicWriteJson`) | E | Task 18 (the writer), Task 31 (the reader) |
| `lib/appModels.ts:356` | `local-models/app-engines.json` | F N E | Task 20 |
| `lib/localModels.ts:617,714,760` | `<grid>.known.json` (E), `<grid>.json`, `app-models.json` | F | Task 20 |
| `lib/gridModels.ts:710`, `lib/agentTokenUsage.ts:362` | `grid-pictures/*.json`, `agent-token-usage/*.json` | F | Task 20 |
| `lib/sessionGitHistory.ts:148` | `session-git-history/*.json` | F E | Task 20 |
| `lib/agentSettings.ts:131`, `lib/daemonRecord.ts:64`, `lib/hookRoutes.ts:24`, `lib/machineMcp.ts:125` | `agent-settings.json`, `daemon-<port>.json`, `hook-routes/*.json`, `mcp-servers.json` | F N | Task 21 |
| `lib/nodeMigration.ts:47` | `node-migration.json` (two writers) | F N E | Task 21 |
| `lib/selfUpdate.ts:64` | `update-pending.json`, `update-rejected.json` (E), `current-node` | F N | Task 22 |
| `lib/signOut.ts:179` | `sign-in-removals.log` | F N | Task 22 |
| `lib/launchers.ts:39,76`, `tui/launcher.ts:116` | `<bin>/harness`, `<bin>/hn` | F N | Task 22 (`hn` with the exclusive publish) |
| `lib/connectors/agents.ts:157` | `connections/mcp-shim.mjs` | F N | Task 22 |
| `lib/windows/installLayout.ts:77`, `ptyInstall.ts:206`, `ptyUpdate.ts:424`, `cliVersions.ts:74` | `cli\current`, `current-pty`, `pty-pending.json`, `pty-rejected.json` (E), `notify.mjs` | F N | Task 23 |
| `services/windowNames.ts:160`, `agentBrowser/stateFile.ts:58` | `window-names.json`, `agent-browser.json` | F N | Task 24 |
| `services/agentCleanup.ts:133`, `sharedMachines.ts:133`, `goals.ts:83` | `agent-cleanup.json`, `shared-machines.json`, `hachi/goals.json` | F N E | Task 24 |
| `messages/requestStore.ts:40`, `consentStore.ts:92`, `noticeStore.ts:43`, `rosterStore.ts:104`, `store.ts:100` | `agent-messages/*.json` (each already moves a broken file aside) | F (N in `store.ts`) | Task 25 |
| `sharing/collaboration.ts:36`, `grants.ts:43`, `orchestrator/service.ts:111` | `harness-collaboration.json`, `harness-shares.json`, `orchestrator/<run>.json` | F | Task 26 |
| `cloud/service.ts:125` | `cloud/harnesses.json` | F N E | Task 26 |
| `dsh/installed.ts:87`, `viewerLedger.ts:123` | `installed.json`, `viewers.json` | F (N) E | Task 27 |
| `dsh/catalog.ts:130` | `.catalog/*.json` | F | Task 27 |
| `cable/notifyMode.ts:53` | `dial-notify.json` | F N | Task 28 |
| `cable/noticeFile.ts:137`, `dialPortVerdicts.ts:81`, `pets/store.ts:245` | `dial-notices.json`, `dial-ports.json`, `pets/*` (text and images; `E`: `pets.json`) | F N E | Task 28. A pack's `<id>.json` is written once with the pack, never from a read: its readers stay |
| `engines/cursor/pendingTasks.ts:67` | `cursor-pending-tasks.json` | F N E | Task 29 |
| `engines/kit/windowsInstall.ts:114`, `messagesHook.ts:134`, `statusLine.ts:49`, `hookSettings.ts:216` | `native-installations/<engine>.json`, `hook.mjs`, `statusline.mjs`, `$CODEX_HOME/rules/harness.rules` | F N | Task 29 |
| `agentClient/program.ts:150`, `ledger.ts:265` | `program-harnesses.json` (E), the ledger's rewrite | F N | Task 30. The ledger is not `E`: it is read line by line, a line it cannot parse is skipped and its rewrite keeps that line byte for byte, so its reader stays |
| `gateway/productUsage.ts:231,249` | `product-usage/*.json` | F N E | Task 30 |
| `lib/autonomous-device/direct.ts:45` | `autonomous-device-connections.json` | F | Task 30 |
| `harnessd/master.ts:186`, `reexec.ts:118,168`, `platform.ts:434` | `harnessd-status.json`, `harnessd-reexec.json`, the handover claim, the service definitions | F N | not here (Decision 12): `src/harnessd/` may not import the helper. Each is read as "none" when torn and nothing is written back |
| `harnessd/leanBundle.ts:186`, `dsh/builtins.ts:98`, `lib/windows/cliVersions.ts:53`, `devices/orcaPluginFolder.ts:137`, `lib/selfUpdate.ts:406` | a folder of files staged and swapped in | F N | not here (Decision 12): a folder swap with its own check or rollback, not one file's text |
| `lib/windows/ptyInstall.ts:183`, `tui/install.ts:105` | executables copied or downloaded, then swapped | F | not here (Decision 12): a binary swap; each is checked before it is used |
| `engines/kit/folderTrust.ts:66`, `inheritedMcp.ts:61`, `lib/connectors/agents.ts:176`, `agentClient/computerUse.ts:139` | `~/.claude.json`, `config.toml`, `opencode.json`, `.claude/settings.local.json` | F N | not here (Decision 12): another program's file. It keeps the target's mode and link, and is written beside the engine's own writes |
| `lib/uninstall/rcFiles.ts:104` | the person's shell startup files | F | not here (Decision 12): the person's file, same reason |
| `messages/inbox.ts:98` | `inbox/<pane>/<key>.json` | F N | not here (Decision 12): its temporary file is kept outside the folder the hook lists, on purpose |
| `lib/shellContextReply.ts:36`, `lib/windows/guestSetupClient.ts:55` | a one-shot reply, a one-shot request | F | not here: read once by the process that waits for it; a crash loses the request either way |
| `lib/__fixtures__/fakeGrid.ts:91` | a test fixture | F N | not here |

### Already correct, for the follow-up (the pull request carries this list)

Unique temporary name, `fsync`, rename or `link`. They stay; a follow-up moves them to the helper.

`lib/harnessRuntimeIgnore.ts:35` · `lib/handoffPublication.ts:77` · `lib/claudeProfiles.ts:24` (its reader, `readLinkedPaths` in `lib/claudeHomes.ts`, is fixed in Task 31) · `lib/apiConnections.ts:102` · `lib/agentCreationReceipt.ts:441,468` and `:571` when not exclusive · `lib/connectors/store.ts:117` · `lib/autonomous-device/resultJournal.ts:32` · `lib/autonomous-device/store.ts:107` when not exclusive · `lib/windows/pipeAuth.ts:192` · `dsh/preparation.ts:26` · `dsh/runtime.ts:59` · `engines/resumeTranscript.ts:94` · `engines/kit/nativeHookFiles.ts:220` · `engines/kit/nativeInstall.ts:120` · `engines/kit/homeAdoption.ts:264` · `devices/dialSkill.ts:120` · `devices/dialSkillFiles.ts:95` (its reader is fixed in Task 31) · `lib/registryPersistence.ts` (the registry image, out of scope by the spec; its lock is Task 33's).

## The guard's module list

`cli/src/lib/stateWrites.guard.spec.ts` fails on a `writeFileSync(` or `writeFile(` call (so `fs.writeFile`, `fs.promises.writeFile` and a handle's too) in a listed module. `lib/secureState.ts` is the helper and is not listed. A call that is not a state file carries `// not a state file: <why>` on its line or the line above.

- **Part 1 (Task 10):** `lib/registry.ts`, `lib/e2ee/store.ts`, `lib/e2ee/machinePeers.ts`, `lib/e2ee/trustGroup.ts`, `lib/e2ee/deviceLogStore.ts`, `lib/e2ee/accountTrust.ts`, `lib/authSession.ts`.
- **Part 2 (Task 19):** `lib/hookAuth.ts`, `lib/commander.ts`, `lib/daemonState.ts`, `core/main.ts`, `harnessd/master.ts`, `masterProcess.ts`, `device/machineList.ts`, `lib/runtimeInstall.ts`, `lib/engineLaunch.ts`, `lib/windows/hermesLaunch.ts`, `lib/browserShim.ts`, `lib/uninstall/deps.ts`, `lib/hostTheme.ts`, `lib/computerIdentity.ts`, `lib/codexProfiles.ts`.
- **Part 3 (Task 32):** every module of Tasks 20 to 30. Task 31's modules: `lib/codexProfiles.ts` is listed since Part 2; `lib/claudeHomes.ts` writes nothing; `lib/claudeProfiles.ts` and `devices/dialSkillFiles.ts` keep their already-correct writers until the follow-up, so they are not listed.
- **Not listed:** `lib/registryPersistence.ts`. Its registry image and, after Task 33, its lock owner are each written whole in a temporary place and published by its own rename, under the lock's protocol, not through the helper.
- **Marked calls:** `lib/runtimeInstall.ts` (the archive), `lib/engineLaunch.ts` (the launch script), `harnessd/master.ts` (the status file, Decision 12), and in Part 3 whatever a module writes that Table A leaves.

## Who reads the pid file

| Caller | After |
|---|---|
| `cli.ts` `runningDaemonPid` (`harness start`, before the lock and again under it in `launch`) | `settlePidFile()` first, on every call |
| `cli.ts` `status`, the update command, `restartDaemonForIdentity`, `runningDaemonStatus`, the remote-password hint, the login's `isDaemonRunning()` | `settlePidFile()` before the read |
| `cli.ts` the start's refusal text (`startRefusalText`) | unchanged: it reads after the command's own settle |
| `lib/daemonStop.ts` `stopDaemonProcess` (`harness stop`) | `deps.settlePid()` right after it takes the lock |
| `lib/startIfDown.ts` `startIfDown`, `runningDaemon` (`harness start --if-down`, Windows) | `deps.settlePid()` before `deps.readPid()` |
| `lib/serviceCommand.ts` (install, uninstall, status) | `deps.settlePid()` before each read |
| `lib/uninstall/command.ts` (`deps.daemonPid()`) | `deps.settlePid()` before it |
| `lib/platformDaemon.ts` `stopUnderPlatform`, `waitForMaster` | no settle of their own: the first runs inside `stopDaemonProcess`, after its settle; the second waits for the master's own claim, which is atomic |
| `lib/daemonLaunch.ts` `waitForBind` | unchanged: an unreadable file is never the child's pid, and the child's claim is atomic |
| `masterProcess.ts` `readHandoverPid`, for the re-exec handover (`harnessd/reexec.ts`) | the same answers through `parsePid`. No settle: the master is the daemon, and "no pid" keeps this master |
| `harnessd/master.ts` (hand-back in `takeOver`, release on exit) | `config.readPidFile()`: unreadable is no pid, so it neither rewrites nor removes the file |
| `core/main.ts` (shutdown, twice), `safeModeDisposition`, `removePidFileIf`, `onError` | no settle (the core is the daemon): an unreadable file is "not mine" and is left |
| `lib/unreachable.ts` `pidIn`, `lib/programDaemon.ts` `running` | `readPidFile`; unreadable is no pid. `ensure` then runs `harness start`, which settles |

## Who calls the trust stores

Checked at the base: where a `StateFileUnreadable` goes, and what changes. The reader's own line names the file once in every case.

| Caller | A throw today's code would swallow or mislabel | After |
|---|---|---|
| `lib/e2ee/manager.ts` `onPake`, `onPwPake` | their catch-alls turn any throw into `CODE_MISMATCH` or a counted `WRONG_PASSWORD` | Task 5: logged, `TIMEOUT`, not counted |
| `lib/e2ee/manager.ts` around `onPeerLinked` | caught: "the link itself stands" | unchanged: the pairing stands, the pin-back did not happen, the reader's line says why |
| `lib/e2ee/groupSyncer.ts` `apply`, `forget` | each member is caught and logged | Task 4: nobody new while the block list or the device log cannot be read |
| `lib/e2ee/groupSyncer.ts` `unpaired` (from `gateway/start.ts` `onUnpaired`) | a block that throws would skip the forget | Task 4: forget first |
| `lib/e2ee/deviceLogSyncer.ts` | `refresh`, `register` and the sweep catch and log; `current` and `suspendedKeys` do not | Task 6 |
| `lib/remoteRelay.ts` `denied` | nothing above it catches | Task 3: caught and logged |
| `lib/remoteRelay.ts` `backOff` (`markGone`), the connect (`get`) | already caught; `get` is `null`, so `NO_PEER_LINK` | unchanged |
| `gateway/sharedTrust.ts` `applyPins`, `applyKeys` (from `gateway/start.ts` `sharedTrust`) | none: the request fails | unchanged |
| `gateway/start.ts` `listed` (`restore`), `switchAccount` (`switchAccountTrust`) | `restore` never throws; the switch is caught and logged | unchanged |
| `services/fleet.ts` (`peers.get`) | none: `null` is "no link" | unchanged |
| `cli.ts` `link`, `unpair`, `group`, `remote-password`, `devices` | all end in `onError`, which prints "Failed to start adapter" and a stack | Task 9: `✗ <message>` |

## Review Focus

1. **A good pid file written between the unreadable read and the set-aside** (launchd starting the master with no spawn lock held) must not be moved aside. Pinned in Task 15 (`a pid file that became good is not set aside`).
2. **A trust file that is valid JSON of the wrong type** (`{}` in `machinePeers.json`, `null` in `group.json`) is unreadable, not empty. Pinned in Tasks 3 and 4.
3. **A trust file that stays broken is read on every relay dial:** only the first read of a given file waits. Pinned in Task 2 (`an unchanged unreadable file is not retried`).
4. **`<name>.unreadable` is already there, or cannot be made** (an older copy, a folder, a read-only folder): the reader never throws for a cache file. Pinned in Task 2.
5. **Nothing a person did not write reaches a log:** the failure is one of the fixed words, never `JSON.parse`'s message. Pinned in Task 2 (`no line holds the folder or the file's text`).

---

## Part 1: the prefix

### Task 1: The helper moves to `secureState.ts` and grows

**Depends on:** none. **Effort:** `xhigh` (every state write goes through it).

**Files:**
- Modify: `cli/src/lib/secureState.ts`, `cli/src/lib/secureState.spec.ts`
- Modify: `cli/src/lib/registry.ts` (`atomicWriteJson` leaves; its five calls pass `'trust'`, the pre-v2 backup `{ exclusive: true }`), `cli/src/lib/registryPersistence.ts` (`AtomicWriteUnconfirmed` leaves)
- Modify (imports and the `'trust'` argument only): `lib/sessionCheckpoint.ts`, `lib/commander.ts`, `lib/daemonSafeMode.ts`, `lib/stoppedAgents.ts`, `lib/terminalAgentReconciler.ts`, `lib/createAgentPane.ts`, `lib/hostMove/moveAgent.ts`, and the specs that import `AtomicWriteUnconfirmed` (`registry.diskFailure.spec.ts`, `registry.launchCallers.spec.ts`, `registry.persistenceCost.spec.ts`, `resumeAgentService.spec.ts`, `terminalAgentReconciler.spec.ts`, `hostMove/moveAgent.spec.ts`)
- Modify: `.github/workflows/windows.yml` (add `'src/lib/secureState.spec.ts'` to the `$paths` list of the step "Contract suite against the real host, and the Windows CLI specs")

**Interfaces (produces, in `secureState.ts`):**
```ts
export type StateKind = 'trust' | 'cache'
export interface AtomicWriteOptions { mode?: number; exclusive?: boolean }   // mode 0o600 unless given
export const RENAME_TRIES = 10
export const RENAME_WAIT_MS = 100
export class AtomicWriteUnconfirmed extends Error                             // moved as it is
/** True when written. False only for `exclusive`, when the file is already there. */
export function atomicWriteFile(file: string, data: string | Uint8Array, kind: StateKind, options?: AtomicWriteOptions): boolean
/** `atomicWriteFile` of `JSON.stringify(value, null, 2)`. */
export function atomicWriteJson(file: string, value: unknown, kind: StateKind, options?: AtomicWriteOptions): boolean
/** A blocking wait, for the retries here and in a store that waits on another process's write. */
export function pauseSync(ms: number): void
```
The order is the one in Global Constraints. `'trust'` calls `hardenPrivateStateFileIfPresent(file)` first; `'cache'` does not. A throw after the publish is `AtomicWriteUnconfirmed`. `registry.diskFailure.spec.ts` mocks `./secureState.js`'s `syncStateDirectory`: the writer's own flush is now an in-module call that mock does not reach, so its unconfirmed case for `atomicWriteJson`, if it has one, moves to `secureState.spec.ts`.

**Tests that fail first** (`secureState.spec.ts`, `describe('atomicWriteFile')`; they fail on the import):
- `writes the whole file with its mode`: `atomicWriteFile(f, '#!/bin/sh\n', 'cache', { mode: 0o700 })` is `true`, the text is there, the mode is `0o700` (POSIX), `0o600` with no mode, and the folder holds only `f`.
- `atomicWriteJson writes JSON.stringify(value, null, 2)`.
- `a write that fails part way leaves the old file whole and no temporary file`: the descriptor write throws `ENOSPC`; the call throws; `f` still reads `old`; `readdirSync(dir)` is `['f']`.
- `a rename the folder does not confirm is AtomicWriteUnconfirmed` (not on Windows).
- `exclusive: one creator wins and the other reads the winner's`: the first call is `true`, the second (other bytes) is `false`, `f` holds the first's.
- `exclusive: the file is never there half-written`: a second creator run from inside the first's temporary write finds no `f`, wins, and the first then answers `false`.
- `exclusive: where link is refused it copies, still exclusive`, for each of `EPERM`, `ENOTSUP`, `EXDEV`, `ENOSYS`: `true` and the bytes; with `f` already there, `false` and its bytes unchanged.
- `trust refuses a target another account could write; cache replaces it` (POSIX): `f` at `0o664`; `'trust'` throws `/group\/world writable/` and the bytes stay; `'cache'` is `true` and `f` is `0o600`.
- `on Windows a rename refused for a moment is tried again` (platform stubbed), for each of `EPERM`, `EACCES`, `EBUSY`: refused twice, then written. `it gives up after RENAME_TRIES`: `renameSync` is called exactly `RENAME_TRIES` times, the error is thrown, the old file is whole, no temporary file. `elsewhere a refused rename is not retried`: one call.
- `it.runIf(WINDOWS)`: a real replace of an existing file, and a real exclusive loser.

- [ ] Write the tests; run `cd cli && npx vitest run src/lib/secureState.spec.ts`: they fail on the missing exports. Commit `test(state): one atomic writer in secureState.ts (red)`.
- [ ] Move and grow the writer; update every importer.
- [ ] Run `npx vitest run src/lib/secureState.spec.ts src/lib/registry src/lib/stoppedAgents.spec.ts src/lib/sessionCheckpoint.spec.ts src/lib/terminalAgentReconciler.spec.ts src/lib/hostMove src/architecture.spec.ts` and `npm run typecheck`: green, and `architecture.coreFiles.txt` is unchanged.
- [ ] Commit `State files: one atomic writer in secureState.ts, with a mode, an exclusive publish and a Windows rename retry`.

### Task 2: The reader

**Depends on:** 1. **Effort:** `xhigh`.

**Files:** Modify `cli/src/lib/secureState.ts`, `cli/src/lib/secureState.spec.ts`.

**Interfaces (produces):**
```ts
export const READ_TRIES = 5
export const READ_WAIT_MS = 20
export type StateRead<T> = { state: 'ok'; value: T } | { state: 'missing' } | { state: 'unreadable'; failure: string }
/** `message`: `<base> cannot be read (<failure>). Move it aside to start over.` It holds the base name only. */
export class StateFileUnreadable extends Error { readonly name: 'StateFileUnreadable'; readonly base: string; readonly failure: string
  constructor(base: string, failure: string) }
export interface TrustFile { file: string; parse(text: string): unknown }
/** Read and parse, with the retry and the memory of Decision 4. Logs nothing, moves nothing. */
export function probeState<T>(file: string, parse: (text: string) => T): StateRead<T>
/** `probeState`, then the kind: trust is logged once and left; cache is set aside, logged, and answered as missing. */
export function readState<T>(file: string, kind: StateKind, parse: (text: string) => T): StateRead<T>
/** A trust file a write depends on: its value, null when missing, a thrown StateFileUnreadable otherwise. */
export function requireState<T>(file: string, parse: (text: string) => T): T | null
/** Rename to `<file>.unreadable`, over an older one. Never throws: a failure is one log line. */
export function setAsideUnreadable(file: string): void
export function jsonArray(text: string): unknown[]                      // throws unless a JSON array
export function jsonObject(text: string): Record<string, unknown>       // throws unless a JSON object (not null, not an array)
```
`parse` throwing a `SyntaxError` is `not valid JSON`; anything else it throws is `unexpected content`. The memory holds at most 64 paths, oldest out. A set-aside that fails logs `[state] <base> could not be set aside (<code>)` and is remembered like a trust file, so it is not tried on every read.

**Tests that fail first** (`describe('readState')`):
- `a missing file is missing`: no log line, `parse` never called.
- `a trust file that cannot be parsed is left, and said once`:
```ts
writeFileSync(file, '[{"identityPub":"')                         // what a reader saw mid-write
expect(readState(file, 'trust', jsonArray)).toEqual({ state: 'unreadable', failure: 'not valid JSON' })
expect(readFileSync(file, 'utf8')).toBe('[{"identityPub":"')
expect(warn).toHaveBeenCalledExactlyOnceWith('[state] paired.json cannot be read (not valid JSON); left as it is. Move it aside to start over.')
readState(file, 'trust', jsonArray); expect(warn).toHaveBeenCalledTimes(1)
```
- `a cache file that cannot be parsed is set aside and read as missing`: `{ state: 'missing' }`; `<file>.unreadable` holds the bytes; `file` is gone; the line is `[state] summaries.json could not be read (not valid JSON); kept as summaries.json.unreadable, starting empty.`
- `one copy is kept`: a second broken file replaces the first `.unreadable`.
- `a file another process is still writing is read again`: `parse` throws twice, then answers; the result is `ok`; `parse` ran three times.
- `it stops after READ_TRIES`: `parse` ran exactly `READ_TRIES` times.
- `an unchanged unreadable file is not retried` (Review Focus 3): a second `probeState` adds no `parse` call; after the file is rewritten whole it reads `ok`.
- `the failure is a fixed word`: `parse` throwing `new Error('x')` is `unexpected content`; a folder at the path is `EISDIR`.
- `no line holds the folder or the file's text` (Review Focus 5): no logged line and no `String(error)` from `requireState` contains the temp folder's path or `identityPub`.
- `requireState`: `null` when missing, the value when good, throws `StateFileUnreadable` with `base === 'paired.json'` otherwise.
- `a file that cannot be set aside is still read as missing` (Review Focus 4): `<file>.unreadable` is a non-empty folder; `readState(file, 'cache', …)` is `{ state: 'missing' }`, does not throw, and logs `could not be set aside`.
- `jsonArray('{}')`, `jsonObject('[]')` and `jsonObject('null')` throw.

- [ ] Write the tests; run `npx vitest run src/lib/secureState.spec.ts`: they fail on the missing exports. Commit `test(state): one reader, two kinds (red)`.
- [ ] Implement the reader.
- [ ] Run the spec and `npm run typecheck`: green.
- [ ] Commit `State files: a reader that leaves a trust file and sets a cache file aside`.

### Task 3: Pinned machines (`machinePeers.json`, `machinePeers-gone.json`)

**Depends on:** 2. **Effort:** `xhigh` (trust data).

**Files:** Modify `cli/src/lib/e2ee/machinePeers.ts`, `machinePeers.spec.ts`, `cli/src/lib/remoteRelay.ts`, `remoteRelay.spec.ts`.

**Interfaces:**
- Consumes: `requireState`, `readState`, `jsonArray`, `atomicWriteJson`, `atomicWriteFile`, `StateFileUnreadable`, `TrustFile`.
- Produces: `export function machinePeerFiles(): TrustFile[]` (both files, each parsed with `jsonArray`). The store's methods keep their signatures.
- Behavior: `get` answers `null` and `list` `[]` for an unreadable `machinePeers.json`; `pin` and `unlink` throw `StateFileUnreadable`. An unreadable gone file: `gone()` answers the marks in memory; `markGone` keeps its mark in memory and throws; `restore` keeps them back in memory and does not throw, as today for a file it cannot rewrite. The pins are written with `atomicWriteJson(…, 'trust')`, the gone list with `atomicWriteFile` (its bytes today have no indent).
- `RemoteRelayPool.denied` catches a `StateFileUnreadable` from `unlink` and logs `[relay] could not drop the pin of a machine that denied this one: <message>`: nothing above it would catch it.

**Tests that fail first:**
```ts
it('a torn machinePeers.json is never written over', () => {
  writeFileSync(FILE, '[{"machineId":"' + a)
  const peers = new MachinePeerStore()
  expect(peers.get(a)).toBeNull(); expect(peers.list()).toEqual([])
  expect(() => peers.pin(b, 'pub-b', 'B')).toThrow(StateFileUnreadable)
  expect(() => peers.unlink(a)).toThrow(StateFileUnreadable)
  expect(readFileSync(FILE, 'utf8')).toBe('[{"machineId":"' + a)   // today: one entry, the others gone
})
```
- `an object where the list should be is unreadable too` (Review Focus 2): `{}` in the file, the same four answers.
- `a pin that fails part way leaves the old pins`: the write throws; the file still holds both earlier pins (today it is truncated).
- `a torn gone list keeps its marks in memory and is not rewritten`: `markGone(a)` throws, `gone().has(a)` is true, the bytes are unchanged; `restore([a])` is `true`, throws nothing, bytes unchanged.
- `a file made whole again is used`: after the file is rewritten, `pin` works.
- `remoteRelay.spec.ts`: `a pin that cannot be dropped is said, and the relay goes on`: with the pins unreadable, a denial neither throws nor rejects, and the line is logged.

- [ ] Write the tests; run `npx vitest run src/lib/e2ee/machinePeers.spec.ts src/lib/remoteRelay.spec.ts`: the first fails with one entry written over the file. Commit `test(state): pinned machines are never written over (red)`.
- [ ] Implement.
- [ ] Run the two specs, `src/gateway/sharedTrust.spec.ts`, and `npm run typecheck`: green.
- [ ] Commit `Linked machines: a pin file that cannot be read is left, and never replaced by an empty one`.

### Task 4: The trust group and its block list (`group.json`, `group-blocked.json`)

**Depends on:** 2. **Effort:** `xhigh`.

**Files:** Modify `cli/src/lib/e2ee/trustGroup.ts`, `trustGroup.spec.ts`, `cli/src/lib/e2ee/groupSyncer.ts`, `groupSyncer.spec.ts`.

**Interfaces:**
- Produces: `export function trustGroupFiles(): TrustFile[]` (`group.json` with `jsonObject`, `group-blocked.json` with `jsonArray`).
- `TrustGroupStore`: `read()` and `list()` answer the empty roster for an unreadable `group.json`; `merge`, `add` and `remove` throw. `blocked()` throws for an unreadable block list; `block` and `unblock` throw with it, and `merge` reads the block list first so it throws too.
- `GroupSyncer.apply` (and so `applyAll`, `resume`, `adoptFromLog`): when `store.blocked()` or `deps.suspended()` throws `StateFileUnreadable`, it pins and trusts nobody from `upserted`, logs `[group] the block list cannot be read: nobody new is pinned or trusted` (or `the device log cannot be read: …`), and still forgets `dropped`.
- `GroupSyncer.isBlocked` answers `false` when the block list is unreadable: the device log must still show every NEW DEVICE alert.
- `GroupSyncer.unpaired(pub)` forgets the key first, then blocks it: a block that throws leaves the key untrusted here, and the throw goes on to the caller.

**Tests that fail first:**
```ts
it('a torn block list is never replaced by one entry', () => {
  writeFileSync(BLOCKED, '["' + pubA)                              // two keys were blocked
  const store = new TrustGroupStore()
  expect(() => store.blocked()).toThrow(StateFileUnreadable)
  expect(() => store.block(pubC)).toThrow(StateFileUnreadable)
  expect(() => store.unblock(pubA)).toThrow(StateFileUnreadable)
  expect(() => store.merge({ members: [member], removed: [] }, self)).toThrow(StateFileUnreadable)
  expect(readFileSync(BLOCKED, 'utf8')).toBe('["' + pubA)          // today: ["<pubC>"], which un-blocks the others
})
```
- `a torn roster cannot merge, and is not written back`: `merge`, `add`, `remove` throw; `list()` is `[]`; bytes unchanged. `null` in `group.json` is the same (Review Focus 2).
- `a roster write that fails part way leaves the old roster`.
- `groupSyncer.spec.ts`: `nobody new is pinned or trusted while the block list cannot be read`: `deps.trust` and `peers.pin` are not called for an upserted member, a dropped one is still forgotten, the line is logged; the same when `deps.suspended` throws. `a key cannot be told blocked reads as not blocked`: `isBlocked(pub)` is `false`. `an unpair still unpins and untrusts when the block cannot be written`: `deps.untrust` was called, then `unpaired` throws.

- [ ] Write the tests; run `npx vitest run src/lib/e2ee/trustGroup.spec.ts src/lib/e2ee/groupSyncer.spec.ts`: the first fails with the list replaced. Commit `test(state): the trust group's files are never written over (red)`.
- [ ] Implement.
- [ ] Run the two specs and `npm run typecheck`: green.
- [ ] Commit `Trust group: a roster or block list that cannot be read is left, and nobody new is trusted meanwhile`.

### Task 5: Identity, paired clients, the remote password

**Depends on:** 2. **Effort:** `xhigh` (the root of trust).

**Files:** Modify `cli/src/lib/e2ee/store.ts`, `store.spec.ts`, `cli/src/lib/e2ee/manager.ts`, `manager.test.ts`.

**Interfaces:**
- Produces: `export function e2eeStoreFiles(): TrustFile[]` (`identity.json`: a JSON object whose `priv` and `pub` decode to 32 bytes each; `paired.json`: `jsonArray`; `remotePassword.json`: `jsonObject`).
- `init()`: a readable identity is used; a missing one is minted with `atomicWriteJson(IDENTITY_FILE, …, 'trust', { exclusive: true })`, and a `false` answer means another process won: its file is read. An unreadable `identity.json` throws `StateFileUnreadable`; it is never replaced. `IDENTITY_READ_RETRIES`, `IDENTITY_READ_RETRY_MS` and `sleepSync` go: the reader's retry covers an older build's create-then-fill.
- `peekIdentityPub`, `peekIdentity` use `probeState` and answer `null` as today (no log line from a read-only command).
- Paired: an unreadable `paired.json` leaves the set empty and marks it; `addPaired`, `removePaired` and `clear` read it again when marked, and throw `StateFileUnreadable` if it is still unreadable (also when there is nothing to remove).
- Password: an unreadable `remotePassword.json` is "no password" for `hasRemotePassword` and `remotePasswordVerifier`; `setRemotePassword`, `clearRemotePassword`, `notePwFailure` and `notePwSuccess` throw.
- `writeSecure` goes; every write is `atomicWriteJson(file, data, 'trust')`.
- `E2eeManager`: the catch-alls of `onPake` and `onPwPake` no longer turn a `StateFileUnreadable` into `CODE_MISMATCH` or a counted `WRONG_PASSWORD`. Each logs `[e2ee] the pairing could not be saved: <message>` and fails the pairing with `TIMEOUT`, uncounted.

**Tests that fail first:**
```ts
it('an identity that cannot be read is never replaced', () => {
  writeFileSync(IDENTITY, '{"priv":"')
  expect(() => new E2eeStore().init()).toThrow(StateFileUnreadable)
  expect(readFileSync(IDENTITY, 'utf8')).toBe('{"priv":"')         // today: a new key after 10 × 20 ms
})
```
- `two processes minting at once hold one identity`: with `node:fs` wrapped so that, the moment the first store has made the final path (today's `wx` create) or is about to publish it (`linkSync`), a second store's `init()` runs to completion; both stores' public keys are equal and the file holds that key. Today the second replaces the file and they differ.
- `a torn paired.json refuses every change`: `count()` is 0, `isPaired(pub)` false; `addPaired`, `removePaired`, `clear` throw; bytes unchanged. Today `addPaired` writes one client over the others.
- `a torn remotePassword.json is no password, and is not replaced`: `hasRemotePassword()` false; the four writers throw; bytes unchanged.
- `a pairing or password write that fails part way leaves the old file`.
- `manager.test.ts`: `a pairing that cannot be saved is not a wrong password`: with `paired.json` torn, a correct password-PAKE ends with `error: 'TIMEOUT'`, the failure count is unchanged (`pwLockedUntil()` null after five such tries), and the line is logged. The same for the live code: `TIMEOUT`, not `CODE_MISMATCH`.

- [ ] Write the tests; run `npx vitest run src/lib/e2ee/store.spec.ts src/lib/e2ee/manager.test.ts`: the first fails with a new identity minted. Commit `test(state): the identity and the paired set are never replaced (red)`.
- [ ] Implement.
- [ ] Run the two specs and `npm run typecheck`: green.
- [ ] Commit `E2EE store: the identity is published whole and never replaced, and a paired set or password that cannot be read refuses changes`.

### Task 6: The device key log (`devlog.json`, `devlog.archive.json`)

**Depends on:** 2. **Effort:** `xhigh` (the freeze and the rollback protection live here).

**Files:** Modify `cli/src/lib/e2ee/deviceLogStore.ts`, `deviceLogStore.spec.ts`, `cli/src/lib/e2ee/deviceLogSyncer.ts`, `deviceLogSyncer.spec.ts`.

**Interfaces:**
- Produces: `export function deviceLogFiles(): TrustFile[]` (both files with `jsonObject`).
- `DeviceLogStore`: every read (`read`, `archivedFile`, `archivedSuspended`, and the reads inside `update`, `archive`, `restore`, `unsuspendArchived`) throws `StateFileUnreadable` for an unreadable file; a missing file is the empty log as today. `write` reads the live file first, so it throws too. `writeJson` becomes `atomicWriteFile(path, JSON.stringify(value), 'trust')`.
- `DeviceLogSyncer`: read every use of `deps.store` (42 at the base). The rule: a `StateFileUnreadable` reaches a caller that logs it, or the method answers closed; none answers as for an empty log. `current()` is `false`. `suspendedKeys()` throws (Task 4's `apply` then trusts nobody new). `refresh`, `register` and the sweep already catch and log: they write nothing.

**Tests that fail first:**
```ts
it('a torn log is not an empty log', () => {
  writeFileSync(file, '{"state":{"acct":"')
  const store = new DeviceLogStore(file)
  expect(() => store.read()).toThrow(StateFileUnreadable)
  expect(() => store.update((f) => f)).toThrow(StateFileUnreadable)
  expect(() => store.write(fresh)).toThrow(StateFileUnreadable)
  expect(readFileSync(file, 'utf8')).toBe('{"state":{"acct":"')    // today: read() is empty(), the freeze is gone
})
```
- `a torn archive keeps its suspensions`: `archivedSuspended()`, `archivedFile(acct)`, `archive(f)`, `restore(acct)`, `unsuspendArchived([k])` throw; bytes unchanged.
- `the temporary file is flushed before it is renamed`, and `two writes in one millisecond do not share a temporary name` (today's is `<pid>.<Date.now()>.tmp`).
- `deviceLogSyncer.spec.ts`: `a log that cannot be read stops the syncer, and nothing is written`: `refresh()` resolves, logs `[devlog] refresh failed: devlog.json cannot be read …`, the bytes are unchanged; `current()` is `false`; `suspendedKeys()` throws.

- [ ] Write the tests; run `npx vitest run src/lib/e2ee/deviceLogStore.spec.ts src/lib/e2ee/deviceLogSyncer.spec.ts`: the first fails with `read()` answering the empty log. Commit `test(state): a device log that cannot be read is not an empty one (red)`.
- [ ] Implement.
- [ ] Run the two specs and `npm run typecheck`: green.
- [ ] Commit `Device log: a file that cannot be read keeps its freeze, and is never started over`.

### Task 7: Per-account trust (`e2e/accounts/<account>/`)

**Depends on:** 2. **Effort:** `xhigh`.

**Files:** Modify `cli/src/lib/e2ee/accountTrust.ts`, `accountTrust.spec.ts`.

**Interfaces:**
- Produces: `export function keptAccountDirs(dir?: string): string[]` (the `accounts/<account>` folders whose name matches `ACCT`, at most 64).
- `writeAtomic` goes: `atomicWriteJson(file, data, 'trust')`. `readList` reads with `requireState(file, jsonArray)`.
- `stashTrust` and `unstashTrust` read every `paired.json` they will touch before anything moves; an unreadable one throws `StateFileUnreadable` and nothing is renamed or written. The whole files (`group.json`, `group-blocked.json`, `machinePeers.json`) are still moved by rename without being parsed: an unreadable one is unreadable in its new place, where its own store fails closed.

**Tests that fail first:**
- `a torn live paired.json stops the switch before anything moves`: `stashTrust(A, dir)` throws; `group.json` is still in `dir`; bytes unchanged.
- `a torn paired.json is never written over by a return`: `unstashTrust(A, dir)` with the live file torn throws; bytes unchanged (today it is read as `[]` and replaced); the kept copy is still there.
- `a torn kept copy is left`: `unstashTrust` throws; the kept bytes are unchanged; the live file is untouched.
- `the copy is flushed before the original is cut`, and `a file at the old fixed temporary name is left alone` (`paired.json.<pid>.tmp`).

- [ ] Write the tests; run `npx vitest run src/lib/e2ee/accountTrust.spec.ts`: the second fails with the live file replaced. Commit `test(state): an account switch never writes over a paired set it cannot read (red)`.
- [ ] Implement.
- [ ] Run the spec and `npm run typecheck`: green.
- [ ] Commit `Account trust: a switch reads before it moves, and writes through the helper`.

### Task 8: The auth session (`auth/session.json`)

**Depends on:** 2. **Effort:** `xhigh` (a credential).

**Files:** Modify `cli/src/lib/authSession.ts`, `authSession.spec.ts`, `cli/src/cli.ts` (`saveSignIn` and `browserSignIn`: one call each), `cli/src/authCommand.spec.ts`.

**Interfaces:**
- Produces: `export function authSessionFiles(): TrustFile[]` (`session.json` with `jsonObject`).
- `readStored` reads with `readState(AUTH_SESSION_FILE, 'trust', jsonObject)`: unreadable is `null` (not signed in). A JSON object of another version or shape is `null` as today, and can be replaced as today.
- `writeAuthSession` throws `StateFileUnreadable` when the file on disk is unreadable (`requireState`), else writes `atomicWriteFile(AUTH_SESSION_FILE, JSON.stringify(session) + '\n', 'trust')`. Every writer but the two below goes through it and stays fail closed: `updateAuthSession`, `ensureSignInEpoch`, `markSignedOut(Held)`, the refresh's writes (`lib/authRefresh.ts`).
- Produces: `export function setAsideUnreadableSession(): void`: `readState(AUTH_SESSION_FILE, 'cache', jsonObject)`, whose answer is dropped. An unreadable file is renamed to `session.json.unreadable` with the cache line; a good or missing one is untouched. It is what a person replacing the session on purpose does first (Decision 8).
- Produces: `export function writeSignIn(session: AuthSession): void`: `setAsideUnreadableSession()`, then `writeAuthSession(session)`. `cli.ts` `saveSignIn` (QR and ticket) and `browserSignIn` (SSO) call it in place of `writeAuthSession`. If the set-aside itself fails (it logs `could not be set aside`), the write throws `StateFileUnreadable` as any other write would.
- `clearAuthSession`: `setAsideUnreadableSession()`, then removes the file as today. Its one product caller is `lib/signOut.ts` `removeSignIn` (`harness logout`, `harness reset`).

**Tests that fail first:**
- `a torn session is signed out, and only a sign-in by hand replaces it`: `session.json` holds `{"version":1,"accessTok`; `readAuthSession()` is `null`; `writeAuthSession(next)` and `updateAuthSession(() => next)` throw `StateFileUnreadable` (the second rejects) and the bytes are unchanged. Today `writeAuthSession` replaces it.
- `a sign-in by hand sets a torn session aside and writes the new one`: same file; `writeSignIn(next)` does not throw; `readAuthSession()` equals `next`; `session.json.unreadable` holds the torn bytes; the line is `[state] session.json could not be read (not valid JSON); kept as session.json.unreadable, starting empty.` Fails today: no `writeSignIn`.
- `a sign-in over a good session replaces it and sets nothing aside`.
- `clearAuthSession sets a torn session aside`: `session.json` is gone and `session.json.unreadable` holds its bytes; with a good session, it is removed and no `.unreadable` is made. Fails today: the torn bytes are deleted.
- `a session of another version is replaced as before`.
- `a write that fails part way leaves the old session`; `the session is flushed before it is renamed`.
- `authCommand.spec.ts`, under `signing out takes a person`: `logout over a session that cannot be read sets it aside`: `session.json` torn; `runSync(root, ['logout', '--from-sign-out-button'])` exits 0; `session.json` is gone; `session.json.unreadable` holds the bytes. Fails today: no `.unreadable`.
- `authCommand.spec.ts`, under `harness login --json`: `a login over a session that cannot be read signs in`: `session.json` torn; a sign-in driven against `fakeBackend` as that block's tests drive one ends with `{ type: 'result', status: 'success' }` and exit 0; `session.json` holds the new session and `session.json.unreadable` the torn bytes. Fails today: no `.unreadable`.

- [ ] Write the tests; run `npx vitest run src/lib/authSession.spec.ts src/authCommand.spec.ts`: the first fails with the file replaced, the set-aside cases with no `.unreadable`. Commit `test(state): a session that cannot be read is replaced only by a sign-in by hand (red)`.
- [ ] Implement.
- [ ] Run the two specs, `src/loginReads.spec.ts`, `src/loginForceRace.spec.ts`, `src/lib/signOut.spec.ts`, and `npm run typecheck`: green.
- [ ] Commit `Sign-in: the session is written whole; one that cannot be read is left, and set aside only by a login or a logout`.

### Task 9: `harness status` names an unreadable trust file

**Depends on:** 3, 4, 5, 6, 7, 8. **Effort:** `high`.

**Files:**
- Create: `cli/src/lib/trustFiles.ts`, `cli/src/lib/trustFiles.spec.ts`, `cli/e2e/stateFiles.e2e.ts`
- Modify: `cli/src/cli.ts` (`status`), `cli/src/lib/daemonState.ts` (`onError`), `docs/cli.md`

**Interfaces:**
- Consumes: `machinePeerFiles`, `trustGroupFiles`, `e2eeStoreFiles`, `deviceLogFiles`, `keptAccountDirs`, `authSessionFiles`, `probeState`.
- Produces in `trustFiles.ts`:
  - `export function trustFiles(): TrustFile[]`: the live files, then for each kept account folder the four names it can hold (`group.json`, `group-blocked.json`, `machinePeers.json`, `paired.json`), each with the parse of the live file of that name.
  - `export function unreadableTrustLines(files?: readonly TrustFile[]): string[]`: one Global Constraints line per file `probeState` finds unreadable.
- `status()` prints those lines after `printInfoBlock`, and leaves the device row out when `DeviceLogStore.read()` throws `StateFileUnreadable`. The exit code stays 0.
- `onError`: a `StateFileUnreadable` prints `✗ <message>` and `  harness status shows where it is`, no stack and not "Failed to start adapter", then lets go of the pid file and exits as before. Every trust command of the CLI (`link`, `unpair`, `group`, `remote-password`, `devices`) already ends in `onError`.
- `docs/cli.md`: a short section after the commands table, "A state file that cannot be read": what `status` prints, what a trust file refuses, where a cache file's bytes go.

**Tests that fail first:**
- `trustFiles.spec.ts`: `names each trust file that cannot be read, with its full path`: a torn `paired.json` and a torn `accounts/<acct>/group.json` give exactly two lines, each `  ! <full path> cannot be read (not valid JSON) · move it aside to start over`; a good or missing file gives none; nothing is logged and no byte changes.
- `e2e/stateFiles.e2e.ts` (an `IsolatedDaemon`, the CLI run with its environment as `cli.e2e.ts` runs it): `status names a paired set it cannot read, and unpair does not replace it`: `e2e/paired.json` is written truncated before the daemon starts (a daemon that loaded a good file holds the set in memory, and its next write heals the file); `harness status` exits 0 and prints the line with the file's path; `harness unpair --all` does not succeed; the bytes are unchanged. With the daemon stopped, `harness unpair --all` exits 1 with `✗ paired.json cannot be read`. `a torn device log does not break status`.

- [ ] Write the tests; run `npx vitest run src/lib/trustFiles.spec.ts` and `npx vitest run --config vitest.e2e.config.ts e2e/stateFiles.e2e.ts`: they fail (no module; no line). Commit `test(state): status names a trust file it cannot read (red)`.
- [ ] Implement; write the doc section.
- [ ] Run both, `src/cliCommand.spec.ts`, and `npm run typecheck`: green.
- [ ] Commit `harness status: one line for each trust file that cannot be read, with its path and the fix`.

### Task 10: The guard, part 1

**Depends on:** 3, 4, 5, 6, 7, 8. **Effort:** `high`.

**Files:** Create `cli/src/lib/stateWrites.guard.spec.ts`. Modify `cli/AGENTS.md` (one rule under Rules: state files are written through `atomicWriteFile` / `atomicWriteJson` and read through `readState`, and the guard lists the modules).

**Interfaces (produces, in the spec):**
- `const STATE_MODULES: readonly string[]` (paths under `cli/src`), with the Part 1 list.
- `function hits(source: string): Array<{ line: number; text: string }>`: every line outside a comment that matches `/\bwriteFile(Sync)?\s*\(/`, unless that line or the one above holds `not a state file:`.

**Tests that fail first** (the scanner does not exist):
- `finds a write in place`: `hits('writeFileSync(file, data)')` and `hits('await fs.promises.writeFile(file, data)')` have one hit each; `hits('// writeFileSync(file)')` has none; `hits('writeFileSync(archive, bytes) // not a state file: a one-shot download')` has none.
- `no listed module writes a state file outside the helper`: for each of `STATE_MODULES`, `hits(readFileSync(...))` is `[]`, printed as `file:line: text`.

- [ ] Write the spec; run `npx vitest run src/lib/stateWrites.guard.spec.ts`: red (no scanner). Commit `test(state): a guard for state modules (red)`.
- [ ] Write the scanner in the spec; add the rule to `cli/AGENTS.md`.
- [ ] Run the spec: green.
- [ ] Commit `State files: a guard fails on a write outside the helper in a module that owns one`.

---

## Part 2: the rest of the spec

### Task 11: The hook credential (`hook-credential`, `hook-token`)

**Depends on:** 9, 10. **Effort:** `xhigh` (a credential, a race).

**Files:** Modify `cli/src/lib/hookAuth.ts`, `hookAuth.spec.ts`, `cli/src/lib/trustFiles.ts`, `trustFiles.spec.ts`.

**Interfaces:**
- `loadOrCreateSecret`: after `readSecret` finds none, `atomicWriteFile(file, value + '\n', 'trust', { exclusive: true })`. `true`: the value is this one. `false`: another creator's file is read with `readSecret`, up to `READ_TRIES` times `READ_WAIT_MS` apart (`pauseSync`; an older build fills its file after creating it); still none throws `StateFileUnreadable(<base>, 'unexpected content')`. The hand-written `O_EXCL` open, write and flush go.
- Produces: `export function hookSecretFiles(dataDir: string): TrustFile[]` (both files; `parse` throws unless the trimmed text matches the token pattern). `trustFiles()` adds them.

**Tests that fail first:**
- `two daemons creating the credential at once read one value`: with `node:fs` wrapped so that a second `loadOrCreateHookCredential` runs the moment the first has made the final path (today's `O_EXCL` open) or is about to publish it (`linkSync`); both answer the same 43 characters, neither throws. Today the second throws `EEXIST`.
- `the credential is never there empty`: at no wrapped call does the final path exist with fewer than 44 bytes.
- `a credential that cannot be used is left, and said`: the file holds `x`; `loadOrCreateHookCredential` throws `StateFileUnreadable`; the bytes are unchanged.
- `trustFiles.spec.ts`: a torn `hook-token` gives its line.

- [ ] Write the tests; run `npx vitest run src/lib/hookAuth.spec.ts src/lib/trustFiles.spec.ts`: the first fails with `EEXIST`. Commit `test(state): the hook credential is published whole (red)`.
- [ ] Implement.
- [ ] Run the two specs, `src/hookServer.spec.ts`, `npx vitest run src/lib/stateWrites.guard.spec.ts`, and `npm run typecheck`: green.
- [ ] Commit `Hook credential: created whole, so a second daemon reads the first's and never an empty file`.

### Task 12: The recap files, and the save's cost

**Depends on:** 9, 10. **Effort:** `high`.

**Files:** Modify `cli/src/lib/commander.ts`, `commander.spec.ts`. Create `cli/src/lib/commander.saveCost.spec.ts`.

**Interfaces:**
- `CommanderMirror.save(strict)`: one path. All four files go through `atomicWriteJson(file, Object.fromEntries(map), 'cache')`; `strict` only decides whether a failure is thrown or logged.
- `load()`: each file through `readState(file, 'cache', jsonObject)`.

**Tests that fail first:**
- `a torn history is set aside, not written over`: `summaries-history.json` holds `{"s1":["a recap`; a mirror is made and a turn is recapped; `summaries-history.json.unreadable` holds those bytes. Today they are gone after the first save.
- `a save that fails part way leaves the four files whole`: the timer path's save meets a write that throws; each file still parses and holds what it held. Today the file being written is empty.
- `the timer's save and the strict save write the same bytes`.

**The measurement** (`commander.saveCost.spec.ts`, runs only with `RECAP_SAVE_COST=1`): a full history (Decision 13) is 200 sessions, each with a latest summary, 3 history entries of 400 characters, 3 full answers of 8,192 bytes (`FULL_TEXT_MAX_BYTES`) and 3 questions of 1,000 characters (`ASK_MAX_CHARS`), written as the four files and loaded by the constructor. It times 30 saves as the 200 ms timer makes them, prints `recap save · 200 sessions · <bytes> bytes · median <ms> ms · p95 <ms> ms`, and asserts only that the four files parse. It sets no limit.

- [ ] Write the tests and the measurement; run `npx vitest run src/lib/commander.spec.ts`: the two torn cases fail. Run `RECAP_SAVE_COST=1 npx vitest run src/lib/commander.saveCost.spec.ts` three times on a quiet machine and keep the lines: **before**. Commit `test(state): the recap files are never written over or left half-written (red)`.
- [ ] Implement.
- [ ] Run the spec, `src/lib/commanderReplay.spec.ts`, `src/lib/commanderNotifications.spec.ts`, and `npm run typecheck`: green. Run the measurement three times again on the same machine: **after**.
- [ ] Commit `Recaps: every save is whole, and a file that cannot be read is set aside`. Report both sets of lines and the machine; the pull request carries them.

### Task 13: The pid file: three answers, one writer

**Depends on:** 9, 10. **Effort:** `xhigh`.

**Files:** Modify `cli/src/lib/daemonState.ts`, `daemonState.pidFile.spec.ts`, `cli/src/lib/unreachable.ts`, `unreachable.spec.ts`, `cli/src/lib/programDaemon.ts`, `programDaemon.spec.ts`, `cli/src/testing/spawnedRuns.ts`.

**Interfaces (produces, in `daemonState.ts`):**
```ts
export type PidFileRead = { state: 'pid'; pid: number } | { state: 'missing' } | { state: 'unreadable' }
/** Digits with whitespace around them, a safe integer above 0; anything else is no pid. */
export function parsePid(text: string): number | null
export function readPidFile(file?: string): PidFileRead                 // probeState: the retry, no log, nothing moved
export function writePidFile(pid: number, file?: string): void          // atomicWriteFile(file, `${pid}\n`, 'cache')
/** The master pid the daemon itself answered with while its pid file could not be read; null takes it back. */
export function setAnsweredPid(pid: number | null): void
/** The pid file's pid; for a file that cannot be read, the answered pid; else null. */
export function readPid(): number | null
/** When the pid file was written; null when there is none, or when the pid in use is the daemon's answer. */
export function pidFileWrittenMs(): number | null
```
`pidIn`, `programDaemon`'s `running` and `spawnedRuns` read through `readPidFile` / `parsePid`. `pidFileWrittenMs` is for Task 15: on Windows the file's time must not judge a pid the daemon gave itself.

**Tests that fail first** (`daemonState.pidFile.spec.ts`):
- `an empty or torn pid file is unreadable, not missing`: `''`, `'12x'` and a folder at the path are `{ state: 'unreadable' }`; no file is `{ state: 'missing' }`; `'4242\n'` is `{ state: 'pid', pid: 4242 }`.
- `readPid answers the daemon's own pid for a file that cannot be read`: unreadable and `setAnsweredPid(77)` gives 77; once the file is whole it gives the file's pid; once it is removed, `null`.
- `writePidFile leaves the old pid when the write fails`, and the file is `0600`.
- `pidFileWrittenMs is null for an answered pid`.

- [ ] Write the tests; run `npx vitest run src/lib/daemonState.pidFile.spec.ts src/lib/unreachable.spec.ts src/lib/programDaemon.spec.ts`: red (no exports). Commit `test(state): the pid file has three answers (red)`.
- [ ] Implement.
- [ ] Run the three specs, `src/lib/daemonSafeMode.spec.ts`, `src/lib/daemonLaunch.spec.ts`, `src/architecture.spec.ts`, and `npm run typecheck`: green.
- [ ] Commit `Pid file: a file that cannot be read is not "no daemon", and it is written whole`.

### Task 14: The pid file's writers, and the machine name

**Depends on:** 13. **Effort:** `xhigh` (the master: 100% per file).

**Files:** Modify `cli/src/core/main.ts`, `cli/src/harnessd/master.ts`, `harnessd/master.spec.ts`, `cli/src/masterProcess.ts`, `masterProcess.spec.ts`.

**Interfaces:**
- `MasterConfig` gains two required members: `writePidFile(pid: number): void` and `readPidFile(): number | null`. `runMaster` uses them where it wrote and parsed `config.pidFile`; `pidFile` stays for the remove. `masterProcess.ts` passes `(pid) => writePidFile(pid)` and `() => { const read = readPidFile(); return read.state === 'pid' ? read.pid : null }`.
- `readHandoverPid` keeps its answers and parses with `parsePid`.
- `core/main.ts`: `startMasterHere` and the no-master branch call `writePidFile`; `onMachineMeta` writes `atomicWriteFile(MACHINE_NAME_FILE, name + '\n', 'cache')`.
- `harnessd/master.ts`'s status file write gets `// not a state file: the master imports no helper (follow-up)` (Decision 12).

**Tests that fail first:**
- `master.spec.ts`: `the master claims the pid file through the writer it is given`: the injected writer is called with the master's pid at the claim, and with `from` at the hand-back in `takeOver`; a writer that throws is logged as today. `a pid file it cannot read is neither rewritten nor removed`.
- `masterProcess.spec.ts`: `the pid file is written whole`: a write that fails leaves the earlier pid.

- [ ] Write the tests; run `npm run test:harnessd` and `npx vitest run src/masterProcess.spec.ts`: red. Commit `test(state): the master writes its pid through a writer it is given (red)`.
- [ ] Implement.
- [ ] Run `npm run test:harnessd` (100% per file), `npx vitest run src/masterProcess.spec.ts src/architecture.spec.ts`, and `npm run typecheck`: green.
- [ ] Commit `Daemon: the pid file and the machine name are written whole`.

### Task 15: An unreadable pid file asks the daemon

**Depends on:** 9, 13. **Effort:** `xhigh` (two processes, one lock).

**Files:**
- Create: `cli/src/lib/pidFileSettle.ts`, `cli/src/lib/pidFileSettle.spec.ts`
- Modify: `cli/src/lib/daemonSpawnLock.ts` (one export), `cli/src/lib/daemonStop.ts`, `cli/src/lib/startIfDown.ts`, `cli/src/lib/serviceCommand.ts`, `cli/src/lib/uninstall/command.ts`, `cli/src/lib/uninstall/deps.ts`, `cli/src/cli.ts`, their specs, `cli/e2e/stateFiles.e2e.ts`

**Interfaces:**
- `daemonSpawnLock.ts`: `export function spawnLockHeldHere(): boolean`.
- `pidFileSettle.ts` (not in the core's process):
```ts
export interface SettleDeps {
  read(): PidFileRead
  /** The daemon's local status (lib/daemonEndpoint.ts localDaemonStatus); null when none answers. */
  status(): Promise<Record<string, unknown> | null>
  /** The spawn lock is free, or this process holds it. False for another holder, or a lock that cannot be read. */
  lockFree(): boolean
  setAside(): void
  answer(pid: number | null): void
}
export type Settled = { state: 'pid'; pid: number; from: 'file' | 'daemon' } | { state: 'missing' } | { state: 'busy' }
export function processSettleDeps(): SettleDeps
export async function settlePidFile(deps?: SettleDeps): Promise<Settled>
```
- The rule: a pid or a missing file takes the answered pid back and is returned. An unreadable file asks `status()`; a safe integer `pid` above 0 in the answer is recorded (`answer`) and returned as `from: 'daemon'`. No answer and `lockFree()`: `read()` once more, and only if it is still unreadable `setAside()`, then `missing`. No answer and the lock held elsewhere: the file is left, the answered pid is taken back, and the result is `busy` (Decision 11): this read has no pid, and a command that changes the daemon settles again under its own lock.
- `StopDeps`, `IfDownDeps`, `ServiceCommandDeps` and the uninstall's deps each gain `settlePid(): Promise<unknown>`, called where [Who reads the pid file](#who-reads-the-pid-file) says. The two inline `statSync(PID_FILE).mtimeMs` (`daemonStop.ts`, `startIfDown.ts`) become `pidFileWrittenMs()`.

**Tests that fail first:**
- `pidFileSettle.spec.ts`: `an unreadable pid file with a daemon running is that daemon`: `status` answers `{ pid: 4242 }`; the result is `{ state: 'pid', pid: 4242, from: 'daemon' }`, `answer(4242)` was called, nothing was set aside. `with no daemon and a free lock it is set aside`: `setAside` once, result `missing`. `with no daemon and the lock held elsewhere it is left`: no `setAside`, result `busy`. `a pid file that became good is not set aside` (Review Focus 1): the second `read()` answers a pid; no `setAside`; that pid is returned. `a good file never asks the daemon`.
- `daemonStop.spec.ts`: `a stop settles under its lock`: `settlePid` is called after `lock` and before `readPid`.
- `startIfDown.spec.ts`: `a pid the daemon answered is not judged by the file's time`.
- `e2e/stateFiles.e2e.ts`: `a daemon whose pid file was emptied is still running, and can be stopped`: `harness status` says running with the master's pid, `harness start` says it already runs, `harness stop` exits 0 and the master is gone. `a stray pid file does not stop a start`: no daemon, `adapter.pid` holds `x`; `harness start` starts one and `adapter.pid.unreadable` holds `x`.

- [ ] Write the tests; run `npx vitest run src/lib/pidFileSettle.spec.ts src/lib/daemonStop.spec.ts src/lib/startIfDown.spec.ts src/lib/serviceCommand.spec.ts src/lib/uninstall` and the e2e file: red. Commit `test(state): an unreadable pid file asks the daemon (red)`.
- [ ] Implement.
- [ ] Run them again, `src/cliStopFirst.spec.ts`, `src/cliCommand.spec.ts`, `src/architecture.spec.ts`, and `npm run typecheck`: green.
- [ ] Commit `Start, stop and status: a pid file that cannot be read asks the daemon, and is set aside only when none answers`.

### Task 16: Scripts and launch files

**Depends on:** 9, 10. **Effort:** `high`.

**Files:** Modify `cli/src/lib/engineLaunch.ts`, `engineLaunch.spec.ts`, `cli/src/lib/browserShim.ts`, `browserShim.spec.ts`, `cli/src/lib/windows/hermesLaunch.ts`, `hermesLaunch.spec.ts`.

**Interfaces:**
- `zshNewUserGuard`: `atomicWriteFile(file, ZSH_GUARD_ZSHENV, 'cache')`. The launch script in the same module keeps its write, with `// not a state file: a fresh name, complete before tmux is started with it`.
- `writeBrowserShim`: `atomicWriteFile(path, script, 'cache', { mode: 0o700 })`.
- `hermesArgv`'s default `write`: `atomicWriteFile(file, text, 'cache')` after its `mkdirSync`.
- Each reader already compares the text and rewrites: no reader changes.

**Tests that fail first** (one per module): `a write that fails part way leaves the old file`: the old script is still whole, where today it is empty. `browserShim.spec.ts` also: the shim is `0700` and was never on disk with fewer bytes than the script.

- [ ] Write the tests; run the three specs: red. Commit `test(state): launch files are written whole (red)`.
- [ ] Implement.
- [ ] Run the three specs, `src/lib/engineLaunch.windows.spec.ts`, and `npm run typecheck`: green.
- [ ] Commit `Launch files: the zsh startup file, the browser script and the Hermes boot file are written whole`.

### Task 17: Pointers, markers and the computer id

**Depends on:** 9, 10. **Effort:** `high`.

**Files:** Modify `cli/src/lib/runtimeInstall.ts`, `runtimeInstall.spec.ts`, `cli/src/lib/uninstall/deps.ts`, `uninstall/command.spec.ts`, `cli/src/lib/computerIdentity.ts`, `computerIdentity.spec.ts`.

**Interfaces:**
- `runtimeInstall.ts`: `current-<name>` and `.unrunnable` through `atomicWriteFile(…, 'cache')`; the archive write keeps `// not a state file: a one-shot download, unpacked and removed`.
- `uninstall/deps.ts` `markUninstalling`: `atomicWriteFile(marker, <seconds> + '\n', 'cache')`, still best effort.
- `readOrMintComputerId`: read with `readState(file, 'cache', parse)` where `parse` throws on blank text (a blank file is set aside, as it was replaced before); mint with `atomicWriteFile(file, id + '\n', 'cache', { exclusive: true })`; `false` reads the winner's. The second, in-place write goes.

**Tests that fail first:**
- `computerIdentity.spec.ts`: `two commands minting at once agree`: a second mint run from inside the first's publish; both return one id and the file holds it. `a blank id file is set aside and a new id minted`: `<file>.unreadable` exists.
- `runtimeInstall.spec.ts`: `a pointer write that fails leaves the old pointer`.
- `uninstall/command.spec.ts`: `the marker is written whole`.

- [ ] Write the tests; run the three specs: red. Commit `test(state): pointers and the computer id are written whole (red)`.
- [ ] Implement.
- [ ] Run the three specs and `npm run typecheck`: green.
- [ ] Commit `Runtime pointer, uninstall marker, computer id: written whole, the id published once`.

### Task 18: JSON caches

**Depends on:** 9, 10. **Effort:** `high`.

**Files:** Modify `cli/src/device/machineList.ts`, `machineList.spec.ts`, `cli/src/lib/hostTheme.ts`, `hostTheme.spec.ts`, `cli/src/lib/codexProfiles.ts`, `codexProfiles.test.ts`.

**Interfaces:**
- `MachineListCache`: `loadCache` through `readState(path, 'cache', jsonObject)`; `saveCache` through `atomicWriteFile(path, <today's string>, 'cache')`, still best effort.
- `loadHostTheme` through `readState(file, 'cache', jsonObject)` then `parseHostTheme`; `saveHostTheme` through `atomicWriteFile(file, JSON.stringify(theme, null, 2) + '\n', 'cache')`.
- `codexProfiles.ts`: its own `atomicWriteJson` goes; `writeLinkedPaths` calls the helper's with `'trust'`, which is the owner and mode check it makes today. `readLinkedPaths` is not changed here: Task 31 fixes it, in Part 3.

**Tests that fail first:** for the machine list and the theme, `a torn file is set aside, not written over` (`<name>.unreadable` holds the bytes after the next save; today they are gone) and `a save that fails part way leaves the old file`. For the Codex profiles, `the list is written by the shared helper`: the folder is flushed after the rename (today's copy never flushes it), and a group-writable old file is still refused.

- [ ] Write the tests; run the three specs: red. Commit `test(state): the machine list, the theme and the Codex profiles are never written over (red)`.
- [ ] Implement.
- [ ] Run the three specs and `npm run typecheck`: green.
- [ ] Commit `Machine list, host theme, Codex profiles: written whole through the one helper, and a cache that cannot be read is set aside`.

### Task 33: The registry lock is made with its owner in it

**Depends on:** 1 (it shares `lib/registryPersistence.ts` and `windows.yml`; done). It shares no file with Tasks 2 to 32 and runs beside them. **Effort:** `xhigh` (a lock between processes, on three platforms).

**Files:**
- Modify: `cli/src/lib/registryPersistence.ts` (`registryFileLock` only), `cli/src/lib/registryPersistence.spec.ts`, `cli/src/lib/registry.persistence.spec.ts` (the crash cases), `cli/src/lib/__fixtures__/registryCrashWriter.ts`
- Create: `cli/src/lib/registryLock.publish.spec.ts` (the real file system, no mocks)
- Modify: `.github/workflows/windows.yml` (add `'src/lib/registryLock.publish.spec.ts'` to the same `$paths` list as Task 1)

**Interfaces:** none new. `registryFileLock(directory, deadline, apply)` keeps its signature and every answer. What changes is how one turn of its loop takes the lock (Decision 16):
1. **Build.** `mkdir(<directory>/registry.json.lock.<pid>.<uuid>.tmp, 0o700)`; in it, `owner.json` opened `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW` at `0o600`, written with today's bytes, `sync`, closed. `check()` between the steps, as today.
2. **Look.** `lstat(lock)`: there means busy. The temporary folder is removed, and today's busy path runs unchanged (the wait, the ownerless rule, the dead-owner takeover).
3. **Publish.** `rename(temporary, lock)`. On success `identity = lstat(lock)`, then `checkOwner()` (the folder and the token), and the lock is held, as today after `mkdir`.
   - Refused while the lock is there (`EEXIST`, `ENOTEMPTY`; on Windows `EPERM` or `EACCES`, which refuse a folder renamed onto any folder): the temporary folder is removed, then the busy path.
   - Refused with no lock there, `EPERM`, `EACCES` or `EBUSY` (Windows: an antivirus or indexer holding the new folder for a moment): the temporary folder is removed and the loop turns again; `check()` bounds it at `LOCK_MS`. Any other error: removed, thrown.
   - On macOS and Linux a rename replaces an empty folder. This build never leaves one at the lock's path, so only an older build's folder made between steps 2 and 3 can be one. That build's own `O_EXCL` create of `owner.json` then fails with `EEXIST`, so it does not enter: there is still one owner. Windows refuses the rename, and that build's folder is waited for like any lock.
4. **Clean up.** The temporary folder is removed with `unlink(<temporary>/owner.json)` and `rmdir(temporary)`, best effort, never recursive (as `removeLockNow`). After a kill in steps 1 to 3, the temporary folder stays, as every temporary file does after a kill (Global Constraints). It blocks nobody.
- `removeOwned` and the `created` flag apply only once the rename has succeeded. The ownerless rule stays for the empty folders older builds can still leave.
- The comment says why: the lock that was there without its owner, from `master.e2e.ts` on Linux CI (run 44406838335, shard 7).

**Tests that fail first:**
- `registry.persistence.spec.ts`, the crash cases: phase `'ownerless'` becomes `'taking'`. `registryCrashWriter.ts` halts once the first `owner.json` it opens is open, before the write (`io.open` wrapped, wherever that file is). The writer is SIGKILLed and the lock is **not** aged: `registry.setClosePlan` commits at once and `rows()[0].title` is `null`. Fails today with `Registry persistence unavailable: registry lock is busy`: the empty lock waits `OWNERLESS_MS` (5 s), past `LOCK_MS` (2 s).
- `registry.persistence.spec.ts`, kept with today's behavior: `an older build's ownerless folder is still cleared`. An empty `registry.json.lock` (`0700`) is made by hand and aged 6 s; `setClosePlan` commits. The fixture no longer makes such a folder, so the ownerless rule needs this case.
- `registryPersistence.spec.ts` (`rename` joins the `node:fs/promises` wrapper, with an `interleave.rename` hook):
  - `a lock is never there without its owner`: at every `interleave.phase` and `interleave.rename` of one acquire, if `lock` exists then `owner.json` in it parses with `pid === process.pid` and a `token`. The violations are collected and asserted `[]` at the end, so the acquire itself is not disturbed. Fails today at the `mkdir` step.
  - `a writer stopped while it takes the lock does not hold it`: the first `open` of an `owner.json` never settles; a second `registryFileLock(directory, deadline(), apply)` runs `apply` and resolves. Fails today: `registry lock is busy`.
  - `a setup that fails leaves no lock and no temporary folder`: the owner write throws `ENOSPC`; the call throws; `readdirSync(directory)` has no `registry.json.lock*` entry.
  - `a publish refused for a moment with no lock there is tried again`: `rename` throws `EPERM` once; `apply` runs once; no temporary folder is left.
  - `an older build that makes its folder between the look and the publish does not enter` (`it.skipIf(win32)`): `interleave.rename` runs `mkdirSync(lock, { mode: 0o700 })` before the real rename; the acquire holds the lock; inside `apply`, `openSync(owner, 'wx', 0o600)` throws `EEXIST`.
  - Updated, not new: the three `does not publish after the deadline expires during owner %s` cases and `includes late owner publication in the two-second acquisition budget` key on the temporary folder and its `owner.json` (today they key on `lock` and `owner`, which this build no longer writes before the publish). Each ends with no lock and no temporary folder, `mkdir` included. Today's "conservative debris" line goes: no folder is made at the lock's path before its owner is in it.
- `registryLock.publish.spec.ts`, the real file system on every platform (on Windows through `windows.yml`). These pass today and pin the publish on each platform:
  - `an acquire and its release leave the folder as it was`: `readdirSync(directory)` is `[]` afterwards.
  - `a lock with a live owner is waited for, not replaced`: `registry.json.lock/owner.json` holds `{ pid: process.pid, startMarker: '', token: 'held' }`; `registryFileLock(directory, deadline(300), apply)` rejects with `registry lock is busy`; `apply` is not called; the owner's bytes are unchanged; no temporary folder is left.
  - `an empty lock folder is not replaced`: a fresh, empty `registry.json.lock`; the same rejection; the folder is still empty and its `ino` unchanged.

- [ ] Write the tests and the fixture's phase; run `cd cli && npx vitest run src/lib/registryPersistence.spec.ts src/lib/registry.persistence.spec.ts src/lib/registryLock.publish.spec.ts`: `taking`, `a lock is never there without its owner` and `a writer stopped while it takes the lock does not hold it` fail. Commit `test(state): the registry lock is made with its owner in it (red)`.
- [ ] Implement.
- [ ] Run the three specs, `src/lib/registry.spec.ts`, `src/lib/registry.diskFailure.spec.ts`, `src/lib/resumeAgentService.spec.ts`, `src/hookNotify.spec.ts`, `src/architecture.spec.ts`, `npx vitest run --config vitest.e2e.config.ts e2e/recovery.e2e.ts`, and `npm run typecheck`: green.
- [ ] Commit `Registry lock: made with its owner already in it, so a writer killed while taking it leaves no lock to wait for`.

### Task 19: The guard, part 2

**Depends on:** 11, 12, 14, 15, 16, 17, 18, 33. **Effort:** `medium`. **No red test:** a list grows; one commit. Task 33 adds no module to the list (see [The guard's module list](#the-guards-module-list)); it is here so Part 2 ends after it.

**Files:** Modify `cli/src/lib/stateWrites.guard.spec.ts` (add the Part 2 list to `STATE_MODULES`).

- [ ] Add the modules; run `npx vitest run src/lib/stateWrites.guard.spec.ts`: green. A hit is a write an earlier task missed: fix it in that module, in this commit.
- [ ] Commit `State files: the guard covers the pid file, the recaps, the hook credential and the launch files`.

---

## Part 3: the writers the sweep found, and their readers

Pull request 3, stacked on Part 2 (Decision 10). Table B's writers that are one file's text under a Harness folder, Table A's three, and the readers of the Part 3 files marked `E` (Decision 9), by area. **Each of Tasks 20 to 30 depends on Task 19; effort `high`; files are the modules named and their specs** (a module with none gets one beside it: `engines/cursor/pendingTasks.spec.ts`).

**The writer recipe, for every site:** the hand-written temporary file and rename (or the write in place) is deleted and replaced by one call: `atomicWriteJson(file, value, 'cache')` where today's bytes are `JSON.stringify(value, null, 2)`, else `atomicWriteFile(file, <today's exact bytes>, 'cache', { mode })`. `mode` is what the site passes today, `0600` when it passes none; a script keeps its `0700` or `0755`. A site that checks the old file with `hardenPrivateStateFileIfPresent` today passes `'trust'` and drops its own call. Folder creation and locks do not change.

**The reader recipe, for each reader the table names (Decision 9):** it reads through `readState(file, 'cache', parse)`, `parse` being the table's `jsonArray` or `jsonObject`. Today's per-row checks and defaults run on an `ok` value unchanged; `missing` answers what a missing file answers today. A check today's reader makes before it parses stays before `readState` (a size bound, an `existsSync`). The reader's own catch-all for a parse error goes, and so does its own line for one (`[goals] goals.json unreadable`): the cache line says it. An async reader calls `readState` as it is (Decision 14). A well-formed file of another version or shape reads as today. Every other reader in these modules stays.

**The tests that fail first, in each module's spec:**
1. `the file is flushed before it is renamed`: with `node:fs` wrapped, an `fsyncSync` of the temporary file comes before the `renameSync` onto the target. Fails today: no `fsync`.
2. For a site marked `N`: `a file at the old temporary name is left alone`: a file planted at today's temporary path still holds its bytes after a save.
3. For a write in place: `a write that fails part way leaves the old file`.
4. For each file in the readers column: `a torn <file> is set aside, not written over`: the file holds truncated JSON (`[{"` for a list, `{"` for an object); the module loads it, then saves through its own writer; `<file>.unreadable` holds the torn bytes, the file holds the save, and the line is `[state] <base> could not be read (not valid JSON); kept as <base>.unreadable, starting empty.` Fails today: the torn bytes are gone after the save, and no `.unreadable`.

| Task | Modules | Readers set aside (file, `parse`) | Notes |
|---|---|---|---|
| 20 Models and usage | `lib/appModels.ts`, `lib/localModels.ts`, `lib/gridModels.ts`, `lib/agentTokenUsage.ts`, `lib/sessionGitHistory.ts` | `readAppRecords` (`app-engines.json`, `jsonArray`); `readKnown` (`<grid>.known.json`, `jsonArray`); the entry's load in `sessionGitHistory.ts` (`session-git-history/<key>.json`, `jsonObject`, after its 512 KiB check) | `npm run test:local-models` stays at 100% |
| 21 Records the core reads | `lib/agentSettings.ts`, `lib/daemonRecord.ts`, `lib/hookRoutes.ts`, `lib/machineMcp.ts`, `lib/nodeMigration.ts`, `lib/gridConfigDir.ts`, `lib/apiInstructions.ts` | `readRecord` (`node-migration.json`, `jsonObject`) | all already in the core's process; `apiInstructions` keeps the file's own mode, else `0644` |
| 22 Update records, launchers, scripts | `lib/selfUpdate.ts` (`writeWhole` and `rejectedVersions` only), `lib/signOut.ts`, `lib/launchers.ts`, `tui/launcher.ts`, `lib/flash.ts`, `lib/connectors/agents.ts` (`mcp-shim.mjs` only) | `rejectedVersions` (`update-rejected.json`, `jsonArray`); `update-pending.json`'s reader stays | `hn` is created with `{ exclusive: true, mode: 0o755 }`; the bundle swap and the engines' config files stay (Table B) |
| 23 Windows pointers and records | `lib/windows/installLayout.ts`, `lib/windows/ptyInstall.ts` (`pty-*.json` only), `lib/windows/ptyUpdate.ts`, `lib/windows/cliVersions.ts` (`replaceFile` only) | `rejectedPtyVersions` in `ptyInstall.ts` (`pty-rejected.json`, `jsonArray`) | runs on Windows in `windows.yml` (`src/lib/windows` is in its list) |
| 24 Services | `services/windowNames.ts`, `services/agentCleanup.ts`, `services/sharedMachines.ts`, `services/goals.ts`, `services/agentBrowser/stateFile.ts` | `readJoined` (`agent-cleanup.json`, `jsonObject`); `readPolicy` (`shared-machines.json`, `jsonObject`; missing is `OFF`); `startGoals`'s `read` (`hachi/goals.json`, `jsonObject`) | `npm run test:core` stays at 100% |
| 25 Agent Messages | `messages/requestStore.ts`, `consentStore.ts`, `noticeStore.ts`, `rosterStore.ts`, `store.ts` | none: each already moves a broken file aside, with its own alert | each keeps its own move-aside and alert |
| 26 Sharing, projects, cloud | `sharing/collaboration.ts`, `sharing/grants.ts`, `orchestrator/service.ts` (the run file only), `cloud/service.ts` (the list only) | the start's load of `cloud/harnesses.json` (`jsonObject`) | `test:sharing` and `test:orchestrator` stay at 100% |
| 27 The Store | `dsh/installed.ts`, `dsh/viewerLedger.ts`, `dsh/catalog.ts` | `readInstalledIndex` (`installed.json`, `jsonArray`); `ViewerLedger.read` (`viewers.json`, `jsonArray`) | `test:portability` |
| 28 The dial | `cable/noticeFile.ts`, `cable/notifyMode.ts`, `cable/dialPortVerdicts.ts`, `cable/pets/store.ts` | `NoticeFile.load` (`dial-notices.json`, Decision 15: a `read` answer of `'json'` or `'unreadable'`, or a top-level value that is not an object, goes to `readState(file, 'cache', jsonObject)`; an `ok` answer is read again through `read`; `'long'`, `'version'` and `'shape'` are dropped as today, with today's line); `DialVerdicts`' constructor (`dial-ports.json`, `jsonObject`, after its `existsSync`); `loadMapping` (`pets.json`, `jsonObject`) | the pets' images are bytes: `atomicWriteFile` takes them |
| 29 Engines | `engines/cursor/pendingTasks.ts`, `engines/kit/windowsInstall.ts`, `engines/kit/messagesHook.ts`, `engines/kit/statusLine.ts`, `engines/kit/hookSettings.ts` (`harness.rules` only) | `read` in `pendingTasks.ts` (`cursor-pending-tasks.json`, `jsonArray`, under its lock as today) | `hook.mjs` keeps `0700` |
| 30 Agent client, usage, the Wi-Fi device | `agentClient/program.ts` (the list only), `agentClient/ledger.ts` (the rewrite only), `gateway/productUsage.ts`, `lib/autonomous-device/direct.ts` | `ProgramRecords.all` (`program-harnesses.json`, `jsonObject`); the collector's load in `productUsage.ts` (`product-usage/*.json`, `jsonObject`, after its `MAX_QUEUE_BYTES` check); the ledger's readers stay (Table B) | the lock files stay (Table A) |

Each task's steps: write the recipe's tests for its modules and see them fail; commit `test(state): <area> files are flushed, written whole and never written over (red)`; apply both recipes; run the modules' specs and `npm run typecheck`; commit `<Area>: state files are written through the helper, and one that cannot be read is set aside`.

### Task 31: The profile lists and the dial skill record: readers

**Depends on:** 19. **Effort:** `high`.

**Files:** Modify `cli/src/lib/codexProfiles.ts`, `codexProfiles.test.ts`, `cli/src/lib/claudeHomes.ts`, `cli/src/lib/claudeProfiles.test.ts`, `cli/src/devices/dialSkillFiles.ts`, `dialSkillFiles.spec.ts`.

**Interfaces:**
- `readLinkedPaths` in `codexProfiles.ts` (`codex-profiles.json`) and in `claudeHomes.ts` (`claude-profiles.json`): the owner check stays first, `hardenPrivateStateFileIfPresent(file, 1024 * 1024)` (owner, mode, size, no link, as `readPrivateStateFile` checks today); a throw from it is no list, as today, and nothing is set aside: a file another account could write is not this reader's to move, and the writer refuses it too. Then `readState(file, 'cache', jsonArray)`; an `ok` value is filtered as today; `missing` is the empty set.
- `dialSkillFiles.ts` `readJson` (`dial-skill.json` and `dial-setup.json`, Decision 15): within the bound, text that is not valid JSON or not a JSON object goes to `readState(file, 'cache', jsonObject)`, and its answer is used (`ok`: the value; else `undefined`). Past the bound, and a read error (`orUnread`'s `unread`: nothing is written from that read), as today.
- The writers do not change: `codexProfiles.ts`'s is Task 18's; `claudeProfiles.ts` and `dialSkillFiles.ts` keep their already-correct writers until the follow-up.

**Tests that fail first:**
- `codexProfiles.test.ts`: `a torn profile list is set aside, not written over`: `codex-profiles.json` holds `["/a`; `linkCodexProfile(folder)` succeeds; `codex-profiles.json.unreadable` holds the torn bytes and the list holds `folder`. Fails today: the torn bytes are gone. `a list another account could write is not set aside` (POSIX): mode `0o664`; the list reads as empty, no `.unreadable`, and the link is still refused as today.
- `claudeProfiles.test.ts`: the same two, with `claude-profiles.json` and `linkClaudeProfile`.
- `dialSkillFiles.spec.ts`: `a torn dial-skill.json is set aside, not written over`: the file holds `{"homes":`; `writePluginHomes(dir, [home])` answers `undefined`; `dial-skill.json.unreadable` holds the torn bytes; `readPluginHomes(dir)` is `{ homes: [home] }`. The same for `dial-setup.json` with `writeSetup`. `a file past the bound reads as today`: no `.unreadable`.

- [ ] Write the tests; run `npx vitest run src/lib/codexProfiles.test.ts src/lib/claudeProfiles.test.ts src/devices/dialSkillFiles.spec.ts`: the torn cases fail with the bytes gone. Commit `test(state): the profile lists and the dial skill record are never written over (red)`.
- [ ] Implement.
- [ ] Run the three specs, `src/devices/dialSkill.spec.ts`, `npx vitest run src/lib/stateWrites.guard.spec.ts`, and `npm run typecheck`: green.
- [ ] Commit `Profile lists, dial skill record: a file that cannot be read is set aside, not written over`.

### Task 32: The guard, part 3

**Depends on:** 20 to 30. **Effort:** `medium`. **No red test:** a list grows; one commit.

**Files:** Modify `cli/src/lib/stateWrites.guard.spec.ts`: add every module of Tasks 20 to 30. A write Table A or B leaves in one of them (a lock file, a one-shot file, the bundle swap, an engine's config) gets its `// not a state file: <why>` line in this commit.

- [ ] Add the modules and the marks; run the guard: green. Commit `State files: the guard covers every module that owns one`.

---

## Verification

No check runs against production, and none needs a sign-in: the end-to-end suite uses its fake backend. No temporary workflow: both long checks have a workflow that runs from a branch by hand. Run the two workflows one after the other, never together, each once, on the final head.

1. **Windows, on GitHub: `windows.yml`.** `gh workflow run windows.yml --ref fix/atomic-state-writes` (inputs left at their defaults, so the tests run). In each `windows-pty` job, the step "Contract suite against the real host, and the Windows CLI specs" runs `src/lib/secureState.spec.ts` (the real-Windows replace and exclusive cases must be run, not skipped), `src/lib/registryLock.publish.spec.ts` (a folder renamed onto the registry lock is refused, and the lock is untouched), `src/lib/windows` (the Hermes boot file; Part 3's pointers) and `src/lib/uninstall`. The install jobs then install with PowerShell, start the daemon, check it and uninstall: that is the atomic pid file, its claim and its removal on a real Windows. A person should see every job green; report the run link.
2. **The real daemon, on GitHub: `cli-e2e.yml`.** `gh workflow run cli-e2e.yml --ref fix/atomic-state-writes`. Eight Linux shards, throwaway homes, private tmux servers, fake engines. It runs the new `e2e/stateFiles.e2e.ts` and the suites that live on these files: `cli.e2e.ts`, `master.e2e.ts`, `twodaemons.e2e.ts`, `reexec.e2e.ts`, the update suites (pid file, handover), `recapsProcess.e2e.ts` and `recapsCompat.e2e.ts` (recap files), `relay.e2e.ts`, `p2p.e2e.ts`, `sharedMachines.e2e.ts`, `deviceAck.e2e.ts` (trust stores), `diskfull.e2e.ts`, and for the registry lock (Task 33) `recovery.e2e.ts` (a lock a crashed daemon left). `master.e2e.ts` is where the lock with no owner was seen (run 44406838335, shard 7). A person should see the summary green with every file run once; report the run link.
3. **macOS, on the developer's Mac** (no workflow runs the CLI there): `cd cli && npx vitest run src/lib/secureState.spec.ts src/lib/stateWrites.guard.spec.ts src/lib/registryLock.publish.spec.ts` and `npx vitest run --config vitest.e2e.config.ts e2e/stateFiles.e2e.ts`. The end-to-end harness isolates it (`e2e/harness/daemon.ts`: its own home, data folder, port and tmux server; never `~/.harness`, port 18473 or the person's tmux, `cli/AGENTS.md` rule 6). Both green, in about two minutes.
4. **The gates PR CI does not run, on the developer's machine:** from a clean tree at the final commit, `python3 scripts/local-checks.py --run`. It picks the gates by the paths changed: `test:core` (for `core/main.ts`), `test:harnessd` and `test:resume` for Parts 1 and 2; with Part 3 also `test:local-models`, `test:sharing`, `test:orchestrator` and `test:portability`. Paste its receipts into the pull request.
5. **The recap save's cost, on the developer's Mac:** Task 12's two sets of three lines, before and after, same machine. The pull request states the machine and both medians and p95s.
6. **PR CI** (automatic, once the pull request is ready): `cli-typecheck`, `cli-tests`, `pty-checks`, `companions`; the workflow file change reruns every component once.

Nothing here needs the user's own login or eye. Each pull request names macOS, Linux and Windows, and carries its red-then-green commits, the recap numbers, the receipts, the two run links and the already-correct list.
