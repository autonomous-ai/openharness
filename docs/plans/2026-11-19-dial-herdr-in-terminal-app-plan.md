# An agent in herdr inside a terminal app's tab shows on that app's page, and a swipe reaches it — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(cli): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message.

**Goal:** An agent in a pane of the person's default herdr session, whose herdr client runs in a tab of Terminal, iTerm2 or Ghostty, is on that app's dial page (one row), and the dial's swipe, rest and tap reach it there, as #4491 did for the person's tmux.

**Architecture:** In the devices process only. A new lookup, `cable/hosts/herdrOuter.ts` (`createHerdrOuter`, the shape of `createTmuxOuter`), finds the herdr server in the hook caller's parents, its clients by their unix sockets (`lsof`), the client used last by its tty's access time, and that client's app by the open scan's walk. A small generic `firstOuter` (`cable/hosts/outer.ts`) gives `observed.ts` one `outer` dep: herdr's answer when it names an app, else tmux's. The herdr pane id carries the app (`w1:p1:terminal-app`), and the herdr adapter gains `canShow` (that app in front) and `show` (`herdr agent focus`, in the pane's turn). `observed.ts` and `tabs.ts` keep their logic: their outer place is generic since #4491.

**Tech Stack:** TypeScript, vitest, herdr 0.8.0, `lsof`/`ps` on macOS; `cli/`.

**Spec:** `docs/plans/2026-11-19-dial-herdr-in-terminal-app-design.md`. Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md` (rules 4-7), `cli/src/services/AGENTS.md` (the person's-tmux paragraph under "Do not"), and the model: `docs/plans/2026-11-19-dial-tmux-terminal-plan.md`, commits `df4454d762` (#4491) and `36c1bac7aa` (#4497).

## Base

- Branch `fix/dial-herdr-in-terminal-app` at `ba0160a84d`, in this worktree.
- **Before the first task, once:** `cd cli && npm ci --no-audit --no-fund` (`cli/` has no `node_modules`). One process runs it, never two tasks at once.
- Names at the base. `tmux.ts`: `OUTER_EVERY_MS` (module-private), `TmuxOuter`, `TmuxOuterDeps`, `createTmuxOuter`, `PID`. `herdr.ts`: `HerdrAdapterDeps`, `HerdrAdapter`, `createHerdrAdapter`, the `focusing`/`prompting` maps. `herdrClient.ts`: `HERDR_PANE`, `herdrPaneKey`. `scannedApp.ts`: `ProcessName`, `scannedApps`, `parentChain`, `WALK_PARENTS`, `BUNDLES_A_PASS`, `appRoots`, `readBundleId`, `readProcessNames`. `tabs.ts`: `TAB_TTY`. `orca.ts`: `OrcaDeps`, `RUN_TIMEOUT_MS` (10 000). `hostDetect.ts`: `APP_IDS`. `adapter.ts`: `Outer`, `Place.outer`. `observed.ts`: `ObservedDeps.outer`, `askOuter`, `shown`, `rest`. `devices.ts`: `createHerdrAdapter(...)` at line 389, `noting`, the tmux adapter at line 516, `createTmuxOuter(...)` passed to `observedSource` at line 641, `cableHost.latestFront()`, `monotonic`. `devices.spec.ts`: `readers` (processes, bundleId), `mac`, `startHere`, `fakeListener`, `listener.tabs()`, `listener.front`, `swiped`, `said`, `orcaRuns`, the tests at lines 3137, 3158, 4217, 4232. e2e: `PrivateHerdr`, `herdrBinary` (`harness/herdrServer.ts`), `tabUnder`, `FakeApp` (`harness/outsideAgent.ts`), `dialTmuxTerminal.e2e.ts` (`watch`, `swipedTo`, `selectOf`), `dialTerminalFollow.e2e.ts` (the watch's `tab` line). If a name differs, follow the code and say so in the report.
- Ken's paused `feat/dial-linux` touches `hosts/` and `devices.ts`: rebase on `main` often.
- The spec and this plan are untracked. The main session commits them; no task does.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 `firstOuter`: the first lookup that finds an app | `cli/src/cable/hosts/outer.ts` (new), `cli/src/cable/hosts/outer.spec.ts` (new) | none | medium | `outer.spec.ts` (module missing) |
| 2 The herdr lookup: the client's app and tty | `cli/src/cable/hosts/herdrOuter.ts` (new), `cli/src/cable/hosts/herdrOuter.spec.ts` (new), `cli/src/cable/hosts/tmux.ts` | 1 | xhigh | `herdrOuter.spec.ts` `describe('the outer place of an agent in the person\'s herdr')` |
| 3 The herdr pane carries its app: show, canShow, bare id for every verb | `cli/src/cable/hosts/herdr.ts`, `cli/src/cable/hosts/herdr.spec.ts`, `cli/src/cable/hosts/adapter.ts` (the `Place.outer` comment), and one `front` line each in `cli/src/cable/hosts/herdrSource.spec.ts`, `cli/src/cable/hosts/open.spec.ts` (two constructions), `cli/src/cable/hosts/observed.spec.ts`, `cli/src/services/devices.ts` (line 389) | none | high | `herdr.spec.ts` `describe('a pane with its app')` |
| 4 e2e harness: a herdr client in a fake tab, a hooked agent in a pane, a `ps` that hides every herdr but the test's | `cli/e2e/harness/herdrServer.ts`, `cli/e2e/deviceHerdr.e2e.ts` | none | high | none: test harness only, one commit |
| 5 Wired in the devices process, proven end to end | `cli/src/services/devices.ts`, `cli/src/services/devices.spec.ts`, `cli/src/cable/hosts/observed.ts` (comments and the `outer` type only), `cli/e2e/dialHerdrTerminal.e2e.ts` (new) | 1, 2, 3, 4 | high | `devices.spec.ts` new herdr tests; `e2e/dialHerdrTerminal.e2e.ts` on this Mac |
| 6 Docs: the devices row and the person's-herdr rule | `cli/AGENTS.md`, `cli/src/services/AGENTS.md` | none | medium | none: docs, one commit |

Longest chain: 1 → 2 → 5 (three tasks). Tasks 1, 3, 4 and 6 start at once; 2 starts when 1 is done. Task 3 touches one line of `devices.ts` because `HerdrAdapterDeps.front` becomes required and `devices.ts` builds the adapter (typecheck stays green at every commit); its coverage in `npm run test:core` comes with Task 5's tests, so `test:core` is a gate from Task 5 on, as in #4491.

## Global Constraints

- **Devices process only.** Nothing in `cli/src/core/`, `cli/hook/` or the observed route's body; no new hint; no line of `cli/src/architecture.coreFiles.txt` changes (`cli/AGENTS.md` rule 7, core rule). `observed.ts`, `open.ts`, `tabs.ts` hold no rule about herdr.
- **No reading another process's environment or argv.** Only process names, parents and ttys (`ps`), the unix-socket rows `lsof` gives for herdr's own processes, and a tty's access time (`stat`). `src/architecture.environment.spec.ts` stays green.
- **Commands, no shell, each value one argument:** `/usr/sbin/lsof -a -U -p <pids> -F pdn` and `/bin/ps -o pid=,tty= -p <pids>`, each through `deps.run` with `RUN_TIMEOUT_MS`; in the person's herdr only `herdr agent focus <bare pane id>` (the `herdr` on PATH, as today), at a tap, or at a rest only while the client's app is in front.
- **Outside text:** a pane id against `HERDR_PANE` (its app field against `APP_IDS`); pids as table numbers in the pid form `^[1-9][0-9]{0,9}$`; a tty against `TAB_TTY` before it becomes a tab or a `stat` path; executable names matched (basename exactly `herdr`) and dropped, never kept or logged.
- **stdout whatever the exit code:** `lsof` and `ps` exit 1 when a pid in their list has gone, with the rest intact. A step is "not read" only when its run gave no output at all (blank) or timed out.
- **Logs:** once per lookup, `[device] herdr client · found`, `[device] herdr client · none`, or `[device] herdr client · not read · <step>`, step one of `processes`, `sockets`, `ttys`, `app`. A cached answer logs nothing. No pane id, pid, tty, path, bundle or app name in a line.
- **Bounds:** one lookup in flight per pane and caller, one per pane and caller every `OUTER_EVERY_MS` (5 000 ms, exported from `tmux.ts` and shared); at most 16 herdr processes besides the server (`HERDR_CLIENTS_A_LOOKUP`, the 16 highest pids); one table read, one `lsof`, one `ps`, up to `BUNDLES_A_PASS` `plutil` and up to 16 `stat` a lookup.
- **Pane id:** `w1:p1` as today, or `w1:p1:<app>` when `place.outer.app` is in `APP_IDS`; `paneKey` stays `herdr:w1:p1`; the `focusing`/`prompting` maps, `herdr agent focus` and `client.prompt` see the bare id only.
- **Platforms:** the lookup answers `undefined` at once off macOS.
- **Harness paths** only through `cli/src/config/harnessHome.ts` (none are needed). **No fixed sleeps:** fake clocks in units, `until` in e2e. **Coverage:** `src/services/devices.ts` stays at 100% per file (`npm run test:core`).

## Decisions made in this plan (the spec left them to the builder)

- Names: `OuterLookup` and `firstOuter` (`outer.ts`); `HerdrOuterDeps`, `createHerdrOuter`, `ttyAtime`, `HERDR_CLIENTS_A_LOOKUP` (`herdrOuter.ts`); `HerdrAdapterDeps.front`. `tmux.ts`'s `TmuxOuter` is replaced by `OuterLookup` (one name for the one shape), and `ObservedDeps.outer` is typed `OuterLookup`.
- `firstOuter` asks the second lookup only once the first answered with no app (herdr inside tmux then runs tmux's commands only when herdr's found nothing).
- No `lsof` runs when no other `herdr` process exists: the server is the only candidate.
- `lsof -p` lists the server first, then the others by ascending pid; `ps -p` lists the candidates by ascending pid. A candidate `ps` does not list has gone and is dropped.
- The server as the only candidate counts only with a tty that passes `TAB_TTY`.
- `stat` runs only when two or more candidates are left, and only on ttys that pass `TAB_TTY`. A candidate whose access time is unknown (a failed `stat`, a tty out of form) ranks below every candidate with a known one; among equals, the higher pid (PM, 2026-11-19).
- herdr `--no-session` inside the person's tmux inside a terminal app rests by `herdr agent focus`, not #4491's tmux select (the tab is still right): accepted by the PM (2026-11-19), no code for it, stated in the pull request.
- The e2e's daemon never reads the person's herdr: `ownHerdrsOnly` (Task 4) puts a `ps` first on that daemon's PATH that hides every `herdr` row outside the test's process tree (PM, 2026-11-19). Nothing in product code, no switch or option.
- The herdr adapter's `show` runs for any pane id in form; `canShow` decides when a rest calls it.
- The e2e's client is `herdr` (no arguments, attaching to the private server) run by `/bin/sh -c 'stty rows 40 columns 120 && exec "$0"' <herdrBinary>` in a fake Terminal's tab, so its pty has a size and the process is `herdr` itself; it is attached once the private server's `lsof` lists one more `herdr-client.sock` descriptor than before it started.

## Review Focus

Inputs the spec implies and its test list does not name. Each has its test in the task that owns the code.

1. **Two clients where one tty's access time cannot be read** (the tab closed between `ps` and `stat`, or its tty out of form). Expected: the one that can be read wins (PM, 2026-11-19). Task 2, `a client whose tty cannot be read loses to one that can`.
2. **A herdr process connected to another server** (another config folder's, or a named session's), whose peer is none of this server's descriptors, and rows the other way round (the server's own `->0x…` to a process's `d`). Expected: never a client. Task 2, `a client of another server, or a connection the other way, is no client`.
3. **A candidate gone between the reads** (`ps` lists only one of two and exits 1). Expected: the gone one dropped, the other's answer. Task 2, `a client gone before ps is dropped`.
4. **The herdr source's bare-id focus and a rest's app-id show on one pane at once**, with the dial's words. Expected: one `herdr agent focus`, both answer it, the words wait their turn. Task 3, `the bare id and the id with its app share one turn`.
5. **A pane id whose app field is out of form** (`w1:p2:Terminal`, `w1:p2:terminal-app:x`, `w1:p2:`, `w1:p2:1`, `w1:p2:nope`). Expected: no command, no words, `canShow` false, `show` failed. Task 3, `a pane id not in its form runs nothing` (extended).

---

### Task 1: `firstOuter`: the first lookup that finds an app

**Files:**
- Create: `cli/src/cable/hosts/outer.ts`
- Test: `cli/src/cable/hosts/outer.spec.ts`

**Interfaces:**
- Produces:
  - `export type OuterLookup = (hints: Readonly<Record<string, string>>, pid: number) => Promise<{ app?: string; tty?: string }> | undefined` (doc: where the person sees an agent nested in a multiplexer whose own pty is no tab; `undefined` at once when not nested; a promise that never rejects, `{}` when no app was found).
  - `export function firstOuter(first: OuterLookup, second: OuterLookup): OuterLookup`

- [ ] **Step 1: Write the failing tests** in `outer.spec.ts`, with lookups that record their `(hints, pid)` calls and answer what each test sets (`undefined`, or a promise):
  - `the first's answer when it names an app, and the second is not asked` — first `{ app: 'terminal-app', tty: '/dev/ttys004' }` → that; second's calls `[]`.
  - `the second's answer when the first's names none` — first `{}`, second `{ app: 'ghostty' }` → `{ app: 'ghostty' }`; the second asked once, with the same hints and pid, only after the first settled.
  - `{} when the first answered none and the second is not nested` — first `{}`, second `undefined` → resolves `{}`.
  - `the second's answer when the first is not nested` — first `undefined`, second `{ app: 'iterm' }` → `{ app: 'iterm' }`.
  - `undefined at once when neither is nested` — the call returns `undefined` (not a promise).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/outer.spec.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** `outer.ts`: the type and `firstOuter`, as the tests read; a top comment says why the order is the caller's (`devices.ts`: herdr's, then tmux's) and that neither lookup knows the other.
- [ ] **Step 4: Run** `npx vitest run src/cable/hosts/outer.spec.ts && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `fix(cli): an agent's outer place comes from the first lookup that finds its app`.

---

### Task 2: The herdr lookup: the client's app and tty

**Files:**
- Create: `cli/src/cable/hosts/herdrOuter.ts`
- Test: `cli/src/cable/hosts/herdrOuter.spec.ts`
- Modify: `cli/src/cable/hosts/tmux.ts` — `export const OUTER_EVERY_MS`; `TmuxOuter` removed, `createTmuxOuter(deps): OuterLookup` (its doc keeps what `TmuxOuter`'s said). No behavior change; `tmux.spec.ts` passes untouched.

**Interfaces:**
- Consumes: `OuterLookup` (Task 1); `OUTER_EVERY_MS` (`tmux.ts`); `ProcessName`, `parentChain`, `scannedApps` (`scannedApp.ts`); `TAB_TTY` (`tabs.ts`); `HERDR_PANE` (`herdrClient.ts`); `OrcaDeps`, `RUN_TIMEOUT_MS` (`orca.ts`).
- Produces (exported from `herdrOuter.ts`):
  - `export const HERDR_CLIENTS_A_LOOKUP = 16`
  - `export interface HerdrOuterDeps { run: OrcaDeps['run']; processes(): Promise<readonly ProcessName[]>; log(line: string): void; now(): number; platform: NodeJS.Platform; roots: readonly string[]; bundleId(bundle: string): Promise<string | undefined>; atime(tty: string): Promise<number | undefined> }`
  - `export function ttyAtime(tty: string): Promise<number | undefined>` — `fs.promises.stat(tty)`'s `atimeMs`, `undefined` when it fails; never rejects.
  - `export function createHerdrOuter(deps: HerdrOuterDeps): OuterLookup`

- [ ] **Step 1: Write the failing tests** in `describe('the outer place of an agent in the person\'s herdr')`, with a `lookup(over, codes, said)` helper like `tmux.spec.ts`'s: `run` records `{ file, args, timeoutMs }` and answers `/usr/sbin/lsof` with `said.lsof`, `/bin/ps` with `said.ps`, codes from `codes` (then 0); `processes` counts its reads and answers `TABLE`; `atime` records its ttys and answers from a map; `platform: 'darwin'`; `roots: ['/Users/u/Applications/']`; `bundleId` maps `/Users/u/Applications/Terminal.app` to `com.apple.Terminal`; `now` from a clock. Fixtures:

```ts
const CONFIG = '/Users/u/.config/herdr'
const TERMINAL = '/Users/u/Applications/Terminal.app/Contents/MacOS/Terminal'
const PANE = { HERDR_PANE_ID: 'w1:p2' }
/** The agent (100) in a pane of a detached server (80); a client (4300) in a Terminal tab. */
const TABLE = [
  { pid: 100, ppid: 90, executable: 'claude' }, { pid: 90, ppid: 80, executable: '/bin/zsh' },
  { pid: 80, ppid: 1, executable: '/opt/homebrew/bin/herdr' },
  { pid: 4300, ppid: 4299, executable: '/opt/homebrew/bin/herdr' }, { pid: 4299, ppid: 4298, executable: '-zsh' },
  { pid: 4298, ppid: 1, executable: TERMINAL },
]
/** lsof -F pdn rows: per pid, its descriptors' `d` and `n`, each with an `f` line before it as lsof prints. */
const sockets = (rows: Record<number, Array<[d: string, n: string]>>) => /* p<pid>\nf<i>\nd<d>\nn<n>\n… */
const SERVER: Array<[string, string]> = [['0xa1', `${CONFIG}/herdr-client.sock`], ['0xa2', `${CONFIG}/herdr-client.sock`], ['0xa3', `${CONFIG}/herdr.sock`]]
const ONE = { lsof: sockets({ 80: SERVER, 4300: [['0xb1', '->0xa2']] }), ps: '4300 ttys004\n' }
const lsofAsked = (pids: string): Call => ({ file: '/usr/sbin/lsof', args: ['-a', '-U', '-p', pids, '-F', 'pdn'], timeoutMs: 10_000 })
const psAsked = (pids: string): Call => ({ file: '/bin/ps', args: ['-o', 'pid=,tty=', '-p', pids], timeoutMs: 10_000 })
```

  Tests (each asserts the answer, the calls and the log lines):
  - `not herdr, a pane id or pid out of form, or off macOS: undefined at once, and nothing runs` — hints `{}`, `{ HERDR_PANE_ID: 'w1' }`, `'w1:p2; x'`, `'--help'`, `'w1:p2:terminal-app'`; pids `0`, `-1`, `1.5`, `NaN`; `platform: 'linux'` and `'win32'` with `PANE` → `undefined` (not a promise); calls `[]`, reads 0.
  - `one client in a Terminal tab: its app and tty` — `ONE` → `{ app: 'terminal-app', tty: '/dev/ttys004' }`; calls `[lsofAsked('80,4300'), psAsked('4300')]`; one table read; `atime` not asked; logs `['[device] herdr client · found']`.
  - `no herdr in the caller's parents: {} and nothing runs` — caller 4299, and a table where 80's executable is `/opt/bin/herdr-dev`, `herdrx` or `/opt/herdr.app` → `{}`, calls `[]`, logs `none`.
  - `a detached server with no client: {}` — no other `herdr` row, ps `'80 ??\n'` → `{}`; calls `[psAsked('80')]` (no lsof); logs `none`.
  - `a herdr agent command connected only to herdr.sock is no client` — add `{ pid: 4500, ppid: 4000, executable: '/opt/homebrew/bin/herdr' }` with `[['0xc1', '->0xa3']]`, ps `'80 ??\n'` → `{}`; calls `[lsofAsked('80,4300,4500'), psAsked('80')]` with 4300 holding no peer.
  - `a client of another server, or a connection the other way, is no client` — a process whose peer is `->0xff` (no descriptor of 80's); and the server holding `['0xa9', '->0xb9']` while 4300 holds ``['0xb9', `${CONFIG}/herdr-client.sock`]`` → `{}` when ps says `80 ??`.
  - `two clients: the tty typed into last wins; on a tie the higher pid` — a second client 4310 (`ppid 4309` → `4298`), ps `'4300 ttys004\n4310 ttys007\n'`; atime `{ '/dev/ttys004': 2000, '/dev/ttys007': 1000 }` → ttys004; both 1000 → ttys007; `atime` asked for both ttys.
  - `a client whose tty cannot be read loses to one that can` — atime of ttys004 `undefined`, ttys007 `1000` → ttys007; both `undefined` → the higher pid (4310).
  - `a client in tmux has no app, and loses to one in Terminal even when typed into last` — 4400 under `-zsh` → `tmux` (ppid 1), its tty newest → 4300's answer.
  - `a client gone before ps is dropped` — two connected clients, ps lists only 4300 with code 1 → 4300's answer.
  - `a tty out of form: the app alone` — ps `4300 console`, `4300 ??`, `4300 pts/3` → `{ app: 'terminal-app' }`; `atime` never asked.
  - `a client whose parents name no listed app answers {}` — `bundleId` → `com.example.other` → `{}`, `none`.
  - `herdr in Herdr's terminal: the holder is under no root the scan reads, {}` — 4300's parent `/opt/herdr-core/libexec/herdr-core-holder` (ppid 1) → `{}`, `none`.
  - `--no-session: the server is the client, on its tab's tty` — server 80 under `-zsh` → `TERMINAL`, no other herdr, ps `'80 ttys005\n'` → `{ app: 'terminal-app', tty: '/dev/ttys005' }`; calls `[psAsked('80')]`.
  - `lsof and ps that exit 1 with their output are read` — codes `[1, 1]` with `ONE` → found.
  - `each step not read says its word and answers {}, never a rejection` — `processes` rejects → `not read · processes`; lsof stdout `''` with code 1, code `null`, or a `run` that rejects → `not read · sockets`; ps `''` → `not read · ttys`; `roots` whose `some` throws (as `tmux.spec.ts`) → `not read · app`.
  - `more than 16 herdr processes: the 16 newest are asked` — 20 others, pids 5001-5020 → `lsofAsked('80,5005,5006,…,5020')`.
  - `one lookup per pane and caller in flight, and one every 5 s` — as `tmux.spec.ts`'s test of that name, holding `lsof` by hand: two asks share one; another pane (`w1:p3`) is not held back; another caller runs its own; `+4 999` gets the last answer with no run; `+5 000` runs again; one still in flight past 5 s is shared.
  - `its lines name no pane, pid, tty, path, bundle or app` — every line of `ONE`, a `none` and a `not read` case against `w1:p2`, `80`, `4300`, `100`, `ttys004`, `CONFIG`, `com.apple.Terminal`, `Terminal`, `terminal-app`.
  - `ttyAtime reads a file's access time, and nothing for a path that is not there` — a temp file's `atimeMs` (`statSync`), and `undefined` for a missing path.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/herdrOuter.spec.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** `herdrOuter.ts` per the spec's "The lookup" steps 1-6 and the decisions above; `tmux.ts` as in Files. A `run` that rejects counts as no output. The `lsof` parser keeps a current pid from `p` lines (pid form), resets the descriptor at each `f`, and records `(pid, d, n)` at each `n`; the server's `d` values whose `n` ends in `/herdr-client.sock` are matched against each other process's `n->` peers. The cache is `tmux.ts`'s (`Map<key, { at, answer, settled }>`, key `<pane>:<pid>`, pruned at each ask). A top comment says why: Diego's Terminal tab B (2026-11-19), herdr's API lists no clients (protocol 19), why only socket rows and a tty's access time are read.
- [ ] **Step 4: Run** `npx vitest run src/cable/hosts/herdrOuter.spec.ts src/cable/hosts/tmux.spec.ts && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `fix(cli): the devices learn the app and tty of the herdr client that shows a pane`.

---

### Task 3: The herdr pane carries its app: show, canShow, bare id for every verb

**Files:**
- Modify: `cli/src/cable/hosts/herdr.ts`
- Test: `cli/src/cable/hosts/herdr.spec.ts`
- Modify: `cli/src/cable/hosts/adapter.ts` — the `Place.outer` doc: "only the tmux, herdr and tabs adapters read it".
- Modify, one `front` each (no other change): `cli/src/cable/hosts/herdrSource.spec.ts` (`setup`'s adapter), `cli/src/cable/hosts/open.spec.ts` (the two `createHerdrAdapter` calls), `cli/src/cable/hosts/observed.spec.ts` (`fakeActions`' herdr adapter): `front: () => undefined`.
- Modify: `cli/src/services/devices.ts` line 389 only: `createHerdrAdapter({ ...apps, client: herdrClient, front: () => cableHost.latestFront() })`.

**Interfaces:**
- Consumes: `Place.outer`; `APP_IDS`; `HERDR_PANE`, `herdrPaneKey`.
- Produces: `HerdrAdapterDeps.front(): string | undefined` (the app in front, `cableHost.latestFront()`); pane id `w1:p2` or `w1:p2:<app>`; `canShow(pane): boolean`; `show(pane): Promise<PaneSwitch>`; `prompt(paneId)` unchanged (bare id); `paneKey` → `herdr:<bare id>`.

- [ ] **Step 1: Write the failing tests.** `recorder` gains `front` (default `() => 'terminal-app'`). The first test becomes `its id is herdr, it taps before its app, it types, and it shows` (`show` and `canShow` are functions). New `describe('a pane with its app')`:
  - `paneOf adds the outer app when it is one of the apps` — `outer: { app: 'terminal-app', tty: '/dev/ttys004' }` → `pane('w1:p2:terminal-app')`; `outer: { app: 'orca' }` → `'w1:p2:orca'`; `outer: { app: 'nope' }` and no `outer` → `'w1:p2'`.
  - `every verb takes the bare pane id` — `focus(pane('w1:p2:terminal-app'))` → `[focusCall('w1:p2')]`; `type!(…, 'next', 'claude')` → prompt `['w1:p2', 'claude', 'next']`; `paneKey` → `'herdr:w1:p2'`.
  - `canShow: only a pane with an app, only while that app is in front` — `'w1:p2:terminal-app'` with front `terminal-app` → true; front `ghostty` or `undefined` → false; `'w1:p2'` → false.
  - `show focuses the pane: ok when herdr agent focus exits 0, else failed` — codes `[0, 1, null]` → `'ok'`, `'failed'`, `'failed'`, each `[focusCall('w1:p2')]`; no herdr on PATH → `'failed'`, no call.
  - `the bare id and the id with its app share one turn` — a held `focus(pane('w1:p2'))`, then `show(pane('w1:p2:terminal-app'))` → one command, both answer its result; a `prompt('w1:p2', …)` asked during the show waits for it; a second prompt meanwhile is busy.
  - Extend `a pane id not in its form runs nothing` with `'w1:p2:Terminal'`, `'w1:p2:terminal-app:x'`, `'w1:p2:'`, `'w1:p2:1'`, `'w1:p2:nope'`: `focus` false, `show` `'failed'`, `canShow` false, `type` false; calls `[]`, prompt never asked.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/herdr.spec.ts` → FAIL.
- [ ] **Step 3: Implement.** A private `paneParts(pane): { id: string; app?: string } | undefined` reads `^(w[0-9]{1,9}:p[0-9]{1,9})(?::([a-z-]{1,32}))?$`, in form only when the app field is absent or in `APP_IDS`. `focus`'s body becomes a private `turn(id): Promise<boolean>` (the per-pane focus, joined by a second, after words under way) that `focus` and `show` both call with the bare id. `type` asks `prompt` with the bare id. Update the file's top comment: a rest runs the same command while the app holding the pane's client is in front (the spec). Add the `front` lines in the four other files.
- [ ] **Step 4: Run** `npx vitest run src/cable/hosts/herdr.spec.ts src/cable/hosts/herdrSource.spec.ts src/cable/hosts/open.spec.ts src/cable/hosts/observed.spec.ts src/services/devices.spec.ts && npm run typecheck` → PASS (the last four unchanged in behavior: no herdr pane has an app yet).
- [ ] **Step 5: Commit** `fix(cli): a dial rest or tap focuses a herdr pane while the app holding its client is in front`.

---

### Task 4: e2e harness: a herdr client in a fake tab, a hooked agent in a pane, a `ps` that hides every herdr but the test's

**Files:**
- Modify: `cli/e2e/harness/herdrServer.ts`
- Modify: `cli/e2e/deviceHerdr.e2e.ts` (its third test uses `hooked`)

No red test: test harness only, one commit.

**Interfaces:**
- Consumes: `tabUnder`, `FakeApp` (`harness/outsideAgent.ts`); `observedAgentId`; `writeExecutable` (`src/testing/executableFixture.ts`).
- Produces (on `PrivateHerdr`):
  - `get pid(): number` — the server's process; the instance keeps its config folder.
  - `tabClient(app: FakeApp): Promise<{ pid: number; tty: string; close(): Promise<void> }>` — the decision's command under `tabUnder(this.d, app, …, { ...this.d.env, XDG_CONFIG_HOME: <config>, TERM: 'xterm-256color' })`; resolved once `/usr/sbin/lsof -a -U -p <server pid> -F n` lists one more `herdr-client.sock` row than before it started (`until`, 20 s); `tty` is `/dev/` + `ps -o tty= -p <pid>`; a failed wait closes the tab.
  - `hooked(folder: string): Promise<{ pane: string; sessionId: string; id: string }>` — `pane(folder)`, its shell drawn, `type(pane, '"$CLAUDE_PATH"')`, the session id from the hook log after its length before typing.
- Produces (exported from `herdrServer.ts`, called by `dialHerdrTerminal.e2e.ts` alone):
  - `export function ownHerdrsOnly(d: IsolatedDaemon, root: number = process.pid): { kept(): number[]; dropped(): number[] }` — called after `IsolatedDaemon.create` and before `d.start()`. Writes `<dirname(d.env.CLAUDE_PATH)>/ps` (the daemon's `bin`, first on its PATH, daemon.ts line 461) with `writeExecutable`, so macOS admits it before the daemon's first run, as the harness's `lsof` wrapper is (daemon.ts lines 381-399). The script: for arguments exactly `-axo pid=,ppid=,comm=` (`readProcessNames`, `scannedApp.ts` line 76, the only caller of that form) it runs `/bin/ps "$@"`, keeps every row, and drops each row whose `comm` basename is exactly `herdr` and whose ancestry by the rows' own `ppid` (at most 64 steps) does not reach `root` (the vitest fork worker); it appends `kept <pid>` or `dropped <pid>` for each herdr row to `<d.root>/ps-herdr.log`, and exits with `/bin/ps`'s status, never awk's (the lsof wrapper's pattern). Any other arguments: `exec /bin/ps "$@"`. `kept()` and `dropped()` read that log, each pid once; none when it is missing. Its comment says why: the PM's isolation of 2026-11-19 (a herdr of the person's runs on the Mac that runs the tests), and that only the lookup's table read is touched.

- [ ] **Step 1: Add the helpers** as in Interfaces; the header comment says the client is pinned to this server and is never the developer's herdr, and that `ownHerdrsOnly` keeps the daemon's lookup off the developer's herdr.
- [ ] **Step 2: Use `hooked`** in `deviceHerdr.e2e.ts`'s `a hooked Claude Code in a herdr pane is one row…` (its step 1), nothing else changed.
- [ ] **Step 3: Run** on this Mac: `cd cli && npm run typecheck && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/deviceHerdr.e2e.ts` → PASS, as before. Then one scratch run (in the session's scratchpad, not committed) that creates an `IsolatedDaemon`, calls `ownHerdrsOnly(d)`, starts a `PrivateHerdr`, attaches `tabClient('terminal-app')` and prints its tty, then runs `<bin>/ps -axo pid=,ppid=,comm=` under the daemon's env from the worker: it must list the server's and the client's pids, list no herdr outside the worker's tree (the developer's herdr runs on this Mac now), and `kept()` must hold both pids. If herdr does not attach within 20 s, find out why on that private server before changing the helper.
- [ ] **Step 4: Commit** `test(cli): the e2e harness attaches a herdr client from a fake terminal tab, starts a hooked agent in a pane, and hides every herdr but the test's`.

**Checked in the code while planning (2026-11-19):**
- (a) The devices process resolves `ps` through the test's PATH: `IsolatedDaemon` sets `PATH: ${bin}:…` (daemon.ts line 461); the master spawns each service with `{ ...env, ...extra }` (`src/harnessd/master.ts` line 401); `readProcessNames` runs `ps` by name through `execFile` (`scannedApp.ts` line 76); #4497's tmux finder prepends to a copy of the environment, never `process.env.PATH` (`lib/tmuxOnPath.ts`). The harness's `lsof` wrapper already reaches the devices' scan the same way.
- (b) Both are the worker's descendants: `PrivateHerdr.start` spawns `herdr server` from the worker and fails if it exits before answering, so it does not detach; `tabUnder` spawns the fake app from the worker, which runs the PTY helper, whose `pty.fork` child `exec`s the client (`outsideAgent.ts` lines 22-33, 110-112). The daemon's own `herdr agent focus` runs are its descendants too, and connect only to `herdr.sock` (no client: Task 2).
- (c) Nothing else in the e2e reads that form of `ps`: the herdr source and adapter use herdr's socket and the daemon's `herdr` wrapper; the tmux lookup is not asked (no `TMUX_PANE`); the open scan's other sessions are already hidden by the `lsof` wrapper; `vscodeTerminals.ts` and the tabs' tty reads use other arguments and pass through.

**Fallback (PM's), applied only if one of these fails and cannot be fixed in the harness alone:** the daemon under test never lists the private server's pid in `kept()` once its agent is listed (its table read did not go through the wrapper), or the server or the client is not a descendant of the worker (a `ps` row shows it under pid 1), or hiding the rows breaks another test of `dialHerdrTerminal.e2e.ts`. Then `ownHerdrsOnly` is not added, the e2e reads the person's herdr's socket rows read-only as the product does, Task 5's `kept`/`dropped` assertions are left out, and the implementer says which condition failed in the report and the pull request says so.

---

### Task 5: Wired in the devices process, proven end to end

**Files:**
- Modify: `cli/src/services/devices.ts` (the `outer` passed to `observedSource`)
- Test: `cli/src/services/devices.spec.ts`
- Modify: `cli/src/cable/hosts/observed.ts` — comments and a type only: `ObservedDeps.outer?: OuterLookup`, its doc names `outer.ts` `firstOuter` of `herdrOuter.ts` and `tmux.ts` and "a multiplexer"; `askOuter`'s doc adds the herdr incident (2026-11-19). No logic change; if a test shows one is needed, it is generic and goes to the main session first.
- Create: `cli/e2e/dialHerdrTerminal.e2e.ts`

**Interfaces:**
- Consumes: `firstOuter`, `OuterLookup` (Task 1); `createHerdrOuter`, `ttyAtime` (Task 2); the herdr adapter's `show`/`canShow` (Task 3); `PrivateHerdr.tabClient`, `.hooked`, `.pid`, `ownHerdrsOnly` (Task 4).

- [ ] **Step 1: Write the failing tests.**
  - `devices.spec.ts`, beside the tmux tests at line 3158, on ``{ ...mac, onPath: (name) => `/opt/${name}/bin/${name}`, run }`` where `run` records into `orcaRuns` and answers `/usr/sbin/lsof` with the server (3900, `herdr-client.sock` descriptors) and client (4300, `->` one of them) rows, `/bin/ps` with `'4300 ttys004\n'`; `readers.processes`: agent 4242 → 4000 `zsh` → 3900 `/opt/homebrew/bin/herdr` (ppid 1), client 4300 `herdr` → 4298 `join(homedir(), 'Applications', 'Terminal.app', 'Contents', 'MacOS', 'Terminal')`; `readers.bundleId` gives `com.apple.Terminal` for that bundle. Hints `{ HERDR_PANE_ID: 'w1:p2' }`.
    - `an agent in the person's herdr is on the page of the app that holds its client, and a rest selects its tab, then its herdr pane` — `said()` holds `[device] herdr client · found`; the snapshot's apps hold `terminal-app` count 1 and no `herdr`; with `listener.front('terminal-app')`, a rest → `stream.lines` `[{ app: 'terminal-app', tty: '/dev/ttys004' }]` and `orcaRuns.at(-1)` `['/opt/herdr/bin/herdr', ['agent', 'focus', 'w1:p2'], 10_000]`; with front `ghostty`, a second rest runs no herdr.
    - `a tap on it focuses its herdr pane, brings Terminal forward, then raises its tab` — `orcaRuns` ends `[herdr agent focus w1:p2, ['/usr/bin/open', ['-b', 'com.apple.Terminal'], 10_000]]`, then `stream.lines` `[{ app: 'terminal-app', tty: '/dev/ttys004', raise: true }]`.
    - `herdr's lookup is asked first, and tmux's only when herdr's found no app` — hints `{ HERDR_PANE_ID: 'w1:p2', TMUX_PANE: '%3' }`: with the client above, no tmux run and the app `terminal-app`; with no herdr in the table, tmux's `display-message` and `list-clients` run and its found client's app is the page (`[device] herdr client · none`, then `[device] tmux client · found`).
    - Update every existing test whose hints carry `HERDR_PANE_ID` on `mac` (lines 3137, 4217, 4232, the herdr source's describe at 5538, and any other `said()` equality the full run shows): the lookup now logs `[device] herdr client · none` (no herdr in their tables, and so no command). Add that line to their expectations; weaken nothing else.
  - `e2e/dialHerdrTerminal.e2e.ts`, `describe.skipIf(process.platform !== 'darwin' || !herdrBinary)`, header comment as `dialTmuxTerminal.e2e.ts` (what is real, what is fake, never the person's herdr, Terminal or daemon, and that the lookup's table hides every herdr outside the test's tree). `fresh()`: `IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })`, `hidden = ownHerdrsOnly(d)`, the fake open checked inside `d.root`, `others` = the pids of `herdr` rows outside the worker's tree, read by the test from `/bin/ps -axo pid=,ppid=,comm=` (names matched and dropped), a dial plugged with `{ appFilter: 'v1' }`, `PrivateHerdr.start(d)`, `client = tabClient('terminal-app')` first, then `b = hooked('b')` and `agent = hooked('in-herdr')`, both `report(…, 'idle')` to herdr, both listed; the watch (its own copy, with `front(bundle)` and `tab(tty)` writers), Terminal in front. `afterEach`: children, then the client, then herdr, then the desk and the daemon.
    - `an agent in the person's herdr is on Terminal's page, one row each, and on no herdr page` — the latest `apps` frame has `terminal-app` count 2 and no `herdr`; the roster holds each id once and no other row; the log has `[device] herdr client · found`; `hidden.kept()` holds `herdr.pid` and `client.pid` and no pid of `others` read at the start or again now; every pid of `others` read at both ends is in `hidden.dropped()`.
    - `with Terminal in front a swipe selects the client's tab, then the agent's herdr pane` — `swipedTo(b → agent)` until the watch prints `{"select":{"app":"terminal-app","tty":<client tty>}}`, then `until` `rpc('agent.get', { target: agent.pane })`'s `focused` is true; a swipe to `b` then focuses `b.pane`.
    - `with another app in front a swipe changes nothing in herdr` — after the agent's pane is focused, `b.pane` focused by the daemon's own `herdr` wrapper (`herdr agent focus`, as a person's click), Orca's ring brought (`InOrca`, front `com.stablyai.orca`, as the tmux file), the dial turned to `b`, then back to the agent; once both `[device] swipe ·` lines came, `b.pane` is still the focused one.
    - `a tab line with the client's tty turns the dial to the agent heard from last` — in this order: the agent typed into (`herdr.type(agent.pane, 'hello')`) until its `turn.done`, so it is heard from last; an `Outside` in a Terminal tab of its own, and the dial turned to it; then the watch's `{ tab: { app: 'terminal-app', tty: <client tty> } }` line → the dial's `focus` for `agent.id`, and `[device] tab · moved` in the log.
    - `the daemon's log has no tty, pane id, config path or session id` — after a swipe: the client tty's name, both panes, the private config folder, both session ids.
- [ ] **Step 2: Run them to see them fail:** `cd cli && npx vitest run src/services/devices.spec.ts -t "herdr"` → the new tests FAIL (the agent is on `herdr`); `TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialHerdrTerminal.e2e.ts` on this Mac → the first, second and fourth tests FAIL.
- [ ] **Step 3: Implement** in `devices.ts`: one object of the shared deps (`run: apps.run, processes: readProcessNames, log, now: monotonic, platform: apps.platform, roots: appRoots(homedir()), bundleId: readBundleId`) and `firstOuter(createHerdrOuter({ ...shared, atime: ttyAtime }), createTmuxOuter({ ...shared, tmux: tmuxAt }))` in place of the bare `createTmuxOuter(...)`, with no new lambda (100% per file); its comment says herdr's first and why. Then `observed.ts`'s comments and type.
- [ ] **Step 4: Run** `npx vitest run src/services/devices.spec.ts src/cable/hosts/observed.spec.ts && npm run typecheck && npm run test:core`, then on this Mac `TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialHerdrTerminal.e2e.ts e2e/deviceHerdr.e2e.ts e2e/dialTmuxTerminal.e2e.ts e2e/dialTerminalFollow.e2e.ts` → PASS.
- [ ] **Step 5: Commit** `fix(cli): an agent in herdr inside a terminal app's tab is on that app's page, and a swipe reaches it`.

---

### Task 6: Docs: the devices row and the person's-herdr rule

**Files:**
- Modify: `cli/AGENTS.md` (the `devices` row of the process table)
- Modify: `cli/src/services/AGENTS.md` (under "Do not", beside the person's-tmux paragraph)

No red test: docs, one commit.

- [ ] **Step 1: `cli/AGENTS.md`'s devices row,** after the tmux sentence: an agent in a pane of the person's default herdr session is on the page of the app that holds the herdr client used last (its tty's access time) of the herdr server in the agent's parents, learned from `ps`, `lsof -U` of herdr's own processes (at most 16 besides the server) and that client's parents, at most one lookup a pane and agent process every 5 s, kept in memory, on macOS, and its tab is that client's tty (`cable/hosts/herdrOuter.ts`); herdr's lookup is asked before tmux's (`cable/hosts/outer.ts`); a swipe or rest while that app is in front selects that tab, then the agent's herdr pane (`herdr agent focus`), and a tap focuses the pane before the app comes.
- [ ] **Step 2: `cli/src/services/AGENTS.md`,** a paragraph after the person's-tmux one: in the person's herdr the devices process runs `herdr agent focus <pane>` alone, for the pane a hook named in the default session, at a tap and at a rest only while the app holding that pane's client is in front (`cable/hosts/herdr.ts`), beside the dial's words over herdr's socket; to find that client it reads only process names, parents and ttys, the unix-socket rows `lsof` gives for herdr's own processes and a tty's access time, never another process's environment or argv (`cable/hosts/herdrOuter.ts`); it never creates or closes anything there.
- [ ] **Step 3: Commit** `docs(cli): a herdr agent is on its client's app's page, and what the dial runs in the person's herdr`.

---

## Verification

**Platforms the pull request names:** macOS, fixed (units, and the end-to-end file on this Mac). Linux and Windows: not affected (the lookup answers `undefined` at once off macOS; a herdr pane with no app keeps today's verbs), covered by Task 2's `off macOS` case and Task 3's bare-id tests; PR CI's `cli-tests` run the unit files on Linux. Out of scope, stated in the pull request: named herdr sessions (`--session`), Linux, Windows.

### End-to-end checks

1. **The dial and an agent in herdr inside Terminal, macOS** (`cli/e2e/dialHerdrTerminal.e2e.ts`). Isolation: `IsolatedDaemon` gives a throwaway `HOME`, data folder and port; `PrivateHerdr` runs a herdr server of the test's own with its config under that `HOME` (`XDG_CONFIG_HOME`, update and manifest checks off), and the daemon's `herdr` is a wrapper pinned to it; the client is a `herdr` attached to that server from a fake Terminal (a Node symlink under `$HOME/Applications/Terminal.app`, `CFBundleIdentifier` `com.apple.Terminal`) through the PTY helper; the agents are the suite's fake Claude Code (`CLAUDE_PATH`); the watch is the real `harness hardware watch --json` under the daemon's env, written `front` and `tab` lines by the test (no Harness Device runs); `HARNESS_OPEN_BIN` is the harness's fake. No window opens, and the person's herdr server, Terminal, daemon (port 18473), `~/.claude` and `~/.codex` are never run or written. The person's herdr is never read either: `ownHerdrsOnly` (Task 4) puts a `ps` first on the daemon's PATH that hides every `herdr` row outside the test's process tree from the lookup's table read, so its candidates and its `lsof -p` list hold only the test's server and client; the test checks that from the recorded kept and dropped pids. If that cannot be made to work in the harness alone (Task 4's fallback conditions), the e2e reads the person's herdr's socket rows read-only, as the product does, and the pull request says so. Run on this Mac (herdr 0.8.0 at `~/.local/bin/herdr`, `cc` at `/usr/bin/cc`): `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialHerdrTerminal.e2e.ts`. A person should see `5 passed`: red on Task 5's red commit (tests 1, 2, 4), green on the final head.
2. **Neighbours unchanged, macOS:** `e2e/deviceHerdr.e2e.ts` (herdr's own rows, a hooked agent in a pane: one row), `e2e/dialTmuxTerminal.e2e.ts` (#4491), `e2e/dialTerminalFollow.e2e.ts` (a plain Terminal tab); same command and isolation.

Checks 1 and 2 run locally on this Mac, by a tester; no workflow runs them on GitHub: `cli-e2e.yml`'s Linux shards skip every herdr file (no herdr or `cc` on the runners) and its `e2e-macos-disk` job runs only `diskfull` and `updateHostile`. They take minutes, so no temporary workflow is added. Proposal for the pull request's body (not in this pull request, needs the PM's go for macOS minutes): a `workflow_dispatch` macOS job in `cli-e2e.yml` that installs a pinned herdr and runs named herdr end-to-end files.

No check needs a sign-in, a test account, a device or the person's own eye. **Against production:** none.

### Required local gates, at the final head, recorded in the pull request

- `cd cli && npm run typecheck`.
- `npx vitest run src/cable/hosts/outer.spec.ts src/cable/hosts/herdrOuter.spec.ts src/cable/hosts/herdr.spec.ts src/cable/hosts/tmux.spec.ts src/cable/hosts/herdrSource.spec.ts src/cable/hosts/open.spec.ts src/cable/hosts/observed.spec.ts src/services/devices.spec.ts src/architecture.spec.ts src/architecture.environment.spec.ts`.
- `npm run test:core` (100% per file, for `src/services/devices.ts`), or `python3 scripts/local-checks.py --run` from a clean tree at the final commit, whose `cli-core` fence goes in the pull request's body.
- `git diff --stat $(git merge-base HEAD origin/main) -- cli/src/core cli/hook cli/src/architecture.coreFiles.txt` prints nothing.
- Not needed: `npm run test:harnessd`, Desktop, device-app, firmware.

### Numbers

One lookup's wall time on this Mac, before and after, with 1 and 3 clients, median of 20 asks each, against a private herdr only: `HOME=$(mktemp -d)`, `XDG_CONFIG_HOME=$HOME/.config`, a server started as `PrivateHerdr.start` does, a fake `Terminal.app` under that `HOME/Applications` as `outsideAgent.ts` makes it, and 1, then 3 clients attached from it through the PTY helper. A scratch script (in the session's scratchpad, not committed) run with `npx tsx` from `cli/`:
- **After:** `createHerdrOuter` with the real deps (an `execFile`-based `run`, `readProcessNames` filtered in the script as `ownHerdrsOnly` filters, so no `lsof` reaches the person's herdr, `readBundleId`, `roots: appRoots(HOME)`, `ttyAtime`, `platform: process.platform`), asked for a pane id with the pid of a shell in a pane, a fresh `now` each ask so none is cached; and once more within 5 s (the cached answer: no command).
- **Before:** `main` runs no lookup for a herdr agent: zero commands, or one `ps -o tty=` when the server inherited a tab app's bundle id.
- Stop the server and remove the temp folders after. The table (1 client, 3 clients; before, after cold, after cached) goes in the pull request.

### Evidence the pull request carries

The red and green outputs of each task's tests and of end-to-end check 1, the `test:core` fence, the numbers above, the platforms, and the out-of-scope line. Two lines the PM accepted (2026-11-19): herdr's `--no-session` inside the person's tmux inside a terminal app rests by `herdr agent focus` rather than #4491's tmux select (the tab is still right); and how the e2e kept off the person's herdr (`ownHerdrsOnly`, with whether a herdr of the developer's ran during the run and was dropped), or, if Task 4's fallback was taken, that the e2e read the person's herdr's socket rows read-only, and why.

## Open questions

None. The PM answered the draft's three on 2026-11-19: an unread access time ranks below every read one, among equals the higher pid (Task 2); herdr `--no-session` inside tmux rests by herdr's focus, stated in the pull request; the e2e hides every herdr outside the test's tree (Task 4, with the fallback named there).
