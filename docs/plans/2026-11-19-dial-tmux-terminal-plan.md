# A Claude Code session in the person's tmux shows on the page of the terminal app that holds the tmux client — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(cli): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message.

**Goal:** An agent in a tmux pane the person opened lands on the dial page of the app that holds the tmux client attached to that pane's session (Terminal, iTerm2, Ghostty, …), and the dial's swipe, rest and tap reach it there.

**Architecture:** In the devices process only. `cable/hosts/tmux.ts` gains a lookup (`createTmuxOuter`) that asks the daemon's tmux which client shows the pane's session and walks that client's parents to its app (`scannedApps`), with the client's tty as the tab. `observed.ts` takes the answer through a generic dep (`outer`) and keeps it on the session's entry as `Place.outer`; `tabs.ts` takes its tab from it; the tmux pane carries the app and, while that app is in front, a rest selects the pane's window and pane on its own session. `services/devices.ts` wires both.

**Tech Stack:** TypeScript, vitest, tmux; `cli/`.

**Spec:** `docs/plans/2026-11-19-dial-tmux-terminal-design.md`. Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md` (rules 4-7) and `cli/src/services/AGENTS.md` (the person's-tmux paragraph under "Do not").

## Base

- Branch `fix/dial-tmux-in-terminal-app` at `91f60b6a7b`, in this worktree.
- **Before the first task, once:** `cd cli && npm ci --no-audit --no-fund` (`cli/` has no `node_modules`). One process runs it, never two tasks at once.
- Names at the base. `tmux.ts`: `TMUX_PANE_ID`, `PID`, `PANE_AND_PID`, `TMUX_PANE_FACTS`, `TMUX_PANE_FACT`, `TMUX_CLIENTS`, `TmuxDeps`, `createTmuxAdapter`, `personsClient`, `notItsPane`. `scannedApp.ts`: `ProcessName`, `scannedApps`, `appRoots`, `readBundleId`, `readProcessNames`, `parentChain`. `observed.ts`: `ObservedDeps`, `Entry`, `learnTty`, `learnApp`, `locate`, `target`, `shown`, `showPane`, `focus`, `byTab`, the `rest`/`tapped` predicates. `devices.ts`: `observedSource(...)` (positional `tty, scanned, herdrTerminal`), `const tmux = noting(createTmuxAdapter(...))` at line 477, `monotonic`, `cableHost.latestFront()`. Specs: `tmux.spec.ts` `recorder`, `TABLE`, `says`, `client`, `OWN`, `asked`, `listed`; `observed.spec.ts` `setup`, `fakeActions` (its `createTmuxAdapter` line), `describe('ObservedSource tabs')` `tabs()`; `devices.spec.ts` `readers`, the `vi.mock('../cable/hosts/scannedApp.js')` block, `startHere`, the two tmux tests at line 3028 and 3055. If a name differs, follow the code and say so in the report.
- Branch `fix/dial-claude-app-idle-sessions` (in review) also touches `observed.ts`, `select.ts`, `appFilter.ts`, `cableHost.ts`, `devices.ts`: when it merges, rebase on `main` keeping both sides.
- The spec and this plan are untracked. The main session commits them; no task does.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 A place can name its outer app and tab | `cli/src/cable/hosts/adapter.ts`, `cli/src/cable/hosts/tabs.ts`, `cli/src/cable/hosts/tabs.spec.ts` | none | medium | `tabs.spec.ts` `a place with an outer app and tty is that tab` |
| 2 The tmux lookup: the client's app and tty | `cli/src/cable/hosts/tmux.ts`, `cli/src/cable/hosts/tmux.spec.ts` | none | xhigh | `tmux.spec.ts` `describe('the outer place of an agent in the person\'s tmux')` |
| 3 The tmux pane carries its app: show, canShow, focus | `cli/src/cable/hosts/tmux.ts`, `cli/src/cable/hosts/tmux.spec.ts`, `cli/src/cable/hosts/observed.spec.ts` (the `fakeActions` tmux line only), `cli/src/services/devices.ts` (line 477 only) | 1, 2 | high | `tmux.spec.ts` `describe('a pane with its app')` |
| 4 The observed source keeps the outer place; rest and tap use both panes | `cli/src/cable/hosts/observed.ts`, `cli/src/cable/hosts/observed.spec.ts` | 1, 3 | xhigh | `observed.spec.ts` `describe('ObservedSource outer place')` |
| 5 Wired in the devices process, proven end to end | `cli/src/services/devices.ts`, `cli/src/services/devices.spec.ts`, `cli/e2e/dialTmuxTerminal.e2e.ts` (new), `cli/e2e/harness/outsideAgent.ts`, `cli/e2e/harness/ownTmux.ts` | 2, 4 | high | `devices.spec.ts` new tmux test; `e2e/dialTmuxTerminal.e2e.ts` on this Mac |
| 6 Docs: the devices row and the person's-tmux rule | `cli/AGENTS.md`, `cli/src/services/AGENTS.md` | none | medium | none: docs, one commit |

Longest chain: 2 → 3 → 4 → 5 (four tasks). Tasks 1, 2 and 6 start at once. Task 3 touches one line of `observed.spec.ts` and one of `devices.ts` because it makes `TmuxDeps.front` required, and both construct the adapter: that keeps `npm run typecheck` green at every commit.

## Global Constraints

- **Devices process only.** Nothing in `cli/src/core/`, `cli/hook/` or the observed route's body; no new hint; no line of `cli/src/architecture.coreFiles.txt` changes (`cli/AGENTS.md` rule 7, core rule).
- **No reading another process's environment** (`tmux show-environment` included). `src/architecture.environment.spec.ts` stays green.
- **tmux in the person's server:** only `display-message`, `list-clients`, `select-window ; select-pane` (new) and today's `switch-client`. Never `switch-client` on a swipe or rest; never a command on a session Harness made or a pane with a daemon's tag. tmux is the daemon's: the name on PATH, no `-L`/`-S`, no shell, every value one argument.
- **Outside text:** the pane id against `TMUX_PANE_ID`, the caller and client pid against `PID`, the client's tty against `TAB_TTY` (`tabs.ts`), the pane id's app field against `APP_IDS`. The session name is read only for `isHarnessSession`, never logged or used as a target.
- **Logs:** counts and fixed words only (#4458): `[device] tmux client · found`, `[device] tmux client · none`, `[device] tmux client · not read`, and the existing `[device] open · tmux · not its pane`. No pane id, pid, tty, session, bundle or app name in a line.
- **Bounds:** at most one lookup per pane in flight and one per pane every `OUTER_EVERY_MS = 5_000` ms (a sooner ask gets the last answer); one `ps` and up to `BUNDLES_A_PASS` (16) `plutil` runs a lookup; each tmux run `RUN_TIMEOUT_MS`.
- **Pane id:** `%3:100` as today, or `%3:100:terminal-app` when `place.outer.app` is in `APP_IDS`.
- **Harness paths** only through `cli/src/config/harnessHome.ts` (none are needed).
- **No fixed sleeps:** fake clocks in units, `until` in e2e.
- **Coverage:** `src/services/devices.ts` stays at 100% per file (`npm run test:core`).

## Decisions made in this plan (the spec left them to the builder)

- Names: `createTmuxOuter(deps: TmuxOuterDeps): TmuxOuter`, `OUTER_EVERY_MS`, `Outer` (in `adapter.ts`), `ObservedDeps.outer`, `TmuxDeps.front`.
- The lookup's log word: `found` when it answers an app; `none` when it read everything and answers `{}` (a Harness pane, a pane not in the caller's chain, no client, a client whose parents name no listed app); `not read` when a run failed or said nothing parseable (`display-message` or `list-clients` non-zero or unparseable, `processes()` rejected). A cached answer logs nothing.
- The 5 s window runs from a lookup's start; the cache drops every pane's answer older than 5 s at each ask, so it holds only panes asked in the last 5 s.
- "The pane stays the same" in `observed.ts` is generic: the caller pid and a shallow-equal hints record are those the answer was asked for.
- A rest shows the tab, waits for it, then the tmux pane (the order of Goal 3).
- The e2e's agent is `InOwnTmux` (`e2e/harness/ownTmux.ts`, already "Claude Code in a tmux session a person opened by hand"), started in a window of a session whose client already attached, so its `session-start` finds the client; the fake Terminal and its PTY tab come from `outsideAgent.ts` (`FAKE_APPS`, `fakeApp`, `PTY`).

## Review Focus

Inputs the spec implies and its own test list does not name. Each has its test in the task that owns the code.

1. **A control-mode client** (`tmux -C`, every Harness terminal and a phone's): no tty and the test runner or the daemon as its parent. Expected: never a tab, never an app; if it was used last it still is the client (spec rule), and the answer is `{}`. Task 2, `a control client used last answers {}`.
2. **An answer that lands late:** the session moved to another caller or pane, ended, or was asked again since. Expected: dropped; only the latest ask for the current caller and hints lands. Task 4, `an answer for an earlier ask, caller or pane, or after the end, is dropped`.
3. **Command Code's turn-start at every tool call**, several panes at once. Expected: one lookup per pane per 5 s, one in flight per pane shared, other panes not held back. Task 2, `one lookup per pane in flight, and one per pane every 5 s`. The cache's pruning (only panes asked in the last 5 s) is not observable from outside: the reviewer checks it in the code.
4. **A pane id with an app field that is no app** (`%3:100:1`, `%3:100:Terminal`, `%3:100:terminal-app:x`). Expected: no command runs, `canShow` false. Task 3, `a pane id not in its form runs nothing` (extended).
5. **The re-ask at turn-start answers `{}`** (the person detached). Expected: the agent goes back to the `tmux` page and its tab goes; while the re-ask runs it keeps its page (no flicker). Task 4, `turn-start and session-start ask again, keeping the outer place until the answer`.

---

### Task 1: A place can name its outer app and tab

**Files:**
- Modify: `cli/src/cable/hosts/adapter.ts` (`Place`)
- Modify: `cli/src/cable/hosts/tabs.ts` (`paneOf`)
- Test: `cli/src/cable/hosts/tabs.spec.ts`

**Interfaces:**
- Produces: `export interface Outer { app: string; tty?: string }` in `adapter.ts`, and `Place.outer?: Outer` (doc comment: the app and tab of the terminal holding the multiplexer's client, from `observed.ts`; only the tmux and tabs adapters read it).

- [ ] **Step 1: Write the failing test** in `tabs.spec.ts`, beside the existing `paneOf` cases:

```ts
it('a place with an outer app and tty is that tab, whatever its host and app', () => {
  const adapter = createTabsAdapter({ isOpen: () => true, select: () => true })
  const nested = { host: 'tmux', app: 'tmux', hints: { TMUX_PANE: '%3' }, tty: '/dev/ttys099', pid: 100 }
  expect(adapter.paneOf({ ...nested, outer: { app: 'terminal-app', tty: '/dev/ttys004' } })).toEqual({ adapter: 'tabs', id: 'terminal-app:/dev/ttys004' })
  // An outer app with no tty, a tty out of form, or an app with no tabs: no tab, and the multiplexer's own pty is never one.
  for (const outer of [{ app: 'terminal-app' }, { app: 'terminal-app', tty: '/dev/pts/3' }, { app: 'orca', tty: '/dev/ttys004' }]) {
    expect(adapter.paneOf({ ...nested, outer }), JSON.stringify(outer)).toBeUndefined()
  }
  expect(adapter.paneOf(nested)).toBeUndefined()
})
```

- [ ] **Step 2: Run it to see it fail:** `cd cli && npx vitest run src/cable/hosts/tabs.spec.ts` → FAIL (`paneOf` answers undefined for the first case; typecheck of `outer` also fails).
- [ ] **Step 3: Implement.** Add `Outer` and `Place.outer` to `adapter.ts`. In `tabs.ts` `paneOf`: when `place.outer` is there, the tab is `tabOf({ app: place.outer.app, tty: place.outer.tty })`; otherwise today's code. Update the comment there to say why (the client's tty is the tab; the pane's pty never is).
- [ ] **Step 4: Run** `npx vitest run src/cable/hosts/tabs.spec.ts && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `fix(cli): a dial tab can be the terminal that holds a tmux client`.

---

### Task 2: The tmux lookup: the client's app and tty

**Files:**
- Modify: `cli/src/cable/hosts/tmux.ts`
- Test: `cli/src/cable/hosts/tmux.spec.ts`

**Interfaces:**
- Consumes: `scannedApps`, `parentChain`, `ProcessName`, `BUNDLES_A_PASS` (`scannedApp.ts`); `TAB_TTY` (`tabs.ts`); `isHarnessSession` (already imported).
- Produces (all exported from `tmux.ts`):
  - `TmuxDeps.processes(): Promise<readonly ProcessName[]>` (widened from `Pick<ProcessName, 'pid' | 'ppid'>`; `devices.ts` already passes `readProcessNames`).
  - `export const OUTER_EVERY_MS = 5_000`
  - `export interface TmuxOuterDeps { run: TmuxDeps['run']; processes: TmuxDeps['processes']; log: TmuxDeps['log']; now(): number; platform: NodeJS.Platform; roots: readonly string[]; bundleId(bundle: string): Promise<string | undefined> }`
  - `export type TmuxOuter = (hints: Readonly<Record<string, string>>, pid: number) => Promise<{ app?: string; tty?: string }> | undefined`
  - `export function createTmuxOuter(deps: TmuxOuterDeps): TmuxOuter`

**Shared fixture:** `TABLE` in `tmux.spec.ts` gains an `executable` on each row (`'claude'`, `'zsh'`, `'tmux'`, `'other'`), as the widened type asks; the adapter's tests keep their meaning. Task 3 edits the same file after this task.

- [ ] **Step 1: Write the failing tests** in a new `describe('the outer place of an agent in the person\'s tmux')`. A `lookup(over, codes, said)` helper like `recorder`: `run` records calls and answers `display-message` with `said.pane`, `list-clients` with `said.clients`; `processes` answers `TABLE` plus the client chain `{ pid: 4300, ppid: 4299, executable: 'tmux' }`, `{ pid: 4299, ppid: 4298, executable: '/usr/bin/python3' }`, `{ pid: 4298, ppid: 1, executable: '/Users/u/Applications/Terminal.app/Contents/MacOS/Terminal' }`; `roots: ['/Users/u/Applications/']`; `bundleId` maps `/Users/u/Applications/Terminal.app` to `com.apple.Terminal`; `platform: 'darwin'`; `now` from a clock. A `places(activity, pid, tty)` helper prints one `list-clients` line, `<activity>|<pid>|<tty>` and a newline. The expected calls:

```ts
const paneAsked = run('tmux', 'display-message', '-p', '-t', '%3', /* TMUX_PANE_FACTS, as `asked` */)
const clientsAsked = run('tmux', 'list-clients', '-t', '%3', '-F', '#{client_activity}|#{client_pid}|#{client_tty}')
```

Tests (each asserts the answer, the calls and the log lines):
  - `not tmux: undefined at once, and nothing runs` — hints `{}`, `{ TMUX_PANE: '%3; x' }`, `{ TMUX_PANE: '%1234567890' }`, and pid `0`, `-1`, `1.5`: the call returns `undefined` (not a promise), `calls` and `processes` untouched.
  - `a person\'s pane with one client: the client\'s app and tty` — `OWN` pane, clients `places(1794700050, 4300, '/dev/ttys004')` → `{ app: 'terminal-app', tty: '/dev/ttys004' }`; calls `[paneAsked, clientsAsked]`; `processes` called once; logs `['[device] tmux client · found']`.
  - `a Harness pane answers {} and lists no client` — the three `harness` pane lines of the existing tap test → `{}`, calls `[paneAsked]`, logs `['[device] tmux client · none']`.
  - `a pane not in the caller\'s chain answers {}` — `says(4242)` → `{}`, no `list-clients`, logs `none`.
  - `a detached session answers {}` — clients `''` → `{}`, logs `none`.
  - `the client used last wins; on a tie the one listed later` — three lines, two at the same newest activity; the later one's pid has the Terminal chain → its app and tty.
  - `a control client used last answers {}` — the newest line is `places(1794700100, 4242, '')` (4242's parent is init, no app) → `{}`.
  - `a tty out of form: the app alone` — `/dev/pts/3`, `''`, `ttys004`, `/dev/ttys004; x` → `{ app: 'terminal-app' }`.
  - `a client whose parents name no listed app answers {}` — `bundleId` gives `com.example.other`.
  - `on Linux the app is read from the names, and no tty passes` — `platform: 'linux'`, the client's parent's executable `ghostty`, tty `/dev/pts/3` → `{ app: 'ghostty' }`.
  - `tmux or ps that fails: {} and not read, never a rejection` — `display-message` code 1, `display-message` stdout `abc\n`, `processes` rejects, `list-clients` code 1, a client line `soon|4300|/dev/ttys004` and `1|0|/dev/ttys004` (no client) → each `{}`; the first four log `['[device] tmux client · not read']`.
  - `one lookup per pane in flight, and one per pane every 5 s` — with a `run` the test settles by hand: two asks for `%3` before it settles share one `display-message`; an ask at `now + 4_999` gets the last answer with no call; at `+ 5_000` it runs again; `%4` asked while `%3` is in flight runs its own and is not held back by it; an answer is never given past 5 s (the ask at `+ 5_000` runs commands even with `%4`'s answer fresh).
  - `its lines name no pane, pid, tty, session, bundle or app` — every log line from the cases above against `%3`, `4300`, `ttys004`, `work`, `com.apple.Terminal`, `Terminal`, `terminal-app`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/tmux.spec.ts` → FAIL (`createTmuxOuter` is not exported).
- [ ] **Step 3: Implement `createTmuxOuter`** in `tmux.ts`, beside the adapter, with the spec's four steps ("The outer place of a nested agent"): `TMUX_PANE_FACTS`/`TMUX_PANE_FACT` and the owner/`isHarnessSession` rule; one `deps.processes()` read and `parentChain(pid, table)` holding the pane's pid; `list-clients -t %N -F TMUX_CLIENT_PLACES` (new constant `'#{client_activity}|#{client_pid}|#{client_tty}'`, line form `/^([0-9]+)\|([1-9][0-9]{0,9})\|(.*)$/`), last used wins, tie → later; `scannedApps([clientPid], { platform, roots, processes: async () => rows, bundleId })`; tty kept only when `TAB_TTY` passes. Never rejects (a `.catch` that logs `not read` and answers `{}`). The in-flight and 5 s cache is a `Map<paneId, { at: number; answer: Promise<…> }>` pruned at each ask. Widen `TmuxDeps.processes`. Comments say why (Diego's server started by the daemon, so no bundle id; Command Code's turn-start per tool call for the bound).
- [ ] **Step 4: Run** `npx vitest run src/cable/hosts/tmux.spec.ts && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `fix(cli): the devices learn the app and tty of the tmux client that shows a pane`.

---

### Task 3: The tmux pane carries its app: show, canShow, focus

**Files:**
- Modify: `cli/src/cable/hosts/tmux.ts` (`paneOf`, `PANE_AND_PID`, `focus`, new `canShow`/`show`, `TmuxDeps.front`)
- Test: `cli/src/cable/hosts/tmux.spec.ts`
- Modify: `cli/src/cable/hosts/observed.spec.ts` — only the `createTmuxAdapter(...)` line in `fakeActions`: add `front: () => undefined`.
- Modify: `cli/src/services/devices.ts` — only line 477: add `front: () => cableHost.latestFront()`.

**Interfaces:**
- Consumes: `Place.outer` (Task 1); `APP_IDS` (`hostDetect.ts`); the widened `TmuxDeps` (Task 2).
- Produces: `TmuxDeps.front(): string | undefined` (the app in front, `cableHost.latestFront()`); the pane id `%N:<pid>` or `%N:<pid>:<app>`; `canShow(pane): boolean`, `show(pane, agentId): Promise<PaneSwitch>`; `tap` stays `'before'`.

- [ ] **Step 1: Write the failing tests.** Change the first test (`its id is tmux …`): `show` and `canShow` are now functions. `recorder` gains `front` (default `() => 'terminal-app'`). New `describe('a pane with its app')`:
  - `paneOf adds the outer app when it is one of the apps` — `outer: { app: 'terminal-app', tty: '/dev/ttys004' }` → `{ adapter: 'tmux', id: '%3:100:terminal-app' }`; `outer: { app: 'nope' }` → `%3:100`; no `outer` → `%3:100`.
  - `canShow: only a pane with an app, only while that app is in front` — `%3:100:terminal-app` with front `terminal-app` → true; front `ghostty` or `undefined` → false; `%3:100` → false.
  - `show selects the pane\'s window and pane on its own session, after the same checks as a tap` — `OWN` → `'ok'`, calls `[asked, run('tmux', 'select-window', '-t', '%3', ';', 'select-pane', '-t', '%3')]`; no `list-clients`, no `switch-client`.
  - `show refuses another process\'s pane or a Harness pane, with one line` — `says(4242)` and the three Harness lines → `'failed'`, calls `[asked]`, logs `['[device] open · tmux · not its pane']`.
  - `show that tmux does not answer, or a select that fails, is failed` — codes `[1]`, `[0, 1]`, pane `''`.
  - `a tap on a pane with its app runs the same select, never switch-client` — through `opener.open('a1', { bundle: 'com.apple.Terminal', pane: { adapter: 'tmux', id: '%3:100:terminal-app' } })` → calls `[asked, select, forward('com.apple.Terminal')]`.
  - `a tap on a pane with no app keeps switch-client` — the existing tap tests stay as they are and pass.
  - Extend `a pane id not in its form runs nothing` with `'%3:100:1'` (already there), `'%3:100:Terminal'`, `'%3:100:terminal-app:x'`, `'%3:100:'`, for `focus` and `show`, and assert `canShow` false for each.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/tmux.spec.ts` → FAIL.
- [ ] **Step 3: Implement.** `PANE_AND_PID` reads an optional third field (`(?::([a-z-]{1,32}))?`) and a pane is in form only when that field is absent or in `APP_IDS`. Move `focus`'s checks (display-message, owner/Harness rule, chain) into one private `checkedPane(id, agentPid): Promise<true | false | 'refused'>`; `show` and an app-carrying `focus` then run one `tmux select-window -t %N ; select-pane -t %N`; `focus` without an app keeps `personsClient` and `switch-client`. Update the file's top comment: the select is the second thing done in the person's tmux, on the pane's own session, for every client on it. Add the two one-line wirings (`observed.spec.ts`, `devices.ts`).
- [ ] **Step 4: Run** `npx vitest run src/cable/hosts/tmux.spec.ts src/cable/hosts/observed.spec.ts src/services/devices.spec.ts && npm run typecheck` → PASS (the last two unchanged in behavior: no place has `outer` yet).
- [ ] **Step 5: Commit** `fix(cli): a dial rest or tap selects a tmux pane on its own session while its terminal app is in front`.

---

### Task 4: The observed source keeps the outer place; rest and tap use both panes

**Files:**
- Modify: `cli/src/cable/hosts/observed.ts`
- Test: `cli/src/cable/hosts/observed.spec.ts`

**Interfaces:**
- Consumes: `Outer`, `Place.outer` (Task 1); the tmux adapter's `canShow`/`show` and the `%N:<pid>:<app>` id (Task 3).
- Produces: `ObservedDeps.outer?(hints: Readonly<Record<string, string>>, pid: number): Promise<{ app?: string; tty?: string }> | undefined` (doc: the place of an agent nested in a host whose own pty is no tab, `tmux.ts` `createTmuxOuter`; `undefined` at once when the event is not nested; absent, nothing is learned). `Entry` gains `outer?: Outer` and the ask it came from (caller and hints).

**Shared fixture:** `fakeActions` builds the tmux adapter with `front: () => fake.tmuxFront()` (new fake, default `() => 'terminal-app'`), and its `ran` answers `display-message` with `'100|work|\n'` so a tmux `show` passes its checks against a `processes` of `[{ pid: 100, ppid: 1, executable: 'claude' }]`. Tests that expect `ran` calls today still pass (check `ran` assertions in the file). Expected tmux pane ids for a nested agent are `'%3:100:terminal-app'`; the existing `'%3:100'` expectations (no `outer` dep) stay.

- [ ] **Step 1: Write the failing tests** in a new `describe('ObservedSource outer place')`, with `vi.useFakeTimers()`, a `tty` dep spy, and an `outer` dep whose answers the test settles by hand (as `tabs()` does for tty reads). The event: `ev('session-start', { hostHints: { TMUX_PANE: '%3', TERM_PROGRAM: 'tmux' } })`.
  - `a nested event lands on its outer app, with its client\'s tty and that app\'s bundle` — before the answer: `app` is `tmux`; after `{ app: 'terminal-app', tty: '/dev/ttys004' }` lands: `list()[0].app === 'terminal-app'`, `byTab('terminal-app', '/dev/ttys004')` is the agent, `paneOf(id, 'tabs') === 'terminal-app:/dev/ttys004'`, `paneOf(id, 'tmux') === '%3:100:terminal-app'`, a tap's target bundle `com.apple.Terminal`; `tty` never called; `changes` fired.
  - `needs-input and turn-stop keep it, and ask nothing` — `outer` called once after `session-start`, `needs-input`, `turn-stop`; app stays `terminal-app`.
  - `turn-start and session-start ask again, keeping the outer place until the answer` — the second ask pending: app still `terminal-app`; it answers `{}`: app `tmux`, `byTab` undefined, no `tabs` pane.
  - `a new caller or a new pane drops it and asks again` — `callerPid: 101`, then `TMUX_PANE: '%4'`: app `tmux` at once, a new ask each.
  - `{} falls back to the app the hints name, as today` — `__CFBundleIdentifier: 'com.mitchellh.ghostty'` in the hints and `{}` → `ghostty`, no tab.
  - `an answer for an earlier ask, caller or pane, or after the end, is dropped` — answers landing out of order, after `callerPid` changed, and after `session-end`, change nothing.
  - `the caller\'s tty is never read, and an old one is cleared at once` — first a plain Terminal event with its tty read (`/dev/ttys031`), then a nested event for the same session: `byTab('terminal-app', '/dev/ttys031')` undefined at once, `tty` not called again.
  - `undefined: nothing changes` — `outer` answers `undefined`: the existing path (`tty` read for a tab app) runs.
  - `a rest shows the tab, then the tmux pane` — after the answer, `showPane` → `'ok'`; `tabSelect` called with `('terminal-app', '/dev/ttys004', false)` and then `ran` has `select-window … ; select-pane …`, in that order. Answers: tab `busy` → `busy`; tab `failed` and tmux `ok` → `ok`; both failed → `failed`.
  - `a rest while another app is in front shows the tab alone` — `tmuxFront` → `'ghostty'`: no `select-window`.
  - `a tap opens the tmux pane and the app, then raises the tab` — `focus` → `open` called with `{ bundle: 'com.apple.Terminal', pane: { adapter: 'tmux', id: '%3:100:terminal-app' } }`, then `tabSelect('terminal-app', '/dev/ttys004', true)`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts -t "outer place"` → FAIL.
- [ ] **Step 3: Implement** in `observed.ts`, per the spec's "The app, tty and bundle" and "Tap, swipe and rest": in `ingest`, after `entry.hints`/`entry.caller` are set, decide whether to ask (`session-start`, `turn-start`, or a caller/hints that differ from the last ask) and call `this.deps.outer?.(e.hostHints, e.callerPid)`; a promise clears `tty`/`ttyPid` and skips `learnTty`; a different caller or hints clears `outer` at once; the answer lands only for the latest ask while the caller and hints match and the entry is `live`, then sets `outer` (or clears it on `{}`), the app (`outer.app` else `detectApp`), `bundle` (`APP_BUNDLES[outer.app]` else `bundleOf`), `tty` (`outer.tty`), runs `locate` and `emit`. `locate` hands `outer: entry.outer` in the place. `showPane`: the first resting pane with `tap === 'after'`, then the first resting other one, each shown in turn, answers combined as the spec says. `focus`: after `open`, raise the first resting `'after'` pane. Comments name Diego's incident (2026-11-19) and why the caller's tty is never a tab here.
- [ ] **Step 4: Run** `npx vitest run src/cable/hosts/observed.spec.ts src/cable/hosts/tmux.spec.ts src/cable/hosts/tabs.spec.ts && npm run typecheck` → PASS (the whole of `observed.spec.ts`, not only the new block).
- [ ] **Step 5: Commit** `fix(cli): an agent in a tmux pane is on the page of the app that holds its client`.

---

### Task 5: Wired in the devices process, proven end to end

**Files:**
- Modify: `cli/src/services/devices.ts` (`observedSource` gains an `outer` parameter; `startDevices` builds the lookup)
- Test: `cli/src/services/devices.spec.ts`
- Create: `cli/e2e/dialTmuxTerminal.e2e.ts`
- Modify: `cli/e2e/harness/outsideAgent.ts` (`FAKE_APPS`, a new export)
- Modify: `cli/e2e/harness/ownTmux.ts` (new helpers)

**Interfaces:**
- Consumes: `createTmuxOuter`, `TmuxOuterDeps` (Task 2); `ObservedDeps.outer` (Task 4); `appRoots`, `readBundleId`, `readProcessNames` (`scannedApp.ts`).
- Produces (e2e harness):
  - `outsideAgent.ts`: `FAKE_APPS['terminal-app'] = { bundle: 'Terminal', id: 'com.apple.Terminal', exe: 'Terminal' }`; `export async function tabUnder(d: IsolatedDaemon, app: FakeApp, argv: readonly string[], env: NodeJS.ProcessEnv): Promise<{ pid: number; close(): Promise<void> }>` — the existing `PTY` helper under `fakeApp(d, app)`, `pid` the pseudo-terminal's child (the command itself), closed and waited for like `Outside.close`.
  - `ownTmux.ts`: `export async function tabClient(d: IsolatedDaemon, session: string, app: FakeApp): Promise<{ pid: number; tty(): Promise<string>; close(): Promise<void> }>` — `tabUnder(d, app, ['tmux', '-S', d.tmux.socket, '-f', '/dev/null', 'attach-session', '-t', session], { ...d.tmux.env, TERM: 'xterm-256color' })`, resolved once `list-clients -F '#{client_pid} #{client_tty}'` lists its pid; `tty()` reads it there. `InOwnTmux.startIn(d: IsolatedDaemon, session: string, folder: string): Promise<InOwnTmux>` — the engine in `new-window -d -t <session>` with the same `ENGINE_ENV` as `start`, so the session's active window stays the one it had.

- [ ] **Step 1: Write the failing tests.**
  - `devices.spec.ts`: add `readBundleId: readers.bundleId` to the `scannedApp.js` mock (never this machine's `plutil`). New test `an agent in the person\'s tmux is on the page of the app that holds its client, and a rest selects its tab, then its pane`: `readers.processes` holds the agent (4242 → 4000) and the client chain (4300 `tmux` → 4298 `${homedir()}/Applications/Terminal.app/Contents/MacOS/Terminal`, `homedir()` as the spec process reads it, since `devices.ts` passes `appRoots(homedir())`), `readers.bundleId` gives `com.apple.Terminal`; `run` answers `display-message` `4000|work|`, `list-clients` `1794700050|4300|/dev/ttys004`; after `session-start` with `{ TMUX_PANE: '%3', TERM_PROGRAM: 'tmux' }`: the snapshot's apps hold `terminal-app` with count 1 and no `tmux`; `said()` holds `[device] tmux client · found`; with the app in front `terminal-app`, a rest reaches `select-window`. Both wiring lambdas run (100% per file).
  - Update the two existing tmux tests at line 3028 and 3055: the lookup now runs at `session-start`, so `orcaRuns` gains its `display-message` and `list-clients -t %3 …` first, and the `says` queue gives the lookup its answer before the tap's; their tap behavior (no client app found: `switch-client`) is unchanged.
  - `e2e/dialTmuxTerminal.e2e.ts`, `describe.skipIf(process.platform !== 'darwin')`, header comment as `dialTerminalFollow.e2e.ts` (what is real, what is fake, never the person's tmux or Terminal). `fresh()`: `IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })`, a dial plugged with `{ appFilter: 'v1' }`, a second agent `Outside.start(d, 'b', { __CFBundleIdentifier: 'com.apple.Terminal' })` to swipe from; `d.tmux.run('new-session', '-d', '-s', 'own-work', '-c', <cwd>, '/bin/sh')`; `tabClient(d, 'own-work', 'terminal-app')`; `InOwnTmux.startIn(d, 'own-work', 'in-tmux')`; the watch as in `dialTerminalFollow.e2e.ts` (its own copy, with a `front(bundle)` writer), Terminal in front. Tests:
    - `an agent in the person\'s tmux is on Terminal\'s page, one row, and on no tmux page` — the latest `apps` frame has `terminal-app` count 2 and no `tmux` entry; the roster holds the agent's id once; the log has `[device] tmux client · found`.
    - `with Terminal in front a swipe selects the client\'s tab, then the agent\'s pane` — swipe from `b` to the agent (as `swipedTo`): the watch prints `{"select":{"app":"terminal-app","tty":<client tty>}}`, and `display-message -p -t own-work '#{pane_id}'` becomes the agent's pane (`until`).
    - `with another app in front a swipe changes nothing in tmux` — `select-window -t own-work:0`, front `com.apple.finder`, swipe again, wait for one more `[device] swipe ·` line, the active pane is still window 0's.
    - `the daemon\'s log has no tty, pane id, session name or session id` — the client's tty name, the agent's pane id, `own-work`, both session ids.
  - In every test nothing real opens: `d.env.HARNESS_OPEN_BIN` is checked inside `d.root` before anything is tapped, as `dialVscodeFollow.e2e.ts` does.
- [ ] **Step 2: Run them to see them fail:** `cd cli && npx vitest run src/services/devices.spec.ts -t "the page of the app that holds its client"` → FAIL (the agent is on `tmux`); `TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialTmuxTerminal.e2e.ts` on this Mac → the first two tests FAIL (a `tmux` entry, no select line).
- [ ] **Step 3: Implement** in `devices.ts`: build `createTmuxOuter({ run: apps.run, processes: readProcessNames, log, now: monotonic, platform: apps.platform, roots: appRoots(homedir()), bundleId: readBundleId })` once in `startDevices` and pass it to `observedSource` as `outer`, which hands it to `ObservedSource` (every platform: the lookup answers `undefined` with no `TMUX_PANE`). The harness helpers as in Interfaces.
- [ ] **Step 4: Run** `npx vitest run src/services/devices.spec.ts && npm run typecheck && npm run test:core`, then the e2e file, `e2e/dialTerminalFollow.e2e.ts` and `e2e/deviceWithoutApp.e2e.ts` on this Mac → PASS (the last two unchanged: a control client's parent is the test, so its lookup answers `{}`).
- [ ] **Step 5: Commit** `fix(cli): the devices process places a tmux agent by its client, end to end`.

---

### Task 6: Docs: the devices row and the person's-tmux rule

**Files:**
- Modify: `cli/AGENTS.md` (the `devices` row of the process table)
- Modify: `cli/src/services/AGENTS.md` (the person's-tmux paragraph under "Do not")

No red test: docs, one commit.

- [ ] **Step 1: Edit `cli/AGENTS.md`'s devices row:** beside "on macOS a swipe selects the agent's tab in Terminal, iTerm2 or Ghostty", add that an agent in a tmux pane the person opened is on the page of the app that holds the tmux client used last on that pane's session, learned from `tmux list-clients` and that client's parents (`cable/hosts/tmux.ts`), at most one lookup per pane every 5 s, kept in memory; its tab is that client's tty; a swipe or rest while that app is in front selects the tab, then the agent's tmux window and pane, and a tap selects them before the app comes.
- [ ] **Step 2: Edit `cli/src/services/AGENTS.md`'s paragraph:** the devices process may run `select-window` and `select-pane` on the pane's own session (which every client on that session then shows) once the pane's checks pass, and `switch-client` only when no client of the person's was found for that session; still nothing on a session Harness made, and never typing, creating or closing.
- [ ] **Step 3: Commit** `docs(cli): a tmux agent is on its client's app's page, and what the dial selects there`.

---

## Verification

**Platforms the pull request names:** macOS, fixed (units, and the end-to-end file on this Mac). Linux, affected: a tmux agent lands on its terminal's page with no tab, and a rest only selects the window and pane while that app is in front (Task 2's Linux unit case; PR CI's `cli-tests` run the unit files on Linux). Windows: not affected (no tmux; the lookup answers `undefined` with no `TMUX_PANE`), covered by the `not tmux` unit case.

### End-to-end checks

1. **The dial and a tmux agent in Terminal, macOS** (`cli/e2e/dialTmuxTerminal.e2e.ts`). Isolation: `IsolatedDaemon` gives a throwaway `HOME`, data folder, port and private tmux server (`TMUX_TMPDIR` in the test's root; the test's `tmux` runs with `-S <that socket> -f /dev/null`); `TMUX`/`TMUX_PANE` unset by the harness; the fake Terminal is a Node symlink under `$HOME/Applications/Terminal.app` with `CFBundleIdentifier` `com.apple.Terminal`, running the Python PTY helper that runs the tmux client; the watch is the real `harness hardware watch --json` under the daemon's env, written `front` lines by the test (no Harness Device runs); `HARNESS_OPEN_BIN` is the harness's fake. No GUI window opens, and the person's tmux, Terminal, daemon (port 18473), `~/.claude` and `~/.codex` are never touched. Run on this Mac: `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialTmuxTerminal.e2e.ts`. A person should see `4 passed`: red on Task 5's red commit (first two tests), green on the final head.
2. **Neighbours unchanged, macOS:** `e2e/dialTerminalFollow.e2e.ts` (a plain Terminal tab) and `e2e/deviceWithoutApp.e2e.ts` (a tap on an agent in the person's tmux with control clients keeps `switch-client`), same command and isolation.

Checks 1 and 2 run locally on this Mac only, by a tester, against the daemon's private tmux server and a throwaway `HOME`/`TMUX_TMPDIR`; no workflow runs them on GitHub. `cli-e2e.yml` is not started for this pull request: its Linux shards skip the macOS-only file. The pull request's body proposes (not in this pull request) a `workflow_dispatch` input on `cli-e2e.yml` that runs named end-to-end files on macOS.

No check needs a sign-in, a test account, a device or the person's own eye. **Against production:** none.

### Required local gates, at the final head, recorded in the pull request

- `cd cli && npm run typecheck`.
- `npx vitest run src/cable/hosts/tmux.spec.ts src/cable/hosts/tabs.spec.ts src/cable/hosts/observed.spec.ts src/services/devices.spec.ts src/architecture.spec.ts src/architecture.environment.spec.ts`.
- `npm run test:core` (100% per file, for `src/services/devices.ts`), or `python3 scripts/local-checks.py --run` from a clean tree at the final commit, whose `cli-core` fence goes in the pull request's body.
- `git diff --stat $(git merge-base HEAD origin/main) -- cli/src/core cli/hook cli/src/architecture.coreFiles.txt` prints nothing.
- Not needed: `npm run test:harnessd`, Desktop, device-app, firmware.

### Numbers

One lookup's wall time on a private tmux server, on this Mac, before and after, with 1 and 3 clients, median of 20 asks each. Never the person's server: `export TMUX_TMPDIR=$(mktemp -d) HOME=$(mktemp -d); unset TMUX TMUX_PANE`, a fake `Terminal.app` under that `HOME/Applications` as in `outsideAgent.ts`, a session `bench` running `/bin/sh`, and 1, then 3 clients attached from that fake app through the PTY helper. A scratch script (not committed, in the session's scratchpad) run with `npx tsx` from `cli/`:
- **After:** `createTmuxOuter` with the real deps (`execText`-based `run`, `readProcessNames`, `readBundleId`, `roots: appRoots(HOME)`, `platform: process.platform`), asked for the `bench` pane with its shell's pid, a fresh `now` each ask so none is cached; and once more within 5 s (the cached answer: no command).
- **Before:** the `readTty` (`ps -o tty=`) read of the agent's pid that `main` runs for a tmux event when the tmux server inherited a tab app's bundle id; zero commands when it has no bundle id.
- Kill the server (`tmux -S <socket> kill-server`) and remove both temp folders after. The table (1 client, 3 clients; before, after cold, after cached) goes in the pull request.

### Evidence the pull request carries

The red and green outputs of each task's tests and of end-to-end check 1, the `test:core` fence, the numbers above, and the platforms.

## Open questions

None.
