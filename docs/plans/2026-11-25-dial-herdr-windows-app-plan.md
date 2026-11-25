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

**Spec:** `docs/plans/2026-11-25-dial-herdr-windows-app-design.md` (approved, PM 2026-11-26).

**Running tests.** The Mac is held for the tier B eval. Implementers write the tests and commit red, then green, but
run nothing until the PM frees the Mac; the main session runs each task's command on the PM's go. Each task's command
is only the vitest files it changed, from `cli/`. `npm run test:core` (100% per file over `src/services/`) is required
because `src/services/devices.ts` changes: it runs once, in phase 4, on the PM's slot. `npm run typecheck` runs with
each task's tests (interfaces change across files).

## Global Constraints

- Platforms: Windows gains the behaviour; macOS and Linux behaviour must not change (PM decision 2). Each changed path
  that has a darwin or linux branch keeps a test pinning it.
- Of the Windows table only `pid`, `ppid`, `executable` and `startMarker` are read, never `args`, `nativeArgv` or
  `commandPath` (PM decision 4, core rule 4): the rows the lookup receives are copied to those four fields.
- Several clients: the newest by start marker wins, a tie to the higher pid; a candidate with a listed app beats every
  candidate without one (PM decision 1).
- No `raise --console-of`, no Rust change: only `harness-pty raise --pid <n>` (PM decision 3).
- Nothing in `cli/src/core/`, nothing stored, `createHerdrNested` and the open scan stay off on Windows (PM decision 5).
- Bounds: at most `HERDR_CLIENTS_A_LOOKUP` (16) candidates a lookup, parent walks bounded by `WALK_PARENTS` through
  `parentChain`.
- Log lines are the existing ones: `[device] herdr client · found | none | outside | not read · processes`, and the
  raise's `[device] raise · window · raised | refused | none`. They name no pane, pid, path or image name.
- Names and copy follow `docs/naming-system.md`; comments say why (cli/AGENTS.md rule 7).

## Review Focus

1. **A named session beside the default one** (`herdr --session x` spawns its own server under its client): that
   client is no candidate, and its server is never taken for ours. Test in Task 3.
2. **A reused pid**: a client whose recorded parent pid now belongs to a newer `Code.exe` or `WindowsTerminal.exe`
   gets no app from it. Test in Task 3.
3. **Windows' default-terminal handoff** (`pwsh` from Win+R, a conhost console under `explorer.exe`): the agent is on
   herdr's page with no window, and a tap focuses the pane and raises nothing. Tests in Tasks 3 and 4.
4. **A terminal started from a herdr pane** keeps `HERDR_PANE_ID` but herdr did not make its terminal (`outside`,
   `{}`): its own hint's bundle stays its tap's. Test in Task 5.
5. **A stale Orca hint** (the server's first client was in Orca): an agent attached from Windows Terminal must not sit
   on Orca's page (`pageOf` keeps Orca's page for `app === 'orca'`). Test in Task 5, its expected app per open
   question 1.

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

> **Before this task's code lands:** check the fake tree below against Ken's VM Part 1 result (spec, "Steps for Ken's
> Windows VM / Dell", Part 1 steps 2, 4, 5, 6). If the server's parent, a client's chain or the handoff shell's
> parent differ, the tree and the expectations change first; a differing step 5 or 6 goes back to the main session as
> a question.

**Files:**
- Modify: `cli/src/cable/hosts/herdrOuter.ts` (`createHerdrOuter`; new `windowsClientOf`; `HerdrOuterDeps`)
- Test: `cli/src/cable/hosts/herdrOuter.spec.ts` (new describe "herdr's clients on Windows")

**Interfaces:**
- Consumes: `windowsPtyMaker`, `windowsName`, `parentChain`, `WindowsProcess` (Task 1); `frontAppId` (`frontApp.ts`);
  `UNKNOWN_APP`, `APP_IDS` (`hostDetect.ts`).
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

The rules (spec "Design · 2", with the PM's decisions):

1. One `windows.processes()` read; a rejection → `{}` and `not read · processes`.
2. `windowsPtyMaker(caller, rows)`; not `herdr` → `{}` and `outside`. `herdr` → `made('herdr')` is told (the same
   `MadeAnswer` path as `placeOf`), and the maker's pid is the server.
3. `windows.server(rows)` names a pid other than the server → `{ nest: 'herdr' }` (line `none`). None named → go on.
4. Candidates: rows with `windowsName === 'herdr'`, not the server, with a `startMarker`, no `herdr` among their
   parents (`parentChain(...).slice(1)`), and no `herdr` child other than the server (a child counts only when it
   started after the candidate, the reused-pid rule `parentChain` uses). The 16 newest by start marker (tie: higher
   pid).
5. Each candidate's walk (`parentChain`, nearest first, candidate included): the nearest step whose
   `frontAppId(win32.basename(executable))` is a listed app (`APP_IDS`, not `UNKNOWN_APP`) gives the candidate's app;
   the nearest that is `UNKNOWN_APP` (`WindowsTerminal.exe`, `alacritty.exe`) gives its window owner, that step's pid;
   whichever comes first ends the walk. Neither → no window.
6. Pick: the newest candidate with an app → `{ app, pid: <client pid>, nest: 'herdr' }` (`found`); else the newest
   candidate (see open question 2) with a window owner → `{ pid: <owner pid>, nest: 'herdr' }` (`none`); else
   `{ nest: 'herdr' }` (`none`). No `tty` on Windows.

The fake table (no `args`; `mark(n)` = `` `w:${134080735400000000n + BigInt(n)}` ``, so a larger pid started later):

```
explorer.exe 50                     mark(50)
└ WindowsTerminal.exe 100           mark(100)
  └ pwsh.exe 110                    mark(110)
    └ herdr.exe 120  client A       mark(120)
      └ herdr.exe 130  server       mark(130)
        └ pwsh.exe 140              mark(140)
          └ claude.exe 150  caller  mark(150), hints { HERDR_PANE_ID: 'w1:p1' }
Code.exe 200                        mark(200)
└ pwsh.exe 210                      mark(210)
  └ herdr.exe 220  client B         mark(220)
```

- [ ] **Step 1: Write the failing tests** (`lookup({ platform: 'win32', windows: { processes, server } })`, `server`
  answering `undefined` unless a case says):
  - `the newest client, in VS Code, places the agent`: `(PANE, 150)` → `{ app: 'vscode', pid: 220, nest: 'herdr' }`,
    log `found`, `made` told `'herdr'`, no `run` call.
  - `with client B gone, Windows Terminal's window`: → `{ pid: 100, nest: 'herdr' }`, log `none`.
  - `an app beats a newer client in a terminal`: client B under WT instead and an older client in `Code.exe` → the
    Code one (`app: 'vscode'`).
  - `a tie on the start marker goes to the higher pid`.
  - `a herdr under the server is no client` (`herdr.exe` 160, child of pwsh 140).
  - `a named session's client is no client` (`herdr.exe` 300 with its own child `herdr.exe` 310).
  - `a reused parent pid ends the walk`: client B's ppid 200 is a `Code.exe` with `mark(230)` → no app; with no other
    candidate → `{ nest: 'herdr' }`.
  - `a row with no start marker is left out` (client B without `startMarker` → client A's answer).
  - `the handoff console has no window`: client A's chain ends at `conhost.exe` → `explorer.exe`, client B gone →
    `{ nest: 'herdr' }`.
  - `at most 16 candidates`: 20 extra `herdr.exe` rows under one `pwsh` under `explorer.exe`, older than client B →
    still B; and 20 newer windowless ones push B out → the answer has no app (pins the bound).
  - `the table not read`: `processes` rejects → `{}`, `not read · processes`, `made` not told.
  - `a maker that is not herdr`: caller under `WindowsTerminal.exe` directly → `{}`, `outside`.
  - `the marker names another server`: `server` → `999` → `{ nest: 'herdr' }`, `made` told.
  - `on Windows with no windows deps, nothing`: `createHerdrOuter({ platform: 'win32' })(PANE, 150)` → `undefined`.
  - Existing macOS and Linux describes stay unchanged and green.
- [ ] **Step 2: Run, expect FAIL** — `cd cli && npx vitest run src/cable/hosts/herdrOuter.spec.ts`: the win32 lookups
  return `undefined`. Commit red.
- [ ] **Step 3: Implement** `windowsClientOf(deps, server, rows): ClientPlace` and the win32 branch of
  `createHerdrOuter` reusing `heldAnswers`, `said`, `skip` and the `made` plumbing of `placeOf`. `isHerdr` stays as it
  is for macOS and Linux; Windows uses `windowsName(executable) === 'herdr'`. Update the module comment: what Windows
  reads (four columns, never argv) and why the tree stands in for the socket (no pipe client pid).
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
  - In `open()`, the `tap === 'before'` branch: `bundle` → `forward(bundle)`; else Linux's `raiseWindow`; else on
    Windows, when `windowOf(agentId)` has `outer: true` and a pid, `windows.window(pid)`. Never the caller's own pid.
    (The fallback branch for a failed pane focus is open question 3: unchanged until answered.)

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
    - The Linux case "a tap on Linux brings the window forward through the raise" stays green unchanged.
- [ ] **Step 2: Run, expect FAIL** — `cd cli && npx vitest run src/cable/hosts/windowsRaise.spec.ts src/cable/hosts/open.spec.ts`:
  `window` is not a function, and no raise runs. Commit red.
- [ ] **Step 3: Implement** `window` in `createWindowsRaise` (a second `raise` form beside the `--exe` one, sharing
  `helper` and the outcome check), the `outer` field on `OpenDeps.windowOf`, and the Windows step in `open()`. Add
  `window` to each listed fake. Update the module comments of both files (the raise by pid, and why only an outer
  answer's pid).
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
    answer): `entry.agent.app = entry.outer?.app ?? <open question 1>`, `entry.bundle = entry.outer ? APP_BUNDLES[entry.outer.app] : undefined`.
    On darwin and linux, and on win32 without herdr's nest, `placeApp` is unchanged. (On Windows herdr's nest comes
    from herdr's lookup alone: the scan's nesting and Herdr's pairing are off there.)

- [ ] **Step 1: Write the failing tests** (`nested({}, undefined, { platform: 'win32' })`, hints
  `{ HERDR_PANE_ID: 'w1:p1', __CFBundleIdentifier: 'com.microsoft.VSCode' }`, the stale VS Code):
  - `on Windows a herdr client in Windows Terminal: no stale bundle, its window is the terminal's`: `made('herdr')`, then
    answer `{ pid: 100, nest: 'herdr' }` → `open` gets no `bundle`; `windowOf(id)` → `{ pid: 100, app: <Q1>, outer: true }`;
    `pageOf`'s page is `herdr`.
  - `on Windows the client's app replaces the hint's`: answer `{ app: 'cursor', pid: 220, nest: 'herdr' }` → app
    `cursor`, `open`'s bundle `APP_BUNDLES.cursor`.
  - `on Windows, told herdr before the answer, the stale bundle is already gone`: after `made('herdr')` alone, a tap's
    target has no `bundle`.
  - `on Windows no window: nothing to raise`: answer `{ nest: 'herdr' }` → no bundle, `windowOf` has no `outer`.
  - `a stale Orca hint stays off Orca's page` (Review Focus 5): hints `{ HERDR_PANE_ID, ORCA_TERMINAL_HANDLE: …,
    ORCA_AGENT_SESSION_ID: … }`, answer `{ pid: 100, nest: 'herdr' }` → the agent's page is `herdr` (expected app per
    Q1).
  - `outside herdr keeps its own bundle` (Review Focus 4): win32, answer `{}` → the hint's bundle stays.
  - `on macOS the same answer keeps the hint's bundle` (decision 2): `platform: 'darwin'`, answer
    `{ pid: 100, nest: 'herdr' }` → `open`'s bundle is `com.microsoft.VSCode`, as today.
  - Update the existing "windowOf: a nested agent is in its client's window…" expectation:
    `{ pid: 4300, app: 'terminal-app', outer: true }` (its other two lines unchanged).
- [ ] **Step 2: Run, expect FAIL** — `cd cli && npx vitest run src/cable/hosts/observed.spec.ts`: the stale VS Code
  bundle is the tap's, and `windowOf` has no `outer`. Commit red.
- [ ] **Step 3: Implement** in `windowOf` and `placeApp`, with a comment naming why (the pane inherits the first
  client's environment, spec "What Windows does today").
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

- [ ] **Step 1: Write the failing tests** (devices on `win32`, `readers.listProcesses` answering Task 3's tree with an
  `args` field on every row, a hook from caller 150 with `HERDR_PANE_ID`, `fakeWindowsRaise()`):
  - `on Windows an agent in herdr attached from VS Code is on VS Code's page, and a tap focuses the pane then raises
    Code`: the log has `[device] herdr client · found`; the apps list has `vscode`; `openAgent` runs
    `herdr agent focus <pane>` and the raise asks `app` for `com.microsoft.VSCode`.
  - `with only the Windows Terminal client, the agent is on herdr's page and a tap raises the terminal's window`:
    `[device] herdr client · none`; the page is `herdr`; the fake raise's `windows` is `[100]`.
  - `the table not read`: `listProcesses` → `[]` → `[device] herdr client · not read · processes`.
  - No log line holds a pid, `herdr.exe` or a path (`logs.filter(l => /\d{3}|herdr\.exe|\\/.test(l))` over the herdr
    client lines is empty).
- [ ] **Step 2: Run, expect FAIL** — `cd cli && npx vitest run src/services/devices.spec.ts -t "herdr"`: no herdr
  client line on Windows. Commit red.
- [ ] **Step 3: Implement** the wiring. Edit the `cli/AGENTS.md` devices row:
  - in the herdr client sentence, after "on macOS and Linux, and its tab is that client's tty (`cable/hosts/herdrOuter.ts`)":
    on Windows from the PTY host's process table (`harness-pty ps`, pid, parent, image name and start marker alone),
    its clients the `herdr.exe` processes outside any herdr pane that started no server of their own, at most 16, the
    newest started first, one in a listed app before one in none, with no tab but VS Code's and Cursor's; one in
    Windows Terminal or Alacritty is on herdr's page and a tap raises that terminal's window by its process
    (`harness-pty raise --pid`, `cable/hosts/windowsRaise.ts`);
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
      `%USERPROFILE%\.harness-dial-check`), herdr running with an agent in a pane attached from Windows Terminal.
   3. `list`: the agent's row is on herdr's page; the log has `[device] herdr client · none` (WT), never `not read`.
   4. Bring another app forward, `tap <row>`: herdr switches to the agent's pane, WT comes forward (or its taskbar
      flashes), the log counts `[device] raise · window · raised` or `refused`. **Needs Ken's eye.**
   5. Attach a second client from VS Code's integrated terminal, send a prompt so the hook runs: `list` puts the agent
      on VS Code's page, `[device] herdr client · found`.
   6. `tap <row>`: VS Code comes forward with the integrated terminal holding herdr. **Needs Ken's eye.**
   7. Detach the VS Code client, prompt again: back on herdr's page, and a tap raises WT.
   8. A named session (`herdr --session x`): the agent gets no pane row, as before.
   9. Ken sends the desk's log lines for steps 3 to 8; they name no pane, pid or path.
4. **Before Task 3's code lands:** the VM Part 1 result (sent to Ken 2026-11-26) is checked against Task 3's tree.

No new workflow is proposed: windows.yml already runs the Windows dial end to end, and the herdr steps need a person's
eye on the window that comes forward.
