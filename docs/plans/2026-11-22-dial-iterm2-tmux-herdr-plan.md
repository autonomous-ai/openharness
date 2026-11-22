# Dial: agents in tmux and herdr inside iTerm2 are on iTerm2's page Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with devcrew phase 3, task by task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** An idle agent in the person's tmux or herdr, found by the open scan after the devices start again, is on the
page of the app holding that multiplexer's client (iTerm2 in Diego's case) with its tab, its tmux pane and, when herdr's
own list names its session, its herdr pane; and iTerm2's `iTermServer-<version>` process names iTerm2 in every walk.

**Architecture:** Devices process only. The scan reads the process table once a look and, for each session with a tmux
or herdr process among its parents, its terminal's maker (`scannedApp.ts readMadeBy`). A session tmux or herdr made has
no tty read for a tab and is asked, after the listing, one session at a time, through a new `ObservedDeps.nested` entry
that `devices.ts` points at each multiplexer's new process form (`tmux.ts createTmuxNested`, `herdrOuter.ts
createHerdrNested`). Its answer lands like a hook's outer answer; tmux's also names a placed pane for a rest and a tap,
and `devices.ts` places a herdr pane from herdr's own rows that carry a session id, as it places cmux's. Gap 2 is one
fixed row in `scannedApps`' macOS walk.

**Tech Stack:** TypeScript (Node 24), Vitest unit suites, the e2e harness's private tmux server, private herdr server and
fake apps, PR CI's `dial-hosts` job for the Linux e2e.

**Spec:** `docs/plans/2026-11-22-dial-iterm2-tmux-herdr-design.md` (read it with this plan). PM decisions of 2026-11-22
in the brief are final: both gaps in one PR, Gap 1 first; Zellij out of Gap 1; herdr's pane only with a session id; the
iTermServer row as the spec writes it; numbers for a look over 50 sessions.

## Global Constraints

- Devices process only: `cli/src/cable/hosts/`, `cli/src/services/devices.ts`, `cli/e2e/`. Nothing in `cli/src/core`,
  `cli/hook` or `cli/src/architecture.coreFiles.txt`.
- `observed.ts` holds no rule about any app: it passes `madeBy`'s host on as an opaque word and stores the lookup's
  `pane` as given (`adapter.ts` `Pane`). The names `tmux` and `herdr` appear only in `devices.ts`, `tmux.ts`,
  `herdrOuter.ts` and `scannedApp.ts`'s existing `PTY_HOSTS`.
- Never read another process's environment or argv. Process names are matched against fixed tables (`PTY_HOSTS`, the
  iTermServer row) and dropped. tmux's listing reads `#{pane_id}`, `#{pane_tty}`, `#{pane_pid}`, `#{session_name}` and
  the owner tag alone.
- Every command runs with no shell, at most `RUN_TIMEOUT_MS` (10 s); each lookup answer is shared in flight and held
  `OUTER_EVERY_MS` (5 s) from its start; tmux's pane listing reads at most `PANES_A_LISTING` (1024) lines; the scan
  lists at most `MAX_SESSIONS` (50) a look and asks their nested lookups one at a time; the iTermServer row takes none of
  `BUNDLES_A_PASS` (16).
- Words never go to a placed pane (tmux's `Entry.placed`, herdr's `setPaneNames` place): words before an agent's first
  hook are unchanged.
- Log lines carry counts and fixed words only, never a pid, tty, pane id, session, path or app:
  `[observed] scan · <n> found · <n> app known · <n> named · <n> answered · <n> ms · <n> nested placed`;
  `[device] tmux client · found | none | not read · <step> | over`; herdr's lines as today.
- Platforms: Gap 1 on macOS and Linux (`scanLearnsApps`); Gap 2 on macOS only (`scannedApps`' macOS branch); on Windows
  `devices.ts` wires none of `table`, `madeBy`, `nested` (no scan walk, no `ps`): no change there.
- Tests never touch the person's tmux, herdr, iTerm2, `~/.claude` or daemon: fakes in unit specs; e2e only through the
  harness's isolated daemon, private tmux server, `PrivateHerdr` with `ownHerdrsOnly`, and fake apps in its throwaway home.
- Every behaviour task: a red commit (the failing test), then a green commit. Run only the specs of what changed
  (`cd cli && npx vitest run <spec> -t '<name>'`), plus `npm run typecheck` when a type or signature changed. Full
  suites wait for the Verification section.
- Comments say why (name Diego's report of 2026-11-22 where it explains a choice); names per `docs/naming-system.md`;
  English. The planner commits nothing.

## Review Focus

1. **The first hook after a scan's place comes from a terminal no multiplexer made** (the session resumed in a plain
   tab): the scan's place goes at once, the agent follows the hook's hints, and no scan-placed tmux pane is shown or
   tapped afterwards. Test in Task 5.
2. **The tmux session has no client, or its client used last is in no listed app** when the scan asks: the agent stays
   where the scan put it (Other's page, `appPending`), no pane is placed and nothing is counted placed. Tests in Tasks 2
   and 4.
3. **tmux's pane listing is long or out of form** (Harness's own panes on the same server, a session name holding a
   bar, a tty out of form): `over` is said once a lookup, a line out of form is passed over, a person's pane past the
   bound answers `{}`. Test in Task 2.
4. **A maker read fails mid-look** (the process gone between the table and its tty read, `ps` past its timeout): that
   session is listed as today, its tab read if its app is a tab app, and the look's other sessions are still placed.
   Tests in Tasks 1 and 4.
5. **herdr's row has a session id but the scan's copy has no known app yet** (its lookup answered `{}`, or has not
   landed): it is placed at the bare pane id, so a tap focuses the herdr pane and a rest does not; the app joins the
   place once known. Test in Task 9.

---

## Task graph

| # | Task | Effort | Depends on |
|---|---|---|---|
| 1 | The look's one table, and the makers of nested sessions | high | - |
| 2 | tmux's process form | high | - |
| 3 | herdr's process form | high | - |
| 4 | The scan asks the nested lookups (Gap 1's main red test) | xhigh | - |
| 5 | The scan's placed tmux pane, and the first hook after a scan's place | xhigh | 4 |
| 6 | herdr's source tells a row's pane | medium | - |
| 7 | iTerm2's server in the walk (Gap 2) | high | - |
| 8 | The devices wire the scan's nested lookups | high | 1, 2, 3, 5, 7 |
| 9 | herdr's panes placed from its own rows, and the exact case | high | 6, 8 |
| 10 | e2e (macOS): tmux in an iTerm2 tab, found by the scan | high | 8 |
| 11 | e2e (Linux): herdr in WezTerm, found by the scan | high | 9 |
| 12 | Docs | medium | 9 |

Files shared by tasks (devcrew runs them one at a time, in any order): `scannedApp.ts` and `scannedApp.spec.ts` (1, 7);
`observed.ts` and `observed.spec.ts` (4, 5); `devices.ts` and `devices.spec.ts` (8, 9).

Longest chain: 4 → 5 → 8 → 9 → 11 (five tasks; 4 → 5 → 8 → 9 → 12 is as long).

Tasks 1-6 are Gap 1, Task 7 Gap 2. Tasks 1, 2, 3, 4, 6 and 7 start at once.

---

### Task 1: The look's one table, and the makers of nested sessions

**Files:** Modify `cli/src/cable/hosts/scannedApp.ts`; Test `cli/src/cable/hosts/scannedApp.spec.ts`.
**Depends on:** none. **Effort:** high.

**Interfaces:**
- Consumes: `parentChain`, `readPtyMaker`, `PTY_HOSTS` (same file).
- Produces:
  - `export interface MadeBy { host: string; maker: number; tty: string }`: the host `PTY_HOSTS` names, the maker's pid,
    and the pid's own terminal as `readTtyName` gives it (`ttys004`, `pts/2`).
  - `export async function readMadeBy(pids: readonly number[], rows: readonly ProcessName[], tty: (pid: number) =>
    Promise<string | undefined>, hosts: readonly string[]): Promise<Map<number, MadeBy>>`: one pid at a time, in the
    order given. A pid none of whose parents (`parentChain` over [rows], the pid itself left out) has a name `PTY_HOSTS`
    maps into [hosts] reads no tty: its maker cannot be one of them. Else `readPtyMaker(pid, rows, reader)`, the reader
    keeping the pid's own answer; kept only when the maker's host is in [hosts]. A pid whose read rejects is left out.
    Never rejects.
  - `learnApps(pids: readonly number[], rows?: readonly ProcessName[], exec: Exec = execText)`: with [rows], the walk
    reads them and runs no `ps`.

- [ ] **Step 1: Failing tests** (describe `the makers of the sessions a look lists`):
  - `a session in a tmux pane and one in a herdr pane: each one's host, its maker and its own tty`: macOS rows
    `[100, 90, 'claude', 'ttys010'], [90, 80, 'zsh', 'ttys010'], [80, 1, 'tmux']` and
    `[200, 190, 'claude', 'ttys020'], [190, 180, 'zsh', 'ttys020'], [180, 1, '/opt/homebrew/bin/herdr']`;
    `readMadeBy([100, 200], rows, tty, ['tmux', 'herdr'])` →
    `new Map([[100, { host: 'tmux', maker: 80, tty: 'ttys010' }], [200, { host: 'herdr', maker: 180, tty: 'ttys020' }]])`.
    The same on Linux names (`tmux: server`, `herdr`, `pts/3`).
  - `no tty is read for a session with no tmux or herdr among its parents`: a plain iTerm2 tab chain and a Zellij chain
    → empty map; the tty reader is never called with their pids.
  - `a terminal started from a tmux pane is not tmux's`: `claude(ttys030) → zsh(ttys030) → Ghostty(ttys010) →
    zsh(ttys010) → tmux` → left out; reads stop at Ghostty.
  - `a pid whose tty read rejects is left out, and the next is still read` (Review Focus 4).
  - `one pid at a time`: the second pid's first read starts only once the first pid's reads settled.
  - `learnApps over the look's rows runs no ps`: `learnApps([100], rows)` → no `ps` in `patient.calls`.
  - Change the two existing `learnApps(pids, exec)` calls to `learnApps(pids, undefined, exec)`.
- [ ] **Step 2:** `cd cli && npx vitest run src/cable/hosts/scannedApp.spec.ts` → FAIL (`readMadeBy` not exported).
- [ ] **Step 3:** Implement `MadeBy`, `readMadeBy` and `learnApps`' `rows`.
- [ ] **Step 4:** `npx vitest run src/cable/hosts/scannedApp.spec.ts` → PASS; `npm run typecheck` passes.
- [ ] **Step 5:** Commit red, then green.

### Task 2: tmux's process form

**Files:** Modify `cli/src/cable/hosts/tmux.ts`; Test `cli/src/cable/hosts/tmux.spec.ts`.
**Depends on:** none. **Effort:** high.

**Interfaces:**
- Consumes: `TMUX_PANE_FACTS`, `TMUX_PANE_FACT`'s owner rule, `holdsPane`, `isHarnessSession`, `scannedApps`,
  `clientTtyForm`, `OUTER_EVERY_MS`, `PID` (existing).
- Produces:
  - `export const PANES_A_LISTING = 1024`.
  - `export function createTmuxNested(deps: Omit<TmuxOuterDeps, 'processes' | 'tty'>): (found: { pid: number; tty:
    string; rows: readonly ProcessName[] }) => Promise<{ app?: string; tty?: string; pid?: number; pane?: Pane }> |
    undefined`.
    - `undefined` at once when the platform has no `clientTtyForm`, the pid is out of `PID`, or `/dev/<tty>` is out of
      that form.
    - Else one `tmux list-panes -a -F '#{pane_id}|#{pane_tty}|' + TMUX_PANE_FACTS` serves every ask for
      `OUTER_EVERY_MS` from its start, one in flight shared: a tmux that hangs costs a look one timeout, not one an ask.
      Its first `PANES_A_LISTING` lines are read, the rest counted; any counted says `[device] tmux client · over`.
    - The line whose `pane_tty` is `/dev/<tty>`: none → `{}`; a daemon's tag or a Harness session → `{}`; its pane pid
      not in the agent's chain (`holdsPane` over `found.rows`) → `{}`.
    - From that pane id on, the hooked form's own steps over `found.rows`: extract `clientOf(id: string, rows: readonly
      ProcessName[]): Promise<ClientPlace | NotRead>` from `createTmuxOuter`'s `placeOf` (the `list-clients -t <pane>`
      read, the client used last, its app) and call it from both. No table read and no maker read: the scan did both.
    - With an app, the answer adds `pane: { adapter: 'tmux', id: '<pane id>:<found.pid>:<app>' }`, the form `paneParts`,
      `checkedPane` and `canShow` take.
    - Lines as the hooked form's (`found`, `none`, `not read · tmux | pane | clients | app`), plus `over`.
    - One answer per `<tty>:<pid>` in flight, held `OUTER_EVERY_MS`.

- [ ] **Step 1: Failing tests** (describe `the place of an agent the scan found in the person's tmux`):
  - `out of form: undefined at once, and nothing runs`: pids `0, -1, 1.5`; ttys `'ttys004; x'`, `'/dev/ttys004'`, `''`,
    `'pts/2'` on macOS; any input on `win32`.
  - `the person's pane on the agent's tty: its client's app, tty and process, and the pane with its app`: listing
    `'%1|/dev/ttys009|50|work|\n%3|/dev/ttys010|90|work|\n'`, clients `'1794700050|4300|/dev/ttys004\n'`, `TABLE` plus
    `CLIENT_CHAIN` → `toStrictEqual({ app: 'terminal-app', tty: '/dev/ttys004', pid: 4300, pane: { adapter: 'tmux', id:
    '%3:100:terminal-app' } })`; runs exactly the listing then `list-clients -t %3 -F …`, no `display-message`.
  - `Linux: pts/5 finds its pane on /dev/pts/5`, the client in a WezTerm window.
  - `a daemon's or Harness's pane on that tty answers {} and lists no client`: each of `HARNESS_PANES`' three forms.
  - `a tty in no pane, or a pane that holds another process: {}`.
  - `a detached session, or a client in no listed app: {}` (Review Focus 2).
  - `past 1024 lines it says over, once, and a pane past the bound is not found`: 1024 lines then the person's →
    `{}` and lines `['[device] tmux client · over', '[device] tmux client · none']`; exactly 1024 lines says no `over`.
  - `lines out of form are passed over, and a session may hold a bar`: `garbage`, `%3|ttys010|90|work|`,
    `%3|/dev/ttys010|90|my|work|` (session `my|work`, the person's) (Review Focus 3).
  - `no tmux, or a listing or client read that fails: {} and not read, with the step, never a rejection`.
  - `one listing serves every ask for 5 s, one in flight shared; one answer per tty and process`: modelled on `one
    lookup per pane and caller in flight, and one every 5 s`.
  - `its lines name no pane, pid, tty, session or app`.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/tmux.spec.ts` → FAIL (`createTmuxNested` not exported).
- [ ] **Step 3:** Implement, extracting `clientOf`; the hooked form's tests stay as they are.
- [ ] **Step 4:** `npx vitest run src/cable/hosts/tmux.spec.ts` → PASS; `npm run typecheck` passes.
- [ ] **Step 5:** Commit red, then green.

### Task 3: herdr's process form

**Files:** Modify `cli/src/cable/hosts/herdrOuter.ts`; Test `cli/src/cable/hosts/herdrOuter.spec.ts`.
**Depends on:** none. **Effort:** high.

**Interfaces:**
- Consumes: `createHerdrOuter`'s `placeOf` steps, `OUTER_EVERY_MS`, `PID`.
- Produces: `export function createHerdrNested(deps: Omit<HerdrOuterDeps, 'processes'>): (found: { pid: number; maker:
  number; rows: readonly ProcessName[] }) => Promise<{ app?: string; tty?: string; pid?: number }> | undefined`.
  - `undefined` at once on Windows (no `clientTtyForm`) or a pid or maker out of `PID`.
  - Else `placeOf`'s steps from the server on, with `found.maker` as the server and `found.rows` as the table: extract
    `clientsOf(server: number, rows: readonly ProcessName[]): Promise<ClientPlace | NotRead>` and call it from both
    forms. No table read, and no maker read of the agent's own.
  - The answer depends on the server alone: one per `found.maker` in flight, held `OUTER_EVERY_MS`, so two panes of one
    herdr cost one lookup.
  - Lines as the hooked form's.

- [ ] **Step 1: Failing tests** (describe `the place of an agent the scan found in the person's herdr`):
  - `the hooked form's answer, with no table read and no maker read of the agent's own`: the `one client in a Terminal
    tab` scene; `await nested({ pid, maker: <server>, rows })` `toStrictEqual` `await outer({ HERDR_PANE_ID: 'w1:p2' },
    pid)`; the tty reader is never called with the agent's or its shell's pid.
  - `Linux: one client in a WezTerm window` (as `herdr's clients on Linux`).
  - `Windows, or a pid or maker out of form: undefined at once, and nothing runs`.
  - `one lookup per server in flight, and one every 5 s: two agents of one server share it`.
  - `each step not read says its word and answers {}, never a rejection` (sockets, ttys, app).
  - `its lines name no pane, pid, tty, path or app`.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/herdrOuter.spec.ts` → FAIL.
- [ ] **Step 3:** Implement, extracting `clientsOf`.
- [ ] **Step 4:** `npx vitest run src/cable/hosts/herdrOuter.spec.ts` → PASS; `npm run typecheck` passes.
- [ ] **Step 5:** Commit red, then green.

### Task 4: The scan asks the nested lookups (Gap 1's main red test)

**Files:** Modify `cli/src/cable/hosts/observed.ts`, `cli/src/cable/hosts/outer.ts`; Test
`cli/src/cable/hosts/observed.spec.ts`. **Depends on:** none. **Effort:** xhigh.

**Interfaces:**
- Consumes: `ProcessName` (`scannedApp.ts`, type only), `Pane` (`adapter.ts`), `APP_BUNDLES`. Tasks 1-3 are matched
  structurally: no import of them.
- Produces, in `outer.ts` (types only):
  - `export interface Nested { host: string; pid: number; tty: string; maker: number; rows: readonly ProcessName[] }`.
  - `export interface NestedPlace { app?: string; tty?: string; pid?: number; pane?: Pane }`.
  - `export type NestedLookup = (found: Nested) => Promise<NestedPlace> | undefined`: `undefined` at once for a host
    with no process form, else a promise that never rejects, `{}` when no app was found.
- Produces, in `ObservedDeps`:
  - `table?(): Promise<readonly ProcessName[]>`: the processes by name, read once a look; rejects when unreadable.
  - `apps?(pids: readonly number[], rows?: readonly ProcessName[])`: the scan passes the look's rows; the hooked walk
    (`learnApp`) and a look with no `table` call it with the pids alone, as today.
  - `madeBy?(pids: readonly number[], rows: readonly ProcessName[]): Promise<ReadonlyMap<number, Omit<Nested, 'pid' |
    'rows'>>>`.
  - `nested?: NestedLookup`.
- Behaviour of `scanOnce`:
  - Reads, before any session is listed: one `table()` when present (a rejection says `[observed] scan · apps not read ·
    <kind>` and asks neither `apps` nor `madeBy`); `apps(pids, rows)`; `madeBy(pids, rows)` when `table`, `madeBy` and
    `nested` are all there (a rejection counts as none).
  - In the listing loop, an entry `madeBy` names and `pair()` left unpaired is not given `learnTty` (its tty is the
    multiplexer pane's pty, which on macOS has a tab's form) and is kept for an ask; every other entry as today.
  - After the emit, the kept entries are asked one at a time, each only while it is live, has no caller and is not
    paired: `nested({ ...made, pid: <owner pid>, rows })`. An answer lands under the same three checks. One naming an
    app sets `outer` (`app`, `tty`, `pid`), `entry.tty`, `agent.app`, `entry.bundle = APP_BUNDLES[app]`, deletes
    `appPending`, then `locate` and `emit`. One naming none changes nothing.
  - The line is said once the asks have settled, then the paired line. The look stays the one `scanOpen` joins until
    then: bounded by the lookups' own timeouts and shared listings (Tasks 2, 3).

- [ ] **Step 1: Failing tests** (describe `ObservedSource and a nested session the scan found`, with the real tabs
  adapter in `actions` and `madeBy`/`nested` fakes answered by hand):
  - `the devices start again with a tmux and a herdr agent idle: the scan puts each on its client's app with its tab,
    known, not on Other's page`: owners `a` (pid 100) and `b` (pid 200); `madeBy` names 100 tmux and 200 herdr; the
    answers `{ app: 'iterm', tty: '/dev/ttys004', pid: 4300 }` and `{ app: 'iterm', tty: '/dev/ttys005', pid: 4400 }` →
    both `app: 'iterm'` with no `appPending`; `paneOf(id, 'tabs')` is `'iterm:/dev/ttys004'`; `windowOf(id)` is
    `{ pid: 4300, app: 'iterm' }`; a tap opens bundle `com.googlecode.iterm2`; the line ends `· 2 nested placed`.
  - `a look reads the table once for its walk, its makers and its lookups`: 50 owners; `table` called once; `apps` and
    `madeBy` each once, with all 50 pids and that same rows array; every `nested` call carries it.
  - `a look asks its nested lookups one at a time`: the second is asked only once the first settled.
  - `a nested session never has its own tty read, even when the walk named a tab app`: `apps` names 200 `terminal-app`
    (herdr's first client); `tty` is never called with 200; a session in Ghostty beside it has its tty read as before.
  - `an answer after a hook, or for a session gone, is dropped; a session hooked before its turn is not asked`.
  - `an answer that names no app leaves the walk's app and appPending as they were, and counts nothing` (Review Focus 2).
  - `a session madeBy leaves out asks nothing and has its tty read as before` (Review Focus 4); `a session paired with a
    Herdr terminal is not asked`.
  - `a table that cannot be read lists every session not known, reads no maker, and says apps not read`, naming nothing.
  - `with no table reader the scan asks apps with the pids alone, and no maker`.
  - `a scan asked while a look's lookups run joins that look`: one `owners()` look, one ask per entry.
  - `the line counts the placed and names nothing`: no `iterm`, pid or tty in the logs.
  - Append ` · 0 nested placed` to each of the ten exact `[observed] scan · …` lines this spec already holds.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/observed.spec.ts` → FAIL (the scan neither asks nor places).
- [ ] **Step 3:** Implement the types in `outer.ts` and the scan in `observed.ts`.
- [ ] **Step 4:** `npx vitest run src/cable/hosts/observed.spec.ts src/cable/hosts/outer.spec.ts` → PASS;
  `npm run typecheck` passes.
- [ ] **Step 5:** Commit red, then green.

### Task 5: The scan's placed tmux pane, and the first hook after a scan's place

**Files:** Modify `cli/src/cable/hosts/observed.ts`; Test `cli/src/cable/hosts/observed.spec.ts`.
**Depends on:** 4. **Effort:** xhigh.

**Interfaces:**
- Consumes: Task 4's landing and `NestedPlace.pane`.
- Produces:
  - `Entry.placed?: Pane`: the answer's pane, set as it lands. `placeIn` reads it after an own pane that is not held and
    before the `setPaneNames` place; it is never in `entry.panes`, so `words`, `byPane`, `paneOf` and `list()`'s pane
    keys never see it. `ingest` clears it: from its first hook the agent's panes are its hook's.
  - `Entry.scanPlaced?: true`: set as an answer lands. At the first hook `askOuter` keeps `outer`, `outerPid` and
    `entry.tty` while that hook's own ask runs (the scan's place counts as an ask kept) and its answer then replaces
    them; when the hook's lookup answers `undefined` at once (not nested), they go at once. Cleared at that hook.

- [ ] **Step 1: Failing tests** (same describe as Task 4; the real tmux adapter with a recording runner, `front()`
  `'iterm'`, and the real herdr adapter with a socket):
  - `a rest with its app in front shows its tab, then selects its tmux pane`: the answer carries `pane: { adapter:
    'tmux', id: '%3:100:iterm' }` → the tabs line `{ app: 'iterm', tty: '/dev/ttys004' }`, then the pane check and
    `select-window -t %3 ; select-pane -t %3`; `paneOf(id, 'tmux')` stays `undefined`.
  - `a tap selects its tmux pane, then brings iTerm2 forward and raises its tab`.
  - `a placed pane takes no words: tmux's, and herdr's placed by its listing`: herdr's via
    `setPaneNames('herdr', new Map(), new Map([[id, 'w1:p2:iterm']]))` → `capabilities(agent).voice` is false, `send`
    refuses, herdr's `prompt` is never called.
  - `the first hook after a scan's place keeps it on its app's page and tab until the hook's own answer lands, and that
    answer wins`: a `session-start` in tmux pane `%3` → still `iterm` and `'iterm:/dev/ttys004'`; its answer
    `{ app: 'terminal-app', tty: '/dev/ttys006', pid: 4500 }` → `terminal-app`, tmux pane `'%3:100:terminal-app'`.
  - `a first hook that is not nested drops the scan's place at once` (Review Focus 1): hints `{ TERM_PROGRAM: 'ghostty'
    }` → `ghostty`, its own tty read for its tab, no tmux pane in a tap's target.
  - `a hook's own answer of none drops the scan's place`.
  - `the first hook takes the placed pane away`: a hook in pane `%4` → the tmux pane is `%4`'s alone.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/observed.spec.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx vitest run src/cable/hosts/observed.spec.ts` → PASS; `npm run typecheck` passes.
- [ ] **Step 5:** Commit red, then green.

### Task 6: herdr's source tells a row's pane

**Files:** Modify `cli/src/cable/hosts/herdrSource.ts`; Test `cli/src/cable/hosts/herdrSource.spec.ts`.
**Depends on:** none. **Effort:** medium.

**Interfaces:** Produces `HerdrSource.paneAt(agentId: string): string | undefined`: the herdr pane id of a row it lists,
by the row's id; none for an id it does not list (as `CmuxSource.paneAt`).

- [ ] **Step 1: Failing test:** `paneAt tells the pane of a row it lists, and none for an id it does not, or once the row
  left` (two rows, `w1:p1` and `w1:p2`).
- [ ] **Step 2:** `npx vitest run src/cable/hosts/herdrSource.spec.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command → PASS; `npm run typecheck` passes.
- [ ] **Step 5:** Commit red, then green.

### Task 7: iTerm2's server in the walk (Gap 2)

**Files:** Modify `cli/src/cable/hosts/scannedApp.ts`; Test `cli/src/cable/hosts/scannedApp.spec.ts`.
**Depends on:** none. **Effort:** high.

**Interfaces:**
- Produces:
  - `ScannedAppDeps.home?: string`: the daemon's home, whose iTerm2 folders the row reads; `homedir()` when absent, so
    `tmux.ts`, `herdrOuter.ts` and `zellij.ts` change nothing.
  - In `scannedApps`' macOS branch only: a process whose executable is exactly
    `<home>/Library/Application Support/iTerm2/iTermServer-<v>`, `<home>/.iterm2/iTermServer-<v>` or `iTermServer-<v>`,
    `<v>` matching `[0-9][0-9A-Za-z.-]{0,31}`, names `iterm` at its place in the nearest-first list `nearestApp` reads.
    It reads no bundle, takes none of `BUNDLES_A_PASS`, and nothing of it is kept or said.

- [ ] **Step 1: Failing tests** (describe `iTerm2's server`, `HOME` `/Users/someone` passed as `home`):
  - `a plain tab under iTermServer is in iTerm2, in each form, with iTerm2 or launchd as its parent`: `it.each` over
    the Application Support path (`3.5.4`), the `.iterm2` path (`3.6.6`), the bare name and a nightly
    (`3.6.0-nightly-20261120`), each with the server's parent `/Applications/iTerm.app/Contents/MacOS/iTerm2` and with
    ppid 1; chain `claude → -zsh → login → server` → `new Map([[pid, 'iterm']])`; with launchd `bundleId` is not called.
  - `a tmux client and a herdr client in an iTerm2 tab name iTerm2 under a server launchd adopted`.
  - `near misses name nothing`: `iTermServer`, `iTermServer-`, `iTermServer-x1`, a version of 33 characters,
    `/tmp/iTermServer-3.5.4`, `/Users/other/Library/Application Support/iTerm2/iTermServer-3.5.4`,
    `/Users/someone/.iterm2/sub/iTermServer-3.5.4`; and on Linux the bare name.
  - `a nearer .app still wins`: a Ghostty bundle nearer than the server → `ghostty`.
  - `the row takes none of the 16 bundles a pass`: 16 sessions under 16 bundles and one under the server → all 17 named.
  - Extend `nothing of a process is kept or said` with a server row.
- [ ] **Step 2:** `npx vitest run src/cable/hosts/scannedApp.spec.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command → PASS; `npm run typecheck` passes.
- [ ] **Step 5:** Commit red, then green.

### Task 8: The devices wire the scan's nested lookups

**Files:** Modify `cli/src/services/devices.ts`; Test `cli/src/services/devices.spec.ts`.
**Depends on:** 1, 2, 3, 5, 7. **Effort:** high.

**Interfaces:**
- Consumes: `readMadeBy`, `learnApps(pids, rows)` (Task 1); `createTmuxNested` (2); `createHerdrNested` (3);
  `ObservedDeps.table | madeBy | nested`, `Entry.placed` (4, 5); the iTermServer row (7).
- Produces: `observedSource(…)` takes one more argument, `nesting: Pick<ObservedDeps, 'table' | 'madeBy' | 'nested'>`,
  spread into its deps, and `apps: (pids, rows) => learnApps(pids, rows)`. Where `scanLearnsApps(apps.platform)`:
  - `table: readProcessNames`;
  - `madeBy: (pids, rows) => readMadeBy(pids, rows, readTtyName, ['tmux', 'herdr'])`;
  - `nested: (found) => found.host === 'tmux' ? tmuxNested(found) : found.host === 'herdr' ? herdrNested(found) :
    undefined`, with `tmuxNested = createTmuxNested({ ...outerDeps, tmux: tmuxAt })` and `herdrNested =
    createHerdrNested({ ...outerDeps, atime: ttyAtime, tty: readTtyName, onPath: apps.onPath, sockets: procSockets })`.
  - On Windows, `nesting` is `{}`.

- [ ] **Step 1: Failing tests** (beside `an agent in the person's tmux is on the page of the app that holds its client`):
  - `Diego's case: a tmux agent idle in an iTerm2 tab, found by the attach scan, is on iTerm2's page; a rest selects its
    tab, then its pane; a tap selects the pane, brings iTerm2 forward and raises the tab`: `readers.processes` holds the
    agent 4242 (`ttys030`) → zsh 4000 (`ttys030`) → tmux 3900 (ppid 1), and the client 4300 `tmux` → zsh 4299 → login
    4298 → `join(homedir(), 'Library', 'Application Support', 'iTerm2', 'iTermServer-3.6.6')` 4297; `it.each` over the
    server's ppid (1, and a process at `/Applications/iTerm.app/Contents/MacOS/iTerm2`). The session is known and its
    owner is 4242, idle; the runner answers `list-panes` with `'%3|/dev/ttys030|4000|work|\n'` and `list-clients` with
    `'1794700050|4300|/dev/ttys004\n'`. After the attach: `[device] tmux client · found`, the scan line ends
    `· 1 nested placed`, the apps hold `iterm` with count 1 and no `tmux`; with iTerm2 in front a rest writes
    `{ app: 'iterm', tty: '/dev/ttys004' }`, then `select-window -t %3 ; select-pane -t %3`; a tap runs the select, then
    `open -b com.googlecode.iterm2`, and raises the tab.
  - `a herdr agent idle in an iTerm2 tab, found by the attach scan, is on iTerm2's page with its tab` (the `inHerdr`
    scene with the client under the server; herdr's source lists no row).
  - `a look reads the process table once, and the ttys of the nested sessions alone`: a session in Ghostty and one in
    tmux; `readers.processes` once in the look; `readers.tty` only with 4242, 4000 and 3900.
  - `a session in Zellij found by the scan asks no lookup and runs nothing`.
  - `Windows: the scan reads no table and no tty, and runs no lookup`; its line says `0 nested placed`.
  - Change the two `expect(readers.apps.mock.calls).toEqual([[[77]]])` to compare the pids alone
    (`readers.apps.mock.calls.map(([pids]) => pids)` → `[[77]]`). Where an existing spec lists a scan session under a
    tmux or herdr chain and now sees the lookup's runs, change only those expectations, and say which in the report.
- [ ] **Step 2:** `npx vitest run src/services/devices.spec.ts -t 'found by the'` → FAIL.
- [ ] **Step 3:** Implement the wiring.
- [ ] **Step 4:** `npx vitest run src/services/devices.spec.ts` → PASS; `npm run typecheck` passes.
- [ ] **Step 5:** Commit red, then green.

### Task 9: herdr's panes placed from its own rows, and the exact case

**Files:** Modify `cli/src/services/devices.ts`; Test `cli/src/services/devices.spec.ts`.
**Depends on:** 6, 8. **Effort:** high.

**Interfaces:**
- Consumes: `HerdrSource.paneAt` (6), `ObservedSource.setPaneNames`, `paneOf`, `windowOf`, `observedAgentId`,
  `UNKNOWN_APP`.
- Produces: `placeInHerdr(source: ObservedSource, listing: HerdrSource): void` beside `placeInCmux`, the same shape: for
  each row of herdr's with a `sessionId`, `agentId = observedAgentId(engine, sessionId)`; when `source.paneOf(agentId,
  'herdr')` is `undefined`, the place is `<paneAt(row.id)>:<app>` with `app = source.windowOf(agentId)?.app` when that
  is a listed app other than `UNKNOWN_APP`, else the bare pane id (herdr's `canShow` needs the app, its tap does not);
  then `source.setPaneNames('herdr', new Map(), placed)`. Run on each change of the observed source and of herdr's, in
  `part.call('herdr', …)`, nothing told while there is no row and no place before.

- [ ] **Step 1: Failing tests:**
  - `a scan-found herdr agent whose herdr row has its session is one row on iTerm2's page; a rest selects its tab, then
    focuses its herdr pane; a tap focuses the pane, brings iTerm2 forward and raises the tab`: herdr's fake listing
    gives `w1:p2` the agent's session; the dial lists one row, the observed id; a rest runs
    `herdr agent focus w1:p2` after the tabs line; a voice to it reaches no herdr `prompt`.
  - `with no session in herdr's row the scan's copy gets its tab alone, and herdr's row stays on herdr's page`: two
    rows; a rest writes the tabs line and runs no `herdr agent focus`.
  - `an agent whose app is not known yet is placed by its pane alone: a tap focuses it, a rest does not` (Review Focus 5).
  - `the place goes with herdr's row`.
  - `the exact case: a plain tab, tmux and two herdr panes in iTerm2 are four rows on iTerm2's page, each reached at
    its own tab and pane`: `it.each` over hooked and found by the scan, and over the server's parent iTerm2 and launchd.
    Tabs `ttys001` (plain), `ttys002` (tmux's client), `ttys003` (herdr's client); herdr's listing gives `w1:p1` and
    `w1:p2` their sessions. iTerm2's count is 4 and no other page holds them; with iTerm2 in front a rest on each writes
    its own tab line, then `select-window -t %3 ; select-pane -t %3` for tmux and `herdr agent focus w1:p1` and `w1:p2`.
- [ ] **Step 2:** `npx vitest run src/services/devices.spec.ts -t 'herdr row|exact case'` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx vitest run src/services/devices.spec.ts` → PASS; `npm run typecheck` passes.
- [ ] **Step 5:** Commit red, then green.

---

## End-to-end

Each check below runs the real daemon through the e2e harness, isolated as the harness isolates every file: a daemon of
its own (`IsolatedDaemon`: a throwaway root, `HOME`, data folder and port, never 18473), its private tmux server (socket
in its root, `TMUX` and `TMUX_PANE` unset), `PrivateHerdr` (config under its home, `ownHerdrsOnly` hiding every herdr
outside the test's tree from the daemon's `ps -axo pid=,ppid=,comm=`), fake apps as Node symlinks under its home, the
harness's fake `open`, a fake dial on its desk. No Harness Device runs, no window opens, nothing of the person's tmux,
herdr, iTerm2 or `~/.claude` is read or driven. An agent started before the dial is plugged runs its hooks while no
devices process runs, so they reach nobody: that is the devices starting again while the agent is idle.

These are worth adding: the unit specs fake every read, and these prove the scan's maker read, the tmux listing by tty,
and herdr's socket and `ss` reads on real processes and real ttys, in the case Diego hit. An iTerm2 e2e cannot measure
the real `iTermServer` form (the stand-in has the form the row assumes), so Gap 2's risk stays in the PR body.

### Task 10: e2e (macOS): tmux in an iTerm2 tab, found by the scan

**Files:** Modify `cli/e2e/dialTmuxTerminal.e2e.ts`, `cli/e2e/harness/outsideAgent.ts`. **Depends on:** 8.
**Effort:** high. **Failing test first:** the new cases run on the base `2e45e251d3` in a throwaway worktree (the two
files copied in) fail at "iTerm2's page holding the agent"; at the branch head they pass.

- [ ] Harness: a fake app `'iterm-server'`, macOS only: Node symlinked at
  `$HOME/Library/Application Support/iTerm2/iTermServer-3.6.6` of the daemon's throwaway home, no bundle, started by a
  `/bin/sh` that exits at once so launchd adopts it (ppid 1), as iTerm2's server is after iTerm2 relaunched with its
  sessions kept; its tab's close kills the command, then the server by pid, and waits until it is gone (no fixed
  sleep). Every other fake app is unchanged.
- [ ] Case `found by the scan after the devices start, an agent in the person's tmux whose client is in an iTerm2 tab is
  on iTerm2's page, one row, and on no tmux or Other page`: the session, `tabClient(d, SESSION, 'iterm-server')` and
  `InOwnTmux.startIn` before `desk.plug`; then the apps frame holds `iterm` with count 1; the log matches
  `/\[observed\] scan · 1 found · .* · 1 nested placed/` and `[device] tmux client · found`.
- [ ] Case `with iTerm2 in front a swipe selects the client's tab, then the agent's pane`: B started after the plug;
  the watch's front `com.googlecode.iterm2`; a `{"select":{"app":"iterm","tty":…}}` line, and the agent's pane active.
- [ ] The log case also checks these cases' log: no tty, pane id, session name or session id.
- [ ] `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialTmuxTerminal.e2e.ts` → PASS, none
  skipped. Commit.

### Task 11: e2e (Linux): herdr in WezTerm, found by the scan

**Files:** Modify `cli/e2e/dialHostHerdrWezterm.e2e.ts`. **Depends on:** 9. **Effort:** high. **Failing test first:**
as Task 10, on the base in a throwaway worktree: the rest activates no client pane.

- [ ] A `fresh` variant that plugs the dial only after `server.hooked('api')` ran and herdr sees the agent idle.
- [ ] Case `found by the scan, with herdr's row of its session: one row on WezTerm's page; a rest with WezTerm in front
  activates the client's pane and tab, then focuses the agent's herdr pane`: before the plug, the agent's session is
  told to herdr as its integration's hook tells it (`server.rpc('pane.report_agent_session', { pane_id, source:
  'herdr:claude', agent: 'claude', agent_session_id })`, `RECORDED_HERDR` byReport); the log matches `· 1 nested placed`.
- [ ] Case `found by the scan, with no session in herdr's row: on WezTerm's page with its tab, and herdr's row on
  herdr's page`: a rest activates the client's pane and tab, and herdr's focused pane does not move.
- [ ] `unsaid` holds the agent's tty, pane, session and folder for both cases.
- [ ] Runs on PR CI's `dial-hosts` (herdr 0.9.5 and WezTerm on ubuntu-24.04, a skip fails there); on this Mac it skips
  without WezTerm, said in the PR. Commit.

---

### Task 12: Docs

**Files:** Modify `cli/AGENTS.md` (the devices row), `cli/src/services/AGENTS.md` (`Do not`: the person's tmux and
herdr), `docs/cli.md` (`herdr inside a terminal`). **Depends on:** 9. **Effort:** medium. **Failing test first:** none
(docs), one commit.

- [ ] `cli/AGENTS.md` devices row: an agent the open scan found, idle since the devices started, in the person's tmux or
  herdr is placed by its terminal's maker: tmux's pane by its own tty from one `tmux list-panes -a` (at most 1024 lines
  read, one listing every 5 s), herdr's client from its server; the scan reads the process table once a look and the
  ttys of a session with tmux or herdr among its parents only; its herdr pane is focused only when herdr's own list
  gives that pane its session (`herdr integration install claude`); iTerm2's `iTermServer-<version>`, in its
  Application Support folder, `~/.iterm2/` or by its bare name, counts as iTerm2 on macOS.
- [ ] `cli/src/services/AGENTS.md`: the devices process may move to the pane a hook named, or to the pane the open scan
  found by the agent's own tty, once it checked that the pane's process is the agent's or one of its parents; it runs
  `herdr agent focus` for the pane a hook named, or the pane herdr's own list gives the agent's session.
- [ ] `docs/cli.md`: an agent in herdr or tmux the dial found before its first prompt is on that app's page too; its
  herdr pane is focused once `herdr integration install claude` is set up.
- [ ] Commit.

---

## Verification

1. **Unit suites and types, locally, at the final head** (this Mac): `cd cli && npm run typecheck && npm test`. Seen:
   green, including `src/testing/dialAppEval/dialAppEval.spec.ts` (the eval's scores unchanged: its sessions have no
   tmux or herdr parent, so no maker is read).
2. **Local gate** (PR CI does not run it): from a clean tree at the final head,
   `python3 scripts/local-checks.py --run`; it runs `npm run test:core` (`src/services/devices.ts` at 100% a file) and
   whatever else the paths select. Its fence goes in the PR body before the push.
3. **PR CI** (GitHub, started by the push; no run dispatched by hand, `cli-e2e.yml`'s `dial_hosts` input is not
   needed): `cli-typecheck`, `cli-tests` (four shards); `dial-hosts` (selected by `cli/src/cable/hosts/` and the
   `dialHost*` file: Task 11's cases with every dial-host file, none skipped); `linux-e2e` (the dial app eval's three
   files, selected by `cli/src/cable/hosts/`; the canary for `cli/e2e/harness/outsideAgent.ts`; `dialTmuxTerminal`
   skips every case on Linux and is listed in the summary); `windows-e2e` on x64 (selected by `cli/src/cable/`: Windows
   unchanged). Seen: all green.
4. **macOS e2e, locally** (no PR CI suite runs macOS), on this Mac at the final head, one file at a time, isolated as
   the End-to-end section says: `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/<file>` for
   `dialTmuxTerminal.e2e.ts` (Task 10's cases and the hooked ones), `dialHerdrTerminal.e2e.ts`,
   `dialTerminalFollow.e2e.ts`, `deviceWithoutApp.e2e.ts`, `dialAppFilter.e2e.ts` and `deviceOrcaHomes.e2e.ts` (their
   scan-line patterns), `deviceHerdrApp.e2e.ts` (needs `herdr-core` in `~/.local/bin`; else named as not run). Seen: each
   passes with none skipped; a skip is named in the PR. `dialHostHerdrWezterm.e2e.ts` skips here (no WezTerm) and runs
   on `dial-hosts`.
5. **Numbers for a look over 50 sessions** (code standard 4), a script in the scratchpad, never committed, on this Mac,
   at the final head and at the base `2e45e251d3` in a throwaway worktree:
   - Stand-ins: a private tmux server from `src/testing/isolatedTmux.ts` (its own socket under a temporary root) with
     50 windows, each `/bin/sh -c 'exec sleep 600'` (50 idle agents in tmux panes, tmux their maker), and 50
     `sleep 600` children of the script on no terminal (50 agents in no multiplexer). Everything is killed at the end.
   - Reads: an `ObservedSource` whose `openSessions` and `sessionRows` are fakes naming those pids (no `~/.claude`
     read), with the real `readProcessNames`, `readTtyName`, `readMadeBy`, `learnApps` (roots under a temporary home)
     and `createTmuxNested`, its `run` adding `-S <socket>` so only the private server answers; `ps` and tmux runs
     counted by wrapping the runners. The base run leaves out what the base lacks.
   - For each set, 10 looks on a fresh source each, medians of: table reads a look, `ps -o tty=` runs a look, tmux
     runs a look, the scan line's ms, and ms from `scanOpen()` to its end.
   - Expected after: 1 table read for each set; 0 tty reads for the 50 not nested, about 3 a session for the 50
     nested; 1 `list-panes` a look and 1 `list-clients` a nested session. Before: 1 table read, 0 tty reads, 0 tmux
     runs. Both tables go in the PR body. Linux is not measured: its `ps` reads `/proc`, and macOS's one-pid `ps`
     (2.4 ms) is the worst case.
6. **Windows:** Task 8's unit test (nothing read or run there) and `windows-e2e` x64 (item 3).
7. **Needs Diego himself** (his own login, his iTerm2, his eye; no agent reads his terminals): once his CLI carries the
   change, with his four agents idle in iTerm2 (a plain tab, tmux in a second tab, two herdr panes in a third),
   `harness stop && harness start` before typing into any of them. Seen: iTerm2's page lists four rows; a swipe to each
   selects its tab and, for tmux, its pane; for herdr's panes, only after `herdr integration install claude`. Optional,
   by his own hand: `ps -axo comm= | grep iTermServer` tells which of the row's forms his Mac prints; a form the row
   does not take is a follow-up.
8. **Proposal, not in this PR:** a macOS e2e job for the dial files no GitHub workflow runs (`dialTmuxTerminal`,
   `dialHerdrTerminal`, `dialVscodeFollow`, `deviceHerdrApp`), as #4500 and the 2026-11-21 Linux follow-ups plan
   proposed.

**For the pull request** (copy the main session writes): platforms (macOS: both gaps; Linux: Gap 1 for tmux and herdr;
Windows: unchanged, no scan walk and no `ps` there); the red-then-green tests of Tasks 4, 8 and 9; item 5's numbers;
the Gap 2 risk as the spec words it (the row was not measured against a live iTermServer; a process outside iTerm2
named exactly `iTermServer-<version>` would put its children's agents on iTerm2's page, a wrong page, never words in a
wrong place; a different measured form changes the row in a follow-up); one line for users: run
`herdr integration install claude` so the dial focuses the right herdr pane; out of scope: Zellij found by the scan, a
scan-found herdr agent with no session in herdr's row (two rows until its first hook), kitty's tab for a scan-found
agent (its socket comes with the first hook), words before the first hook.
