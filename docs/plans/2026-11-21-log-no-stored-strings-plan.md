# Daemon logs: no stored strings, process output, peer text, paths or URLs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(cli): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message. A sweep task's red commit deletes its own pending list, so the guard fails on exactly its hits. A task with no red test is one commit. No task pushes or merges, and every task ends green.

**Goal:** Every daemon log line the audit listed, and every line the extended guard finds, prints a fixed word, a kind or code, a count, a length or a hash instead of a stored string, process output, a peer's text, a path or a URL; the guard keeps it so.

**Architecture:**
- **Two helpers in `cli/src/lib/log.ts`** beside `errorKind` (already in the core's process): `codeOrLength(value)` for a stored or peer string, `hashOf(text)` for a path, URL or label. One more export there, `exitOnFatal`, is the Windows master's fatal handler made reusable for every master and service process.
- **The guard (`cli/src/architecture.failureLogs.spec.ts`) grows five rules**, syntactic as today: an error's stored fields, name rules for process output, free text and paths/URLs, two exclusions in one place each, a file's own function's result, and `testing/`. It lands with a pending list per sweep task, each task deletes its own, the last task deletes the mechanism.
- **A hold keeps its sentence in the log** (spec decision 4): `HookPreparationHeld`'s fixed words move to a field no rule reads, `hold`, and a spec of their own, `architecture.hookHolds.spec.ts` (Task 9), fails when any hold is built from anything but string literals.
- **The sweep is nineteen tasks by area**, no file shared, each red on the guard for its own files and on behaviour tests for the lines the guard cannot see. Two more follow: the end-to-end expectations, and the guard without its lists.

**Tech Stack:** TypeScript (Node 24), vitest, the TypeScript compiler API for the guard. No new dependency.

**Spec:** `docs/plans/2026-11-21-log-no-stored-strings-design.md` (its Decisions section binds this plan). Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md`, and the previous sweep's plan, `docs/plans/2026-11-19-log-failure-kinds-plan.md`, whose pending-list mechanism this plan reuses.

## Base

- `fix/log-no-stored-strings` at `9281024a97` (= `main`). The spec and this plan are untracked; the main session commits them, no task does.
- Line numbers are the base's, re-read for this plan. A task follows the expression it names when a line has moved, and says so in its report.
- `node_modules` is installed in `cli/`. Every command below runs from `cli/`.

## Tasks at a glance

| Task | Area (files in the task) | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 Helpers | `lib/log.ts` | none | medium | `lib/log.spec.ts` |
| 2 The guard and its pending lists | `architecture.failureLogs.spec.ts`, `architecture.failureLogs.pending/` | none | xhigh | the guard on today's tree |
| 3 The master and the service processes | `masterProcess.ts`, `serviceProcess.ts`, `lib/nodeReferences.ts`, `lib/launchers.ts`, `lib/log.ts` (`exitOnFatal`) | 1, 2 | xhigh | guard (`master.txt`); fatal and path tests |
| 4 harnessd | `harnessd/leanServices.ts`, `master.ts`, `reexec.ts`, `supervisor.ts` | 1, 2 | high | guard (`harnessd.txt`); `supervisor.spec.ts` |
| 5 Core: agents | `core/agents/fork.ts`, `launch.ts`, `newPane.ts`, `retarget.ts`, `discovery.ts`, `lib/terminalAgentReconciler.ts` | 1, 2 | high | guard (`core-agents.txt`); `newPane.spec.ts` |
| 6 Core: wiring, engines, turns | `core/main.ts`, `core/connectorsLink.ts`, `core/engines/hooks.ts`, `core/engines/homeAdoptions.ts`, `core/turns/funnel.ts`, `lib/daemonSafeMode.ts`, `testing/launchShapes.ts` | 1, 2 | high | guard (`core-wiring.txt`); three behaviour tests |
| 7 The hook door | `hookServer.ts` | 1, 2 | high | guard (`hook-door.txt`); `hookServer.spec.ts` |
| 8 The relay and peer to peer | `gateway/upstream.ts`, `gateway/start.ts`, `lib/remoteRelay.ts`, `lib/terminalP2p.ts` | 1, 2 | xhigh | guard (`relay.txt`); `terminalP2p.spec.ts`, `upstream.spec.ts` |
| 9 Engine hooks, their holds, creating an agent, and the e2e hook check | `engines/kit/hookReview.ts`, `hookSettings.ts`, `hookHeld.ts`, `notifyHooks.ts`, `hookRemoval.ts`, `hookRemovalOutcome.ts`, `nativeHookSettings.ts`, `nativeHookYaml.ts`, `nativePlugin.ts`, `engines/nativeHooks.ts`, `nativeLaunch.ts`, `removeHooks.ts`, `lib/uninstall/deps.ts`, `engines/facets/hooks.ts`, `engines/claude/hookContract.ts`, `engines/codex/hookContract.ts`, `core/agents/create.ts`, `architecture.hookHolds.spec.ts` (new), `e2e/harness/daemon.ts`, `e2e/homeMove.e2e.ts`, `testing/hookFilesNamed.spec.ts` (new) | 1, 2 | xhigh | guard (`engine-hooks.txt`); `architecture.hookHolds.spec.ts`; sentinel-home tests; `create.spec.ts` |
| 10 Engine launch and transcripts | `engines/kit/launchExecutable.ts`, `resumeRepair.ts`, `transcriptDiscovery.ts`, `engines/launchPrep.ts`, `engines/facets/launch.ts`, `engines/codex/launch.ts` | 1, 2 | high | guard (`engine-launch.txt`) |
| 11 Moves | `lib/hostMove/moveAgent.ts`, `mover.ts`, `core/agents/hostMove.ts` | 1, 2 | high | guard (`moves.txt`); `hostMove.spec.ts` |
| 12 Agent services | `lib/deleteAgentFallback.ts`, `closeAgentService.ts`, `resumeAgentService.ts`, `restartAgent.ts`, `createAgentPane.ts`, `launchOverrides.ts`, `cwdRepair.ts`, `gitProject.ts` | 1, 2 | high | guard (`agent-services.txt`); three behaviour tests |
| 13 Restore and the registry | `lib/restoreAgents.ts`, `core/agents/heldLaunches.ts`, `lib/registry.ts` | 1, 2 | high | guard (`restore.txt`); `heldLaunches.spec.ts`, registry test |
| 14 Terminal hosts and streams | `lib/ptyHostBackend.ts`, `lib/tmuxBackend.ts`, `lib/terminalStreamManager.ts` | 1, 2 | high | guard (`terminals.txt`); stream diagnostics test |
| 15 Updates and install | `lib/selfUpdate.ts`, `lib/runtimeInstall.ts`, `lib/gridWindowsPin.ts`, `config/env.ts`, `lib/secureState.ts`, `lib/openclawStore.ts` | 1, 2 | high | guard (`updates.txt`); `runtimeInstall.spec.ts` |
| 16 Windows | `lib/windows/ptyUpdate.ts`, `lib/windows/dataFolderClaim.ts` | 1, 2 | high | guard (`windows.txt`) |
| 17 Dials | `cable/serial.ts`, `cableFleet.ts`, `cableSession.ts`, `cableHost.ts`, `windowsSerial.ts`, `engineTally.ts` | 1, 2 | high | guard (`dials.txt`); `cableSession.spec.ts` |
| 18 Devices | `services/devices.ts`, `services/devicesListener.ts`, `device/deviceLink.ts`, `cable/hosts/vscodeTerminals.ts` | 1 | high | three behaviour tests |
| 19 The agent browser | `services/agentBrowser.ts`, `agentBrowserProcess.ts`, `agentBrowser/streams.ts`, `agentBrowser/notices.ts` | 1, 2 | high | guard (`agent-browser.txt`); three behaviour tests |
| 20 Services | `services/followLink.ts`, `hachi.ts`, `sharedMachines.ts`, `agentCleanup.ts`, `models.ts`, `osDevice.ts`, `lib/gridAttach.ts` | 1, 2 | high | guard (`services.txt`); two behaviour tests |
| 21 Edges | `orchestrator/service.ts`, `dsh/service.ts`, `dsh/viewer.ts`, `watcher/watcher.ts`, `lib/autonomous-device/dump.ts`, `lib/connectors/renew.ts`, `lib/e2ee/deviceLogSyncer.ts`, `lib/machineMcp.ts`, `lib/notifyTier.ts` | 1, 2 | high | guard (`edges.txt`); three behaviour tests |
| 22 End-to-end expectations | `e2e/lean.e2e.ts`, `e2e/hermesAdmission.e2e.ts` | 3, 4, 7 | high | none committed: test code only, one commit |
| 23 The guard keeps no pending list | `architecture.failureLogs.spec.ts`, specs reported `cross-area` | 3 to 21 | medium | none: test code only, one commit |

Every path is under `cli/src/` unless it starts with `e2e/` (under `cli/`). Specs sit beside the files they test and belong to that file's task.

**Longest chain:** three tasks (1 or 2 → 3, 4 or 7 → 22; or 1 or 2 → any of 3 to 21 → 23).

- Tasks 1 and 2 share no file and start at once. Tasks 3 to 21 share no file with each other.
- Files shared by two tasks are shared only along a dependency: Task 1 and Task 3 both edit `lib/log.ts` (3 after 1); Task 2 creates the pending lists and Tasks 3 to 21 each delete their own; Task 23 edits Task 2's spec after them.
- Task 18 has no pending list (the guard finds none of its lines), so it waits on Task 1 alone.
- `core/agents/create.ts` is Task 9's, not Task 5's: its line 302 reads a hold's field, which Task 9 renames, so the rename and every reader of it land in one task (no file in two tasks).

## Global Constraints

- **Log text only.** Errors, replies and text returned to clients or shown to the person (`error`, `detail`, a notice, a hold reason, `terminal_closed.reason`, a launch record) do not change. No log line gains a field beyond the kind, code, count, length or hash that replaces content.
- **One way per kind of content** (spec, "What a line logs instead"): an error is `errorKind(error)`; a stored or peer string is `codeOrLength(value)`; a path, URL or person-chosen label is dropped, a fixed word, or `hashOf(text)`; process output is its byte length or line count with the exit code or signal. A literal union of fixed words in its type stays as it is.
- **Never a preview**: no `slice`, `basename`, first word or first line of content, and no new local made only to carry content past the guard.
- **Lines other code reads keep their tokens** (see "Readers of changed lines").
- **No new file in the core's process**: the helpers go in `lib/log.ts`; `architecture.coreFiles.txt` is not edited.
- **Coverage stays 100% per file** for `src/core/`, `src/services/`, `src/harnessd/`, `src/orchestrator/`, `lib/resumeAgentService.ts`: a deleted branch takes its now-idle expectation with it, never the case; a new branch gets its case.
- **A test never reads the developer's own machine** (cli/AGENTS.md rule 6): sentinels live in a temporary folder or are plain strings.
- **Comments say why.** A comment that says a line prints a path or "fixed words" (`hookHeld.ts`, `nativeHookSettings.ts`, `facets/hooks.ts`) stays true or goes.
- **Platforms the pull request names:** the CLI daemon on macOS, Linux and Windows, the same on each.

## The helpers (Task 1)

`codeOrLength(value: unknown): string` — never throws:

| Value | Returns |
|---|---|
| a string shaped as a code, `/^[A-Z][A-Z0-9_]{1,39}$/` (the `CODE` `errorKind` already trusts) | the string |
| any other string | `text(<length>)` |
| anything else | `typeof value` (`null` is `object`) |

`hashOf(text: string): string` — the first 8 hex of the text's SHA-256, as `sid` hashes an OpenClaw key.

**Named here, not `codeOf`:** `codeOf` is already a local in `homeMove/stage.ts`, `devices/dialSkillFiles.ts` and `lib/windows/ptyInstall.ts`, each returning an error's unchecked `code`; the guard reads a safe helper by its name, so that name would trust them.

`exitOnFatal(tag: string, fd: number, on = (event, listener) => process.on(event, listener), exit = (code) => process.exit(code)): void` (Task 3) — `writeFatalTo`'s body, moved: on `uncaughtException` it writes `` `${ts()} ${tag} stopped on an uncaught error: ${errorKind(error)}\n` `` to [fd] with `writeSync`, on `unhandledRejection` `… stopped on an unhandled rejection: …`, then `exit(1)`; a write that throws loses the line, never the exit.

## What the guard finds, as built (Task 2)

The prototype that settled these rules ran over the base (a scratch copy of the guard, not committed). Each rule's exact form:

1. **An error's stored fields.** `ERROR_WORDS = ['message', 'stack', 'reason', 'detail', 'stderr', 'stdout', 'path']`, read off an error anywhere in a log call, as `.message` and `.stack` are today.
2. **Name rules, of any value, printed whole** (an argument, a template part, a sum or branch operand, an object's value, an array element, an argument handed to a function, and the receiver of a method call: `stream.stderr.trim()`, spec decision 6). A name, as an identifier or a property read's last name:
   - process output: `/^(stderr|stdout|output)$|(Stderr|Stdout|Output)$/`
   - free text: `/^(detail|details|message)$|(Detail|Message)$/`
   - a path or URL: `/^(path|cwd|dir|folder|file|home|url)$|(Path|Cwd|Dir|Folder|File|Home|Url|URL)$/`

   Not found: a name an `import` binds (`path.sep` of `node:path`); a read of `.length` or `.size` (of anything, an error's words included: a number); `typeof`; a comparison; a value handed to `errorKind`, `codeOrLength`, `hashOf`, `sid`, `serialPortName`, `Number`, `Boolean` or `Buffer.byteLength`. Any other function's argument is printed whole, in a condition too (`existsSync(file) ? …` is found), as an error is today. The name lists are the spec's, unchanged: each finds content somewhere on the tree, and their false hits (a fixed sentence in `detail`, a contract's fixed name under `file`, a boolean `noPath`) are renamed at their site.
3. **The two exclusions, each in one place.** `serialPortName` (Task 17, `cable/serial.ts`) is the one function that passes a serial port's name; `port.path` by its spelling is a finding. A bare identifier that is a whole argument of the log call and a plain parameter (not destructured) of the log call's nearest enclosing function is no name finding: `(message) => console.log(message)`, `log: (line) => deps.log(line)`. Used in any other way (`` (detail) => log(`… ${detail}`) ``, `preview(message)`) it is found where it is logged, and its callers are checked through the guard's forwarding as today.
4. **A file's own function's result.** A property read `x.p` printed whole, where `x` is a `const` or `let` whose values (its initializer and, for a `let`, each later assignment) are, through `await`, a call of a function of the file's own (`calleeOf`), or an object literal: the function's return values (its `return` statements outside nested functions, or an arrow's body), through `await`, `?:`, `??` and `||`, to an object literal's `p` (assigned or shorthand), are read as the log call's own arguments, by every rule above. A function that calls itself is read once.
5. **`testing/` is scanned** like the rest of `cli/src` but its specs. One hit there (`testing/launchShapes.ts:62`, a catch that binds nothing), fixed by Task 6: no list beside `TERMINAL` is needed.

**`TERMINAL` gains two files**, each printing only its command's own output: `dsh/command.ts` (harness dsh; the spec's decision 3) and `agentClient/mcpServers.ts` (harness mcp-servers, imported by `cli.ts` alone).

**Measured on the base** (this machine, the guard's tree scan alone): 1.57 s with today's rules, 1.62 to 1.90 s with these; the spec's `tests` time today is 1.60 to 1.79 s. Task 2 measures the spec run before and after.

### The guard's hits on the base: 133 in 64 files

Grouped by the pending list (and task) that owns them. `*` = found only through the method-receiver reading (spec decision 6).

| List (task) | Hits | Files and lines |
|---|---|---|
| `master.txt` (3) | 8 | `masterProcess.ts` 422 431 443 448 452 460; `lib/nodeReferences.ts` 44 45 |
| `harnessd.txt` (4) | 5 | `harnessd/leanServices.ts` 78 96; `harnessd/master.ts` 322; `harnessd/reexec.ts` 427 617 |
| `core-agents.txt` (5) | 6 | `core/agents/fork.ts` 176; `launch.ts` 143; `newPane.ts` 183 212; `retarget.ts` 277 319 |
| `core-wiring.txt` (6) | 3 | `core/main.ts` 3208; `core/turns/funnel.ts` 230; `testing/launchShapes.ts` 62 |
| `hook-door.txt` (7) | 4 | `hookServer.ts` 498* 883 948 1188 |
| `relay.txt` (8) | 2 | `gateway/upstream.ts` 196; `lib/remoteRelay.ts` 1058 |
| `engine-hooks.txt` (9) | 27 | `core/agents/create.ts` 185 216 227 255 283 302 345; `engines/kit/hookReview.ts` 246 266; `hookSettings.ts` 73 74 123 127 135; `nativeHookSettings.ts` 100 101; `nativeHookYaml.ts` 262 388 422 433 447 453 462; `nativePlugin.ts` 55 86; `engines/nativeHooks.ts` 198; `engines/nativeLaunch.ts` 297 |
| `engine-launch.txt` (10) | 4 | `engines/kit/launchExecutable.ts` 181; `resumeRepair.ts` 276; `transcriptDiscovery.ts` 47; `engines/launchPrep.ts` 45 |
| `moves.txt` (11) | 7 | `lib/hostMove/moveAgent.ts` 268 282 379 389; `mover.ts` 118 121; `core/agents/hostMove.ts` 169 |
| `agent-services.txt` (12) | 11 | `lib/deleteAgentFallback.ts` 89 131; `closeAgentService.ts` 277; `resumeAgentService.ts` 203; `launchOverrides.ts` 317; `cwdRepair.ts` 45 72 82 94; `gitProject.ts` 382 386 |
| `restore.txt` (13) | 5 | `lib/restoreAgents.ts` 672 811 823 853 889 |
| `terminals.txt` (14) | 2 | `lib/ptyHostBackend.ts` 545; `lib/tmuxBackend.ts` 239 |
| `updates.txt` (15) | 9 | `lib/selfUpdate.ts` 838 845 848 901; `config/env.ts` 114 116; `lib/secureState.ts` 596; `lib/openclawStore.ts` 74; `lib/gridWindowsPin.ts` 40 |
| `windows.txt` (16) | 7 | `lib/windows/ptyUpdate.ts` 179 212 219 224 247; `lib/windows/dataFolderClaim.ts` 164 175 |
| `dials.txt` (17) | 17 | `cable/cableFleet.ts` 177 230 246 271 347 351 373 420 430; `cableSession.ts` 1080 1254; `cableHost.ts` 439 442 488 1141; `windowsSerial.ts` 171; `engineTally.ts` 18* |
| `agent-browser.txt` (19) | 2 | `services/agentBrowser/streams.ts` 138 151* |
| `services.txt` (20) | 6 | `services/agentCleanup.ts` 154; `models.ts` 93; `osDevice.ts` 166; `sharedMachines.ts` 260; `lib/gridAttach.ts` 166 177 |
| `edges.txt` (21) | 8 | `dsh/service.ts` 57 60; `watcher/watcher.ts` 165; `lib/autonomous-device/dump.ts` 56; `lib/connectors/renew.ts` 33; `lib/e2ee/deviceLogSyncer.ts` 999; `lib/machineMcp.ts` 186*; `lib/notifyTier.ts` 34 |

**Appendix lines the guard does not find** (each gets a behaviour test in its task, or is confirmed fixed below): `lib/gitProject.ts:466`, `core/agents/newPane.ts:215`, the ten peer strings of appendix section 3, and in section 4 `backendSocket.ts:1070`, `hookServer.ts:748, 982`, `masterProcess.ts:418`, `core/main.ts:3463`, `lib/createAgentPane.ts:157`, `lib/restartAgent.ts:197`, `lib/restoreAgents.ts:622, 730`, `lib/runtimeInstall.ts:371`, `lib/selfUpdate.ts:810`, `lib/tmuxBackend.ts:234, 253`, `lib/registry.ts:1642, 1645`, `lib/hostMove/mover.ts:153`, `lib/ptyHostBackend.ts:318`, `core/agents/hostMove.ts:116`, `core/agents/heldLaunches.ts:126`, `core/agents/discovery.ts:371, 375, 390, 395`, `core/engines/hooks.ts:339`, `orchestrator/service.ts:445`, `services/devices.ts:2224`, `services/devicesListener.ts:644`, `cable/hosts/vscodeTerminals.ts:322`, `services/agentBrowser/notices.ts:175`, `dsh/viewer.ts:207`, `lib/windows/ptyUpdate.ts:150`; in section 5 `engines/kit/nativeHookSettings.ts:93`, `engines/kit/nativePlugin.ts:43`, `lib/runtimeInstall.ts:279`.

## The pending lists (how the guard stays green between landings)

- **Where:** `cli/src/architecture.failureLogs.pending/<list>.txt`, the eighteen lists above, one line a file: `<path from cli/src> <hits>`. Paths are listed one by one, no pattern: a list is exactly its task's files.
- **What the guard does with them:** a listed file is excused exactly that many hits; one more or one fewer fails, naming the list and the line. The tree scan then must be `[]`. Two cases test the mechanism: `a pending line excuses its file's hits and no more` (a planted file of two hits: `2` passes, `1` and `3` fail) and `every pending line names a file with exactly that many hits`.
- **Red, green, gone:** Task 2 lands the rules red (the tree scan fails with the 133 hits), then green with the lists. Each sweep task's red commit deletes its own list, so the guard fails on exactly that task's hits and no other task's, while every other list still excuses its files; its green commit fixes them. No two sweep tasks touch the same list or the same source file, so they run at once. Task 23 removes the mechanism whole (code, cases, folder, every comment naming it, the header's sentence) and proves it with a grep: nothing temporary survives.
- The code that reads the lists is a few lines of its own, named so that Task 23 can prove it gone: the folder's constant is `PENDING_LISTS`, the function that reads it `pendingExcuses`, its comment says `pending lists` and that Task 23 deletes them, its two cases' names hold `pending line`, and the header says it in one sentence holding `pending lists`. Nothing else in the spec uses those words.
- **The base count stays 133 with the hold kept:** the eleven lines that print a `HookPreparationHeld`'s `reason` (spec decision 4) are found on the base by rule 1, so the guard stays their red test; Task 9 makes them print `hold`, which no rule reads. `core/agents/create.ts`'s seven hits move from `core-agents.txt` to `engine-hooks.txt` with the file.

## How a line changes

**Source or line.** A value whose only readers are log lines is fixed where it is made: its error's words become `errorKind(error)`, its output its byte length. A value that also reaches a reply, a record, a client, a file or a metric stays as it is, and the log line prints `codeOrLength`/`hashOf` of it. Each task's table names which, and the implementer confirms the readers with a search before choosing: a reader the table missed moves the change to the line, and goes in the report.

**A name the rules find that holds no content** (a fixed sentence in a local named `detail`, a contract's fixed file name under `file`, a boolean `noPath`) is renamed at its declaration, or the line prints the code beside it. Never a local made only to pass the guard; a local holding a value that is not content (a version) is fine, with a comment.

| Today | Becomes |
|---|---|
| `` `… refused · ${refusal.detail}` `` (a result with a code) | `` `… refused · ${codeOrLength(refusal.error)}` `` |
| `` `… ${result.detail ?? result.error}` `` | `` `… ${codeOrLength(result.error)}` `` |
| `` `… (${answer.error})` `` (a peer's or the backend's) | `` `… (${codeOrLength(answer.error)})` `` |
| `` `… · ${home}` ``, `` `… → ${this.url}` ``, `` `… ${name}` `` (a person-chosen label) | `` `… · ${hashOf(home)}` `` |
| `` `… ${cwd} → ${folder}` ``, `` `… in ${adapterDataDir}` `` | fixed words for what it is: `the agent's folder`, `the data folder` |
| `` `… (${probed.detail})` `` (a probe's last stderr line) | `(exit 5)`, `(signal SIGKILL)`, `(TypeError)`, with `· stderr <n> B` when it printed |
| `` `… ${error.reason}` `` (a typed error's stored words) | `` `… ${errorKind(error)}` ``; a `HookPreparationHeld`'s fixed sentence is `error.hold` instead (Task 9) |
| `` `… ${port.path}` `` (a serial port) | `` `… ${serialPortName(port.path)}` ``, the same text |

- **The line keeps** its tag, its words, its separator, its ids (`sid`), counts, codes and states.
- **Import** `codeOrLength`, `hashOf` from `lib/log.js` (extend the import where `errorKind` comes from).

## The behaviour test

For a line the guard cannot see, in the spec beside the file that logs it: spy the logger the line uses (`vi.spyOn(console, 'warn')`, or the injected `log`), drive the path with sentinel content (a peer answer `{ error: 'peer said /Users/sentinel/x' }`, a probe whose stderr is `'boom /Users/sentinel/x'`, a home under a temporary folder named `sentinel-…`), then:

```ts
const lines = spy.mock.calls.map((call) => call.map(String).join(' ')).join('\n')
expect(lines).not.toContain('sentinel')
expect(lines).toContain('<the line with its code, kind, count or hash>')
```

A line whose value is a literal union of fixed words in its type keeps it; its pin test asserts the line with one of those words and passes before and after (marked "pin" below).

## Readers of changed lines

| Marker | Reader | Changed line | Kept |
|---|---|---|---|
| `[backend] connected` | `lib/daemonLaunch.ts:118` (`harness start`'s readiness) | `gateway/upstream.ts:196` | yes: `[backend] connected · <hash>` |
| `[hooks] listening on 127.0.0.1:<port> (` | `e2e/harness/daemon.ts` `listeningPort` | `hookServer.ts:1175` unchanged; `:1188` becomes `[hooks] listening on the private socket`, which the reader's pattern does not match | yes |
| `[harnessd] services run from (\S+), as this master does` | `e2e/lean.e2e.ts` 97, 140, 173, 182, 191, 207, 284 | `harnessd/master.ts:322` | text changes; Task 22 reads the lean path from the master's command line instead |
| `the lean bundle … cannot be used (it is gone)`, `died 2 times … from now on`, `did not answer its probe (exit 5)`, `lean-off is there: …` | `e2e/lean.e2e.ts` 148, 149, 169, 218, 283 | `harnessd/leanServices.ts:78, 96`, `masterProcess.ts:422, 448` | Task 22 rewrites them to the texts Tasks 3 and 4 pin |
| `held · Hermes session source is unavailable` | `e2e/hermesAdmission.e2e.ts:66` | `hookServer.ts:748` | Task 22 waits on the agent row's hold instead |
| `[hooks] … → /path`, `unchanged: /path`, `updated … in /path` | `e2e/harness/daemon.ts` `hookFilesNamed`, the hooks-stayed-inside check after every e2e daemon, and `e2e/homeMove.e2e.ts:103` | every hook install line (Task 9) | the lines name the file by `hashOf`; Task 9 changes the check to hashes (spec decision 6) |
| `[hooks] home adoption held` | `e2e/enginehomes.e2e.ts:90` | `core/engines/hooks.ts:339` | yes: only what follows ` · ` changes |
| `retained · engine process absent` | `e2e/core.e2e.ts:96` | `core/agents/discovery.ts:371` | yes: unchanged (fixed words, Task 5 pins their type) |
| `[watcher] tail <engine> <id8>` | `e2e/otherEngines.e2e.ts:99` | `watcher/watcher.ts:165` | yes: the path after it goes |
| `cable: open on <port> [usb …]`, `[devices] vscode stream · ended · gone · windows 0`, `[cable] notify · silent · rule:notice · notice · 0ms`, `[update] 43.0.3 does not match its manifest (DigestMismatchError)` | `e2e/devicesProcess.e2e.ts:326`, `dialVscode.e2e.ts:311, 521`, `deviceNotify.e2e.ts:174`, `updateHostile.e2e.ts:370` | `cableSession.ts:1254`, `vscodeTerminals.ts:322`, `notifyTier.ts:34`, `selfUpdate.ts:810` | yes: same text |

## Confirmed fixed, no change

Each "not traced" item of the spec's appendix, decided by its call sites:

- `harnessd/supervisor.ts` 392, 521, 626: `reason`/`why` are fixed words of the file (`the core asked to stop (harness stop)`, the memory sentences, `crashed`/`update`/`memory`/`hung`). Its line 482 is not: Task 4.
- `harnessd/serviceSupervisor.ts:234, 241`: `this.killReason ?? 'crashed'`, set only to `'memory'` and `'hung'`.
- `cable/cableHost.ts` `open (reason)` (1093): `OpenReason = 'question'`, a literal union.
- `cable/engineTally.ts`: its `reason` is the setups' literal unions (`VscodeFailure`, Orca's `'not-running' | 'old' | …`) and fixed words; only its `e` parameter is renamed (Task 17, the method-receiver rule).
- `lib/restoreAgents.ts:592`: `'grid agent; credential not persisted'`, a literal.
- `backendSocket.ts:1070`: `verdict.error` is `'GUEST_NOT_ALLOWED' | 'NOT_YOUR_HARNESS'` in its type.
- `gateway/gateway.ts:1050` and `lib/remoteRelay.ts:1058, 1236` print a reason that can be a peer's (`p2p_abort`): fixed at its intake by Task 8, so the lines stay.
- `lib/notifyTier.ts:34`: every caller passes a fixed rule name; the parameter is renamed (Task 21).
- `engines/kit/resumeRepair.ts:276`: `contract.names.file` is the label `'Codex rollout'`; the property is renamed (Task 10).
- `lib/runtimeInstall.ts`, `lib/nodeReferences.ts`, `lib/gridAttach.ts`, `lib/gridWindowsPin.ts` are daemon log, so they follow the rule: `runtimeInstall` runs in the updater (`services/updaterProcess.ts:160`, `[update]`) and the models service (`services/models.ts:73, 90`, `[grid-runtime]`), as well as `harness start`; `nodeReferences` and `launchers` in the master (`masterProcess.ts`); `gridAttach` in the models service and the core (`core/modelsLink.ts`); `gridWindowsPin` through `runtimeInstall`.
- `cable/cableFleet.ts` and `cable/cableSession.ts`'s serial port lines keep the port's name, through `serialPortName` (spec decision; the 2026-11-19 sweep's answer 5).

## Decided here, where the spec left it to the builder

- **The helpers are `codeOrLength` and `hashOf`**; the fatal handler is `exitOnFatal`, in `lib/log.ts`, where `ts` and `errorKind` already are, which the master and every lean process load: no new chunk and no new file.
- **`serialPortName(path: string): string`** returns its argument unchanged, in `cable/serial.ts`, which both port files import; its comment carries the decision and its dates.
- **Rule 4 reads only a property printed whole**: read in a condition or deeper (`ask.session.engine`), the prototype found one false hit and no real one.
- **Probe results say how the probe ended**, never what it printed: `masterProcess.ts` `probeLean` and `harnessd/reexec.ts` `runProbe` (whose result only these log lines read) give `exit <n>`, `signal <s>` or the spawn error's kind, and `· stderr <n> B` when the probe wrote to stderr; their field `detail` is renamed `ended`.
- **A peer's `p2p_abort` reason is not kept** (`lib/terminalP2p.ts:427, 619, 630`): those calls pass `'peer_aborted'`. It reached the three `[p2p]`/`[terminal-p2p]` log lines and the backend metric `reportP2pResult` sends (`reason.slice(0, 64)`, AGENTS.md rule 8), and nothing a person sees; the peer logs its own reason on its own side.
- **Terminal-stream diagnostics** (`lib/terminalStreamManager.ts`, printed whole by `core/main.ts:1264`): every `reason` field goes through `codeOrLength` (the close reason is shown to the person in Desktop, so it cannot change at its source), the two errors become `kind: errorKind(error)`, and `takenBy` (a client's name, chosen by a person) becomes `hashOf(name)`. The cost: a fixed close reason (`heartbeat timeout`) reads `text(17)`; the event, its counters and ids stay.
- **Same cause beyond the appendix and the guard, fixed in their tasks:** `harnessd/supervisor.ts:482` (a core's safe-mode reason, an error's words), `masterProcess.ts` `node`/`own`/`missing` (paths through `fromBundle`), `lib/launchers.ts:47` (paths, from the master), `engines/kit/hookSettings.ts:74-76, 228-229`, `engines/nativeHooks.ts:97` (`{file}` and `{script}` filled with paths), `core/agents/create.ts:254` (the materializer's warnings name a template's folder), `hookServer.ts:498`'s host and origin (a refused page's URL), the `negotiationDetail` peer SDP words (`lib/terminalP2p.ts:325`).
- **A hold's sentence** (spec decision 4, Task 9): `HookPreparationHeld.reason` is renamed `hold`, which no guard rule reads, and every reader prints `error instanceof HookPreparationHeld ? error.hold : errorKind(error)`. The four holds on the base built from anything but string literals become literals at their source: `notifyHooks.ts:119`'s `refuse` goes and its eight callers throw `new HookPreparationHeld('a hook argument …')` with today's words, so the lines Windows' specs read do not change; `HookScriptMissing` takes no argument (`notify.mjs is missing, so no hook of Harness's could run`), so `notifyHooks.ts:55` throws `new HookScriptMissing()` and the readers' `HookScriptMissing` exception goes; `hookRemoval.ts:49` throws one literal per branch (`the hooks member is not an object`, today's text for `nested` and `entries`, and `the hook block's member is not an object` for `named`, whose block is a contract's fixed name). The person still sees notify.mjs's path where a held create or resume says why: that detail is `engines/kit/hooksHeldDetail.ts`'s, from `missingHookScript`, unchanged. `architecture.hookHolds.spec.ts` lives beside the other tree scans (not a kit spec: it reads the whole of `cli/src`, as `architecture.failureLogs.spec.ts` does, but in a file of its own so that it is Task 9's alone).
- **Left as they are:** `lib/secureState.ts:571, 584` name a state file by `basename`, which is a name Harness's own modules give their state files and which the guard does not find; `:596`, which it finds, takes `hashOf(file)`.

## Review Focus

1. **A peer's abort reason with a person's words**: never in the daemon's log or the p2p metric; Harness's own reasons still are. Task 8, `a peer's abort reason reaches no log line and no report`.
2. **An e2e daemon that writes hooks outside its throwaway root** is still caught after the hook lines stop naming paths. Task 9, `hooksOutside finds a hook file outside the root by its hash`.
3. **A fatal error in a service process or the macOS/Linux master**: one line with the process's tag and the kind, exit 1, so the master restarts the service and launchd or systemd the master, as before. Task 3, `a service process that throws or rejects logs its kind and exits 1`.
4. **`harness start` still sees the daemon connect, and the e2e harness still finds the port**: `[backend] connected` starts the line; `[hooks] listening on 127.0.0.1:<n> (` is unchanged. Tasks 8 and 7, `the connected line keeps its marker and names no URL`, `the socket's line names no path and is not read as the port`.
5. **A code is kept, anything else is not**: `SERVICE_UNAVAILABLE` passes, `peer_failed`, `enoent`, a sentence with a path and 41 characters become `text(n)`, a number `number`. Task 1, `a value that is %s reads %s`.

---

### Task 1: Helpers

**Depends on:** none. **Effort:** `medium`.

**Files:**
- Modify: `cli/src/lib/log.ts` (after `errorKind`)
- Test: `cli/src/lib/log.spec.ts`

**Interfaces:**
- Produces: `export function codeOrLength(value: unknown): string`, `export function hashOf(text: string): string`, from `lib/log.js`.

- [ ] **Step 1: Write the failing tests** in `lib/log.spec.ts`:

```ts
it.each([
  ['a code', 'SERVICE_UNAVAILABLE', 'SERVICE_UNAVAILABLE'],
  ['a lower-case word', 'peer_failed', 'text(11)'],
  ['a sentence with a path', 'could not read /Users/sentinel/notes', 'text(36)'],
  ['41 characters', `E${'X'.repeat(40)}`, 'text(41)'],
  ['one letter', 'E', 'text(1)'],
  ['empty', '', 'text(0)'],
  ['a number', 5, 'number'],
  ['undefined', undefined, 'undefined'],
  ['null', null, 'object'],
  ['an object', { code: 'ENOENT' }, 'object'],
])('a value that is %s reads %s', (_, value, shown) => expect(codeOrLength(value)).toBe(shown))

it('a hash is the first 8 hex of the text\'s SHA-256, the same each time, and holds none of it', () => {
  expect(hashOf('/Users/sentinel/.claude/settings.json')).toBe(createHash('sha256').update('/Users/sentinel/.claude/settings.json').digest('hex').slice(0, 8))
  expect(hashOf('/Users/sentinel/a')).not.toBe(hashOf('/Users/sentinel/b'))
  expect(hashOf('x')).toMatch(/^[0-9a-f]{8}$/)
})
```

- [ ] **Step 2: Run** `npx vitest run src/lib/log.spec.ts`. Expected: FAIL, neither is exported. Commit `test(cli): a code or a length, and a hash, for a log line (red)`.
- [ ] **Step 3: Implement** both after `errorKind`, reusing its `CODE` and the file's `createHash`. The doc comments say why: a stored or peer string can hold the person's words, a path names their home, and Export logs sends the log off the machine; a lower-case word is never trusted.
- [ ] **Step 4: Run** `npx vitest run src/lib/log.spec.ts src/architecture.spec.ts src/leanEntry.spec.ts` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `Daemon logs: codeOrLength and hashOf name a stored string or a path without its words`.

### Task 2: The guard and its pending lists

**Depends on:** none (it names the helpers, it does not import them). **Effort:** `xhigh`.

**Red test:** the guard itself on today's tree, with the extended rules and before its lists exist.

**Files:**
- Modify: `cli/src/architecture.failureLogs.spec.ts`
- Create: `cli/src/architecture.failureLogs.pending/` with the eighteen lists of the table above

**Interfaces:**
- Consumes: nothing.
- Produces: `npx vitest run src/architecture.failureLogs.spec.ts`, the red test of Tasks 3 to 17 and 19 to 21; one list per task, named in the table. The safe calls the guard passes: `errorKind`, `codeOrLength`, `hashOf`, `sid`, `serialPortName`, `Number`, `Boolean`, `Buffer.byteLength`.

- [ ] **Step 1: Measure** `npx vitest run src/architecture.failureLogs.spec.ts` three times; note each run's `tests` time (the base: 1.60 to 1.79 s).
- [ ] **Step 2: Write the rules** of "What the guard finds, as built", and the two `TERMINAL` lines with their commands. Rule 4 is a function beside `forwardedBy` (`returnedBy(read: ts.PropertyAccessExpression, hand: Hand): string | undefined`), which `printed` calls for a whole property read before it reads the property's object. The import bindings join `declaredIn`'s names for a source file, so an imported name resolves to its `import`. The header comment is the one description: the rules, why (rule 7; Export logs since #4447; the stored-string follow-up), and its limits, which become: a logger under another name; text carried two locals away or through a local of the function that logs it; a local whose value is content of a name the rules read (`const shown = basename(file)`), never followed; a local destructured from an error or a result; an error's or a value's words read by element access; an `AggregateError`'s `.errors`; a catch with a binding that logs without the word "fail"; a name the rules do not read (`reason`, `why`, `label`, a string `error`: a syntactic rule cannot tell a literal union's fixed words from free text); a hold's sentence (`HookPreparationHeld`'s `hold`), which no rule reads and `architecture.hookHolds.spec.ts` keeps to string literals; and a value built in one file and logged in another (a hold's reason, a peer's answer, a probe's result, a stream's close reason), each fixed at its sink with a behaviour test (docs/plans/2026-11-21-log-no-stored-strings-plan.md).
- [ ] **Step 3: Cases.** The two `passes` marked "Not yet" move to `finds` and their comment goes. Add to `finds`, each from a real site:

```ts
  "console.warn(`[agent] create refused · ${engine} · ${refusal.detail}`)",
  "const detail = 'Too many unverified hooks are pending'; console.log(`[hooks] held · ${detail}`)",
  "console.log(`[backend] connected → ${this.url}`)",
  "console.warn(`[x] exec exited (${code}): ${stream.stderr.trim()}`)",
  "console.log(`[turn] aborted by codex error · ${preview(message)}`)",
  "const tally = (tier: string, detail: string) => log(`notify · ${tier} · ${detail}`)",
  "console.log(`[harnessd] services run from ${config.serviceScriptPath}`)",
  "console.warn(`[state] ${basename(file)} could not be set aside`)",
  "function run() { const r = probe(); log(`[x] ${r.reason}`) } function probe() { try { return { ok: true } } catch (err) { return { ok: false, reason: (err as Error).message } } }",
  "async function run() { const r = await probe(); log(`[x] ${r.why}`) } async function probe() { return { ok: false, why: stderr } }",
  "let outcome; try { outcome = await move() } catch (error) { outcome = { moved: false, reason: error instanceof Error ? error.message : String(error) } } log(`[x] ${outcome.reason}`)",
  "this.host.log(`cable: ${port.path} is in use by another program`)",
  "console.warn(`[x] ${error instanceof HookPreparationHeld ? error.reason : errorKind(error)}`)",
```

  And to `passes`:

```ts
  "console.warn(`[agent] create refused · ${engine} · ${codeOrLength(refusal.error)}`)",
  "console.log(`[backend] connected · ${hashOf(this.url)}`)",
  "console.warn(`[x] exec exited (${code}): ${stream.stderr.length} B`)",
  "console.log(`[x] ${Buffer.byteLength(stderr)} B`)",
  "this.host.log(`cable: ${serialPortName(port.path)} is in use by another program`)",
  "const say = (message: string) => console.log(message)",
  "const deps = { log: (line: string) => console.log(line) }",
  "import path from 'node:path'; console.log(`[x] ${path.sep}`)",
  "function run() { const r = probe(); log(`[x] ${r.reason}`) } function probe() { return { ok: false, reason: 'busy' } }",
  "function openOf(p: unknown) { return { session: { engine: 'codex', transcriptPath: p } } } const ask = openOf(payload); console.warn(`[engine ${ask.session.engine}] LIVE_OPEN_FAILED`)",
  "console.warn(`[x] ${Boolean(err.reason) ? 'not a lock this CLI made' : 'held'}`)",
  "console.warn(`[x] ${error instanceof HookPreparationHeld ? error.hold : errorKind(error)}`)",
```

  Plus the two pending-list cases of "The pending lists".
- [ ] **Step 4: Run** the spec before any list exists. Expected: every case passes but `no daemon log line …`, which FAILS with 133 hits in 64 files, those of the table. A count far from it means a rule was misread: the tables are the truth, and a hit in a file no task names is reported. Commit `test(cli): no daemon log line carries a stored string, process output, a path or a URL (red)`, with the counts by list in the report.
- [ ] **Step 5: Write the eighteen lists** from that output, and the list-reading code by the names of "The pending lists" (`PENDING_LISTS`, `pendingExcuses`, its comment, its two cases, the header's one sentence).
- [ ] **Step 6: Run** the spec and `npm run typecheck`. Expected: PASS. Measure as in step 1 and report before and after; expected within about 0.3 s of the base.
- [ ] **Step 7: Commit** `The failure-log guard reads stored fields, names and a file's own results, with today's lines pending, one list a sweep task`.

---

**Every sweep task (3 to 21) runs these steps**, its own names filled in below:

- **Red.** Delete the task's list (none for Task 18). Write its behaviour tests (B in its table). Rewrite, in the specs beside its files, each expectation of a line it will change to the new text. Run the guard and those specs: the guard fails on exactly the list's hits, each behaviour test fails on the old line, each rewritten expectation fails. Commit `test(cli): <message> (red)`.
- **Change** the lines, by its table.
- **Check.** Run the guard, the task's specs and `npm run typecheck`. Then, for each changed line, `grep -rlF '<its fixed words>' src --include='*.spec.ts'` and run what it finds, and `grep -rlF '<its fixed words>' e2e`. A failing spec outside the task's files is not edited: it goes in the report as `cross-area: <spec>:<line> '<old>' -> '<new>'` (Task 23 applies it). An e2e file reading a changed line that "Readers of changed lines" does not list is reported as `e2e: <file>:<line>`, and the main session decides.
- **Commit** with the task's message.

In the tables: **G** = the guard finds it on the base (its list is the red test); **B** = a behaviour test of its own, named; **pin** = a test that passes before and after.

### Task 3: The master and the service processes

**Depends on:** 1, 2. **Effort:** `xhigh`.

**Files:**
- Modify: `cli/src/masterProcess.ts`, `cli/src/serviceProcess.ts`, `cli/src/lib/nodeReferences.ts`, `cli/src/lib/launchers.ts`, `cli/src/lib/log.ts` (`exitOnFatal`)
- Test: `cli/src/masterProcess.spec.ts`, `cli/src/serviceProcess.spec.ts`, `cli/src/lib/nodeReferences.spec.ts`, `cli/src/lib/launchers.spec.ts`, `cli/src/lib/log.spec.ts`
- Delete: `cli/src/architecture.failureLogs.pending/master.txt`

**Interfaces:**
- Consumes: `codeOrLength`, `errorKind`, `ts` (Task 1).
- Produces: `exitOnFatal` (see "The helpers"); `probeLean(…): { ok: boolean; ended: string }`. The texts Task 22 asserts: `[harnessd] the lean bundle did not answer its probe (exit 5): the master, the core and the services run from cli.js`; `[harnessd] lean-off is there: the master, the core and the services run from cli.js`.

| Line | Today | Becomes | Test |
|---|---|---|---|
| `masterProcess.ts:418` `fromBundle(reason)` | logs each caller's reason | unchanged; its callers below name no path | B with 443, 460 |
| 422 | `${LEAN_OFF_FILE} is there: … from ${bundlePath}` | `lean-off is there: … run from cli.js` | G |
| 431 | `no lean bundle in ${bundlePath}: …` | `no lean bundle in cli.js: …` | G |
| 443 | `the lean bundle ${leanPath} did not answer its probe on ${node} (${probed.detail}): the master stays on ${own}` | `the lean bundle did not answer its probe on the new Node (${probed.ended}): the master stays on the Node it runs on` | G; B (`node`, `own`) |
| 448 | `… ${leanPath} … (${probed.detail}): … from ${bundlePath}` | the Task 22 text | G |
| 452 | `… it runs from ${bundlePath}, … from ${leanPath}` | `… it runs from cli.js, the core and the services from the lean bundle` | G |
| 460 | `${missing} is not there to re-execute on: … from ${bundlePath}` | `the Node is not there …` or `the lean bundle is not there …` by which is missing, `… run from cli.js` | G; B (`missing`) |
| `probeLean` (369) | `detail`: the spawn error's message or the last line of stderr or stdout | `ended`: as "Decided here" says | B |
| `writeFatalTo` (153) | the Windows master's handler | moves to `lib/log.ts` as `exitOnFatal`; `processWindowsMasterDeps().fatal` calls `exitOnFatal('[harnessd] the master', fd)`, the same line as today | the moved tests |
| `startMaster` (235) | no handler on macOS and Linux | a fifth parameter `fatal: () => void = () => exitOnFatal('[harnessd] the master', 2)`, called first when `platform !== 'win32'` | B |
| `serviceProcess.ts` `startServiceProcess` | no handler (the gateway's process is one of these) | `ServiceProcessDeps.fatal?: (tag: string) => void`, default `(tag) => exitOnFatal(tag, 2)`, called with `` `[service ${processName}]` `` right after `ignoreLogWriteErrors()` | B |
| `lib/nodeReferences.ts:44` | `  ✓ repointed ${service!.file} at ${node}` | `  ✓ repointed the service definition at the new Node` | G |
| 45 | `  ✗ ${service!.file} was left on its Node: ${repointed.detail}` | `  ✗ the service definition was left on its Node: ${codeOrLength(repointed.detail)}` | G |
| `lib/launchers.ts:47` | `  ✓ repointed ${launcher} at ${node}` | `  ✓ repointed bin/harness at the new Node` | B |

Tests (B):
- `masterProcess.spec.ts`, `never names a path on its lines, whichever way it starts`: `startMasterFromBundle('/sentinel/cli.js', deps)` with `node: () => '/sentinel/node'`, `nodeBack: () => '/sentinel/own'`, a probe that answers `{ ok: false, ended: 'exit 1' }`, and in a second run `exists: () => false`; no logged line holds `sentinel`.
- `masterProcess.spec.ts`, `a probe says how it ended, never what it printed`: `probeLean` of a script that writes `boom /sentinel` to stderr and exits 3 gives `` ended: `exit 3 · stderr ${n} B` ``, `n` the bytes it wrote, and no `sentinel`.
- `lib/log.spec.ts`, `exitOnFatal writes one line with the tag and the kind and exits 1`: the moved `writeFatalTo` cases, with the tag `[service gateway]`, an uncaught `new TypeError('/sentinel')` and a rejection of the string `'/sentinel'`: the lines are `… [service gateway] stopped on an uncaught error: TypeError` and `… on an unhandled rejection: string`, exit `[1, 1]`.
- `serviceProcess.spec.ts`, `a service process that throws or rejects logs its kind and exits 1`: `startServiceProcess('search', { fatal })` calls `fatal('[service search]')` once, before a service starts.
- `masterProcess.spec.ts`, `the master on macOS and Linux stops on a fatal error with one line`: `startMaster(start, exit, 'darwin', windows, fatal)` calls `fatal` once; on `'win32'` it does not (the Windows path has its own).
- `lib/launchers.spec.ts`: a launcher under a temporary `sentinel-…` bin folder, repointed: the line is `  ✓ repointed bin/harness at the new Node`.

Rewrite: `masterProcess.spec.ts:97, 142, 191, 195, 209, 218, 223, 225, 239` and the `writeFatalTo` cases (443-…), `lib/nodeReferences.spec.ts:64, 75, 129`.

- [ ] Run the sweep steps. Red command: `npx vitest run src/architecture.failureLogs.spec.ts src/masterProcess.spec.ts src/serviceProcess.spec.ts src/lib/nodeReferences.spec.ts src/lib/launchers.spec.ts src/lib/log.spec.ts`. Check adds `src/leanEntry.spec.ts src/architecture.spec.ts`. Red commit `test(cli): the master's lines name no path, and every process stops on a fatal error with its kind (red)`; commit `Daemon logs: the master names no path, and the master and every service process stop on a fatal error with one line`.

### Task 4: harnessd

**Depends on:** 1, 2. **Effort:** `high`.

**Files:**
- Modify: `cli/src/harnessd/leanServices.ts`, `master.ts`, `reexec.ts`, `supervisor.ts`
- Test: `cli/src/harnessd/leanServices.spec.ts`, `master.spec.ts`, `reexec.spec.ts`, `supervisor.spec.ts`
- Delete: `cli/src/architecture.failureLogs.pending/harnessd.txt`

**Interfaces:**
- Produces, for Task 22: `[harnessd] services run from the lean bundle, as this master does` (and without `, as this master does` when there is no `bundleFingerprint`); `[harnessd] the lean bundle cannot be used (${why}): the core and the services start from cli.js`; `[harnessd] ${named(name)} died ${deaths} times from the lean bundle before it beat: it starts from cli.js from now on`. `runProbe`'s `ProbeResult` field `detail` is renamed `ended` (as Task 3's).

| Line | Becomes | Test |
|---|---|---|
| `leanServices.ts:78` | the text above (`why` is `unusable`'s fixed words) | G |
| 96 | the text above | G |
| `master.ts:322` | the text above | G |
| `reexec.ts:427` | `the bundle is not there to hand over to` | G |
| `reexec.ts:298` (`runProbe`) and 617 | `ended` as Task 3's `probeLean`; 617 prints `(${ended})` | G (617) |
| `supervisor.ts:482` | `in safe mode: ${codeOrLength(message.safeMode)}`; the status file keeps the core's reason (not a log) | B |

Test (B): `supervisor.spec.ts`, `a core's safe-mode reason reaches the log by its length`: a `harnessd:ready` with `safeMode: 'listen EADDRINUSE /Users/sentinel/x'` logs `· in safe mode: text(35)` and no `sentinel`.

`harnessd/` is held to 100% (`npm run test:harnessd`): the `lastLine` helper goes with its last use.

- [ ] Run the sweep steps. Red command: `npx vitest run src/architecture.failureLogs.spec.ts src/harnessd`. Check adds `src/architecture.spec.ts`. Red commit `test(cli): the supervisor's lines name no path and no probe's output (red)`; commit `Daemon logs: harnessd names the lean bundle and cli.js in words, and a probe by how it ended`.

### Task 5: Core: agents

**Depends on:** 1, 2. **Effort:** `high`.

**Files:**
- Modify: `cli/src/core/agents/fork.ts`, `launch.ts`, `newPane.ts`, `retarget.ts`, `discovery.ts`; `cli/src/lib/terminalAgentReconciler.ts`. Not `create.ts`: Task 9's (see "Tasks at a glance").
- Test: the specs beside each, and `lib/terminalAgentReconciler.spec.ts`
- Delete: `cli/src/architecture.failureLogs.pending/core-agents.txt`

| Line | Becomes | Test |
|---|---|---|
| `fork.ts:176` | `· ${codeOrLength(forkRefusal.error)}` | G |
| `launch.ts:143` | `pi's conversation brought home · ${hashOf(home)}` | G |
| `newPane.ts:183` | `create failed · ${engine} · ${codeOrLength(error)}` (the branch's own code) | G |
| 212 | `· ${refused.error}` (a literal code) | G |
| 215 | `describeAgentCreateFailure` gets `output: ''` and the line ends ` · pane output ${lines} lines` (the captured output's line count) | B |
| `discovery.ts:371, 375, 390, 395` | unchanged: their reasons are the reconciler's two sentences, typed `` `${'engine process' \| 'terminal runtime'} absent after ${number} confirmed scans` `` (`terminalAgentReconciler.ts` exports it; `onDormant`/`onRemoved` take it) | pin |

Tests: `newPane.spec.ts`, `a pane that exits before ready logs its output's line count, never a line of it` (captured output `'boom /Users/sentinel/x\nmore'`: `pane output 2 lines`, no `sentinel`); `terminalAgentReconciler.spec.ts`, pin: a pane missing `MISS_LIMIT` scans calls `onDormant` with `engine process absent after 3 confirmed scans`.

Core is held to 100% (`npm run test:core`).

- [ ] Run the sweep steps. Red command: `npx vitest run src/architecture.failureLogs.spec.ts src/core/agents/fork src/core/agents/launch src/core/agents/newPane src/core/agents/retarget src/core/agents/discovery src/lib/terminalAgentReconciler`. Red commit `test(cli): forking, retargeting and opening an agent's pane log its code, never its detail (red)`; commit `Daemon logs: forking, retargeting and opening an agent's pane name a code, never a detail or a folder`.

### Task 6: Core: wiring, engines, turns

**Depends on:** 1, 2. **Effort:** `high`.

**Files:**
- Modify: `cli/src/core/main.ts` (3208, 3463), `cli/src/core/connectorsLink.ts`, `cli/src/core/engines/hooks.ts`, `cli/src/core/engines/homeAdoptions.ts`, `cli/src/core/turns/funnel.ts`, `cli/src/lib/daemonSafeMode.ts`, `cli/src/testing/launchShapes.ts`
- Test: `core/connectorsLink.spec.ts`, `core/engines/homeAdoptions.spec.ts`, `core/turns/funnel.spec.ts`, `lib/daemonSafeMode.spec.ts`; `core/main.ts` has none (the guard is its test)
- Delete: `cli/src/architecture.failureLogs.pending/core-wiring.txt`

| Line | Becomes | Test |
|---|---|---|
| `core/main.ts:3208` | `[cli] dialing the backend (${hashOf(env.BACKEND_WS_URL)}) · watching …` | G |
| `core/main.ts:3463` with `lib/daemonSafeMode.ts:61, 65` | the two not-staying cases that return the error's message (read only by this line) return fixed words with `errorKind(error)`: `the data folder's socket is another daemon's (${kind})`, `the master that started this core is gone (${kind})`; the staying case keeps `message` (it is the safe mode's reason, `harness status`'s) | B |
| `core/connectorsLink.ts:27` | `: ${codeOrLength(answer.error)};` | B |
| `core/engines/homeAdoptions.ts:34` → `hooks.ts:339` | `reason(error)` becomes `errorKind(error)` and `reason` goes (its value reaches only `held`, which only logs); the catalog's holds are checked to be fixed words, else the same | B |
| `core/turns/funnel.ts:230` | `aborted by ${engine} error · ${codeOrLength(message)}` | G |
| `testing/launchShapes.ts:62` | as `core/main.ts` writes the same catch, with its binding and `errorKind` | G |

Tests: `daemonSafeMode.spec.ts`, `a core that leaves names why in words and a kind, never the error's message` (an `EADDRINUSE`-coded and an `ORPHAN_STILL_SERVING`-coded error whose message holds `/Users/sentinel`); `connectorsLink.spec.ts`, `a refusal is logged by its code` (`{ error: 'peer /Users/sentinel' }` → `text(…)`, `{ error: 'SERVICE_UNAVAILABLE' }` kept); `homeAdoptions.spec.ts`, `a hold names a failure by its kind` (an install that throws `new Error('/Users/sentinel')` → `held('Error')`).

- [ ] Run the sweep steps. Red command: `npx vitest run src/architecture.failureLogs.spec.ts src/core/connectorsLink src/core/engines/homeAdoptions src/core/engines/hooks src/core/turns/funnel src/lib/daemonSafeMode src/engines/launchShapes.golden.spec.ts`. Red commit `test(cli): the core's wiring names the backend by a hash and a hold by its kind (red)`; commit `Daemon logs: the core's wiring, home adoptions and turns name no URL, path or error's words`.

### Task 7: The hook door

**Depends on:** 1, 2. **Effort:** `high`.

**Files:**
- Modify: `cli/src/hookServer.ts`
- Test: `cli/src/hookServer.spec.ts`, `hookServer.hermes.spec.ts`
- Delete: `cli/src/architecture.failureLogs.pending/hook-door.txt`

| Line | Becomes | Test |
|---|---|---|
| 498 | `refused ${req.method} (${url.length} chars) · host=${hashOf(host)} origin=${hashOf(origin)}` (each when given) | G (method receiver) |
| 748 (the reasons `core/engines/pendingAdmission.ts:95, 114` build, which the hold publishes) | `held · ${codeOrLength(reason)}` | B |
| 883 | `· home=${hashOf(result.entry.hermesHome)}` | G |
| 948 | `held · HOOK_ADMISSION_BUSY` (the reply's code) | G |
| 982 | `· reason=${codeOrLength(hook.reason)}` (an engine's word) | B |
| 1188 | `[hooks] listening on the private socket` | G |
| 1175 | unchanged (the port, which the e2e harness reads) | |

Tests: `hookServer.spec.ts`, `a held hook is logged by its reason's length` (a hold whose reason holds `/Users/sentinel`), `a session-end reason is logged as a code or a length` (`'clear'` → `text(5)`, `'/Users/sentinel'` → `text(…)`), `the socket's line names no path and is not read as the port` (no line holds the socket path; `listeningPort` of the log, imported as `testing/daemonListeningPort.spec.ts` does, is the TCP port).

- [ ] Run the sweep steps. Red command: `npx vitest run src/architecture.failureLogs.spec.ts src/hookServer src/testing/daemonListeningPort.spec.ts`. Red commit `test(cli): the hook door names no path, URL or hold's words (red)`; commit `Daemon logs: the hook door names a hold, a session end and a refused request without their words`.

### Task 8: The relay and peer to peer

**Depends on:** 1, 2. **Effort:** `xhigh`.

**Files:**
- Modify: `cli/src/gateway/upstream.ts`, `cli/src/gateway/start.ts`, `cli/src/lib/remoteRelay.ts`, `cli/src/lib/terminalP2p.ts`
- Test: `gateway/upstream.spec.ts`, `lib/terminalP2p.spec.ts`, `lib/remoteRelay.spec.ts`, and a new `gateway/start.spec.ts`: `postAck` lives inside `startGateway`, which no spec starts, so its body becomes an exported `postDeviceAck(http: Pick<ReturnType<typeof createAccountHttp>, 'backend'>, ack: unknown): Promise<boolean>` in `gateway/start.ts`, which `startGateway` wires as `postAck: (ack) => postDeviceAck(accountHttp, ack)`
- Delete: `cli/src/architecture.failureLogs.pending/relay.txt`

| Line | Becomes | Test |
|---|---|---|
| `upstream.ts:196` | `[backend] connected · ${hashOf(this.url)}` | G; B `the connected line keeps its marker and names no URL` |
| `start.ts:341` | `(${r.status}: ${codeOrLength(code)})`, the backend's `error.code` | B (`postDeviceAck`: a 500 whose `error.code` is `'/Users/sentinel'` logs `(500: text(15))`, one whose code is `ACK_INVALID` logs it) |
| `terminalP2p.ts:427, 619, 630` | `'peer_aborted'`, the peer's reason dropped (see "Decided here") | B |
| `terminalP2p.ts:325` `negotiationDetail` → renamed `negotiationFacts`; its candidate types are kept only when one of ICE's four (`host`, `srflx`, `prflx`, `relay`), any other read as `other` | | B |
| `remoteRelay.ts:1058` | `· ${p2p.negotiationFacts}` | G |
| `remoteRelay.ts:1236`, `gateway/gateway.ts:1050` | unchanged: their reason is now this file's own | |

Tests: `terminalP2p.spec.ts`, `a peer's abort reason reaches no log line and no report` (a `p2p_abort` with `reason: 'words /Users/sentinel'`: `onState` and `onUnavailable` get `peer_aborted`; the host side's `closeConnection` the same), `a peer's candidate types are ICE's words` (a remote SDP with `typ sentinel` reads `other`); `upstream.spec.ts`, the connected line starts `[backend] connected` and holds no URL; and the `start.ts` refusal.

- [ ] Run the sweep steps. Red command: `npx vitest run src/architecture.failureLogs.spec.ts src/gateway src/lib/terminalP2p src/lib/remoteRelay src/lib/daemonLaunch.spec.ts`. Red commit `test(cli): the relay names the backend by a hash and keeps a peer's words out of its lines (red)`; commit `Daemon logs: the relay names the backend by a hash, and a peer's abort reason and SDP words stay out of the log`.

### Task 9: Engine hooks, their holds, creating an agent, and the e2e hook check

**Depends on:** 1, 2. **Effort:** `xhigh`.

**Files:**
- Modify: `cli/src/engines/kit/hookReview.ts`, `hookSettings.ts`, `nativeHookSettings.ts`, `nativeHookYaml.ts`, `nativePlugin.ts`, `cli/src/engines/nativeHooks.ts`, `cli/src/engines/nativeLaunch.ts`, `cli/src/engines/facets/hooks.ts` (the `messages` comment, the `file` property), `cli/src/engines/claude/hookContract.ts`, `cli/src/engines/codex/hookContract.ts` (the renamed property)
- Modify, for the hold (spec decision 4): `cli/src/engines/kit/hookHeld.ts` (`reason` renamed `hold`, `HookScriptMissing` with no argument, its comments), `cli/src/engines/kit/notifyHooks.ts` (55, `refuse` at 119 and its eight callers, `isNamedHold`, the comment at 73), `cli/src/engines/kit/hookRemovalOutcome.ts` (25), `cli/src/engines/kit/hookRemoval.ts` (49, and 132 for the renamed property), `cli/src/core/agents/create.ts` (every line below, 302 among them)
- Modify, for the renamed property alone: `cli/src/engines/removeHooks.ts` (188), `cli/src/lib/uninstall/deps.ts` (106, 109), and every spec `npm run typecheck` names for it (today `engines/kit/windowsHooks.spec.ts`, `engines/kit/hookScript.spec.ts`, `engines/kit/hookSettings.spec.ts`, `engines/hookInstallers.afterMove.spec.ts`)
- Modify: `cli/e2e/harness/daemon.ts` (`hookFilesNamed`, `assertHooksStayedInside`), `cli/e2e/homeMove.e2e.ts:103`
- Create: `cli/src/architecture.hookHolds.spec.ts`
- Test: the specs beside each kit file (`hookScript.spec.ts`, `notifyHooks.spec.ts`, `hookRemoval.spec.ts`, `windowsHooks.spec.ts` among them), `engines/nativeLaunch.spec.ts`, `engines/nativeHooks.eager.spec.ts`, `engines/nativeHooks.hermes.spec.ts`, `engines/hooks.spec.ts`, `core/agents/create.spec.ts`, and a new `cli/src/testing/hookFilesNamed.spec.ts` (imports the harness as `testing/daemonListeningPort.spec.ts` does)
- Delete: `cli/src/architecture.failureLogs.pending/engine-hooks.txt`

**Interfaces:**
- Produces: every hook line names its file and the hook script by `hashOf(path)` where it named the path: `→ <hash>`, `unchanged: <hash>`, `updated (path/port changed) → <hash> --port <n> in <hash>`. `e2e/harness/daemon.ts` exports `hooksOutside(log: string, root: string): string[]`: the hashes the log names that are no file's under [root] (it walks [root] and hashes each path as the daemon spells it), which `assertHooksStayedInside` and `homeMove.e2e.ts` use.
- Produces: `HookPreparationHeld.hold: string` (was `reason`; the constructor's argument, unchanged); `new HookScriptMissing()`, whose `hold` is `notify.mjs is missing, so no hook of Harness's could run`; `isNamedHold(error: unknown, platform: NodeJS.Platform): error is HookPreparationHeld`.

**The hold** ("Decided here", "A hold's sentence"):

| Site | Becomes | Test |
|---|---|---|
| `hookHeld.ts:10-11` | the field `hold`; its comment: fixed words, so a log line names a hold by them, kept so by `architecture.hookHolds.spec.ts` (the "HookScriptMissing's alone names a path" sentence goes) | `architecture.hookHolds.spec.ts` |
| `hookHeld.ts:19` `HookScriptMissing(script)` | `constructor() { super("notify.mjs is missing, so no hook of Harness's could run") … }` | `architecture.hookHolds.spec.ts` |
| `notifyHooks.ts:55` | `throw new HookScriptMissing()` (`missing` is still what `missingHookScript` returns, and stays its caller's test) | `architecture.hookHolds.spec.ts` |
| `notifyHooks.ts:119` `refuse` and its callers 129-150 | `refuse` goes; each caller `throw new HookPreparationHeld('a hook argument <its words today>')`, byte for byte the sentence it makes today | `architecture.hookHolds.spec.ts`; `windowsHooks.spec.ts:98, 109` and `lib/windows/hookFiles.real.spec.ts:156` pass unchanged |
| `hookRemoval.ts:49` | one throw a branch, each a literal: `the hook block's member is not an object` for `named`, `the hooks member is not an object` otherwise | `architecture.hookHolds.spec.ts`; `hookRemoval.spec.ts:192` unchanged |
| `notifyHooks.ts:69` `isNamedHold` | a type guard, so its callers read `error.hold`; the comment at 73 says the caller adds the hold | typecheck |
| `hookRemovalOutcome.ts:25` | `return error.hold` (uninstall's report, the same words) | `hookRemoval.spec.ts` |
| `hookSettings.ts:72-73, 121`, `nativeHookSettings.ts:99-100`, `nativePlugin.ts:55, 86`, `nativeHookYaml.ts:462`, `nativeHooks.ts:198`, `nativeLaunch.ts:296`, `hookReview.ts:266`, `core/agents/create.ts:302` | `error instanceof HookPreparationHeld ? error.hold : errorKind(error)`; the `HookScriptMissing` exception, its comment and the import it leaves unused go | G |
| `nativeHooks.ts:81` | `${hooksNotInstalled('hermes')} · ${error.hold}`, as the other "not installed" lines | `hookScript.spec.ts:74` rewritten |

`architecture.hookHolds.spec.ts`, `every hold is built from string literals`: it reads every `.ts` file under `cli/src` but specs with the TypeScript compiler API, as `architecture.failureLogs.spec.ts` does; the holds are `HookPreparationHeld` and every class that `extends` one of them, to a fixed point; it reports `<file>:<line>` for each `new <hold>(…)` and each `super(…)` in a hold's constructor with an argument that is not a `StringLiteral` or `NoSubstitutionTemplateLiteral`. Its own cases, from a planted source: it finds `` new HookPreparationHeld(`a hook argument ${reason}`) ``, `new HookPreparationHeld(detail)` and `class A extends HookPreparationHeld { constructor(s: string) { super(s) } }; new A('x')` (the `super`), and passes `new HookPreparationHeld('the settings do not have the declared object shape')` and `new HookScriptMissing()`. Red on the base: exactly `engines/kit/hookHeld.ts:19`, `engines/kit/hookRemoval.ts:49`, `engines/kit/notifyHooks.ts:55`, `engines/kit/notifyHooks.ts:119`.

**The lines:**

| Line | Becomes | Test |
|---|---|---|
| `hookSettings.ts:74-76, 228-229`, `nativeHookSettings.ts:93`, `nativePlugin.ts:43`, `nativeHooks.ts:97`, `nativeHookYaml.ts:388, 422, 433, 453` (`{file}`, `{script}` filled with a path) | filled with `hashOf(path)` | G (nativeHookYaml), B (the rest) |
| `nativeHookYaml.ts:447` `(${basename(home)})`, and 262 (its caller) | `(${hashOf(home)})` | G |
| `hookSettings.ts:123, 127, 135`, `hookReview.ts:246, 266` (`settings.file`, `allow.file`, `record.file`: a contract's fixed name) | the property is renamed `fileName` in `facets/hooks.ts`'s types and the two contracts; the lines unchanged in text | G |
| `create.ts:185` | `create refused · ${engine} · ${codeOrLength(refusal.error)}` | G |
| `create.ts:216, 283, 345` (a fixed sentence in `detail`) | the code the same branch returns, through `codeOrLength` | G |
| `create.ts:227` | `· ${codeOrLength(built.error)}` | G |
| `create.ts:254` (found while planning) | `materialize · ${materialized.warnings.length} warnings` (a warning names the template's folder, `dsh/materialize.ts:44`) | B |
| `create.ts:255` | `materialized · created … · kept …`: no `cwd` | G |

Tests: in the kit specs, `a hook install names its file by a hash, never its path`, per filler (Claude Code/Codex `hookSettings`, a native settings engine, a native plugin, Hermes YAML, a removal line of `nativeHooks`): install into a temporary home `sentinel-…`; no line holds `sentinel`, each holds `hashOf(<the file>)`. `testing/hookFilesNamed.spec.ts`: `hooksOutside finds a hook file outside the root by its hash` (a log naming `hashOf('/elsewhere/settings.json')` and one file under a temporary root: the first is reported, the second is not), and the three line shapes are read. `create.spec.ts`, `the materializer's warnings are counted` (a warning `template /Users/sentinel/t is missing`: `materialize · 1 warnings`). `architecture.hookHolds.spec.ts` above.

Rewrite the expectations of the old lines in the kit's specs (`… → /…`, `unchanged: /…`), and the hold's: `hookScript.spec.ts:42` (`toThrow('notify.mjs is missing, so no hook')`), `59, 67, 74` and `nativeLaunch.spec.ts:220` (`· notify.mjs is missing, so no hook of Harness's could run` where they read `· HookScriptMissing`), `nativeLaunch.spec.ts:214` (`new HookScriptMissing()`).

`core/agents/create.ts` is held to 100% (`npm run test:core`): a branch the `HookScriptMissing` exception made goes with its case.

- [ ] Run the sweep steps. Red command: `npx vitest run src/architecture.failureLogs.spec.ts src/architecture.hookHolds.spec.ts src/engines src/core/agents/create src/testing/hookFilesNamed.spec.ts src/hookAdmission.golden.spec.ts`: the guard fails on exactly `engine-hooks.txt`'s 27 hits, `architecture.hookHolds.spec.ts` on its four sites. Check adds `src/lib/uninstall` and a run of one e2e file that installs hooks and stops its daemon, `E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/enginehomes.e2e.ts`: expected PASS, its daemons' hook check reading hashes. Red commit `test(cli): a hook line names its file by a hash, a hold is built from fixed words, and the e2e hook check reads hashes (red)`; commit `Daemon logs: engine hooks name their files by a hash and a hold by its fixed words, creating an agent names a code; the e2e hook check follows`.

### Task 10: Engine launch and transcripts

**Depends on:** 1, 2. **Effort:** `high`.

**Files:**
- Modify: `cli/src/engines/kit/launchExecutable.ts`, `resumeRepair.ts`, `transcriptDiscovery.ts`, `cli/src/engines/launchPrep.ts`, `cli/src/engines/facets/launch.ts` (`names.file`), `cli/src/engines/codex/launch.ts`
- Test: the specs beside each
- Delete: `cli/src/architecture.failureLogs.pending/engine-launch.txt`

| Line | Becomes | Test |
|---|---|---|
| `launchExecutable.ts:181` | `looked past ${hashOf(path)}, a Windows Store app's alias for ${app}` | G |
| `resumeRepair.ts:276` | unchanged text; `names.file` (`'Codex rollout'`) renamed `names.record` in `facets/launch.ts` and `codex/launch.ts`, and at its other reads (`resumeRepair.ts:119, 250`, and the specs `npm run typecheck` names) | G |
| `transcriptDiscovery.ts:47` | `held · ${codeOrLength(detail)}` (the hold is kept on the candidate as before) | G |
| `launchPrep.ts:45` | `… it found above ${hashOf(path)}, …` | G |

- [ ] Run the sweep steps. Red command: `npx vitest run src/architecture.failureLogs.spec.ts src/engines/kit/launchExecutable src/engines/kit/resumeRepair src/engines/kit/transcriptDiscovery src/engines/launchPrep src/engines/launchShapes.golden.spec.ts`. Red commit `test(cli): an engine's launch and transcript lines name no path (red)`; commit `Daemon logs: an engine's launch, resume and transcript lines name no path`.

### Task 11: Moves

**Depends on:** 1, 2. **Effort:** `high`.

**Files:**
- Modify: `cli/src/lib/hostMove/moveAgent.ts`, `mover.ts`, `cli/src/core/agents/hostMove.ts`
- Test: the specs beside each
- Delete: `cli/src/architecture.failureLogs.pending/moves.txt`

`moveAgent`'s results' `reason` reaches the client (`core/main.ts:3101`, `MOVE_FAILED`'s `detail`): it stays, and every line prints it through `codeOrLength`.

| Line | Becomes | Test |
|---|---|---|
| `moveAgent.ts:268, 282, 379, 389` | `(${codeOrLength(x.reason)})` | G |
| `mover.ts:118` (→ `skip`, 153), 121 | `codeOrLength(outcome.reason)`; `skip` logs `skipped (${codeOrLength(reason)})` | G |
| `core/agents/hostMove.ts:116` | `(${codeOrLength(kept.reason ?? 'UNKNOWN')})` | B |
| 169 | `the relaunch in the old pane failed: ${codeOrLength(outcome.error ?? outcome.detail)}`, the result's code when it has one | G |

Test: `core/agents/hostMove.spec.ts`, `a pane that could not be kept open is logged by its reason's length` (`kept.reason: '/Users/sentinel'`).

- [ ] Run the sweep steps. Red command: `npx vitest run src/architecture.failureLogs.spec.ts src/lib/hostMove src/core/agents/hostMove`. Red commit `test(cli): a move's lines carry no reason's words (red)`; commit `Daemon logs: moving an agent between terminal hosts names a reason by its code or length`.

### Task 12: Agent services

**Depends on:** 1, 2. **Effort:** `high`.

**Files:**
- Modify: `cli/src/lib/deleteAgentFallback.ts`, `closeAgentService.ts`, `resumeAgentService.ts`, `restartAgent.ts`, `createAgentPane.ts`, `launchOverrides.ts`, `cwdRepair.ts`, `gitProject.ts`
- Test: the specs beside each
- Delete: `cli/src/architecture.failureLogs.pending/agent-services.txt`

| Line | Becomes | Test |
|---|---|---|
| `deleteAgentFallback.ts:89, 131` (its functions return `reason: err.message`) | at the source, when the reason reaches only these lines: `reason: errorKind(err)`; else `codeOrLength` at the line | G |
| `closeAgentService.ts:277` | `(${codeOrLength(result.error)})` | G |
| `resumeAgentService.ts:203` | the detail goes; `result.error` through `codeOrLength` | G |
| `restartAgent.ts:197` | `respawn-pane failed: ${codeOrLength(spawned.reason ?? 'UNKNOWN')}` | B |
| `createAgentPane.ts:157` | `· ${codeOrLength(spawned.reason ?? '')}` | B |
| `launchOverrides.ts:317` | `· ${codeOrLength(checked.error ?? checked.detail)}` (its code when it has one) | G |
| `cwdRepair.ts:45, 72, 82, 94` | the folders go: `cwd is not its transcript's project folder …`, `cwd repaired (transcript project folder)`, `(forked from <id8>)` | G |
| `gitProject.ts:382, 386` | git's stderr by its byte length, the folder by `the worktree` | G |
| `gitProject.ts:466` (`stopTree`'s string) | `stopTree` returns `errorKind(error)` for `process.kill` and `taskkill exit <code> · <n> B` for taskkill, when its result reaches only this line; else `codeOrLength` here | B |

Tests: `restartAgent.spec.ts` and `createAgentPane.spec.ts`, a spawn refused with a reason holding `/Users/sentinel`; `gitProject.spec.ts`, `a git that cannot be stopped is logged by how it failed` (a `stopTree` result naming `/Users/sentinel`).

`resumeAgentService.ts` is held to 100% (`npm run test:resume`); `launchOverrides` and `createAgentPane` are in `test:portability`.

- [ ] Run the sweep steps. Red command: `npx vitest run src/architecture.failureLogs.spec.ts src/lib/deleteAgentFallback. src/lib/closeAgentService. src/lib/resumeAgentService. src/lib/restartAgent. src/lib/createAgentPane. src/lib/launchOverrides. src/lib/cwdRepair. src/lib/gitProject.`. Red commit `test(cli): closing, resuming and repairing an agent log no folder and no detail (red)`; commit `Daemon logs: closing, resuming, restarting and repairing an agent name a code, never a folder or a detail`.

### Task 13: Restore and the registry

**Depends on:** 1, 2. **Effort:** `high`.

**Files:**
- Modify: `cli/src/lib/restoreAgents.ts`, `cli/src/core/agents/heldLaunches.ts`, `cli/src/lib/registry.ts` (1642, 1645 only)
- Test: `lib/restoreAgents*.spec.ts`, `core/agents/heldLaunches.spec.ts`, `lib/registry.quarantine.spec.ts`
- Delete: `cli/src/architecture.failureLogs.pending/restore.txt`

| Line | Becomes | Test |
|---|---|---|
| `restoreAgents.ts:622, 730` | `· ${codeOrLength(created.reason)}` | B |
| 672 | `· ${codeOrLength(launch.error)}` | G |
| 811 (`fail(error, detail)`), with 853, 889 its callers | `failed · ${codeOrLength(error)}`; `detail` still goes to the registry | G |
| 823 | `held · ${codeOrLength(detail)}` | G |
| `heldLaunches.ts:126` (`summary.failed` reasons, from `restoreAgents`) | `· ${codeOrLength(reason)}`; the once-per-change check still compares the reason itself | B |
| `registry.ts:1642` | `moved it aside to ${hashOf(aside)} and started empty`, and `${reason}` through `codeOrLength` when it is not one of the file's fixed words (check its two callers) | B |
| 1645 | `${reason}` as 1642 | B |

Tests: `heldLaunches.spec.ts`, `a held agent's reason is logged by its code or length`; `restoreAgents.spec.ts`, a pane refused with `/Users/sentinel`; `registry.quarantine.spec.ts`, `a corrupt registry is moved aside and named by a hash` (no line holds the data folder).

`lib/registry.ts` is in `test:portability`; `core/agents` in `test:core`.

- [ ] Run the sweep steps. Red command: `npx vitest run src/architecture.failureLogs.spec.ts src/lib/restoreAgents src/core/agents/heldLaunches src/lib/registry.quarantine.spec.ts`. Red commit `test(cli): restoring and holding agents log codes, never details or paths (red)`; commit `Daemon logs: restore, held launches and the registry's quarantine name a code or a hash`.

### Task 14: Terminal hosts and streams

**Depends on:** 1, 2. **Effort:** `high`.

**Files:**
- Modify: `cli/src/lib/ptyHostBackend.ts`, `cli/src/lib/tmuxBackend.ts`, `cli/src/lib/terminalStreamManager.ts`
- Test: `lib/ptyHostBackend.spec.ts`, `lib/tmuxBackend.spec.ts`, `lib/terminalStreamManager*.spec.ts`
- Delete: `cli/src/architecture.failureLogs.pending/terminals.txt`

| Line | Becomes | Test |
|---|---|---|
| `ptyHostBackend.ts:545` | `reconnect failed (${'incompatible' in reached ? 'incompatible' : reached.code})` | G |
| 318 (`markGone(reason)`) | `has gone (${codeOrLength(reason)})` | B |
| `tmuxBackend.ts:234` | `unavailable: ${codeOrLength(tmuxPath.reason)}` | B |
| 239 | `adopted tmux from ${tmuxPath.from}` (`from` is a fixed word; checked) | G |
| 253 | `(${codeOrLength(startup.reason)})` | B |
| `terminalStreamManager.ts:899, 948` | `{ kind: errorKind(error) }` | B |
| 1140, 1498, 1667, 1794 (`reason` fields) | `reason: codeOrLength(reason)`; 1667's `takenBy: hashOf(takenBy.name)`; the `terminal_closed` frame keeps both | B |

Tests: `terminalStreamManager.spec.ts`, `a stream's diagnostics carry no reason's words and no client's name` (a stream closed by the host with `'pty host stream failed: /Users/sentinel'`, taken by a client named `Sentinel's iPhone`: the `closed` diagnostic's `reason` is `text(…)`, `takenBy` its hash; the client's `terminal_closed` still has both whole); `tmuxBackend.spec.ts` and `ptyHostBackend.spec.ts`, a reason holding `/Users/sentinel`.

- [ ] Run the sweep steps. Red command: `npx vitest run src/architecture.failureLogs.spec.ts src/lib/ptyHostBackend. src/lib/tmuxBackend. src/lib/terminalStreamManager`. Red commit `test(cli): terminal hosts and streams log no reason's words (red)`; commit `Daemon logs: terminal hosts and streams name a reason by its code or length and a client by a hash`.

### Task 15: Updates and install

**Depends on:** 1, 2. **Effort:** `high`.

**Files:**
- Modify: `cli/src/lib/selfUpdate.ts`, `cli/src/lib/runtimeInstall.ts`, `cli/src/lib/gridWindowsPin.ts`, `cli/src/config/env.ts`, `cli/src/lib/secureState.ts` (596 only), `cli/src/lib/openclawStore.ts`
- Test: the specs beside each
- Delete: `cli/src/architecture.failureLogs.pending/updates.txt`

| Line | Becomes | Test |
|---|---|---|
| `selfUpdate.ts:332, 355` (the canary's `detail`, read only by 838, 845, 848) | renamed `ended`: `errorKind(error)`, `signal <s>`, `exit <n>`, never a message | G |
| 838 | `does not run on the new Node (${result.ended})` | G |
| 845, 848 | `(${result.ended})` | G |
| 810 (`refuse(why)`) | unchanged: each `why` its callers pass is fixed words with a kind or `ended` (checked) | B |
| 901 | `${Boolean(err.reason) ? …}` | G |
| `runtimeInstall.ts:279` | `  ✓ ${spec.label} runtime ready (${artifact.version})` | B |
| 371 | `  ✗ Node stays on the one installed: ${result.reason}` (`NodeMigrationReason`, a literal union) | B |
| `gridWindowsPin.ts:40` | `  ✗ grid ${version} not installed · ${codeOrLength(result.status)}` | G |
| `config/env.ts:114, 116` | `… into the data folder`, `… in the data folder` | G |
| `secureState.ts:596` | `[state] ${hashOf(file)} could not be set aside (…)` | G |
| `openclawStore.ts:74` | `[openclaw] the agent folder's config is unreadable · ${errorKind(error)} · …` | G |

Tests: `runtimeInstall.spec.ts`, `a runtime ready or kept names no folder` (a runtime dir under a temporary `sentinel-…`); `selfUpdate.spec.ts`, `a refused update names why in words and a kind` (a canary whose failure message holds `/Users/sentinel`).

- [ ] Run the sweep steps. Red command: `npx vitest run src/architecture.failureLogs.spec.ts src/lib/selfUpdate src/lib/runtimeInstall src/lib/gridWindowsPin src/config src/lib/secureState. src/lib/openclawStore`. Red commit `test(cli): updates and installs name no folder and no error's words (red)`; commit `Daemon logs: the updater, the runtimes and the state files name no folder and no error's words`.

### Task 16: Windows

**Depends on:** 1, 2. **Effort:** `high`.

**Files:**
- Modify: `cli/src/lib/windows/ptyUpdate.ts`, `cli/src/lib/windows/dataFolderClaim.ts`
- Test: `lib/windows/ptyUpdate.spec.ts`, `lib/windows/dataFolderClaim.spec.ts` (they run on every platform)
- Delete: `cli/src/architecture.failureLogs.pending/windows.txt`

| Line | Becomes | Test |
|---|---|---|
| 179, 224 (`refuse(…, error.reason)`) → 150 | `refuse(key, version, errorKind(error))` | G |
| 219 | `could not be unpacked (${errorKind(error)})` | G |
| 212 | the version read into a local first (`currentPtyVersion` returns a version; a comment says so) | G |
| 247 | `${Boolean(error.reason) ? …}` | G |
| `dataFolderClaim.ts:164, 175` | `the data folder's claim`, never its path | G |

- [ ] Run the sweep steps. Red command: `npx vitest run src/architecture.failureLogs.spec.ts src/lib/windows/ptyUpdate. src/lib/windows/dataFolderClaim.`. Red commit `test(cli): the terminal host's updates and the data folder claim name no path (red)`; commit `Daemon logs: Windows' terminal host updates and data folder claim name no path and no refusal's words`.

### Task 17: Dials

**Depends on:** 1, 2. **Effort:** `high`.

**Files:**
- Modify: `cli/src/cable/serial.ts` (`serialPortName`), `cableFleet.ts`, `cableSession.ts`, `cableHost.ts`, `windowsSerial.ts`, `engineTally.ts`
- Test: the specs beside each (`serial.spec.ts`, `cableFleet.spec.ts`, `cableSession.spec.ts`, `cableHost.spec.ts`, `windowsSerial.spec.ts`, `engineTally.spec.ts`)
- Delete: `cli/src/architecture.failureLogs.pending/dials.txt`

**Interfaces:**
- Produces: `export function serialPortName(path: string): string`, returning [path]; its comment: a dial's serial port name is a device's name, not personal content (the 2026-11-19 sweep's answer 5, kept by the 2026-11-21 spec), and the one way a log line prints it (`architecture.failureLogs.spec.ts` reads it as safe).

| Line | Becomes | Test |
|---|---|---|
| `cableFleet.ts:177, 230, 246, 271, 347, 351, 373, 420, 430`, `cableSession.ts:1080, 1254` | the port through `serialPortName`, the same text | G |
| `cableSession.ts:2118` (a dial's `pet.error` reason) | `refused pet ${id}: ${codeOrLength(reason)}`; `petErrors` keeps the reason | B |
| `cableHost.ts:439, 442, 488` | `(${online.code ?? codeOrLength(online.message)})`, the code when the result has one, the catch's `errorKind(err)` at 437 | G |
| 1141 | `refused (${codeOrLength(result.error)})` | G |
| `windowsSerial.ts:171` | the bridge's stderr by its byte length and the exit | G |
| `engineTally.ts:18` | the `e` parameter renamed `engine` | G (method receiver) |

Test: `cableSession.spec.ts`, `a dial's refusal of a pet is logged by its code or length` (`reason: 'memory'` → `text(6)`, a reason holding `/Users/sentinel` → no `sentinel`).

`cable/serial.ts` and `windowsSerial.ts` select `cli-serial` (macOS, `serial.real.spec.ts`) at the end.

- [ ] Run the sweep steps. Red command: `npx vitest run src/architecture.failureLogs.spec.ts src/cable/serial.spec.ts src/cable/cableFleet src/cable/cableSession src/cable/cableHost src/cable/windowsSerial src/cable/engineTally src/services/fleet.spec.ts`. Red commit `test(cli): the dials keep their port's name through one function and log no peer's words (red)`; commit `Daemon logs: the dials name their port through serialPortName, and a refusal by its code`.

### Task 18: Devices

**Depends on:** 1. **Effort:** `high`. **No pending list:** the guard finds none of these lines.

**Files:**
- Modify: `cli/src/services/devices.ts` (2204, 2224), `cli/src/services/devicesListener.ts` (644), `cli/src/device/deviceLink.ts` (1219), `cli/src/cable/hosts/vscodeTerminals.ts` (322, pin only)
- Test: `services/devices*.spec.ts`, `services/devicesListener.spec.ts`, `device/deviceLink.spec.ts`, `cable/hosts/vscodeTerminals.spec.ts`

| Line | Becomes | Test |
|---|---|---|
| `devices.ts:2204` | `settings for … : ${codeOrLength(result.error)}` | B |
| 2224 | `REFUSED: ${codeOrLength(sent.reason)}` (and `sent.machine`, an id, kept) | B |
| `deviceLink.ts:1219` | `error=${codeOrLength(payload.error)}` (the device's) | B |
| `devicesListener.ts:644`, `vscodeTerminals.ts:322` | unchanged: `stream.ended.reason` is a `StreamEnd`, a literal union, at its only `abort` | pin |

Tests: `devices.spec.ts`, a setting refused and a route refused with words holding `/Users/sentinel`; `deviceLink.spec.ts`, `a device's error is logged by its code or length`; pins: `devicesListener.spec.ts` and `vscodeTerminals.spec.ts` assert `ended · gone`.

`services/` is held to 100%.

- [ ] Run the sweep steps (no list to delete). Red command: `npx vitest run src/services/devices src/device/deviceLink src/cable/hosts/vscodeTerminals`. Red commit `test(cli): the devices log a peer's refusal by its code (red)`; commit `Daemon logs: the devices name a dial's, a device's and a route's refusal by its code or length`.

### Task 19: The agent browser

**Depends on:** 1, 2. **Effort:** `high`.

**Files:**
- Modify: `cli/src/services/agentBrowser.ts` (589), `agentBrowserProcess.ts` (192), `agentBrowser/streams.ts` (138, 151), `agentBrowser/notices.ts` (175)
- Test: the specs beside each
- Delete: `cli/src/architecture.failureLogs.pending/agent-browser.txt`

| Line | Becomes | Test |
|---|---|---|
| `agentBrowser.ts:589` | `codeOrLength(answer.error).toLowerCase()` | B |
| `agentBrowserProcess.ts:192` | `browser_move_failed (${typeof answer?.error === 'string' ? codeOrLength(answer.error).toLowerCase() : 'no_answer'})` | B |
| `streams.ts:138` | `codeOrLength(detail)` | G |
| 151 | `exec exited (${code ?? signal}): stderr ${Buffer.byteLength(stream.stderr)} B` | G (method receiver) |
| `notices.ts:175` | `(${codeOrLength(event.reason ?? 'REJECTED')})` | B |

Tests: one per B line, a peer or core answer holding `/Users/sentinel`.

- [ ] Run the sweep steps. Red command: `npx vitest run src/architecture.failureLogs.spec.ts src/services/agentBrowser`. Red commit `test(cli): the agent browser logs no answer's words and no stderr (red)`; commit `Daemon logs: the agent browser names an answer by its code and a stream's stderr by its size`.

### Task 20: Services

**Depends on:** 1, 2. **Effort:** `high`.

**Files:**
- Modify: `cli/src/services/followLink.ts` (100), `hachi.ts` (123), `sharedMachines.ts` (260), `agentCleanup.ts` (154), `models.ts` (93), `osDevice.ts` (163-166), `cli/src/lib/gridAttach.ts` (166, 177)
- Test: the specs beside each
- Delete: `cli/src/architecture.failureLogs.pending/services.txt`

| Line | Becomes | Test |
|---|---|---|
| `followLink.ts:100` | `(${typeof answer?.error === 'string' ? codeOrLength(answer.error) : 'no answer'})` | B |
| `hachi.ts:123` | `the wake was not taken: ${codeOrLength(reply.error)}` | B |
| `sharedMachines.ts:260` | `errorKind(held.failed)` when it is an error, else its code through `codeOrLength` | G |
| `agentCleanup.ts:154` | `: ${codeOrLength(result.error)}` | G |
| `models.ts:93` | `grid not installed · ${installed.status} · its installer said ${Buffer.byteLength(installed.message)} B` | G |
| `osDevice.ts:166` | `spawnDetached`'s `file` renamed `program` (an executable Harness names); the line unchanged | G |
| `gridAttach.ts:166` | `grid sign-in did not happen: ${codeOrLength(handoff.code)}` | G |
| 177 | `signed grid in and ensured ${hashOf(name)}: ${ensured.status}` (the network's name is the person's) | G |

Tests: `followLink.spec.ts` and `hachi.spec.ts`, an answer holding `/Users/sentinel`.

- [ ] Run the sweep steps. Red command: `npx vitest run src/architecture.failureLogs.spec.ts src/services/followLink src/services/hachi src/services/sharedMachines src/services/agentCleanup src/services/models src/services/osDevice src/lib/gridAttach`. Red commit `test(cli): the services log no answer's words and no installer's output (red)`; commit `Daemon logs: following, Hachi, shared machines, cleanup and grid name a code, never an answer's words`.

### Task 21: Edges

**Depends on:** 1, 2. **Effort:** `high`.

**Files:**
- Modify: `cli/src/orchestrator/service.ts` (445), `cli/src/dsh/service.ts` (57, 60), `cli/src/dsh/viewer.ts` (207), `cli/src/watcher/watcher.ts` (165), `cli/src/lib/autonomous-device/dump.ts` (56), `cli/src/lib/connectors/renew.ts` (33-34), `cli/src/lib/e2ee/deviceLogSyncer.ts` (303, 999), `cli/src/lib/machineMcp.ts` (80 → 184, 186), `cli/src/lib/notifyTier.ts` (30-34)
- Test: the specs beside each
- Delete: `cli/src/architecture.failureLogs.pending/edges.txt`

| Line | Becomes | Test |
|---|---|---|
| `orchestrator/service.ts:445` | `[orchestrator] project paused after a background error · ${errorKind(error)}`; `run.error` unchanged | B |
| `dsh/service.ts:57` | `of ${id ?? hashOf(url)} failed · ${codeOrLength(result.error)}` | G |
| 60 | `installed ${result.installed.id}`: no folder | G |
| `dsh/viewer.ts:207` | `codeOrLength(resolved.error)` | B |
| `watcher.ts:165` | the transcript path goes | G |
| `dump.ts:56` | `to the file HARNESS_DEVICE_DUMP names` | G |
| `renew.ts:33-34` | the issuer by `hashOf`, the error by `errorKind(error)` | G |
| `deviceLogSyncer.ts:303` | `register refused: ${codeOrLength(answer.error)}` | B |
| 999 | the device by its `fp` alone (its label goes), `${codeOrLength(r.error)}` | G |
| `machineMcp.ts:80` → 184 | `why` (a reason with JSON's message) through `codeOrLength` at 184, or the message's kind at 80 when `why` is read only there | B |
| 186 | `noPath` renamed `unsupported` | G (method receiver) |
| `notifyTier.ts:34` | `createTally`'s `detail` renamed `rule`; text unchanged | G |

Tests: `orchestrator/service.spec.ts`, a background error with a message holding `/Users/sentinel` (the run's `error` still holds it, the line does not); `dsh/viewer.spec.ts`, `deviceLogSyncer.spec.ts`, `machineMcp.spec.ts`, a refusal or a file with `/Users/sentinel`.

`orchestrator` is held to 100% (`npm run test:orchestrator`); `dsh/` is in `test:portability`.

- [ ] Run the sweep steps. Red command: `npx vitest run src/architecture.failureLogs.spec.ts src/orchestrator src/dsh/service src/dsh/viewer src/watcher src/lib/autonomous-device src/lib/connectors/renew src/lib/e2ee/deviceLogSyncer src/lib/machineMcp src/lib/notifyTier`. Red commit `test(cli): the orchestrator, DSH, watcher and key sync log no path and no peer's words (red)`; commit `Daemon logs: the orchestrator, DSH, the watcher, key sync and machine MCP name no path and no peer's words`.

### Task 22: End-to-end expectations

**Depends on:** 3, 4, 7. **Effort:** `high`. **Red test:** none committed: test code only, one commit. Its red run is the files failing on the swept tree, seen and reported.

**Files:**
- Modify: `cli/e2e/lean.e2e.ts`, `cli/e2e/hermesAdmission.e2e.ts`, and any `e2e:` line a sweep task reported that the main session gave this task

- `lean.e2e.ts:97, 140, 182`: the lean bundle's path from the master's command line (`commandOf(master)`, as its lines 98-103 read it), not the log; `173, 191, 207, 284`: `/\[harnessd\] services run from the lean bundle/`; `148, 149`: `[harnessd] the lean bundle cannot be used (it is gone): the core and the services start from cli.js`; `169`: `… it starts from cli.js from now on`; `218`: unchanged; `283`: Task 3's text.
- `hermesAdmission.e2e.ts:66`: waits on the agent row's hold (`row()`), which carries the hold reason to clients, not the log.
- No assertion is dropped.

- [ ] **Step 1: Run** `E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/lean.e2e.ts e2e/hermesAdmission.e2e.ts` on the swept tree. Expected: FAIL on the old text.
- [ ] **Step 2: Rewrite** them.
- [ ] **Step 3: Run** the step 1 command. Expected: PASS, or a failure the same file shows on `origin/main`, named in the report.
- [ ] **Step 4: Commit** `test(cli): the end-to-end suite reads the lean bundle from the master's command and a hold from its agent`.

### Task 23: The guard keeps no pending list

**Depends on:** 3 to 21. **Effort:** `medium`. **Red test:** none: test code only, one commit.

**Files:**
- Modify: `cli/src/architecture.failureLogs.spec.ts` (the pending mechanism goes, whole)
- Delete: `cli/src/architecture.failureLogs.pending/`
- Modify: each spec a sweep task reported as `cross-area`, for the reported lines alone

The temporary pending mechanism is removed whole (spec decision 6): nothing of it is left behind, no code, case, folder, comment naming it, or sentence in the header.

- [ ] **Step 1: Check** that no list is left: `git ls-files src/architecture.failureLogs.pending` prints nothing. A list still there names a task that did not finish: stop and report it.
- [ ] **Step 2: Delete** from the guard's spec, by the names Task 2 gave them ("The pending lists"): the `PENDING_LISTS` constant, `pendingExcuses` and every call of it, the two cases whose names hold `pending line`, the comment above the mechanism, every other comment naming a pending list or Task 23, and the header's sentence about the pending lists. The tree scan then asserts `[]` with nothing excused. Delete the folder from disk if it is still there.
- [ ] **Step 3: Apply** each reported `cross-area` line.
- [ ] **Step 4: Run** `npx vitest run src/architecture.failureLogs.spec.ts src/architecture.hookHolds.spec.ts src/architecture.spec.ts` and the specs of step 3, then `npm run typecheck`. Expected: PASS, `TERMINAL` and `serialPortName` the guard's only exceptions.
- [ ] **Step 5: Prove nothing is left**, from `cli/`:

```bash
grep -nE 'PENDING_LISTS|pendingExcuses|pending lists?|pending line|Task 23' src/architecture.failureLogs.spec.ts
git -C .. grep -nE 'failureLogs\.pending|PENDING_LISTS|pendingExcuses' -- . ':!docs/plans'
test ! -e src/architecture.failureLogs.pending && echo gone
```

  Expected: the two greps print nothing (each exits 1) and the last line prints `gone`. Any line printed is a piece left behind: delete it and run step 4 again. The output goes in the report.
- [ ] **Step 6: Commit** `The failure-log guard excuses nothing but a command's own output and a dial's port`.

---

## The pull request's body

- What it helps someone do, in the root `AGENTS.md` words: rule 7 (no personal content in logs, which Export logs sends off the machine) and rule 13 (the rule is code).
- The guard's red run on the base (133 hits by list, Task 2's report), its time before and after, `architecture.hookHolds.spec.ts`'s red run (its four sites), and each sweep task's red and green commits.
- Platforms: the CLI daemon on macOS, Linux and Windows; daemon TypeScript only; local checks ran on macOS.
- What changed beyond a log's text: the fatal handlers (Task 3), a peer's p2p abort reason no longer kept for the metric (Task 8), the e2e hook check by hashes (Task 9), and a hold's field `hold` with `HookScriptMissing`'s message no longer naming notify.mjs's path (Task 9; a held create or resume still names it, from `missingHookScript`).
- The `harness-local-checks` fence from Verification, in the body when the pull request opens (it opens ready, not as a draft), and the by-hand CLI end to end run's link, added when the run ends.
- `architecture.coreFiles.txt` is unchanged.

## Verification

**End-to-end checks of the feature: none of their own.** The change is the text of daemon log lines and two process behaviours that unit tests pin (Task 3's fatal handlers, Task 8's p2p intake). No screen, command output, protocol frame or stored file changes, so there is nothing for a person to watch.

**Required local checks, which PR CI does not run, before the pull request opens.** From a clean tree at the final commit, on a Mac: `python3 scripts/local-checks.py --run`. It selects by path; for this branch (`--list` on its files): `cli-core` (`npm run test:core`), `cli-harnessd`, `cli-orchestrator`, `cli-portability` (`dsh/`, `launchOverrides`, `createAgentPane`, `registry`), `cli-resume` (`resumeAgentService`), `cli-pty` (`ptyHostBackend`, `tmuxBackend`: `npm run test:terminal-contract`), `cli-serial` (`cable/serial.ts`, `windowsSerial.ts`: the real-serial spec, macOS). Its fence goes in the pull request body before the push and the open: the process checks read the receipts from the event that opens it.

**PR CI, by the automatic run alone.** The pull request opens ready, not as a draft (spec decision 6), with the receipts in its body, so its first run is the full selection: `cli-typecheck`, `cli-tests` (the guard and `architecture.hookHolds.spec.ts` among them) and the suites its paths select:
- **linux-e2e**: the e2e files the PR modifies (`lean.e2e.ts`, `hermesAdmission.e2e.ts`, `homeMove.e2e.ts`), and its canary, which the change to `e2e/harness/daemon.ts` selects (two daemons on the real backend in its own throwaway setup, one case). Expected: `linux-e2e-summary` passes.
- **windows-e2e**: selected by `lib/windows/`, `cable/` and `lib/secureState.ts` (`windows.yml`'s specs and modules, `scripts/ci-plan.py` `windows_e2e`), about 43 runner-minutes. It is this pull request's own CI and needs no go (spec decision 6). Expected: its summary passes.
- No temporary workflow.

**The tester's check: one full end-to-end run by hand** (spec decision 5). **Actions → CLI end to end → Run workflow** on `fix/log-no-stored-strings` (`gh workflow run cli-e2e.yml --ref fix/log-no-stored-strings`), the repo's own workflow (eight Linux shards and the macOS full-disk job), once, on the final head after Tasks 22 and 23 land; the main session tells harness-pm when it starts (the heavy lane). Why: Task 9 changes the hook check that runs at every e2e daemon's stop, in every file, and e2e files read daemon log text widely while PR CI runs only the files the PR modifies; the grep of "Readers of changed lines" may miss a reader, and the nightly would find it a day late. Each shard runs its own daemons from one bundle under throwaway homes, private tmux servers, fake engines and the suite's fake backend: no account, no production, nobody's own login. Expected: `e2e-summary` passes; a file that fails here and on `main`'s latest nightly is not this branch's, and the tester names it. The run's link goes in the pull request.
