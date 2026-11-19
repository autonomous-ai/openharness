# Round dial: a TABS | APPS switch on the TABS screen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(dial): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message. No task pushes or merges.

**Goal:** On the round dial's TABS screen a two-cell pill, `TABS | APPS`, flips to the other apps with agents, and a pick there turns the dial to that app's agents and brings the app to the front.

**Architecture:**
- **The dial host** (`cli/src/cable/cableHost.ts`) adds the other apps (never Harness, `shown: 'harness'`) to the tab's answer for a dial that says `appFilter`, and takes a pick of one of them on the tab: the filter holds the app, the view turns to `apps`, the answer is `switched`.
- **The filter** (`cli/src/cable/hosts/appFilter.ts`) gains `hold`: show an app and hold it even when it is already shown.
- **The session** (`cli/src/cable/cableSession.ts`) advertises `apps.switch` in the welcome. Its `apps` frame and its `app.pick` handler are not edited: they already send what the host gives and answer by the pick's answer.
- **The firmware** (`devices/harness-device/firmware`) parses the feature and draws the pill, its two taps and the switch's APPS in `ui_habitat.c`.
- Nothing in `cli/src/core/`, `cli/src/services/`, Desktop or `devices/harness-pro`. Nothing stored. No hello field, no proto bump.

**Tech Stack:** TypeScript daemon (Node, Vitest, `cli/`); C firmware with host tests in C and Python (`devices/harness-device/firmware/test`).

**Spec:** `docs/plans/2026-11-18-dial-tabs-apps-switch-design.md`. Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md` and `docs/specs/2026-11-14-dial-app-filter.md` (the filter, `apps` and `app.pick` this builds on).

**Open questions:** none.

## Base

- `feat/dial-tabs-apps-switch` at `e6737565c2` (`main` after #4437). The spec and this plan are untracked. The main session commits them; no task does.
- The tasks name functions, never lines. If a name differs at the base, the implementer follows the code and says so in its report.
- Read on this Mac at the base, 2026-11-18:
  - `env -u IDF_PATH bash devices/harness-device/firmware/test/run.sh`: exit 0, about 2.5 minutes.
  - The same with `IDF_PATH="$HOME/esp/esp-idf-5.5.4"`: `host features: PASS`, then it stops in `test_cable_models.py` (`'snprintf' macro redefined`, Apple clang with the macOS SDK). That failure is the base's, in a file this branch does not touch. Nobody fixes it here (Follow-ups).
  - PR CI's `firmware-checks` runs every `test/test_*.py` and no C test: `test_cable_features.c` runs only locally.
  - A tab read (`listAgentSnapshot({ apps: true })`, a window open, Harness in front): about 1 to 3 µs, no registry read, with 0 and with 50 agents.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 The filter holds an app | `cli/src/cable/hosts/appFilter.ts`, `appFilter.spec.ts` | none | medium | `appFilter.spec.ts` |
| 2 The tab's answer carries the other apps | `cli/src/cable/cableHost.ts`, `cableHost.spec.ts` | none | high | `cableHost.spec.ts` |
| 3 A pick on the tab | `cli/src/cable/cableHost.ts`, `cableHost.spec.ts` | 1, 2 | high | `cableHost.spec.ts` |
| 4 The welcome says `apps.switch` | `cli/src/cable/cableSession.ts`, `cableSession.spec.ts` | none | medium | `cableSession.spec.ts` |
| 5 The tab read's measure | `cli/scripts/benchmark-dial-tab-read.ts` | none | medium | none: no behavior (a measuring script), one commit |
| 6 End to end | `cli/e2e/dialAppFilter.e2e.ts` | 2, 3, 4 | high | none: no behavior (the end-to-end test of Tasks 2 to 4), one commit |
| 7 Firmware: the feature bit | `devices/harness-device/firmware/main/cable_features.h`, `cable_features.c`, `test/test_cable_features.c` | none | medium | `test_cable_features.c` |
| 8 Firmware: the pill, its taps and the switch's APPS | `devices/harness-device/firmware/main/ui/habitat/ui_habitat.c`, `test/test_touch_ui.py` | 7 | high | `test_touch_ui.py` |

Longest chain: three tasks (1 or 2 → 3 → 6).

- Tasks 1, 2, 4, 5 and 7 share no file and start at once. The CLI (1 to 6) and the firmware (7, 8) never share a file.
- Shared files, ordered by a dependency above: `cableHost.ts` and `cableHost.spec.ts` (Tasks 2, 3).

## Before starting

- `cli/node_modules` was installed while planning. If it is gone: `cd cli && npm ci`.
- `test_cable_features.c` needs the SDK's cJSON source, nothing else of the SDK. Below, `$IDF` is an ESP-IDF checkout that has `components/json/cJSON/cJSON.c` (on this Mac `$HOME/esp/esp-idf-5.5.4`). Nothing is built for the board and nothing is flashed.
- The firmware's host tests print one `PASS` line per file and stop at the first failure.

## Global Constraints

- **The core does not change.** No file under `cli/src/core/`, nothing `src/core/main.ts` imports, no line in `src/architecture.coreFiles.txt`. Every CLI file here runs in the devices service process.
- **Not touched:** `devices/harness-pro`, `cli/src/services/`, Desktop, `devices/harness-device/firmware/version.txt`. No firmware build for the board, no flash, no release.
- **Protocol.** No hello field. `CABLE_PROTO_VERSION` stays 3. The welcome's feature is `apps.switch`; the firmware's bit is `CABLE_FEATURE_APPS_SWITCH = 1u << 7`. The firmware drops every feature of a welcome that lists more than 16 names: the fullest round-dial welcome is 8.
- **The tab's `apps`.** Today's frame, fields and bounds: `shown` is the literal `'harness'`, the rows are the apps with agents other than Harness, at most 16 (`APP_LIMIT`). It goes when its key changes, as now.
- **A tab read** by a dial that says `appFilter` reads `registry.entries()` once and never calls `filter.shown()`.
- **Both mixes keep working.** Old firmware with the new daemon: it stores the tab's `apps` and draws nothing new. New firmware with an old daemon: no `apps.switch`, so the title is `TABS` as today.
- **The pill** (466 px glass, Inter 20, letter-spaced 2; `TABS` and `APPS` each measure 59 px, the font is 28 px high):
  - outer box `x 149, y 58, 168 x 36`, radius 18, fill `BG`, border `#2c2c2c`;
  - the selected cell's box `81 x 30` at `y 61`, radius 15, fill and border `#1e1e1e`, at `x 152` (TABS) or `x 233` (APPS);
  - each word centred in its 84 px cell at `y 62`: `TABS` from `x 161`, `APPS` from `x 245`. The selected word is `#8a8a8a` on `#1e1e1e`, the other `#3a3a3a` on `BG`;
  - two boxes and eight letter runs in both states. TABS goes from 23 runs to 29, APPS from 25 to 31 (`HT_RUNS` is 40);
  - hits `{83, 30, 150, 78}` for `A_SWITCH_TABS` and `{233, 30, 150, 78}` for `A_SWITCH_APPS`. The selected cell's hit is there and not enabled.
- **Copy:** the two words `TABS` and `APPS`, nothing else. No new font, no animation.
- **Logs:** no new line. The view's turn and the bring log as today (`view apps · pick`, `bring · ok`), never an app.
- **Paths.** No task adds a path under `~/.harness`. If one ever does, it goes through `cli/src/config/harnessHome.ts` (it lands on `main` soon, with a guard test; it is not at this base), never `homedir()` joined with `.harness` by hand. A rebase conflict in a path file goes to the PM.
- **Repo rules.** Tests never touch the developer's real daemon (port 18473), dial or homes. No fixed sleeps. Comments say why.
- **Platforms.** The daemon on macOS, Linux and Windows (the bring is macOS only, as #4373); the round dial's firmware.

## Review Focus

1. **A tab switch still loading when APPS is tapped.** A swipe on TABS switches the tab at once; its roster lands a moment later and `ui_land_after_reload` sends every view but TABS to the face. The switch's APPS must stay open. Task 8 (`a tab switch still loading`).
2. **A pick, on the tab, of the app Harness was picked over.** A `pickedOver` left behind keeps the view on the tab the next time that app gets agents in front. Task 3 (`ends that hold`).
3. **Eighteen other apps.** `APP_IDS` has 18 ids besides Harness and the dial keeps 16 rows. The tab's list is the first 16 in the order the apps appeared. Task 2 (`eighteen other apps`).
4. **A welcome of more than 16 names** loses every feature on the dial. Task 4 pins the fullest list at 8 names; Task 7 parses that same list whole.
5. **An `apps` frame on the tab for a dial that shows no switch** (what old firmware does with the new daemon). The face and TABS are drawn exactly as before. Task 8 (`no pill`).

## Decided (PM for Diego, 2026-11-18)

All in the spec: the welcome feature `apps.switch`, only for an `appFilter: 'v1'` dial whose host can pick; no hello field, no proto bump; `apps` on the tab holds the other apps, `shown: 'harness'`, built without `filter.shown()`; a tab pick holds the app through `AppFilter.hold`, turns the view to `apps`, answers `switched` and brings the app; Inter 20 in the pill; an instant flip; the switch's APPS emptying goes back to TABS; a tap on the selected cell does nothing; the pill shows on "No tabs yet." too; a ✓ on the machine view's APPS racing a flip to the tab is a tab pick.

## Decided here, where the spec was silent

- **`hold` answers a boolean:** false for an app with no agents, and then it changes nothing.
- **A notice's pick on the tab stays `ignored`.** The spec names `app.pick`. The session never sends a notice's pick on the tab (`appOf` is undefined there).
- **The tab's list is `rings.update` then `rings.apps()`, less Harness:** the same rows in the same order as the machine view's APPS. It is always in the tab's answer to a dial that says `appFilter`, empty with no other app or no registry: an empty frame is what tells the dial the last app went.
- **One registry read serves the view's rule and the list:** `viewOnTab` takes the agents the tab read listed.
- **`apps.switch` sits after `question.review` and before `settings`** in the welcome.
- **No pressed state on the pill.** The spec gives two colours a cell.
- **The switch's APPS draws the pill whenever it is open** (`s.view == APPS && !s.machine_view`), so TABS stays one tap away.
- **The measure is a script** in `cli/scripts`, as `benchmark-store-pages.ts` is, with `--src` for the base. It loads `cableHost.ts`, whose `config/env.ts` moves folders under the home at import: the script sets a throwaway home first.
- **The session spec's `appHost` gains `tabApps`** (off unless a test sets it): the session sends what the host gives, so its other tests need no list on the tab.
- **No docs change.** The devices row of `cli/AGENTS.md` already says what the devices keep ("which app the dial shows and, with a window open, whether it holds the window's tab or that app"); nothing is added to it.

---

### Task 1: The filter holds an app

**Layer:** devices service process. **Depends on:** none. **Effort:** `medium`.

**Red test:** `cli/src/cable/hosts/appFilter.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/appFilter.ts` (one method, right after `pick`; `pick` is not edited)
- Test: `cli/src/cable/hosts/appFilter.spec.ts`

**Interfaces:**
- Produces: `AppFilter.hold(app: string): boolean`. An app with no agents (`deps.counts().all`): false, nothing changes. Otherwise `pickedOnDial = true`, `byDefault = false`, `show(app, 'pick')`, true. A switch is told only when the shown app changes.

- [ ] **Step 1: Write the failing tests**, beside `a pick of the shown app holds nothing…`:
  - `hold of the shown app holds it and tells no switch`: `agents({ ghostty: 3 })`, `shown()` is `ghostty`, `front('vscode')`, `settle()`, `hold('ghostty')` is true, `agents({ ghostty: 3, vscode: 1 })`, `shown()` is still `ghostty`, `causes()` is `[]`.
  - `hold of another app is a switch by pick`: `agents({ ghostty: 3, vscode: 1 })`, `front('ghostty')`, `settle()`, `hold('vscode')` is true, `shown()` is `vscode`, `causes()` is `['pick']`.
  - `hold of an app with no agents answers false and holds nothing`: `agents({ ghostty: 3 })`, `shown()`, `front('vscode')`, `settle()`, `hold('cursor')` is false, `agents({ ghostty: 3, vscode: 1 })`, `shown()` is `vscode`, `causes()` is `['front']`.
  - `a hold ends when another app settles in front`: `agents({ ghostty: 3, vscode: 1 })`, `shown()`, `hold('vscode')`, `front('ghostty')`, `settle()`, `shown()` is `ghostty`, `causes()` is `['pick', 'front']`.
  - In `agents not known yet`: `a hold of the default page stops it giving way`: `agents({ terminal: 3 }, {})`, `shown()` is `terminal`, `hold('terminal')` is true, `agents({ terminal: 3, ghostty: 5 }, { ghostty: 5 })`, `shown()` is `terminal`, `causes()` is `[]`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/appFilter.spec.ts`. Expected: FAIL (`filter.hold is not a function`).
- [ ] **Step 3: Implement.** The comment says why `pick` is not enough: it answers `same` for the shown app and holds nothing.
- [ ] **Step 4: Run** the step 2 command and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `dial: the app filter holds an app that is already shown`.

### Task 2: The tab's answer carries the other apps

**Layer:** devices service process, the dial's one-second tick. **Depends on:** none. **Effort:** `high` (hot path).

**Red test:** `cli/src/cable/cableHost.spec.ts`.

**Files:**
- Modify: `cli/src/cable/cableHost.ts` (`listAgentSnapshot`'s tab path, `viewOnTab`, one new private method beside `appList`, the comment above `listAgentSnapshot`)
- Test: `cli/src/cable/cableHost.spec.ts`

**Interfaces:**
- Produces: for `opts.apps` while `view === 'tabs'`, `listAgentSnapshot` answers `{ agents, tab, total, apps: { shown: 'harness', apps: AppEntry[] } }`. Without `opts.apps`, or with no window, the answer is as today (no `apps` key).
- Approach: `private tabApps(listed: HostAgent[]): AppList` runs `this.rings.update(listed, this.ranks)` and maps `this.rings.apps()` less `harness`, cut to `APP_LIMIT`, as `appList` maps its rows. `viewOnTab` takes the same `listed`, read once at the top of the tab read. A read that turns the view inside itself (the tab to a ring, or a ring left as Harness to the tab) may read once more.

- [ ] **Step 1: Write the failing tests.** In `the dial that shows one app at a time`:
  - Rewrite `with a window: the tab's list exactly as before, no apps, and a pick is ignored` as `with a window: the tab's list as before with the other apps, shown harness; a dial without appFilter gets none`. With `five()` and `sessions`, after `onTab(host, ['h2'])`:
    - `listAgentSnapshot({ apps: true })` strictly equals the `h2` row as today plus `apps: { shown: 'harness', apps: [{ id: 'ghostty', name: 'Ghostty', count: 3, waiting: 0 }, { id: 'vscode', name: 'VS Code', count: 2, waiting: 0 }] }`;
    - `listAgentSnapshot()` strictly equals today's answer;
    - `pickApp('harness')` and `pickApp('cursor')` are `ignored`. The `vscode` pick leaves this test (Task 3);
    - the test's end stays: the window closes, `ghostty` is shown again and `appSwitched` was never called.
  - `on the tab the list of apps switches no filter`: the agents of the app the filter shows (`ghostty`) end; the next tab read's `apps` is `{ shown: 'harness', apps: [{ id: 'vscode', name: 'VS Code', count: 2, waiting: 0 }] }`, `appSwitched` was never called and `holdsTab()` is true.
  - `the tab's apps count the agents that need the person`: `agent('v2', 'vscode', { state: 'needs-you' })` gives `{ id: 'vscode', name: 'VS Code', count: 2, waiting: 1 }`.
  - `no other app, or no registry: an empty list, shown harness`: `setup([], { sessions })` on the tab, and a host with no `setRegistry` on the tab, each answer `apps: { shown: 'harness', apps: [] }`.
  - `eighteen other apps: the tab's apps are the first sixteen`: one agent in each of `APP_IDS` but `harness` (18 ids); the rows' ids equal the first 16 of that list.
  - In `the view while a window is open`:
    - Rewrite `with %s settled in front, a tab read does not read the registry` as `… a tab read reads the registry once`: add the row `['cursor (another app, no agents)', 'cursor']`; after three tab reads `list` was called `before + 3` times.
    - `a read that finds the shown app left as Harness answers the tab`: the expected answer gains `apps: { shown: 'harness', apps: [] }`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableHost.spec.ts`. Expected: FAIL in exactly these tests (no `apps` key; `list` called 0 times a read).
- [ ] **Step 3: Implement.** The comment on `tabApps` says why it never asks `filter.shown()` (it can switch the filter and push every dial). The comment on `viewOnTab` no longer says a tab read costs no registry read.
- [ ] **Step 4: Run** `npx vitest run src/cable src/services/devices.spec.ts && npm run typecheck`. Expected: PASS. The two tab-pick tests Task 3 rewrites are untouched here and still pass.
- [ ] **Step 5: Commit** `dial: the tab's list carries the other apps for a dial that says appFilter`.

### Task 3: A pick on the tab

**Layer:** devices service process. **Depends on:** 1, 2. **Effort:** `high`.

**Red test:** `cli/src/cable/cableHost.spec.ts`.

**Files:**
- Modify: `cli/src/cable/cableHost.ts` (`answerPick`'s tab branch, the comment on `pickApp`; `pickApp`'s own lines already bring a `switched` app)
- Test: `cli/src/cable/cableHost.spec.ts`

**Interfaces:**
- Consumes: `AppFilter.hold(app): boolean` (Task 1).
- Produces: on the tab, `pickApp(app)` with cause `pick`, `app !== 'harness'` and `filter.hold(app)` true: `pickedOver` is cleared, the view is set to `apps` with cause `pick`, the answer is `switched`. Anything else on the tab is `ignored` and changes nothing.

- [ ] **Step 1: Write the failing tests**, in `the view while a window is open`:
  - Rewrite `with a window, a pick on the tab is ignored and brings nothing; …` as `a pick of another app brings it, on the tab and on an app's ring`: on the tab `pickApp('ghostty')` is `switched` and `told` is `['view tabs window', 'view apps pick', 'brought ghostty']`; its second half stays.
  - Rewrite `a pick of another app works on an app's ring and is ignored on the tab` as `… and on the tab`: the tab pick of `ghostty` is `switched` and `appSwitched` was called with `[['pick'], ['pick']]`.
  - `a tab pick holds the app, turns the view to apps and brings it; Harness in front with known agents does not turn it back`: `setup(five(), { sessions, ...over })`, a read, `settle(host, 'harness')`, `onTab(host, ['h1'])`, `told.length = 0`. Then `pickApp('vscode')` is `switched` and `told` is `['switched pick', 'view apps pick', 'brought vscode']`. Two more reads each match `{ tab: '', view: 'machine', apps: { shown: 'vscode' } }`, list the apps `['harness', 'ghostty', 'vscode']` and the agents `['v1', 'v2']`. `told` did not grow and `holdsTab()` is false.
  - `a tab pick of the app the filter already shows holds it too`: `sessions: () => live` with `live` empty; a read (`ghostty` shown by default); `settle(host, 'harness')`; `live = sessions()`; `onTab(host, ['h1'])`; `told.length = 0`. Then `pickApp('ghostty')` is `switched`, `told` is `['view apps pick', 'brought ghostty']`, two more reads match `{ view: 'machine', apps: { shown: 'ghostty' } }` and `told` did not grow. (With `filter.pick` in place of `hold` the first of those reads feeds Harness's agents and turns the view back to the tab.)
  - `Harness, an app with no agents and a notice's pick stay ignored on the tab`: `pickApp('harness')`, `pickApp('cursor')` and `pickApp('vscode', 'notice')` are `ignored`; `told` is `[]`; `appPicked` was called twice; `holdsTab()` is true.
  - `a tab pick of the app Harness was picked over ends that hold`: `onGhosttyRing`, `pickApp('harness')` is `tabs`, `pickApp('ghostty')` is `switched`; Ghostty's agents end and a read gives `tabs empty`; a Ghostty agent comes back and a read gives `apps front`. `views` is `['apps window', 'tabs pick', 'apps pick', 'tabs empty', 'apps front']`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableHost.spec.ts`. Expected: FAIL (`expected 'ignored' to be 'switched'`).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/cable src/services/devices.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `dial: a pick of another app on the window's tab holds it and turns the dial to its ring`.

### Task 4: The welcome says `apps.switch`

**Layer:** devices service process. **Depends on:** none. **Effort:** `medium`.

**Red test:** `cli/src/cable/cableSession.spec.ts`.

**Files:**
- Modify: `cli/src/cable/cableSession.ts` (one line of the welcome's `features`, after `question.review`'s)
- Test: `cli/src/cable/cableSession.spec.ts` (`appHost` and `the app filter`)

**Interfaces:**
- Produces: `features` holds `'apps.switch'` when `this.appFilter && this.host.pickApp`, between `question.review` and `settings`.

- [ ] **Step 1: Write the tests**, in `the app filter`. The first two fail; the last two pass before the change and pin what the session already does with a list on the tab:
  - `the welcome lists apps.switch for a dial that says appFilter and a host that picks`: `greeted(appHost().host)` gives `['voice.draft', 'agents.refresh', 'apps.switch', 'settings']`. Without `appFilter`, and with `appHost({ pickApp: undefined })`, it gives `['voice.draft', 'agents.refresh', 'settings']`.
  - `the fullest round-dial welcome is eight names`: `appHost` with `form`, `visit`, `selectPassage` and `answerReviewed` gives `['voice.draft', 'agents.refresh', 'form', 'selection', 'visit', 'question.review', 'apps.switch', 'settings']`, and its length is at most 16.
  - `appHost` gains `state.tabApps` (false): when set, its tab answer to `opts.apps` carries `apps: { shown: 'harness', apps: list().apps }`. Rewrite `with a window no apps frame is sent` as `with a window the tab's apps go before the tab's list, and a count change alone sends apps` with `state.window = state.tabApps = true`: the list frames are `['apps', 'agents.begin', 'agent', 'agent', 'agents.end']`, the first equals `{ t: 'apps', shown: 'harness', apps: list().apps }`; VS Code down to one agent sends that one `apps` frame and no list; the next sync sends nothing.
  - `app.pick on the tab that the host answers switched is sent apps and that app's ring at once`: `pickApp` sets `state.appView = true` and `state.shown = app` and answers `switched`; after `app.pick` of `vscode` the list frames are `['apps', 'agents.begin', 'agent', 'agent', 'agents.end']`, the first shows `vscode` and the last is `{ t: 'agents.end', total: 2, tab: '', view: 'machine' }`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableSession.spec.ts`. Expected: the two welcome tests FAIL (no `apps.switch`).
- [ ] **Step 3: Implement.** The comment says the dial shows its switch only when told, so a list kept from an earlier machine view is never a dead control.
- [ ] **Step 4: Run** the step 2 command, `npx vitest run src/cable/cableFleet.spec.ts` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `dial: the welcome says apps.switch to a dial that says appFilter`.

### Task 5: The tab read's measure

**Layer:** a script, no process of the daemon. **Depends on:** none. **Effort:** `medium`.

**Red test:** none: it changes no behavior. One commit.

**Files:**
- Create: `cli/scripts/benchmark-dial-tab-read.ts`

**Interfaces:**
- Produces: `node --import tsx scripts/benchmark-dial-tab-read.ts [--src <the cli/src of a tree>] [output.json]`, run from `cli/`. It prints, and writes to `output.json` when given: `{ node, platform, arch, cases: [{ agents, apps, reads, medianUs, maxUs, registryReadsPerRead, appsInAnswer }] }`, one case for 0 agents and one for 50 across 5 apps (`ghostty`, `vscode`, `orca`, `cursor`, `iterm`).

- [ ] **Step 1: Write the script**, in the shape of `benchmark-store-pages.ts` (`--src`, a `load` that imports from that tree):
  - Before any module of the tree loads: a folder from `mkdtempSync`, set as `HOME` and `USERPROFILE`, with `ADAPTER_DATA_DIR`, `ADAPTER_RUNTIME_DIR` and `HARNESS_AUTH_DIR` inside it; `HARNESS_ENV_FILE` and `DOTENV_CONFIG_PATH` deleted. The folder is removed at the end. The script names no path under a home.
  - A `DaemonCableHost` with no sessions and an `appTimer` that runs its callback at once (the settle needs no wait); a `HostRegistry` of `host.harness` and one source whose `list` counts its calls; one read with no window; `front('harness')`; a window on an empty tab (`setSwarms`, `setDesk([])`); it throws unless `holdsTab()`.
  - 500 reads to warm up, then 21 rounds of 500 `listAgentSnapshot({ apps: true })`, each round timed with `performance.now()`. `medianUs` and `maxUs` are over the rounds, a read; `registryReadsPerRead` is the `list` calls over the reads; `appsInAnswer` is the last answer's `apps` row count, or null.
- [ ] **Step 2: Run** `cd cli && node --import tsx scripts/benchmark-dial-tab-read.ts`. Expected: two cases in well under 5 s. Before Task 2 is in: `registryReadsPerRead` 0 and `appsInAnswer` null; after: 1, and 0 and 5 rows. Its only folder is the one it made and removed.
- [ ] **Step 3: Commit** `dial: a script that measures the tab read`.

### Task 6: End to end

**Layer:** test: the real daemon, a fake dial, a fake `open`. **Depends on:** 2, 3, 4. **Effort:** `high`.

**Red test:** none: it changes no behavior (the end-to-end test of Tasks 2 to 4). One commit.

**Files:**
- Modify: `cli/e2e/dialAppFilter.e2e.ts` (and its header comment's list)

- [ ] **Step 1: Write the cases.**
  - Rewrite `a window opens: the tab's list and no apps; it closes: apps again` as `a window opens: the tab's list under the other apps, shown harness; it closes: the shown app's ring again`: the push that brings the tab holds one `apps` frame before `agents.begin`, with `shown: 'harness'` and counts `{ ghostty: 1, vscode: 1 }`.
  - In `with a window open`, new: `on the tab the dial is told apps.switch and the other apps; app.pick of Ghostty sends its ring, holds with Harness in front, and brings it`:
    - `onTheTab()`; the dial's `welcome` lists `apps.switch`;
    - `run.front('ai.autonomous.harness')`, then `settleWindowPassed`;
    - the last `apps` frame has `shown: 'harness'`, no row with the id `harness`, and the row `{ id: 'ghostty', name: 'Ghostty', count: 2, waiting: 0 }`;
    - `dial.send({ t: 'app.pick', app: 'ghostty' })`; `shows(dial, 'ghostty', ghostty, since)`; the list's end matches `{ tab: '', view: 'machine' }`;
    - `views(d)` ends with `apps · pick`;
    - on macOS (`process.platform === 'darwin'`, as the file's other bring checks): `d.opens()` holds `['-b', GHOSTTY_BUNDLE]` exactly once and the log has `[device] app filter: bring · ok`;
    - past another `settleWindowPassed`: every list since is a machine list and `views(d)` still ends with `apps · pick`.
  - In `a pick of Harness in APPS returns the dial to the tab, and an older dial beside it kept the tab throughout`: the older dial's `welcome` does not list `apps.switch` (its `apps` check is there already).
- [ ] **Step 2: Run** `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/dialAppFilter.e2e.ts -t "on the tab the dial is told|a window opens|a pick of Harness in APPS"`. Expected: the three selected tests pass on this Mac, the `open -b` lines among them.
- [ ] **Step 3: Commit** `dial: end to end, a pick from the window's tab`.

### Task 7: Firmware: the feature bit

**Layer:** firmware, the cable client. **Depends on:** none. **Effort:** `medium`.

**Red test:** `devices/harness-device/firmware/test/test_cable_features.c`.

**Files:**
- Modify: `devices/harness-device/firmware/main/cable_features.h`, `main/cable_features.c`
- Test: `devices/harness-device/firmware/test/test_cable_features.c`

**Interfaces:**
- Produces: `CABLE_FEATURE_APPS_SWITCH = 1u << 7`, set by `cable_features_parse` for the name `apps.switch`.

- [ ] **Step 1: Write the failing checks** in `main`:
  - `check("{\"features\":[\"apps.switch\"]}", CABLE_FEATURE_APPS_SWITCH);`
  - `check("{\"features\":[\"Apps.switch\",\"apps.Switch\",\"apps\",\"switch\",\"apps.switch.2\"]}", 0);`
  - the daemon's fullest round-dial welcome, `["voice.draft","agents.refresh","form","selection","visit","question.review","apps.switch","settings"]`, parses to all eight bits (`255u`);
  - the new bit is none of the other seven: `assert(!(CABLE_FEATURE_APPS_SWITCH & (CABLE_FEATURE_SETTINGS | 63u)));`
- [ ] **Step 2: Run**, from `devices/harness-device/firmware` (the line `run.sh` uses):
  ```bash
  IDF="${IDF:-$HOME/esp/esp-idf-5.5.4}"; out="$(mktemp -d)" && cc -std=c11 -Wall -Wextra -Werror -Wno-deprecated-declarations -O1 -g -fsanitize=undefined,bounds \
    -I main -I "$IDF/components/json/cJSON" -o "$out/test_cable_features" \
    test/test_cable_features.c main/cable_features.c "$IDF/components/json/cJSON/cJSON.c" && "$out/test_cable_features"
  ```
  Expected: FAIL to compile (`CABLE_FEATURE_APPS_SWITCH` undeclared).
- [ ] **Step 3: Implement.** The header's comment says what the bit tells the dial: the daemon lists the other apps on the window's tab and takes a pick there.
- [ ] **Step 4: Run** the step 2 command. Expected: `host features: PASS (…)`.
- [ ] **Step 5: Commit** `dial firmware: the welcome's apps.switch`.

### Task 8: Firmware: the pill, its taps and the switch's APPS

**Layer:** firmware, the UI. **Depends on:** 7. **Effort:** `high`.

**Red test:** `devices/harness-device/firmware/test/test_touch_ui.py`.

**Files:**
- Modify: `devices/harness-device/firmware/main/ui/habitat/ui_habitat.c`
- Test: `devices/harness-device/firmware/test/test_touch_ui.py`

**Interfaces:**
- Consumes: `CABLE_FEATURE_APPS_SWITCH` (Task 7).
- Produces, in `ui_habitat.c`:
  - `A_SWITCH_TABS, A_SWITCH_APPS` in the action enum, after `A_APP, A_APP_DONE`.
  - `static bool apps_switch(void)`: `cable_client_supports(CABLE_FEATURE_APPS_SWITCH) && !s.machine_view && s.app_count > 0`. And `static bool apps_from_switch(void)`: `s.view == APPS && !s.machine_view`. Both right after `hold_picks_app`.
  - `static void focus_switch(ht_scene_t *f, bool apps)`, right after `focus_header`: the pill of "Global Constraints" and its two hits; `apps` says the APPS cell is the selected one.
  - `render_focus_tabs` draws `focus_switch(f, false)` when `apps_switch()`, else today's title, before its "No tabs yet." return. `render_apps` draws `focus_switch(f, true)` when `apps_from_switch()`, else today's title.
  - Dispatch, right after the `A_APP_DONE` case and before `A_MACHINE` (the test lifts that span): `A_SWITCH_APPS` calls `apps_open()` when `s.view == TABS && apps_switch()`; `A_SWITCH_TABS` calls `tabs_open()` when `apps_from_switch()`.
  - `ui_apps_replace`: an empty list closes the switch's APPS with `tabs_open()`, the machine view's with `view(HOME)` as today.
  - `ui_land_after_reload`: the switch's APPS stays, as TABS does.
  - Not edited: `ui_fleet_set_view`, `ui_apps_forget`, `app_pick`, `hold_open`, the touch handler.

- [ ] **Step 1: Write the failing checks.** In the test's harness: `'apps_switch', 'apps_from_switch'` after `'hold_picks_app'` in the first list of names; `function('focus_switch')` after `function('focus_header')`; the fake `dispatch` sends `A_SWITCH_TABS` and `A_SWITCH_APPS` to `workspace_action`. `host_features` stays 31 in `reset()`. A new `apps_switch_checks(dir)`, called after `app_picker_checks(dir)`, with `switch_setup(n)`: `workspace_setup()`, the Focus character, `fake_ms = 1000`, `host_features |= CABLE_FEATURE_APPS_SWITCH`, `ui_apps_replace(picker_rows, n, "harness")`. It ends with its own `PASS` line. Its cases:
  - `TABS with the pill`: `switch_setup(3)`, `hold_at(233, 230)`. `s.view == TABS` on the desktop's tab (index 1), nothing sent. The two boxes, the eight letter runs, their colours and places, and the two hits are those of "Global Constraints", TABS selected. The scene has six runs more than the same screen with the feature off. `FOCUS_PAGE("tabs-switch")`.
  - `tap APPS`: a tap at `(275, 76)`. `s.view == APPS`, `!s.machine_view`, page 0 (`Ghostty`, `3 agents`), `!app_picks`. APPS is the selected cell. 31 runs, the same while the pages are dragged (the loop `app_picker_checks` has). `FOCUS_PAGE("apps-switch")`.
  - `swipe, ✓`: `picker_swipe(300, 200)` gives page 1 and no pick; a tap at `(233, 420)` sends one pick of `vscode`, `s.view == HOME`, `s.app_landing` is `vscode`. A tap on a page (`(233, 233)`) sends one pick of that page.
  - `tap TABS`: from the switch's APPS a tap at `(191, 76)`: `s.view == TABS`, index 1, no pick, no tab switch, TABS selected.
  - `the selected cell, a swipe and a hold do nothing`: on TABS a tap at `(191, 76)`, a drag from `(275, 76)` to `(175, 76)` and a 700 ms hold at `(275, 76)`; on the switch's APPS a tap at `(275, 76)` and the same drag. The view, its page, `app_picks` and `tab_switches` are unchanged.
  - `each hold opens TABS`: from the switch's APPS: TABS, Done, then `hold_at(233, 230)` gives TABS with TABS selected.
  - `no pill`: (a) the feature off with apps listed; (b) the feature on and `ui_apps_replace(picker_rows, 0, "harness")`; (c) the feature on and no `apps` frame; (d) the feature on in the machine view with no apps. Each: a hold opens TABS, the title is four runs `TABS` in `#4c4c4c` at `y 62`, no box 36 px high, no hit for either switch action, and a tap at `(275, 76)` leaves TABS. For (a): the face's runs are the same before and after the `apps` frame.
  - `No tabs yet. with the pill`: no tabs, the feature and three apps: a hold shows `No tabs yet.` under the pill, and a tap on APPS opens APPS. `FOCUS_PAGE("tabs-switch-empty")`.
  - `the list emptying`: on the switch's APPS `ui_apps_replace(picker_rows, 0, "harness")` gives `s.view == TABS` on index 1 with the plain title.
  - `the view flipping`: on the switch's APPS `ui_fleet_set_view(true)` gives `s.view == HOME`.
  - `the machine view's hold`: `picker_setup(3, "ghostty")` with the feature on: APPS, the title four runs `APPS` in `#4c4c4c`, no pill, no switch hit, 25 runs.
  - `a tab switch still loading`: on TABS a swipe to `tab-2` (`tab_switches == 1`, `s.loading`), a tap on APPS, then the switch lands as the "Host echoes" case lands one (`ui_swarms_replace`, `ht_workspace_refresh`, `ui_workspace_applied`, `ui_land_after_reload`): `!s.loading` and `s.view == APPS`.
- [ ] **Step 2: Run** `python3 devices/harness-device/firmware/test/test_touch_ui.py`. Expected: FAIL (`AssertionError: apps_switch`: the function is not in the source).
- [ ] **Step 3: Implement.** The comment on `focus_switch` gives the pill's numbers and why the letters keep Inter 20 (the dial has no Inter 17; a font for one word is flash). The comment on `apps_open` says it opens on the first page from the switch, where the shown app is Harness and not listed.
- [ ] **Step 4: Run** `env -u IDF_PATH bash devices/harness-device/firmware/test/run.sh`. Expected: exit 0, with `touch UI: PASS` and the new line.
- [ ] **Step 5: Commit** `dial firmware: a TABS | APPS switch on the TABS screen`.

---

## The pull request's body

Written by the main session, not a task. It carries:

- **Platforms:** the daemon on macOS, Linux and Windows (the bring is macOS only); the round dial's firmware. Harness Pro, Desktop and the core are unchanged.
- **Evidence:** each task's red then green; the two tables of numbers (Verification 3); the pill's pictures beside the mockup (Verification 1); the end-to-end run's link; the output of `python3 scripts/local-checks.py --run`.
- **Not in this pull request:** a firmware release, a flash, the check on a real dial (Verification 5).

## Verification

**Never touched:** Diego's everyday daemon (port 18473), his dial, `~/.harness`, `~/.claude`, `~/.codex`, any backend, production. No firmware is built for a board, flashed or released.

**Temporary workflow:** none. The one long check is the CLI's end-to-end suite, which has a workflow of the repo's own that starts by hand on a branch (`.github/workflows/cli-e2e.yml`); it takes every `e2e/**/*.e2e.ts`. The firmware's Python host tests run in PR CI by themselves; its one C test here takes seconds and runs locally (Follow-ups has the proposal).

**Turns.** The tester asks the orchestrator, who asks the PM, before the one hand-started GitHub run (check 2).

**1. Local gates**, on this Mac at the final head, recorded in the pull request:
- `cd cli && npm run typecheck`: no error.
- `cd cli && npx vitest run src/cable/cableHost.spec.ts src/cable/cableSession.spec.ts src/cable/hosts/appFilter.spec.ts src/cable/cableFleet.spec.ts src/services/devices.spec.ts src/architecture.spec.ts`: every test passes. The last three prove what already used the host and the session, and the core's boundary.
- `git diff --stat "$(git merge-base HEAD origin/main)" -- cli/src/core cli/src/services cli/src/architecture.coreFiles.txt devices/harness-pro devices/harness-device/firmware/version.txt` prints nothing.
- `env -u IDF_PATH bash devices/harness-device/firmware/test/run.sh`: exit 0, about 2.5 minutes, with `touch UI: PASS` and the switch's own line.
- Task 7's compile-and-run line with `$IDF`: `host features: PASS`. PR CI does not run this test.
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit. These paths select no check: `--list` over this plan's files printed `{}` on 2026-11-18. No coverage gate covers `cli/src/cable/`: `test:core` is `src/core` and `src/services`, `test:harnessd` is `src/harnessd`, and the serial check is `cli/src/cable/serial*.ts` only.
- The pill's pictures: `SCRATCH=$(mktemp -d); HABITAT_PREVIEW_DIR="$SCRATCH/preview" python3 devices/harness-device/firmware/test/test_touch_ui.py` writes `tabs-switch.ppm`, `apps-switch.ppm` and `tabs-switch-empty.ppm` (the production renderer, on the host), each with a `.json` of its runs and hits. `sips -s format png <file>.ppm --out <file>.png` makes the pull request's pictures. A person compares them with the mockup's variant "2 · Pill" (`devices/harness-device/mockup/tabs-apps-options.html` in the main checkout, gitignored, read only): the same pill at the title's place, the selected cell filled, the carousel and Done unchanged.
- Not needed: `npm run test:core`, `test:harnessd` and the other coverage gates, the serial and PTY specs, `make desktop-test`, `cargo test` in `device-app`.

**2. The real daemon, a fake dial, a fake front app and a fake `open`**
- Build: nothing by hand. The suite starts the daemon from one bundle with `E2E_BUNDLE=1`.
- Isolation, the suite's own (`cli/e2e/harness/daemon.ts`, `cli/AGENTS.md` rules 5 and 6): a throwaway home and data folder, a private port and tmux server, fake Claude Code engines started outside Harness, a fake dial on a file the daemon is pointed at, a fake `open` that notes each run and brings nothing forward, and the app in front written on the stdin of the real `harness hardware watch --json` under the throwaway daemon's environment. No account, no sign-in.
- On this Mac, for the part only a Mac runs (the one `open -b`): Task 6's step 2 command, at the final head. A person sees the three selected tests pass: the welcome lists `apps.switch`; on the tab the dial is sent `apps` with `shown: 'harness'` and no Harness row; after `app.pick` of Ghostty it is sent Ghostty's ring as a machine list, the fake `open` ran once with `-b com.mitchellh.ghostty`, the log has `view apps · pick` and `bring · ok`, and no later list is the tab's.
- On GitHub, by hand, once on the final head, after the PM's go: Actions → CLI end to end → Run workflow, branch `feat/dial-tabs-apps-switch`, `agent_browser_podman` not ticked. Its shards are Linux: the `open -b` lines are not run there. Every shard passes. The link goes in the pull request.
- Skipped or not run: report it as not verified, never as passed.

**3. The tab read's numbers** (the spec's Hot path; `cli/AGENTS.md` rule 8)
- Where: this Mac. No daemon, port, account or network; the script's home is a throwaway folder.
- Run, from the repository root, at the final head:
  ```bash
  SCRATCH=$(mktemp -d)
  BASE=$(git merge-base HEAD origin/main)
  mkdir "$SCRATCH/base" && git archive "$BASE" cli/src cli/package.json | tar -x -C "$SCRATCH/base"
  ln -s "$PWD/cli/node_modules" "$SCRATCH/base/cli/node_modules"
  (cd cli && node --import tsx scripts/benchmark-dial-tab-read.ts --src "$SCRATCH/base/cli/src" "$SCRATCH/before.json")
  (cd cli && node --import tsx scripts/benchmark-dial-tab-read.ts "$SCRATCH/after.json")
  ```
- A person sees two tables, each with 0 and 50 agents. Before: `registryReadsPerRead` 0, no `apps`. After: `registryReadsPerRead` exactly 1, and 0 and 5 rows. Both go in the pull request with the Node version.
- What planning measured with a throwaway copy of this change (Node 22.23.5): about 1 to 3 µs a read before; about 3 to 5 µs with 0 agents and 17 to 18 µs with 50 after. That is once a second for each attached dial that says `appFilter`. No number is a gate; a 50-agent median over 1 ms is reported to the main session as a finding.

**4. In PR CI, by itself:** `cli-typecheck` and `cli-tests` run Tasks 1 to 4's specs on Linux; a `cli/` change also runs `companions` and `pty-checks`; `firmware-checks` runs `test_touch_ui.py` with the other Python host tests; `process-checks` runs for the docs. Nothing is started by hand.

**5. On a real dial (needs Diego himself: his dial, his eye; after the merge, not in this pull request):** the spec leaves it out of this item. The PM asks Diego once a firmware release carries it. No agent builds for the board, flashes or releases.

**6. Against production:** none, and never.

## Follow-ups

Not built in this branch; each is a proposal for the maintainers.

- `firmware-checks` runs the Python host tests only. The C tests `run.sh` compiles (`test_cable_features.c` among them) run on nobody's machine but a developer's.
- On a Mac, `run.sh` with `IDF_PATH` set stops in `test_cable_models.py` at the base (`'snprintf' macro redefined` against the macOS SDK), so the tests after it never run there.
