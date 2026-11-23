# Dial on Windows: a held Orca or herdr pane is told from the agent's own — Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with devcrew phase 3. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** On Windows the devices read who made an agent's terminal from the process table they already read, so an Orca
or herdr pane that another program made is held (a tap alone, the dial follows the agent's own hooks) instead of taking
the agent's words at the wrong prompt. This turns eval `a/win32/O6` `focus.lands` and `focus.latency` green.

**Architecture:** A pure walk, `windowsPtyOwner` in `cable/hosts/scannedApp.ts`, names the first parent of the caller
that is not a shell, a launcher or a shim of the caller, and maps it through a Windows-only `WINDOWS_PTY_HOSTS`.
`services/devices.ts` wires it on win32 over `listProcesses` (the observed source's own table read, the PTY host's
table on Windows), which now keeps the `w:<FILETIME>` start marker so `parentChain` ends at a reused pid. The Orca and
herdr adapters drop their win32 exception: a pane takes words only when `ptyOwner` names its host, as on macOS and
Linux.

**Tech Stack:** TypeScript, Vitest (`cli/`).

**Spec:** `docs/plans/2026-11-23-dial-orca-windows-held-pane-design.md` (approved). Executors read both.

## Global Constraints

- Platforms: Windows (behavior); macOS and Linux unchanged, and the tests run there.
- `PTY_HOSTS`, `ptyHostOf`, `readPtyOwner`, `readMadeBy` and every macOS/Linux path are unchanged.
- `WINDOWS_PTY_HOSTS`: `orca` → `orca`, `herdr` → `herdr`, `wezterm-gui` → `wezterm`, `wezterm-mux-server` → `wezterm`
  (keys are names after `win32.basename`, a trailing `.exe` dropped, lower-cased).
- Skipped parents: `pwsh`, `powershell`, `cmd`, `bash`, `sh`, `node`, and any parent whose name equals the caller's own
  (same normalisation) while no shell has been passed (final review: one above a shell is another agent). Nothing else.
- A process name is outside text: matched and dropped, never kept, logged or put in an error.
- No new process, no Rust change, no new dependency, no polling. One table read per new caller process (the existing
  `learnPtyOwner` path, `TTY_RETRY_MS` retry).
- `wezterm.ts` is not edited.
- The dial eval's files are not edited, except `cli/src/testing/dialAppEval/baseline.json` (Task 5). Never read
  `cli/src/testing/dialAppEval/heldOut.ts`.
- Comments say why; the comments saying "Windows reads no maker" / "no `ps`" about the pane maker go (`observed.ts`
  `ptyOwner` dep, `devices.ts` win32 argument, `orca.ts` and `herdr.ts` `paneOf`). The eval's note in
  `tierA/steps/sessions.ts` stays.
- Commit messages end with the attribution line the session gives. devcrew commits; this plan commits nothing.

## Review Focus

1. **A full Windows path and odd case** (`C:\Users\someone\AppData\Local\Programs\Orca\Orca.exe`, `ORCA.EXE`): names
   `orca`. Task 2 tests both.
2. **The walk cut short** (an elevated Orca whose row the PTY host dropped, so the shell's parent is not in the table;
   or the caller already gone): answers `undefined`, so the pane is held and `[device] orca · held` is logged once.
   Task 2 (unit) and Task 4 (`devices.spec.ts`, the held case) test it.
3. **A table that could not be read** (`listProcesses` answers `[]`): the read rejects, the pane stays held, and
   `[observed] pty · not read · <kind>` is logged with no pid or name. Task 4 tests it.
4. **A Codex npm shim chain** (`codex.exe` ← `node.exe` ← `cmd.exe` ← `pwsh.exe` ← `Orca.exe`) and a Scoop/Volta shim
   bearing the caller's name (`claude.exe` ← `claude.exe` ← `pwsh.exe` ← `Orca.exe`): names `orca`. Task 2.
5. **No process name in any log line** on the held path (`Code.exe` never appears in the devices' logs). Task 4 asserts
   it.

---

### Task 1: `listProcesses` keeps the Windows start marker

**Effort:** medium. **Depends on:** none.

**Files:**
- Modify: `cli/src/lib/sessionSearch/externals/support.ts` (`listProcesses` returns
  `Array<RunningProcess & { startMarker?: string }>`, the field's one-line doc: the Windows `w:<FILETIME>` start, kept so
  a parent walk ends at a reused pid). `externals/types.ts` is on the core's file list and is NOT touched (orchestrator,
  2026-11-23).
- Test: `cli/src/lib/sessionSearch/externals/support.spec.ts`

**Interfaces:**
- Produces: `listProcesses()` rows carry `startMarker` exactly when `windowsStartTime(row.startMarker) !== null`
  (`cli/src/lib/windows/treeKill.ts`); every other row is unchanged.

- [ ] **Step 1: Write the failing test** in `support.spec.ts`, beside `lists no processes when ps cannot be read…`:
  `it('keeps a Windows start marker, and adds none to any other row')`: with
  `row = { pid: 5, parentPid: 1, executable: 'claude.exe', args: 'claude', startMarker: 'w:133456789012345678' }`,
  `expect(await listProcesses(async () => [row])).toEqual([{ pid: 5, ppid: 1, executable: 'claude.exe', args: 'claude',
  startMarker: 'w:133456789012345678' }])`; and for a `ps` lstart row (`'Sun Sep 27 09:05:03 2026'`) and `'soon'`,
  `expect(result[i]).not.toHaveProperty('startMarker')`.
- [ ] **Step 2: Run it to see it fail:** `cd cli && npx vitest run src/lib/sessionSearch/externals/support.spec.ts`.
  Expected: FAIL, the Windows row has no `startMarker`.
- [ ] **Step 3: Implement:** widen `listProcesses`' return type in `support.ts` with the optional field; in its map spread
  `startMarker: row.startMarker` when `windowsStartTime(row.startMarker) !== null`.
- [ ] **Step 4: Run to pass:** the same command, then `npm run typecheck`. Expected: PASS, no type errors.
- [ ] **Step 5: Commit** (`support.ts`, `support.spec.ts`).

### Task 2: `windowsPtyOwner` and `readWindowsPtyOwner`

**Effort:** high. **Depends on:** none.

**Files:**
- Modify: `cli/src/cable/hosts/scannedApp.ts`
- Test: `cli/src/cable/hosts/scannedApp.spec.ts`

**Interfaces:**
- Produces:
  - `export type WindowsProcess = ProcessName & { startMarker?: string }`
  - `export function windowsPtyOwner(pid: number, rows: readonly WindowsProcess[]): string | undefined`
  - `export async function readWindowsPtyOwner(pid: number, list: () => Promise<readonly WindowsProcess[]>): Promise<string | undefined>`
    (a `() => Promise<RunningProcess[]>` such as `listProcesses` is assignable to `list`).
  - Private `WINDOWS_PTY_HOSTS` (Global Constraints) and a name normaliser: `win32.basename(name)` (from
    `node:path`), trailing `.exe` dropped case-insensitively, lower-cased.
- Consumes: `parentChain` (existing, already ends at a parent whose `w:` marker is later than its child's).

- [ ] **Step 1: Write the failing tests** in a new `describe('the host that made a Windows process\'s terminal')` after
  `the host that owns a process's terminal, read`, using a small `win(rows: [pid, ppid, name, marker?][])` helper:
  - `names orca for an agent in a shell Orca made`: `[[10, 9, 'claude.exe'], [9, 8, 'pwsh.exe'], [8, 1, 'Orca.exe']]`
    → `'orca'`; the same with `8`'s name `C:\Users\someone\AppData\Local\Programs\Orca\Orca.exe` and `ORCA.EXE` → `'orca'`.
  - `passes cmd and node, and a shim of the caller's own name`: `codex.exe` ← `node.exe` ← `cmd.exe` ← `pwsh.exe` ←
    `Orca.exe` → `'orca'`; `claude.exe` ← `claude.exe` ← `powershell.exe` ← `Orca.exe` → `'orca'`; `bash.exe` and
    `sh.exe` between → `'orca'`.
  - `names herdr and wezterm for theirs`: `… ← pwsh.exe ← herdr.exe` → `'herdr'`; `wezterm-gui.exe` → `'wezterm'`;
    `wezterm-mux-server.exe` → `'wezterm'`.
  - `names none for a terminal another program made`: `claude.exe` ← `pwsh.exe` ← `Code.exe` → `undefined`;
    `claude.exe` ← `pwsh.exe` ← `eval-terminal` ← `Orca.exe` → `undefined` (the first other parent decides).
  - `names none when a parent started after its child`: `[[10, 9, 'claude.exe', 'w:200'], [9, 8, 'pwsh.exe', 'w:150'],
    [8, 1, 'Orca.exe', 'w:300']]` → `undefined`; with `8` at `'w:100'` → `'orca'`.
  - `names none for a caller not in the table, a walk of shells alone, or a shell whose parent is gone`: pid 99 absent
    → `undefined`; `claude.exe` ← `pwsh.exe` (ppid 1) → `undefined`; `claude.exe` ← `pwsh.exe` (ppid 8, no row 8)
    → `undefined`.
  - `macOS and Linux names are not read here, and Windows names not there`: `windowsPtyOwner` over
    `… ← 'Orca Agents'` → `undefined`; `readPtyOwner(10, table([[10, 9, 'claude', 'ttys003'], [9, 8, '-zsh',
    'ttys003'], [8, 1, '/Applications/Orca.app/Contents/MacOS/Orca']]), …)` → `undefined` (macOS's `Orca` is no host).
  - `readWindowsPtyOwner rejects on an empty table and answers the walk otherwise`:
    `await expect(readWindowsPtyOwner(10, async () => [])).rejects.toThrow('process table not read')`; over the first
    Orca table → `'orca'`; the error message holds no process name.
- [ ] **Step 2: Run to see them fail:** `cd cli && npx vitest run src/cable/hosts/scannedApp.spec.ts`. Expected: FAIL,
  `windowsPtyOwner` / `readWindowsPtyOwner` not exported.
- [ ] **Step 3: Implement** both functions and `WINDOWS_PTY_HOSTS` beside `PTY_HOSTS`. `windowsPtyOwner`: take
  `parentChain(pid, new Map(rows.map(r => [r.pid, r])))`; empty → `undefined`; drop the caller; pass parents whose
  normalised name is a skipped one or the caller's; the first other one maps through `WINDOWS_PTY_HOSTS` (with
  `Object.hasOwn`), else `undefined`; a walk with no such parent → `undefined`. `readWindowsPtyOwner`: `await list()`;
  no rows → `throw new Error('process table not read')`; else `windowsPtyOwner(pid, rows)`. Doc comments say why
  (ConPTY: the maker starts the shell as its own child; Orca's terminal host keeps the app's image name on Windows;
  macOS's `Orca` is not its terminal host, so the tables stay apart). Update the file's header comment to name the
  Windows walk.
- [ ] **Step 4: Run to pass:** the same command and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** (`scannedApp.ts`, `scannedApp.spec.ts`).

### Task 3: The Orca and herdr adapters hold a pane on Windows as elsewhere

**Effort:** high. **Depends on:** none.

**Files:**
- Modify: `cli/src/cable/hosts/orca.ts` (`paneOf`, ~line 233-239), `cli/src/cable/hosts/herdr.ts` (`paneOf`, ~line 91-97)
- Test: `cli/src/cable/hosts/orca.spec.ts` (`the agent's own terminal`), `cli/src/cable/hosts/herdr.spec.ts`
  (`the agent's own pane`)

**Interfaces:**
- Produces: on every platform, `paneOf` gives the bare handle / pane id only when `place.ptyOwner === 'orca'`
  (`'herdr'`); otherwise the `held:` pane, logging `[device] orca · held` (`[device] herdr · held`) once a caller when
  `ptyOwner !== undefined`.

- [ ] **Step 1: Write the failing tests:** replace each `Windows: the agent's own, as today` case with
  `Windows: the agent's own only when Orca made its terminal, as elsewhere` (herdr: `…when herdr made it…`):
  `logged('win32')`; `madeBy('orca')` → `own`; `undefined`, `null`, `'wezterm'` → `held`;
  `expect(logs).toEqual(['[device] orca · held'])` (one line: `null` and `'wezterm'` share caller pid 100). The herdr
  case: `madeBy('herdr')` → `pane('w1:p2')`, the others → `held`, one `[device] herdr · held`.
- [ ] **Step 2: Run to see them fail:** `cd cli && npx vitest run src/cable/hosts/orca.spec.ts src/cable/hosts/herdr.spec.ts`.
  Expected: FAIL, win32 still answers the own pane.
- [ ] **Step 3: Implement:** drop `deps.platform === 'win32' ||` in `orca.ts` and `deps.platform !== 'win32' &&` in
  `herdr.ts`; rewrite each comment without "Windows reads no maker". `deps.platform` stays where else it is read.
- [ ] **Step 4: Run to pass:** the same command. Expected: PASS.
- [ ] **Step 5: Commit** (the four files).

### Task 4: The devices read the maker on Windows

**Effort:** high. **Depends on:** Task 2 (imports `readWindowsPtyOwner`), Task 3 (its held case passes only once the
adapters hold on win32).

**Files:**
- Modify: `cli/src/services/devices.ts` (the `ptyOwner` argument, ~line 837-838; the import from `scannedApp.js`)
- Modify: `cli/src/cable/hosts/observed.ts` (the `ptyOwner` dep's doc, ~line 130-131: absent now means no reader was
  given, not Windows)
- Modify: `cli/AGENTS.md` (the devices row: replace "and Orca and herdr on Windows as before (`cable/hosts/orca.ts`,
  `herdr.ts`, `herdrSource.ts`)" with words saying Orca and herdr on Windows are held as elsewhere, the maker read on
  Windows from the PTY host's table (`listProcesses`) past shells and launchers, `scannedApp.ts` `windowsPtyOwner`)
- Test: `cli/src/services/devices.spec.ts`

**Interfaces:**
- Consumes: `readWindowsPtyOwner(pid, list)` (Task 2); `listProcesses` (`lib/sessionSearch/externals/support.ts`).
- Produces: on win32 the observed source's `ptyOwner` is `(pid) => readWindowsPtyOwner(pid, listProcesses)`; elsewhere
  unchanged.

- [ ] **Step 1: Write the failing tests.** Make the `support.js` mock's `listProcesses` a hoisted
  `readers.listProcesses = vi.fn(async () => [] as RunningProcess[])`, reset to `[]` where the other readers are reset.
  Then, near `an agent with an Orca handle lists v and f…`, on `startHere({ orca: { ...orca, platform: 'win32' } })`
  with a `session-start` hook naming `ORCA_TERMINAL_HANDLE: HANDLE` for caller 4242:
  - `on Windows an agent in a shell Orca made takes its words`: `listProcesses` gives `claude.exe` (4242) ← `pwsh.exe`
    (4000) ← `C:\Users\someone\AppData\Local\Programs\Orca\Orca.exe` (3900, ppid 1); after `landed()`, `sendTurn` →
    `{ ok: true }`, a `terminal send --terminal HANDLE …` run is recorded, `said()` holds `[device] voice · orca`;
    `readers.processes` and `readers.tty` were not called.
  - `on Windows an agent in a terminal another program made inside Orca is held`: the same with `Code.exe` at 3900; no
    `terminal send` run; the words do not reach the Orca terminal (as the Linux held case asserts); the logs hold
    `[device] orca · held` once and no line contains `Code.exe`.
  - `on Windows a table not read keeps the pane held and is logged`: `listProcesses` gives `[]`; no `terminal send`;
    a log line starting `[observed] pty · not read · `, with no pid or name in it.
  Run the whole `devices.spec.ts` once too: any existing win32 case that now changes because the Orca or herdr pane is
  held gets a table naming its host through `readers.listProcesses` (keeping what it tests), never a loosened assert.
- [ ] **Step 2: Run to see them fail:** `cd cli && npx vitest run src/services/devices.spec.ts`. Expected: all three
  FAIL: with Task 3 in and no reader on win32, every Orca pane is held (no `terminal send`) and neither log line comes.
- [ ] **Step 3: Implement:** on win32 pass `(pid) => readWindowsPtyOwner(pid, listProcesses)`; replace the
  "Windows has no `ps`…" comment with why (the PTY host's table, which the observed source already reads, gives the
  maker; `listProcesses` answers `[]` for a failed read, which `readWindowsPtyOwner` turns into a rejection). Edit the
  `observed.ts` doc and the `cli/AGENTS.md` row.
- [ ] **Step 4: Run to pass:** `npx vitest run src/services/devices.spec.ts src/cable/hosts/observed.spec.ts
  src/architecture.spec.ts`, `npm run typecheck`, and `npm run test:core` (100% per file: `devices.ts`' new arrow is run
  by the cases above). Expected: PASS. `npx vitest run src/testing/dialAppEval/` is expected to fail on `matches the
  baseline` alone (a rise on `a/win32/O6`); Task 5 fixes it.
- [ ] **Step 5: Commit** (`devices.ts`, `devices.spec.ts`, `observed.ts`, `cli/AGENTS.md`).

### Task 5: The dial eval baseline

**Effort:** medium. **Depends on:** Tasks 1-4 (the baseline is written from the branch's final code). Runs only in the
eval turn the orchestrator gives (4th in the queue), when no other `eval:dial-apps` runs.

**Files:**
- Modify: `cli/src/testing/dialAppEval/baseline.json` (written by the command, never by hand)

- [ ] **Step 1: The failing test** is tier A's `matches the baseline`: `cd cli && npx vitest run
  src/testing/dialAppEval/dialAppEval.spec.ts` FAILs, reporting `a/win32/O6/focus.lands` and `focus.latency` risen.
- [ ] **Step 2: Keep the old baseline:** `git show HEAD:cli/src/testing/dialAppEval/baseline.json >
  /tmp/dial-eval-orca-win-before.json`.
- [ ] **Step 3: Check no other eval runs:** `ps ax -o pid,command | grep -E 'eval:dial-apps|dialAppEval/run.ts' | grep -v
  grep` prints nothing; otherwise wait for the orchestrator.
- [ ] **Step 4: Run both tiers and write the baseline:** `cd cli && caffeinate -i env TMPDIR=/tmp
  DIAL_EVAL_OUT=/tmp/dial-eval-orca-win npm run eval:dial-apps -- --update-baseline`. Expected: exit 0, `Gate: passed`,
  `baseline written`.
- [ ] **Step 5: Judge it** with Verification item 3's script; all its conditions hold.
- [ ] **Step 6: Run** `npx vitest run src/testing/dialAppEval/`. Expected: PASS, `matches the baseline` green.
- [ ] **Step 7: Commit** (`baseline.json`), the message naming Orca's score before and after.

---

## Verification

Platforms the pull request names: Windows (behavior), macOS and Linux (unchanged; tests run there). Nothing runs
against production, a real account's data, the everyday daemon (port 18473), the real `~/.claude`, `~/.codex` or a real
Orca on this Mac: the unit specs and tier A mock every reader of the machine; tier B's e2e files run their own daemon,
fake backend and fakes in throwaway homes (`cli/e2e/harness/`).

1. **Unit, per changed file** (`cd cli`, this Mac, final head): `npx vitest run
   src/lib/sessionSearch/externals/support.spec.ts src/cable/hosts/scannedApp.spec.ts src/cable/hosts/orca.spec.ts
   src/cable/hosts/herdr.spec.ts src/cable/hosts/observed.spec.ts src/cable/hosts/wezterm.spec.ts
   src/services/devices.spec.ts src/architecture.spec.ts src/testing/dialAppEval/` and `npm run typecheck`. Seen: all
   pass.
2. **Local gates PR CI does not run** (`docs/validation-and-release.md`, `cli/AGENTS.md` rule 4): from a clean tree at
   the final commit, `python3 scripts/local-checks.py --run`; paste its output into the PR body. It runs
   `npm run test:core`, which applies because `src/services/devices.ts` changes (100% per file). `test:harnessd` does
   not apply (no `src/harnessd/` change), nor `test:portability`, `test:resume`, `test:orchestrator`, `test:sharing`,
   `test:remote-viewers`, `test:local-models` (none of their files change). No serial or PTY spec changes. Core
   untouched: `git diff --stat origin/main -- cli/src/core cli/src/architecture.coreFiles.txt
   cli/src/lib/sessionSearch/externals/types.ts` prints nothing.
3. **The dial eval, both tiers, on this Mac** (no workflow runs it; the orchestrator gives this item the eval turn, 4th
   in the queue, and it runs only when Task 5 Step 3 finds no other `eval:dial-apps`): Task 5 Step 4. Then, from `cli/`:

   ```bash
   node --input-type=module -e '
   import { readFileSync, readdirSync } from "node:fs"
   const out = "/tmp/dial-eval-orca-win"
   const before = JSON.parse(readFileSync("/tmp/dial-eval-orca-win-before.json", "utf8")).checks
   const now = new Map()
   for (const f of readdirSync(out).filter((n) => /^results-[ab]-\w+\.json$/.test(n)))
     for (const r of JSON.parse(readFileSync(`${out}/${f}`, "utf8")).results)
       if (!(r.tier === "b" && r.timed)) now.set(`${r.tier}/${r.platform}/${r.scenario}/${r.check}`, r.score)
   const moved = (up) => [...now].filter(([k, s]) => k in before && (up ? s > before[k] : s < before[k])).map(([k]) => k).sort()
   console.log(`fell: ${moved(false).join(", ") || "none"}`)
   console.log(`rose: ${moved(true).join(", ") || "none"}`)
   process.exit(moved(false).length > 0 ? 1 : 0)'
   ```

   Pass: exit 0 (no untimed check of any app fell; a timed tier B entry moving between its latency bands is noise, not
   a drop, `docs/plans/2026-11-21-dial-app-eval-design.md`); `rose` holds `a/win32/O6/focus.lands` and
   `a/win32/O6/focus.latency` (0 → 1); the report's Orca score is above the old baseline's; `Gate: passed` (wrong-session
   sends 0; any wrong send stops the branch and goes to the PM); `baseline.json` updated in this branch (Task 5).
4. **PR CI, selected by the paths** (no extra run): `cli-typecheck`, `cli-tests`, `process-checks`; `linux-e2e` runs the
   dial eval's six files (a `cli/src/cable/hosts/` change) and the Orca files (`orca.ts` changes); `dial-hosts`;
   `windows-e2e` x64 (a `cli/src/cable/` change). No repo workflow is started by hand.
5. **Windows check (Ken's side)**, held for the user and the orchestrator, not run by a tester. It needs Ken, the
   Windows VM (`ken-side-test-machines`: PR, head SHA and these steps go to ken-pm) and a test login for Claude Code
   there; nothing on Diego's machines. The PR body carries these steps and their result; the merge waits for it.
   1. On the Windows VM, install the Harness CLI built from the PR head (the VM's usual dev install), Harness Device and
      Orca; sign Harness in with the test account;
      plug in the dial. Neither the daemon nor Orca runs as administrator: in Task Manager's Details, add the
      "Elevated" column and check both say No.
   2. In Orca terminal 1 start Claude Code (agent A).
   3. In Orca terminal 2 run `code .`; in VS Code's integrated terminal start Claude Code (agent B).
   4. Record each agent's parent chain, names only, in PowerShell:
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"; while ($p) { $p.Name; $p = Get-CimInstance
      Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" }`. Seen: A reaches `Orca.exe` past only shells
      (`pwsh.exe`, `powershell.exe`, `cmd.exe`, `bash.exe`, `node.exe`); B reaches `Code.exe`.
   5. On the dial pick agent A and speak a short sentence: it lands at A's prompt in Orca terminal 1.
   6. Pick agent B and speak: nothing is typed into Orca terminal 2; the devices' log has `[device] orca · held` once.
   7. Type a prompt in agent B in VS Code: the dial moves to B.
   8. If the VM has herdr, repeat 2-6 with an agent in a herdr pane (A reaches `herdr.exe`) and a terminal started from
      that pane; if it has WezTerm, check an agent in a WezTerm pane takes the dial's words. Else the PR says each was
      not checked.
6. **PR body** carries: the two limits the spec names (a console window opened from an Orca shell with `start` keeps
   the Orca shell as its parent, so it is read as Orca's; a Node program that makes terminals inside an Orca terminal,
   such as `code serve-web`, is passed as a launcher; both were Orca's own before and are no worse), the red-then-green
   tests, the `local-checks.py` output, the eval's before/after scores, and the "Windows check (Ken's side)" section
   (item 5) with its result.
7. **Proposal, not built here:** a Windows end to end of the held path in `dialWindows.e2e.ts` (`windows-e2e`), a
   PTY-host table naming an `Orca.exe` stand-in, so later pull requests keep it on a real Windows runner.

## Decisions

1. `startMarker` is declared in `support.ts` alone; `externals/types.ts` (core-listed) is not changed (orchestrator,
   2026-11-23).
