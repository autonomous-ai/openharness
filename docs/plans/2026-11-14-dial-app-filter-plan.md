# The dial's app filter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use diegodev phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With no Harness window, the round dial shows the agents of one app at a time (Harness, Orca, Ghostty, VS Code, …). A hold on the face picks another app, and the dial follows the app the person brings to the front on the computer.

**Architecture:**
- In the devices process each agent gets an `app` (its outermost app). The cable host keeps one ring per app (`AppRings`, built on `DialRing`) and one `AppFilter` that says which app is shown. A dial that greets with `appFilter: "v1"` gets the shown app's ring and an `apps` frame, and sends `app.pick` back. An older dial keeps the single ring.
- The Harness Device app learns which app is in front from the OS and writes it on the stdin of the `harness hardware watch --json` child it already runs. The watch maps the raw name to an app id and sends `dial_front`. The core checks and bounds that frame and forwards it to the devices process, where the filter settles it for 1 s.
- The round firmware says `appFilter` in `hello`, holds the `apps` it is sent, draws the shown app's name on the face, and opens `APPS` (the TABS carousel) on a hold in the machine view.

**Tech Stack:** TypeScript daemon and CLI (Node, vitest, `cli/`), Rust and Tauri 2 (`device-app/`, objc2 on macOS, x11rb on Linux), ESP-IDF 5.5.4 C firmware with Python host tests.

**Spec:** `docs/specs/2026-11-14-dial-app-filter.md`. It stacks on the fixed ring (`docs/plans/2026-11-14-dial-swipe-order-design.md`, uncommitted on `fix/dial-swipe-order`) and on wave 1a (`docs/plans/2026-11-13-device-claude-orca-plan.md`, PR #4296).

## Layers

Every file this plan creates or changes, and the process it runs in (`cli/AGENTS.md`, master / core / services).

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/core/dialFront.ts` (new) | **Core** (`harnessd-core`). Checks, bounds and forwards one frame; keeps a rate counter and nothing else | A new line in `src/architecture.coreFiles.txt`; 100% per file (`npm run test:core`). Decided: the PM, answer 1 |
| `cli/src/core/api.ts`, `cli/src/core/devicesLink.ts` | **Core** | Already listed; 100% per file |
| `cli/src/localWsServer.ts` | **Core** (listed in `coreFiles.txt`, outside the 100% gate): one frame block and one feature name, no logic | `localWsServer.spec.ts` |
| `cli/src/core/main.ts` | **Core**, wiring only | The end-to-end suite |
| `cli/src/architecture.coreFiles.txt` | The list of what the **core** loads: one new line | `architecture.spec.ts` |
| `cli/src/cable/hosts/types.ts`, `hostDetect.ts`, `select.ts`, `appFilter.ts` (new), `observed.ts`, `harness.ts` | **Devices service process** (`harnessd-devices`) | Their specs |
| `cli/src/cable/cableHost.ts`, `cli/src/cable/cableSession.ts` | **Devices service process** | Their specs |
| `cli/src/services/devices.ts`, `cli/src/services/devicesProcess.ts` | **Devices service process** | 100% per file (`npm run test:core`) |
| `cli/src/cable/hosts/frontApp.ts` (new), `cli/src/devices/client.ts` | **CLI only**: the `harness hardware watch` process. The table sits next to `hostDetect.ts` as the spec says, and only the CLI imports it | Their specs |
| `device-app/src-tauri/src/front.rs`, `front_macos.rs`, `front_x11.rs` (new), `cli.rs`, `watch.rs`, `runner.rs`, `lib.rs`, `main.rs`, `testing.rs`, `tests/fake-harness`, `Cargo.toml`, `Cargo.lock` | **Harness Device app** (its own process, thin over the CLI) | `cargo test --lib`: PR CI on Linux, by hand on a Mac |
| `devices/harness-device/firmware/main/cable_client.c`, `cable_client.h`, `ui/ui_screens.h`, `ui/habitat/ui_habitat.c` | **Firmware**, round dial (OTA key `harness-device`) | `make device-test`, every `firmware/test/test_*.py` |
| `devices/harness-device/firmware/test/test_touch_ui.py`, `test_cable_supertab.py`, `test_cable_identity.py`, `test_cable_outbound.py` | **Firmware** host tests | Themselves |
| `cli/e2e/dialAppFilter.e2e.ts`, `cli/e2e/harness/outsideAgent.ts` (new), `cli/e2e/harness/desk.ts`, `cli/e2e/deviceWithoutApp.e2e.ts` | Test: the real daemon, a fake dial, the real watch | `cli-e2e.yml` |
| `cli/e2e/dialAppFilterOnDial.e2e.ts` (new, opt-in) | Test rig: the isolated daemon on a real dial. It skips unless `ON_DIAL_PORT` is set | By hand, Verification check 4 |
| `.github/workflows/ci.yml` (`device-app-checks`), `scripts/tests/test_ci_plan.py`, `docs/validation-and-release.md` | PR CI: the X11 source, live under Xvfb | `process-checks` (`scripts/tests`) |
| `cli/AGENTS.md`, `device-app/AGENTS.md`, `docs/specs/2026-11-13-device-without-the-app.md` | Repo files, no process | none |

What this fixes, by layer:
- **The core never** learns which app is shown, keeps the app in front, or logs an app name. It lets through one of 16 fixed words (the 15 app ids, `claude` among them (Task 23), and `none`), at most 10 a second per connection, and only from a tool that asked to watch the dial.
- **The raw name** (a bundle id, an exe name) exists only in the Harness Device app and in the `harness hardware watch` process. The daemon is sent an app id.
- **Which app is shown, the rings and the settle timer** live in the devices process, in memory only.
- With `HARNESSD_SERVICES=none` (debugging) and on Harness OS the devices service runs inside the core's process, as every service does there. The file boundaries stay the same.

## Unmerged dependencies

No code task starts before both of these are on `main` (Task 1). The plan names files and functions as those branches leave them.

- **`fix/dial-swipe-order`** has a design and no code yet. `DialRing`, its `select(agents): { rows, total }` and "one per `CableHost` in `machineSnapshot`" are known **only from the design**. Every place below that uses them is marked **⚠ design-only**: the implementer reads the merged code at dispatch and uses its real names.
- **PR #4296** (`origin/feat/device-claude-orca`, head `9eed162bbb`, open). Names below from `cableHost.ts`, `cableSession.ts`, `observed.ts`, `services/devices.ts`, `core/api.ts`, `core/devicesLink.ts` and `core/main.ts` are read from that head and marked **⚠ #4296**: review can still change them. Line numbers are that head's (or `main` at `92aa7660f4` for files it does not touch) and will move.

## External gate: mockup approved

A mockup of the `APPS` picker and of the face's app line is made by the main session in the main checkout's `devices/harness-device/mockup/` and reviewed by Diego. It is not a task of this plan. **Approved by Diego, 2026-11-14:** `/Users/duynguyen/go/src/github.com/autonomous-ai/autonomous-harness/devices/harness-device/mockup/dial-app-filter/index.html` (gitignored; its "today" images are `test_touch_ui.py` renders). Tasks 17 and 18 draw exactly what it shows and wait only for their dependencies. The unknown app's page and face line read "Other" (the PM, answer 4).

## Global Constraints

- **Apps.** The fixed set is the host ids `hostDetect.ts` names: `harness`, `orca`, `herdr`, `rex`, `zellij`, `kitty`, `wezterm`, `iterm`, `terminal-app`, `ghostty`, `vscode`, `cursor`, `warp`, `terminal` (14, at most 16). An unknown app is `terminal`. An agent's `app` is its outermost app; `host` stays the nearest host, for caps and "See it in …".
- **Two names that must not meet** (the PM, answer 4).
  - **The unknown app** is the app id `terminal` (`UNKNOWN_APP`): an agent in a terminal the daemon does not know. In `apps` its `name` is **"Other"**. Apple's Terminal (`terminal-app`) stays "Terminal". Reason: `docs/naming-system.md` defines Terminal ("A shell for entering commands") and neither defines nor forbids Other, so two pages no longer share one name. `hostDisplayName('terminal')` stays "Terminal" for "See it in Terminal".
  - **No listed app in front** is the front value `none` (`FRONT_NONE`): Safari, Finder, an app with no name. **Renamed here:** the spec's first word for it was `other`; the app id keeps its name and the front value changed, because the front value was new everywhere and the app id is the one `detectHost` already gives. `none` is not an app id, never has agents, and is never shown. The words `other` and `Other` are no id and no front value: "Other" travels only as the `name` of the `terminal` entry in `apps`.
- **Rings.** One per app, at most 16 agents, the swipe-order rules inside each. A ring is dropped when its app has no agents. The Buddy filter and the wait for Swarm cards run first.
- **Shown app.** No "All". Default: the app in front if it has agents, else the app with the most agents; a tie is drawn once and held while the counts stay the same. The app in front is followed after it has stayed in front for 1 s. An app in front with no agents, and `none`, change nothing. A pick on the dial holds until another app settles in front. With a Harness window the dial is sent none of it and a pick is ignored; the filter still follows the app in front (the PM, answer 6), so the dial shows it when the window closes.
- **Wire.** `hello.appFilter: "v1"`. Host → dial `apps`: `{ shown, apps: [{ id, name, count, waiting }] }`, at most 16 entries, in a fixed order, in the machine view only, coalesced with the machine list's 1 s. Dial → host `app.pick`: `{ app }`. A dial without `appFilter` gets the single ring and no `apps`. An older daemon sends no `apps`, and the new firmware's hold then opens TABS.
- **Front.** The Harness Device app writes `{"front":"<bundle id or exe name>"}` on the watch's stdin, only on a change, cut to 128 characters. The watch sends `dial_front { app }` only to a daemon whose `connected.features` has `dial-front`. The core takes it only from a tool that asked for `watch: ['dial']`, with `app` in the fixed set or `none`, at most 10 a second per connection, and drops it with no devices process.
- **Privacy.** Which app is in front goes only from the Harness Device app to the devices process: never to the backend, the phone, the gateway, a file or a log. The log line is `app filter: switched` and never names an app. Measures carry a cause and no app name or agent id.
- **Memory only.** The pick, the rings and the app in front are never written to disk or to the dial's NVS.
- **Needs-you elsewhere (decision 7, A).** The bell and inbox count every agent on this computer. A notice opened from the inbox turns the dial to the agent and its app, and counts as a pick.
- **No polling.** The OS tells the app when the front changes: no timer, no osascript, no System Events, no Accessibility or Screen Recording permission.
- **Platforms** (the PM, answer 2). The app in front is read on macOS and Linux X11. On Windows the dial filters by app and takes a pick, and follows nothing until the Windows source exists.
- **Out of scope (follow-ups):** Harness Desktop reporting the app in front; the Windows source of the app in front, with the wave that builds the Harness Device app for Windows; Cursor outside macOS (its agents say `TERM_PROGRAM=vscode` there); Wayland; a setting to turn the filter off; Harness Pro (never edit `devices/harness-pro`).
- **Repo rules.** Tests never touch the developer's real `~/.claude`, `~/.codex`, daemon (port 18473), tmux or dial. No fixed sleeps: fake timers, or a wait on a condition. Firmware dev builds use `-DPROJECT_VER=0.1.0-dev`; flash only by the repo procedure (quit Harness, flag file, `harness stop`, chip check).

## Review Focus

1. **An agent whose app changes.** The open scan lists a session as `terminal` until its first hook says where it runs, and a session can be resumed in another terminal. It must leave its old ring, join the new app's at the end, and the counts must follow. Covered in Task 3 (`an agent whose app changes leaves its ring and joins the other at the end`).
2. **A burst of front changes** (Cmd-Tab held down, a daemon flooded by a broken tool). One timer, one settle, a bounded rate. Covered in Task 4 (`fifty changes inside a second leave one timer and settle once`) and Task 8 (`the 11th frame within a second is dropped; another connection's is kept`).
3. **The list moving under the finger.** The picked app's last agent ends while the picker is open. Covered in Task 6 (`a pick of an app with no agents sends apps again and no ring`) and Task 18 (`a push while open keeps the app by id`).
4. **Two dials on one computer, one old and one new.** Each gets its own list, and a pick on one moves the other new dial. Covered in Task 5 (`asked without apps it is the single ring; asked with, the shown app's`) and Task 6 (`a dial without appFilter is sent no apps frame`).
5. **A watch that starts after the app is already in front**, or a daemon that restarts. Without the first value the dial follows nothing until the next app switch. Covered in Task 12 (`a front line that arrives before connected is sent once after it`) and Task 13 (`a new watch is told the app in front once`).

---

### Task 1: Rebase on `main` once both dependencies have merged

**Layer:** none. **Depends on:** `fix/dial-swipe-order` and PR #4296 merged to `main` (external). **Effort:** `medium`. **Red test:** none: no behavior (workflow).

**Files:** none of its own.

- [ ] **Step 1:** Confirm both are on `main` (`gh pr view 4296 --json state`; the swipe-order pull request the main session names). If either is open, stop and report.
- [ ] **Step 2:** `git rebase origin/main` on `feat/dial-app-filter`.
- [ ] **Step 3:** Read the merged `cli/src/cable/hosts/select.ts` and `cli/src/cable/cableHost.ts`. Report the real names of everything this plan marks **⚠ design-only** and **⚠ #4296**, so the main session can correct the tasks before they are dispatched.
- [ ] **Step 4:** `cd cli && npm run typecheck && npx vitest run src/cable src/services/devices.spec.ts`. Expected: PASS, as on `main`.

### Task 2: Each agent's app

**Layer:** devices service process. **Depends on:** Task 1. **Effort:** `high`.

**Files:**
- Modify: `cli/src/cable/hosts/types.ts`, `cli/src/cable/hosts/hostDetect.ts`, `cli/src/cable/hosts/observed.ts` (the new entry's agent, and `ingest` beside `a.host = detectHost(…)` :220 ⚠ #4296), `cli/src/cable/hosts/harness.ts` (`list()`)
- Test: `cli/src/cable/hosts/hostDetect.spec.ts`, `observed.spec.ts`, `harness.spec.ts`
- Modify, one word each (the `HostAgent` literals; list them again at dispatch with `git grep -l unseenDone cli/src cli/e2e`): `cli/src/cable/hosts/select.spec.ts`, `registry.spec.ts`, `cli/src/cable/cableHost.spec.ts`, `cli/src/cable/cableSession.spec.ts`

**Interfaces:**
- Produces, in `types.ts`:
  - `HostAgent.app: string` — the outermost app, an id of `APP_IDS`.
  - `interface AppEntry { id: string; name: string; count: number; waiting: number }`
  - `interface AppList { shown: string; apps: AppEntry[] }` — `shown` is `''` with no agents.
  - `type AppPick = 'switched' | 'same' | 'ignored'`
  - `type SwitchCause = 'front' | 'pick' | 'empty' | 'notice'`
- Produces, in `hostDetect.ts`:
  - `const APP_IDS: readonly string[]` — the keys of `NAMES`, in its order.
  - `detectApp(hints: Record<string, string>): string`
  - `const UNKNOWN_APP = 'terminal'` — the app of an agent whose app is not in the set.
  - `appDisplayName(id: string): string` — "Other" for `UNKNOWN_APP`, else `hostDisplayName(id)`. `hostDisplayName` is unchanged.
- Rule of `detectApp`, in this order:
  1. `__CFBundleIdentifier` is in the bundle table → that id. Cursor's bundle id decides before `TERM_PROGRAM=vscode`.
  2. `TERM_PROGRAM` is in the program table → that id.
  3. Either of the two is set and unknown → `UNKNOWN_APP`.
  4. Neither is set and `KITTY_WINDOW_ID` is set → `kitty`. kitty sets no `TERM_PROGRAM`, so off macOS its own variable is its only name.
  5. Else → `detectHost(hints)`.
  `ZELLIJ`, `HERDR_PANE_ID` and `REX_BLOCK` are never read before step 5.
- The two tables (the PM, answer 3). The first seven bundle ids and five programs are the ones `detectHost` reads today; `detectHost` itself does not change.
  - Bundle ids: `com.stablyai.orca` → `orca`, `com.todesktop.230313mzl4w4u92` → `cursor`, `com.googlecode.iterm2` → `iterm`, `com.apple.Terminal` → `terminal-app`, `com.mitchellh.ghostty` → `ghostty`, `com.microsoft.VSCode` → `vscode`, `dev.warp.Warp-Stable` → `warp`, and three new rows:
    - `net.kovidgoyal.kitty` → `kitty`. Source: kitty's `setup.py`, `CFBundleIdentifier=f'net.kovidgoyal.{appname}'`, with `appname: str = 'kitty'` in `kitty/constants.py` (<https://github.com/kovidgoyal/kitty/blob/master/setup.py>, <https://github.com/kovidgoyal/kitty/blob/master/kitty/constants.py>). Its quick-access bundle, `net.kovidgoyal.kitty-quick-access`, is not a row.
    - `com.github.wez.wezterm` → `wezterm`. Source: WezTerm's `Info.plist` (<https://github.com/wezterm/wezterm/blob/main/assets/macos/WezTerm.app/Contents/Info.plist>).
    - `ai.autonomous.harness` → `harness`. Source: `/Applications/Harness.app`'s `CFBundleIdentifier`, read by the main session on Diego's Mac, 2026-11-14.
  - `TERM_PROGRAM`: `iTerm.app` → `iterm`, `Apple_Terminal` → `terminal-app`, `ghostty` → `ghostty`, `vscode` → `vscode`, `WarpTerminal` → `warp`, and one new row:
    - `WezTerm` → `wezterm`. Source: `config/src/config.rs`, `cmd.env("TERM_PROGRAM", "WezTerm")` (<https://github.com/wezterm/wezterm/blob/main/config/src/config.rs>).
  - **kitty has no `TERM_PROGRAM` row: kitty does not set it.** Its documented variables are `KITTY_WINDOW_ID`, `KITTY_PID`, `TERM` (`xterm-kitty`) and the rest of <https://sw.kovidgoyal.net/kitty/glossary/#environment-variables>; `kitty/child.py` sets `TERM`, `COLORTERM`, `KITTY_PID`; a code search of `kovidgoyal/kitty` for `TERM_PROGRAM` finds nothing (all read 2026-11-14). Hence step 4.
- `ObservedSource`: a new entry has `app: UNKNOWN_APP`; every event sets `a.app = detectApp(e.hostHints)`. `HarnessSource.list()`: `app: 'harness'`.

- [ ] **Step 1: Write the failing tests.**
  - `hostDetect.spec.ts`, `detectApp`:
    - `zellij, herdr and rex inside Ghostty, iTerm2 and Terminal give the terminal` — nine rows: each of `ZELLIJ`, `HERDR_PANE_ID`, `REX_BLOCK` with each of `TERM_PROGRAM` `ghostty` / `iTerm.app` / `Apple_Terminal` → `ghostty` / `iterm` / `terminal-app`.
    - `the bundle id decides before TERM_PROGRAM: Cursor before VS Code`.
    - `an unknown bundle id or TERM_PROGRAM gives the unknown app` (`org.alacritty`; `TERM_PROGRAM: 'tmux'`; `net.kovidgoyal.kitty-quick-access`) → `terminal`.
    - `kitty and WezTerm by bundle id, WezTerm by TERM_PROGRAM, Harness Desktop by bundle id` (`net.kovidgoyal.kitty` → `kitty`; `com.github.wez.wezterm` → `wezterm`; `TERM_PROGRAM: 'WezTerm'` → `wezterm`; `ai.autonomous.harness` → `harness`).
    - `zellij inside kitty is kitty, with and without a bundle id` (`{ ZELLIJ: '0', KITTY_WINDOW_ID: '1', __CFBundleIdentifier: 'net.kovidgoyal.kitty' }` and `{ ZELLIJ: '0', KITTY_WINDOW_ID: '1' }` → `kitty`).
    - `kitty's variable never decides against a bundle id or a TERM_PROGRAM` (`{ KITTY_WINDOW_ID: '1', TERM_PROGRAM: 'vscode' }` → `vscode`: VS Code started from a kitty shell).
    - `with neither set, the app is the host` (`{ ZELLIJ: '0' }` → `zellij`; `{}` → `terminal`; `{ ORCA_AGENT_SESSION_ID: 'x' }` → `orca`; `{ WEZTERM_PANE: '0' }` → `wezterm`).
    - `APP_IDS has 14 ids, at most 16, and every one has a display name`.
    - `the unknown app reads Other, Apple's Terminal reads Terminal, and every other app reads as its host` (`appDisplayName('terminal')` is `Other`; `appDisplayName('terminal-app')` is `Terminal`; `hostDisplayName('terminal')` is still `Terminal`; for the other twelve the two functions agree).
  - `observed.spec.ts`: `a session the open scan found is in terminal until its first hook says its app`; `a hook from zellij inside Ghostty gives host zellij and app ghostty`; `a session resumed in another terminal changes app`.
  - `harness.spec.ts`: `a Harness agent's app is harness`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts`. Expected: FAIL (`detectApp` missing, `app` undefined).
- [ ] **Step 3: Implement.** Add `app` to the other files' `HostAgent` literals so `npm run typecheck` passes.
- [ ] **Step 4: Run** the step 2 command and `cd cli && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `devices: each agent's outermost app, beside its nearest host`.

### Task 3: One ring per app

**Layer:** devices service process. **Depends on:** Task 2. **Effort:** `high`.

**Files:**
- Modify: `cli/src/cable/hosts/select.ts`
- Test: `cli/src/cable/hosts/select.spec.ts`

**Interfaces:**
- Consumes: `DialRing` and its `select(agents: HostAgent[]): { rows: HostAgent[]; total: number }` (**⚠ design-only**); `APP_IDS`, `HostAgent.app` (Task 2).
- Produces:
  - `class AppRings { update(agents: HostAgent[]): void; apps(): Array<{ id: string; count: number; waiting: number }>; counts(): ReadonlyMap<string, number>; ring(app: string): { rows: HostAgent[]; total: number } }`
- Rules:
  - `update` groups the agents by `app` and runs each app's own `DialRing` over that app's agents. An `app` outside `APP_IDS` counts as `terminal`, so the map never holds more than `APP_IDS.length` rings.
  - An app with no agents left loses its ring. If it comes back it starts a new one (swipe-order rule 7).
  - `apps()` keeps a fixed order: an app keeps its place from the moment it appears, a new one goes at the end, a gone one closes up. `count` is the app's agents; `waiting` is how many of them have `state === 'needs-you'`.
  - `ring(app)` is that app's rows and its agent count; `{ rows: [], total: 0 }` for an app with none.
  - No timers, no I/O.

- [ ] **Step 1: Write the failing tests:**
  - `one ring per app, each over its own agents only`.
  - `inside a ring the order is fixed: a state change moves nobody, a new agent goes to the end, an ended one closes up` (the swipe-order rules, on one app while another app's agents change).
  - `each ring holds at most 16; total is the app's count` (20 agents in one app, 3 in another).
  - `a ring is dropped when its app empties, and the app starts a new ring when it comes back` (the new ring is in the registry's order, not the old one).
  - `the apps keep their order: a new app at the end, a gone app closes up`.
  - `count and waiting follow the agents`.
  - `an agent whose app changes leaves its ring and joins the other at the end`.
  - `the map is bounded: 20 agents with 20 unknown app ids make one terminal ring`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/select.spec.ts`. Expected: FAIL (`AppRings` missing).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command. Expected: PASS, the swipe-order tests of `DialRing` untouched.
- [ ] **Step 5: Commit** `devices: one fixed ring per app`.

### Task 4: Which app is shown

**Layer:** devices service process. **Depends on:** Task 2 (the `AppPick` and `SwitchCause` types). **Effort:** `xhigh` (state every dial shares, a timer racing picks and counts).

**Files:**
- Create: `cli/src/cable/hosts/appFilter.ts`, `cli/src/cable/hosts/appFilter.spec.ts`

**Interfaces:**
- Produces:
  - `const FRONT_SETTLE_MS = 1_000`
  - `interface AppFilterDeps { after(ms: number, run: () => void): () => void; random(): number; counts(): ReadonlyMap<string, number>; switched(cause: SwitchCause): void }` — `after` returns its cancel; `random` is in `[0, 1)`; `counts` is each app with agents and how many, as last read.
  - `class AppFilter { constructor(deps: AppFilterDeps); shown(): string | undefined; front(app: string): void; pick(app: string, cause?: 'pick' | 'notice'): AppPick; stop(): void }`
- State: `shown`, `pickedOnDial`, `tieBreak` (the app drawn and the counts it was drawn for), `settledFront`, and the one pending settle.
- Rules (the spec's "Which app is shown", 1 to 3):
  - `shown()` applies rule 1 first: with no `shown`, or a `shown` that has no agents left, it becomes `settledFront` if that app has agents, else the app with the most agents. On a tie it keeps `tieBreak` while the counts are the ones it was drawn for, else draws again with `random()`. This clears `pickedOnDial`. With no agents at all it is `undefined`.
  - `front(app)`: a value equal to the last one given does nothing. Otherwise the one timer is cancelled and started again for `FRONT_SETTLE_MS`. When it fires: if the app is not `settledFront`, `pickedOnDial` ends and `settledFront` becomes it; then, unless `pickedOnDial` is set, if the app has agents and is not `shown`, `shown` becomes it. `none` gets no case of its own: it is no app, so it never has agents.
  - `pick(app, cause = 'pick')`: an app with no agents → `'ignored'`; the app shown → `'same'`, and nothing changes; else `shown` becomes it, `pickedOnDial` is set → `'switched'`.
  - `switched(cause)` is called once for each change of `shown` from one app to another: `front`, `pick`, `notice`, or `empty` (rule 1 replacing an app that emptied). The first app shown, when none was, is not a switch.
  - `stop()` cancels the timer.

- [ ] **Step 1: Write the failing tests** with a fake `after` and a scripted `random`:
  - `the default is the app with the most agents`; `the app in front is the default when it has agents`.
  - `a tie is drawn once: the same counts later draw nothing new, and changed counts draw again` (2+2 draws; every agent goes; 2+2 again keeps the drawn app with no call to `random`; 3+3 draws).
  - `the app in front is shown after 1 s, not before`.
  - `fifty changes inside a second leave one timer and settle once, on the last`.
  - `three apps and back inside a second moves nothing`.
  - `an app in front with no agents changes nothing`; `none in front changes nothing`; `an unknown terminal's agents are never followed to: none in front does not show the unknown app` (agents in `terminal` and in `ghostty`, Ghostty shown, `front('none')` settles → Ghostty).
  - `a pick holds through count changes and through the same app settling in front again`.
  - `a pick ends when another app settles in front, even one with no agents`: VS Code picked with Ghostty in front; `none`, then Ghostty → Ghostty is shown.
  - `the picked app emptying shows the app in front, else the biggest, and is an empty switch`.
  - `a pick of an app with no agents is ignored`; `a pick of the shown app is same and tells no switch`.
  - `a notice pick is a switch by notice and holds as a pick does`.
  - `each change tells its cause once; the first app shown tells none`.
  - `a front equal to the last starts no timer`; `stop cancels the timer`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/appFilter.spec.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** No `setTimeout`, `Date` or `Math.random` in the file: everything comes through `deps`.
- [ ] **Step 4: Run** the step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `devices: which app the dial shows: the one in front, a pick, or the biggest`.

### Task 5: The cable host: the shown app's ring, the app list, a pick, the front

**Layer:** devices service process. **Depends on:** Tasks 3, 4. **Effort:** `xhigh` (one state read by every dial's tick, a timer and a pick at once).

**Files:**
- Modify: `cli/src/cable/cableHost.ts` — `CableHostWiring` (:58 ⚠ #4296), `listAgentSnapshot` (:698), `machineSnapshot` (:723, where the single `DialRing` is called ⚠ design-only), beside `capsOf` / `hostOf` (:560)
- Test: `cli/src/cable/cableHost.spec.ts`

**Interfaces:**
- Consumes: `AppRings` (Task 3), `AppFilter`, `FRONT_SETTLE_MS` (Task 4), `appDisplayName` (Task 2).
- Produces, on `CableHostWiring` (all optional, so every other caller compiles):
  - `appSwitched?: (cause: SwitchCause) => void`
  - `appPicked?: () => void` — every `pickApp(app, 'pick')` a dial sent, whatever came of it. This is the picker's measure (the PM, answer 5).
  - `appTimer?: (ms: number, run: () => void) => () => void` — default: an unref'd `setTimeout`.
  - `appRandom?: () => number` — default `Math.random`.
- Produces, on `DaemonCableHost`:
  - `listAgentSnapshot(opts?: { apps?: boolean }): Promise<{ agents: CableAgent[]; tab: string; total: number; view?: 'machine'; apps?: AppList }>`
  - `pickApp(app: string, cause: 'pick' | 'notice' = 'pick'): AppPick`
  - `appOf(agentId: string): string | undefined`
  - `front(app: string): void`
- Rules:
  - The host owns one `AppRings` and one `AppFilter` (its `counts` are the rings' `counts()`), beside the single `DialRing`.
  - `machineSnapshot` filters as today (the Buddies, the wait for Swarm cards). Asked without `apps`: today's single ring, unchanged. Asked with `apps: true`: it updates the rings with the filtered agents, reads `filter.shown()`, and answers the shown app's rows, `total` = that app's count, and `apps: { shown, apps }` with each entry's `name` from `appDisplayName(id)`. With no agents: `apps: { shown: '', apps: [] }`, no rows, `total: 0`.
  - With a window (`swarms !== null`) or no registry: the answer is today's, with no `apps`, whatever `opts` says.
  - `pickApp` with a window is `'ignored'`. `appOf` is the machine list's agent's `app` (`onMachine(agentId)` ⚠ #4296), `undefined` with a window.
  - `front(app)` hands the app to the filter, with or without a window (the PM, answer 6): the filter keeps following while a window is open, and only the dial does not show it.

- [ ] **Step 1: Write the failing tests:**
  - `asked without apps it is the single ring; asked with, the shown app's` (Ghostty 3, VS Code 2: with `apps`, three rows, `total: 3`, `apps.shown: 'ghostty'`; without, five rows and no `apps`).
  - `the app list: fixed order, display names, count and waiting` (`{ id: 'vscode', name: 'VS Code', count: 2, waiting: 1 }`).
  - `the unknown app is named Other and Apple's Terminal is named Terminal` (agents in `terminal` and `terminal-app`: `{ id: 'terminal', name: 'Other', … }`, `{ id: 'terminal-app', name: 'Terminal', … }`).
  - `the front is followed while a window is open: when it closes, the app that settled in front meanwhile is shown` (Ghostty shown; a window opens; `front('vscode')` settles; the window closes → `apps.shown: 'vscode'`).
  - `a Buddy, and a Harness agent that waits for its Swarm cards, count in no app`.
  - `a pick switches the list and holds through a count change`; `a pick of an app with no agents is ignored`.
  - `the app in front is shown 1 s later` (a scripted `appTimer`); `appSwitched hears front once`.
  - `two reads in a row give the same shown app and the same order`.
  - `with a window: the tab's list exactly as before, no apps, and a pick is ignored`.
  - `appOf is the agent's app in the machine view, undefined with a window`.
  - `no agents: shown is empty and nothing is listed`.
  - `appPicked is told once for each pick, and not for a notice`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableHost.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Update the doc comment above `listAgents` (:670): the "no window" answer for a dial that says `appFilter` is one app's ring.
- [ ] **Step 4: Run** the step 2 command and `cd cli && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `dial: the machine list is the shown app's ring for a dial that asks for it`.

### Task 6: The dial's session: `appFilter`, `apps`, `app.pick`, a notice across apps

**Layer:** devices service process. **Depends on:** Task 2 (the wire types). **Effort:** `high`.

**Files:**
- Modify: `cli/src/cable/cableSession.ts` — `interface CableHost` (:408 ⚠ #4296), the capability flags (:765-808), `case 'hello'` (:1349), a new `case 'app.pick'`, `case 'agent.open'` (:1603), `syncAgentsNow` (:2698)
- Test: `cli/src/cable/cableSession.spec.ts`

**Interfaces:**
- Consumes: `AppList`, `AppPick` (Task 2).
- Produces, on `interface CableHost` (optional; the fake host of the spec implements them):
  - `listAgentSnapshot?(opts?: { apps?: boolean }): Promise<{ agents: CableAgent[]; tab: string; total: number; view?: 'machine'; apps?: AppList }>`
  - `pickApp?(app: string, cause?: 'pick' | 'notice'): AppPick`
  - `appOf?(agentId: string): string | undefined`
- Rules:
  - `hello`: `this.appFilter = str('appFilter') === 'v1'`, reset with the other capabilities, named `appFilter` in the greeting's log line.
  - `syncAgentsNow` asks `listAgentSnapshot({ apps: this.appFilter })`. When the answer has `apps`, the frame `{ t: 'apps', shown, apps }` goes before `agents.begin`, when its own key (`shown`, and each `id:count:waiting`) changed or the push is forced. A change of `apps` alone sends `apps` alone. Both follow the machine list's gap (`AGENTS_PUSH_GAP_MS` ⚠ #4296): at most one push a second, a forced one at once.
  - `app.pick`: dropped unless the dial said `appFilter` and `app` is a string of 1 to 16 characters. `'switched'` → `apps` and the ring, forced. `'ignored'` → `apps` again, forced, and no ring. `'same'` → nothing.
  - `agent.open` with no `reason` (a tapped notice), from a dial that said `appFilter`, for an agent whose `appOf` is defined: `pickApp(app, 'notice')`. On `'switched'`: `desiredFocus` becomes the agent, then a forced push, which re-asserts the focus when the new ring holds the agent. After a switch an agent without `f` is not opened (the dial is on its face; no "did not open it" toast). An agent with `f` is opened as today. On `'same'` or `'ignored'` everything is as today.
  - `agent.open` with `reason: 'question'` never picks an app.

- [ ] **Step 1: Write the failing tests:**
  - `a dial that says appFilter v1 is sent apps, then the shown app's ring` (the frames in order: `apps`, `agents.begin`, `agent`×3, `agents.end` with `total: 3`).
  - `a dial without appFilter is sent no apps frame, and asks for the single ring` (the fake host records `opts`).
  - `with a window no apps frame is sent`.
  - `a count change alone sends apps and no agents.begin`.
  - `apps and the ring are held to one push a second; a forced push goes at once` (fake clock).
  - `app.pick that switches is answered with apps and the new ring at once`.
  - `app.pick of the shown app sends nothing`.
  - `a pick of an app with no agents sends apps again and no ring`.
  - `app.pick from a dial without appFilter, with no app, or with a 17-character app, is dropped`.
  - `a tapped notice for an agent in another app picks its app as a notice, pushes the ring and focuses the agent` (frames: `apps`, the ring, `focus`).
  - `after that turn an agent without f is not opened and gets no toast; one with f is opened`.
  - `a tapped notice for an agent in the shown app does what it did before`.
  - `a question that opened by itself never switches the app`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableSession.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command and `cd cli && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `dial: apps and app.pick for a dial that says appFilter, and a notice opens its agent across apps`.

### Task 7: The devices' wiring: a switch is logged, pushed and reminded

**Layer:** devices service process. **Depends on:** Task 5. **Effort:** `xhigh` (what the log may say; `services/devices.ts` is in the 100% gate).

**Files:**
- Modify: `cli/src/services/devices.ts` — the `new DaemonCableHost({ … })` literal (:289 ⚠ #4296), `remind` (:677)
- Test: `cli/src/services/devices.spec.ts`

**Interfaces:**
- Consumes: `CableHostWiring.appSwitched`, `appPicked`, `appTimer` (Task 5); `timerIn`, `part.call`, `remind`, `cable.syncAgents` (⚠ #4296).
- Produces:
  - `appSwitched: (cause)` → the log line `[device] app filter: switched · <cause>` (the measure: a count by cause, read from the log as the notify tally is), then `cable.syncAgents()` and `remind`, each inside `part.call('dial', …)`.
  - `appPicked` → the log line `[device] app filter: picker`, one for each `app.pick` a dial sent (the PM, answer 5).
  - `appTimer: timerIn('dial')`.
  - `remind` reads both lists a dial can hold, `listAgentSnapshot()` and `listAgentSnapshot({ apps: true })`, and tells again each mid-turn agent in either: a ring the dial was just turned to has heard nothing of its agents yet.

- [ ] **Step 1: Write the failing tests:**
  - `a switch logs "[device] app filter: switched · pick" and no app id or name` (the whole log is read: no `vscode`, `VS Code`, `ghostty`, `Ghostty`).
  - `a switch pushes the list to the dials at once`.
  - `after a switch each mid-turn agent of the new ring is told again`.
  - `the picker's use is one log line with no app in it`.
  - `the settle timer is guarded: a filter that throws is logged and the devices keep running`.
  - `the timer is cancelled when the service stops`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd cli && npm run test:core && npm run typecheck`. Expected: PASS, 100% for `services/devices.ts`.
- [ ] **Step 5: Commit** `devices: a change of the shown app is logged by its cause, pushed and reminded`.

### Task 8: Core: check and bound a `dial_front`

**Layer:** core. **Depends on:** Task 1. **Effort:** `xhigh` (the core's trust boundary). A core file of its own: the PM, answer 1.

**Files:**
- Create: `cli/src/core/dialFront.ts`, `cli/src/core/dialFront.spec.ts`
- Not here: the line in `cli/src/architecture.coreFiles.txt`. `architecture.spec.ts` fails on a listed file the core does not load yet, so Task 10 adds it with the import.

**Interfaces:**
- Consumes: `minuteCounts`, `isRecord` from `core/observedHook.ts` (exported there by #4296 ⚠).
- Produces:
  - `const FRONT_APPS: ReadonlySet<string>` — the 15 app ids (Task 2's 14 and `claude`, Task 23) and `none`, written out here: the core imports nothing of the devices'.
  - `const FRONT_PER_SECOND = 10`
  - `createDialFront(deps: { forward(app: string): boolean; now(): number; log?: (line: string) => void }): { connection(): (payload: unknown) => void }`
- Rules:
  - `connection()` gives one connection its own bucket of 10, refilled at 10 a second; a clock that stepped back refills nothing. The bucket goes with the connection: no map, nothing to clean.
  - A payload that is not `{ app: <a member of FRONT_APPS> }` is refused. A frame past the rate is dropped. `forward` false (no devices process) is dropped.
  - Refused and dropped are counted and logged at most once a minute as `[devices] dial front in the last minute: N refused, M dropped`. No app, no payload, ever.
  - It keeps no app: after a forward nothing of the frame is held.

- [ ] **Step 1: Write the failing tests:**
  - `forwards a known app and none` (`terminal`, the unknown app's id, is a known app).
  - `refuses`: a non-object, no `app`, a number, `''`, `Ghostty` (a name, not an id), `com.mitchellh.ghostty` (a raw value), `other` and `Other` (neither is an id or a front value), a 5000-character string.
  - `the 11th frame within a second is dropped; another connection's is kept`; `a second later ten more pass`; `a clock set back refills nothing`.
  - `forward false is dropped, not an error`.
  - `the minute's line has counts and nothing of what was sent` (the log is read for the refused value).
  - `keeps nothing`: the returned object and its connections have no field holding an app after a forward.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/core/dialFront.spec.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npm run test:core`. Expected: PASS, 100% for `core/dialFront.ts`.
- [ ] **Step 5: Commit** `core: check and bound the app in front before it goes to the devices`.

### Task 9: The devices' port takes the app in front

**Layer:** core (`api.ts`, `devicesLink.ts`) and devices service process (`devices.ts`, `devicesProcess.ts`). **Depends on:** Tasks 5, 7. **Effort:** `xhigh` (privacy; state across two processes).

**Files:**
- Modify: `cli/src/core/api.ts` — `DevicesPort` (:1661 ⚠ #4296), `DEVICES_FALLBACKS` (:1714); `cli/src/core/devicesLink.ts` — the port; `cli/src/services/devicesProcess.ts` — `heard` (:231); `cli/src/services/devices.ts` — `port` (:789)
- Test: `cli/src/core/api.spec.ts`, `cli/src/core/devicesLink.spec.ts`, `cli/src/services/devicesProcess.spec.ts`, `cli/src/services/devices.spec.ts`

**Interfaces:**
- Consumes: `DaemonCableHost.front(app)` (Task 5), the switch's log line (Task 7).
- Produces:
  - `DevicesPort.front(app: string): boolean` — false when the devices did not take it. Fallback `false`.
  - `devicesLink`: `front: (app) => event('front', { app })`. A link that is down drops it.
  - `devicesProcess` `heard.front: ({ app }) => port.front(text(app))`.
  - `devices.ts`: `front: (app) => { part.call('dial', () => cableHost.front(app)); return true }`.
  - The inline path (`HARNESSD_SERVICES=none`) gets the same port.

- [ ] **Step 1: Write the failing tests:**
  - `api.spec.ts`: `the front's fallback is false`.
  - `devicesLink.spec.ts`: `front is one event on the link`; `with the devices down it answers false and nothing is queued`.
  - `devicesProcess.spec.ts`: `a front event reaches the port`; `a front that is not a string reaches it as ''`.
  - `devices.spec.ts`:
    - `the app in front becomes the shown app 1 s later, and the dial is pushed apps`.
    - `a front with a window open moves nothing on the dial`.
    - **Privacy:** `across a run with front changes, nothing but the dial's own frames holds the app in front`. Agents in Ghostty and VS Code; `port.front('ghostty')`, `'none'`, `'vscode'`, each settled. Every log line, and every call the devices made on the core's API, the windows, the fleet and the gateway, is read: none matches `/ghostty|vscode|VS Code/i`, and no argument of a call is the front value `none`. The dial's `apps` frames do name the shown app.
    - `the inline port takes a front too`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/core/api.spec.ts src/core/devicesLink.spec.ts src/services/devicesProcess.spec.ts src/services/devices.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd cli && npm run test:core && npm run typecheck`. Expected: PASS, 100% for the four files.
- [ ] **Step 5: Commit** `devices: the app in front, from the core's port to the filter`.

### Task 10: The local socket's `dial_front`

**Layer:** core. **Depends on:** Tasks 8, 9. **Effort:** `xhigh` (the core line).

**Files:**
- Modify: `cli/src/localWsServer.ts` — `LOCAL_TOOL_FEATURES` (:30), `LocalWsServerOptions` (:55), `machine_select` (:478), a block beside `dial_settings` (:845); `cli/src/core/main.ts` — beside the `observedHook` wiring (:2272 ⚠ #4296) and `onDialSettings` (:2518); `cli/src/architecture.coreFiles.txt` — add `core/dialFront.ts`, sorted (after `core/deviceInput.ts`)
- Test: `cli/src/localWsServer.spec.ts`; `cli/src/architecture.spec.ts` (unchanged; it reads the list)

**Interfaces:**
- Consumes: `createDialFront` (Task 8), `DevicesPort.front` (Task 9).
- Produces:
  - `LOCAL_TOOL_FEATURES` gains `'dial-front'`.
  - `LocalWsServerOptions.dialFront?: () => (payload: unknown) => void` — called once for a tool connection that asked for `watch: ['dial']`; what it returns is that connection's gate.
  - A `dial_front` frame is always consumed here: handed to the connection's gate when it has one, dropped otherwise. It never reaches `handleLocalFrame` or a relay.
  - `main.ts`: `const dialFront = createDialFront({ forward: (app) => ports.devices?.front(app) ?? false, now: () => performance.now(), log })`, and `dialFront: dialFront.connection` in the server's options. Nothing here starts the devices process.

- [ ] **Step 1: Write the failing tests** in `localWsServer.spec.ts`:
  - `a tool is told dial-front among its features` (`['openclaw-local', 'dial-watch', 'dial-front']`).
  - `dial_front from a tool that watches the dial reaches its gate with the payload`.
  - `dial_front from a window, from a tool that did not ask for the dial, and on a relayed machine reaches no gate and no backend`.
  - `each watching connection gets a gate of its own`.
  - `with no dialFront option the frame is dropped`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/localWsServer.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The block in `localWsServer.ts` is the check of who sent it and one call; every other rule is in `core/dialFront.ts`. The pull request says why every session's core loads that file: the local socket is the core's, and what a tool sends on it is checked before it reaches a component.
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npm run test:core && npx vitest run src/architecture.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `core: a dial watch may say which app is in front`.

### Task 11: The front table

**Layer:** CLI only. **Depends on:** Tasks 2, 8, 23. **Effort:** `high`.

**Files:**
- Create: `cli/src/cable/hosts/frontApp.ts`, `cli/src/cable/hosts/frontApp.spec.ts`

**Interfaces:**
- Consumes: `APP_IDS` (Task 2), `FRONT_APPS` (Task 8), for the spec only.
- Produces:
  - `const FRONT_NONE = 'none'` — no listed app is in front. Not an app id.
  - `frontAppId(value: string): string` — an app id, or `FRONT_NONE`.
- The table (the PM, answer 3; the list is closed):
  - Bundle ids, matched whole: the ten of Task 2's bundle table, with the same ids. The three new ones and their sources: `net.kovidgoyal.kitty` → `kitty` (kitty's `setup.py`, <https://github.com/kovidgoyal/kitty/blob/master/setup.py>), `com.github.wez.wezterm` → `wezterm` (WezTerm's `Info.plist`, <https://github.com/wezterm/wezterm/blob/main/assets/macos/WezTerm.app/Contents/Info.plist>), `ai.autonomous.harness` → `harness` (`/Applications/Harness.app`, read on Diego's Mac). And `com.anthropic.claudefordesktop` → `claude` (Task 23; `/Applications/Claude.app`'s `CFBundleIdentifier`, read by the main session on Diego's Mac, 2026-11-14).
  - Exe names, lower-cased, a trailing `.exe` dropped: `code` → `vscode`, `cursor` → `cursor`, `windowsterminal` → `terminal`, `wezterm-gui` → `wezterm` (the `CFBundleExecutable` of the same `Info.plist`), `kitty` → `kitty`, `ghostty` → `ghostty`.
  - The `.exe` rows (`Code.exe`, `Cursor.exe`, `WindowsTerminal.exe`) stay, as answer 2's option A says: the watch takes them, and nothing sends them until the Windows source exists.
  - Anything else, the empty string included → `FRONT_NONE`. An unknown terminal in front (Alacritty) is `none`, never the unknown app `terminal`: only `WindowsTerminal.exe` maps to that id.

- [ ] **Step 1: Write the failing tests:**
  - `every bundle id maps to the id detectApp gives for it` (every row, kitty's, WezTerm's, Harness Desktop's and Claude's among them, each also run through `detectApp({ __CFBundleIdentifier })`).
  - `Code.exe, Cursor.exe, WindowsTerminal.exe, wezterm-gui, kitty and ghostty map` (`CODE.EXE` too).
  - `an unknown app, the empty string and a 128-character string are none` (`com.apple.Safari`, `org.alacritty`, `net.kovidgoyal.kitty-quick-access`).
  - `no value maps to the words other or Other, and none is no app id` (`FRONT_NONE` is not in `APP_IDS`; `frontAppId('other')` and `frontAppId('Other')` are `none`).
  - `every id the table can give is in FRONT_APPS, and FRONT_APPS is APP_IDS and FRONT_NONE` (the core's list and the devices' list cannot drift).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/frontApp.spec.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `hardware watch: which app a bundle id or an exe name is`.

### Task 12: `harness hardware watch` reads the app in front

**Layer:** CLI only. **Depends on:** Task 11. **Effort:** `xhigh` (the raw name must stop here).

**Files:**
- Modify: `cli/src/devices/client.ts` — `DialWatchDeps` (:59), `runDialWatch` (:83)
- Test: `cli/src/devices/client.spec.ts`

**Interfaces:**
- Consumes: `frontAppId` (Task 11); the frame and the feature name of Task 10.
- Produces:
  - `DialWatchDeps.stdin` also takes `on(event: 'data', listener: (chunk: Buffer | string) => void)`.
  - Each stdin line that is JSON with a string `front` is mapped with `frontAppId`. The watch sends `{ type: 'dial_front', payload: { app } }` when the daemon's `connected.features` has `dial-front` and the app id differs from the last one sent.
  - A line before `connected` is held (the latest only) and sent once after it.
  - With no `dial-front` in the features, `front` lines are read and dropped.
  - A line over 1024 bytes, a line that is not JSON, and one with no string `front` are dropped. A partial line is kept up to 1024 bytes.
  - Nothing of a line is printed, on stdout or stderr.

- [ ] **Step 1: Write the failing tests:**
  - `a front line becomes dial_front with the app id` (`{"front":"com.mitchellh.ghostty"}` → `{ app: 'ghostty' }`; `{"front":"Code.exe"}` → `{ app: 'vscode' }`).
  - `an unknown app is sent as none`.
  - `the raw value is never sent or printed`: every frame the fake socket was sent, and every `print` and `printError`, is read for the bundle id and the exe name.
  - `the same app twice sends one frame; Safari then Finder sends one none`.
  - `a front line that arrives before connected is sent once after it`.
  - `with a daemon that has no dial-front, front lines send nothing`.
  - `a line in two chunks is one line; a 2000-byte line and a line that is not JSON are dropped, and the next line still works`.
  - `dial status lines print as before, and stdin closing still exits 0`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/client.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command and `cd cli && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `hardware watch: tell the daemon which app is in front, as an app id`.

### Task 13: Harness Device: the app in front goes to the watch's stdin

**Layer:** Harness Device app. **Depends on:** Task 1. **Effort:** `xhigh` (the value must never reach the log).

**Files:**
- Create: `device-app/src-tauri/src/front.rs`
- Modify: `device-app/src-tauri/src/cli.rs` (`Child` :211, beside `StdinCloser` :327), `watch.rs` (`Watch` :15), `runner.rs` (`Doors` :19, `Shared` :36, `spawn_watch` :163), `lib.rs`, `main.rs` (where `Doors` is built), `testing.rs`, `device-app/src-tauri/tests/fake-harness`
- Test: in `front.rs`, `cli.rs`, `watch.rs`, `runner.rs` (`cargo test --lib`)

**Interfaces:**
- Produces, in `front.rs`:
  - `const FRONT_MAX: usize = 128`
  - `trait FrontSource: Send + Sync { fn start(&self, changed: Box<dyn Fn(String) + Send + Sync>); }` — `changed` gets the value now, once, and then each new one. An app with no name is the empty string.
  - `struct NoFront;` — reports nothing: Wayland, and a platform with no source (Windows, until its wave).
  - `fn front_line(value: &str) -> String` — `{"front":"…"}`, the value cut to 128 characters on a character boundary, JSON-escaped, one line.
  - `struct FrontFeed` with `changed(&mut self, value: &str) -> Option<String>` (the line to write; `None` for a repeat) and `current(&self) -> Option<String>` (the line for a new watch).
  - `fn system() -> Arc<dyn FrontSource>` — `NoFront` in this task; Tasks 14 and 15 give it the real sources.
- Produces elsewhere:
  - `cli.rs`: `Child::stdin_writer(&self) -> StdinWriter`; `StdinWriter::line(&self, text: &str) -> bool` writes the text and a newline, false when the pipe is closed. It holds the pipe weakly, as `StdinCloser` does.
  - `watch.rs`: `Watch::front(&self, line: &str)`.
  - `runner.rs`: `Doors.front: Arc<dyn FrontSource>`, started once; each value goes through one `FrontFeed` to the current watch; a watch that has just spawned is written `current()`.
  - `tests/fake-harness`: a directive `@record`, which copies stdin to `stdin.log` in the fake's folder until stdin closes; `Fake::stdin(&self) -> Vec<String>` in `testing.rs`.
- Rules: the value goes to the watch's stdin and nowhere else: not `Event`, not `Effect::Log`, not the state file, not the window. A write that fails is not logged with the value.

- [ ] **Step 1: Write the failing tests:**
  - `front.rs`: `one_line_per_change_and_none_for_a_repeat`; `a_value_is_cut_to_128_characters` (ASCII, and a multi-byte name cut on a boundary); `a_quote_or_a_newline_stays_one_json_line`; `no_front_reports_nothing`.
  - `cli.rs`: `a_writer_reaches_the_child_and_stops_when_stdin_is_closed`.
  - `watch.rs`: `a_front_line_reaches_the_watch` (`@record`; `fake.stdin()` is the line).
  - `runner.rs`, with a fake `FrontSource`: `the_app_in_front_is_written_to_the_watch`; `a_new_watch_is_told_the_app_in_front_once`; `a_repeat_writes_nothing`; `nothing_of_the_front_is_logged` (after a run with a value, a repeat and a write to a watch that has ended, no line of the `MemoryLog` holds the value).
- [ ] **Step 2: Run** `cd device-app/src-tauri && cargo test --lib`. Expected: FAIL (does not compile: `front` is missing).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd device-app/src-tauri && cargo test --lib`. Expected: PASS, on Linux (PR CI) and on a Mac.
- [ ] **Step 5: Commit** `Harness Device: write the app in front on the watch's stdin, and nowhere else`.

### Task 14: Harness Device: the app in front on macOS

**Layer:** Harness Device app. **Depends on:** Task 13. **Effort:** `high`.

**Files:**
- Create: `device-app/src-tauri/src/front_macos.rs`
- Modify: `device-app/src-tauri/src/front.rs` (`system()`), `lib.rs`, `device-app/src-tauri/Cargo.toml`, `Cargo.lock`
- Test: in `front_macos.rs` (`#[cfg(target_os = "macos")]`)

**Interfaces:**
- Consumes: `FrontSource` (Task 13).
- Produces: `struct MacFront` implementing `FrontSource`: `NSWorkspace.frontmostApplication` once at `start`, then an observer of `NSWorkspaceDidActivateApplicationNotification` on the workspace's notification centre. The value is the app's `bundleIdentifier`, or the empty string when it has none. `system()` gives it on macOS.
- Rules: no timer, no `osascript`, no System Events, no Accessibility or Screen Recording. The objc2 crates gain only the features the observer needs (the notification, its block); the pull request lists them.

- [ ] **Step 1: Write the failing tests:**
  - `an_app_with_no_bundle_id_is_the_empty_value` (the pure helper that turns an optional bundle id into the value).
  - `start_tells_the_app_in_front_once` (`start` calls `changed` exactly once before it returns, with at most 128 characters).
  - `system_is_the_appkit_source_on_macos`.
- [ ] **Step 2: Run** on a Mac: `cd device-app/src-tauri && cargo test --lib front_macos`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** Start it where the app's `setup` runs, on the main thread (check `main.rs` at dispatch).
- [ ] **Step 4: Run** `cd device-app/src-tauri && cargo test --lib` on a Mac. Expected: PASS. PR CI does not compile this file.
- [ ] **Step 5: Commit** `Harness Device: the app in front on macOS, from NSWorkspace`.

### Task 15: Harness Device: the app in front on Linux X11

**Layer:** Harness Device app. **Depends on:** Task 13. **Effort:** `high`.

**Files:**
- Create: `device-app/src-tauri/src/front_x11.rs`
- Modify: `device-app/src-tauri/src/front.rs` (`system()`), `lib.rs`, `device-app/src-tauri/Cargo.toml`, `Cargo.lock`
- Test: in `front_x11.rs` (`#[cfg(target_os = "linux")]`)

**Interfaces:**
- Consumes: `FrontSource` (Task 13).
- Produces:
  - `struct X11Front` implementing `FrontSource`: a thread that waits on `PropertyNotify` for the root window's `_NET_ACTIVE_WINDOW`, reads that window's `_NET_WM_PID`, and gives the file name of `/proc/<pid>/exe`. A window with no pid, or a process it cannot read, is the empty string.
  - `fn session_is_x11(session_type: Option<&str>, wayland_display: Option<&str>, display: Option<&str>) -> bool` — false when `XDG_SESSION_TYPE` is `wayland` or `WAYLAND_DISPLAY` is set, and false with no `DISPLAY`.
  - `fn exe_name(proc_root: &Path, pid: u32) -> Option<String>`
  - `system()` on Linux: `X11Front` when `session_is_x11`, else `NoFront`. A connection that fails is `NoFront`'s behavior and one log line with no value.
- New crate: `x11rb`, for Linux only, its pure-Rust connection (no new system package). The pull request names its license.

- [ ] **Step 1: Write the failing tests:**
  - `the_exe_name_is_the_file_name_of_the_proc_link` (a temp folder shaped like `/proc`); `a_process_that_is_gone_has_no_name`.
  - `a_wayland_session_is_not_x11` (the table of the three variables, XWayland's `DISPLAY` under Wayland included).
  - `x11_live`, `#[ignore]` (it needs an X server, a window manager and `xdotool`): it waits, up to 10 s, for the root window's `_NET_SUPPORTED` to list `_NET_ACTIVE_WINDOW` (the window manager is up), starts the X clients named in `X11_LIVE_CLIENTS` (two paths), activates each with `xdotool`, and waits on the source, with a 10 s deadline each, for each client's exe name in order. It ends its clients. Every wait is on a condition. Task 20 runs it in PR CI.
- [ ] **Step 2: Run** on Linux: `cd device-app/src-tauri && cargo test --lib front_x11`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd device-app/src-tauri && cargo test --lib --locked`. Expected: PASS; `x11_live` is listed as ignored. On a Mac this file is not compiled: its first run is Task 20's, on a runner.
- [ ] **Step 5: Commit** `Harness Device: the app in front on Linux X11, from _NET_ACTIVE_WINDOW`.

### Task 16: Round firmware: `appFilter` in `hello`, `apps` in, `app.pick` out

**Layer:** firmware. No drawing, so the mockup does not gate it. **Depends on:** Task 1. **Effort:** `high`.

**Files** (under `devices/harness-device/firmware/`):
- Modify: `main/cable_client.c` (`send_hello` :250, a new `handle_apps` and its line in the frame switch :1359-1540, a new `cable_client_pick_app`, `session_up` / the session's end), `main/cable_client.h`, `main/ui/ui_screens.h`, `main/ui/habitat/ui_habitat.c` (the state :233, two setters beside `ui_fleet_set_view` :4203)
- Test: `test/test_cable_supertab.py` (`send_hello`), `test/test_cable_identity.py` (the parse), `test/test_cable_outbound.py` (`app.pick`), `test/test_touch_ui.py` (the state; its copy of the struct :82 and its function lists :240, :251)

**Interfaces:**
- Produces:
  - `hello` carries `"appFilter": "v1"`.
  - `cable_client.h`: `#define CABLE_MAX_APPS 16`; `typedef struct { char id[16]; char name[24]; uint16_t count, waiting; } cable_app_t;`; `void cable_client_pick_app(const char *app);` → `{ "t": "app.pick", "app": … }`.
  - `ui_screens.h`: `void ui_apps_replace(const cable_app_t *rows, int count, const char *shown);` and `void ui_apps_forget(void);`.
  - UI state: `s.apps[CABLE_MAX_APPS]`, `s.app_count`, `s.app_shown[16]`, `s.apps_known`.
- Rules:
  - `handle_apps` takes at most 16 entries. An entry whose `id` is missing, empty or 16 characters or more is dropped, never cut: an id is what the dial sends back. A `name` that does not fit is cut on a character. `count` and `waiting` are clamped to 0..999. A `shown` that is no entry's id is kept as it came.
  - `ui_apps_replace` sets `apps_known`. `ui_apps_forget` clears it and the list; it is called when the session ends and when a `welcome` starts a new one, so an older daemon after a newer one reads as "no apps".
  - A failed allocation sends no partial `app.pick` (the rule `test_cable_outbound.py` holds every command to).

- [ ] **Step 1: Write the failing tests:**
  - `test_cable_supertab.py`: `hello` has `appFilter` `v1`.
  - `test_cable_identity.py`: `two apps and shown are handed on`; `the 17th entry is dropped`; `an id of 16 characters is dropped, not cut`; `a count of 5000 is 999`; `apps with no array is an empty list that is still known`.
  - `test_cable_outbound.py`: `app.pick carries the app`; `a failed allocation sends nothing`.
  - `test_touch_ui.py`: `ui_apps_replace holds the apps and the shown one`; `ui_apps_forget makes them unknown`.
- [ ] **Step 2: Run** `IDF_PATH=~/esp/esp-idf-5.5.4 python3 devices/harness-device/firmware/test/test_cable_supertab.py` and the three others the same way. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `env -u IDF_PATH make device-test` and every `devices/harness-device/firmware/test/test_*.py`. Expected: PASS, except the known macOS `test_cable_models.py` "'snprintf' macro redefined". Build `default` with `-DPROJECT_VER=0.1.0-dev`.
- [ ] **Step 5: Commit** `round dial: say appFilter, hold the apps, and send a pick`.

### Task 17: Round firmware: the shown app's name on the face

**Layer:** firmware UI. **Depends on:** Task 16 (the mockup is approved; draw what it shows). **Effort:** `high`.

**Files** (under `devices/harness-device/firmware/`):
- Modify: `main/ui/habitat/ui_habitat.c` — `render_home`'s `.chat` (:1807)
- Test: `test/test_touch_ui.py` (cases, and a `DESIGN` preview :4331-4373)

**Interfaces:**
- Consumes: `s.apps`, `s.app_shown`, `s.apps_known` (Task 16).
- Produces: in the machine view with `apps_known` and a shown app that is in the list, the grey line under the agent's name is that entry's `name`. Otherwise it stays `host_name(a->host)`. "See it in …" still uses `host_name(a->host)`.

- [ ] **Step 1: Write the failing tests:**
  - `the face's line is the shown app's name`: an agent with host `zellij`, apps `ghostty` "Ghostty" shown → the scene says `Ghostty` and not `Zellij`.
  - `a tap still says See it in Zellij` (the nearest host).
  - `without apps the line is the host's name, as before`; `with a window there is no line`.
  - `a shown app that is not in the list falls back to the host's name`.
  - `an agent in an unknown terminal: the line reads Other, and a tap says See it in Terminal` (host `terminal`, apps `terminal` "Other" shown). The firmware draws the `name` it was sent and has no word of its own for it.
  - A `DESIGN` preview `machine-view-app`, as the mockup draws it.
- [ ] **Step 2: Run** `IDF_PATH=~/esp/esp-idf-5.5.4 python3 devices/harness-device/firmware/test/test_touch_ui.py`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `env -u IDF_PATH make device-test` and every `test_*.py`. Expected: PASS (the known macOS exception of Task 16).
- [ ] **Step 5: Commit** `round dial: the face names the app it shows`.

### Task 18: Round firmware: the `APPS` picker

**Layer:** firmware UI. **Depends on:** Task 16 (the mockup is approved; draw what it shows). **Effort:** `high`.

**Files** (under `devices/harness-device/firmware/`):
- Modify: `main/ui/habitat/ui_habitat.c` — `view_t` (:73), the actions (:96), the carousels (:273), `face_hold` (:891), a new `render_apps` beside `render_tabs` (:2251), `dispatch` (:3085), the sender's switch (:3412), the hold branch (:3783-3792), `ui_apps_replace`, `ui_fleet_set_view` (:4203)
- Test: `test/test_touch_ui.py` (cases, its function lists, `DESIGN` previews)

**Interfaces:**
- Consumes: the UI state and `cable_client_pick_app` (Task 16); `focus_carousel`, `focus_header`, `ht_tab_carousel_*`.
- Produces: a view `APPS`, a carousel `app_carousel`, actions `A_APP` (a page, by app id) and `A_APP_DONE`.
- Rules:
  - A hold on the face, and on the badged companion (`A_PET_INBOX`): on a Swarm recap, the Personal | Team picker as today. Else in the machine view with `apps_known`: `APPS` when there is at least one app, and nothing at all when there is none. Else TABS as today (a window; an older daemon).
  - `APPS`: the header `APPS`; one page per app through `focus_carousel`, the app's `name` in the tab page's type; under it `1 agent` / `3 agents`, or `3 agents · 1 waiting` with the waiting part in the accent; Done at the bottom, as in TABS, and no close pill, as in TABS (`focus_header`). It opens on the shown app. Positions and type are the mockup's.
  - Browsing sends nothing. Done, or a tap on a page, sends `app.pick` for that page's app, returns to the face, and arms the landing so the first agent of the next list is shown. Done on the shown app is how a person leaves without changing anything.
  - `ui_apps_replace` while `APPS` is open keeps the carousel on the same app **by id**. A page whose app went closes up, and a list that became empty closes `APPS` to the face.
  - `APPS` closes to the face when the list stops being the machine view (a window opened) and when the apps are forgotten (the link dropped).

- [ ] **Step 1: Write the failing tests:**
  - `a hold in the machine view with apps opens APPS on the shown app`; `the same hold on the badged companion`.
  - `a hold with a window opens TABS`; `a hold in the machine view without apps opens TABS, which says No tabs yet.` (today's screen, an older daemon).
  - `a hold with apps known and none listed opens nothing` (the view stays `HOME`, the scene is the face's).
  - `a hold on a Swarm recap still opens the Personal | Team picker`.
  - `the pages`: `Ghostty` with `3 agents`; `VS Code` with `2 agents · 1 waiting`, the waiting run in the accent ink; `1 agent` for one.
  - `one app: one page`.
  - `browsing sends nothing` (a swipe to the next page: no action queued).
  - `Done sends app.pick for the page in the middle and returns to the face`; `a tap on a page sends app.pick for that page`; `Done on the shown app sends its pick and the face is as it was`.
  - `after a pick the first agent of the new list is on the face`.
  - `a push while open keeps the app by id` (on VS Code; a new list puts Orca before it → still VS Code); `the page of an app that went closes up`; `a list that became empty closes the picker`.
  - `a window opening closes APPS`; `a dropped link closes APPS`.
  - `DESIGN` previews `apps`, `apps-waiting`, `apps-one`.
- [ ] **Step 2: Run** `IDF_PATH=~/esp/esp-idf-5.5.4 python3 devices/harness-device/firmware/test/test_touch_ui.py`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `env -u IDF_PATH make device-test` and every `test_*.py`. Expected: PASS (the known macOS exception). Build `default` with `-DPROJECT_VER=0.1.0-dev`. The previews go to the main session for review beside the mockup.
- [ ] **Step 5: Commit** `round dial: a hold on the face picks the app, with no window`.

### Task 19: End to end: the daemon, a fake dial and the real watch

**Layer:** test. **Depends on:** Tasks 6, 10, 12. **Effort:** `high`. **Red test:** none: no behavior (it adds end-to-end tests of what Tasks 2 to 12 built, and moves a test helper).

**Files:**
- Create: `cli/e2e/dialAppFilter.e2e.ts`, `cli/e2e/harness/outsideAgent.ts`
- Modify: `cli/e2e/deviceWithoutApp.e2e.ts` (its `Outside` class, `PTY` and `HOST_HINTS` move to `harness/outsideAgent.ts`, which exports them, and it imports them), `cli/e2e/harness/desk.ts` (`plug` takes the dial's `capabilities`)

**Interfaces:**
- Consumes: `IsolatedDaemon`, `Desk`, `FakeDial` (its `capabilities`), `Outside.start(d, folder, hints)`, and the way `e2e/hardwareWatch.e2e.ts` starts `harness hardware watch --json` with a stdin pipe.

- [ ] **Step 1: Write the tests** (no window unless said; the dial greets with `appFilter: 'v1'`). The agents' folders are named `a1`, `a2`, …: the last test reads the log for app names, and a folder name is in it.
  - `Ghostty 3 and VS Code 2: the dial is sent apps with both counts and Ghostty's three agents`.
  - `app.pick vscode: apps says vscode, and the ring is VS Code's two, in the order they started`.
  - `Claude Code in zellij inside Ghostty is in Ghostty's ring, and its row's host is zellij`.
  - `the watch is written {"front":"com.microsoft.VSCode"}: the dial is sent VS Code's ring`; `Finder's bundle id changes nothing`. The test waits for the frame, never for a time.
  - `an agent in an unknown terminal is in the app named Other, beside Apple's Terminal` (`TERM_PROGRAM: 'tmux'` and `TERM_PROGRAM: 'Apple_Terminal'`: `apps` has `{ id: 'terminal', name: 'Other' }` and `{ id: 'terminal-app', name: 'Terminal' }`); `an unknown terminal in front ({"front":"org.alacritty"}) does not turn the dial to Other`.
  - `kitty's bundle id in front turns the dial to kitty's agents` (an agent with `__CFBundleIdentifier: 'net.kovidgoyal.kitty'`; the watch is written `{"front":"net.kovidgoyal.kitty"}`).
  - `the front is followed while a window is open: when it closes the dial is sent the app that came to the front meanwhile`.
  - `a pick holds while the same app is in front, and ends when another settles`.
  - `an agent in VS Code needs the person while Ghostty is shown: apps says waiting 1, and agent.open for it turns the dial to VS Code and focuses it`.
  - `a window opens: the tab's list and no apps; it closes: apps again`.
  - `unplugged and plugged in again, the dial is sent the app it had picked` (decision 8: the pick lives as long as the devices process).
  - `a dial without appFilter beside it gets all five agents in one ring and no apps frame`.
  - `the daemon's log has "app filter: switched" lines and no bundle id, no exe name and no app name`.
- [ ] **Step 2: Run** `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialAppFilter.e2e.ts e2e/deviceWithoutApp.e2e.ts e2e/hardwareWatch.e2e.ts`. Expected: PASS.
- [ ] **Step 3: Commit** `e2e: the dial's app filter`.

### Task 20: PR CI runs the X11 source live

**Layer:** PR CI (`device-app-checks`, which runs only when `device-app/` changes). **Depends on:** Task 15 (the `x11_live` test). **Effort:** `high` (a job the required check waits on).

This replaces the draft's temporary workflow (the PM, answer 7): the check has the repo's own workflow, so no `.github/workflows/tmp-*.yml` is added and nothing is removed before the pull request.

**Files:**
- Modify: `.github/workflows/ci.yml` (`device-app-checks` :730, its `apt-install.sh` line and a new step after "Rust unit tests"), `docs/validation-and-release.md` (the `device-app/` row :81)
- Test: `scripts/tests/test_ci_plan.py` (`test_the_workflow_carries_every_suite` :117)

**Interfaces:**
- Consumes: `x11_live` and `X11_LIVE_CLIENTS` (Task 15).
- Produces, in `device-app-checks`:
  - The package line gains `xvfb openbox xdotool xterm` (four packages; the comment above it says what each is for).
  - A step `X11 front source, live`, after "Rust unit tests" (so it reuses that build):
    1. It copies `xterm` to `$RUNNER_TEMP/code`, so one client's exe name is `code`.
    2. It starts `Xvfb` on a display of its own and `openbox` on it. `xvfb-run` is not used: it needs `xauth`, which `apt-install.sh`'s `--no-install-recommends` leaves out. It waits for the display with a bounded loop on `xdotool getdisplaygeometry`, never a sleep.
    3. It runs `X11_LIVE_CLIENTS="$(command -v xterm):$RUNNER_TEMP/code" cargo test --locked --lib --manifest-path device-app/src-tauri/Cargo.toml -- --ignored x11_live --nocapture`.
    4. It fails unless the output has `x11_live ... ok`: a filter that matches no test passes with 0 tests.
  - The job's `timeout-minutes` stays 30. No secret, nothing published.
- `docs/validation-and-release.md`: the row says the job also runs the X11 front source live under Xvfb.

- [ ] **Step 1: Write the failing test.** In `test_the_workflow_carries_every_suite`, the `device-app-checks` job must also hold `xvfb`, `openbox`, `xdotool`, `xterm`, `--ignored x11_live` and `x11_live ... ok`; and `X11 front source, live` comes after `cargo test --locked --manifest-path device-app/src-tauri/Cargo.toml`.
- [ ] **Step 2: Run** `python3 -m unittest discover -s scripts/tests -p 'test_ci_plan.py' -v`. Expected: FAIL (`'xvfb' not found in …`).
- [ ] **Step 3: Implement** the job's change and the doc row.
- [ ] **Step 4: Run** the step 2 command, then `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 .github/workflows/ci.yml`. Expected: PASS, no finding.
- [ ] **Step 5: Commit** `CI: device-app-checks runs the X11 front source live, under Xvfb`.
- [ ] **Step 6: The first run on a runner** is Verification check 2, the pull request's own CI run (no hand-started run: `AGENTS.md` allows no extra CI run). The pull request records the job's time there beside its time on the latest earlier run in which the job ran, and the difference.

### Task 21: Say it in the docs

**Layer:** repo files. **Depends on:** Task 1. **Effort:** `medium`. **Red test:** none: no behavior.

**Files:**
- Modify: `cli/AGENTS.md` (the devices row of the processes table: which app the dial shows, and the app in front, in memory), `device-app/AGENTS.md` ("Rules a change keeps": the app in front is written to the watch's stdin and nowhere else, and is never logged), `docs/specs/2026-11-13-device-without-the-app.md` ("What the dial gets with no window": one ring per app for a dial that says `appFilter`, with a link to this spec)

- [ ] **Step 1:** Write the three changes, in the files' own words and length.
- [ ] **Step 2:** Check every link resolves.
- [ ] **Step 3: Commit** `docs: the dial's app filter, where the daemon and the device app describe themselves`.

### Task 22: The on-dial rig (opt-in)

**Layer:** test rig. **Depends on:** Task 19 (`HOST_HINTS`, exported by `cli/e2e/harness/outsideAgent.ts`). **Effort:** `high`. **Red test:** none: no behavior (an opt-in rig for the check a person walks; every run that does not set `ON_DIAL_PORT` skips it).

Why it is a task (the PM, answer 8): the repo has no rig for this. `fix/dial-swipe-order`'s on-dial check runs a script kept in its plan, which starts its own sessions on pseudo-terminals. This check needs each fake Claude Code in a real app's tab, so the tab names its app and the app can be brought to the front.

**Files:**
- Create: `cli/e2e/dialAppFilterOnDial.e2e.ts`

**Interfaces:**
- Consumes: `IsolatedDaemon`, `until`, `CLI_ROOT` (`e2e/harness/daemon.ts`); `HOST_HINTS` (Task 19); the `CLI_ENTRY` of `e2e/hardwareWatch.e2e.ts`.
- Reads from the environment: `ON_DIAL_PORT` (the dial's serial port; without it `describe.skipIf` skips the file), `ON_DIAL_OUT` (a folder for what it writes; an error when the port is set and this is not), `ON_DIAL_MINUTES` (the case's timeout, default 45).
- Does, in one case:
  1. Starts `IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false', HARNESSD_TEST_DIAL_PORT: <ON_DIAL_PORT> } })`, as `e2e/deviceCompat.e2e.ts` does for a fake dial. `CABLE_FW_DISABLE` stays `true`: this daemon offers the dial no firmware.
  2. Writes into `ON_DIAL_OUT`, each value shell-quoted:
     - `tab.sh <folder>`: exports the daemon's environment without `HOST_HINTS`, `TMUX`, `TMUX_PANE` and `HARNESS_PANE` (the tab's own `TERM_PROGRAM` and `__CFBundleIdentifier` name its app), makes and enters `<projectsDir>/<folder>`, and execs the fake engine (`CLAUDE_PATH`).
     - `harness`: an executable that runs this checkout's CLI (`CLI_ENTRY`) under the daemon's environment.
     - `device.sh`: under the daemon's environment, writes the Harness Device app's first-run state with `loginItem` true (`$HOME/Library/Application Support/ai.autonomous.harness.device/state.json`, as `docs/plans/2026-11-13-device-menubar-plan.md` Verification says) and execs `device-app/src-tauri/target/debug/harness-device` with `HARNESS_DEVICE_CLI` at the `harness` above.
  3. Prints the three lines a person pastes (`sh <out>/tab.sh a1`, `sh <out>/device.sh`, `touch <out>/done`), and the dial's line once it greets (`cable: dial … on fw …`, waited for up to 60 s).
  4. Waits, on a condition, for `<out>/done`, up to `ON_DIAL_MINUTES`.
  5. Copies the daemon's log to `<out>/daemon.log`, prints how many `[device] app filter: switched · <cause>` lines each cause has and how many `[device] app filter: picker` lines there are, and closes the daemon (its throwaway root goes with it).
- Asserts: the dial greeted; every `app filter:` line is exactly `[device] app filter: switched · front|pick|empty|notice` or `[device] app filter: picker`; every `dial front` line is the minute's count and nothing else.

- [ ] **Step 1: Write the file.**
- [ ] **Step 2: Run** `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialAppFilterOnDial.e2e.ts`. Expected: 1 skipped. `npm run typecheck`. Expected: PASS.
- [ ] **Step 3: Rehearse without a dial,** on the developer's Mac: `ON_DIAL_PORT` at a pseudo-terminal nothing answers on, `ON_DIAL_OUT` a scratch folder, `ON_DIAL_MINUTES=5`. The three files are written; `sh <out>/tab.sh a1` in a terminal tab adds a fake session the daemon's log lists; `touch <out>/done` ends the run. The case fails on "the dial never greeted", which is expected here. The everyday daemon (18473), its dial and `~/.harness` are untouched.
- [ ] **Step 4: Commit** `e2e: an opt-in rig for the app filter on a real dial`.

### Task 23: Claude desktop reads "Claude" on the dial

The PM, 2026-11-14 (added to this plan's scope): #4296 finds an agent in the Claude desktop app (bundle
`com.anthropic.claudefordesktop`) and opens its session, but the dial reads "Terminal": neither the daemon's `NAMES`
(`hostDetect.ts`) nor the firmware's `host_name` table has `claude`, and `test_touch_ui.py` holds the two tables equal.
`/Applications/Claude.app`'s `CFBundleIdentifier` is `com.anthropic.claudefordesktop` (read by the main session on
Diego's Mac, 2026-11-14).

**Layer:** devices service process and firmware (one table row each; no drawing, so the mockup does not gate it).
**Depends on:** Task 2 (it shares `hostDetect.ts` and its spec). **Effort:** `medium`.

**Files:**
- Modify: `cli/src/cable/hosts/hostDetect.ts` (`NAMES`; and `detectHost` / `detectApp` only if #4296 merged without a `claude` id: Task 1 reports which), `devices/harness-device/firmware/main/ui/habitat/ui_habitat.c` (`host_name`'s table)
- Test: `cli/src/cable/hosts/hostDetect.spec.ts`, `devices/harness-device/firmware/test/test_touch_ui.py`

**Interfaces:**
- `NAMES` gains `claude: 'Claude'`, so `APP_IDS` has 15 ids (Task 2's count test moves from 14 to 15) and `appDisplayName('claude')` is `Claude`.
- `detectHost` and `detectApp`: `__CFBundleIdentifier === 'com.anthropic.claudefordesktop'` gives `claude`.
- Firmware `host_name`: `{"claude", "Claude"}`.

- [ ] **Step 1: Write the failing tests:**
  - `hostDetect.spec.ts`: `the Claude desktop app's bundle id is claude, read Claude` (`detectHost` and `detectApp` of `{ __CFBundleIdentifier: 'com.anthropic.claudefordesktop' }` → `claude`; `hostDisplayName('claude')` → `Claude`); `APP_IDS has 15 ids, at most 16, and every one has a display name`.
  - `test_touch_ui.py`: `host_name("claude")` is `Claude`, and the existing check that the firmware's table equals the daemon's `NAMES` (less its "Terminal" rows) passes with the new row on both sides.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/hostDetect.spec.ts` and `python3 devices/harness-device/firmware/test/test_touch_ui.py`. Expected: FAIL (`Terminal` where `Claude` is wanted).
- [ ] **Step 3: Implement** the two rows (and the bundle-id branch if Task 1 found none).
- [ ] **Step 4: Run** the step 2 commands, then `make device-test`. Expected: PASS.
- [ ] **Step 5: Commit** `dial: the Claude desktop app reads Claude, in the daemon's names and the firmware's`.

---

## Verification

**Local gates**, recorded in the pull request (PR CI does not run them):
- `cd cli && npm run typecheck && npm run test:core` — 100% per file for `core/dialFront.ts`, `core/api.ts`, `core/devicesLink.ts`, `services/devices.ts`, `services/devicesProcess.ts`; and `npx vitest run src/architecture.spec.ts`.
- `cd device-app/ui && npm ci && npm run build`, then `cd device-app/src-tauri && cargo test --lib` and `cargo test --locked`, **on a Mac**: PR CI compiles and tests the app's Linux code only, so `front_macos.rs` is compiled nowhere else.
- `env -u IDF_PATH make device-test`, every `devices/harness-device/firmware/test/test_*.py` with `IDF_PATH=~/esp/esp-idf-5.5.4`, and the `default` build with `-DPROJECT_VER=0.1.0-dev`.
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit; its receipts go in the pull request.
- Not needed: `npm run test:harnessd` and the serial specs (nothing of theirs changes).

**Platforms the pull request names:** the daemon and CLI on macOS, Linux and Windows; the Harness Device app on macOS and Linux X11; the round dial. On Windows the dial filters by app and takes a pick, and follows nothing until the Windows source exists (a follow-up). This plan has no Windows check (the PM, answer 2): `windows.yml` runs a fixed list of Windows specs, none of them touched, and is not started.

**Turns.** The tester asks before using either, and starts nothing until it is granted.
- **A runner turn,** asked of the orchestrator, before the one hand-started run on GitHub: CLI end to end (check 1: eight shards, about 70 minutes of test time).
- **The dial and Diego's turn,** asked of the PM, before check 4. The shared dial is used only after the PM's go, and only for the steps asked for.

**Temporary workflow:** none. The X11 check runs in PR CI's own job (Task 20).

**1. The daemon, a fake dial and the real watch**
- Run: `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialAppFilter.e2e.ts e2e/deviceWithoutApp.e2e.ts e2e/hardwareWatch.e2e.ts e2e/deviceCompat.e2e.ts e2e/devicesProcess.e2e.ts`, on a Mac or a Linux box.
- Isolation: the suite's own (`e2e/harness/daemon.ts`): a throwaway home and data folder, a private port and tmux server, fake engines, a fake dial on a pseudo-terminal, no backend and no sign-in.
- A person sees: every test passes; the daemon's log has `[device] app filter: switched · front` and `· pick` lines with no app in them.
- On GitHub, by hand, once on the final head, after a runner turn: Actions → CLI end to end → Run workflow, branch `feat/dial-app-filter` (`.github/workflows/cli-e2e.yml`). Every shard passes. This is also the Linux run of the daemon's side of the spec's check 9.

**2. Linux X11: the front line arrives**
- Where: PR CI's `device-app-checks` on `ubuntu-latest`, its step `X11 front source, live` (Task 20): Xvfb, `openbox`, two `xterm` clients, one of them copied to the name `code`.
- Isolation: the runner. No daemon, no backend, no login, no secret.
- A person sees: the step prints `x11_live ... ok`: the source gave `xterm`, then `code`, as each window was brought to the front.
- That `code` in front becomes `vscode` and turns the dial is Tasks 11 and 12's tests and check 1.
- On GitHub: the pull request's own CI run, which runs `device-app-checks` because `device-app/` changed. It is the first run of `front_x11.rs` anywhere (a Mac does not compile it), so a failure there is fixed as phase 5 says. No CI run is started by hand (`AGENTS.md`: never an extra CI run).
- The pull request records how much longer the job runs: `device-app-checks`' time on this run, its time on the latest earlier run in which the job ran (`gh run view <run> --json jobs`), and the difference.
- No Linux desktop is named for this plan, so following VS Code on a person's X11 desktop is not walked by hand.

**3. The Harness Device app on a Mac, against the fake CLI**
- Where: a Mac, in a desktop session, in the feature worktree at the final head.
- Isolation: the recipe of `docs/plans/2026-11-13-device-menubar-plan.md`, Verification, "Isolation": a throwaway `HOME` and `CFFIXED_USER_HOME`, a `PATH` of its own, `HARNESS_DEVICE_CLI` pointing at `device-app/src-tauri/tests/fake-harness` with `FAKE_HARNESS="$T/fake"`, and a `state.json` whose `loginItem` is true. The fake's script for the watch is the file `$T/fake/hardware_watch_--json` with two lines, `{"attached":false}` and `@record`. No daemon, no backend, no login; the person's `~/.harness`, daemon (18473) and dial are not touched.
- Build: `(cd device-app/ui && npm ci && npm run build) && (cd device-app/src-tauri && cargo build --locked)`; run `target/debug/harness-device` in the isolated shell.
- A person does and sees: brings Ghostty, VS Code, Finder, then Ghostty to the front. `$T/fake/stdin.log` gains one `{"front":"<bundle id>"}` line per switch, the first one at start, none for bringing the same app forward twice. macOS asks for no permission. `grep -c` for each bundle id in `$HOME/Library/Logs/ai.autonomous.harness.device/app-*.log` is 0.
- On GitHub: none. macOS code is built and tested by hand (`device-app/AGENTS.md`).

**4. On a dial** (the spec's "On a dial" 1 to 8)
- When: after every task, on the final head.
- **First, the turn.** The tester asks the PM for the shared dial and for Diego's turn, and waits for the go. Nothing below starts before it.
- Where: the Mac the shared round dial is plugged into, in a desktop session.
- **Then free the dial:** quit Harness and Harness Device (each starts the daemon again when it is down), then run `harness stop`. The everyday daemon stays down for the turn. Nothing of its data, its account or its agents is read or written.
- **Never against the everyday daemon or anyone's account.** The daemon is the rig's (Task 22): the end-to-end suite's `IsolatedDaemon`, with a throwaway home, data, auth and computer-id folder, a free port of its own, a private tmux server, signed out (`BACKEND_WS_URL=ws://127.0.0.1:9`), no update, no analytics, no firmware offer (`CABLE_FW_DISABLE=true`) and fake engines whose hooks reach that daemon alone. It holds the dial through `HARNESSD_TEST_DIAL_PORT=<the dial's port>`, the only port it then looks at (how #4290's dial check ran).
- Run the rig: `cd cli && TMPDIR=/tmp ON_DIAL_PORT=<the dial's port> ON_DIAL_OUT=<a scratch folder> npx vitest run --config vitest.e2e.config.ts e2e/dialAppFilterOnDial.e2e.ts`. It prints the dial's firmware line and the lines to paste. `touch <out>/done` ends a run.
- Agents (the PM, answer 8): the suite's fake Claude Code, each started with `sh <out>/tab.sh <folder>` pasted in a real Ghostty tab or VS Code terminal tab. Each tab's own `TERM_PROGRAM` and `__CFBundleIdentifier` name its app. No Claude, Codex or Harness login is used.
- Harness Device, for check 3: the debug build (`(cd device-app/ui && npm ci && npm run build) && (cd device-app/src-tauri && cargo build --locked)`), started with `sh <out>/device.sh`, so its watch reaches the rig's daemon.
- Order:
  1. **Rig run 1, on the firmware the dial already has. Check 8:** note the firmware version the rig prints. Five agents (Ghostty 3, VS Code 2). The dial lists all five in one ring, as today; a hold on the face shows "TABS — No tabs yet.". End the run.
  2. With no daemon running, flash the branch's firmware by the repo procedure (the flag file, `esptool chip_id` says ESP32-S3, `idf.py -p <port> flash` of the `-DPROJECT_VER=0.1.0-dev` build, remove the flag).
  3. **Rig run 2. Check 1:** the same five agents. The dial opens on Ghostty. The face says "Ghostty". A swipe goes around Ghostty's three only.
  4. **Check 2:** hold → `APPS`: Ghostty `3 agents`, VS Code `2 agents`. Browsing changes nothing on the face behind. Pick VS Code: VS Code's two, in the order they started.
  5. **Check 3,** with the debug Harness Device app running: bring Ghostty to the front: the dial turns to Ghostty in about 1 s. Cmd-Tab across three apps and back within a second: nothing moves. Finder in front: nothing moves.
  6. **Check 4:** pick VS Code on the dial with Ghostty in front: it holds. Safari, then Ghostty, in front: the dial returns to Ghostty.
  7. **Check 5:** a VS Code agent asks for approval while the dial shows Ghostty: the bell rings; `APPS` says `2 agents · 1 waiting` on VS Code; opening the notice turns the dial to that agent.
  8. **Check 6:** a fake Claude Code in zellij inside Ghostty is in Ghostty's ring; its face says "Ghostty"; a tap says "See it in Zellij".
  9. **Check 7:** not run on the dial: opening the Harness desktop app would start and reach the everyday daemon. Its two halves are check 1 above (`a window opens: the tab's list and no apps`) and Task 18's host tests (`a hold with a window opens TABS`).
- Evidence: `<out>/daemon.log` of both runs (`[device] app filter: switched · …`, `[device] app filter: picker` and `cable: agents → N of M` lines), the rig's counts, and a photo of the face and of `APPS`.
- **Afterwards:** end the run and quit the debug app (the rig removes its throwaway root). Flash the released firmware back (`harness flash`), then run `harness start`. Check the dial lists the everyday daemon's agents, and tell the PM and the orchestrator the dial is free.
- Not done, for whatever reason: report check 4 as not verified, never as passed.
- On GitHub: none. It needs a real dial.

## Open questions

None. The draft's eight were answered by the PM on 2026-11-14:

1. **The core's change:** A. A new core file, `cli/src/core/dialFront.ts`, a line in `architecture.coreFiles.txt`, 100% per file (Tasks 8, 10).
2. **Windows:** A. macOS and Linux X11 now; the Windows source is a follow-up, and this plan has no Windows check.
3. **Rows the tables lacked:** kitty and WezTerm by bundle id, WezTerm by `TERM_PROGRAM` (kitty sets none), and `ai.autonomous.harness` (Tasks 2, 11, each row with its source). Cursor outside macOS is a follow-up.
4. **Two pages named "Terminal":** B. The unknown app reads "Other"; Apple's Terminal stays "Terminal" (Global Constraints; Tasks 2, 5, 17, 19).
5. **The picker's measure:** A. Each `app.pick` is counted (Tasks 5, 7).
6. **While a Harness window is open:** A. The filter keeps following the app in front (Tasks 5, 9, 19).
7. **The X11 check after this pull request:** B. It runs in PR CI's `device-app-checks` (Task 20); the temporary workflow is gone.
8. **The on-dial check's agents:** A. The suite's fake Claude Code against an isolated daemon, through an opt-in rig (Task 22).

Still waited on, outside this plan: the mockup's approval (Tasks 17 and 18), and the two unmerged dependencies (Task 1).

## Decided here, where the spec was silent

- The first app shown, when none was, is not counted as a switch. `empty` is an app replacing one that emptied.
- A pick of the shown app is answered with nothing; a pick of an app with no agents is answered with `apps` alone.
- After a notice turned the dial to an agent in another app, an agent the dial cannot bring forward (no `f`) is not "opened": no toast.
- An app with no bundle id, and an X11 window with no pid, are the empty value, which the watch sends as `none`.
- An XWayland `DISPLAY` under a Wayland session reports nothing.
- The measures are daemon log lines, as the notify tally and wave 1a's approvals are: `[device] app filter: switched · <cause>` and `[device] app filter: picker`.
- A new crate for Linux, `x11rb`.
- An agent the open scan found is in the unknown app (`terminal`, "Other") until its first hook event names its app. Its face line read "Terminal" before, from its host.
- **The rename** (answer 4 asked for the two to be kept apart): the front value for "no listed app in front" is `none`, not `other`. The unknown app keeps the id `terminal` and reads "Other". On macOS and Linux the dial reaches "Other" by a pick or as the default, never by following: an unknown terminal in front is `none`. The one row that gives the id `terminal` is `WindowsTerminal.exe`, which nothing sends yet; what Windows Terminal reads as is the Windows wave's to settle.
- **kitty off macOS:** kitty sets no `TERM_PROGRAM`, so with no bundle id and no `TERM_PROGRAM`, `KITTY_WINDOW_ID` names kitty as the outer app, also inside zellij (Task 2, step 4). It never decides against a bundle id or a `TERM_PROGRAM`.
- **`ai.autonomous.harness` is a row of both tables:** the front table (the question asked) and `detectApp`'s bundle table, so the two cannot disagree about one bundle id. `detectHost` does not change.
- **The `.exe` rows stay** in the front table, as answer 2's option A says, though nothing sends them until the Windows source exists.
- **The rig runs twice on the dial** (check 4): once on the firmware the dial has, once after the flash, because a daemon that holds the port cannot be flashed past.
