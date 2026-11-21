# The daemon serves the Harness Pro the round dial's app data (item A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(<area>): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message. A task with no red test is one commit. No task pushes or merges.

**Goal:** A device whose hello says `appCards: "v1"` gets `working` on each `apps` row; a device that says `swarms: "members-v1"` keeps the window's `swarms` while the view is an app's ring; specs pin the rest of what a Pro hello gets; the Pro's cable doc says so. The round dial's frames and cadence do not change.

**Architecture:**
- **`AppRings`** (`cli/src/cable/hosts/select.ts`) counts `working` beside `waiting`, over the same list as `count`; `AppEntry` (`hosts/types.ts`) gains `working: number`; `DaemonCableHost.appList()` and `tabApps()` (`cableHost.ts`) copy it into every row. The host always carries it.
- **`CableSession`** (`cableSession.ts`) decides per session: `appCards` sends the host's rows and keys on `working`; any other session drops `working` and keeps today's key. `syncSwarmsNow()` asks `listSwarms({})` (the window) for a `members-v1` device.
- Devices process only. Nothing in `cli/src/core/`, no firmware, no new message, timer, list or state file.

**Tech Stack:** TypeScript (Node, vitest) in `cli/`; the e2e harness in `cli/e2e/harness/`. No new dependency.

**Spec:** `docs/plans/2026-11-20-pro-app-data-daemon-design.md`, with the shared contract `docs/plans/2026-11-20-pro-parity-split.md` (sections 1-3, 5, 6). Read both with this plan, the root `AGENTS.md` and `cli/AGENTS.md` (Protect the core; Rules 5, 6, 7).

## Base

- Branch `feat/pro-app-data-daemon` at `ea1bffc979` (= its merge base with `origin/main`), worktree `/Users/duynguyen/orca/workspaces/autonomous-harness/pro-A-daemon`.
- **Before the first task, once:** `cd cli && npm ci --no-audit --no-fund` (the worktree has no `node_modules`). One `npm` process at a time.
- Names at the base (tasks name functions, never lines):
  - `hosts/select.ts`: `APP_LIMIT` (16), `interface AppRing { ring; rows; waiting }`, `AppRings.update`, `AppRings.apps`, `needsYou`. `hosts/select.spec.ts`: `agent`, `row`, `needs`, `working`, `at`, `ringIds`; the case `count and waiting follow the agents`.
  - `hosts/types.ts`: `AppEntry`, `AppList`, `HostAgentState`.
  - `cableHost.ts`: `appList`, `tabApps`, `windowOf`, `listSwarms`, `pickApp`, `answerPick`. `cableHost.spec.ts`: `describe('the dial that shows one app at a time')` with `agent`, `five`, `setup`, `onTab`; cases `the app list: fixed order, display names, count and waiting`, `the tab's apps count the agents that need the person`.
  - `cableSession.ts`: fields `appFilter`, `questionTier`, `swarmMembers`, `seqOn`, `lastAppsKey`; `capabilitiesNamed`, `resetCapabilities`, the `hello` case (`str('appFilter')`), `syncAgentsNow`, `syncSwarmsNow`, `viewChanged`, `resync`, `asItself`; constant `AGENTS_PUSH_GAP_MS` (1000).
  - `cableSession.spec.ts`: `LoopbackPort` (`sent` and `seqs` are parallel arrays: clear both together), `makeHost`, `connect`, `settle`, `row`, `NAMES`, `appHost` (returns `host, state, asked, pickApp, list`), `describe('the app filter')` with `LIST`, `listFrames`, `listTypes`, `greeted`; guard case `viewChanged on an app's ring: no tabs, then apps and the ring, inside the machine list's 1 s gap`; models to copy: `the fullest round-dial welcome is nine names`, `forwards a whole stroke, including the reports that carry no travel`.
  - `cli/e2e/dialAppFilter.e2e.ts` (file-local helpers to copy): `rosters`, `appsFrames`, `ids`, `idsOf`, `counts`, `same`, `showing`, `shows`, `features`, `settleWindowPassed`, and in its `describe`: `fresh`, `startOutside`, `plugged`, `startFirst`, `openWindow`. Harness: `IsolatedDaemon` (`opens()`, `engineConfig.root`, `log()`), `Desk.plug(serial, mac, capabilities)`, `FakeDial` (`messages` keep `seq`), `Outside.start`, `Outside.type`; the fake engine's `!until <name>` holds a turn until `<engineConfig.root>/<name>.release` exists.
- If a name differs at the base, the implementer follows the code and says so in its report.
- The spec, the split doc and this plan are untracked. The main session commits them; no task does.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 `AppRings` counts `working` | `cli/src/cable/hosts/select.ts`, `cli/src/cable/hosts/select.spec.ts` | none | medium | `select.spec.ts` |
| 2 `apps` rows carry `working` for `appCards: "v1"` | `cli/src/cable/hosts/types.ts` (`AppEntry` only), `cli/src/cable/cableHost.ts`, `cli/src/cable/cableSession.ts`, `cli/src/cable/cableHost.spec.ts`, `cli/src/cable/cableSession.spec.ts`, `cli/src/services/devices.spec.ts` (one expectation, **Q1**) | 1 | high | `cableHost.spec.ts`, `cableSession.spec.ts` (`appCards`), `devices.spec.ts` (opencode row) |
| 3 A `members-v1` device keeps the window's `swarms` on an app's ring; pins of a Pro hello | `cli/src/cable/cableSession.ts` (`syncSwarmsNow`), `cli/src/cable/cableSession.spec.ts` | none | high | `cableSession.spec.ts` (`a Harness Pro hello`, the swarms case; six pins pass on `main`) |
| 4 The Pro's cable doc | `devices/harness-pro/docs/cable.md` | none | medium | none (docs, one commit) |
| 5 A Pro hello end to end | `cli/e2e/dialProApps.e2e.ts` (new) | 2, 3 | high | none (an end-to-end test of behavior that went red in Tasks 2 and 3; one commit) |

Tasks 1, 3 and 4 share no file and can run at once. Tasks 2 and 3 share `cableSession.ts` and `cableSession.spec.ts`: the scheduler runs them one after the other, in either order; neither consumes the other. Longest chain: three tasks, 1 → 2 → 5.

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `hosts/select.ts`, `hosts/types.ts`, `cableHost.ts`, `cableSession.ts` | **Devices service process** | their specs (PR CI `cli-tests`, Linux; locally on this Mac), `npm run typecheck` |
| `services/devices.spec.ts` (one expectation, test only) | spec of the devices service | `cli-core` local gate (`npm run test:core`), if Q1 is yes |
| `cli/e2e/dialProApps.e2e.ts` | the real daemon, isolated | local run on this Mac; GitHub "CLI end to end" by hand |
| `devices/harness-pro/docs/cable.md` | docs | review |

Not changed, and a diff in any is a finding: anything under `cli/src/core/`, `cli/src/architecture.coreFiles.txt`, `cli/src/services/*.ts` (non-spec), `cli/src/cable/hosts/appFilter.ts`, `cli/e2e/harness/*`, `cli/e2e/dialAppFilter.e2e.ts`, `devices/harness-pro/firmware/`, `devices/harness-device/`.

## Global Constraints

- **Wire `apps`** (split doc section 3): `{t:"apps", shown, apps:[{id, name, count, waiting, working?}]}`, at most `APP_LIMIT` (16) rows. `working` is an integer, `0 <= working <= count` (both counted over the same list), sent only to a session whose hello says `appCards: "v1"` (a positive string match: `str('appCards') === 'v1'`; any other value or type is off).
- **An `appCards` session:** rows `{id, name, count, waiting, working}` in that key order; apps key per row `` `${id}:${count}:${waiting}:${working}` ``, so a turn starting or ending pushes `apps`.
- **Any other session:** rows `{id, name, count, waiting}` in that key order (the host's `working` dropped) and today's key `` `${shown}|${id}:${count}:${waiting}|…` ``: byte-identical frames, and a change of `working` alone pushes nothing.
- **No welcome feature** for `appCards`. The capability log line names it `appCards`, after `questionTier`. It resets in `resetCapabilities()` (a new port, a close).
- **Swarms rule, in the session only:** `syncSwarmsNow()` asks `listSwarms(this.swarmMembers ? {} : this.asItself)`. The ring, `agents.end` (`tab: ""`, `view: "machine"` on an app's ring), focus, the app filter and every round-dial frame still ask `asItself`.
- `AGENTS_PUSH_GAP_MS` (1 s) bounds `apps` on the machine view, a `working` change as a `waiting` change. No new timer, retry, list or log line. Logs: fixed words and `errorKind`, no content or identifiers.
- PM decisions, not reopened: one app filter per host, shared by every dial; `appCards: "v1"` gates `working`; nothing changes for the round dial.
- **Never the person's own:** no test touches the real `~/.claude`, `~/.codex`, the daemon on port 18473, the user's tmux server, a serial port or a board. Nothing is flashed.
- **Repo rules:** test first at the layer where the behavior lives; no fixed sleeps (fake timers, `vi.waitFor`, `until`); comments say why; English; vitest only of the files changed, plus `npm run typecheck`; no full suite locally.
- **The PR body states the platforms:** the app list, the counts and the swarms rule are platform-neutral TypeScript and run on macOS, Linux and Windows; bringing an app forward on `app.pick` is `open -b` on macOS and the raise on Linux, and Windows has none yet (Ken's dial-windows #4513; nothing built for it here); the Pro's cable on Windows (`harness-serial.exe`, `cable/windowsSerial.ts`) is not yet checked with a Pro.

## Review Focus

1. **A Pro and a round dial on one computer at once** (one host count, two sessions). Expected: a `working` change alone pushes `apps` to the Pro only; the round dial's frames stay byte-identical. Task 2, `a Pro and a round dial on one host: …`; Task 5, case 3.
2. **An agent killed mid-turn** (the observed source lists it `ended` with `state: 'working'` for up to its `END_DELAY_MS`, 10 s). Expected: it counts in `working` as an ended `needs-you` row counts in `waiting` today, never above `count`. Task 1, `working counts the mid-turn agents of the same list as count, …`.
3. **A device that says `appCards` with another value or type** (`"v2"`, `true`), or says it without `appFilter`. Expected: nothing new, today's frame byte for byte; no `apps` at all without `appFilter`. Task 2, `without appCards v1 …`.
4. **The person adds a tab in the window while the Pro shows an app's ring.** Expected: the Pro is sent the new `swarms` at once; a view flip either way sends none. Task 3, the swarms case; Task 5, case 3.
5. **A turn that starts and ends inside the 1 s gap.** Expected: the change is held, not lost: the next push after the gap carries the final `working`. Task 2, `a Pro and a round dial on one host: …` (the held second change).

## Decided (the PM, 2026-11-20)

One app filter per host, shared by every dial; `appCards: "v1"` gates `working`; the round dial's frames and cadence stay as they are; `AppEntry` gains `working: number` (one line in `hosts/types.ts`); the swarms rule lives in the session only (`syncSwarmsNow`); the end-to-end test is a new `cli/e2e/dialProApps.e2e.ts` with a fake dial given the Pro's hello through `capabilities`.

## Decided here, where the spec was silent

- **The session drops `working` itself** for a session without `appCards` (each row rebuilt as `{ id, name, count, waiting }`); the host gets no new option. `cableHost.ts` adds `working: a.working` to its two existing row literals, no new helper.
- **Section 3 is all pinning:** every item already passes on `main` (read in `cableSession.ts`: `send` numbers every frame for `board: "pro"`, `resync` forces `syncAgents(true)`, `app.pick` and `agent.open` call `pickApp`, `scroll` forwards to `host.scrolled` for any hello). They sit in Task 3's red commit beside its one failing case. The host's halves are already pinned per host, not per device, in `cableHost.spec.ts`: `a pick that switches tells appBrought the app once, …` (bringing the app) and `a notice of a Harness agent turns the view as a pick does, …` (back to the tab).
- **The Pro hello in specs and e2e** is the split doc's Pro hello (section 1) plus item B's three keys: `board: 'pro', swarms: 'members-v1', recap: 'long-v1', activity: 'steps-v1', stats: 'turn-v1', player: 'library-v1', ota: 'v1', appFilter: 'v1', questionTier: 'v1', appCards: 'v1'` (`PRO`). With `player.library` the welcome reaches its most, eleven names.
- **The `appHost` fake** (cableSession.spec.ts) answers as the cable host will: its rows always carry `working` (Task 2's `cards()`); its `list()` stays today's wire shape, so every existing expectation built from it is what a dial without `appCards` must still get. Task 3 gives it `state.swarms` for a tab change.
- **The e2e file copies the helpers it uses** from `dialAppFilter.e2e.ts`: they are file-local there, importing a test file would register its tests too, and eight device e2e files already keep their own `rosters`/`appsFrames`. Nothing under `e2e/harness/` changes.
- **The doc** puts the three new hello keys after `ota` in section 1's table, as item B's brief lists them.

## Answered question

1. **Q1.** `cli/src/services/devices.spec.ts` (case `with a dial attached opencode's sessions are listed sv, on the opencode page; …`) checks a host row with `toContainEqual({ id: 'opencode', name: 'opencode', count: 1, waiting: 0 })`. Once the host always carries `working` (the spec), that row is `{ …, working: 0 }` and the check fails. The fix is one test line (`working: 0`), but the file is outside the brief's list, and any path under `cli/src/services/` makes `scripts/local-checks.py` require the `cli-core` gate (`npm run test:core`) with its receipt in the PR body. Allow the one-line edit and the gate (recommended), or have the host carry `working` only when asked, which changes the approved spec. **Answered by the PM, 2026-11-20: allowed** (the one line `working: 0`, and `npm run test:core` with its receipt in the PR body).

---

### Task 1: `AppRings` counts `working` beside `waiting`

**Files:**
- Modify: `cli/src/cable/hosts/select.ts` (`AppRing`, `AppRings.update`, `AppRings.apps` and its comment)
- Test: `cli/src/cable/hosts/select.spec.ts`

**Interfaces:**
- Produces: `AppRings.apps(): Array<{ id: string; count: number; waiting: number; working: number }>`; `working` = the agents of that app's list (the list `count` counts) whose `state === 'working'`. `cableHost.ts` is not touched: its row literals pick fields by name until Task 2.

- [ ] **Step 1: Write the failing tests** in `select.spec.ts`
  - Rename `count and waiting follow the agents` to `count, waiting and working follow the agents`; also set `list[1] = working(list[1])` and `list[2] = working(list[2])`. Expect `[{ id: 'ghostty', count: 18, waiting: 2, working: 2 }, { id: 'orca', count: 1, waiting: 0, working: 0 }]`; after `rings.update([needs(list[18]), list[1]])`, `[{ id: 'ghostty', count: 1, waiting: 0, working: 1 }, { id: 'orca', count: 1, waiting: 1, working: 0 }]`.
  - New `working counts the mid-turn agents of the same list as count, an ended or resting one too`: seven Ghostty agents, states `idle`, `working`, `needs-you`, `done`, `error`, one `working` with `ended: true`, one `idle` with `resting: true` → `rings.apps()` is `[{ id: 'ghostty', count: 7, waiting: 1, working: 2 }]`, and for every row `0 <= working <= count`.
  - Add `working: 0` to every other `rings.apps()` expectation in the file.

- [ ] **Step 2: Run to verify they fail**

  Run: `cd cli && npx vitest run src/cable/hosts/select.spec.ts`
  Expected: FAIL (rows have no `working`).

- [ ] **Step 3: Commit red:** `test(dial): AppRings counts working beside waiting (red)` (only `select.spec.ts`).

- [ ] **Step 4: Implement** the signature above: `AppRing` gains `working: number`, set in `update` beside `waiting` in the same pass over each app's list; `apps()` returns it. Its comment says `working <= count` by construction.

- [ ] **Step 5: Run to verify they pass**

  Run: `cd cli && npx vitest run src/cable/hosts/select.spec.ts src/cable/cableHost.spec.ts && npm run typecheck`
  Expected: PASS, no type errors.

- [ ] **Step 6: Commit:** `feat(dial): AppRings counts working beside waiting`.

---

### Task 2: `apps` rows carry `working` for a device that says `appCards: "v1"`

**Files:**
- Modify: `cli/src/cable/hosts/types.ts` (`AppEntry` and its doc line only)
- Modify: `cli/src/cable/cableHost.ts` (`appList`, `tabApps`: `working: a.working` in each row)
- Modify: `cli/src/cable/cableSession.ts` (a field `appCards` beside `appFilter`, the `hello` case, `resetCapabilities`, `capabilitiesNamed`, `syncAgentsNow`)
- Test: `cli/src/cable/cableHost.spec.ts` (`describe('the dial that shows one app at a time')`)
- Test: `cli/src/cable/cableSession.spec.ts` (`appHost`; a new nested `describe('appCards')` at the end of `describe('the app filter')`)
- Test: `cli/src/services/devices.spec.ts` (the opencode row only; **Q1**)

**Interfaces:**
- Consumes: `AppRings.apps()` with `working` (Task 1).
- Produces: `AppEntry { id: string; name: string; count: number; waiting: number; working: number }`. `CableSession`: `private appCards = false` (doc comment: the Harness Pro, this spec; `working` on each `apps` row and a change of it alone pushes `apps`; any other device gets today's frame byte for byte). `appHost` fake: `state.working: Record<string, number>` (default `{}`), `cards(): AppList` (= `list()` with `working: state.working[id] ?? 0` on each row, what its snapshot answers on the machine view and, as `{ shown: 'harness', apps: cards().apps }`, on the tab), returned beside `list`; `list()` keeps today's rows, typed `{ shown: string; apps: Array<Omit<AppEntry, 'working'>> }`.

- [ ] **Step 1: Write the failing tests**
  - `cableHost.spec.ts`: rename `the app list: fixed order, display names, count and waiting` to `…, count, waiting and working`, with `g1` `state: 'working'` → first read `{ id: 'ghostty', name: 'Ghostty', count: 3, waiting: 0, working: 1 }`, `{ id: 'vscode', name: 'VS Code', count: 2, waiting: 1, working: 0 }` (the second read's rows gain the matching `working`). Rename `the tab's apps count the agents that need the person` to `… that need the person and those mid-turn`, with `agents[1] = agent('g2', 'ghostty', { state: 'working' })` → the rows contain `{ id: 'ghostty', name: 'Ghostty', count: 3, waiting: 0, working: 1 }` and `{ id: 'vscode', name: 'VS Code', count: 2, waiting: 1, working: 0 }`. Every other app row expectation in the file gains `working: 0`.
  - `devices.spec.ts`: the opencode row gains `working: 0` (Q1).
  - `cableSession.spec.ts`, `appHost` as in Interfaces. In `describe('appCards')`, a local `greet(host, fields: Record<string, unknown>)` connects, says `{ t: 'hello', product: 'harness', mac: 'aa:bb', appFilter: 'v1', ...fields }` and waits for `notif.replace`. Cases:
    - `a dial that says appCards v1 gets working on each row, after waiting`: `appHost({ log })` with a `log` spy, `state.working = { ghostty: 2 }`, fields `{ appCards: 'v1' }` → `JSON.stringify` of its first `apps` frame is `{"t":"apps","shown":"ghostty","apps":[{"id":"ghostty","name":"Ghostty","count":3,"waiting":0,"working":2},{"id":"vscode","name":"VS Code","count":2,"waiting":1,"working":0}]}`; the greeting's log line matches `/caps appFilter,appCards$/`; the welcome's features are `['voice.draft', 'agents.refresh', 'apps.switch', 'settings']`.
    - `without appCards v1 the apps frame is today's, byte for byte, though the host counts working`: `state.working = { ghostty: 2 }`; for fields `{}`, `{ appCards: 'v2' }` and `{ appCards: true }`, `JSON.stringify` of the first `apps` frame is `{"t":"apps","shown":"ghostty","apps":[{"id":"ghostty","name":"Ghostty","count":3,"waiting":0},{"id":"vscode","name":"VS Code","count":2,"waiting":1}]}`. A hello with `appCards: 'v1'` and `appFilter: undefined` is sent no `apps` frame.
    - `the tab's apps carry working to an appCards dial`: `state.window = state.tabApps = true`, `state.working = { vscode: 1 }`, fields `{ appCards: 'v1' }` → the first `apps` frame equals `{ t: 'apps', shown: 'harness', apps: cards().apps }`, its VS Code row `working: 1`.
    - `a Pro and a round dial on one host: a working change alone pushes apps to the Pro only, held to the 1 s gap` (`vi.useFakeTimers({ toFake: ['Date', 'performance'] })`): `pro = greet(host, { appCards: 'v1' })`, `round = greet(host, {})` on one `appHost`; clear both ports; advance 1100 ms; `state.working.ghostty = 1`; `syncAgents()` on both → the Pro's list frames `[{ t: 'apps', ...cards() }]`, the round dial's `[]`. Advance 100 ms; `state.working.ghostty = 0`; the Pro's `syncAgents()` sends nothing; advance 1000 ms; its `syncAgents()` sends one `apps` with Ghostty `working: 0`. The round dial's list frames stay `[]`.
    - `appCards is read at each hello and forgotten when the port closes`: greet with `{ appCards: 'v1' }` → `session['appCards']` is `true`; a hello with `fw: '1.0.1'` and no `appCards` → `false`; one with it again → `true`; `await port.close('unplugged')` → `false`.

- [ ] **Step 2: Run to verify they fail**

  Run: `cd cli && npx vitest run src/cable/cableHost.spec.ts src/cable/cableSession.spec.ts` and `cd cli && npx vitest run src/services/devices.spec.ts -t "opencode's sessions are listed sv"`
  Expected: FAIL: host rows have no `working`; the `appCards` cases (no `working` on the wire, no field); the byte-for-byte case (the fake host's `working` reaches a round dial today); the opencode row.

- [ ] **Step 3: Commit red:** `test(dial): apps rows carry working for a device that says appCards (red)` (only the three spec files).

- [ ] **Step 4: Implement**
  - `types.ts`: `working: number` on `AppEntry`; its doc line names it (how many of the app's agents are mid-turn).
  - `cableHost.ts`: `working: a.working` in the `appList` and `tabApps` rows.
  - `cableSession.ts`: the field; `this.appCards = str('appCards') === 'v1'` beside `appFilter` in the `hello` case; reset in `resetCapabilities()`; `this.appCards && 'appCards'` after `questionTier` in `capabilitiesNamed()`; in `syncAgentsNow()` the rows and the apps key per Global Constraints, with a comment saying why (the round dial's frames and push cadence stay byte-identical, PM 2026-11-20).

- [ ] **Step 5: Run to verify they pass**

  Run: `cd cli && npx vitest run src/cable/hosts/select.spec.ts src/cable/cableHost.spec.ts src/cable/cableSession.spec.ts && npx vitest run src/services/devices.spec.ts -t "opencode's sessions are listed sv" && npm run typecheck`
  Expected: PASS, no type errors.

- [ ] **Step 6: Commit:** `feat(dial): apps rows carry working for a device that says appCards`.

---

### Task 3: A `members-v1` device keeps the window's `swarms` on an app's ring; pins of a Pro hello

**Files:**
- Modify: `cli/src/cable/cableSession.ts` (`syncSwarmsNow` only)
- Test: `cli/src/cable/cableSession.spec.ts` (`appHost`'s `listSwarms`; a new nested `describe('a Harness Pro hello (docs/plans/2026-11-20-pro-app-data-daemon-design.md)')` at the end of `describe('the app filter')`)

**Interfaces:**
- Produces: `appHost` `state.swarms` (default `[{ id: 't1', name: 'Main', agents: 2, panes: 2 }]`), which its `listSwarms` answers on the tab (`{ selected: 't1', swarms: state.swarms, tiles: [] }`). In the new describe: `PRO` (Decided here) and a local `pro(host)` that connects, says `PRO` and waits for `notif.replace`. A test that clears `port.sent` clears `port.seqs` with it.

- [ ] **Step 1: Write the failing test and the pins**
  - **Red:** `the window's swarms stay on a Pro on an app's ring: a view flip pushes none, a new tab still does`: `state.window = true`; `pro(host)`; clear; `state.appView = true`; `await session.viewChanged()` → no `swarms` frame; the list frames are `apps` (`shown: 'ghostty'`), `g1`..`g3` and `{ t: 'agents.end', total: 3, tab: '', view: 'machine' }`; every `asked` is `{ apps: true }`. Then `state.swarms = [...state.swarms, { id: 't2', name: 'Two', agents: 0, panes: 1 }]`; `await session.syncSwarms()` → exactly one `swarms`, matching `{ selected: 't1', items: [{ id: 't1' }, { id: 't2' }] }`. Clear; `state.appView = false`; `await session.viewChanged()` → no `swarms` frame.
  - **Pins (pass on `main`):**
    - `the welcome names apps.switch, question.tier and resync, eleven names in all`: `appHost` with `form`, `visit`, `selectPassage`, `answerReviewed` as in `the fullest round-dial welcome is nine names`, and `playerLibrary: async () => []` → features `['voice.draft', 'agents.refresh', 'player.library', 'resync', 'form', 'selection', 'visit', 'question.review', 'apps.switch', 'question.tier', 'settings']`, 11 names (the firmware reads none past 16).
    - `every apps frame to a Pro carries seq, one more than the frame before` (fake timers `Date`, `performance`): after the greeting, advance 1100 ms, `state.rings.vscode = [row('v1', 'vscode', 'sf')]`, `syncAgents()` → at least two `apps` frames, and for each at index `i`: `port.seqs[i]` is a number equal to `port.seqs[i - 1]! + 1`.
    - `resync resends apps before the ring`: clear; say `{ t: 'resync' }`; wait for `agents.end` → `apps` (matching `{ shown: 'ghostty' }`) comes before `agents.begin`.
    - `app.pick of another app turns a Pro's ring`: say `{ t: 'app.pick', app: 'vscode' }` → `pickApp` called with `'vscode'`; the next list frames are `apps` with `shown: 'vscode'`, `v1`, `v2`, `{ t: 'agents.end', total: 2, tab: '', view: 'machine' }`.
    - `a tap on a Harness agent on an app's ring asks for the window's tab, then opens it`: `state.window = state.appView = true`, `state.rings.harness = [row('h1', 'harness', 'svfa')]`, `openAgent: vi.fn()` → say `{ t: 'agent.open', agentId: 'h1' }` → `pickApp` called with `('harness', 'notice')`, then `openAgent` with `('h1', undefined)`.
    - `scroll from a Pro reaches the host as the round dial's does`: say `scroll` `down` (`dy: 0`), `move` (`dy: 12`), `up` (`dy: 3, v: -1800`) → `host.scrolled` called with `('down', 0, 0)`, `('move', 12, 0)`, `('up', 3, -1800)` in that order.
  - **Guard, unchanged:** `viewChanged on an app's ring: no tabs, then apps and the ring, …` (a dial with `appFilter` alone still gets `{ t: 'swarms', selected: '', items: [], tiles: [] }`).

- [ ] **Step 2: Run to verify**

  Run: `cd cli && npx vitest run src/cable/cableSession.spec.ts -t "the app filter"`
  Expected: FAIL only in the swarms case (a `swarms` frame with `items: []` after the flip); the six pins and the guard pass.

- [ ] **Step 3: Commit red:** `test(dial): a Pro keeps the window's tabs on an app's ring (red)` (only `cableSession.spec.ts`).

- [ ] **Step 4: Implement** in `syncSwarmsNow()`: `this.host.listSwarms(this.swarmMembers ? {} : this.asItself)`, with a comment saying why (a Pro that says `appFilter` draws its Tabs cards from `swarms`, which would vanish whenever an app's ring is shown; PM, 2026-11-20).

- [ ] **Step 5: Run to verify they pass**

  Run: `cd cli && npx vitest run src/cable/cableSession.spec.ts && npm run typecheck`
  Expected: PASS, no type errors.

- [ ] **Step 6: Commit:** `feat(dial): a Pro keeps the window's tabs while the dial shows an app's ring`.

---

### Task 4: The Pro's cable doc says what the daemon now sends it

**Files:**
- Modify: `devices/harness-pro/docs/cable.md` (sections 1, 2 and 5)

No test: documentation only, one commit.

- [ ] **Step 1: Write the doc**
  - Section 1, the hello table: rows `appFilter` `"v1"`, `questionTier` `"v1"`, `appCards` `"v1"` (each "capability"), after `ota`.
  - Section 2, the capability table, a row each:
    - `appFilter: "v1"`: the `apps` frame `{t:"apps", shown, apps:[{id, name, count, waiting, working?}]}` (at most 16 rows, the shown app always among them; sent before the ring it names), `app.pick` `{t:"app.pick", app}` (an `app` of 1-16 characters, anything else ignored), welcome `apps.switch` (when the host can pick); with no window, or a window while the view is an app's ring, the shown app's ring with `agents.end` `tab: ""` and `view: "machine"`; the window's tab otherwise. One app filter per computer, shared by every dial on it.
    - `questionTier: "v1"`: a question told again is sent with `tier: "list"` (a silent row); welcome `question.tier`.
    - `appCards: "v1"`: `working` on each `apps` row, an integer `0..count` (the app's agents mid-turn); a change of it alone pushes `apps`, at most once a second with no window; no welcome feature; an older daemon sends none, which reads as 0. A device that does not say it gets today's `apps` frame byte for byte.
    - Under `swarms: "members-v1"`: such a device keeps getting the window's `swarms` (`selected`, `items`, `tiles`) while the view is an app's ring; a flip of the view sends no `swarms`; a real tab change still does.
    - One line: with `appFilter` and `questionTier` the welcome to a Pro holds at most 11 names (the firmware reads none past 16).
  - Section 5: `apps` joins the messages the Pro uses; `app.pick` joins those it sends.

- [ ] **Step 2: Commit:** `docs(pro): the cable doc names appFilter, questionTier, appCards and the swarms rule`.

---

### Task 5: A Harness Pro hello, end to end

**Files:**
- Create: `cli/e2e/dialProApps.e2e.ts`

No red commit of its own: it adds an end-to-end test of behavior that went red at its unit layer in Tasks 2 and 3. One commit.

**Interfaces:**
- Consumes: Task 2 (`working` for `appCards`), Task 3 (the swarms rule).
- The file's header comment names the spec and what it drives. Constants: `PRO` (Decided here), `FILTER = { appFilter: 'v1' }`, `GHOSTTY = { TERM_PROGRAM: 'ghostty' }`, `VSCODE = { TERM_PROGRAM: 'vscode' }`, `VSCODE_BUNDLE = 'com.microsoft.VSCode'`. `fresh()` as in `dialAppFilter.e2e.ts` (`IsolatedDaemon` with `CABLE_DISABLE: 'false'`, `HARNESSD_TEST_DIAL_PORT` on a `Desk`, the daemon log printed on a failure); `afterEach` closes engines, windows, the desk and the daemon. `interface AppEntry` there gains `working?: number`.

- [ ] **Step 1: Write the three cases**
  - `a Pro's hello: the welcome, then apps with seq and working, a turn counting 1 then 0`: `pro = plugged(desk, PRO)`; `features(pro)` contains `apps.switch`, `question.tier` and `resync`, at most 11 names. `g1 = startFirst(d, pro, 'ghostty', 'a1', GHOSTTY)`, `g2` in Ghostty, `v1` in VS Code; `showing` Ghostty 2, VS Code 1, every `working` 0. `g1.type('!until pro-turn')` → `showing` Ghostty `working: 1`; `writeFileSync(join(d.engineConfig.root, 'pro-turn.release'), '')` → `showing` Ghostty `working: 0`. Then over every `apps` frame the Pro heard: each row's keys are exactly `['id', 'name', 'count', 'waiting', 'working']` with `0 <= working <= count`, and its `seq` is a number one more than the `seq` of the message before it.
  - `app.pick from a Pro turns its ring to VS Code and brings VS Code`: Ghostty 2 (`startFirst`, then one more), VS Code 1; `shows(pro, 'ghostty', ghostty)`; `pro.send({ t: 'app.pick', app: 'vscode' })` → `shows(pro, 'vscode', [v1], since)` with `agents.end` matching `{ tab: '', view: 'machine', total: 1 }`. On macOS only (`process.platform === 'darwin'`): `until` `same(d.opens(), [['-b', VSCODE_BUNDLE]])` and the log has `[device] app filter: bring · ok`.
  - `with a window, a Pro on an app's ring keeps the window's swarms, and a round dial beside it gets none`: `pro = plugged(desk, PRO)`, `round = plugged(desk, FILTER, 'E2E-B', 'e2:e0:00:00:00:0b')`; Ghostty 2; `openWindow(d)` → the Pro's list with `end.tab === 't1'` and a `swarms` with `selected: 't1'`. `pro.send({ t: 'app.pick', app: 'ghostty' })` → both dials show Ghostty's ring (one filter per computer); the round dial's last `swarms` since the pick matches `{ items: [] }`; every `swarms` the Pro heard since has `selected: 't1'`. The window then says two tabs (`app_swarms` with `t1` and `t2`) → the Pro hears a `swarms` with two items while its last list is still `view: 'machine'`; after `settleWindowPassed(round, told)` every `swarms` the round dial heard since the pick has `items: []`.

- [ ] **Step 2: Run it on this Mac** (isolated daemons only; see Verification)

  Run: `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialProApps.e2e.ts`
  Expected: 3 passed.

- [ ] **Step 3: Commit:** `test(dial): a Harness Pro's hello, end to end`.

---

## Verification

**Unit, per task (on this Mac, in the worktree):** each task's Step 5 (Task 5: Step 2): the spec files it names, then `cd cli && npm run typecheck`. No full suite.

**Local gates PR CI does not run** (`docs/validation-and-release.md`): with Q1 answered yes, `cli/src/services/devices.spec.ts` changes, so from a clean tree at the final head, on this Mac, `python3 scripts/local-checks.py --run` plans `cli-core` (`npm run test:core`); paste its `harness-local-checks` fence into the PR body. No other gate applies: nothing under `cli/src/core/`, `src/harnessd/`, or `cable/serial*`/`windowsSerial*` changes. If Q1 is answered otherwise and no file under `cli/src/services/` changes, `npm run test:core` is not needed.

**End to end, locally (a tester on this Mac, a few minutes):** `cd cli && npm ci --no-audit --no-fund` if needed, then `TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/dialProApps.e2e.ts` on the final head (an arm64 Node; Xcode's command line tools build the process-image helper once). Each case runs `IsolatedDaemon`: a throwaway root, home and data folders, its own port and sockets (never 18473), a private tmux server, fake Claude Code engines, the fake `open` in its root (`HARNESS_OPEN_BIN`, logged for `opens()`), firmware offers off (`CABLE_FW_DISABLE`), no account, and the fake dial on a pseudo-terminal (`HARNESSD_TEST_DIAL_PORT`). The real `~/.claude`, `~/.codex`, the user's daemon, tmux server, serial ports and boards are never touched. What the tester sees: 3 passed; on a failure, the daemon's last 200 log lines and the dials' `apps` and lists, printed by the test. On macOS case 2 also shows one `-b com.microsoft.VSCode` run of the fake `open` and `[device] app filter: bring · ok` in the daemon log.

**CLI end to end on GitHub, by hand, once, after the final review, with the orchestrator's turn:** `gh workflow run cli-e2e.yml --ref feat/pro-app-data-daemon` (Actions → CLI end to end → Run workflow on the branch). The eight Linux shards run the whole suite: `dialProApps.e2e.ts` (placed by the default timing hint; on Linux case 2 checks the ring and skips the macOS `open -b`, as `dialAppFilter.e2e.ts` does) and the round dial's files, whose `apps` rows (`dialAppFilter.e2e.ts`, `deviceOpencode.e2e.ts` and the other device files) must still match today's shape exactly; plus the macOS full-disk job. Report the run link and the shard that ran `dialProApps.e2e.ts`. No temporary workflow: `cli-e2e.yml` already runs by hand from a branch and keeps the new file every night.

**PR CI (automatic):** `cli-typecheck`, `cli-tests` (Linux), `process-checks`, and what the plan job selects for `devices/harness-pro/docs/`. No extra run is started.

**Not checked here, said in the PR:** no real Pro (item B's firmware is not on `main`; no hardware, no serial port, nothing flashed); the Pro's cable on Windows (`harness-serial.exe`) is not yet checked with a Pro; bringing an app forward has no Windows path (Ken's #4513). No check runs against production.
