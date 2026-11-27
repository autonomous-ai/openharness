# Small fixes, 2026-11-27: implementation plan

> **For agentic workers:** REQUIRED: devcrew phase 3 runs this plan task by task. Each task with a test: a red commit
> (the failing test alone), then the code commit. A task with no test is one commit. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** Seven small fixes in one pull request: `harness device notify` says why it printed `no dial` and never drops
an answer that arrived in time; the end-to-end sweep ends Codex's detached app server, and is the real-Codex case's
only cleanup; tier A's `Math.random` pin; `codex --version` asked once per binary; a failed removal that is ignored
goes through one helper and never replaces the error on its way; an empty `CODEX_HOME` is `~/.codex` for every reader,
at the setting itself; the plugin README's measured hook times.

**Architecture:** Each item stays in the module that owns it: the devices' client (`cli/src/devices/listenerClient.ts`)
and `notify` (`devices/notice.ts`); the test sweep (`cli/src/testing/rootProcesses.ts` and its plain-Node copy
`cli/e2e/harness/reaperProcess.mjs`); Codex's plugin setup (`devices/codexPlugin.ts`); one removal helper,
`removeQuietly`, in `lib/removePath.ts` (already a file of the core's process), and the master's own copy,
`harnessd/leanBundle.ts`'s (the master imports only Node, its own folder and `../lib/log.js`); the `CODEX_HOME` field
of `config/env.ts` (already a file of the core's process), which reads `''` as `~/.codex`, so every reader is right on
its own. So `architecture.coreFiles.txt` does not change. Nothing of item 8.

**Tech Stack:** TypeScript (Node 22/24), Vitest, `node:http` over a Unix socket or Windows named pipe, `ps`/`lsof`.

**Spec:** [docs/plans/2026-11-27-small-fixes-1127-design.md](2026-11-27-small-fixes-1127-design.md)

## Global Constraints

- One pull request for items 1-7; nothing of item 8 (`device_bindings.firmwareVersion`).
- Platforms: macOS, Linux, Windows. Windows is proven by the PR's own CI (`windows-e2e`, by path); the Windows VM or the
  Dell only after the orchestrator hands one out. No CI rerun to get green; no `workflow_dispatch` unless the
  orchestrator hands out the turn. No new workflow, not even a temporary one.
- The devices' bound stays 2 s (`timeoutMs ?? 2000`, the stream's headers 2 s); `ASK_ANSWER_MAX` stays 1024 bytes.
- A reason is fixed words and numbers only: never an error's message, the answer, a path or a session.
- `codex --version`'s bound stays `LOCAL_MS` 15 s; `MAX_HOMES` stays 64; `MIN_CODEX` stays 0.172.0.
- No file joins the core's process: `cli/src/architecture.coreFiles.txt` does not change. `cli/src/core/` does not
  change.
- Files of the core's process change, as bug fixes: `config/env.ts` (tasks 18, 20), `lib/removePath.ts` (task 10),
  and task 16's files. The PR body says a core file changed and why (`CODEX_HOME=''` was kept as `''`, so readers took
  a relative folder for Codex's home, which Codex takes as `~/.codex`; a failed removal replaced the error on its way).
  So `npm run test:core` (100% per file) runs once on the final head, and `npm run test:harnessd` (100% per file) too
  (task 19); their receipts go in the PR.
- A removal whose failure is ignored goes through `removeQuietly`, on every path, the work's success included (a stray
  temporary is left, as `harnessd` already accepts). No second way stays, inline or local, but the master's one copy
  (`harnessd/leanBundle.ts`), kept by its import rule. Async removals ending in `.catch(() => {})` stay as they are.
- Tests: no fixed sleeps (a deliberate hold of the event loop with `Atomics.wait` is the repro, not a wait); never the
  developer's own `~/.codex`, daemon, tmux or processes; a test signals only a process it started or a pid file inside
  its own test root names under the item 2 rule.
- Comments say why and name the incident or measure (run 45948212750, the census of 2026-11-14, 16 minutes with 64
  homes).
- Copy short. Docs in English.

## Review Focus

1. A pid file inside the test root that names a process not the test's: the Vitest worker (`e2e/harness/sharedCodex.ts`
   writes that on purpose), the person's own Codex app server started before the root, another account's, a plain
   `codex` that is not an app server. Never signalled (tasks 5 and 6 test each).
2. A listener that truly answers after the bound, with the loop free: still a timeout. The fix gives the loop one turn
   to read what arrived, never a longer bound (task 3 tests it).
3. A temporary left behind once its removal's failure is dropped: no reader takes it for data (the inbox's `typing/`
   folder, a folder of receipts). Tasks 11-15 add, for each site whose folder a reader lists, a test that a left
   temporary is not read as an entry.
4. A Codex binary replaced in place (same path, new modification time) is asked again; a path that cannot be
   `stat`ed is never cached (task 9 tests both).
5. An error whose message carries a path (`read ECONNRESET /Users/x/...`) gives `error ECONNRESET` and nothing of
   the path (task 1 tests it).
6. A reader of `env.CODEX_HOME` that took `''` for "not set" (a truthiness check, an `?? ''`, a comparison with
   `''`): none may remain once the field reads `''` as `~/.codex` (task 20 lists what it checked).

---

## Item 1: `harness device notify` and the devices' client

### Task 1: `askDevices` says why it answers null

**Files:**
- Modify: `cli/src/devices/listenerClient.ts`
- Test: `cli/src/devices/listenerClient.spec.ts`

**Depends on:** none. **Effort:** high.

**Interfaces:**
- Produces: `askDevices(dataDir, message, options: SendOptions & { timeoutMs?: number; why?: (reason: string) => void })`.
  `why` is called once, only when `askDevices` resolves null, with one of exactly:
  `no listener`, `unproven`, `timeout before headers (<n> ms)`, `timeout in the body (<n> ms)`, `too big`, `not json`,
  `not an object`, `error <CODE>` (`<CODE>` matches `/^E[A-Z0-9_]+$/`) or `error` (no such code). `<n>`: whole
  milliseconds from the send to the abort, so a held loop (far over the bound) shows apart from a slow listener.
  A status other than 200 still resolves the number and calls nothing.
- Consumed by task 2 (`notice.ts`) and task 3.

- [ ] **Step 1: Write the failing tests** in a new `describe("askDevices says why it answers null")`, each asserting
  the resolved value (null) and the `why` calls (`vi.fn`):
  - no socket there: `['no listener']`; a socket of another account (`getuid` mocked) or looser than 0600:
    `['unproven']`;
  - listener never answers (`timeoutMs: 50`): one call matching `/^timeout before headers \(\d+ ms\)$/`; headers then
    a stalled body: `/^timeout in the body \(\d+ ms\)$/`;
  - body of 2048 bytes: `['too big']`; `{not json`: `['not json']`; `[]`, `"x"`, `null`: `['not an object']` each;
  - `fetch` rejecting `TypeError('fetch failed', { cause: { code: 'ECONNRESET', message: 'read ECONNRESET /Users/x/data' } })`:
    `['error ECONNRESET']`, and no call's text contains `/Users/x`; cause code `ECONNREFUSED` or `ENOENT`:
    `['no listener']`; a rejection with no code: `['error']`;
  - over a pipe: no record, and the recorded process gone: `['no listener']`; an answer with no proof or a wrong one:
    `['unproven']`;
  - a 200 object and a 400 call nothing.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/listenerClient.spec.ts` — expect the new cases to fail
  (`why` never called).
- [ ] **Step 3: Implement.** `devicesFetch` answers `'no listener'` with no target, and, where it would use
  `fetchOverSocket` (no `fetch` given, so an injected one still sees every send), `'no listener'` for no file at the
  socket's path (`existsSync`) and `'unproven'` for one `socketIsPrivate` (lib/localTransport.ts) refuses;
  `tellDevices` and `streamDevices` read anything but a function as false, as today. `askDevices`' catch maps: its bound's abort to the
  timeout reasons (a flag set once `send` resolved says whether headers came), `PipeUnproven` to `unproven`, a
  `SyntaxError` from `JSON.parse` to `not json`, cause code `ECONNREFUSED`/`ENOENT` to `no listener`, any other code to
  `error <CODE>`. The doc comment lists the reasons and says why: run 45948212750 printed `no dial` with nothing to say
  which null it was.
- [ ] **Step 4: Run** the same spec — all pass.
- [ ] **Step 5: Commit** red, then code.

### Task 2: `notify` writes why on stderr, never for `no listener`

**Files:**
- Modify: `cli/src/devices/notice.ts`
- Test: `cli/src/devices/notice.spec.ts`

**Depends on:** task 1 (the `why` option). **Effort:** medium.

**Interfaces:**
- Consumes: task 1's `why`.
- Produces: `NoticeDeps.ask?: (message: { type: 'notice' } & NoticeAsk, why: (reason: string) => void) => Promise<Record<string, unknown> | number | null>`;
  the default is `(message, why) => askDevices(deps.dataDir, { ...message }, { why })`. stdout is unchanged.
  One stderr line, `harness device notify: <reason>`, when stdout says `no dial` for any reason but the devices'
  own `{ result: 'no dial' }` and `no listener`: task 1's reasons, `status <n>` for a status other than 200 and 429,
  `unknown result` for a 200 object whose `result` `isNoticeResult` does not know.

- [ ] **Step 1: Write the failing tests** (the spec's `notify` helper takes an `ask` that calls `why`):
  - ask calls `why('timeout before headers (2004 ms)')` and resolves null: `out ['no dial']`,
    `err ['harness device notify: timeout before headers (2004 ms)']`, code 0; the same with `--json`
    (`out ['{"result":"no dial"}']`);
  - `why('no listener')`, null: `err []`;
  - 500: `err ['harness device notify: status 500']`; 429: `out ['limited']`, `err []`;
  - `{ result: 'later' }`: `out ['no dial']`, `err ['harness device notify: unknown result']`;
  - `{ result: 'no dial' }` and `{ result: 'shown' }`: `err []`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/notice.spec.ts` — the new cases fail.
- [ ] **Step 3: Implement** in `runNotice`. The comment says why `no listener` stays silent (an agent's shell would
  see it each time no devices run) and why only `notify` writes (`dial-watch`'s stderr is the Device app's log,
  `attach` promises none).
- [ ] **Step 4: Run** the spec — all pass. **Step 5: Commit** red, then code.

### Task 3: the bound never drops an answer that arrived inside it

**Files:**
- Modify: `cli/src/devices/listenerClient.ts`
- Test: `cli/src/devices/listenerClient.spec.ts`, `cli/src/devices/listenerPipe.windows.real.spec.ts`

**Depends on:** task 1 (same files, and the timeout reasons). **Effort:** xhigh.

**Interfaces:**
- Produces: a private `answerBound(ms: number, outer?: AbortSignal): { signal: AbortSignal; clear(): void }` used by
  `tellDevices`, `askDevices` and `streamDevices` in place of `AbortSignal.timeout` and the stream's own `setTimeout`:
  when its timer fires it aborts only from a `setImmediate`, so the loop's I/O phase runs once between (Node runs
  expired timers before it reads a socket that became readable while the loop was held, and on Windows libuv runs
  timers last in an iteration). `streamDevices` gains `timeoutMs?: number` (its headers' bound, 2000 by default), as
  the other two have.

- [ ] **Step 1: Write the failing tests**, `describe("an answer that arrived inside the bound is taken, though the loop runs again only after it")`:
  - a hold helper: `const hold = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)`;
  - the listener answers, then queues `setImmediate(() => hold(400))` (the answer is with the kernel by then: Node
    writes it in a `nextTick`), and the client's `timeoutMs` is 100:
    `tellDevices` → `true`; `askDevices` → `{ result: 'shown' }` with `why` not called; `streamDevices` with
    `timeoutMs: 100` → `true` and the chunk handed on; over a pipe (the stand-in socket), `askDevices` with the proof
    → the answer;
  - Review Focus 2: a listener that answers from `setTimeout(…, 250)` with the loop free and `timeoutMs: 100` → null,
    `why` matching `/^timeout before headers/`;
  - in `listenerPipe.windows.real.spec.ts`, the same hold on the real pipe: the notify handler queues
    `setImmediate(() => hold(2500))` and returns its answer; `askDevices` (default bound) → `{ mode: 'you' }`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/listenerClient.spec.ts` — the three held cases fail
  (false, null, false); the free-loop case passes. The Windows file runs only on Windows CI.
- [ ] **Step 3: Implement `answerBound`** and use it in the three clients; `clear()` in each `finally`. The comment
  names run 45948212750 (the devices logged `shown` at 06:06:58.843; the CLI printed `no dial` about 5 s later).
- [ ] **Step 4: Run** the spec — all pass. **Step 5: Commit** red, then code.

### Task 4: the notify end to end prints the CLI's stderr; the flaky record goes

**Files:**
- Modify: `cli/e2e/harness/windowsDaemon.ts`, `cli/e2e/dialWindows.e2e.ts`, `docs/validation-and-release.md`

**Depends on:** none. **Effort:** medium. **No failing test:** test harness and docs only; one commit.

- [ ] **Step 1:** `WindowsDaemon.harness` resolves `{ code, stdout, stderr }` (it still writes stderr to the
  `harness-<port>.log` artifact). In "harness device notify says no dial before the dial greets, and shown after",
  `onTestFailed` prints `---- harness device notify stderr` and both runs' stderr.
- [ ] **Step 2:** delete the `harness device notify says no dial before the dial greets, and shown after` row from
  "Recorded flaky tests" in `docs/validation-and-release.md`.
- [ ] **Step 3:** `cd cli && npm run typecheck` passes. **Commit.**

## Item 2: the sweep ends Codex's detached app server

The rule, in both copies: read each `app-server-daemon/daemon.pid` under the test root (breadth first, folders at
most 4 levels below the root, at most 2,000 folders read and 16 pid files, no link followed); of the JSON's `pid`
(a safe integer over 1), read with `ps -p` of those pids only `uid`, `lstart` and `command`; SIGKILL that pid alone
when its uid is this account's, its command matches `/(^|[\/\\\s])codex(\.js|\.exe)?\s(.*\s)?app-server(\s|$)/`, and
its start is no sooner than the second before the root's `birthtimeMs` (Linux's `lstart` can name the second before,
as `spawnedRuns.ts daemonOf` says). A root whose `birthtimeMs` is not over 0 ends nothing by this rule and logs one
line. Never the caller, its parent or pid 1. A bound reached logs one line.

### Task 5: the daemon's close sweep

**Files:**
- Modify: `cli/src/testing/rootProcesses.ts`, `cli/src/testing/spawnedRuns.ts` (`psOf` takes `'uid'` too)
- Test: `cli/src/testing/rootProcesses.spec.ts`, `cli/src/testing/ownTreeOnly.spec.ts`

**Depends on:** none. **Effort:** xhigh.

**Interfaces:**
- Produces (exported for the spec):
  `codexPidFiles(root: string): number[]`;
  `interface PidRow { pid: number; uid: number; started: string; command: string }`;
  `codexDaemons(rows: readonly PidRow[], made: number, uid: number): number[]`.
  `endRootProcesses(root, seen, owned, ms)` also ends those pids, waits for them within the same `ms`, and returns
  any still alive in the same `pid <n> <command>` form. `IsolatedDaemon.close()` does not change.

- [ ] **Step 1: Write the failing tests** in `rootProcesses.spec.ts`:
  - `codexDaemons`: kept, a row of this uid, `codex app-server --managed-daemon`, started 3 s after `made`; also the
    second before `made`; dropped: another uid, started 2 s before `made`, `node …/vitest/…/forks.js`,
    `codex exec hi`, `/x/codex-tools app-server`;
  - `codexPidFiles`: finds `<root>/home/codex/app-server-daemon/daemon.pid` and `<root>/b1/h/x/app-server-daemon/daemon.pid`;
    not one whose `app-server-daemon` is 5 folders below; not through a link to a folder outside the root; at most 16;
    skips text that is not JSON or a `pid` that is not a safe integer over 1;
  - real (skipped on Windows): a launcher starts
    `spawn(process.execPath, ['-e', idle, 'app-server', '--managed-daemon'], { argv0: 'codex', detached: true, stdio: 'ignore', cwd: tmpdir() })`,
    writes `{ pid, processStartTime }` to `<root>/home/codex/app-server-daemon/daemon.pid` and exits; once the
    launcher is gone, `endRootProcesses(root, new Map())` → `[]` and the stand-in is dead;
  - a pid file naming this worker (as `sharedCodex.ts` writes): `process.kill` never called with that pid.
  In `ownTreeOnly.spec.ts` ("the daemon's close sweep"), on the made-up machine with a real `testRoot()`: pid files
  name a made-up `codex app-server --managed-daemon` started an hour before the root (the person's), one of another
  uid, and one started after the root (the test's): only the last is signalled (`[pid, 'SIGKILL']`); `beyond` allows
  `ps -p` of exactly those three pids and nothing else (its doc says so).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/testing/rootProcesses.spec.ts src/testing/ownTreeOnly.spec.ts` —
  the new cases fail (functions missing; the stand-in alive).
- [ ] **Step 3: Implement** the rule above. The file's doc comment gains the why: a real
  `codex app-server --managed-daemon` from the tester of #4660 and #4668 outlived `close()`, launchd's, named by no
  command line or working folder the sweep reads; Codex records it in `<CODEX_HOME>/app-server-daemon/daemon.pid`
  (`engines/codex/launch.ts sharedServer.pidFile`). Only a process such a file inside the root names, never every
  app server on the machine (the person's own).
- [ ] **Step 4: Run** both specs — all pass. **Step 5: Commit** red, then code.

### Task 6: the worker's reaper

**Files:**
- Modify: `cli/e2e/harness/reaperProcess.mjs`
- Test: `cli/src/testing/reaperProcess.spec.ts`, `cli/src/testing/ownTreeOnly.spec.ts`

**Depends on:** task 5 (the rule it copies; the same `ownTreeOnly.spec.ts`). **Effort:** xhigh.

- [ ] **Step 1: Write the failing tests:** in `reaperProcess.spec.ts` (skipped on Windows), task 5's detaching
  stand-in under a real `htmux-` root the reaper is told (`{"tmux":…,"root":…}`), stdin closed: the reaper exits 0,
  the stand-in is dead, the root removed, stderr names one Codex app server ended. In `ownTreeOnly.spec.ts`
  ("the worker's reaper"), task 5's three made-up pid files through `fakeBin`: only the test's is signalled, `beyond`
  as in task 5.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/testing/reaperProcess.spec.ts src/testing/ownTreeOnly.spec.ts` —
  fail.
- [ ] **Step 3: Implement** the same rule in plain Node. The pid-file rule runs before `removeRoot(root)` even when
  nothing seen still runs: today `endRootProcesses` returns early on an empty `still`. Its comment points at
  `rootProcesses.ts` as the rule's source, as the file's other copies do.
- [ ] **Step 4: Run** both specs — pass. **Step 5: Commit** red, then code.

### Task 7: the real-Codex case leaves its cleanup to the sweep

**Files:** Modify `cli/e2e/deviceDialSkill.e2e.ts`.

**Depends on:** task 5 (`close()` must end what `daemon.pid` names before the case stops ending it itself).
**Effort:** medium. **No failing test:** an opt-in end-to-end case's cleanup; its proof is Verification 2. One commit.

- [ ] **Step 1:** in "a real Codex app-server's rollout gives its home", the `finally` keeps the pane's capture and
  `tmux kill-server` (the case's own tmux server, the pane's TUI with it) and drops every kill of Codex's processes:
  the `executablesUnder(home)` SIGTERM loop, its wait, the SIGKILL fallback and the last `until`. `executablesUnder`
  goes, and any import only it used. The comment that said the app server outlives the pane says instead that
  `IsolatedDaemon.close()` ends it through `<home>/app-server-daemon/daemon.pid` (rootProcesses.ts), so the sweep is
  the one cleanup and this case proves it (Verification 2).
- [ ] **Step 2:** `cd cli && npm run typecheck` passes. **Commit.**

## Item 3

### Task 8: tier A's `Math.random` pin

**Files:** Modify `cli/src/testing/dialAppEval/dialAppEval.spec.ts` (lines 42-44 and the case at about line 810).

**Depends on:** none. **Effort:** medium. **No failing test:** no behavior change; one commit.

Found while planning: #4655 sends a tie that holds tmux's or herdr's page to that page, but
`cable/hosts/appFilter.ts:216` still draws `this.deps.random()` for a tie between two other apps, or between tmux's
and herdr's, and tier A wires no `appRandom` (`cableHost.ts:309`). So the draws are counted first:

- [ ] **Step 1:** locally, not committed: replace the pin with a spy that calls through and counts; run the whole file
  (`cd cli && npx vitest run src/testing/dialAppEval/dialAppEval.spec.ts`); note the count and which caller drew.
- [ ] **Step 2a (count 0):** delete the pin and the "draws Math.random the same each time" case; run the file twice;
  "C1 twice gives the same frames…" and the second "…same…" case stay green.
- [ ] **Step 2b (count over 0):** keep the pin and its case; fix the comment to say what draws (for example
  `AppFilter.fallback`'s tie between two apps neither of which is tmux's or herdr's page).
- [ ] **Step 3: Commit.** The PR states the count and which step ran.

## Item 4

### Task 9: `codex --version` asked once per binary

**Files:**
- Modify: `cli/src/devices/codexPlugin.ts`
- Test: `cli/src/devices/codexPlugin.spec.ts`, `cli/src/cable/dialCodexPluginSetup.spec.ts`

**Depends on:** none. **Effort:** high.

**Interfaces:**
- Produces: `export type CodexRun = ClaudeRun & { readonly bin?: string }`; `codexFound` resolves and `codexRunIn`
  returns a `CodexRun` with `bin` (the `codex` it found); `CodexPluginDeps.run: CodexRun | null`.
  `supportedRun` asks `--version` through a module cache keyed by `realpathSync(bin)` and `statSync(bin).mtimeMs`,
  holding the answer's promise (so two asks at once share one), whatever it answered: a version, a failure, a
  `timedOut`. At most 8 binaries kept, oldest out. A run with no `bin`, or a `bin` that cannot be `stat`ed, asks each
  time, as today. `dialCodexPluginSetup.ts` and `services/devices.ts` do not change (`CodexRun` is a `ClaudeRun`).
  The existing call lists (for example "trust is written after the install and again after an update", two
  `--version`s) stay as they are: those rigs' runs carry no `bin`.

- [ ] **Step 1: Write the failing tests.** `codexPlugin.spec.ts`: two homes set up with runs carrying the same `bin`
  (a temp file) → `--version` asked once; `utimesSync(bin, …)` to a new time → asked again; a `--version` answering
  `{ code: null, timedOut: true }` → the second home asks nothing and fails `launcher` with the same reason; a `bin`
  that does not exist → asked each time; two setups started together → one ask.
  `dialCodexPluginSetup.spec.ts`, "64 homes with a `--version` that never answers end the pass after one bound":
  fake timers; 64 served homes; `codex(home)` returns one run with one `bin` whose `--version` resolves
  `{ code: null, stdout: '', stderr: '', timedOut: true }` only after its `timeoutMs`; start the pass,
  `await vi.advanceTimersByTimeAsync(15_000)`: the pass has settled and `--version` was asked once.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/codexPlugin.spec.ts src/cable/dialCodexPluginSetup.spec.ts`
  — fail (64 asks; the pass still running).
- [ ] **Step 3: Implement.** The comment: one pass asked each due home's `--version` with a 15 s bound, 16 minutes
  with 64 homes on a hanging Codex.
- [ ] **Step 4: Run** both specs — pass. **Step 5: Commit** red, then code.

## Item 5: a failed removal that is ignored never replaces the error on its way

One helper, `removeQuietly`, is the one way to remove a path whose removal's failure is ignored; the master
(`harnessd/`) keeps its own one copy, `leanBundle.ts`'s, by its import rule. Tasks 10-15 fix the sites where an
unguarded removal in a `catch` or `finally` replaced the error on its way (a behavior change, red first). Tasks 16-19
move every site that already ignores the failure inline (or through a local helper) to it, or in the master to its own
copy (no behavior change, no failing test). In a `finally`, the failure is dropped on every path, the work's success included:
a stray temporary is left, as `harnessd` accepts.

Each site's test (tasks 10-15): the work fails once with error A (`code: 'EACCES'`, by mocking the step before the
removal), and the removal throws `EBUSY` (as Windows does for a file still held; by a partial `vi.mock('node:fs')`, and
`vi.mock('fs')` too where the module imports the bare name, since the helper imports `node:fs`); the caller sees what A
gives, as the table says. For a `finally` site, also: the work succeeds and the removal throws `EBUSY` → the caller sees
the success.

### Task 10: `removeQuietly`, and Codex's trust write

**Files:**
- Modify: `cli/src/lib/removePath.ts`, `cli/src/devices/codexPluginTrust.ts`
- Test: `cli/src/lib/removePath.spec.ts`, `cli/src/devices/codexPluginTrust.spec.ts`

**Depends on:** none. **Effort:** high.

**Interfaces:**
- Produces: `export function removeQuietly(path: string): void` in `lib/removePath.ts`: `removePath(path)` (a link
  or file removed, never what a link points to; a folder with what is in it), its own failure dropped. Its comment says
  why: a file Windows still holds throws `EBUSY` or `EPERM`, and thrown from a `catch` or `finally` it replaced the
  error that failed the work (`replaceConfigText`); and that it is for a path the caller may leave behind (its own
  temporary, a pid file, a marker, a staging name).

- [ ] **Step 1: Write the failing tests:** `removePath.spec.ts`: removes a file, a link whose target is gone, and a
  folder with what is in it; returns, no throw, when the removal throws `EBUSY`; nothing there is no throw.
  `codexPluginTrust.spec.ts` (its `node:fs` is already spy-able): `replaceConfigText` whose `renameSync` throws
  `EACCES` once and whose removal throws `EBUSY` throws the `EACCES` error.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/removePath.spec.ts src/devices/codexPluginTrust.spec.ts` — fail.
- [ ] **Step 3: Implement**; `replaceConfigText`'s `catch` calls `removeQuietly(temporary)`.
- [ ] **Step 4: Run** — pass. **Step 5: Commit** red, then code.

### Tasks 11-15: the unguarded sites

Every one depends on task 10 alone, shares no file with another task, and follows task 10's steps: the failing tests
(one per site, the success-path case for each `finally`, plus Review Focus 3 where a reader lists the folder), red,
`removeQuietly` in place of the unguarded removal, green, commit red then code. Run each task's spec files with
`cd cli && npx vitest run <specs>`.

| Task | Effort | Site (file:line on d776283ec2) | What the caller sees with A | Spec |
|---|---|---|---|---|
| 11 | high | `devices/dialSkill.ts:189` (catch) | `false`, no throw | `devices/dialSkill.spec.ts` |
| 11 | | `devices/dialSkillFiles.ts:117` (catch) | A's code returned | `devices/dialSkillFiles.spec.ts` |
| 11 | | `devices/pluginFolder.ts:147` (finally in catch) | A thrown | `devices/pluginFolder.spec.ts` |
| 12 | high | `messages/inbox.ts:103` (catch) | A thrown; a left `.….tmp` in `typing/` is no item | `messages/inbox.spec.ts` |
| 12 | | `homeMove/bridge.ts:69` (finally), `:205` (catch) | A thrown; `false` | `homeMove/bridge.spec.ts` |
| 12 | | `dsh/preparation.ts:30` (finally) | A thrown | `dsh/preparation.spec.ts` |
| 12 | | `engines/resumeTranscript.ts:127` (finally, `unlinkSync`) | the `nativeUnavailable` answer A gives today | `engines/resumeTranscript.spec.ts` |
| 12 | | `engines/kit/resumeRepair.ts:316`, `:319` (finally) | A thrown | `engines/kit/resumeRepair.spec.ts` |
| 13 | xhigh | `lib/registryPersistence.ts:215` (catch, `await fs.rm`) | rejects with A | `lib/registryPersistence.spec.ts` |
| 13 | | `lib/agentCreationReceipt.ts:482`, `:503` (finally) | `storageFailure` of A; A thrown; a left temporary is no receipt | `lib/agentCreationReceipt.spec.ts` |
| 14 | high | `lib/harnessRuntimeIgnore.ts:38` (finally) | A thrown | `lib/harnessRuntimeIgnore.spec.ts` |
| 14 | | `lib/claudeProfiles.ts:33` (finally, imports `fs`) | A thrown | Create `lib/claudeProfiles.spec.ts` (throwaway home) |
| 14 | | `lib/apiConnections.ts:111` (finally) | A thrown | `lib/apiConnections.spec.ts` |
| 14 | | `lib/runtimeInstall.ts:253` (finally); also `:191`, already ignored inline, moved (no test) | A's outcome | `lib/runtimeInstall.spec.ts` |
| 14 | | `lib/connectors/store.ts:124` (finally) | A thrown | `lib/connectors/store.spec.ts` |
| 14 | | `lib/autonomous-device/resultJournal.ts:35` (finally) | A thrown | Create `lib/autonomous-device/resultJournal.spec.ts` |
| 14 | | `lib/uninstall/rcFiles.ts:109` (catch) | that file's outcome `failed` with A; the next files still done | `lib/uninstall/rcFiles.spec.ts` |
| 15 | xhigh | `engines/kit/homeAdoption.ts:269` (finally, `unlinkSync`) | A thrown | `engines/kit/homeAdoption.spec.ts` |
| 15 | | `engines/migrate/session.ts:104` (finally, `unlinkSync`) | A thrown | `engines/migrate/session.spec.ts` |
| 15 | | `dsh/builtins.ts:112` (finally) | A thrown, and `unlock()` still runs | `dsh/builtins.spec.ts` |
| 15 | | `tui/install.ts:123` (finally) | A thrown | `tui/install.spec.ts` |

All paths are under `cli/src/`. Each task's files are its sites and their specs. `registryPersistence.ts:215` is an
async `fs.rm`: it becomes `removeQuietly(temporary)` (a sync removal in an error path), not a second, async helper.
Left alone on purpose: `engines/kit/nativeHookFiles.ts:262` (its cleanup throws `HookPreparationHeld` by design).
An unguarded site an implementer finds beyond the table goes into the task that owns its folder (11: `devices/`, 12:
the spec's, 13: core-process data writers, 14: `lib/`, 15: `engines/`, `dsh/`, `tui/`) and is named in the PR.

### Tasks 16-19: the sites that already ignore the failure inline

A site moves when its `try` holds only one `rmSync` or `unlinkSync` of one path (no `maxRetries`) and its `catch`
does nothing: the line becomes `removeQuietly(path)`; a comment that says why the path may be left stays on the call.
Left as they are, each for its own reason, and named in the PR: `rmdirSync` sites, which remove a folder only when empty
(`messages/inbox.ts:204`, `engines/removeHooks.ts:199`, `engines/kit/messagesHook.ts:89`, `devices/dialSkill.ts:212`,
`lib/uninstall/removal.ts:253`); a `catch` that does something (`dsh/update.ts:92` says a line,
`lib/uninstall/deps.ts:118`, `devices/dialSkill.ts:199`, `messages/inbox.ts:141`, `config/env.ts:60`); a `catch` that
rethrows (`lib/registryPersistence.ts:328`/`:330`, `lib/removePath.ts:23`); removals that retry on purpose
(`lib/windows/ptyUpdate.ts:56`, `lib/windows/ptyUpdateCommand.ts:100`, `lib/windows/ptyPayload.ts:443`); and the 13
async removals ending in `.catch(() => {})` (`lib/sessionCheckpoint.ts`, `lib/oneshot.ts`, `lib/gitProjectFolder.ts`,
`orchestrator/service.ts`, `sharing/viewer.ts`, `lib/gridConfigDir.ts`, `lib/terminalStreamManager.ts`,
`lib/nativeProcessImages.ts`: a promise's own `catch`, kept by the orchestrator's answer). Each task: replace, then
`cd cli && npm run typecheck` and the named files' own specs (`npx vitest run <specs>`) pass; one commit.

| Task | Effort | Depends on | Sites (file:line on d776283ec2, under `cli/src/`) |
|---|---|---|---|
| 16 | high | 10 | Core's process: `lib/daemonState.ts:121`, `lib/authSession.ts:317`, `:331`, `:374`, `lib/localSocket.ts:211`, `:216`, `lib/windows/pipeAuth.ts:211`, `lib/ptyHost/launch.ts:588`, `lib/engineLaunch.ts:630`, `lib/daemonSafeMode.ts:114` |
| 17 | high | 10 | Other `lib/`: `lib/daemonStop.ts:165`, `:189`, `:216`, `:257`, `lib/selfUpdate.ts:380`, `:457`, `:596`, `lib/platformDaemon.ts:239`, `lib/startIfDown.ts:151`, `lib/e2ee/store.ts:264`, `lib/uninstall/removal.ts:251`, `lib/windows/cliVersions.ts:59`, `lib/windows/guestSetupClient.ts:60` (`unlink: removeQuietly`) |
| 18 | high | 10, 20 (`config/env.ts`) | Outside `lib/`: `devices/vscodeExtension.ts:342`, `devices/listenerPipe.ts:78`, `agentClient/browserOutput.ts:83`, `cable/hosts/linuxRaise.ts:127`, `config/env.ts:112` |
| 19 | high | none | The master, on its own copy (its import rule unchanged: `src/architecture.spec.ts` and `src/harnessd/AGENTS.md` do not change): `harnessd/leanBundle.ts:141`'s `removeQuietly` is exported, as a `function` declaration (hoisted: `reexec.ts` importing it closes a cycle with `leanBundle.ts`'s import of `sha256File`, safe because both are called only after load; the comment says so), its comment saying why for every caller (a failed removal is left for the next master, and never replaces the error on its way); `harnessd/master.ts:202` and `harnessd/reexec.ts:124`, `:143` (`removeMarker` keeps its name; its body is `removeQuietly(file)`) call it. Specs: `harnessd/master.spec.ts`, `harnessd/reexec.spec.ts`, `harnessd/leanBundle.spec.ts`; `npm run test:harnessd` passes at 100% per file. |

## Item 6: an empty `CODEX_HOME` is `~/.codex`

### Task 20: the `CODEX_HOME` setting reads `''` as `~/.codex`

**Files:**
- Modify: `cli/src/config/env.ts`, `cli/src/cli.ts`
- Test: `cli/src/config/env.spec.ts`

**Depends on:** none. **Effort:** high (a core-process file; every Codex reader sees it).

**Interfaces:**
- Produces: `env.CODEX_HOME` is `join(homedir(), '.codex')` when the variable is unset or `''`, and the value as
  written otherwise (today's reading). Only that field changes: `text()` (`config/envFields.ts`) and every other field
  stay as they are (they keep parity with the old zod `.default()`, #829, which is the only reason `''` was kept). The
  field's comment says why: Codex takes an empty `CODEX_HOME` as `~/.codex` (`utils/home-dir find_codex_home`;
  measured with codex-cli 0.172.0: `CODEX_HOME= codex login status` is signed in, an empty folder is not), and `''`
  made readers take a relative folder for Codex's home (the devices' skill and plugin homes, `engineHomes.ts`'s
  session roots in the core's process, the worktree deletion's protected list).
- Then every reader of `env.CODEX_HOME` is right on its own: no helper, no per-site fix. `cli.ts:3123` becomes
  `codexHome: env.CODEX_HOME`, its comment going with the inline form (the `homedir` and `join` imports stay: other
  lines use them). `services/devices.ts`, `lib/engineHomes.ts`, `lib/worktreeDeletion.ts` and `lib/codexProfiles.ts`
  do not change: the first three read the field as it is (the deletion's `protectedPath &&` guard stays, for
  `s.transcriptPath` and the other settings), and `defaultCodexHome`, like `lib/engineAccount.ts:153` and
  `lib/connectors/agents.ts:270`, reads a process environment passed to it, not `config/env.ts`.

- [ ] **Step 1: Write the failing test** in `env.spec.ts` ("the environment, as env.ts reads it"), through its `load`
  rig (env.ts in a process of its own, a throwaway home): `load({ CODEX_HOME: '' }, { read: ['CODEX_HOME'] })` gives
  `join(home, '.codex')`; unset gives the same; `/x` gives `/x`. The comment names the measure above.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/config/env.spec.ts -t "CODEX_HOME"` — fails (`''`).
- [ ] **Step 3: Implement** the field, then `cli.ts:3123`.
- [ ] **Step 4: Check that nothing relies on `''` meaning "not set"** (Review Focus 6): every non-spec reader of
  `env.CODEX_HOME` (`grep -rn "env\.CODEX_HOME" cli/src`, and the generic `env[own.setting]`, `env[setting]`,
  `env[profile.setting]`, `env[settings.home.setting]` reads in `lib/engineHomes.ts`, `engines/discoveries.ts`,
  `engines/kit/hookSettings.ts`), among them `services/devices.ts`, `lib/worktreeDeletion.ts`,
  `lib/conversationIdentity.ts`, `lib/sessionSearch/externals/index.ts`, `engines/nativeHooks.ts`,
  `engines/kit/notifyHooks.ts`, `testing/dialAppEval/tierA/world.ts`. Remove what the change makes dead (an
  `|| join(homedir(), '.codex')` or a `''` check on this field's value); the PR lists what was checked and says that
  nothing relied on `''` (or names what did and how it was fixed).
- [ ] **Step 5: Run** `env.spec.ts`, `cd cli && npm run typecheck`, and the specs of any file Step 4 changed — pass.
  No test at a reader: the readers' specs set `env.CODEX_HOME` past the field, so one would prove the fix only by
  loading `config/env.ts` with `CODEX_HOME=''` in a process of its own, as `env.spec.ts` already does; the PR says so.
- [ ] **Step 6: Commit** red, then code. The PR says `config/env.ts`, a core file, changed, and why.

## Item 7

### Task 21: the plugin README's measured hook times

**Files:** Modify `plugins/harness-device/README.md`.

**Depends on:** none. **Effort:** medium. **No failing test:** docs only; one commit.

- [ ] **Step 1:** a short `## Measured hook times` section after `## Codex`, these numbers and their runs:
  - Codex 0.172.0, hook start to exit, Harness CLI start-up included, median of 5 (#4660): macOS 238-269 ms; a Windows
    11 ARM64 VM 1.49-1.54 s, about 860 ms of it Windows PowerShell 5.1 starting. In the real macOS TUI, Codex's own
    hook log: 243-250 ms; the first ask after a fresh build 1.16 s (cold start). The hook's bound is 5 s.
  - Codex on Windows x64 (#4668), from the model's answer to the approval dialog: 928-966 ms, about 0.41 s of it
    Harness's own `PermissionRequest` hook in `CODEX_HOME/hooks.json`.
  - Claude Code on Windows (the README's own): the prompt shows about 0.5-1 s later in Git Bash, 2-3.5 s in
    PowerShell (a Windows 11 ARM64 VM).
- [ ] **Step 2: Commit.**
- The PR body says: the README is carried in cli.js (`scripts/lib/claudePluginBundle.mjs`), so the plugin's hash
  changes and every computer updates the plugin once after the release; for Codex, the daemon's pass writes the trust
  records again for the new copy, so the person is not asked to review the hooks again (Part 7's rule). That rule is
  already proven by two existing tests, which stay green and are named in the PR (no new test):
  `cable/dialCodexPluginSetup.spec.ts` "trust is written after the install and again after an update" (a CLI update
  whose carried README changed: the pass runs `plugin add` again, the content hashes in `config.toml` become the new
  copy's, and the home is counted `updated`, not `untrusted`) and `devices/codexPlugin.spec.ts` "codexUpdate writes
  the folder again, adds the plugin again with no marketplace call, and trusts the new copy" (`trusted: true` with a
  changed README). Run: `cd cli && npx vitest run src/cable/dialCodexPluginSetup.spec.ts src/devices/codexPlugin.spec.ts -t "after an update|trusts the new copy"`.

---

## Verification

1. **Item 1, Windows (`windows-e2e`, the PR's own CI, by path).** `cli/src/devices/`, `cli/src/cable/`,
   `cli/e2e/dialWindows.e2e.ts`, `cli/e2e/harness/windowsDaemon.ts` and `cli/e2e/harness/reaperProcess.mjs` select
   it; the Windows-named e2e file starts arm64 too. Isolated by the harness: a sealed throwaway profile, its own data
   folder, pipe and port, a stand-in dial, a fake backend, no account. Seen: `dialWindows.e2e.ts` "harness device
   notify says no dial…, and shown after" passes on x64 and arm64, and the Windows CLI specs step runs task 3's case
   in `listenerPipe.windows.real.spec.ts` green. If the notify case fails, its `---- harness device notify stderr`
   gives the reason, which with the daemon log's `notify · agent · shown` time goes in the PR. No rerun; by hand
   (**CI → Run workflow**, `scope=windows-e2e`) only when the orchestrator hands out the turn; the Windows VM or Dell
   only when the orchestrator hands one out. Where no run shows the failure, the PR argues the cause from the code and
   task 3's test (red on `main`, green after). A reason that shows the daemon's loop held (`timeout before headers`
   with the devices' `shown` logged well inside it): fixed here as a new task only when small and outside
   `cli/src/core`; otherwise reported to the orchestrator as its own item.
2. **Item 2, this Mac, local, on the final head (tasks 5 and 7 in).** `$SCRATCH` is a folder of the tester's own
   outside the repository. A real Codex at or above 0.172.0, installed there, never globally:
   `npm install --prefix "$SCRATCH/codex" @openai/codex@0.172.0`. Then:
   ```bash
   cd cli
   ps -axww -o pid=,ppid=,lstart=,command= | grep -E '[c]odex(\.js|\.exe)? .*app-server' > "$SCRATCH/app-servers-before.txt"
   E2E_REAL_CODEX="$SCRATCH/codex/node_modules/.bin/codex" npx vitest run --config vitest.e2e.config.ts e2e/deviceDialSkill.e2e.ts -t "real Codex"
   ps -axww -o pid=,ppid=,lstart=,command= | grep -E '[c]odex(\.js|\.exe)? .*app-server' > "$SCRATCH/app-servers-after.txt"
   ```
   Isolated by the harness: a throwaway `/tmp/htmux-*` root holding `HOME`, `CODEX_HOME` and the data folder, a
   private tmux server, free ports, a signed-out daemon, a provider on 127.0.0.1:9 with a dummy key, no Codex login;
   the person's `~/.codex` is never read. The case no longer kills Codex's processes itself (task 7), so
   `IsolatedDaemon.close()`'s sweep is the only cleanup. Seen: "1 passed" (not skipped), the case's log shows the
   rollout's holder is an app server, and no pid in the after file that is not in the before file. A pid only in the
   after file is checked with `lsof -a -p <pid> -d cwd,txt -Fn`: a path in a `/tmp/htmux-` root is a leak (the check
   fails; report it); anything else is the person's own and is left alone. Nothing is signalled by hand. Proposal,
   not built: a scheduled job that runs this case against a pinned Codex with the same `ps` diff (the newest-Codex
   check #4660 proposed).
3. **Unit and local gates.** Each task's specs as its steps say; `cd cli && npm run typecheck`; once on the final head,
   `npm run test:core` (core-process files change: items 5 and 6) and `npm run test:harnessd` (task 19),
   both at 100% per file, their receipts in the PR, which also says which core-process files changed and why.
4. **`linux-e2e` (the PR's own CI, by path).** `cli/e2e/` changes (tasks 4, 6, 7) run its canary
   (`twoAccounts.spike.e2e.ts`); a change to `cli/src/testing/dialAppEval/` (task 8, step 2a or 2b) runs the dial app
   eval's six files. Seen: `linux-e2e-summary` green. The real-Codex case is skipped there (no `E2E_REAL_CODEX`).
5. **Item 7.** No end-to-end check: the trust rule is proven by the two tests task 21 names; the README itself
   changes no behavior.

## Open questions

None. The three earlier ones were answered by the orchestrator: the master keeps its import rule and its own copy
(task 19); `config/env.ts`'s `CODEX_HOME` field reads `''` as `~/.codex` (task 20); the async `.catch(() => {})`
removals stay.
