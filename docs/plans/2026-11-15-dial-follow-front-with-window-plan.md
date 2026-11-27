# The dial follows the app in front with a Harness window open — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use diegodev phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With a Harness Desktop window open, the round dial shows the app the person brought to the front, as it does with no window, and goes back to the window's tab when Harness Desktop comes to the front.

**Architecture:**
- The cable host keeps one more value beside the app filter: **the view**, `tabs` or `apps`, set only while a window is open. The filter's settle, a window opening, a pick of Harness, the app in front getting known agents, and the shown app being left as Harness or no app set it.
- A dial that says `appFilter` is answered by the view: in `apps` exactly what it is answered with no window (the shown app's ring, `apps`, `view: 'machine'`, `tab: ''`, no tabs). Any other dial is answered the tab, as today.
- On each change the devices write one log line and every `appFilter` dial is sent its tabs and its list at once. Back on the tab, the dial is turned to the agent the window has in focus. A window focus that names an agent off the ring a dial walks does not move it.
- The agents outside a pane reach the dial unless it holds a window's tab: a window is open, and the view is `tabs` or no connected dial says `appFilter`.
- Dictation on an app's ring goes to the agent on the dial's face, as with no window.
- On Linux, Harness Desktop in front is read by its exe name, `harness`.
- Approach A: no firmware, no protocol, no core, no Desktop, no Harness Device change.

**Tech Stack:** TypeScript daemon (Node, vitest, `cli/`).

**Spec:** `docs/specs/2026-11-15-dial-follow-front-with-window.md`. It replaces step 4 of `docs/specs/2026-11-14-dial-app-filter.md`, § Which app is shown.

## Base

- **PR #4331 has merged.** `origin/main` is at `e4b1ca94a9` (#4331) and this branch sits on it. Tasks start from there.
- Every name and line number below is from that commit. The draft was written from #4331's branch (`47843bceda`); for every path this plan touches the two are the same (`git diff 47843bceda origin/main` over `cli/src/cable`, `cli/src/services`, `cli/src/devices`, `cli/e2e`, `cli/AGENTS.md` and the app filter spec is empty, checked 2026-11-15). Line numbers move as tasks land: find each place by its name.
- What #4331 brought to these files, which the tasks build on:
  - `cli/src/services/devices.ts`: the tab follow (`tabs`, `tabReported`, `tabSettled`, `followTab`, `FOLLOWED.tab`); `appSettled` calls `tabSettled` too.
  - `cli/src/services/devices.spec.ts`: `fakeListener().tabs` and the describe `selecting a tab moves the dial`, which Task 6 adds one test to.
  - `cli/AGENTS.md`: the devices row, which Task 9 edits.
  - `cli/e2e/dialTerminalFollow.e2e.ts` (Verification, check 2).

## Start order

diegodev starts a task when the tasks it depends on are done and no running task shares its files.

| Task | Depends on | Shares files with |
|---|---|---|
| 1 The shared words | none | none |
| 2 The view in the cable host | 1 | 3 (`cableHost.ts` and its spec) |
| 3 What each dial is answered | 2 | 2; 6 (`services/devices.spec.ts`) |
| 4 The session | 1 | none |
| 5 The fleet | 4 | none |
| 6 The devices | 3, 5 | 3 |
| 7 End to end | 6, 10 | none |
| 8 The on-dial rig | none | none |
| 9 Docs | none | none |
| 10 Harness Desktop in front on Linux | none | none |

Longest chain: 1 → 2 → 3 → 6 → 7 (five tasks; 1 → 4 → 5 → 6 → 7 is as long). Task 10 adds no link to it: it has no dependency, and Task 7 already waits for Task 6.

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/core/**`, `cli/src/localWsServer.ts`, `cli/src/architecture.coreFiles.txt` | **Core:** unchanged (`cli/AGENTS.md`, Protect the core, rule 7) | `git diff` against `origin/main` is empty for these paths |
| `cli/src/cable/hosts/types.ts`, `cli/src/cable/cableHost.ts`, `cableSession.ts`, `cableFleet.ts` | **Devices service process** | Their specs, `npm run typecheck` |
| `cli/src/cable/hosts/appFilter.ts` | **Devices service process:** unchanged. The filter stays "which app" | Its spec passes as it is |
| `cli/src/cable/hosts/frontApp.ts` | **The watch** (`harness hardware watch`, a CLI process) and the **devices service process** (the Linux scan, `scannedApp.ts`, reads the same table) | `frontApp.spec.ts`, `scannedApp.spec.ts` |
| `cli/src/services/devices.ts` | **Devices service process** | 100% per file (`npm run test:core`) |
| `cli/e2e/dialAppFilter.e2e.ts` | Test: the real daemon, a fake dial, a fake window, the real watch | `cli-e2e.yml`, by hand |
| `cli/e2e/dialAppFilterOnDial.e2e.ts` | Test rig, opt-in (`ON_DIAL_PORT`) | By hand, Verification check 3 |
| `docs/specs/2026-11-14-dial-app-filter.md`, `cli/AGENTS.md` | Repo files, no process | none |
| `devices/**`, `desktop/**`, `device-app/**` | Firmware, Desktop, Harness Device: unchanged | `git diff` against `origin/main` is empty |

## Global Constraints

- **The view** is `tabs` or `apps`. It exists only while a window is open, one per cable host, in memory only, and applies only to a dial that says `appFilter`. It is lost on a restart and set again by the next settle.
- **What sets it** (the spec, § The view):
  - a window opens: `tabs`, unless the app settled in front is not Harness and has agents: then `apps`;
  - `harness` settles in front: `tabs`; another app that has agents settles: `apps`; an app with no agents, or `none`: no change;
  - in `tabs`, the app settled in front (not Harness) gets known agents: `apps` (D1);
  - a pick of `harness` on the dial: `tabs`. Any other pick is the filter's, as with no window. In `tabs` a pick is ignored;
  - in `apps`, the app the filter shows is Harness, or there is none (the shown app ran out of agents and Harness, or nothing, is what is left): `tabs` (the PM, 2026-11-15). The view is never `apps` over Harness's own page;
  - the window closes: no view.
- **Causes:** `front`, `pick`, `window`, `empty`, and no other. They are the log line's words and the counters' names.
- **The log line** is exactly `[device] app filter: view tabs · <cause>` or `[device] app filter: view apps · <cause>`. No app, no agent id. It is the measure, read from the log as `app filter: switched` is.
- **In `apps` the dial is told exactly what it is told with no window.** No new frame, no new field. `git diff origin/main -- devices/` is empty.
- **On every view change** each `appFilter` dial gets its tabs, then its list, at once, not on the next 1 s tick. Back in `tabs`, the focus on the window's agent comes after the tab's list.
- **Not changed:** an older round dial and Harness Pro (no `appFilter`): the tab, as today, in either view. No Harness Device app, Windows, `HARNESSD_SERVICES=none`: no app in front is told, so the view is always `tabs`. No window: the app filter spec. Voice: the candidates of a voice turn stay the single ring, and words spoken on the overview go to the window's palette.
- **The agents outside a pane** (their turns, waiting lines, questions and reminders) reach the dial unless a window is open and either the view is `tabs` or no connected dial says `appFilter` (the PM, 2026-11-15): an older dial or Harness Pro alone hears nothing of them with a window open, as today. Accepted edge (the spec): an older dial beside an `appFilter` dial may hear an outside agent's card while the view is `apps`.
- **Dictation** (the PM, 2026-11-15). On an app's ring the words go to the agent on the dial's face, as with no window: `host.appFocus` answers nothing to a dial that says `appFilter` while the view is `apps`. On the tab, and for any other dial, they go to the window's focused agent, as today.
- **Linux X11.** Harness Desktop in front is the exe name `harness` (`desktop/linux/CMakeLists.txt`, `BINARY_NAME`), a row of `EXE_APPS` (the PM, 2026-11-15).
- **Privacy.** Which app is in front reaches no log, measure, backend or phone.
- **Idle cost.** The devices read a dial's list every second. The D1 check counts the registry's agents only while a listed app other than Harness is settled in front, the view is `tabs` and no pick of Harness holds. With Harness or no listed app in front a tab read costs what it costs today (Task 2 has the test). In `apps` a read costs what it costs with no window: the filter is asked for its shown app once.
- **Repo rules.** Tests never touch the developer's real `~/.claude`, daemon (port 18473), tmux or dial. No fixed sleeps: fake timers, or a wait on a condition. `src/services` stays at 100% per file. Before any local run, `node -p process.arch` says `arm64`.

## Review Focus

1. **An older dial or Harness Pro, alone or beside a new dial, while another app is in front.** It must be answered exactly as before: the tab's list, the window's tabs, and "everything" for a tab agent's caps, so its swipe still moves the window. Task 3 (`a dial without appFilter is answered as before in either view`), Task 4 (`a dial without appFilter asks as itself, and follows the window as before`).
2. **A burst of fronts between Harness and another app** (Cmd-Tab held down): one settle, one view, one line, one push. Task 2 (`a burst of fronts tells one view`), Task 6 (`a view change sends the dials their lists once`).
3. **The window's focus at the edge of the settle** (the spec's click in the window). A focus that comes while the dial is on an app's ring must not move it, and is followed once the tab is back, the list first. Task 4 (`a window focus off the ring of a dial on an app's ring does not move it`, `viewChanged back on the tab`).
4. **The devices starting with a window already open, and a dial plugged in during `apps`.** Nothing has settled: the view is `tabs`. A dial that greets during `apps` gets the app's ring and is not pulled to the window's agent. Task 2 (`a window opening sets the view by the app settled in front`), Task 4 (`a dial plugged in while on an app's ring is not turned to the window's agent`).
5. **The window closing and opening again while a pick of Harness holds.** The view and the hold go with the window, nothing is told for the close, and the next opening starts from the rule. Task 2 (`the window closing drops the view and a pick of Harness`).
6. **A pick of Harness made on the dial before the window opened, with another app still in front.** The filter holds Harness while the app in front has agents: the view must turn to `tabs` once and stay, not turn back and forth at each one-second read. Task 2 (`a pick of Harness made before the window opened turns the view to tabs once and holds`).
7. **A dial that says `appFilter` plugged in, or unplugged, while a window is open on an app's ring.** The gate turns with it: what waits is asked when it comes, and closed when it goes and an older dial stays. Task 6 (`a dial that says appFilter coming while the view is apps is asked what waits …`).

---

### Task 1: The shared words

**Layer:** devices service process. **Depends on:** none. **Effort:** `medium`.

**Red test:** none: no behavior (three types, which Tasks 2 and 4 both need so they can run apart).

**Files:**
- Modify: `cli/src/cable/hosts/types.ts` (`AppPick`, line 42)

**Interfaces:**
- Produces:
  ```ts
  /** What a pick on the dial did. `tabs`: with a window open, Harness was picked on an app's ring, and the dials hold the window's tab again. */
  export type AppPick = 'switched' | 'same' | 'ignored' | 'tabs'
  /** What the dials that say `appFilter` hold while a window is open: its active tab, or the shown app's ring. */
  export type DialView = 'tabs' | 'apps'
  /** Why the view was set: an app settled in front or the app in front got known agents, a pick on the dial, the window opening, the shown app left as Harness or no app. */
  export type ViewCause = 'front' | 'pick' | 'window' | 'empty'
  ```

- [ ] **Step 1:** Write the three types.
- [ ] **Step 2: Run** `cd cli && npm run typecheck`. Expected: PASS.
- [ ] **Step 3: Commit** `cable: the dial's view with a window, its causes, and a pick that answers tabs`.

### Task 2: The view in the cable host

**Layer:** devices service process. **Depends on:** Task 1. **Effort:** `high`.

**Red test:** the describe `the view while a window is open` in `cli/src/cable/cableHost.spec.ts`.

**Files:**
- Modify: `cli/src/cable/cableHost.ts` (`CableHostWiring` 139-150, the filter's `settled` 241, `setSwarms` 529, `pickApp` 584, `listAgentSnapshot` 678)
- Test: `cli/src/cable/cableHost.spec.ts`

**Interfaces:**
- Consumes: `DialView`, `ViewCause`, `AppPick` (Task 1); `AppFilter.settledApp()`, `AppFilter.pick`, the filter's `settled` callback; `AppRings.counts`.
- Produces, in `CableHostWiring`:
  ```ts
  /** The view was set, and why: told on each change and on each window opening, never an app. */
  appView?: (view: DialView, cause: ViewCause) => void
  ```
- Produces, on `DaemonCableHost`:
  - `holdsTab(): boolean`: a window is open and the view is `tabs`. False with no window.
  - `pickApp(app, cause)`: with no window, the filter's pick, as today. In `tabs`, `'ignored'`. In `apps`, `harness` turns the view to `tabs` and answers `'tabs'`, for a pick and for a notice alike; any other app is the filter's pick. `appPicked` is told as today.
- State, private: `view: DialView | undefined` (undefined with no window) and `pickedOver: string | undefined`, the app settled in front when Harness was picked.
- Rules:
  - `setSwarms`, from null to a value: the view is `apps` when `settledApp()` is neither undefined nor `harness` and that app has agents (`counts().all`), else `tabs`. Told with `window`. From a value to a value: nothing. To null: the view and `pickedOver` are dropped and nothing is told.
  - The filter's `settled(app)`, with a window: an app equal to `pickedOver` changes nothing (the same app settling again leaves a pick holding, as `AppFilter.settle` does). Any other app ends `pickedOver`; then `harness` gives `tabs`, an app with agents (`counts().all`) gives `apps`, and the rest nothing. Told with `front`, then `wiring.appSettled(app)` as today.
  - D1, at the top of `listAgentSnapshot` when asked with `apps: true`: in `tabs`, with `settledApp()` defined, not `harness` and not `pickedOver`, the view becomes `apps` when that app has known agents (`counts().known`). Told with `front`. The checks run in that order, so the registry is read last.
  - E, in the same place, after D1: in `apps`, the app the filter shows (`this.filter.shown()`) being `harness` or none turns the view to `tabs`. Told with `empty`. If the app settled in front has known agents then (`counts().known`), only a pick of Harness made before the window opened holds the filter off it: `pickedOver` becomes that app, as for a pick of Harness with the window open, so D1 does not turn the view straight back.
  - A view equal to the one held tells nothing.
- This task does not change what a list read returns: Task 3 does, and moves E's check onto the answer it builds.

- [ ] **Step 1: Write the failing tests** (inside `the dial that shows one app at a time`, which has `setup`, `sessions`, `five`, `agent`, `onTab`; `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })`; a `settle(host, app)` that calls `host.front(app)` and advances `FRONT_SETTLE_MS`; `views`, each `appView` call as `'<view> <cause>'`):
  - `a window opening sets the view by the app settled in front` (`it.each`): nothing settled, `harness`, `cursor` (no agents) and `none` give `['tabs window']` and `holdsTab()` true; `ghostty` gives `['apps window']` and `holdsTab()` false.
  - `Harness settling in front turns the view to tabs and ends a pick`: on Ghostty's ring, `pickApp('vscode')` is `'switched'`; `harness` settles: `'tabs front'`; `ghostty` settles: `'apps front'`, and `appSwitched` heard `['pick', 'front']`.
  - `another app with agents settling in front turns the view to apps`: `['tabs window', 'apps front']`.
  - `an app with no agents, and none, settling in front change nothing in either view`.
  - `the app settled in front getting known agents turns tabs to apps at the next list a dial that says appFilter reads`: `cursor` settled, in `tabs`. An agent with `appPending: true` is then added there: a read with `apps: true` tells nothing. A known one is added: a read without `apps` tells nothing, a read with `apps: true` tells `'apps front'`.
  - `a pick of Harness on an app's ring answers tabs and holds as a pick does`: `pickApp('harness')` is `'tabs'`, `views` gains `'tabs pick'`, `appPicked` was told once. `cursor` then `ghostty` inside the second (Ghostty settles again): nothing. A read with `apps: true`: nothing. `vscode` settles: `'apps front'`.
  - `a notice of a Harness agent turns the view as a pick does, and is no use of the picker`: `pickApp('harness', 'notice')` is `'tabs'`, `'tabs pick'`, `appPicked` not told.
  - `a pick of another app works on an app's ring and is ignored on the tab`: `'switched'` with `appSwitched` `['pick']`; in `tabs`, `'ignored'`.
  - `the window closing drops the view and a pick of Harness`: after a pick of Harness, `setSwarms(null)`: `holdsTab()` false and `views` has no new entry; the window opens again with Ghostty still settled: `'apps window'`.
  - `with no window no view is ever told`: settles of `harness`, `ghostty` and `none`, `pickApp('harness')` (the filter's own answer, as today) and reads with `apps: true`: `views` is `[]`, `holdsTab()` false.
  - `the window changing its tab tells no view`: on an app's ring, `onTab(host, ['h2'], 't2')`: `views` has no new entry and `holdsTab()` is still false.
  - `a burst of fronts tells one view`: `ghostty`, `harness`, `vscode`, `harness`, `ghostty` inside the second, then the settle: `['tabs window', 'apps front']`.
  - `the view is told after the switch its settle caused and before appSettled`: one array fed by `appSwitched`, `appView` and `appSettled` reads `['front', 'apps front', 'settled vscode']`.
  - `with Harness, none or nothing settled in front, a tab read does not read the registry`: the observed source's `list` is a `vi.fn`; its call count does not move across reads with `apps: true`.
  - `the shown app running out of agents turns the view to tabs when Harness or no app is left` (the agents' array is emptied in place; one read with `apps: true` before the window opens, which feeds Harness's agents; then Ghostty settled in front and the window opened, on Ghostty's ring): with Harness's two sessions and Ghostty's one agent, and with Ghostty's one agent alone, a read with `apps: true` after the agent is gone tells `'tabs empty'` and `holdsTab()` is true. A second read tells nothing.
  - `the shown app running out of agents keeps the view when another app is left`: `five()` and no Harness session; Ghostty's three gone: `appSwitched` heard `'empty'`, `views` has no new entry, `holdsTab()` is false.
  - `a read without apps decides nothing on an app's ring`: Ghostty's agents gone, `listAgentSnapshot()`: `views` has no new entry.
  - `the app in front getting agents again after it emptied turns the view back to apps`: after `'tabs empty'`, a known Ghostty agent is added (Ghostty still settled): a read with `apps: true` tells `'apps front'`.
  - `a pick of Harness made before the window opened turns the view to tabs once and holds`: no window, Harness's two sessions and `five()`, one read with `apps: true`, `ghostty` settled, `pickApp('harness')` is `'switched'`. The window opens: `'apps window'`. A read with `apps: true`: `'tabs empty'`. Three more reads: no new entry. `vscode` settles: `'apps front'`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableHost.spec.ts`. Expected: FAIL (`holdsTab` is not a function, no `appView` call).
- [ ] **Step 3: Implement.** One private setter for the view tells the wiring. `counts` is one private method, which the filter's `counts` dependency calls too.
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npx vitest run src/cable src/services/devices.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `cable host: the view with a window open, tabs or apps, set by the app in front, a pick, the window and the shown app emptying`.

### Task 3: What each dial is answered

**Layer:** devices service process. **Depends on:** Task 2. **Effort:** `high`.

**Red test:** the tests below in `cli/src/cable/cableHost.spec.ts`, and the rewritten test in `cli/src/services/devices.spec.ts`.

**Files:**
- Modify: `cli/src/cable/cableHost.ts` (`appFocus` 496, `onMachine` 553, `capsOf` 570, `hostOf` 575, `appOf` 579, `markSeen` 609, `listSwarms` 633, `listAgentSnapshot` 678, `activeSwarm` 742, `sendTurn` 861, and the comments that say "with no window" at 235-238, 536, 551)
- Test: `cli/src/cable/cableHost.spec.ts`, `cli/src/services/devices.spec.ts` (one test, line 1775)

**Interfaces:**
- Consumes: the view (Task 2).
- Produces, on `DaemonCableHost` (each `opts` is `{ apps?: boolean }`, default `{}`):
  - `listAgentSnapshot(opts)`: asked with `apps: true` while the view is `apps`, the machine answer (`machineSnapshot`), the same object it gives with no window. Otherwise as today. E (Task 2) is now checked on that answer's `apps.shown`, which `machineSnapshot` reads after it has fed Harness's agents, and Task 2's own ask of the filter goes: the filter is asked once a read. A read that E turns to `tabs` answers the tab.
  - `appFocus(opts)`: `undefined` for `apps: true` while the view is `apps`. Otherwise the wiring's answer, as today.
  - `listSwarms(opts)`: `{ selected: '', swarms: [], tiles: [] }` for `apps: true` while the view is `apps`. Otherwise as today.
  - `activeSwarm(opts)`: `''` for `apps: true` while the view is `apps`. Otherwise as today.
  - `capsOf(agentId, opts)`, `hostOf(agentId, opts)`, `appOf(agentId, opts)`, `markSeen(agentId, opts)`: the registry is asked with no window, and for `apps: true` while the view is `apps`. A dial on the tab is answered `undefined`, as today.
  - `sendTurn(agentId, text)`: an agent of another app is sent its words through its source with no window and while the view is `apps`, whichever dial asked. In `tabs` it is refused as today.
- One private helper says whose window a dial holds: none with no window, and none for `apps: true` while the view is `apps`. Every method above asks it.
- `CableHostWiring.appFocus` keeps its type (`CableHost['appFocus']`), and the devices' wiring is not touched: a function that takes nothing is still one.

- [ ] **Step 1: Write the failing tests:**
  - `on an app's ring a dial that says appFilter is answered as with no window`: the answer to `listAgentSnapshot({ apps: true })` taken with no window, then a window on `h1` with Ghostty settled in front: the same call is `toStrictEqual` that answer; `listSwarms({ apps: true })` is `{ selected: '', swarms: [], tiles: [] }`; `activeSwarm({ apps: true })` is `''`. The window then changes its tab (`onTab(host, ['h2'], 't2')`): the three answers are the same. This replaces `the front is followed while a window is open: when it closes, the app that settled in front meanwhile is shown`.
  - `a dial without appFilter is answered as before in either view`: on an app's ring, `listAgentSnapshot()` is `toStrictEqual` `{ tab: 't1', total: 2, agents: [<h1's row>] }`, `listSwarms()` names the tab, `activeSwarm()` is `'t1'`, and `capsOf('h1')`, `hostOf('h1')` and `appOf('g1')` are `undefined`.
  - `caps, host and app answer a dial on an app's ring as with no window` (after one read with `apps: true`, which feeds Harness's agents): `capsOf('g1', { apps: true })` is `'s'`, `capsOf('h1', { apps: true })` is `'sva'`, `hostOf('g1', { apps: true })` is `'ghostty'`, `appOf('h1', { apps: true })` is `'harness'`. In `tabs` each is `undefined`.
  - `markSeen reaches an agent of another app for a dial on an app's ring`, and not on the tab.
  - `the window's focus is answered to a dial on the tab and to an older dial, and to no dial on an app's ring` (the wiring's `appFocus` answers `{ machineId: 'mine', agentId: 'h1' }`): on an app's ring `appFocus({ apps: true })` is `undefined` and `appFocus()` is the focus; on the tab, and with no window, both are the wiring's answer.
  - `a read that finds the shown app left as Harness answers the tab`: on Ghostty's ring, Ghostty's agents gone: `listAgentSnapshot({ apps: true })` is `toStrictEqual` the tab's answer (`{ tab: 't1', total: 2, agents: [<h1's row>] }`), and `listSwarms({ apps: true })` names the tab after it.
  - In `an agent outside Harness takes its voice, its answer and its tap from its own source`: `with a window, its words are delivered on an app's ring and refused on the tab`.
  - `appOf is the agent's app in the machine view, undefined with a window` is retitled `… undefined on the window's tab`, and passes as written.
  - `devices.spec.ts`, replacing `a front through the handler with a window open moves nothing on the dial, and is shown when the window closes`: `a front through the handler with a window open turns a dial that says appFilter to the app, and leaves an older dial its tab` (after the settle, `listAgentSnapshot({ apps: true })` has `apps.shown` `'vscode'` and `view` `'machine'`; `listAgentSnapshot()` equals the tab's answer).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableHost.spec.ts src/services/devices.spec.ts`. Expected: FAIL (the tab's list where the app's ring is expected).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd cli && npx vitest run src/cable src/services/devices.spec.ts && npm run test:core && npm run typecheck`. Expected: PASS, 100% for `services/devices.ts`.
- [ ] **Step 5: Commit** `cable host: on an app's ring a dial that says appFilter is answered as with no window, any other dial the tab`.

### Task 4: The session asks as its dial, pushes a view change, and follows the window only on its ring

**Layer:** devices service process. **Depends on:** Task 1. **Effort:** `xhigh`.

**Red test:** the tests below in `cli/src/cable/cableSession.spec.ts`.

**Files:**
- Modify: `cli/src/cable/cableSession.ts` (the `CableHost` interface 329-374, the hello's follow 1332, `agent.open` 1487, `voice.begin` 1717, `agentSnapshot` 2526, `syncSwarmsNow` 2747, `followApp` 3223, `followLocal` 3301, `lacks` 3345, `outsideHarness` 3352, `hostName` 3357, the `markSeen` call 1452)
- Test: `cli/src/cable/cableSession.spec.ts`

**Interfaces:**
- Consumes: `AppPick` with `'tabs'` (Task 1).
- Produces, in the `CableHost` interface, an optional last parameter `opts?: { apps?: boolean }` on `listSwarms`, `activeSwarm`, `capsOf`, `hostOf`, `appOf`, `markSeen` and `appFocus`. `pickApp`'s comment says `'tabs'`; `appFocus`'s says it answers nothing to a dial on an app's ring.
- The session passes `{ apps: this.appFilter }` to each of them and to `listAgentSnapshot`, from one private getter. `appFocus` has three callers: the hello's follow, `voice.begin` and `viewChanged`.
- Dictation: `voice.begin` is not otherwise changed. With no focus answered, plain dictation keeps the agent the dial named, and an agent that takes no voice is refused in its app's name, as with no window.
- Produces, on `CableSession`:
  - `viewChanged(): Promise<void>`. Nothing for a dial that is not connected or does not say `appFilter` (`wantsApps`). Else, in this order: the machine list's push gap is reset (`agentsPushedAt`), `syncSwarms()`, `syncAgents()`, then `followApp` to `host.appFocus(opts)` when it names one (on an app's ring it names none).
  - `followApp(machineId, agentId)`: the window's follow. A dial that says `appFilter` and holds no tab (`host.activeSwarm({ apps: true }) === ''`) is not moved to an agent its last list lacks (`lastRing`): nothing is sent, and `desiredFocus` is kept. Otherwise today's body, which moves to a private method.
  - `followLocal` calls that private method, not `followApp`: its own list read already said the agent has a tile, and a tile the dial has not been sent yet must still be reached.
- A pick the host answers `'tabs'` sends nothing from the session: the view's change sends the tabs and the list. `agent.open` then goes on to `host.openAgent`, as for any pick that did not switch.

- [ ] **Step 1: Write the failing tests** (in `the app filter`; `appHost`'s `state` gains `appView: boolean` and `focus`; its `listAgentSnapshot`, `listSwarms` and `activeSwarm` answer the machine view for `apps: true` when `state.window && state.appView`, and the tab `t1` for anyone else with a window; its `appFocus` answers `undefined` in that same case and `state.focus` otherwise):
  - `a dial that says appFilter asks its host as itself`: `listSwarms`, `capsOf`, `hostOf`, `appOf`, `markSeen` and `appFocus` are called with `{ apps: true }` as their last argument.
  - `a dial without appFilter asks as itself, and follows the window as before`: the same calls carry `{ apps: false }`; with `state.appView` true, `followApp('mac-local', 'a2')` sends `{ t: 'focus', agentId: 'a2' }`.
  - `viewChanged on an app's ring: no tabs, then apps and the ring, inside the machine list's 1 s gap` (`vi.useFakeTimers({ toFake: ['Date', 'performance'] })`): a tab push, 100 ms, `state.appView = true`, `await session.viewChanged()`. The frames since are a `swarms` with no tabs, `apps`, `agents.begin`, Ghostty's three `agent` rows and `{ t: 'agents.end', total: 3, tab: '', view: 'machine' }`, and no `focus` for the window's agent.
  - `viewChanged back on the tab: the tabs, the tab's list, then the focus on the window's agent`: `state.focus = { machineId: 'mac-local', agentId: 'a2' }`, `state.appView = false`. In `port.types()`, `swarms` comes before `agents.end`, which comes before the `focus` whose `agentId` is `a2`.
  - `viewChanged with the list unchanged sends no list twice`: a second `viewChanged()` sends no `agents.begin`.
  - `viewChanged on a dial without appFilter, or one not connected, sends nothing`.
  - `a window focus off the ring of a dial on an app's ring does not move it`: on Ghostty's ring, a hand on `g2`; `followApp('mac-local', 'a2')`: no `focus` frame, no `agents.begin`. The record still names `g2`: `followLocal('g2', 'prompt')` sends nothing, and `followLocal('g3', 'prompt')` sends one `focus`, for `g3`.
  - `a window focus on that ring moves the dial`: `followApp('mac-local', 'g3')` sends `{ t: 'focus', agentId: 'g3' }`.
  - `a dial plugged in while on an app's ring is not turned to the window's agent`: `state.focus` names `a2`; after the greeting no `focus` for `a2` was sent.
  - `a prompt for an agent the dial has not been sent yet still moves it` (a dial that says `appFilter`, no window, 1.1 s after its last push on the fake clock): `state.rings.ghostty` gains `g4`, then `followLocal('g4', 'prompt')`: `agents.end` before the `focus` for `g4`.
  - `a pick the host answers tabs sends nothing itself`: `pickApp` returns `'tabs'`; after `app.pick`, `listFrames(port)` since is `[]`.
  - `a tapped notice whose pick answers tabs opens the agent`: `host.openAgent` was called with the agent, and the session forced no list.
  - `dictation on an app's ring goes to the agent on the dial's face` (a window open and `state.appView` true; `g2`'s row has caps `'sv'`, `state.focus` names `a2`, `transcribe` answers `'run the tests'`): after `voice.begin` naming `g2`, audio and `voice.end`, `host.sendTurn` was called once, with `('g2', 'run the tests')`, and the `voice.transcript` frame names `g2`.
  - `dictation to an agent there that takes no voice is refused in its app's name, and nothing goes to the window's agent`: `voice.begin` naming `g1` (caps `'s'`), then `voice.end`: the answer is `{ t: 'voice.error', uploadId, message: 'This agent is in Ghostty. Talking to it from the device comes in an update.' }`; `transcribe` and `host.sendTurn` were not called.
  - `on the tab, and for a dial without appFilter beside an app's ring, dictation goes to the window's focused agent` (a pin: it passes before the change too; `state.focus` names `a2` and `voice.begin` names `a1`): with `state.appView` false for a dial that says `appFilter`, and with it true for one that does not, `host.sendTurn` was called with `('a2', …)`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableSession.spec.ts`. Expected: FAIL (`viewChanged` is not a function).
- [ ] **Step 3: Implement.** The five `markSeen` assertions (lines 4762-4948) gain `{ apps: false }` as their second argument.
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `cable session: a dial asks as itself, a view change is sent at once, and the window moves a dial only on its ring`.

### Task 5: The fleet hands a view change to every dial

**Layer:** devices service process. **Depends on:** Task 4. **Effort:** `medium`.

**Red test:** `viewChanged reaches each attached dial` in `cli/src/cable/cableFleet.spec.ts`.

**Files:**
- Modify: `cli/src/cable/cableFleet.ts` (beside `followLocal`, line 422)
- Test: `cli/src/cable/cableFleet.spec.ts`

**Interfaces:**
- Consumes: `CableSession.viewChanged()` (Task 4).
- Produces: `CableFleet.viewChanged()`, through `send('viewChanged')` as `followLocal` is.

- [ ] **Step 1: Write the failing test,** beside `followLocal reaches each attached dial`: two dials greeted with `appFilter: 'v1'`, the host's tabs changed, `await f.fleet.viewChanged()`: each port was sent a `swarms` frame since.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableFleet.spec.ts`. Expected: FAIL (`viewChanged` is not a function).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command and `cd cli && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `cable fleet: a view change reaches each dial`.

### Task 6: The devices: the gate, the log line and the pushes

**Layer:** devices service process. **Depends on:** Tasks 3, 5. **Effort:** `high`.

**Red test:** the tests below in `cli/src/services/devices.spec.ts`.

**Files:**
- Modify: `cli/src/services/devices.ts` (the host's wiring 390-409, `windowOpen`, `tell`, `showWaits` and `remind` 596-680, `dialAttached` 683, the `swarms` handler 917-926)
- Test: `cli/src/services/devices.spec.ts`

**Interfaces:**
- Consumes: `CableHostWiring.appView`, `DaemonCableHost.holdsTab()` (Task 2); the lists of Task 3; `CableFleet.viewChanged()` (Task 5); `CableFleet.wantsApps()`, which is there already.
- Produces:
  - `appView: (view, cause)`: writes `[device] app filter: view ${view} · ${cause}`. Then, in a microtask as `appSwitched` does (the view can turn inside a list read), each guarded by `part.call('dial', …)`: `cable.viewChanged()`, `showWaits`, and `remind` when the view is `apps`.
  - The gate is one function beside `windowOpen`, which stays: `heldOnTab = (): boolean => windowOpen && (cableHost.holdsTab() || !cable.wantsApps())`. `tell`, `showWaits` and `remind` ask it where they read `windowOpen`.
  - The `swarms` handler reads `heldOnTab()` before it sets `windowOpen` and calls `setSwarms`, and reminds when it was true and is false after (the window closed while the dials held its tab). Its `syncSwarms`, `syncAgents` and `showWaits` stay.
  - `dialAttached(on)` runs `showWaits`, guarded as its other calls are: when a dial came, after the held questions are asked again and before `remind`; when one went, after its timers are cleared. A dial that says `appFilter` coming or going turns the gate.
  - The `appFocus` and `windowFocus` handlers stay as they are: `cable.followApp` now holds the rule.
- `FakeCable` in the spec gains `viewChanged = recorder('viewChanged')`.

- [ ] **Step 1: Write the failing tests** (a describe `with a window open` inside `the app a dial that says appFilter shows`; `windowed(app?)`: fake timers, `twoApps`, `port.swarms` with one tab, then `host().front(app)` and `FRONT_SETTLE_MS`; `views()`: the log lines that include `app filter: view`):
  - `the window opening, an app settling in front and a pick of Harness each log the view with its cause, and no app`: `views()` is `['[device] app filter: view tabs · window', '[device] app filter: view apps · front', '[device] app filter: view tabs · pick']`.
  - `a view change sends the dials their lists once`: `calls('viewChanged')` grows by one for each of those three, and by none for Ghostty settling again.
  - `on an app's ring an outside agent's turn, wait and reminder reach the dial, and on the tab none does`: a `turn-start`, an `asked` and `REMIND_MS`: in `apps`, `turnStarted`, `question` and a second `turnStarted`; in `tabs`, none of them.
  - `turning to an app's ring asks what waits and tells each agent mid-turn; turning back closes its question`: an agent waits while in `tabs`; Ghostty settles: one `question` and one `turnStarted`; `harness` settles: `questionClose` with that id.
  - `with a window and an app's ring, a prompt in the app in front asks the dials to follow, and the list a dial that says appFilter reads holds its agent`: `calls('followLocal')` is `[[<id>, 'prompt']]`, and the ids of `listAgentSnapshot({ apps: true })` contain it.
  - In `selecting a tab moves the dial`: `with a window open, a tab report whose app has settled in front asks the dials to follow, and the list holds its agent`.
  - `the window closing from the tab reminds, and from an app's ring does not again`.
  - `with a window open and no dial that says appFilter, an app's ring opens nothing` (`FakeCable.apps` false, `windowed('ghostty')`): a `turn-start`, an `asked` and `REMIND_MS` give no `turnStarted` and no `question`; the window closing then reminds.
  - `a dial that says appFilter coming while the view is apps is asked what waits and told each agent mid-turn, and its going closes the question`: `apps` false, `windowed('ghostty')`, one agent waiting and one mid-turn: nothing. `apps` true and `seen.host.watching!(true)`: one `question` and one `turnStarted`. `apps` false and `seen.host.watching!(false)`: `questionClose` with that id.
  - `the shown app left as Harness logs "view tabs · empty", sends the dials their lists and closes the outside agents' questions` (`AppFilter.prototype.shown` spied to answer `'harness'`, as `a switch pushes the list to the dials at once` spies it): on Ghostty's ring with one agent waiting, a read with `apps: true`: `views()` gains `'[device] app filter: view tabs · empty'`, `calls('viewChanged')` grows by one, and `questionClose` was called with the question's id.
  - `the window's focus is handed to the dials as before` (a pin: it passes before the change too): `calls('followApp')` after `port.appFocus('m1', 'a1')` in `apps` is `[['m1', 'a1']]`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts`. Expected: FAIL (no `view` line).
- [ ] **Step 3: Implement.** A test that states the old rule ("with a window open … nothing") still holds where no app has settled in front; one that settles an app there is rewritten to the new rule, never dropped. `passes the tabs, the unread rows, the window's focus and what it saw` (line 716) lists the fleet's calls in order: it gains `viewChanged` where the window opens.
- [ ] **Step 4: Run** `cd cli && npm run test:core && npm run typecheck && npx vitest run src/architecture.spec.ts src/leanEntry.spec.ts`. Expected: PASS, 100% for `services/devices.ts`.
- [ ] **Step 5: Commit** `devices: with a window open the dial follows the app in front, and the agents outside a pane reach it there`.

### Task 7: End to end: a window, the app in front, and back

**Layer:** test. **Depends on:** Tasks 6, 10 (step 6 of the first case writes Linux's exe name). **Effort:** `high`.

**Red test:** none: no behavior (end-to-end tests of what Tasks 1 to 6 and 10 built, and the one case their change made untrue).

**Files:**
- Modify: `cli/e2e/dialAppFilter.e2e.ts`

**Interfaces:**
- Consumes: the file's own `fresh`, `plugged`, `startFirst`, `startOutside`, `listening`, `watch`, `rosters`, `appsFrames`, `shows`, `settleWindowPassed`, `GHOSTTY`, `GHOSTTY_BUNDLE`; `LocalClient`; a Harness agent made through the window as `devicesProcess.e2e.ts`'s `create` makes one (`agent_create`, the fake Claude Code).
- The order each case keeps, so no tie is drawn: two agents in Ghostty first, with no window; then the window on an empty tab; then two Harness agents `h1` and `h2`, the tab announced with both (`app_swarms`, `app_panes`), and `app_focus` on `h2`.
- Harness in front is `{"front":"ai.autonomous.harness"}` on the watch's stdin. No Harness Desktop and no Harness Device runs.

- [ ] **Step 1: Write the tests** (a daemon of its own each; a describe `with a window open`):
  - `the app in front turns the dial to its ring, and Harness in front returns it to the tab on the window's focused agent`:
    1. The dial holds the tab: a list whose `end.tab` is `t1` with `h1` and `h2`, and a `focus` for `h2`.
    2. `run.front(GHOSTTY_BUNDLE)`: `shows(dial, 'ghostty', [g1, g2], since)`, `end.tab` is `''`, and the last `swarms` frame since has no tabs. The log has `[device] app filter: view apps · front`.
    3. `window.send('app_focus', { agentId: h1 })`, then `settleWindowPassed`: the dial heard no `focus` for `h1`.
    4. `g2.type('hello')`: the dial hears a `focus` for `g2`; the log has `[device] prompt · moved` and no `prompt · skipped · no tile`.
    5. `run.front('ai.autonomous.harness')`: a list whose `end.tab` is `t1`, then, after that `agents.end`, a `focus` for `h1`. The log has `[device] app filter: view tabs · front`.
    6. `run.front(GHOSTTY_BUNDLE)`: Ghostty's ring again. `run.front('harness')`, the exe name as Linux writes it (Task 10): a list whose `end.tab` is `t1`.
  - `a pick of Harness in APPS returns the dial to the tab, and an older dial beside it kept the tab throughout`: a second dial plugged with no capabilities. On Ghostty's ring the older dial's last list has `end.tab` `t1` and it was sent no `apps`. `dial.send({ t: 'app.pick', app: 'harness' })`: the new dial's list has `end.tab` `t1`; the log has `[device] app filter: view tabs · pick`.
  - `the front is followed while a window is open: when it closes the dial is sent the app that came to the front meanwhile` is removed: the first case replaces it.
  - In `the daemon's log has "app filter: switched" lines …`, the pattern also takes `view (tabs|apps) · (front|pick|window|empty)`, and a window is opened and closed in it so one such line is there.
- No case ends the shown app's agents: an ended session stays listed for up to 40 s, and the rule is held by Task 2's and Task 6's tests.
- [ ] **Step 2: Run** `cd cli && npm run typecheck && npx vitest run --config vitest.e2e.config.ts e2e/dialAppFilter.e2e.ts`. Expected: PASS.
- [ ] **Step 3: Commit** `e2e: with a window open the dial follows the app in front, and returns to the tab with Harness`.

### Task 8: The on-dial rig opens a window

**Layer:** test rig. **Depends on:** none (the log line's text is fixed in Global Constraints). **Effort:** `high`.

**Red test:** `the rig's log check takes the view's lines and refuses one that names an app` and `the rig knows a greeting that says appFilter`, in the always-run describe of `cli/e2e/dialAppFilterOnDial.e2e.ts`.

**Files:**
- Modify: `cli/e2e/dialAppFilterOnDial.e2e.ts`

**Interfaces:**
- Produces, module-level: `expectFilterLines(log: string): void`. Every line that includes `app filter:` matches `/\[device\] app filter: (switched · (front|pick|empty|notice)|picker|view (tabs|apps) · (front|pick|window|empty))$/`. The rig's walk calls it in place of its inline loop (line 130), and its count line also prints `view tabs` and `view apps`.
- Produces, module-level: `saysAppFilter(greeting: string): boolean`, true when the greeting's `caps` list names `appFilter` (`cable: dial … caps swarms,recap,appFilter`). The walk asks it of the line it prints at the greeting. For a dial that greeted without it, the rig prints `This dial does not say appFilter. Stop here: ask before any flash.`, does not wait for `done`, closes its daemon and fails with `the dial does not say appFilter`. The rig never flashes (`CABLE_FW_DISABLE` stays true).
- Produces, in the walk, a window of the rig's own, a `LocalClient` on the rig's daemon. The person drives it with files in `ON_DIAL_OUT`, each removed once acted on, looked for once a second as `done` is:
  - `window`: three Harness agents (the fake Claude Code, made through the window with `agent_create` as `devicesProcess.e2e.ts`'s `create` makes one), tab `t1` with `h1` and `h2`, tab `t2` with `h3`, `t1` active, focus on `h1`;
  - `focus`: the window focuses `h2`;
  - `tab`: `t2` becomes the active tab, with `h3` on it and in focus;
  - `harness`: the devices are told Harness is in front, with `tellDevices(d.dataDir, { type: 'front', app: 'harness' })` (`cli/src/devices/listenerClient.ts`). No second watch is started, so Harness Device's watch keeps its `tabs` stream;
  - `close`: the window closes.
- The rig prints one line for each file, and each agent's name.

- [ ] **Step 1: Write the failing tests:**
  - `expectFilterLines` passes over `'[device] app filter: view apps · front\n[device] app filter: view tabs · pick\n[device] app filter: view tabs · empty\n[device] app filter: switched · front'`, and throws over `'[device] app filter: view apps · front ghostty'`.
  - `saysAppFilter('cable: dial aa:bb on fw 0.0.95 proto 2 caps swarms,recap,appFilter')` is true; it is false for `'cable: dial aa:bb on fw 0.0.90 proto 2 caps swarms,recap'` and for `'cable: dial aa:bb on fw 0.0.90 proto 2'`.
- [ ] **Step 2: Run** `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialAppFilterOnDial.e2e.ts`. Expected: FAIL (`expectFilterLines` is not defined). The walk is skipped without `ON_DIAL_PORT`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command and `cd cli && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `e2e rig: the on-dial walk opens a window, takes the view's lines, and stops for a dial without appFilter`.

### Task 9: Say it in the docs

**Layer:** repo files. **Depends on:** none. **Effort:** `medium`.

**Red test:** none: no behavior.

**Files:**
- Modify: `docs/specs/2026-11-14-dial-app-filter.md`, `cli/AGENTS.md`

- [ ] **Step 1:** Write the changes, in each file's own words and length:
  - The app filter spec, § Which app is shown, step 4: replaced by a pointer to `2026-11-15-dial-follow-front-with-window.md`.
  - The same spec, § Decided on the plan's questions, 6: replaced by the same pointer.
  - The same spec, § Done when, On a dial, 7: "Harness Desktop in front: the dial goes back to the active tab, and a hold opens TABS."
  - The same spec, § From the watch to the devices process, the exe names: Linux's list gains `harness`, Harness Desktop's (`desktop/linux/CMakeLists.txt`, `BINARY_NAME`).
  - `cli/AGENTS.md`, the devices row: after "which app the dial shows", one clause: with a window open, whether it holds the window's tab or that app. No new process, listener or stored value.
- [ ] **Step 2:** Check every link resolves.
- [ ] **Step 3: Commit** `docs: with a window open the dial follows the app in front`.

### Task 10: Harness Desktop in front on Linux

**Layer:** the watch (a CLI process) and the devices service process (the Linux scan). **Depends on:** none. **Effort:** `medium`.

**Red test:** `frontAppId('harness')` is `'harness'` in `cli/src/cable/hosts/frontApp.spec.ts`, and `on Linux a session under a process named harness is in Harness` in `cli/src/cable/hosts/scannedApp.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/frontApp.ts` (`EXE_APPS`, line 11)
- Test: `cli/src/cable/hosts/frontApp.spec.ts`, `cli/src/cable/hosts/scannedApp.spec.ts` (one test, no change to `scannedApp.ts`)

**Interfaces:**
- Produces: one row in `EXE_APPS`, `harness: 'harness'`, with a comment that names where the name comes from (Harness Desktop's Linux binary, `desktop/linux/CMakeLists.txt`, `BINARY_NAME`). `frontAppId('harness')` and `frontAppId('Harness')` are `'harness'`. Nothing else in the table moves.
- Who reads the table:
  - the watch (`runDialWatch`, `cli/src/devices/client.ts` line 262), for the exe name the Harness Device app writes on Linux X11 (`front_x11.rs`, `exe_name`): Harness Desktop in front is now told as `harness`, not `none`;
  - the Linux scan (`scannedApp.ts` line 102), for each parent process's name: a session the open scan finds under a process named `harness` is now put on Harness's page. On macOS a session under Harness.app's bundle already is (`nearestApp`, `BUNDLE_APPS`). The daemon's own processes are named `harnessd…` and the CLI runs as `node`, so neither matches. Open question 1 asks Diego to confirm this side.

- [ ] **Step 1: Write the failing tests:**
  - `frontApp.spec.ts`: `EXES` gains `['harness', 'harness']` and `['Harness', 'harness']`, and the `it.each` over it is retitled to name `harness` too.
  - `scannedApp.spec.ts`, in `scannedApps elsewhere`: `on Linux a session under a process named harness is in Harness`: `deps([[10, 9, 'claude'], [9, 8, 'bash'], [8, 1, 'harness']], {}, 'linux')`, and `scannedApps([10], d)` equals `new Map([[10, 'harness']])`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/frontApp.spec.ts src/cable/hosts/scannedApp.spec.ts`. Expected: FAIL (`'none'` where `'harness'` is expected; an empty map).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npx vitest run src/cable/hosts src/devices && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `front app: Harness Desktop's Linux exe name is Harness`.

---

## Verification

**Platforms the pull request names:** the daemon on macOS and Linux X11. On Linux, Harness Desktop in front is read by its exe name (Task 10; check 1 writes it on the Linux shards). Windows: nothing changes, since nothing tells the app in front there. No firmware, Desktop or Harness Device change: the round dial on its current release.

**Temporary workflow:** none. The one long check runs on the repo's own workflow, by hand.

**Turns.** The tester asks the orchestrator before the one hand-started GitHub run (check 1) and before the shared dial (check 3), and starts neither until it is granted.

**Local gates**, recorded in the pull request (PR CI does not run them; `docs/validation-and-release.md`):
- `node -p process.arch` says `arm64`.
- `cd cli && npm run typecheck && npm run test:core`: 100% per file for `services/devices.ts`. Then `npx vitest run src/architecture.spec.ts src/leanEntry.spec.ts`: the core's file list is unchanged.
- `git diff --stat origin/main -- cli/src/core cli/src/localWsServer.ts cli/src/architecture.coreFiles.txt devices desktop device-app` prints nothing.
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit. Its receipts are in the pull request's body before the push that `process-checks` reads.
- Not needed: `npm run test:harnessd`, the serial, PTY and shell specs, `make device-test`, `make desktop-test`, `cargo test`, `windows.yml`.

**PR CI, automatic:** the CLI unit jobs run the specs of Tasks 2 to 6 and 10 on Linux. Nothing is started by hand.

**1. The real daemon, a fake dial, a fake window, the real watch**
- On GitHub, by hand, once on the final head, after the orchestrator's go: Actions → CLI end to end → Run workflow, branch `feat/dial-follow-front-with-window` (`.github/workflows/cli-e2e.yml`, eight Linux shards).
- Isolation: the suite's own (`cli/e2e/harness/daemon.ts`). A throwaway home and data folder, a private port and tmux server, fake engines, a fake dial on a pseudo-terminal, a window that is the suite's `LocalClient`. No backend, no sign-in, no Harness Desktop, no Harness Device. The test writes the `front` lines on the watch's stdin. The everyday daemon (18473) and production are not touched.
- A person sees: every shard passes. In `dialAppFilter.e2e.ts`, `with a window open` passes: the dial is sent Ghostty's ring with `tab: ''` while the window is open, then the tab `t1` and a `focus` on the window's agent, and the tab again when the watch is written `harness`, as Linux names Harness Desktop. The daemon's log has `[device] app filter: view apps · front`, `view tabs · front`, `view tabs · pick` and `[device] prompt · moved`, and no `prompt · skipped · no tile`.
- The cases keep running after this pull request: the file is in the nightly run already.

**2. The tab follow on a Mac**
- Run, on a Mac, at the final head: `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialTerminalFollow.e2e.ts`.
- Why by hand: the file is macOS only, so the Linux shards of check 1 skip it. A tab's follow goes through `followLocal`, whose path Task 4 changes. The prompt's and the Claude app's follows (`dialPaneFollow.e2e.ts`, `dialClaudeAppFollow.e2e.ts`) run in check 1.
- Isolation: as check 1. The real Terminal is never asked anything: the test writes the `front` and `tab` lines itself.
- A person sees: every test passes.
- On GitHub: none. No workflow runs this file.

**3. On a dial** (the spec's "On a dial" 1 to 6)
- When: at the final head, after the orchestrator's go for the shared dial. Nothing below starts before it.
- Where: the Mac the shared round dial is plugged into, in a desktop session.
- **Never the everyday daemon, Diego's own dial or anyone's account.** Quit Harness and Harness Device, then `harness stop`. The daemon is the rig's (Task 8): the suite's `IsolatedDaemon`, with a throwaway home, data and auth folder, a port of its own, a private tmux server, signed out, no update, no firmware offer. It holds the dial through `HARNESSD_TEST_DIAL_PORT`.
- The window is the rig's own, and "Harness in front" is the rig's `harness` file (the PM, 2026-11-15). Harness Desktop is not pointed at the rig's daemon: the desktop app would start and reach the everyday daemon. So the real dial, the real Terminal and the real Harness Device are walked, and Harness Desktop itself coming to the front is not.
- Run: `cd cli && TMPDIR=/tmp ON_DIAL_PORT=<the dial's port> ON_DIAL_OUT=<a scratch folder> npx vitest run --config vitest.e2e.config.ts e2e/dialAppFilterOnDial.e2e.ts`.
- **First, before anything else is started: the dial's firmware.** The rig prints the dial's greeting within a minute. It must name `appFilter` (`… caps …,appFilter`). If it does not, the rig stops by itself (Task 8). Then restore the Mac as under "Afterwards", and ask the orchestrator before any flash: this plan flashes nothing, and the check is reported as not verified until a dial that says `appFilter` is there.
- Agents: `sh <out>/tab.sh a1` and `sh <out>/tab.sh a2` in two tabs of the real Terminal (the suite's fake Claude Code; no Claude, Codex or Harness login).
- Harness Device: the debug build at the final head, which is `main`'s (this plan changes nothing in `device-app/`) (`(cd device-app/ui && npm ci && npm run build) && (cd device-app/src-tauri && cargo build --locked)`), started with `sh <out>/device.sh` after the dial greeted, so its watch reaches the rig's daemon. macOS may ask once to let it control Terminal: allow.
- The rig's `harness` file does not change which app macOS has in front, and the watch tells only a change. So Terminal is told again by a visit to Safari: **"Terminal back"** below is Safari to the front for two seconds or more, then Terminal. A shorter visit settles nothing, and after a pick of Harness the dial then rightly keeps the tab. The `touch` lines are typed in a third Terminal tab, a plain shell.
- A person does and sees:
  1. `touch <out>/window` (Terminal is in front, so the dial may stay on Terminal's ring), then `touch <out>/harness`: the dial shows the tab `t1`, on `h1`. Terminal back: in about 1 s the dial shows Terminal's two agents, and the face says "Terminal".
  2. `hello` typed in `a2`'s tab, then `a1`'s tab selected: the dial turns to that agent each time.
  3. Hold: `APPS`. Pick Harness: the window's tab `t1`, and a hold now opens TABS. Terminal back: Terminal's ring. `touch <out>/focus`, then `touch <out>/harness`: the tab, on the window's focused agent, `h2`. (The spec's step 3, as the PM reworded it on 2026-11-15.)
  4. On the tab: Safari to the front, then a listed app with no agents (VS Code, say): the dial keeps the tab. Terminal back, then the same two: the dial keeps Terminal's ring.
  5. Terminal back, `touch <out>/tab`: the dial stays on Terminal. `touch <out>/harness`: the tab `t2`, on `h3`.
  6. Terminal back, `!permit printf hi` typed in `a1`'s tab: its line and its question show. `touch <out>/harness`: the question closes. Terminal back: it is asked again.
- Evidence: `<out>/daemon.log` (the `view` lines with their causes, `[device] prompt · moved`, `[device] tab · moved`), the rig's counts, a photo of the face on Terminal's ring and of `APPS`.
- **Afterwards:** `touch <out>/done`, quit the debug Harness Device, `harness start`, start the released Harness Device. Check the dial lists the everyday daemon's agents, and tell the orchestrator the dial is free.
- Not done, for whatever reason: report it as not verified, never as passed.
- On GitHub: none. It needs a dial, Terminal and a person.

## Decided on the plan's questions (the PM, for Diego, 2026-11-15)

1. **Dictation on an app's ring** goes to the agent on the dial's face, as with no window. `host.appFocus` answers nothing for such a dial. Tasks 3 and 4.
2. **The shown app left as Harness, or no app, while a window is open** means the tab view. The cause is a fourth one, `empty`: the log line and the counters are `front`, `pick`, `window`, `empty`. Tasks 1, 2, 3 and 6.
3. **The gate for the agents outside a pane** stays shut with a window open unless a dial that says `appFilter` is connected. Task 6.
4. **Linux X11:** `harness` → `harness` joins `EXE_APPS`. Task 10.
5. **The on-dial check** uses the rig's own window and a file for "Harness in front". Harness Desktop is not pointed at the rig's daemon. Task 8 and check 3.
6. **The shared dial's firmware** is checked first: it must greet with `appFilter`. If not, the check stops and the orchestrator is asked before any flash. The plan flashes nothing. Task 8 and check 3.
7. **The spec's on-dial step 3** now reads: "Hold: APPS. Pick Harness: the window's tab. Bring Terminal to the front: Terminal's ring. Bring Harness to the front: the tab, on the window's focused agent." Check 3 follows it.
8. **The `harness` row also reaches the Linux scan** (`scannedApp.ts`): accepted, pinned by one test in `scannedApp.spec.ts` (Task 10).

## Decided here, where the spec was silent

- The view is `undefined` with no window. A window opening always tells the view it starts in, with `window`; a window closing tells nothing.
- A pick of Harness answers `'tabs'`, a fourth `AppPick`, so the session sends nothing itself and the view's change sends the tabs before the list.
- A tapped notice of a Harness agent, on an app's ring, turns the view to `tabs` as a pick of Harness does and is counted under `pick` (the view has no `notice` cause). The window then opens the agent, and the dial follows the window's focus.
- A pick of Harness holds as a pick of an app holds: through the same app settling in front again, and through that app getting agents, until another app settles.
- "Has agents" counts every agent of the app at a settle and at a window opening, as the filter's settle does. D1 counts known agents only, as the filter's D1 does.
- "At once" resets the machine list's 1 s push gap rather than forcing the push, so a list that did not change is not sent twice.
- The window's follow is checked against the ring the dial was last sent (`lastRing`), with no extra list read.
- The landing reads `host.appFocus(opts)`, the selection the window last reported, as a dial's attach does. A window too old to report one gives none, and the dial lands by the tab's list alone.
- A dial asks its host as itself for its tabs, the active tab, and an agent's caps, host and app. So an older dial is answered exactly as before in either view. `sendTurn` is not asked per dial: an agent of another app takes its words while the view is `apps`, whichever dial asked.
- Known edge, by the spec's rule of no protocol change: Harness has a page in `APPS` only while this computer has Harness agents. With a window whose tabs hold none (an empty tab, another computer's agents only), the dial returns to the tab only when Harness comes to the front.
- The end-to-end cases go in `dialAppFilter.e2e.ts`, which has the fake window, the watch and the list helpers, and already runs nightly.
- `empty` is decided where the filter's shown app is read: at a list read by a dial that says `appFilter`, as the filter's own `empty` is. A window opening is not checked for it: the first read after it is.
- The filter showing Harness while the app settled in front has known agents can only be a pick of Harness made before the window opened. It then holds as a pick of Harness with the window open holds, until another app settles, so the view does not turn back and forth at each read.
- After `empty`, the app in front getting known agents again turns the view back to `apps` (D1), as it turns the shown app with no window.
- A `view` line's cause is not checked against its view: the patterns take any of the four causes with either view.
- A dial coming or going asks `showWaits` again, since the gate can turn with it.
- The rig, not the person, stops the walk for a dial that does not say `appFilter`.
- Task 7 writes `harness` on the watch once, so the Linux shards walk Linux's own name for Harness Desktop. It is the one dependency the answers added: Task 7 on Task 10.
