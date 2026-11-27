# Discovery after a deleted start folder, and engines left unconfirmed on Windows: Implementation Plan

> **For agentic workers:** REQUIRED: implement this plan with devcrew phase 3, task by task. Steps use checkbox
> (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(cli): <the task's message> (red)` once its
> failing tests have been run and seen to fail, then the task's own message. A task with no red test is one commit. No
> task pushes or merges, and every task ends green.

**Goal:** A daemon keeps finding and confirming engines when the folder it was started in is deleted later, or when
one PATH folder answers with an odd error (the Windows report); when discovery cannot look, its log line and
`discoveryError` say why; and on Windows `harness stop` and `harness start` run no POSIX `ps` found on PATH.

**Architecture:**
- **The master and the core enter the person's home as their first step** (`lib/workingFolder.ts` `enterHome`, called
  by `startMaster`, `startCoreProcess` and `runCoreInForeground`), with the filesystem root as the fallback. Services,
  tmux and the PTY host inherit it.
- **The ownership pass (`lib/engineBin.ts`) stops reading the working folder, never throws synchronously, and never
  fails on one bad PATH folder or file**: a folder it cannot list is probed by name, as `EACCES` is today, and skipped
  only when those probes fail too or hang; each folder's read has a bound of its own; one line counts the folders not
  listed and skipped, by kind, once per change.
- **Discovery names the reason**: the probe carries the snapshot's error kind (`ownershipFailure`), and the reconciler's
  warning, `discoveryError` and the pane lookup's reason carry it.
- **On Windows a lock's start marker runs nothing** (`lib/processLiveness.ts` `processStartMarker`), so the spawn lock
  `harness stop` and `harness start` take no longer runs Git's `ps`.

**Tech Stack:** TypeScript on Node 24, vitest (unit and `vitest.e2e.config.ts`), PowerShell on GitHub's Windows runners.
No new dependency.

**Spec:** `docs/plans/2026-11-20-discovery-cwd-windows-confirm-design.md`. Read it with this plan, the root `AGENTS.md`,
`cli/AGENTS.md` (Protect the core, Rules), `cli/src/core/AGENTS.md` and `docs/validation-and-release.md`.

**Status of part 4:** GO. The Windows reproduction reproduced through lead a (GitHub run 44758521149, below). Tasks 4
and 5 are normal tasks.

## Base

- `fix/discovery-cwd-windows-confirm` at `c7e15ea5fb` (main `a59ba98a15` plus the temporary workflow's commit). The spec
  and this plan are untracked; the main session commits them, no task does.
- Line numbers are the base's. A task follows the expression it names when a line has moved, and says so in its report.
- `cd cli && npm ci` once. Every command below runs from `cli/` unless it says otherwise.

## Tasks at a glance

| Task | Files (tests included) | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 The e2e helper names its start folder; daemons from the sources load tsx by path | `e2e/harness/daemon.ts`, `e2e/stateFiles.e2e.ts`, `e2e/deviceDialSkill.e2e.ts`, `e2e/deviceNotify.e2e.ts`, `e2e/deviceOrcaHomes.e2e.ts`, `scripts/local-stack-peer.ts`, `scripts/remote-viewers-stack.ts`, `scripts/share-harness-e2e.ts` | none | medium | none: test tooling, one commit |
| 2 The master and the core start in the home | `src/lib/workingFolder.ts` + `.spec.ts` (new), `src/masterProcess.ts` + `.spec.ts`, `src/coreProcess.ts` + `.spec.ts`, `src/core/main.ts`, `src/architecture.coreFiles.txt`, `e2e/startFolderGone.e2e.ts` (new) | 1 | high | `e2e/startFolderGone.e2e.ts`; `workingFolder.spec.ts`; the order tests |
| 3 The ownership key reads no folder; nothing throws synchronously | `src/lib/engineBin.ts`, `src/lib/engineBin.key.spec.ts` (new) | none | high | `engineBin.key.spec.ts` |
| 4 A PATH folder that cannot be listed is probed by name; one bad folder or file never fails the lookup | `src/lib/engineBin.ts`, `src/lib/engineBin.async.spec.ts`, `src/lib/engineBin.pathEntries.spec.ts` (new), `.github/workflows/windows.yml` | none | xhigh | `engineBin.pathEntries.spec.ts` (EPERM, EACCES and the other kinds) |
| 5 A hung PATH folder, or a hung probe by name, is skipped by its own bound | `src/lib/engineBin.ts`, `src/lib/engineBin.pathEntries.spec.ts` | 4 | xhigh | `engineBin.pathEntries.spec.ts`, the hung cases |
| 6 Discovery names why it could not look | `src/lib/terminalAgentDiscovery.ts`, `src/lib/terminalAgentReconciler.ts`, `src/lib/terminalAgentDiscovery.unavailable.spec.ts` (new), `src/lib/terminalAgentReconciler.spec.ts` | none | high | both specs |
| 7 The pane lookup's reason carries the kind | `src/lib/paneEngineProcess.ts`, `src/lib/paneEngineProcess.probe.spec.ts` | none | medium | `paneEngineProcess.probe.spec.ts` |
| 8 The temporary workflow also runs this branch's build | `.github/workflows/tmp-discovery-cwd-windows-confirm.yml` | none | high | none: temporary workflow, one commit |
| 10 On Windows a lock's start marker runs no `ps` | `src/lib/processLiveness.ts`, `src/lib/processLiveness.spec.ts` | none | medium | `processLiveness.spec.ts`, the Windows case |
| 9 Remove the temporary workflow | `.github/workflows/tmp-discovery-cwd-windows-confirm.yml` (deleted) | 2, 3, 4, 5, 6, 7, 8, 10 | medium | none: one commit |

Longest chain of dependent tasks: three (1 → 2 → 9, or 4 → 5 → 9). Tasks 3, 4 and 5 share `engineBin.ts`, so devcrew
runs them one after another although 3 and 4 do not depend on each other. Task 10 is numbered after Task 9 only
because it was added later; it shares no file with any other task.

## Global Constraints

- No setting, flag or switch (spec, Non-goals). Docs and comments in English; comments say why and name the incident
  (the firmware flash's deleted worktree; Windows run 44758521149).
- Core rules (`cli/src/core/AGENTS.md`): a fix, not a feature. A new file the core loads gets its line in
  `src/architecture.coreFiles.txt`, in order, and the PR says why every session needs it. `npm run test:core` stays at
  100% per file (`src/core/main.ts` is the wiring, outside the gate).
- New log lines and `discoveryError` carry error kinds only (`errorKind`, `lib/log.ts`): never a path, PATH contents, a
  folder name or an error's words (AGENTS rule 7).
- Discovery keeps every agent when it could not look; "could not look" never becomes "nothing is running" (spec,
  Anti-goals).
- Tests never touch the person's daemon (port 18473), homes or tmux server: isolated daemons only (`IsolatedDaemon`),
  each started from a stable folder, except the throwaway start folder `startFolderGone.e2e.ts` deletes on purpose.
- No fixed sleeps in tests: `until`, gates and fake timers.
- Platforms: macOS, Linux, Windows x64 and ARM64. Nothing new is stored or synced; `discoveryError`'s text changes.

## Decided here, where the spec left it to the builder

- **The helper:** `src/lib/workingFolder.ts`, `enterHome()`. It returns the line to log (no timestamp, starting
  `[start]`) when the home could not be entered, else `null`; each caller logs it where its output already goes. The master logs it after
  `windows()` is taken, so on Windows it reaches the daemon log (harness-launch.exe gives the master no output before).
- **A third core start.** `harness start -f` with `HARNESS_NO_MASTER=1` (Harness OS's unit) and a start from the sources
  run the core through `runCoreInForeground` (`core/main.ts:3546`), not `startCoreProcess`. It enters the home too: the
  goal says the core never depends on the folder it was started in. That puts `lib/workingFolder.ts` in the core's
  import walk, hence its line in `architecture.coreFiles.txt`.
- **The probe's reason:** `TerminalAgentProbe.ownershipFailure?: string`, the snapshot's `errorKind`.
- **The helper's start folder:** `DaemonOptions.startFolder`.
- **Relative PATH entries stay** and resolve against the daemon's folder, now the home.
- **Parts 3 and 4 together.** With part 4 every error on a PATH folder is a probe by name or a skip, and every error on
  a candidate file is a skip, so nothing produces `ENGINE_LOOKUP_FAILED` any more: Task 4 removes it. The system code
  the decision wanted named reaches the log in the PATH line instead
  (`[engine] PATH: 1 folder not listed (EPERM), probed by name`). The kinds left for the probe and the pane reason
  (`ENGINE_LOOKUP_TIMEOUT`, `_CHANGED`, `_PATH_LIMIT`, `ENGINE_PATH_CHANGED`, a raw `ENOENT`) are what `errorKind` already
  reads, so Tasks 6 and 7 use `errorKind` and need nothing from Tasks 3 to 5.
- **One rule for a folder's read** (its `stat`, its listing, its second `stat`), as the orchestrator decided: `ENOENT`
  and `ENOTDIR` are an empty folder, not counted; any other error (`EACCES`, `EPERM`, `EINVAL`, `ELOOP`, `UNKNOWN`,
  anything) makes the folder probed by name, as `EACCES` does today, counted as "not listed" under the first error's
  kind. The folder is skipped only when every probe by name fails with something other than `ENOENT` or `ENOTDIR`
  (under the first probe error's kind) or the read, probes included, hangs (`TIMEOUT`, Task 5). A folder counts once:
  skipped, else not listed. `EACCES` on POSIX changes in two ways: it is counted in the PATH line, and a probe that
  then fails with another code skips the folder where today it fails the pass.
- **Probing by name, one way.** It happens inside the folder's own read, one `lstat(join(folder, name))` at a time,
  for each command the pass looks up by name (not a path) and each Windows launch candidate's basename, in its own case.
  A folder of more than 16,384 names is probed the same way (today it falls back to the file pool's probes), so `names`
  is never `null` and `visible()` reads only a set. One at a time, so a folder holds at most one filesystem thread, and
  Task 5's bound covers the probes with the rest of the folder's read.
- **What is cached.** As today, a folder's names are cached by its generation stamp when both `stat`s answered and
  match; the cache entry also keeps the folder's "not listed" kind, so a cache hit counts it again and the line does
  not flap. A read whose `stat` failed, and a skipped folder, are not cached.
- **The PATH line:** `console.warn`, `[engine] PATH: ` then one or two parts joined by `; `:
  `<n> folder not listed (<kinds>), probed by name` and `<m> folder skipped (<kinds>)` (`folders` when the count is
  above 1), each part only when its count is above 0, the kinds unique, sorted and joined with `, `. It is logged when
  its text differs from the last one logged (module state). `[engine] PATH: every folder read` when both counts are 0
  after a line that named some. Lines come only from passes that answered. A hung folder's kind is `TIMEOUT`. A
  candidate file that fails is skipped and not counted: the spec counts PATH entries only.
- **`PATH_ENTRY_TIMEOUT_MS = 2_000`** (settled by the main session). A local folder reads in milliseconds, and SMB in
  under half a second. 2 s leaves the pass's 10 s deadline room for several slow folders across 8 readers. A disk
  waking from sleep is skipped once and read again next pass.
- **The Windows `ps` (Task 10).** `harness stop` and `harness start` both take the spawn lock (`cli.ts` `stop` →
  `stopDaemonOrExit` → `stopDaemonProcess` → `acquireSpawnLock`; `startCommand` → `launch` → `withSpawnLock`), whose
  owner record (`daemonSpawnLock.ts` `tryCreate`) calls `processLockIdentity(process.pid)` →
  `processStartMarker`, which runs `execFileSync('ps', ['-p', pid, '-o', 'lstart='])` on every OS but Linux. Its error
  output reaches the console: one line per stop and per start, as run 44758521149 shows. The other process reads seen
  on those paths use the Windows table there already: `pidFileSettle.ts` reads `windowsProcessRows` on Windows,
  `stopOnWindows` and `startIfDown.ts` read `lib/windows/processTable.ts`, and `lockOwnerAlive` never asks for a marker
  on Windows, whose owner records hold none. The fix is that on Windows the marker is `null` and nothing runs: the Windows path the code
  already has for this question ("a pid is all Windows gives the owner record"; `spawnLockOwnerReused` proves a reused
  pid from the Windows process table). Reading the Windows table for a marker instead would be a new lock format and a
  full process-table read on every lock, which this fix does not need. `lib/processLiveness.ts` is already a core file
  (`architecture.coreFiles.txt`); the change adds no file.
- **The temporary workflow is extended (Task 8).** It is cheap: the same scenarios, plus a build and the install path
  `windows.yml` already uses. It is the only x64 after-evidence tonight, since nobody has an x64 machine free. It also
  shows the Windows update path: agents stuck on 0.6.78 come up after the branch build is installed over it. It also
  produces the arm64 install the VM round uses, and shows the `ps` lines gone from `harness stop` and `harness start`.

## Open questions

None. The PATH folder's bound (2 s) is settled; the rule for folders that cannot be listed, the Windows `ps` and the
heavy runs were answered by the orchestrator.

## Review Focus

1. **A daemon from the sources after the master moves to the home** (`node --import <loader> src/cli.ts __harnessd`,
   `start -f`, dev checkouts, every e2e from the sources): its core and services must still load. Pinned by Task 2's
   e2e, run from the sources on macOS, and by Task 1's runs of sources-mode files.
2. **Relative PATH entries** (`.`, `node_modules/.bin`) now resolve against the home: the pass still answers and finds an
   engine there. Task 3: `a relative PATH entry resolves against the process's working folder`.
3. **A failed key read must not poison the shared pass**: once the failure is gone, the next call answers. Task 3:
   `the next pass answers once that failure is gone`.
4. **A running engine whose folder was skipped** (not listed, and its probes failed too) must still be matched, by its
   name, so a skip never evicts a live agent. Task 4: `a running engine from a skipped folder is still matched by its
   name`.
5. **Nothing personal in the new lines**: a folder's name, a home path, or an error message quoting a path must never
   reach `[engine] PATH`, the `[start]` line, `[discovery]`, `discoveryError` or the pane reason. Tasks 2, 4, 6 and 7
   each assert that a sentinel name is absent.

---

### Task 1: The e2e helper names its start folder; daemons from the sources load tsx by path

Today the helper spawns every daemon with `cwd: CLI_ROOT` and a bare `--import tsx`, which Node resolves from the
working folder. Once the master works in its home (Task 2), the core it spawns from the sources with those flags
would not load.

**Files:**
- Modify: `cli/e2e/harness/daemon.ts` (`DaemonOptions` ~78-125; `start()` ~575-607)
- Modify: `cli/e2e/stateFiles.e2e.ts:106` (its `launch`)
- Modify: `cli/e2e/deviceDialSkill.e2e.ts:31-35`, `cli/e2e/deviceNotify.e2e.ts:31-35`,
  `cli/e2e/deviceOrcaHomes.e2e.ts:31-35`: their own copy of the loader URL is replaced by the export (one way)
- Modify: `cli/scripts/local-stack-peer.ts:193`, `cli/scripts/remote-viewers-stack.ts:202`,
  `cli/scripts/share-harness-e2e.ts:202, 325`: the `__run` daemon starts pass the loader by absolute path, as
  `scripts/orchestrator-e2e-peer.ts:21` resolves it

**Interfaces:**
- Produces (from `e2e/harness/daemon.ts`):
  - `export const TSX_LOADER: string`: `pathToFileURL(createRequire(join(CLI_ROOT, 'package.json')).resolve('tsx')).href`,
    the expression the three device files use today.
  - `export const SOURCES_CLI: readonly string[]`: `['--import', TSX_LOADER, join(CLI_ROOT, 'src', 'cli.ts')]`.
  - `DaemonOptions.startFolder?: string`: the folder the daemon's process is started in, as the folder of the shell
    that ran `harness start`. It must exist at each `start()`. `CLI_ROOT` when unset.
- `start()` builds its sources script from `SOURCES_CLI`, keeping the process-images preload first; the preload is
  already an absolute path (`e2e/harness/processImages.ts:29`). It spawns with `cwd: this.options.startFolder ?? CLI_ROOT`.

- [ ] **Step 1: Make the changes above.** CLI commands that only run from `CLI_ROOT` and start no daemon (`CLI_ENTRY`
      in the dial files, `harness(...)` helpers) stay as they are.
- [ ] **Step 2: Run sources-mode daemons through the master and the foreground paths, on macOS, no `E2E_BUNDLE`.**
      Run: `npx vitest run --config vitest.e2e.config.ts e2e/paneEnv.e2e.ts e2e/stateFiles.e2e.ts e2e/deviceNotify.e2e.ts`
      Expected: PASS, as on the base.
- [ ] **Step 3: Commit** `test(cli): the e2e helper names a daemon's start folder, and daemons from the sources load tsx by its path`

### Task 2: The master and the core start in the home

**Files:**
- Create: `cli/src/lib/workingFolder.ts`, `cli/src/lib/workingFolder.spec.ts`
- Modify: `cli/src/masterProcess.ts:234-251` (`startMaster`), `cli/src/masterProcess.spec.ts`
- Modify: `cli/src/coreProcess.ts:15-21`, `cli/src/coreProcess.spec.ts`
- Modify: `cli/src/core/main.ts:3546-3549` (`runCoreInForeground`: its first statement)
- Modify: `cli/src/architecture.coreFiles.txt`: `lib/workingFolder.ts`, in order
- Create: `cli/e2e/startFolderGone.e2e.ts`

**Interfaces:**
- Consumes: Task 1's `DaemonOptions.startFolder`; the sources-mode helper start.
- Produces: `export function enterHome(deps?: { home?: () => string; chdir?: (folder: string) => void; platform?: NodeJS.Platform }): string | null`.
  The defaults are `os.homedir`, `process.chdir` and `process.platform`. It enters the home. If that fails, or `home()`
  throws, it enters the root of the filesystem the home is on: `path.posix` or `path.win32` `.parse(home).root`, else `/`
  on macOS and Linux, else `${process.env.SystemDrive ?? 'C:'}\` on Windows. It returns one line naming the kind
  (`errorKind`) of each failure, and never the home's path. If the root fails too, it stays where it is and the line
  says so. It never throws.
- `startMaster`: `enterHome()` is the first statement, before `ensureUtf8Locale()`. A returned line is logged with
  `masterLog` right after `windowsConfig` is taken. `startCoreProcess`: `enterHome()` first; a line goes to
  `console.log(`${ts()} ${line}`)` after `ensureUtf8Locale()`. `runCoreInForeground`: the same, as its first statement.
  Each call gets a comment that names the deleted worktree.

- [ ] **Step 1: Write the failing tests**

`src/lib/workingFolder.spec.ts`:

```ts
it('enters the home', () => {
  const chdir = vi.fn()
  expect(enterHome({ home: () => '/Users/someone', chdir, platform: 'darwin' })).toBeNull()
  expect(chdir.mock.calls).toEqual([['/Users/someone']])
})
it('falls back to the root of the home\'s filesystem, and names the kind, never the folder', () => {
  const chdir = vi.fn((folder: string) => { if (folder !== '/') throw Object.assign(new Error(`ENOENT: chdir '${folder}'`), { code: 'ENOENT' }) })
  const line = enterHome({ home: () => '/home/sentinel-person', chdir, platform: 'linux' })
  expect(chdir.mock.calls.map(([folder]) => folder)).toEqual(['/home/sentinel-person', '/'])
  expect(line).toContain('ENOENT')
  expect(line).not.toContain('sentinel-person')
})
it('on Windows, the root of the home\'s drive', () => {
  const chdir = vi.fn((folder: string) => { if (folder !== 'D:\\') throw Object.assign(new Error('x'), { code: 'EPERM' }) })
  enterHome({ home: () => 'D:\\Users\\someone', chdir, platform: 'win32' })
  expect(chdir.mock.calls.at(-1)).toEqual(['D:\\'])
})
it('with no home to read, the root: / elsewhere, the system drive on Windows', () => { /* home throws; linux → '/', win32 with SystemDrive stubbed 'E:' → 'E:\\' */ })
it('stays where it is and says so when the root cannot be entered either, and never throws', () => { /* both chdir calls throw; returns a line naming both kinds */ })
```

`src/coreProcess.spec.ts`: add `vi.mock('./lib/workingFolder.js', () => ({ enterHome: vi.fn(() => { calls.push('enterHome'); return null }) }))`.
The existing expectation starts with `'enterHome'`: `['enterHome', 'ensureUtf8Locale', 'ensureHnLauncher …', 'runCore …']`.
A new case: when `enterHome` returns `'[start] sentinel line'`, `console.log` gets a line that ends with it.

`src/masterProcess.spec.ts`: mock `./lib/workingFolder.js` the same way, so no test moves the worker's folder. New case:

```ts
it('enters the home first, and says a failed entry once the Windows log is in place', () => {
  enterHome.mockImplementationOnce(() => { order.push('enterHome'); return '[start] sentinel line' })
  startMaster({ scriptPath: '/cli/cli.js' }, () => {}, 'win32', () => { order.push('redirect'); return {} })
  expect(order.slice(0, 2)).toEqual(['enterHome', 'redirect'])
  expect(log).toHaveBeenCalledWith(expect.stringMatching(/\[start\] sentinel line$/))
})
```

`e2e/startFolderGone.e2e.ts`. Each case starts an isolated daemon from a throwaway folder (`mkdtempSync(join(tmpdir(), 'harness-start-'))`)
and deletes the folder once `start()` resolves. It then creates a Claude Code agent with the fake engine in
`join(d.projectsDir, 'after-delete')`:

```ts
describe.each([
  ['under the master', {}],
  ['the core alone (__run)', { noMaster: true }],
  ['harness start -f with HARNESS_NO_MASTER=1', { foreground: true, env: { HARNESS_NO_MASTER: '1' } }],
])('a daemon whose start folder is deleted once it is up, %s', (_what, options) => {
  it('confirms a new agent, works in its home, and logs no folder failure', async () => {
    // ... create, then:
    await until('the new agent\'s launch to be confirmed', async () => { const row = await rowOf(client, id); return row && (!row.launch || row.launch.state === 'ready') ? row : null }, 90_000, 500)
    // The master and the core (d.pid, and d.corePid() when it differs) work in the daemon's HOME:
    // Linux readlink /proc/<pid>/cwd, macOS `lsof -a -p <pid> -d cwd -Fn`, compared with realpathSync(d.env.HOME!).
    expect(workingFolderOf(d.pid!)).toBe(realpathSync(d.env.HOME!))
    expect((await status(d)).discoveryError).toBeNull()
    expect(d.log()).not.toMatch(/process table unavailable|executable ownership unavailable|process\.cwd/)
  }, 300_000)
})
```

`rowOf`, `status` and `workingFolderOf` are small helpers in the file. `status` reads `/api/status` with
`d.localHeaders()`, as `e2e/updateOnItsOwn.e2e.ts` does.

- [ ] **Step 2: Run them to see them fail.**
      Run: `npx vitest run src/lib/workingFolder.spec.ts src/coreProcess.spec.ts src/masterProcess.spec.ts`. Expected:
      FAIL, `./lib/workingFolder.js` not found.
      Run on macOS, from the sources: `npx vitest run --config vitest.e2e.config.ts e2e/startFolderGone.e2e.ts`.
      Expected: each case FAILs on "the new agent's launch to be confirmed", and the log holds
      `process table unavailable`.
- [ ] **Step 3: Commit the red tests:** `test(cli): the master and the core start in the home (red)`
- [ ] **Step 4: Implement `enterHome`, the three calls and the `coreFiles.txt` line.**
- [ ] **Step 5: Run them to see them pass.**
      Run: `npx vitest run src/lib/workingFolder.spec.ts src/coreProcess.spec.ts src/masterProcess.spec.ts src/architecture.spec.ts src/startupOrder.spec.ts src/cliStartEnvironment.spec.ts`
      Run: `npx vitest run --config vitest.e2e.config.ts e2e/startFolderGone.e2e.ts`, then
      `E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/startFolderGone.e2e.ts`. Expected: PASS, all three
      cases, in both modes.
- [ ] **Step 6: Commit** `fix(cli): the master and the core work in the home, so a deleted start folder cannot break discovery`

### Task 3: The ownership key reads no folder; nothing throws synchronously

**Files:**
- Modify: `cli/src/lib/engineBin.ts:366-375` (`ownershipKey`; the start of `agentCommandOwnershipSnapshotAsync`)
- Create: `cli/src/lib/engineBin.key.spec.ts` (its own `vi.mock('node:os')` with a switchable `homedir`, and a
  temp-folder fixture as in `engineBin.async.spec.ts`)

**Interfaces:**
- `ownershipKey()` loses `process.cwd()`. The key is read inside a try. On a failure the call returns a rejected promise
  that has logged `[engine] <errorKind>: executable ownership unavailable` once. No flight is set and nothing throws.

- [ ] **Step 1: Write the failing tests**

```ts
it('answers while the working folder is gone: the key does not read it', async () => {
  const { root } = fixture()                       // PATH = root, root/codex executable
  vi.spyOn(process, 'cwd').mockImplementation(() => { throw Object.assign(new Error('ENOENT: process.cwd failed'), { code: 'ENOENT' }) })
  expect((await engineBin.agentCommandOwnershipSnapshotAsync()).engineCandidates?.get('codex')?.[0]?.path).toBe(join(root, 'codex'))
})
it('a failure reading the key\'s inputs rejects, logs its kind once, and never throws', async () => {
  fixture(); os.homedirFails = true
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  let pass!: Promise<unknown>
  expect(() => { pass = engineBin.agentCommandOwnershipSnapshotAsync() }).not.toThrow()
  await expect(pass).rejects.toMatchObject({ code: 'ENOENT' })
  expect(errors.mock.calls).toEqual([['[engine] ENOENT: executable ownership unavailable']])
})
it('the next pass answers once that failure is gone', async () => { /* homedirFails, one rejected call, then false: the next call resolves with codex */ })
it('a relative PATH entry resolves against the process\'s working folder', async () => { /* cwd spied to root; PATH = 'rel'; root/rel/codex is found */ })
```

- [ ] **Step 2: Run it to see it fail.** Run: `npx vitest run src/lib/engineBin.key.spec.ts`. Expected: the first two
      FAIL (ENOENT thrown synchronously from `ownershipKey`). The last two are pins and may pass already.
- [ ] **Step 3: Commit the red tests:** `test(cli): the ownership key reads no folder and nothing throws out of the pass (red)`
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run.** `npx vitest run src/lib/engineBin.key.spec.ts src/lib/engineBin.async.spec.ts src/lib/engineBin.spec.ts src/lib/engineBin.shell.spec.ts`. Expected: PASS.
- [ ] **Step 6: Commit** `fix(cli): the engines' ownership pass no longer reads the working folder, and a failure to read its inputs is logged, never thrown`

### Task 4: A PATH folder that cannot be listed is probed by name; one bad folder or file never fails the lookup

Evidence: on Windows, a PATH folder the user cannot list (icacls deny RX) answers `stat` ok and `opendir` EPERM. Every
pass then fails with `ENGINE_LOOKUP_FAILED`, and no engine is ever confirmed (run 44758521149). A folder that cannot be
listed may still let a file in it be read by name (traverse-only), so it is probed, never skipped outright.

**Files:**
- Modify: `cli/src/lib/engineBin.ts:330-451` (`candidateNames`, the folder and file pools, `visible`, `engineFailure`'s
  uses)
- Modify: `cli/src/lib/engineBin.async.spec.ts:76-82`: `rejects failed ownership evidence…` becomes `a candidate file
  that fails to read (EIO) is skipped, and the pass answers`
- Create: `cli/src/lib/engineBin.pathEntries.spec.ts`: mocks `node:fs/promises` `stat`, `lstat`, `opendir`, `access` and
  `realpath`, failing them from four maps: `fail.stat` and `fail.opendir` (folder path → code, that call on that
  folder only), `fail.under` (folder path → code, every call on any path inside it) and `fail.file` (file path → code,
  every call on that path).
- Modify: `.github/workflows/windows.yml:192`: `src/lib/engineBin.pathEntries.spec.ts` joins `$paths`, so the Windows CLI
  specs run it on both architectures

**Interfaces:** none outside `engineBin.ts`, except the log line ("Decided here").
- `type FolderRead = { names: Set<string>; unlisted?: string; skipped?: string }` (kinds from `errorKind`).
  `candidateNames(directory: string, wanted: Set<string>, wantedKey: string, probeNames: readonly string[]): Promise<FolderRead>`.
  It never throws and never answers `null` names.
- A folder whose `stat`, listing or second `stat` fails with `ENOENT` or `ENOTDIR` is empty and not counted (today).
- Any other error there: the folder is probed by name and `unlisted` is the first error's kind. More than 16,384 names:
  probed by name, nothing counted.
- Probing by name: for each of `probeNames` (the commands the pass looks up by name, and the Windows launch candidates'
  basenames, once each case-insensitively, in their own case), one `lstat(join(folder, name))` at a time. An answer adds
  `name.toLowerCase()` to `names`; `ENOENT` or `ENOTDIR` is absent. When every probe fails with another code, the
  folder is skipped: `skipped` is the first probe error's kind, `names` is empty, and `unlisted` is not reported.
- Caching as "Decided here" says: the generation entry keeps `unlisted`; a read whose `stat` failed, or a skipped one,
  is not cached.
- A relative entry whose `resolve()` throws is skipped under its kind and left out of the pass's paths, so nothing later
  resolves it again.
- A candidate file whose `access`, `stat` or `realpath` fails with anything is skipped. It is not counted.
- `ENGINE_LOOKUP_FAILED`, `directoryFailure` and the file pool's `failure` go. `ENGINE_LOOKUP_TIMEOUT`,
  `ENGINE_LOOKUP_CHANGED` and `ENGINE_LOOKUP_PATH_LIMIT` are unchanged.
- The PATH line, once per change of its text, as "Decided here" says. Module state holds the last text logged.

- [ ] **Step 1: Write the failing tests** (`engineBin.pathEntries.spec.ts`; `bad` and `good` are temp folders, in that
      order on PATH, each holding an executable `codex`; `warn` spies `console.warn`):

```ts
const KINDS = ['EPERM', 'EACCES', 'EINVAL', 'ELOOP', 'UNKNOWN']
const found = async () => (await engineBin.agentCommandOwnershipSnapshotAsync()).engineCandidates?.get('codex')?.map((c) => c.path)
it.each(KINDS)('a folder whose listing fails with %s is probed by name: its engine is found, and the line counts it', async (code) => {
  fail.opendir.set(bad, code)
  expect(await found()).toEqual([join(bad, 'codex'), join(good, 'codex')])
  expect(warn.mock.calls).toEqual([[`[engine] PATH: 1 folder not listed (${code}), probed by name`]])
})
it.each(KINDS)('a folder whose stat fails with %s is probed by name the same way', async (code) => { /* fail.stat; same two assertions */ })
it.each([['EACCES', 'EACCES'], ['EACCES', 'EPERM'], ['EPERM', 'EPERM'], ['EPERM', 'EACCES']])('a folder not listed (%s) whose probes fail with %s too is skipped, and the pass answers with the rest', async (listing, probes) => {
  fail.opendir.set(bad, listing); fail.under.set(bad, probes)
  expect(await found()).toEqual([join(good, 'codex')])
  expect(warn.mock.calls).toEqual([[`[engine] PATH: 1 folder skipped (${probes})`]])
})
it('ENOENT and ENOTDIR are folders with nothing in them, and are not counted', async () => { /* pin: both; no warn */ })
it('a candidate file whose read fails is skipped, not the pass', async () => { /* bad listed; fail.file join(bad,'codex') EPERM; found() → [good/codex]; no warn */ })
it('a relative entry that cannot be resolved is skipped under its kind', async () => { /* cwd throws ENOENT; PATH = 'rel' + good → '[engine] PATH: 1 folder skipped (ENOENT)' */ })
it('says the line once, again when it changes, and when everything is read again', async () => {
  // passes: bad not listed (EPERM); the same again (a cache hit: still counted); bad as before plus bad2 skipped (EACCES listing, EACCES under); none
  expect(warn.mock.calls).toEqual([
    ['[engine] PATH: 1 folder not listed (EPERM), probed by name'],
    ['[engine] PATH: 1 folder not listed (EPERM), probed by name; 1 folder skipped (EACCES)'],
    ['[engine] PATH: every folder read'],
  ])
})
it('names no folder: the lines carry kinds only', async () => { /* pin: bad is named 'sentinel-folder-name'; no console call contains it */ })
it('a running engine from a skipped folder is still matched by its name', async () => {
  // pin: claude in a skipped folder: the snapshot has no file key for it, and processTable.ts engineProcessMatch still matches by name
  expect(engineProcessMatch({ executable: 'claude', commandPath: join(bad, 'claude'), args: [join(bad, 'claude')] } as never, 'claude', snapshot).score).toBeGreaterThan(0)
})
it('a folder of more than 16,384 names is probed by name in its own read', async () => { /* pin: opendir yields 16,385 other names; codex found by lstat; no warn */ })
```

- [ ] **Step 2: Run it to see it fail.** Run: `npx vitest run src/lib/engineBin.pathEntries.spec.ts`. Expected on the
      base: the pass rejects `ENGINE_LOOKUP_FAILED` for EPERM, EINVAL, ELOOP and UNKNOWN (listing and stat), for a
      probe failing with EPERM, and for the failing candidate file; the EACCES listing and stat cases find `codex` but
      FAIL on the missing `[engine] PATH` line; `['EACCES', 'EACCES']` answers but FAILs on the line; the line-change
      case finds no line. The four cases marked pin may pass already. If a case marked red passes on the base, fix the
      test before the red commit.
- [ ] **Step 3: Commit the red tests:** `test(cli): a PATH folder that cannot be listed is probed by name, and one bad folder or file never fails the engines' lookup (red)`
- [ ] **Step 4: Implement, and change the EIO case in `engineBin.async.spec.ts` and the `windows.yml` list.**
- [ ] **Step 5: Run.** `npx vitest run src/lib/engineBin.pathEntries.spec.ts src/lib/engineBin.async.spec.ts src/lib/engineBin.key.spec.ts src/lib/engineBin.spec.ts src/lib/engineBin.shell.spec.ts src/lib/engineBinOpencode.spec.ts src/lib/paneEngineProcess.probe.spec.ts`. Expected: PASS.
- [ ] **Step 6: Commit** `fix(cli): a PATH folder the daemon cannot list is probed by name, a folder or file it cannot read is skipped and counted by its kind, never the end of every engine's confirmation`

### Task 5: A hung PATH folder, or a hung probe by name, is skipped by its own bound

**Files:**
- Modify: `cli/src/lib/engineBin.ts` (the folder pool Task 4 left)
- Modify: `cli/src/lib/engineBin.pathEntries.spec.ts` (new cases; gates that hold one folder's `stat` or `opendir`, or
  every call on a path inside it: `hold.opendir`, `hold.under`)

**Interfaces:**
- Consumes: Task 4's `candidateNames`, `FolderRead` and the line.
- Produces: `export const PATH_ENTRY_TIMEOUT_MS = 2_000`.
- A folder's whole read (`stat`, listing, probes by name, `stat`) races `PATH_ENTRY_TIMEOUT_MS`. Past it, the folder is
  skipped under `TIMEOUT` and gives no candidate file. The read goes on, and its result is not used. Until it settles,
  the folder's resolved path stays in a module set, bounded by the 1,024-entry PATH limit. Every pass skips a folder in
  that set under `TIMEOUT` without a new read. Once the read settles, the next pass reads the folder again. The pass's
  10 s deadline stays as the last resort, and the existing `bounds filesystem fan-out…` test stays green.

- [ ] **Step 1: Write the failing tests** (fake timers):

```ts
it('a folder whose listing does not answer is skipped after its own bound, and the pass answers', async () => {
  hold.opendir.add(hung)                            // never answers until released
  const pass = engineBin.agentCommandOwnershipSnapshotAsync()
  await vi.advanceTimersByTimeAsync(engineBin.PATH_ENTRY_TIMEOUT_MS)
  expect((await pass).engineCandidates?.get('codex')?.map((c) => c.path)).toEqual([join(good, 'codex')])
  expect(warn.mock.calls).toEqual([['[engine] PATH: 1 folder skipped (TIMEOUT)']])
})
it('a folder not listed (EACCES) whose probe by name does not answer is skipped after the same bound', async () => {
  fail.opendir.set(hung, 'EACCES'); hold.under.add(hung)
  // same two assertions; on the base the file pool's access on hung/codex holds the pass to its 10 s deadline
})
it('is not read again while that read is outstanding, and is read again once it ends', async () => {
  // pass 2, while held: reads.of(hung) unchanged, answers with no timer advanced; release; pass 3 reads hung again
})
it('one hung folder never holds more than one filesystem read', async () => { /* three passes while held, probes included: reads.most(hung) === 1 */ })
```

- [ ] **Step 2: Run it to see it fail.** Run: `npx vitest run src/lib/engineBin.pathEntries.spec.ts`. Expected: the new
      cases FAIL (the pass waits for its 10 s deadline and rejects `ENGINE_LOOKUP_TIMEOUT`).
- [ ] **Step 3: Commit the red tests:** `test(cli): a hung PATH folder or probe by name is skipped by its own bound (red)`
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** the Task 4 command. Expected: PASS.
- [ ] **Step 6: Commit** `fix(cli): a PATH folder that does not answer, probes by name included, is skipped after its own bound and not read again while its read is outstanding`

### Task 6: Discovery names why it could not look

**Files:**
- Modify: `cli/src/lib/terminalAgentDiscovery.ts:105-112` (`TerminalAgentProbe`), `:320-322` (the ownership catch)
- Modify: `cli/src/lib/terminalAgentReconciler.ts:351-369`
- Create: `cli/src/lib/terminalAgentDiscovery.unavailable.spec.ts`. It mocks `./engineBin.js`
  `agentCommandOwnershipSnapshotAsync` and `./processTable.js` `processRows`, with one backend and one root, as in
  `terminalAgentDiscovery.codexHome.spec.ts:17-50`.
- Modify: `cli/src/lib/terminalAgentReconciler.spec.ts` (beside `:218`)

**Interfaces:**
- Produces: `TerminalAgentProbe.ownershipFailure?: string`. It holds `errorKind(error)` of the snapshot's rejection,
  set only by the ownership catch, where `processTableAvailable` stays `false`, so the reconciler still keeps every
  agent. Its doc comment says so.
- Reconciler: `probeError` is `engine executables could not be resolved (<kind>)` when `ownershipFailure` is set, else
  `process table unavailable` as today. The warning is `[discovery] ${probeError}; keeping existing terminal agents`.
  The same text reaches `onProbeStatus`, hence `discoveryError`.

- [ ] **Step 1: Write the failing tests**

```ts
// terminalAgentDiscovery.unavailable.spec.ts
it('says the engines\' executables could not be resolved, with the kind', async () => {
  ownership.mockRejectedValue(Object.assign(new Error('ENGINE_LOOKUP_TIMEOUT'), { code: 'ENGINE_LOOKUP_TIMEOUT' }))
  expect(await probeTerminalAgents([backend], ['tmux'])).toMatchObject({ processTableAvailable: false, ownershipFailure: 'ENGINE_LOOKUP_TIMEOUT', agents: [] })
})
it('names a system code, never the words', async () => {
  ownership.mockRejectedValue(Object.assign(new Error("ENOENT: uv_cwd '/Users/sentinel-person/gone'"), { code: 'ENOENT' }))
  const probe = await probeTerminalAgents([backend], ['tmux'])
  expect(probe.ownershipFailure).toBe('ENOENT')
  expect(JSON.stringify({ ...probe, ambiguousPlacements: [] })).not.toContain('sentinel-person')
})
it('says nothing of executables when the process table itself could not be read', async () => { /* processRows → null: no ownershipFailure */ })

// terminalAgentReconciler.spec.ts
it('names the executables, not the table, when only they could not be resolved, and keeps every agent', async () => {
  // probe: { processTableAvailable: false, ownershipFailure: 'ENGINE_LOOKUP_TIMEOUT', targets: [available tmux root], agents: [], ambiguousPlacements: new Set() }
  expect(onProbeStatus).toHaveBeenCalledWith({ ready: true, error: 'engine executables could not be resolved (ENGINE_LOOKUP_TIMEOUT)' })
  expect(warn).toHaveBeenCalledWith('[discovery] engine executables could not be resolved (ENGINE_LOOKUP_TIMEOUT); keeping existing terminal agents')
  expect(onRemoved).not.toHaveBeenCalled(); expect(onDormant).not.toHaveBeenCalled()
})
```

The existing `still verifies retained panes when the process table is unavailable` test also asserts the warning
`[discovery] process table unavailable; keeping existing terminal agents`.

- [ ] **Step 2: Run them to see them fail.** Run: `npx vitest run src/lib/terminalAgentDiscovery.unavailable.spec.ts src/lib/terminalAgentReconciler.spec.ts`. Expected: FAIL (no `ownershipFailure`; the old text).
- [ ] **Step 3: Commit the red tests:** `test(cli): discovery names why it could not look (red)`
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** the same command, then all the discovery specs: `npx vitest run src/lib/terminalAgentDiscovery src/lib/terminalAgentReconciler src/core/agents/bind.spec.ts src/core/agents/restart.spec.ts src/core/agents/retarget.spec.ts`. Expected: PASS.
- [ ] **Step 6: Commit** `fix(cli): discovery says whether the process table or the engines' executables could not be read, with the error's kind`

### Task 7: The pane lookup's reason carries the kind

**Files:**
- Modify: `cli/src/lib/paneEngineProcess.ts:47-49`
- Modify: `cli/src/lib/paneEngineProcess.probe.spec.ts`

**Interfaces:** the reason becomes `ENGINE_LOOKUP_UNAVAILABLE: executable ownership could not be read (<errorKind>)`.
The new-pane and restore watchers and the reaper read it as text; nothing matches on it.

- [ ] **Step 1: Write the failing test.** The mock rejects with
      `Object.assign(new Error('ENGINE_LOOKUP_TIMEOUT'), { code: 'ENGINE_LOOKUP_TIMEOUT' })`:

```ts
expect(result).toEqual({ ok: false, unknown: true, reason: 'ENGINE_LOOKUP_UNAVAILABLE: executable ownership could not be read (ENGINE_LOOKUP_TIMEOUT)' })
// and one whose message quotes '/Users/sentinel-person' gives '(ENOENT)' and no sentinel
```

- [ ] **Step 2: Run it to see it fail.** `npx vitest run src/lib/paneEngineProcess.probe.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Commit the red test:** `test(cli): the pane lookup's reason names the ownership failure's kind (red)`
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** `npx vitest run src/lib/paneEngineProcess src/lib/nativeConversation.probe.spec.ts`. Expected: PASS.
- [ ] **Step 6: Commit** `fix(cli): the pane lookup says why executable ownership could not be read`

### Task 8: The temporary workflow also runs this branch's build

Temporary: one commit, no red test, removed by Task 9. It stays `push` to this branch only, `permissions: contents:
read`, and uses no secrets. It signs nothing, publishes nothing and writes nothing outside its run.

**Files:**
- Modify: `.github/workflows/tmp-discovery-cwd-windows-confirm.yml`

**What each matrix job (windows-latest, windows-11-arm) does after the change:**
1. **Release 0.6.78, as today.** The order is A (baseline), B (stop/start), D (deleted start folder), then C (odd PATH
   entries) last, so C's Claude Code and Codex agents are left stuck. These are the before, and they should match run
   44758521149.
2. **This branch's build.** `actions/checkout`, then setup-node `24.22.2` with the npm cache on `cli/package-lock.json`.
   In `cli/`: `npm ci; npm run bundle` with `ADAPTER_VERSION=0.0.0-dev.ci${{ github.run_id }}`.
3. **An install manifest of that build with the release's terminal host.** The six host files come from the release
   install (`harness-pty.exe`, `harness-launch.exe`, `harness.exe`, `conpty.dll`, `OpenConsole.exe`,
   `harness-serial.exe`), at the release's host version. Node comes from nodejs.org, checked against `SHASUMS256.txt`.
   Then `node cli/scripts/windows-install-manifest.mjs`, exactly as `windows.yml`'s install job does (lines 284-308).
4. **The update onto it.** `install.ps1 -Manifest` over the release install, with `HARNESS_ALLOW_UNSIGNED=1` and
   `ADAPTER_UPDATE_DISABLE=true` at user level and in the step. Then `harness start` with C's odd PATH again.
   `harness version` must print the dev version.
5. **The after scenarios on the branch build.** C-after: C's stuck agents (`Watch-Launches -Ids <C's ids>`), plus two
   new agents, with the odd PATH. Then B-after (stop/start) and D-after (start in `C:\work\gone`, delete it, new agents).
6. **Summary and artifacts.** The summary table gains a `build` column (`release` / `branch`) and a `ps errors` column:
   the count of `ps: unknown option` lines in the output of that scenario's `harness stop` and `harness start` (the
   before shows one after each; Task 10's after shows none). `$Pattern` gains `\[engine\] PATH`. The existing log artifact is kept. The manifest folder of step 3 is uploaded as
   `discovery-cwd-windows-confirm-install-<runner>` with `retention-days: 7`, for the VM round. `timeout-minutes` goes
   to 70.

- [ ] **Step 1: Make the change.** Check it with `actionlint` if it is installed; CI's `plan` job runs it anyway.
- [ ] **Step 2: Commit** `chore: the temporary Windows workflow also runs this branch's build (removed before merge)`

### Task 9: Remove the temporary workflow

Starts only once the after-run on the final fix head (Tasks 2 to 7 and 10 in) is recorded (Verification 6). It does not wait for the VM round:
the run's arm64 install artifact outlives the file (7 days), and the pull request opens only once this file is gone, so
CI runs beside the VM round.

**Files:** Delete: `.github/workflows/tmp-discovery-cwd-windows-confirm.yml`

- [ ] **Step 1:** `git rm .github/workflows/tmp-discovery-cwd-windows-confirm.yml`
- [ ] **Step 2: Commit** `chore: remove the temporary Windows reproduction workflow`

### Task 10: On Windows a lock's start marker runs no `ps`

Evidence: run 44758521149, both runners, release 0.6.78: `ps: unknown option -- o` right after every `harness stop` and
every `harness start` (Git's `ps` is on the runners' PATH). The path, and why the fix lives here: "Decided here", "The
Windows `ps`".

**Files:**
- Modify: `cli/src/lib/processLiveness.ts:34-44` (`processStartMarker`) and its module comment
- Modify: `cli/src/lib/processLiveness.spec.ts`: a new `describe('on Windows')`, outside the `describe.each` that also
  runs `hook/notify.mjs`'s copy (the hook is out of scope, below)

**Interfaces:** `processStartMarker(pid)` keeps its signature. On `process.platform === 'win32'` it returns `null` before
it reads `/proc` or runs anything. `processLockIdentity` then gives `{ startMarker: '', generationMarker: '' }` there, as
every Windows owner record already holds. The comment names run 44758521149 and says why Windows needs no marker
(`spawnLockOwnerReused` proves a reused pid from the Windows table).

- [ ] **Step 1: Write the failing test.** The platform is set with `Object.defineProperty(process, 'platform', { value: 'win32' })`
      and put back in `afterEach`:

```ts
describe('on Windows', () => {
  it('runs no ps and reads no /proc: a lock names its owner by pid alone there', () => {
    expect(processStartMarker(process.pid)).toBeNull()
    expect(processLockIdentity(process.pid)).toEqual({ startMarker: '', generationMarker: '' })
    expect(lockOwnerAlive(process.pid, '')).toBe(true)
    expect(mocks.exec).not.toHaveBeenCalled()
    expect(mocks.read).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it to see it fail.** `npx vitest run src/lib/processLiveness.spec.ts`. Expected: FAIL, `mocks.exec`
      was called with `'ps'` (the marker is `ps-c:…` from the mock).
- [ ] **Step 3: Commit the red test:** `test(cli): on Windows a lock's start marker runs no ps (red)`
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** `npx vitest run src/lib/processLiveness.spec.ts src/lib/daemonSpawnLock.spec.ts src/lib/startIfDown.spec.ts src/lib/daemonStop.spec.ts`.
      Expected: PASS. It is not added to `windows.yml`'s list: its other cases are the POSIX markers, with `ps` mocked.
- [ ] **Step 6: Commit** `fix(cli): on Windows, harness stop and start no longer run a ps found on PATH for the spawn lock's owner`

## Out of scope, seen while planning Task 10 (not planned; a proposal for the maintainers)

POSIX `ps` callers with no Windows check in the function itself. Whether a Windows caller reaches each was not checked.
- `hook/notify.mjs` `processStartMarker`: the hook's copy of the function Task 10 fixes, run on every Claude Code hook
  event; the same spec runs it, so the fix would be one more line and the shared case.
- `dsh/viewerLedger.ts:80` `processStartedAt` (an `execFileSync`, so its error output would reach the console too).
- `lib/tmux.ts:112` `isTmuxProcess`, `lib/harnessResources.ts:58` `sampleProcesses`, `lib/processTree.ts:35`
  `readTable`, `lib/processTable.ts:433, 460`, `lib/appModels.ts:252`, `lib/externalOwnerControl.ts:10`,
  `lib/sessionSearch/externals/support.ts:329`, `lib/processEvidence.ts:80, 98` (through `nativeProbe`),
  `engines/kit/downloadMarker.ts:71`, `cable/hosts/scannedApp.ts:84, 94`, `cable/hosts/vscodeTerminals.ts:63, 82`.
- Already guarded: `lib/pidFileSettle.ts`, `lib/registryPersistence.ts`, `lib/signOut.ts`.

## The pull request's body

- Platforms: macOS, Linux, Windows x64 and ARM64, and where each was tested (Verification).
- Bug 2: "a likely cause, not yet matched to the user's log". Give the evidence (run 44758521149 and the VM round) and
  every scenario tried, where, on which build, and what was seen.
- Why `lib/workingFolder.ts` joins the core's process (its `architecture.coreFiles.txt` line): every session needs it,
  because every core, the master's, `__run`'s and `start -f`'s with no master, enters the home before anything else,
  so no session depends on the folder it was started in.
- The behavior changes. Relative PATH entries resolve against the home. Every folder that cannot be listed is now probed
  by name, as an `EACCES` folder already was (a traverse-only folder can still hold an engine), and is skipped only when
  those probes fail too or the folder does not answer in 2 s; both are counted by kind in one `[engine] PATH` line, once
  per change. `EACCES` is now counted in that line, and its probes failing with another code skip the folder instead of
  failing the pass. `ENGINE_LOOKUP_FAILED` is gone, and the PATH line names the code. On Windows, an installed copy's
  master was already started outside `harness start`'s folder (Scenario D); a checkout's no longer holds that folder.
- On Windows, `harness stop` and `harness start` no longer run a `ps` found on PATH (Git's printed
  `ps: unknown option -- o` after each, run 44758521149): the spawn lock's owner record asked `ps` for a start marker
  Windows never uses. `lib/processLiveness.ts` is already a core file; no file is added. The other POSIX `ps` callers
  seen are listed as a proposal, not fixed here.
- The red-then-green runs, the receipts of Verification 9, and the run links of Verification 4, 6 and 7.

## Verification

The merge waits for the Windows ARM VM round (8), not for the user's log. The temporary workflow (6) runs on each push
to the branch (pre-approved). `cli-e2e.yml` (4) and `windows.yml` (7) are heavy: each runs once, at the final head,
after asking the orchestrator once for both, one at a time.

1. **Unit and typecheck, Linux.** PR CI's `cli-typecheck` and `cli-tests` run on the PR when it is marked ready. They
   include every spec above (`processLiveness.spec.ts`'s Windows case included) and `src/architecture.spec.ts` (the
   `coreFiles.txt` line).
2. **The new end-to-end test, this Mac.** Run it from the sources and with `E2E_BUNDLE=1`:
   `npx vitest run --config vitest.e2e.config.ts e2e/startFolderGone.e2e.ts`. It uses isolated daemons (throwaway
   home, data folder, free port, private tmux, fake engines) and a throwaway start folder the test deletes. The red run
   is the one at Task 2's red commit; all three cases pass at the final head.
3. **Daemons from the sources after the master moved, this Mac.** Run
   `npx vitest run --config vitest.e2e.config.ts e2e/paneEnv.e2e.ts e2e/stateFiles.e2e.ts e2e/twodaemons.e2e.ts e2e/deviceDialSkill.e2e.ts`
   with no `E2E_BUNDLE`, at the final head. Expected: PASS. CI runs only the bundle, so only this run shows that the
   absolute loader works.
4. **CLI end to end, Linux.** PR CI does not run `cli/e2e`. Once the orchestrator has said yes (asked once, with 7),
   start **Actions → CLI end to end → Run workflow** (`cli-e2e.yml`) on the branch once, at the final head: eight Linux shards from the bundle, plus the macOS full-disk
   job. Expected: `e2e-summary` green with `startFolderGone.e2e.ts` in it. Record the link.
5. **"An update clears it", this Mac, an isolated daemon** (the spec's own check; no CI test).
   - Build release 0.6.78's bundle from its tag in a worktree of your own under the scratchpad
     (`git worktree add <scratch>/rel-0.6.78 v0.6.78_cli`, `npm ci`,
     `ADAPTER_VERSION=0.6.78 BUNDLE_OUT_DIR=<scratch>/bundle-0.6.78 node build-bundle.mjs`). Build the final head's
     bundle at `ADAPTER_VERSION=0.6.79` the same way. Remove exactly that worktree and those folders afterwards.
   - Write a temporary, never-committed `cli/e2e/tmpUpdateClears.e2e.ts`, modeled on `e2e/update.e2e.ts`: a local
     manifest server on 127.0.0.1, the 0.6.78 bundle installed in the test's `cli` folder, and `IsolatedDaemon` with
     `scriptPath`, `startFolder` (a throwaway folder) and the update settings (`ADAPTER_UPDATE_URL`, `_CHECK_MS`,
     `_SLOT_SEC`, `HARNESS_TUI_MANIFEST_URL`). It touches no CDN and no backend.
   - Start the daemon. Delete the start folder. Create agent A with the fake engine and a first prompt, as
     `e2e/eagerHooks.e2e.ts` does, so its launch carries a native token.
   - Before the update, expect: the log repeats `[discovery] process table unavailable`. A stays `starting`, then within
     11 minutes is `held` with "Waiting to confirm the native engine process". If the fake create gets no native token,
     it fails `START_TIMEOUT` instead: record which.
   - Then offer 0.6.79. Expect: the master hands over to the new build with no manual restart, and A is confirmed
     (`launch` ready), through the restore path. A new agent B is confirmed. After the update the log has no
     `process table unavailable`, `executable ownership unavailable` or `process.cwd` line, and `/api/status`
     `discoveryError` is null.
   - Delete the temporary file. Paste the outcome into the PR.
6. **GitHub Windows runs, x64 and ARM** (the temporary workflow, on each push to the branch).
   - **Before:** run 44758521149, release 0.6.78 on both runners, alike. A PATH folder the user cannot list (icacls deny
     RX: `stat` ok, `opendir` EPERM, `access X_OK` ok) made every pass log
     `[engine] ENGINE_LOOKUP_FAILED: executable ownership unavailable`, and discovery log `process table unavailable`.
     After a restart came `[restore] <engine> · agent … · could not be surveyed · Unsurveyed`. A new Claude Code and a
     new Codex both stayed `starting` for the whole 4-minute watch. The quoted, `%VAR%`, missing-drive (`Q:`), `.` and
     WindowsApps entries gave ENOENT or ok, which are tolerated. Baseline, stop/start and the deleted start folder all
     confirmed; the folder could be deleted.
   - **Before, `ps`:** the same run printed `ps: unknown option -- o` right after every `harness stop` and every
     `harness start`, on both runners.
   - **After:** Task 8's run on the final head. Scenario C on the branch build confirms both engines, and C's agents
     stuck on 0.6.78 are confirmed after the install over it. The log has, once,
     `[engine] PATH: 1 folder not listed (EPERM), probed by name`, or `[engine] PATH: 1 folder skipped (EPERM)` if
     Windows refuses the probes by name in that folder too (record which), and no `ENGINE_LOOKUP_FAILED` or
     `process table unavailable`. B-after and D-after confirm. The `ps errors` column is 0 for every branch-build row.
     Record the link and the summary tables.
7. **The Windows CLI specs, x64 and ARM.** Once the orchestrator has said yes (the same ask as 4), start
   **Actions → Windows → Run workflow** (`windows.yml`) on the branch once, at the final head. It is heavy (it builds
   the host). Expected: the step "Contract suite against the real host, and the
   Windows CLI specs" passes with `engineBin.pathEntries.spec.ts` in it, on both runners.
8. **The Windows 11 ARM VM round** (192.168.64.5, UUID `B2D53905-133C-4DA5-92EB-3978FCC448C7`). It is shared: start only
   when harness-pm hands over the turn, and hand it back after. If everything else is green and the VM is still busy,
   ask harness-pm then.
   - **Isolation.** As `admin`, make a local standard user of our own for this round, with the Mac's key in its own
     `authorized_keys`. Do everything over `ssh <that user>@192.168.64.5`, so its `%USERPROFILE%\.harness` is its own.
     Never touch `admin`'s `C:\work\e2e` install, which is signed in to a real account, or its daemon. Stay signed out.
     Use no backend or secret. The engines stay not signed in: a login screen in the pane is enough to confirm.
   - **Release 0.6.78:** install with `install.ps1 -NoService`. Install Claude Code and Codex for that user. Put a deny-RX
     folder first on the user's own PATH (user-level, so every start and the reboot have it). Run baseline, then
     `harness stop`/`start`, then a VM reboot (`shutdown /r /t 0`, then ssh back in and `harness start`). Run the 0.6.77 →
     0.6.78 auto-update if install.ps1 can lay down 0.6.77. Read `harness.log` for `process table unavailable`,
     `ENGINE_LOOKUP_*`, `executable ownership unavailable`, `[agent] create timed out` and `[restore]`.
     Expected: the reproduction above.
   - **The branch build:** install the arm64 artifact of Verification 6 (`gh run download`) with `install.ps1 -Manifest`,
     `HARNESS_ALLOW_UNSIGNED=1` and `ADAPTER_UPDATE_DISABLE=true`, over the release. Expected: the stuck agents are
     confirmed, new Claude Code and Codex agents are confirmed with the deny-RX folder on PATH, and the log has
     `[engine] PATH: 1 folder not listed (EPERM), probed by name` (or `1 folder skipped (EPERM)`, as in 6; record
     which). Stop/start and the reboot confirm too. A start folder can be deleted. If that user's PATH has Git's
     `usr\bin`, `harness stop` and `harness start` print no `ps:` line on the branch build where 0.6.78 did; if it has no
     `ps`, record that this was not observable there.
   - **Cleanup:** `harness uninstall --yes` as that user, then remove the user and its profile. Record every scenario,
     build and outcome for the PR body.
9. **Local gates PR CI does not run.** `python3 scripts/local-checks.py --run` from a clean tree at the final commit, on
   this Mac. It selects `cli-core` (`npm run test:core`), because `src/core/main.ts` changed; nothing here touches
   `src/harnessd/` or the other gates' paths. Paste its receipts into the PR body before the PR is marked ready.
