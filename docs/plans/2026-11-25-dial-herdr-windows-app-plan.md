# Dial on Windows: the app that holds the herdr client — Implementation Plan

> **For agentic workers:** REQUIRED: execute with devcrew phase 3, task by task: a red commit (the failing test), then
> the code commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent in a pane of the person's own herdr on Windows goes on the page of the app that holds the herdr
client they attached from last, and a tap focuses the pane, then brings that app's window (or the terminal's window)
forward.

**Architecture:** All in the devices process (`cli/src/cable/hosts/`, wired in `cli/src/services/devices.ts`).
`herdrOuter.ts` gets a Windows branch that finds the server with `windowsPtyMaker` and the clients by the process
tree (pid, ppid, image name, start marker) of one `harness-pty ps --json` read; `windowsRaise.window(pid)` runs the
`raise --pid` the helper already ships; `observed.ts` stops taking the hint's stale bundle once herdr's lookup
confirmed the pane on Windows. Nothing in the core, nothing stored, no Rust change.

**Tech Stack:** TypeScript (Node), Vitest.

**Spec:** `docs/plans/2026-11-25-dial-herdr-windows-app-design.md` (approved, PM 2026-11-26, with its Decisions 1-6).

**Running tests.** The Mac is held for the tier B eval. Implementers write the tests and commit red, then green, but
run nothing until the PM frees the Mac; the main session runs each task's command on the PM's go. Each task's command
is only the vitest files it changed, from `cli/`. `npm run test:core` (100% per file over `src/services/`) is required
because `src/services/devices.ts` changes: it runs once, in phase 4, on the PM's slot. `npm run typecheck` runs with
each task's tests (interfaces change across files).

## Global Constraints

- Platforms: Windows gains the behaviour; macOS and Linux behaviour must not change (decision 2). Each changed path
  that has a darwin or linux branch keeps a test pinning it.
- Of the Windows table only `pid`, `ppid`, `executable` and `startMarker` are read, never `args`, `nativeArgv` or
  `commandPath` (spec, "What Windows does offer"): the rows the lookup receives are copied to those four fields.
- Several clients: the newest by start marker wins, a tie to the higher pid (decision 1); a candidate with a listed app
  beats every candidate without one, and then one with a window owner beats every one without (decision 5).
- No client in a listed app (Windows Terminal, Alacritty, no window): the agent's app is `UNKNOWN_APP` (`terminal`),
  on herdr's page, never the hint's app (decision 4).
- A tap whose `herdr agent focus` failed or was refused still raises the known window owner, as Linux's fallback does
  (decision 6).
- No `raise --console-of`, no Rust change: only `harness-pty raise --pid <n>` (decision 3).
- Nothing in `cli/src/core/`, nothing stored, `createHerdrNested` and the open scan stay off on Windows (spec, "Design · 2").
- Bounds: at most `HERDR_CLIENTS_A_LOOKUP` (16) candidates a lookup, parent walks bounded by `WALK_PARENTS` through
  `parentChain`.
- Log lines are the existing ones: `[device] herdr client · found | none | outside | not read · processes`, and the
  raise's `[device] raise · window · raised | refused | none`. They name no pane, pid, path or image name.
- Names and copy follow `docs/naming-system.md`; comments say why (cli/AGENTS.md rule 7).

## Review Focus

1. **A named session beside the default one** (`herdr --session x` spawns its own server under its client): that
   client is no candidate, and its server is never taken for ours. Test in Task 3.
2. **A reused pid**: a client whose recorded parent pid now belongs to a newer `Code.exe` or `WindowsTerminal.exe`
   gets no app from it, and the server's `ppid` (its first client's pid, kept after that client died) is never read as
   a client. Tests in Task 3.
3. **Windows' default-terminal handoff** (`pwsh` from Win+R, a conhost console under `explorer.exe`): the agent is on
   herdr's page with no window, and a tap focuses the pane and raises nothing; beside an older client in Windows
   Terminal, that terminal's window is the tap's (decision 5). Tests in Tasks 3 and 4.
4. **A terminal started from a herdr pane** keeps `HERDR_PANE_ID` but herdr did not make its terminal (`outside`,
   `{}`): its own hint's bundle stays its tap's. Test in Task 5.
5. **A stale Orca hint** (the server's first client was in Orca): an agent attached from Windows Terminal must not sit
   on Orca's page (`pageOf` keeps Orca's page for `app === 'orca'`): its app is `terminal`, its page herdr's (decision
   4). Test in Task 5.

---

### Task 1: `scannedApp.ts` — the Windows maker with its pid, and the four-column table

**Effort:** medium. **Depends on:** none.

**Files:**
- Modify: `cli/src/cable/hosts/scannedApp.ts` (`windowsPtyOwner`, `readWindowsPtyOwner`, `windowsName`)
- Test: `cli/src/cable/hosts/scannedApp.spec.ts` (describe "the host that made a Windows process's terminal", and a new
  describe "the Windows table a lookup reads")

**Interfaces:**
- Produces:
  - `export function windowsPtyMaker(pid: number, rows: readonly WindowsProcess[]): PtyMaker | undefined` — the same
    walk as today's `windowsPtyOwner`; the maker's `pid` always, its `host` when `WINDOWS_PTY_HOSTS` lists it; none
    when the caller is not in `rows` or the walk finds shells alone.
  - `windowsPtyOwner(pid, rows)` becomes `windowsPtyMaker(pid, rows)?.host` (one walk).
  - `export const windowsName` (unchanged body, now exported): lower-cased image name, `.exe` dropped.
  - `export async function readWindowsProcesses(list: () => Promise<readonly WindowsProcess[]>): Promise<WindowsProcess[]>`
    — each row copied to `{ pid, ppid, executable, startMarker? }` alone (`startMarker` only when the row has one);
    rejects with `new Error('process table not read')` on no rows. `readWindowsPtyOwner` reads through it.
  - `WindowsProcess` stays `ProcessName & { startMarker?: string }` (a `Pick` of `RunningProcess`): no `args`.

- [ ] **Step 1: Write the failing tests**
  - `windowsPtyMaker gives the herdr server's pid`: the spec doc's tree (Task 3 below), caller 150 →
    `toEqual({ pid: 130, host: 'herdr' })`; a maker no table lists (`Code.exe` as maker) → `{ pid: <its pid> }` with no
    `host`; caller missing → `undefined`; shells alone → `undefined`.
  - `readWindowsProcesses keeps four columns`: given `[{ pid: 1, ppid: 0, executable: 'herdr.exe', startMarker: 'w:1',
    args: 'herdr --secret', commandPath: 'x' }, { pid: 2, ppid: 1, executable: 'pwsh.exe', args: 'pwsh' }]` →
    `toStrictEqual([{ pid: 1, ppid: 0, executable: 'herdr.exe', startMarker: 'w:1' }, { pid: 2, ppid: 1, executable: 'pwsh.exe' }])`;
    `[]` → rejects `'process table not read'`.
  - A type check in the same spec: `const row: WindowsProcess = { pid: 1, ppid: 0, executable: 'a.exe' }` then
    `// @ts-expect-error the lookup's rows carry no command line` on `row.args` (held by `npm run typecheck`).
  - Existing `windowsPtyOwner` cases stay as they are (the host alone).
- [ ] **Step 2: Run, expect FAIL** — `cd cli && npx vitest run src/cable/hosts/scannedApp.spec.ts` (on the PM's go):
  `windowsPtyMaker`/`readWindowsProcesses` is not a function. Commit the red test.
- [ ] **Step 3: Implement** the three exports above in `scannedApp.ts`; `readWindowsPtyOwner(pid, list)` becomes
  `windowsPtyOwner(pid, await readWindowsProcesses(list))`.
- [ ] **Step 4: Run, expect PASS** — the same command, and `npm run typecheck`.
- [ ] **Step 5: Commit** `scannedApp.ts`, `scannedApp.spec.ts`.

### Task 2: `herdrClient.ts` — the server pid herdr's marker names

**Effort:** medium. **Depends on:** none.

**Files:**
- Modify: `cli/src/cable/hosts/herdrClient.ts` (`markerHerdr`)
- Test: `cli/src/cable/hosts/herdrClient.spec.ts` (inside "on Windows, over the pipe the marker names", or a sibling
  describe using the same marker fixture)

**Interfaces:**
- Produces: `export async function herdrMarkerServer(path: string, rows: readonly { pid: number; executable: string; startMarker?: string }[]): Promise<number | undefined>`
  — the pid in the marker at [path] when [rows] hold that pid as `herdr.exe` (no case) with a start marker before the
  marker's time; else none. Never rejects. One marker parse and one check, shared with `markerHerdr` (refactor
  `markerHerdr` onto the same helper; the client's behaviour is unchanged).
- Not on the `HerdrClient` interface: the lookup passes its own table, so no second table read and no fake of
  `HerdrClient` changes (deviation from the brief's `server()`, on purpose).

- [ ] **Step 1: Write the failing tests** (`herdrMarkerServer`), with the suite's marker
  (`${process.pid}:1763600000000000000`) and `herdrRow()` as rows:
  - the marker's herdr running → `process.pid`;
  - no marker file, a marker out of form, the pid missing from rows, `executable: 'node.exe'`, `startMarker` absent or
    `''`, a start after the marker's time (`w:134080736600000000`) → `undefined`.
- [ ] **Step 2: Run, expect FAIL** — `cd cli && npx vitest run src/cable/hosts/herdrClient.spec.ts`: not exported.
  Commit red.
- [ ] **Step 3: Implement** `herdrMarkerServer` on the shared check; `markerHerdr` keeps returning the `ProcessRow`
  (the client still needs `imagePath`).
- [ ] **Step 4: Run, expect PASS** — the same command; the existing Windows client cases stay green.
- [ ] **Step 5: Commit** `herdrClient.ts`, `herdrClient.spec.ts`.

### Task 3: `herdrOuter.ts` — the Windows client lookup

**Effort:** high. **Depends on:** Task 1.

The fake tree is the one Part 1 recorded on Ken's VM (spec, "The test that fails first" and "What Part 1 showed",
2026-11-26), with its pids. Known gap, no code for it in this branch (spec, "What Part 1 showed"): with several WT
windows `raise --pid` brings the WT window used last, and a client started through the Win+R handoff has no window.
No test pins either.

**Files:**
- Modify: `cli/src/cable/hosts/herdrOuter.ts` (`createHerdrOuter`; new `windowsClientOf`; `HerdrOuterDeps`)
- Test: `cli/src/cable/hosts/herdrOuter.spec.ts` (new describe "herdr's clients on Windows")

**Interfaces:**
- Consumes: `windowsPtyMaker`, `windowsName`, `parentChain`, `WindowsProcess` (Task 1); `frontAppId`, `FRONT_NONE`
  (`frontApp.ts`); `UNKNOWN_APP` (`hostDetect.ts`).
- Produces (Task 6 wires it):
  ```ts
  /** What the Windows lookup reads, given on Windows alone (services/devices.ts). */
  export interface HerdrWindowsDeps {
    /** The PTY host's table, four columns a row (scannedApp.ts readWindowsProcesses); rejects when not read. */
    processes(): Promise<readonly WindowsProcess[]>
    /** The server herdr's marker names, checked against [rows] (herdrClient.ts herdrMarkerServer); none when unknown. */
    server(rows: readonly WindowsProcess[]): Promise<number | undefined>
  }
  // HerdrOuterDeps gains: windows?: HerdrWindowsDeps
  ```
  On `win32` with no `windows`, `createHerdrOuter` answers `undefined` at once, as today. Off Windows nothing changes.

The rules (spec "Design · 2" and "What Part 1 showed", with Decisions 1 and 5). The server is a child of its first
client and keeps that pid as its `ppid` after the client dies, and Windows may give the pid to a newer process (Part 1
step 4): so nothing walks up from the server. The lookup walks up from the caller to the server (rule 2, which stops
there) and up from each client (rules 4 and 5), never past the server.

1. One `windows.processes()` read; a rejection → `{}` and `not read · processes`.
2. `windowsPtyMaker(caller, rows)`; not `herdr` → `{}` and `outside`. `herdr` → `made('herdr')` is told (the same
   `MadeAnswer` path as `placeOf`), and the maker's pid is the server.
3. `windows.server(rows)` names a pid other than the server → `{ nest: 'herdr' }` (line `none`). None named → go on.
4. Candidates: rows with `windowsName === 'herdr'`, not the server, with a `startMarker`, no `herdr` among their
   parents (`parentChain(candidate.pid, table).slice(1)`), and no `herdr` child other than the server. A `herdr` row
   is the candidate's child only when `parentChain(row.pid, table)[1]` is the candidate: `parentChain` ends at a parent
   that started after its child, so a row whose `ppid` names a pid reused by a newer process is no child of it (the
   start-marker rule, spec "Candidates"). The 16 newest by start marker (tie: higher pid).
5. Each candidate's walk (`parentChain`, nearest first, candidate included): the nearest step whose
   `frontAppId(win32.basename(executable))` is neither `FRONT_NONE` nor `UNKNOWN_APP` gives the candidate's app; the
   nearest that is `UNKNOWN_APP` (`WindowsTerminal.exe`, `alacritty.exe`) gives its window owner, that step's pid;
   whichever comes first ends the walk. Neither (`explorer.exe`, `conhost.exe`, a dead or reused parent) → no window.
6. Pick, in three tiers, the newest within a tier: the newest candidate with an app →
   `{ app, pid: <client pid>, nest: 'herdr' }` (`found`); else the newest candidate with a window owner, even when a
   newer candidate has none (decision 5) → `{ pid: <owner pid>, nest: 'herdr' }` (`none`); else `{ nest: 'herdr' }`
   (`none`). No `tty` on Windows. The answer never carries `UNKNOWN_APP` as `app`: the agent's `terminal` app is set by
   `observed.ts` (Task 5, decision 4).

The fake table, `RECORDED_WINDOWS` in the spec: pid, ppid, image name and `startMarker: mark(k)` alone, no `args`
(`mark(k)` = `` `w:${134080735400000000n + BigInt(Math.round(k * 1000))}` ``, `k` the start order below, so start
order is not pid order; a fractional `k` starts a row between two others). Part 1 gave no pid for client #3: the
fake's 3720, lower than #2's, pins that the newest is by start marker.

```
pid   ppid  image                k   role
5616  4900  explorer.exe          1   (4900 not in the table)
7588  5616  WindowsTerminal.exe   2   one process for every WT window
4008  7588  OpenConsole.exe       3   the tab's ConPTY
5512  7588  powershell.exe        4   the tab's shell
8412  5512  herdr.exe             5   client #1
5992  8412  herdr.exe             6   server (marker 5992)
2264  5992  OpenConsole.exe       7   herdr's ConPTY
8928  5992  powershell.exe        8   the pane
8976  8928  powershell.exe        9   caller (stand-in agent), hints { HERDR_PANE_ID: 'w1:p1' }
5864  5616  Code.exe             10   VS Code's main
6400  5864  Code.exe             11   VS Code's pty host
6936  6400  OpenConsole.exe      12
9264  6400  powershell.exe       13
9904  9264  herdr.exe            14   client #2
5604  5616  powershell.exe       15   Win+R, the default-terminal handoff
4168  5604  conhost.exe          16
3720  5604  herdr.exe            17   client #3, newest
```

"#2 gone" drops 9904 and 9264; "#1 gone" drops 8412 and 5512 and keeps the server's `ppid` 8412.

- [ ] **Step 1: Write the failing tests** (`lookup({ platform: 'win32', windows: { processes, server } })`, `server`
  answering `undefined` unless a case says; caller 8976 with `{ HERDR_PANE_ID: 'w1:p1' }`):
  - `the client in VS Code places the agent, before the newer one with no window`: → `{ app: 'vscode', pid: 9904,
    nest: 'herdr' }`, log `found`, `made` told `'herdr'`, no `run` call.
  - `with client #2 gone, Windows Terminal's window beats the newer handoff client` (decision 5): →
    `{ pid: 7588, nest: 'herdr' }`, log `none`.
  - `with client #1 gone too, no window`: → `{ nest: 'herdr' }`, log `none`, `made` told.
  - `a reused pid of the first client changes nothing`: #1 and #2 gone, and a row `Code.exe` 8412 (ppid 5616,
    `mark(18)`) → `{ nest: 'herdr' }` (the server's `ppid` now names a newer `Code.exe`, never its client); with #2
    kept → `{ app: 'vscode', pid: 9904, nest: 'herdr' }`.
  - `an app beats a newer client in a terminal`: a row `powershell.exe` 7700 (ppid 7588, `mark(18)`) and `herdr.exe`
    7710 (ppid 7700, `mark(19)`) → still 9904.
  - `a tie on the start marker goes to the higher pid`: `herdr.exe` 9950 (ppid 9264, `mark(14)`) → `pid: 9950`.
  - `a herdr under the server is no client`: `herdr.exe` 9990 (ppid 8928, `mark(18)`) → still 9904.
  - `a named session's client is no client`: `powershell.exe` 7100 (ppid 6400, `mark(18)`), `herdr.exe` 7110 (ppid
    7100, `mark(19)`) and its server `herdr.exe` 7120 (ppid 7110, `mark(20)`) → still 9904, never 7110.
  - `a herdr whose parent pid was reused is no child of it`: `herdr.exe` 300 (ppid 9904, `mark(13)`, started before
    client #2) → still 9904.
  - `a reused parent pid ends the walk`: 9264 replaced by a `Code.exe` 9264 (ppid 5616, `mark(20)`) → client #2 has no
    app; → `{ pid: 7588, nest: 'herdr' }`.
  - `a row with no start marker is left out`: client #2 without `startMarker` → `{ pid: 7588, nest: 'herdr' }`.
  - `at most 16 candidates`: 20 `herdr.exe` rows 20001..20020 (ppid 5604, `mark(100 + i)`, newer than all) push #1
    and #2 out → `{ nest: 'herdr' }` (inside the bound, the app tier would have kept #2); the same 20 started before
    #2 (`mark(13 + i / 100)`) → still 9904.
  - `the table not read`: `processes` rejects → `{}`, `not read · processes`, `made` not told.
  - `a maker that is not herdr`: caller `powershell.exe` 6000 (ppid 5512, `mark(18)`) → `{}`, `outside`.
  - `the marker names another server`: `server` → `1234` → `{ nest: 'herdr' }`, `made` told.
  - `on Windows with no windows deps, nothing`: `createHerdrOuter({ platform: 'win32' })(PANE, 8976)` → `undefined`.
  - Existing macOS and Linux describes stay unchanged and green.
- [ ] **Step 2: Run, expect FAIL** — `cd cli && npx vitest run src/cable/hosts/herdrOuter.spec.ts`: the win32 lookups
  return `undefined`. Commit red.
- [ ] **Step 3: Implement** `windowsClientOf(deps, server, rows): ClientPlace` and the win32 branch of
  `createHerdrOuter` reusing `heldAnswers`, `said`, `skip` and the `made` plumbing of `placeOf`. `isHerdr` stays as it
  is for macOS and Linux; Windows uses `windowsName(executable) === 'herdr'`. Update the module comment: what Windows
  reads (four columns, never argv), why the tree stands in for the socket (no pipe client pid), and why nothing walks
  up from the server (its parent is its first client's pid, kept after that client died).
- [ ] **Step 4: Run, expect PASS** — the same command, and `npm run typecheck`.
- [ ] **Step 5: Commit** `herdrOuter.ts`, `herdrOuter.spec.ts`.

### Task 4: `windowsRaise.window(pid)` and the tap that raises the client's window

**Effort:** high. **Depends on:** none.

**Files:**
- Modify: `cli/src/cable/hosts/windowsRaise.ts` (`WindowsRaise`, `createWindowsRaise`)
- Modify: `cli/src/cable/hosts/open.ts` (`OpenDeps.windowOf`, `open`)
- Test: `cli/src/cable/hosts/windowsRaise.spec.ts`, `cli/src/cable/hosts/open.spec.ts` ("a tap on Windows brings the
  app forward through the raise")
- Modify (fakes of `WindowsRaise` gain `window`, nothing else): `cli/src/cable/hosts/vscode.spec.ts`,
  `cli/src/cable/hosts/appLink.spec.ts`, `cli/src/cable/hosts/cursorFolder.spec.ts`,
  `cli/src/cable/hosts/codexApp.spec.ts`, `cli/src/testing/dialAppEval/tierA/world.ts`
  (`window: async (pid) => this.ran(['harness-pty', 'raise', '--pid', String(pid)]).code === 0`),
  `cli/src/services/devices.spec.ts` (`noWindowsRaise`, `fakeWindowsRaise`: record the pids in a `windows: number[]`)

**Interfaces:**
- Produces:
  - `WindowsRaise.window(pid: number): Promise<boolean>` — runs `harness-pty raise --pid <pid>`, counts the outcome as
    `app()` does, true for `raised`/`refused`; a pid that is not a safe integer in 1..9999999999 is `none`, counted,
    and runs nothing.
  - `OpenDeps.windowOf?(agentId): { pid?: number; app?: string; outer?: true } | undefined` — `outer: true` when the
    pid is the outer answer's (Task 5 produces it).
  - One Windows step, `ownerWindow(agentId)`: when `windows` is there and `windowOf(agentId)` has `outer: true` and a
    pid, `() => windows.window(pid)`; else none. Never the caller's own pid.
  - In `open()`, the `tap === 'before'` branch after a shown pane: `bundle` → `forward(bundle)`; else Linux's
    `raiseWindow`; else `ownerWindow(agentId)`.
  - The fallback after a pane focus that failed or was refused (decision 6, Linux's parity): the app step becomes
    `bundle` → `forward(bundle)`; else Linux's `raiseWindow`; else `ownerWindow(agentId)`; none → `false`, as today.
    The `[device] open · <adapter> · fallback` line stays as it is: logged on a failed focus with an app step, not on
    a refused one. `can()` is unchanged (the herdr pane makes the tap possible).

- [ ] **Step 1: Write the failing tests**
  - `windowsRaise.spec.ts`, "createWindowsRaise window": `window(4242)` runs
    `{ file: PTY, args: ['raise', '--pid', '4242'], timeoutMs: RUN_TIMEOUT_MS }` and is true on `raised`/`refused`,
    each counted as itself; the failure table of `app` (none, exit 2, timeout, other word, refused with exit 1, spawn
    error) → false, counted `none`; `window(0)`, `window(-1)`, `window(1.5)`, `window(2 ** 40)` → false, `none`, no
    run; no helper → false, no run.
  - `open.spec.ts` (win32, a herdr-like adapter `tap: 'before'` whose `focus` answers true, `windows.window` recorded
    in `asked` as `['window', String(pid)]`):
    - `a herdr pane with an outer window owner and no bundle: the pane, then raise --pid`: target `{ pane }`, `windowOf`
      → `{ pid: 100, app: 'terminal', outer: true }` → `asked` is `[['window', '100']]` after the focus; never `app`.
    - `a pid that is not the outer answer's is never raised`: `windowOf` → `{ pid: 150, app: 'terminal' }` → no
      `window` call.
    - `with a bundle the app comes as before`: target `{ pane, bundle: VSCODE }` → `[['app', VSCODE]]`, no `window`.
    - `the handoff console: no window, nothing raised`: `windowOf` → undefined → `asked` is `[]`, open answers true.
    - `a failed focus still raises the outer window owner` (decision 6): `focus` answers false, target `{ pane }`,
      `windowOf` → `{ pid: 100, app: 'terminal', outer: true }` → `asked` is `[['window', '100']]`, logs
      `['[device] open · herdr · fallback']`, open answers the raise's answer (true; with `onWindows([false])`, false).
    - `a refused focus raises it with no line`: `focus` answers `'refused'` (as the existing "a pane its adapter
      refuses" case) → `[['window', '100']]`, no log line.
    - `a failed focus with no window owner and no bundle: nothing`: `windowOf` → undefined → `asked` is `[]`, open
      answers false, no log line.
    - `a failed focus never raises a pid that is not the outer answer's`: `windowOf` → `{ pid: 150, app: 'terminal' }`
      → `asked` is `[]`, false.
    - `a failed focus with a bundle brings the app as before`: target `{ pane, bundle: VSCODE }` →
      `[['app', VSCODE]]`, no `window`.
    - The Linux cases "a tap on Linux brings the window forward through the raise" (including "a pane that failed logs
      the fallback and raises") stay green unchanged.
- [ ] **Step 2: Run, expect FAIL** — `cd cli && npx vitest run src/cable/hosts/windowsRaise.spec.ts src/cable/hosts/open.spec.ts`:
  `window` is not a function, no raise runs, and the failed focus answers false. Commit red.
- [ ] **Step 3: Implement** `window` in `createWindowsRaise` (a second `raise` form beside the `--exe` one, sharing
  `helper` and the outcome check), the `outer` field on `OpenDeps.windowOf`, and `ownerWindow` used by both branches
  of `open()`. Add `window` to each listed fake. Update the module comments of both files (the raise by pid, why only
  an outer answer's pid, and why a failed focus still raises it: Linux's fallback does, PM 2026-11-26).
- [ ] **Step 4: Run, expect PASS** — `cd cli && npx vitest run src/cable/hosts/windowsRaise.spec.ts src/cable/hosts/open.spec.ts src/cable/hosts/vscode.spec.ts src/cable/hosts/appLink.spec.ts src/cable/hosts/cursorFolder.spec.ts src/cable/hosts/codexApp.spec.ts`
  and `npm run typecheck`.
- [ ] **Step 5: Commit** the files above.

### Task 5: `observed.ts` — the outer answer's window, and no stale bundle on Windows

**Effort:** high. **Depends on:** none.

**Files:**
- Modify: `cli/src/cable/hosts/observed.ts` (`windowOf`, `placeApp`)
- Test: `cli/src/cable/hosts/observed.spec.ts` (describe "ObservedSource outer place")

**Interfaces:**
- Produces:
  - `windowOf(agentId): { pid: number; app: string; outer?: true } | undefined` — `outer: true` when the pid is
    `e.outer?.pid ?? e.outerPid`; otherwise as today.
  - `placeApp` on `win32` once herdr's lookup confirmed the pane (`entry.agent.nest === 'herdr'`, told by `made` or the
    answer): `entry.agent.app = entry.outer?.app ?? UNKNOWN_APP`, `entry.bundle = entry.outer ? APP_BUNDLES[entry.outer.app] : undefined`
    (decision 4: no client in a listed app is the unknown app `terminal`, on herdr's page, never the hint's app). No
    walk of the caller's parents (`learnApp`) there: the pane's parents are herdr's server, not the client's app.
    On darwin and linux, and on win32 without herdr's nest, `placeApp` is unchanged. (On Windows herdr's nest comes
    from herdr's lookup alone: the scan's nesting and Herdr's pairing are off there.)

- [ ] **Step 1: Write the failing tests** (`nested({}, undefined, { platform: 'win32' })`, hints
  `{ HERDR_PANE_ID: 'w1:p1', __CFBundleIdentifier: 'com.microsoft.VSCode' }`, the stale VS Code):
  - `on Windows a herdr client in Windows Terminal: no stale bundle, its window is the terminal's`: `made('herdr')`, then
    answer `{ pid: 100, nest: 'herdr' }` → the agent's `app` is `'terminal'`; `open` gets no `bundle`;
    `windowOf(id)` → `{ pid: 100, app: 'terminal', outer: true }`; `pageOf`'s page is `herdr`.
  - `on Windows the client's app replaces the hint's`: answer `{ app: 'cursor', pid: 220, nest: 'herdr' }` → app
    `cursor`, `open`'s bundle `APP_BUNDLES.cursor`.
  - `on Windows, told herdr before the answer, the stale app is already gone`: after `made('herdr')` alone, the agent's
    `app` is `'terminal'`, its page `herdr`, and a tap's target has no `bundle`.
  - `on Windows no window: nothing to raise`: answer `{ nest: 'herdr' }` → app `'terminal'`, no bundle, `windowOf` has
    no `outer`.
  - `a stale Orca hint stays off Orca's page` (Review Focus 5): hints `{ HERDR_PANE_ID, ORCA_TERMINAL_HANDLE: …,
    ORCA_AGENT_SESSION_ID: … }`, answer `{ pid: 100, nest: 'herdr' }` → the agent's app is `'terminal'` and its page
    `herdr`, never `orca`.
  - `outside herdr keeps its own bundle` (Review Focus 4): win32, answer `{}` → the hint's bundle stays.
  - `on macOS the same answer keeps the hint's bundle` (decision 2): `platform: 'darwin'`, answer
    `{ pid: 100, nest: 'herdr' }` → `open`'s bundle is `com.microsoft.VSCode`, as today.
  - Update the existing "windowOf: a nested agent is in its client's window…" expectation:
    `{ pid: 4300, app: 'terminal-app', outer: true }` (its other two lines unchanged).
- [ ] **Step 2: Run, expect FAIL** — `cd cli && npx vitest run src/cable/hosts/observed.spec.ts`: the agent's app is
  the hint's `vscode` (or `orca`), the stale VS Code bundle is the tap's, and `windowOf` has no `outer`. Commit red.
- [ ] **Step 3: Implement** in `windowOf` and `placeApp`, with a comment naming why (the pane inherits the first
  client's environment, spec "What Windows does today"; the PM's decision 4, 2026-11-26).
- [ ] **Step 4: Run, expect PASS** — the same command.
- [ ] **Step 5: Commit** `observed.ts`, `observed.spec.ts`.

### Task 6: `devices.ts` wiring on Windows, and the devices row

**Effort:** high. **Depends on:** Tasks 1, 2, 3, 4, 5.

**Files:**
- Modify: `cli/src/services/devices.ts` (the `createHerdrOuter` call, ~line 956; imports)
- Test: `cli/src/services/devices.spec.ts` (beside "on Windows herdr is subscribed…")
- Modify: `cli/AGENTS.md` (the `devices` row)

**Interfaces:**
- Consumes: `readWindowsProcesses` (Task 1), `herdrMarkerServer` (Task 2), `HerdrWindowsDeps` (Task 3),
  `WindowsRaise.window` (Task 4), `windowOf`'s `outer` (Task 5).
- Produces: on `win32`, `createHerdrOuter({ ...outerDeps, …, windows: { processes: () => readWindowsProcesses(listProcesses), server: (rows) => herdrMarkerServer(herdrAt.socketPath, rows) } })`;
  elsewhere no `windows`. `readWindowsPtyOwner(pid, listProcesses)` stays (it reads four columns since Task 1).
  `listProcesses` returns `RunningProcess & { startMarker?: string }` rows (`args` included); `readWindowsProcesses`
  (Task 1, landed) cuts each to `pid`, `ppid`, `executable` and `startMarker` before the lookup sees it.
- Already done by Task 4, not touched here: both Windows raise fakes in `devices.spec.ts` (`noWindowsRaise` has
  `window`, and `fakeWindowsRaise()` records each raised pid in `windows: number[]`).

- [ ] **Step 1: Write the failing tests** (devices on `win32`, `readers.listProcesses` answering Task 3's recorded tree
  with an `args` field on every row and each row's `startMarker`, a hook from caller 8976 with
  `HERDR_PANE_ID: 'w1:p1'`, `fakeWindowsRaise()`). Widen the `readers.listProcesses` fake's type (~line 219) to
  `Array<RunningProcess & { startMarker?: string }>`, the real reader's, so rows with a start marker type-check:
  - `on Windows an agent in herdr attached from VS Code is on VS Code's page, and a tap focuses the pane then raises
    Code`: the log has `[device] herdr client · found`; the apps list has `vscode`; `openAgent` runs
    `herdr agent focus <pane>` and the raise asks `app` for `com.microsoft.VSCode`.
  - `with client #2 gone, the agent is on herdr's page and a tap raises Windows Terminal's window` (the handoff
    client #3 stays, newer, with no window: decision 5 end to end): `[device] herdr client · none`; the agent's app is
    `terminal` and its page `herdr`; the fake raise's `windows` is `[7588]`, and its `apps` stays empty.
  - `the table not read`: `listProcesses` → `[]` → `[device] herdr client · not read · processes`.
  - No log line holds a pid, `herdr.exe` or a path (`logs.filter(l => /\d{3}|herdr\.exe|\\/.test(l))` over the herdr
    client lines is empty).
- [ ] **Step 2: Run, expect FAIL** — `cd cli && npx vitest run src/services/devices.spec.ts -t "herdr"`: no herdr
  client line on Windows. Commit red.
- [ ] **Step 3: Implement** the wiring. Edit the `cli/AGENTS.md` devices row:
  - in the herdr client sentence, after "on macOS and Linux, and its tab is that client's tty (`cable/hosts/herdrOuter.ts`)":
    on Windows from the PTY host's process table (`harness-pty ps`, pid, parent, image name and start marker alone),
    its clients the `herdr.exe` processes outside any herdr pane that started no server of their own, at most 16, the
    newest started first, one in a listed app before one in none and one in a window before one in none, with no tab
    but VS Code's and Cursor's; an agent whose client is in no listed app is on herdr's page as the unknown app, never
    the app its pane's environment names (herdr's server keeps its first client's), and where that client is in
    Windows Terminal or Alacritty a tap raises that terminal's window by its process, also when herdr's focus of the
    pane failed (`harness-pty raise --pid`, `cable/hosts/windowsRaise.ts`);
  - "neither is followed on Windows, where tmux runs only inside WSL and herdr's lookup of the app holding its client
    is macOS and Linux only" → "…and herdr's client has no tab there".
- [ ] **Step 4: Run, expect PASS** — `cd cli && npx vitest run src/services/devices.spec.ts` and `npm run typecheck`.
  `npm run test:core` runs once in phase 4 on the PM's slot.
- [ ] **Step 5: Commit** `devices.ts`, `devices.spec.ts`, `cli/AGENTS.md`.

---

## Verification

1. **Unit tests, local, on the Mac** (on the PM's go; the Mac is held for the tier B eval): each task's vitest files,
   `npm run typecheck`, and in phase 4 `npm run test:core` once (100% for `src/services/devices.ts`). Record them in
   the pull request.
2. **windows.yml on GitHub** (`workflow_dispatch`, Actions → Windows → Run workflow; also PR CI's `windows-e2e`, which
   `scripts/ci-plan.py` selects for `cli/src/cable/` paths, so no extra run is started): it
   runs its own listed Windows specs and `e2e/dialWindows*.e2e.ts` on a stand-in dial. It does not run this plan's
   `cable/hosts` specs (they are platform-independent fakes run by the unit suite); it shows the Windows daemon and
   dial still work with the branch.
3. **Ken's Windows VM / Dell, Part 2** (spec, "Steps for Ken's Windows VM / Dell"), run by Ken through the PM; the
   tester cannot reach the VM. The VM's test user only, the stand-in agent or a test-account Claude Code, herdr 0.9.5;
   names, pids and parents only, never command lines.
   1. Bundle the branch on the Mac (`cd cli && node scripts/windows-dial-e2e/bundle.mjs <out>`, on the PM's slot),
      copy `<out>` to the VM (`cli/scripts/windows-dial-e2e/README.md`: the release's signed `node.exe` and
      `harness-pty.exe`; the spec says `raise --pid` ships, and a helper without `raise` leaves step 4's raise unchecked, as the README says).
   2. Start the desk on the stand-in dial (`desk.mjs --own-account`, the test user's own homes in
      `%USERPROFILE%\.harness-dial-check`), herdr running with an agent in a pane attached from one Windows Terminal
      window (a second WT window may come forward instead: the known gap).
   3. `list`: the agent's row is on herdr's page; the log has `[device] herdr client · none` (WT), never `not read`.
   4. Bring another app forward, `tap <row>`: herdr switches to the agent's pane, WT comes forward (or its taskbar
      flashes), the log counts `[device] raise · window · raised` or `refused`. **Needs Ken's eye.**
   5. Attach a second client from VS Code's integrated terminal, send a prompt so the hook runs: `list` puts the agent
      on VS Code's page, `[device] herdr client · found`.
   6. `tap <row>`: VS Code comes forward with the integrated terminal holding herdr. **Needs Ken's eye.**
   7. Detach the VS Code client, prompt again: back on herdr's page, and a tap raises WT.
   8. A named session (`herdr --session x`): the agent gets no pane row, as before.
   9. Ken sends the desk's log lines for steps 3 to 8; they name no pane, pid or path.
4. **Part 1 (done, Ken's VM, 2026-11-26):** its tree is Task 3's fake table. Its known gap is not checked here: with
   several WT windows a tap may raise the WT window used last, and a Win+R handoff client has no window (spec, "What
   Part 1 showed"). Part 2 step 2 opens one WT window so step 4 checks the raise itself.

No new workflow is proposed: windows.yml already runs the Windows dial end to end, and the herdr steps need a person's
eye on the window that comes forward.
