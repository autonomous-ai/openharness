# The dial's app filter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use diegodev phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With no Harness window, the round dial shows the agents of one app at a time (Harness, Orca, Ghostty, VS Code, …). A hold on the face picks another app, and the dial follows the app the person brings to the front on the computer.

**Architecture:**
- In the devices process each agent gets an `app` (its outermost app). The cable host keeps one ring per app (`AppRings`, built on `DialRing`) and one `AppFilter` that says which app is shown. A dial that greets with `appFilter: "v1"` gets the shown app's ring and an `apps` frame, and sends `app.pick` back. An older dial keeps the single ring.
- The Harness Device app learns which app is in front from the OS and writes it on the stdin of the `harness hardware watch --json` child it already runs. The watch maps the raw name to an app id and tells the devices process through the devices' own local listener (`{ type: 'front', app }`), where the filter settles it for 1 s. The core is not on this path and knows nothing of it (`cli/AGENTS.md`, Protect the core, rule 7; the PM, 2026-11-15).
- The devices listener (`cli/src/services/devicesListener.ts`) is shared: one private socket of the devices process, with a handler per message type. `front` is its first handler; #4296's follow-up registers `asked`, `inbox` and `observed` and changes nothing else.
- The round firmware says `appFilter` in `hello`, holds the `apps` it is sent, draws the shown app's name on the face, and opens `APPS` (the TABS carousel) on a hold in the machine view.

**Tech Stack:** TypeScript daemon and CLI (Node, vitest, `cli/`), Rust and Tauri 2 (`device-app/`, objc2 on macOS, x11rb on Linux), ESP-IDF 5.5.4 C firmware with Python host tests.

**Spec:** `docs/specs/2026-11-14-dial-app-filter.md` (as of `4126d89b25`). It stacks on the fixed ring (`fix/dial-swipe-order`, `6fd0344484`) and on wave 1a (`docs/plans/2026-11-13-device-claude-orca-plan.md`, PR #4296).

## State (2026-11-15)

- **Done, on `feat/dial-app-filter`:** Tasks 2 to 18, 20 and 23, each as a red commit and a code commit (its `Done:` line names the code commit). Since then, by the branch's log at `4126d89b25`: Task 24 (`29fe6b59e5`), 25 (`e69f212be2`), 26 (`c3cfa8c77f`), 27 (`4a861d2e36`), 28 (`1920db2d41`), 29 (`044d361a5e`), 19 (`ffe4b8b98d`), 21 (`27636d914b`) and 22 (`695eebd84e`).
- **Obsolete:** Task 1. The branch is stacked on `fix/dial-swipe-order` (`6fd0344484`), which sits on PR #4296 and on a `main` that deleted the Swarm (#4303).
- **Done since `4126d89b25`:** Task 30 (`6fdbfd918d`, red `5e6ff403bb`), 31 (`74445dd379`, red `34e4450420`; its own comm-last `ps`: `ea2482121c`, red `1c891a38dd`) and 32 (`142dfbf628`). Every task is done.
- **Final review fixes** (code commits, each after its red one):
  - The filter: `602a298b44` (decides on the agents there now), `e84dc051a8` (D1: the settled app in front is shown once it has known agents, unless a pick holds), `4d877de9e8` (D2: a pick or a notice of the shown app changes nothing, withdrawing `85ad59b619`), `2a18e8e497` (`AppFilter.stop` dropped).
  - The scan: `e975ce094a`, `dd8943f084`, `a3cdb88d67` (a bundle not read ends the walk with no answer), `31893376e1`.
  - The session: `8d36f5fb14`, `33d74d0cf4`.
  - The devices, the listener and the watch: `0298d66fe6`, `1e064d75bf`, `7ea98758f5`, `531d48900d`, `9d81f78407`, `87ebbf2386`, `e2a6080ac1`, `d2f8e21f35`.
  - Harness Device: `4f68167ac8`, `b410fa315d`, `921803c1d5`, `766db86b77`, `c27b13861f`, `e80be830a2`.
  - Firmware: `15515bbf64`, `cfffb3ac89`.
  - Docs: `4a21aab0ef`.
- **Decided by the PM, 2026-11-15:**
  1. The core knows nothing of the app in front (rule 7). Tasks 8, 9 and 10 are reverted (Task 24); the watch tells the devices through their own listener (Tasks 25 to 28).
  2. The Swarm is gone from `main`: no Buddy filter, no wait for Swarm cards, no Swarm-recap or badged-companion exception to the hold. The rebase already applied this in the code; this plan now says the same.
  3. "Hold to switch tabs" becomes "Hold to switch apps" where a hold opens `APPS` (Task 29).
  4. An agent the open scan found is **not known yet**, not "Other": it sits on Other's page and counts for nothing in the default (Task 30). The scan learns its app from its parent processes' executables where that is cheap (Task 31). **No process's environment is ever read** (Global Constraints).

## Start order

diegodev starts a task when the tasks it depends on are done and no running task shares its files.

| Task | Depends on | Shares files with |
|---|---|---|
| 24 Revert the core's part | none | 27 (`services/devices.ts`, `services/devicesProcess.ts` and their specs) |
| 25 The listener's path | none | none |
| 26 The devices listener | 25 | none |
| 27 The devices open the listener | 24, 25, 26 | 24 |
| 28 The watch tells the listener | 25 | none |
| 29 The hint "Hold to switch apps" | none | none |
| 19 End to end | 27, 28 | none |
| 21 Docs | 27, 28 | none |
| 22 The on-dial rig | 19, 27 | none |
| 30 Not known yet never wins the default | none (Tasks 2 to 5 are done) | 31 (`cable/hosts/observed.ts` and its spec) |
| 31 The scan learns the app from the parent processes | 30 (`appPending`, which a learned app ends) | 30 |
| 32 End to end: plugged in over agents already running | 30, 31 | none |

The rows above Task 30 are done and kept for the record. Longest chain still to run: 30 → 31 → 32 (the longest of the whole plan was 25 → 26 → 27 → 19 → 22).

## Layers

Every file this plan creates or changes, and the process it runs in (`cli/AGENTS.md`, master / core / services).

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/core/**`, `cli/src/localWsServer.ts`, `cli/src/architecture.coreFiles.txt` | **Core** (`harnessd-core`): **unchanged by this work.** Tasks 8 to 10 added to it; Task 24 takes all of it out | `git diff` against the base is empty for these paths; `architecture.spec.ts`; `npm run test:core` |
| `cli/src/cable/hosts/types.ts`, `hostDetect.ts`, `select.ts`, `appFilter.ts` (new), `observed.ts`, `harness.ts` | **Devices service process** (`harnessd-devices`) | Their specs |
| `cli/src/cable/hosts/scannedApp.ts` (new, Task 31) | **Devices service process**, and only there: which app a scanned session's parent processes name. It reads process ids, parent ids and executable names from the table the devices already read, and on macOS one `Info.plist` key of an app bundle. **Never an environment** | Its spec, with fakes for both reads |
| `cli/src/cable/cableHost.ts`, `cli/src/cable/cableSession.ts` | **Devices service process** | Their specs |
| `cli/src/services/devices.ts`, `cli/src/services/devicesProcess.ts` | **Devices service process** | 100% per file (`npm run test:core`) |
| `cli/src/services/devicesListener.ts` (new) | **Devices service process**, and only there: the devices' own private socket and its handlers. The core's process never opens it, also when the devices run inside it | 100% per file (`npm run test:core`); its security tests |
| `cli/src/devices/listenerPath.ts` (new) | Shared by the **devices service process** and the **CLI**: where the socket is. A pure helper; the core does not load it | Its spec |
| `cli/src/devices/listenerClient.ts` (new) | **CLI only**: one message to the devices listener, sent only to a socket that is this account's own | Its spec |
| `cli/src/cable/hosts/frontApp.ts` (new), `cli/src/devices/client.ts` | **CLI only**: the `harness hardware watch` process. The table sits next to `hostDetect.ts` as the spec says; the CLI, the listener's `front` handler and the scan's `scannedApp.ts` (Task 31, in the devices process) import it | Their specs |
| `device-app/src-tauri/src/front.rs`, `front_macos.rs`, `front_x11.rs` (new), `cli.rs`, `watch.rs`, `runner.rs`, `lib.rs`, `main.rs`, `testing.rs`, `tests/fake-harness`, `Cargo.toml`, `Cargo.lock` | **Harness Device app** (its own process, thin over the CLI) | `cargo test --lib`: PR CI on Linux, by hand on a Mac |
| `devices/harness-device/firmware/main/cable_client.c`, `cable_client.h`, `ui/ui_screens.h`, `ui/habitat/ui_habitat.c`, `ui/habitat/focus.c`, `ui/habitat/focus.h` | **Firmware**, round dial (OTA key `harness-device`) | `make device-test`, every `firmware/test/test_*.py` |
| `devices/harness-device/firmware/test/test_touch_ui.py`, `test_cable_identity.py`, `test_cable_outbound.py`, `test_character.c` | **Firmware** host tests | Themselves |
| `cli/e2e/dialAppFilter.e2e.ts`, `cli/e2e/harness/outsideAgent.ts` (new), `cli/e2e/harness/desk.ts`, `cli/e2e/deviceWithoutApp.e2e.ts` | Test: the real daemon, a fake dial, the real watch | `cli-e2e.yml` |
| `cli/e2e/dialAppFilterOnDial.e2e.ts` (new, opt-in) | Test rig: the isolated daemon on a real dial. It skips unless `ON_DIAL_PORT` is set | By hand, Verification check 4 |
| `.github/workflows/ci.yml` (`device-app-checks`), `scripts/tests/test_ci_plan.py`, `docs/validation-and-release.md` | PR CI: the X11 source, live under Xvfb | `process-checks` (`scripts/tests`) |
| `cli/AGENTS.md`, `cli/src/services/AGENTS.md`, `device-app/AGENTS.md`, `docs/specs/2026-11-13-device-without-the-app.md` | Repo files, no process | none |

What this fixes, by layer:
- **The core never** hears of the app in front, in any form: no frame, no port member, no feature name, no file, no line of `architecture.coreFiles.txt`. Delete the devices and nothing is left in the core to take out.
- **The devices listener** takes one of 16 fixed words (the 15 app ids, `claude` among them (Task 23), and `none`), at most 10 a second per connection, on a socket only this computer's owner can open.
- **The raw name** (a bundle id, an exe name) exists only in the Harness Device app and in the `harness hardware watch` process. The devices are told an app id.
- **Which app is shown, the rings and the settle timer** live in the devices process, in memory only.
- **Where a scanned session runs** is worked out in the devices process from executable names alone. Nothing of a process is kept but the app id it gave: no name, no path, no argument, and never an environment.
- With `HARNESSD_SERVICES=none` (debugging) and on Harness OS the devices service runs inside the core's process, as every service does there. There is no devices process then, so no listener is opened: the dial filters by app and takes a pick, and does not follow the app in front.

## Base

The branch is stacked on `fix/dial-swipe-order` (`6fd0344484`), which holds `DialRing` and sits on PR #4296. "The base" below is `git merge-base HEAD fix/dial-swipe-order` today, and `origin/main` once both have merged. The marks **⚠ design-only** and **⚠ #4296** in the done tasks are history: their code is written against the real names. Line numbers in the done tasks are from before the rebase.

## External gate: mockup approved

A mockup of the `APPS` picker and of the face's app line is made by the main session in the main checkout's `devices/harness-device/mockup/` and reviewed by Diego. It is not a task of this plan. **Approved by Diego, 2026-11-14:** `/Users/duynguyen/go/src/github.com/autonomous-ai/autonomous-harness/devices/harness-device/mockup/dial-app-filter/index.html` (gitignored; its "today" images are `test_touch_ui.py` renders). Tasks 17 and 18 draw exactly what it shows and wait only for their dependencies. The unknown app's page and face line read "Other" (the PM, answer 4).

## Global Constraints

- **Apps.** The fixed set is the host ids `hostDetect.ts` names: `harness`, `orca`, `herdr`, `rex`, `zellij`, `kitty`, `wezterm`, `iterm`, `terminal-app`, `ghostty`, `vscode`, `cursor`, `warp`, `terminal`, and `claude` (Task 23): 15, at most 16. An unknown app is `terminal`. An agent's `app` is its outermost app; `host` stays the nearest host, for caps and "See it in …".
- **Two names that must not meet** (the PM, answer 4).
  - **The unknown app** is the app id `terminal` (`UNKNOWN_APP`): an agent in a terminal the daemon does not know. In `apps` its `name` is **"Other"**. Apple's Terminal (`terminal-app`) stays "Terminal". Reason: `docs/naming-system.md` defines Terminal ("A shell for entering commands") and neither defines nor forbids Other, so two pages no longer share one name. `hostDisplayName('terminal')` stays "Terminal" for "See it in Terminal".
  - **No listed app in front** is the front value `none` (`FRONT_NONE`): Safari, Finder, an app with no name. **Renamed here:** the spec's first word for it was `other`; the app id keeps its name and the front value changed, because the front value was new everywhere and the app id is the one `detectHost` already gives. `none` is not an app id, never has agents, and is never shown. The words `other` and `Other` are no id and no front value: "Other" travels only as the `name` of the `terminal` entry in `apps`.
- **Rings.** One per app, at most 16 agents, the swipe-order rules inside each. A ring is dropped when its app has no agents. The rings see every agent on this computer, in the registry's list as it is (the Buddy filter and the wait for Swarm cards went with the Swarm).
- **Shown app.** No "All". Default: the app in front if it has agents, else the app with the most agents; a tie is drawn once and held while the counts stay the same. The app in front is followed after it has stayed in front for 1 s. An app in front with no agents, and `none`, change nothing. A pick on the dial holds until another app settles in front. With a Harness window the dial is sent none of it and a pick is ignored; the filter still follows the app in front (the PM, answer 6), so the dial shows it when the window closes.
- **Not known yet is not "Other"** (the PM, 2026-11-15). An agent the open scan found, which no hook has told of and whose parent processes named no app, is **not known yet**. It sits on the unknown app's page and in its ring (`app` stays `terminal`), so it can be reached, picked and opened from a notice, and `apps` counts it there. It counts for nothing in the default: the default and the tie draw count known agents only, and a page whose agents are all not known yet is the default only when no app has a known agent. A pick or the front can still show it. Its first hook, with or without hints, makes it known: an agent a hook put in `terminal` is known to be in "Other".
- **The scan learns the app where that is cheap** (the PM, 2026-11-15). Once for each session the scan newly finds, from one read of the process table by the scan's own `ps -axo pid=,ppid=,comm=` (`comm` last, so macOS prints the whole path, not 16 characters), run only on a scan with sessions whose app is not known yet: the session's process, then its parents by `ppid`, at most 16, each by its **executable's name or path and nothing else**. macOS: the outermost `.app` folder of the path, whose bundle id comes from that app's `Info.plist`. Linux: the executable's name. Both go through the tables that exist (`BUNDLE_APPS`, the front table). The nearest process that names a listed app decides; one that names none is passed over. **The scan never answers "Other":** no listed app found is not known yet, and waits for the first hook. No new permission, no polling, no second try. Windows waits for the first hook.
- **Never read another process's environment** (the PM, 2026-11-15, a hard rule). No `ps eww`, no `ps -E`, no `/proc/<pid>/environ`, nothing equivalent, in code, in a test, in a measurement or by hand "to check it works": not even to read and discard at once. An environment holds secrets (`ORCA_PAIRING_CODE`, `ORCA_AGENT_SESSION_SPAWN_TOKEN`, API tokens). The repo has such a reader for the core's own panes (`cli/src/lib/processEnv.ts`); nothing this plan adds imports or calls it, and a test says so (Task 31). A process's command line is not read by this work either, and its name is outside text: a process can write anything there (a session's title, a prompt), so it is matched and dropped, never kept, logged or sent.
- **Wire.** `hello.appFilter: "v1"`. Host → dial `apps`: `{ shown, apps: [{ id, name, count, waiting }] }`, at most 16 entries, in a fixed order, in the machine view only, coalesced with the machine list's 1 s. Dial → host `app.pick`: `{ app }`. A dial without `appFilter` gets the single ring and no `apps`. An older daemon sends no `apps`, and the new firmware's hold then opens TABS.
- **Front.** The Harness Device app writes `{"front":"<bundle id or exe name>"}` on the watch's stdin, only on a change, cut to 128 characters. The watch sends `{ type: 'front', app }` to the devices listener. With no listener (an older daemon, the devices process not running, Windows) it ignores the line and tries again on the next change.
- **The devices listener** (the PM, 2026-11-15). A Unix socket `devices.sock` in the data folder (a short folder under the home when that path is too long for a socket), mode 0600, opened only by the devices process and only while it runs. Handlers are registered by message type, each with its own body limit and rate limit. An unknown type, a body over its limit and a message over its rate are dropped and counted, never echoed or logged with their content. `front` takes `app` only from the fixed set or `none`, at most 10 a second per connection, keeps nothing and logs no app name. Windows has none yet (its named pipe comes with the Harness Device app for Windows).
- **The core is not touched.** Nothing under `cli/src/core/`, `cli/src/localWsServer.ts` or `cli/src/architecture.coreFiles.txt` differs from the base when this work ends.
- **Privacy.** Which app is in front goes only from the Harness Device app to the devices process: never to the core, the backend, the phone, the gateway, a file or a log. The log line is `app filter: switched` and never names an app. Measures carry a cause and no app name or agent id.
- **Memory only.** The pick, the rings and the app in front are never written to disk or to the dial's NVS.
- **Needs-you elsewhere (decision 7, A).** The bell and inbox count every agent on this computer. A notice opened from the inbox turns the dial to the agent and its app, and counts as a pick.
- **No polling.** The OS tells the app when the front changes: no timer, no osascript, no System Events, no Accessibility or Screen Recording permission.
- **Platforms** (the PM, answer 2). The app in front is read on macOS and Linux X11. On Windows the dial filters by app and takes a pick, and follows nothing until the Windows source exists.
- **Out of scope (follow-ups):** Harness Desktop reporting the app in front; the Windows source of the app in front, with the wave that builds the Harness Device app for Windows; Cursor outside macOS (its agents say `TERM_PROGRAM=vscode` there); the scan learning the app on Windows (a dead parent's pid can be another process's there, and the devices read no process table on Windows today) and for a session whose terminal hands its shells to a process of launchd's or init's (tmux, zellij, herdr, and iTerm2 by default): each waits for its first hook (Task 31, Open question 4); Wayland; a setting to turn the filter off; Harness Pro (never edit `devices/harness-pro`).
- **Repo rules.** Tests never touch the developer's real `~/.claude`, `~/.codex`, daemon (port 18473), tmux or dial. No fixed sleeps: fake timers, or a wait on a condition. Firmware dev builds use `-DPROJECT_VER=0.1.0-dev`; flash only by the repo procedure (quit Harness, flag file, `harness stop`, chip check).

## Review Focus

1. **An agent whose app changes.** The open scan lists a session on the unknown app's page, not known yet, until its parent processes or its first hook say where it runs, and a session can be resumed in another terminal. It must leave its old ring, join the new app's at the end, and the counts (all agents, and known agents) must follow. Covered in Task 3 (`an agent whose app changes leaves its ring and joins the other at the end`) and Task 30 (`an agent that becomes known joins its app's ring at the end, and its known count`).
2. **A burst of front changes** (Cmd-Tab held down, a daemon flooded by a broken tool). One timer, one settle, a bounded rate. Covered in Task 4 (`fifty changes inside a second leave one timer and settle once`) and Task 26 (`the 11th front within a second on one connection is dropped; another connection's is taken`).
3. **The list moving under the finger.** The picked app's last agent ends while the picker is open. Covered in Task 6 (`a pick of an app with no agents sends apps again and no ring`) and Task 18 (`a push while open keeps the app by id`).
4. **Two dials on one computer, one old and one new.** Each gets its own list, and a pick on one moves the other new dial. Covered in Task 5 (`asked without apps it is the single ring; asked with, the shown app's`) and Task 6 (`a dial without appFilter is sent no apps frame`).
5. **A watch that starts after the app is already in front.** Without the first value the dial follows nothing until the next app switch. Covered in Task 13 (`a new watch is told the app in front once`) and Task 28 (`a front line is told at once, before the daemon has answered`). **Not covered, by the spec's own rule:** a devices process that starts after the watch (a dial plugged in later) hears nothing until the next app switch (Open question 2).
6. **A socket that is not the owner's.** Another account's process, or a file put where the socket should be, must neither reach the listener nor be sent the app in front. Covered in Task 26 (`the socket is 0600`, `a folder that is not this account's own is refused`) and Task 28 (`a socket of another account, or one looser than 0600, is told nothing`).
7. **The end-to-end test that timed out once: `a dial plugged in while VS Code is already in front (the watch started first) is sent VS Code's ring`** (`cli/e2e/dialAppFilter.e2e.ts`, as of `ffe4b8b98d`; cause unknown). A flaky test is a bug (`AGENTS.md`, Code standards 3). **The final review must find its cause** and show it with evidence: the failing run's daemon log and frames, or a run that reproduces it. A longer timeout, a retry or "it passed again" is not a finding. Task 32 turns this test (its agents no longer type a prompt), which can hide the cause without removing it, so the review looks at the test as it was at `ffe4b8b98d` too. Two leads, neither proven: (a) the watch tells its app once when `dial_status` turns attached, and a tell the listener did not take is not tried again (`cli/src/devices/client.ts`, "A tell not taken is not tried again by itself"), so an attach heard before `[devices] listener open` leaves the devices never told; (b) a prompt typed into a fake engine that was not yet at its prompt. If the cause is in the product (lead a is), the fix is a task of its own with a red test at the layer where it lives, before the pull request.
8. **A dial plugged in over agents nobody has heard from, some of which then speak.** Diego's morning: the first list holds only agents not known yet, so their page is shown; then hooks name apps one by one. The dial must not stay on "Other" while a known app has agents, and must not move once the person has picked. Covered in Task 30 (`that default gives way once an app has a known agent`, `a pick of the page of agents not known yet holds`). The rule for it is the plan's reading of the spec (Open question 3).
9. **A process name that is not a name.** `ps` prints whatever a process wrote over its own name: a session's title, a prompt, a path with `..` in it. The scan must match it and drop it, read no file it points at outside the four folders, and never log it. Covered in Task 31 (`a process name that is not a path is passed over`, `a bundle outside the four folders is not read`, `nothing of a process is kept or said`).
10. **A scan on a busy or broken machine.** `ps` times out, a bundle's `Info.plist` cannot be read, fifty sessions sit under twenty apps, a parent chain loops. The scan must still list every session, each not known yet where nothing was learned, within its bounds. Covered in Task 31 (`a process table that cannot be read leaves every session not known yet, and listed`, `at most 16 bundles a pass`, `a walk stops after 16 parents, and at a loop`).
11. **The suite run from a real terminal.** An end-to-end agent started before the dial, with no fake app above it, has the developer's own terminal as a parent: the scan would learn that app on a Mac and nothing on a runner. Covered in Task 32 (every such agent gets a fake app, and a grep proves no other test reads `apps` for one that has none).

---

### Task 1: Rebase on `main` once both dependencies have merged

**Obsolete** (2026-11-15): not run. The branch was stacked on `fix/dial-swipe-order` (`6fd0344484`) instead, and the tasks were written against its real names (§ Base). Every "Depends on: Task 1" below is met.

**Layer:** none. **Depends on:** `fix/dial-swipe-order` and PR #4296 merged to `main` (external). **Effort:** `medium`. **Red test:** none: no behavior (workflow).

**Files:** none of its own.

- [ ] **Step 1:** Confirm both are on `main` (`gh pr view 4296 --json state`; the swipe-order pull request the main session names). If either is open, stop and report.
- [ ] **Step 2:** `git rebase origin/main` on `feat/dial-app-filter`.
- [ ] **Step 3:** Read the merged `cli/src/cable/hosts/select.ts` and `cli/src/cable/cableHost.ts`. Report the real names of everything this plan marks **⚠ design-only** and **⚠ #4296**, so the main session can correct the tasks before they are dispatched.
- [ ] **Step 4:** `cd cli && npm run typecheck && npx vitest run src/cable src/services/devices.spec.ts`. Expected: PASS, as on `main`.

### Task 2: Each agent's app

**Done:** `a62d2c2642` (red: `ba2cab39be`).

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

- [x] **Step 1: Write the failing tests.**
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
- [x] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts`. Expected: FAIL (`detectApp` missing, `app` undefined).
- [x] **Step 3: Implement.** Add `app` to the other files' `HostAgent` literals so `npm run typecheck` passes.
- [x] **Step 4: Run** the step 2 command and `cd cli && npm run typecheck`. Expected: PASS.
- [x] **Step 5: Commit** `devices: each agent's outermost app, beside its nearest host`.

### Task 3: One ring per app

**Done:** `15aedfd288` (red: `6eb62e9b65`).

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

- [x] **Step 1: Write the failing tests:**
  - `one ring per app, each over its own agents only`.
  - `inside a ring the order is fixed: a state change moves nobody, a new agent goes to the end, an ended one closes up` (the swipe-order rules, on one app while another app's agents change).
  - `each ring holds at most 16; total is the app's count` (20 agents in one app, 3 in another).
  - `a ring is dropped when its app empties, and the app starts a new ring when it comes back` (the new ring is in the registry's order, not the old one).
  - `the apps keep their order: a new app at the end, a gone app closes up`.
  - `count and waiting follow the agents`.
  - `an agent whose app changes leaves its ring and joins the other at the end`.
  - `the map is bounded: 20 agents with 20 unknown app ids make one terminal ring`.
- [x] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/select.spec.ts`. Expected: FAIL (`AppRings` missing).
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** the step 2 command. Expected: PASS, the swipe-order tests of `DialRing` untouched.
- [x] **Step 5: Commit** `devices: one fixed ring per app`.

### Task 4: Which app is shown

**Done:** `f84efcac74` (red: `bf176568d6`).

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
  - `pick(app, cause = 'pick')`: an app with no agents → `'ignored'`; the app shown, by a pick or a notice → `'same'`, and nothing changes: no hold, no switch (the PM, 2026-11-15, D2: Done on the shown app is how a person leaves the picker); else `shown` becomes it, `pickedOnDial` is set → `'switched'`.
  - `switched(cause)` is called once for each change of `shown` from one app to another: `front`, `pick`, `notice`, or `empty` (rule 1 replacing an app that emptied). The first app shown, when none was, is not a switch.
  - `stop()` cancels the timer.

- [x] **Step 1: Write the failing tests** with a fake `after` and a scripted `random`:
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
- [x] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/appFilter.spec.ts`. Expected: FAIL (module missing).
- [x] **Step 3: Implement.** No `setTimeout`, `Date` or `Math.random` in the file: everything comes through `deps`.
- [x] **Step 4: Run** the step 2 command. Expected: PASS.
- [x] **Step 5: Commit** `devices: which app the dial shows: the one in front, a pick, or the biggest`.

### Task 5: The cable host: the shown app's ring, the app list, a pick, the front

**Done:** `d27a5e64a6` (red: `fa9996b5e3`).

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
  - `machineSnapshot` takes the registry's list as it is: every agent on this computer (the Buddy filter and the wait for Swarm cards went with the Swarm, #4303). Asked without `apps`: today's single ring, unchanged. Asked with `apps: true`: it updates the rings with those agents, reads `filter.shown()`, and answers the shown app's rows, `total` = that app's count, and `apps: { shown, apps }` with each entry's `name` from `appDisplayName(id)`. With no agents: `apps: { shown: '', apps: [] }`, no rows, `total: 0`.
  - With a window (the windows' tab list is set: `swarms !== null`, the port's name for it) or no registry: the answer is today's, with no `apps`, whatever `opts` says.
  - `pickApp` with a window is `'ignored'`. `appOf` is the machine list's agent's `app` (`onMachine(agentId)` ⚠ #4296), `undefined` with a window.
  - `front(app)` hands the app to the filter, with or without a window (the PM, answer 6): the filter keeps following while a window is open, and only the dial does not show it.

- [x] **Step 1: Write the failing tests:**
  - `asked without apps it is the single ring; asked with, the shown app's` (Ghostty 3, VS Code 2: with `apps`, three rows, `total: 3`, `apps.shown: 'ghostty'`; without, five rows and no `apps`).
  - `the app list: fixed order, display names, count and waiting` (`{ id: 'vscode', name: 'VS Code', count: 2, waiting: 1 }`).
  - `the unknown app is named Other and Apple's Terminal is named Terminal` (agents in `terminal` and `terminal-app`: `{ id: 'terminal', name: 'Other', … }`, `{ id: 'terminal-app', name: 'Terminal', … }`).
  - `the front is followed while a window is open: when it closes, the app that settled in front meanwhile is shown` (Ghostty shown; a window opens; `front('vscode')` settles; the window closes → `apps.shown: 'vscode'`).
  - `a pick switches the list and holds through a count change`; `a pick of an app with no agents is ignored`.
  - `the app in front is shown 1 s later` (a scripted `appTimer`); `appSwitched hears front once`.
  - `two reads in a row give the same shown app and the same order`.
  - `with a window: the tab's list exactly as before, no apps, and a pick is ignored`.
  - `appOf is the agent's app in the machine view, undefined with a window`.
  - `no agents: shown is empty and nothing is listed`.
  - `appPicked is told once for each pick, and not for a notice`.
- [x] **Step 2: Run** `cd cli && npx vitest run src/cable/cableHost.spec.ts`. Expected: FAIL.
- [x] **Step 3: Implement.** Update the doc comment above `listAgents` (:670): the "no window" answer for a dial that says `appFilter` is one app's ring.
- [x] **Step 4: Run** the step 2 command and `cd cli && npm run typecheck`. Expected: PASS.
- [x] **Step 5: Commit** `dial: the machine list is the shown app's ring for a dial that asks for it`.

### Task 6: The dial's session: `appFilter`, `apps`, `app.pick`, a notice across apps

**Done:** `9eca48b8ec` (red: `ab386740fe`).

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
  - `agent.open` with no `reason` (a tapped notice), from a dial that said `appFilter`, for an agent whose `appOf` is defined: `pickApp(app, 'notice')`. There is no other condition: the "not a Swarm Lead or Buddy" one went with the Swarm. On `'switched'`: `desiredFocus` becomes the agent, then a forced push, which re-asserts the focus when the new ring holds the agent. After a switch an agent without `f` is not opened (the dial is on its face; no "did not open it" toast). An agent with `f` is opened as today. On `'same'` or `'ignored'` everything is as today.
  - `agent.open` with `reason: 'question'` never picks an app.

- [x] **Step 1: Write the failing tests:**
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
- [x] **Step 2: Run** `cd cli && npx vitest run src/cable/cableSession.spec.ts`. Expected: FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** the step 2 command and `cd cli && npm run typecheck`. Expected: PASS.
- [x] **Step 5: Commit** `dial: apps and app.pick for a dial that says appFilter, and a notice opens its agent across apps`.

### Task 7: The devices' wiring: a switch is logged, pushed and reminded

**Done:** `98bbef7522` (red: `7f1addc962`).

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

- [x] **Step 1: Write the failing tests:**
  - `a switch logs "[device] app filter: switched · pick" and no app id or name` (the whole log is read: no `vscode`, `VS Code`, `ghostty`, `Ghostty`).
  - `a switch pushes the list to the dials at once`.
  - `after a switch each mid-turn agent of the new ring is told again`.
  - `the picker's use is one log line with no app in it`.
  - `the settle timer is guarded: a filter that throws is logged and the devices keep running`.
  - `the timer is cancelled when the service stops`.
- [x] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts`. Expected: FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** `cd cli && npm run test:core && npm run typecheck`. Expected: PASS, 100% for `services/devices.ts`.
- [x] **Step 5: Commit** `devices: a change of the shown app is logged by its cause, pushed and reminded`.

### Task 8: Core: check and bound a `dial_front`

**Done:** `ea6b817e24` (red: `e89a64d4fc`). **Reverted by Task 24** (the PM, 2026-11-15, rule 7): the file and its spec are deleted. The text below is history.

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

- [x] **Step 1: Write the failing tests:**
  - `forwards a known app and none` (`terminal`, the unknown app's id, is a known app).
  - `refuses`: a non-object, no `app`, a number, `''`, `Ghostty` (a name, not an id), `com.mitchellh.ghostty` (a raw value), `other` and `Other` (neither is an id or a front value), a 5000-character string.
  - `the 11th frame within a second is dropped; another connection's is kept`; `a second later ten more pass`; `a clock set back refills nothing`.
  - `forward false is dropped, not an error`.
  - `the minute's line has counts and nothing of what was sent` (the log is read for the refused value).
  - `keeps nothing`: the returned object and its connections have no field holding an app after a forward.
- [x] **Step 2: Run** `cd cli && npx vitest run src/core/dialFront.spec.ts`. Expected: FAIL (module missing).
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** the step 2 command, then `cd cli && npm run test:core`. Expected: PASS, 100% for `core/dialFront.ts`.
- [x] **Step 5: Commit** `core: check and bound the app in front before it goes to the devices`.

### Task 9: The devices' port takes the app in front

**Done:** `82d30fa91f` (red: `84c62eb4ee`). **Reverted by Task 24** (the PM, 2026-11-15, rule 7): `DevicesPort.front`, its fallback, the link's `front` event, `heard.front` and the port's `front` member in `services/devices.ts` all go. What stays is `DaemonCableHost.front` (Task 5) and the call that guards it, `part.call('dial', () => cableHost.front(app))`, which Task 27 makes the body of the listener's `front` handler. The text below is history.

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

- [x] **Step 1: Write the failing tests:**
  - `api.spec.ts`: `the front's fallback is false`.
  - `devicesLink.spec.ts`: `front is one event on the link`; `with the devices down it answers false and nothing is queued`.
  - `devicesProcess.spec.ts`: `a front event reaches the port`; `a front that is not a string reaches it as ''`.
  - `devices.spec.ts`:
    - `the app in front becomes the shown app 1 s later, and the dial is pushed apps`.
    - `a front with a window open moves nothing on the dial`.
    - **Privacy:** `across a run with front changes, nothing but the dial's own frames holds the app in front`. Agents in Ghostty and VS Code; `port.front('ghostty')`, `'none'`, `'vscode'`, each settled. Every log line, and every call the devices made on the core's API, the windows, the fleet and the gateway, is read: none matches `/ghostty|vscode|VS Code/i`, and no argument of a call is the front value `none`. The dial's `apps` frames do name the shown app.
    - `the inline port takes a front too`.
- [x] **Step 2: Run** `cd cli && npx vitest run src/core/api.spec.ts src/core/devicesLink.spec.ts src/services/devicesProcess.spec.ts src/services/devices.spec.ts`. Expected: FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** `cd cli && npm run test:core && npm run typecheck`. Expected: PASS, 100% for the four files.
- [x] **Step 5: Commit** `devices: the app in front, from the core's port to the filter`.

### Task 10: The local socket's `dial_front`

**Done:** `e3cbfdfc22` (red: `e9678f8eca`). **Reverted by Task 24** (the PM, 2026-11-15, rule 7): `dial_front`, the `dial-front` feature, the wiring in `core/main.ts` and the line in `architecture.coreFiles.txt` all go. The text below is history.

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

- [x] **Step 1: Write the failing tests** in `localWsServer.spec.ts`:
  - `a tool is told dial-front among its features` (`['openclaw-local', 'dial-watch', 'dial-front']`).
  - `dial_front from a tool that watches the dial reaches its gate with the payload`.
  - `dial_front from a window, from a tool that did not ask for the dial, and on a relayed machine reaches no gate and no backend`.
  - `each watching connection gets a gate of its own`.
  - `with no dialFront option the frame is dropped`.
- [x] **Step 2: Run** `cd cli && npx vitest run src/localWsServer.spec.ts`. Expected: FAIL.
- [x] **Step 3: Implement.** The block in `localWsServer.ts` is the check of who sent it and one call; every other rule is in `core/dialFront.ts`. The pull request says why every session's core loads that file: the local socket is the core's, and what a tool sends on it is checked before it reaches a component.
- [x] **Step 4: Run** the step 2 command, then `cd cli && npm run test:core && npx vitest run src/architecture.spec.ts && npm run typecheck`. Expected: PASS.
- [x] **Step 5: Commit** `core: a dial watch may say which app is in front`.

### Task 11: The front table

**Done:** `8835a1209a` (red: `0114b2de47`). Task 24 changes its last test: `FRONT_APPS` goes with `core/dialFront.ts`.

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

- [x] **Step 1: Write the failing tests:**
  - `every bundle id maps to the id detectApp gives for it` (every row, kitty's, WezTerm's, Harness Desktop's and Claude's among them, each also run through `detectApp({ __CFBundleIdentifier })`).
  - `Code.exe, Cursor.exe, WindowsTerminal.exe, wezterm-gui, kitty and ghostty map` (`CODE.EXE` too).
  - `an unknown app, the empty string and a 128-character string are none` (`com.apple.Safari`, `org.alacritty`, `net.kovidgoyal.kitty-quick-access`).
  - `no value maps to the words other or Other, and none is no app id` (`FRONT_NONE` is not in `APP_IDS`; `frontAppId('other')` and `frontAppId('Other')` are `none`).
  - `every id the table can give is in FRONT_APPS, and FRONT_APPS is APP_IDS and FRONT_NONE` (the core's list and the devices' list cannot drift).
- [x] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/frontApp.spec.ts`. Expected: FAIL (module missing).
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** the step 2 command. Expected: PASS.
- [x] **Step 5: Commit** `hardware watch: which app a bundle id or an exe name is`.

### Task 12: `harness hardware watch` reads the app in front

**Done:** `7f608ce279` (red: `72a836ffe2`). **Changed by Task 28** (the PM, 2026-11-15): the watch tells the devices listener, and sends the core nothing of the app in front. Reading stdin, the line limits and `frontAppId` stay.

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

- [x] **Step 1: Write the failing tests:**
  - `a front line becomes dial_front with the app id` (`{"front":"com.mitchellh.ghostty"}` → `{ app: 'ghostty' }`; `{"front":"Code.exe"}` → `{ app: 'vscode' }`).
  - `an unknown app is sent as none`.
  - `the raw value is never sent or printed`: every frame the fake socket was sent, and every `print` and `printError`, is read for the bundle id and the exe name.
  - `the same app twice sends one frame; Safari then Finder sends one none`.
  - `a front line that arrives before connected is sent once after it`.
  - `with a daemon that has no dial-front, front lines send nothing`.
  - `a line in two chunks is one line; a 2000-byte line and a line that is not JSON are dropped, and the next line still works`.
  - `dial status lines print as before, and stdin closing still exits 0`.
- [x] **Step 2: Run** `cd cli && npx vitest run src/devices/client.spec.ts`. Expected: FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** the step 2 command and `cd cli && npm run typecheck`. Expected: PASS.
- [x] **Step 5: Commit** `hardware watch: tell the daemon which app is in front, as an app id`.

### Task 13: Harness Device: the app in front goes to the watch's stdin

**Done:** `0f1cf140c6` (red: `b4d1056b1a`).

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

- [x] **Step 1: Write the failing tests:**
  - `front.rs`: `one_line_per_change_and_none_for_a_repeat`; `a_value_is_cut_to_128_characters` (ASCII, and a multi-byte name cut on a boundary); `a_quote_or_a_newline_stays_one_json_line`; `no_front_reports_nothing`.
  - `cli.rs`: `a_writer_reaches_the_child_and_stops_when_stdin_is_closed`.
  - `watch.rs`: `a_front_line_reaches_the_watch` (`@record`; `fake.stdin()` is the line).
  - `runner.rs`, with a fake `FrontSource`: `the_app_in_front_is_written_to_the_watch`; `a_new_watch_is_told_the_app_in_front_once`; `a_repeat_writes_nothing`; `nothing_of_the_front_is_logged` (after a run with a value, a repeat and a write to a watch that has ended, no line of the `MemoryLog` holds the value).
- [x] **Step 2: Run** `cd device-app/src-tauri && cargo test --lib`. Expected: FAIL (does not compile: `front` is missing).
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** `cd device-app/src-tauri && cargo test --lib`. Expected: PASS, on Linux (PR CI) and on a Mac.
- [x] **Step 5: Commit** `Harness Device: write the app in front on the watch's stdin, and nowhere else`.

### Task 14: Harness Device: the app in front on macOS

**Done:** `32bfece710` (red: `eee547f99b`).

**Layer:** Harness Device app. **Depends on:** Task 13. **Effort:** `high`.

**Files:**
- Create: `device-app/src-tauri/src/front_macos.rs`
- Modify: `device-app/src-tauri/src/front.rs` (`system()`), `lib.rs`, `device-app/src-tauri/Cargo.toml`, `Cargo.lock`
- Test: in `front_macos.rs` (`#[cfg(target_os = "macos")]`)

**Interfaces:**
- Consumes: `FrontSource` (Task 13).
- Produces: `struct MacFront` implementing `FrontSource`: `NSWorkspace.frontmostApplication` once at `start`, then an observer of `NSWorkspaceDidActivateApplicationNotification` on the workspace's notification centre. The value is the app's `bundleIdentifier`, or the empty string when it has none. `system()` gives it on macOS.
- Rules: no timer, no `osascript`, no System Events, no Accessibility or Screen Recording. The objc2 crates gain only the features the observer needs (the notification, its block); the pull request lists them.

- [x] **Step 1: Write the failing tests:**
  - `an_app_with_no_bundle_id_is_the_empty_value` (the pure helper that turns an optional bundle id into the value).
  - `start_tells_the_app_in_front_once` (`start` calls `changed` exactly once before it returns, with at most 128 characters).
  - `system_is_the_appkit_source_on_macos`.
- [x] **Step 2: Run** on a Mac: `cd device-app/src-tauri && cargo test --lib front_macos`. Expected: FAIL (module missing).
- [x] **Step 3: Implement.** Start it where the app's `setup` runs, on the main thread (check `main.rs` at dispatch).
- [x] **Step 4: Run** `cd device-app/src-tauri && cargo test --lib` on a Mac. Expected: PASS. PR CI does not compile this file.
- [x] **Step 5: Commit** `Harness Device: the app in front on macOS, from NSWorkspace`.

### Task 15: Harness Device: the app in front on Linux X11

**Done:** `4fccb20e7c` (red: `5146cd3872`).

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

- [x] **Step 1: Write the failing tests:**
  - `the_exe_name_is_the_file_name_of_the_proc_link` (a temp folder shaped like `/proc`); `a_process_that_is_gone_has_no_name`.
  - `a_wayland_session_is_not_x11` (the table of the three variables, XWayland's `DISPLAY` under Wayland included).
  - `x11_live`, `#[ignore]` (it needs an X server, a window manager and `xdotool`): it waits, up to 10 s, for the root window's `_NET_SUPPORTED` to list `_NET_ACTIVE_WINDOW` (the window manager is up), starts the X clients named in `X11_LIVE_CLIENTS` (two paths), activates each with `xdotool`, and waits on the source, with a 10 s deadline each, for each client's exe name in order. It ends its clients. Every wait is on a condition. Task 20 runs it in PR CI.
- [x] **Step 2: Run** on Linux: `cd device-app/src-tauri && cargo test --lib front_x11`. Expected: FAIL (module missing).
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** `cd device-app/src-tauri && cargo test --lib --locked`. Expected: PASS; `x11_live` is listed as ignored. On a Mac this file is not compiled: its first run is Task 20's, on a runner.
- [x] **Step 5: Commit** `Harness Device: the app in front on Linux X11, from _NET_ACTIVE_WINDOW`.

### Task 16: Round firmware: `appFilter` in `hello`, `apps` in, `app.pick` out

**Done:** `507119d2d5` (red: `1150823726`).

**Layer:** firmware. No drawing, so the mockup does not gate it. **Depends on:** Task 1. **Effort:** `high`.

**Files** (under `devices/harness-device/firmware/`):
- Modify: `main/cable_client.c` (`send_hello` :250, a new `handle_apps` and its line in the frame switch :1359-1540, a new `cable_client_pick_app`, `session_up` / the session's end), `main/cable_client.h`, `main/ui/ui_screens.h`, `main/ui/habitat/ui_habitat.c` (the state :233, two setters beside `ui_fleet_set_view` :4203)
- Test: `test/test_cable_outbound.py` (`send_hello` and `app.pick`; `test_cable_supertab.py` was deleted with the Swarm), `test/test_cable_identity.py` (the parse), `test/test_touch_ui.py` (the state; its copy of the struct :82 and its function lists :240, :251)

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

- [x] **Step 1: Write the failing tests:**
  - `test_cable_identity.py`: `two apps and shown are handed on`; `the 17th entry is dropped`; `an id of 16 characters is dropped, not cut`; `a count of 5000 is 999`; `apps with no array is an empty list that is still known`.
  - `test_cable_outbound.py`: `hello has appFilter v1`; `app.pick carries the app`; `a failed allocation sends nothing`.
  - `test_touch_ui.py`: `ui_apps_replace holds the apps and the shown one`; `ui_apps_forget makes them unknown`.
- [x] **Step 2: Run** `IDF_PATH=~/esp/esp-idf-5.5.4 python3 devices/harness-device/firmware/test/test_cable_outbound.py` and the two others the same way. Expected: FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** `env -u IDF_PATH make device-test` and every `devices/harness-device/firmware/test/test_*.py`. Expected: PASS, except the known macOS `test_cable_models.py` "'snprintf' macro redefined". Build `default` with `-DPROJECT_VER=0.1.0-dev`.
- [x] **Step 5: Commit** `round dial: say appFilter, hold the apps, and send a pick`.

### Task 17: Round firmware: the shown app's name on the face

**Done:** `abdaab785e` (red: `6cecd5b99f`).

**Layer:** firmware UI. **Depends on:** Task 16 (the mockup is approved; draw what it shows). **Effort:** `high`.

**Files** (under `devices/harness-device/firmware/`):
- Modify: `main/ui/habitat/ui_habitat.c` — `render_home`'s `.chat` (:1807)
- Test: `test/test_touch_ui.py` (cases, and a `DESIGN` preview :4331-4373)

**Interfaces:**
- Consumes: `s.apps`, `s.app_shown`, `s.apps_known` (Task 16).
- Produces: in the machine view with `apps_known` and a shown app that is in the list, the grey line under the agent's name is that entry's `name`. Otherwise it stays `host_name(a->host)`. "See it in …" still uses `host_name(a->host)`.

- [x] **Step 1: Write the failing tests:**
  - `the face's line is the shown app's name`: an agent with host `zellij`, apps `ghostty` "Ghostty" shown → the scene says `Ghostty` and not `Zellij`.
  - `a tap still says See it in Zellij` (the nearest host).
  - `without apps the line is the host's name, as before`; `with a window there is no line`.
  - `a shown app that is not in the list falls back to the host's name`.
  - `an agent in an unknown terminal: the line reads Other, and a tap says See it in Terminal` (host `terminal`, apps `terminal` "Other" shown). The firmware draws the `name` it was sent and has no word of its own for it.
  - A `DESIGN` preview `machine-view-app`, as the mockup draws it.
- [x] **Step 2: Run** `IDF_PATH=~/esp/esp-idf-5.5.4 python3 devices/harness-device/firmware/test/test_touch_ui.py`. Expected: FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** `env -u IDF_PATH make device-test` and every `test_*.py`. Expected: PASS (the known macOS exception of Task 16).
- [x] **Step 5: Commit** `round dial: the face names the app it shows`.

### Task 18: Round firmware: the `APPS` picker

**Done:** `b0e0ed82ea` (red: `8a42a1d3b7`). The same commits hold the hint "Hold for apps" (`focus.c`, `ht_focus_set_hold_apps`; the spec's line is `3f8b1dac53`).

**Layer:** firmware UI. **Depends on:** Task 16 (the mockup is approved; draw what it shows). **Effort:** `high`.

**Files** (under `devices/harness-device/firmware/`):
- Modify: `main/ui/habitat/ui_habitat.c` — `view_t` (:73), the actions (:96), the carousels (:273), `face_hold` (:891), a new `render_apps` beside `render_tabs` (:2251), `dispatch` (:3085), the sender's switch (:3412), the hold branch (:3783-3792), `ui_apps_replace`, `ui_fleet_set_view` (:4203)
- Test: `test/test_touch_ui.py` (cases, its function lists, `DESIGN` previews)

**Interfaces:**
- Consumes: the UI state and `cable_client_pick_app` (Task 16); `focus_carousel`, `focus_header`, `ht_tab_carousel_*`.
- Produces: a view `APPS`, a carousel `app_carousel`, actions `A_APP` (a page, by app id) and `A_APP_DONE`.
- Rules:
  - A hold on any agent's face (the PM, 2026-11-15: no Swarm-recap, Personal | Team or badged-companion exception; they went with the Swarm): in the machine view with `apps_known`, `APPS` when there is at least one app, and nothing at all when there is none. Else TABS as today (a window; an older daemon).
  - The relaxing face's hint follows the same rule (`ht_focus_set_hold_apps(hold_picks_app())`): "Hold for apps" where a hold opens `APPS`, "Hold for tabs" otherwise. The resting line "Hold to switch tabs" is Task 29's.
  - `APPS`: the header `APPS`; one page per app through `focus_carousel`, the app's `name` in the tab page's type; under it `1 agent` / `3 agents`, or `3 agents · 1 waiting` with the waiting part in the accent; Done at the bottom, as in TABS, and no close pill, as in TABS (`focus_header`). It opens on the shown app. Positions and type are the mockup's.
  - Browsing sends nothing. Done, or a tap on a page, sends `app.pick` for that page's app, returns to the face, and arms the landing so the first agent of the next list is shown. Done on the shown app is how a person leaves without changing anything.
  - `ui_apps_replace` while `APPS` is open keeps the carousel on the same app **by id**. A page whose app went closes up, and a list that became empty closes `APPS` to the face.
  - `APPS` closes to the face when the list stops being the machine view (a window opened) and when the apps are forgotten (the link dropped).

- [x] **Step 1: Write the failing tests:**
  - `a hold in the machine view with apps opens APPS on the shown app`.
  - `a hold with a window opens TABS`; `a hold in the machine view without apps opens TABS, which says No tabs yet.` (today's screen, an older daemon).
  - `a hold with apps known and none listed opens nothing` (the view stays `HOME`, the scene is the face's).
  - `the pages`: `Ghostty` with `3 agents`; `VS Code` with `2 agents · 1 waiting`, the waiting run in the accent ink; `1 agent` for one.
  - `one app: one page`.
  - `browsing sends nothing` (a swipe to the next page: no action queued).
  - `Done sends app.pick for the page in the middle and returns to the face`; `a tap on a page sends app.pick for that page`; `Done on the shown app sends its pick and the face is as it was`.
  - `after a pick the first agent of the new list is on the face`.
  - `a push while open keeps the app by id` (on VS Code; a new list puts Orca before it → still VS Code); `the page of an app that went closes up`; `a list that became empty closes the picker`.
  - `a window opening closes APPS`; `a dropped link closes APPS`.
  - `the hint says Hold for apps in the machine view with apps, Hold for tabs with a window or with no apps, as often as before, also on a face without voice`.
  - `DESIGN` previews `apps`, `apps-waiting`, `apps-one`.
- [x] **Step 2: Run** `IDF_PATH=~/esp/esp-idf-5.5.4 python3 devices/harness-device/firmware/test/test_touch_ui.py`. Expected: FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** `env -u IDF_PATH make device-test` and every `test_*.py`. Expected: PASS (the known macOS exception). Build `default` with `-DPROJECT_VER=0.1.0-dev`. The previews go to the main session for review beside the mockup.
- [x] **Step 5: Commit** `round dial: a hold on the face picks the app, with no window`.

### Task 19: End to end: the daemon, a fake dial and the real watch

**Done:** `ffe4b8b98d`. Task 32 turns one of its tests.

**Layer:** test. **Depends on:** Tasks 27, 28 (Task 6 is done). **Effort:** `high`. **Red test:** none: no behavior (it adds end-to-end tests of what Tasks 2 to 7, 11 and 24 to 28 built, and moves a test helper).

**Files:**
- Create: `cli/e2e/dialAppFilter.e2e.ts`, `cli/e2e/harness/outsideAgent.ts`
- Modify: `cli/e2e/deviceWithoutApp.e2e.ts` (its `Outside` class, `PTY` and `HOST_HINTS` move to `harness/outsideAgent.ts`, which exports them, and it imports them), `cli/e2e/harness/desk.ts` (`plug` takes the dial's `capabilities`)

**Interfaces:**
- Consumes: `IsolatedDaemon`, `Desk`, `FakeDial` (its `capabilities`), `Outside.start(d, folder, hints)`, the way `e2e/hardwareWatch.e2e.ts` starts `harness hardware watch --json` with a stdin pipe (under the daemon's environment, so the watch finds the daemon's data folder and its devices socket), and `devicesListenerPath` (Task 25).
- The path the app in front takes here is the real one: the watch's stdin → `tellDevices` → the devices process's `devices.sock` → the filter. The daemon runs under its master (the suite's default), so the devices are a process of their own; with `CABLE_DISABLE: 'false'` that process starts when the fake dial is plugged in.
- **When a `front` line may be written.** The listener exists only while the devices process runs. The tests write a `front` line only after the daemon's log has `[devices] listener open` (Task 26's line), waited for with `until`. A line written earlier is dropped by design, and one test below proves that.

- [ ] **Step 1: Write the tests** (no window unless said; the dial greets with `appFilter: 'v1'`). The agents' folders are named `a1`, `a2`, …: the last test reads the log for app names, and a folder name is in it.
  - `Ghostty 3 and VS Code 2: the dial is sent apps with both counts and Ghostty's three agents`.
  - `app.pick vscode: apps says vscode, and the ring is VS Code's two, in the order they started`.
  - `Claude Code in zellij inside Ghostty is in Ghostty's ring, and its row's host is zellij`.
  - `the watch is written {"front":"com.microsoft.VSCode"}: the dial is sent VS Code's ring`; `Finder's bundle id changes nothing`. The test waits for the frame, never for a time.
  - `a front line written before a dial is plugged in is dropped, and the next app in front is followed` (no devices process yet: `devices.sock` does not exist; then the dial is plugged in, the log says `[devices] listener open`, and a second, different app is written).
  - `while a dial is plugged in the devices' socket is in the data folder with mode 0600, and it is gone once the daemon has stopped` (`devicesListenerPath(<the daemon's data folder>)`; skipped on Windows, which has none).
  - `an agent in an unknown terminal is in the app named Other, beside Apple's Terminal` (`TERM_PROGRAM: 'tmux'` and `TERM_PROGRAM: 'Apple_Terminal'`: `apps` has `{ id: 'terminal', name: 'Other' }` and `{ id: 'terminal-app', name: 'Terminal' }`); `an unknown terminal in front ({"front":"org.alacritty"}) does not turn the dial to Other`.
  - `kitty's bundle id in front turns the dial to kitty's agents` (an agent with `__CFBundleIdentifier: 'net.kovidgoyal.kitty'`; the watch is written `{"front":"net.kovidgoyal.kitty"}`).
  - `the front is followed while a window is open: when it closes the dial is sent the app that came to the front meanwhile`.
  - `a pick holds while the same app is in front, and ends when another settles`.
  - `an agent in VS Code needs the person while Ghostty is shown: apps says waiting 1, and agent.open for it turns the dial to VS Code and focuses it`.
  - `a window opens: the tab's list and no apps; it closes: apps again`.
  - `unplugged and plugged in again, the dial is sent the app it had picked` (decision 8: the pick lives as long as the devices process).
  - `a dial plugged in while VS Code is already in front (the watch started first) is sent VS Code's ring`: the watch tells its current app when `dial_status` turns attached (Task 28).
  - `a dial without appFilter beside it gets all five agents in one ring and no apps frame`.
  - `the daemon's log has "app filter: switched" lines and no bundle id, no exe name and no app name` (the `[devices] listener` lines among them: `open`, and the minute's counts when there are any).
- [ ] **Step 2: Run** `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialAppFilter.e2e.ts e2e/deviceWithoutApp.e2e.ts e2e/hardwareWatch.e2e.ts`. Expected: PASS.
- [ ] **Step 3: Commit** `e2e: the dial's app filter`.

### Task 20: PR CI runs the X11 source live

**Done:** `acac59fc67` (red: `328e454bde`).

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
    2. It starts `Xvfb` on a display of its own and `openbox` on it. `xvfb-run` is not used: it needs `xauth`, which `apt-install.sh`'s `--no-install-recommends` leaves out. It waits for the display with a bounded loop on `xdotool getdisplaygeometry`, never a sleep. **As built:** `Xvfb -displayfd 3` picks a free display and writes its number once it takes connections; the step reads it with a bounded `read -t 10` instead of the loop.
    3. It runs `X11_LIVE_CLIENTS="$(command -v xterm):$RUNNER_TEMP/code" cargo test --locked --lib --manifest-path device-app/src-tauri/Cargo.toml -- --ignored x11_live --nocapture`.
    4. It fails unless the output has `x11_live ... ok`: a filter that matches no test passes with 0 tests.
  - The job's `timeout-minutes` stays 30. No secret, nothing published.
- `docs/validation-and-release.md`: the row says the job also runs the X11 front source live under Xvfb.

- [x] **Step 1: Write the failing test.** In `test_the_workflow_carries_every_suite`, the `device-app-checks` job must also hold `xvfb`, `openbox`, `xdotool`, `xterm`, `--ignored x11_live` and `x11_live ... ok`; and `X11 front source, live` comes after `cargo test --locked --manifest-path device-app/src-tauri/Cargo.toml`.
- [x] **Step 2: Run** `python3 -m unittest discover -s scripts/tests -p 'test_ci_plan.py' -v`. Expected: FAIL (`'xvfb' not found in …`).
- [x] **Step 3: Implement** the job's change and the doc row.
- [x] **Step 4: Run** the step 2 command, then `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 .github/workflows/ci.yml`. Expected: PASS, no finding.
- [x] **Step 5: Commit** `CI: device-app-checks runs the X11 front source live, under Xvfb`.
- [x] **Step 6: The first run on a runner** is Verification check 2, the pull request's own CI run (no hand-started run: `AGENTS.md` allows no extra CI run). The pull request records the job's time there beside its time on the latest earlier run in which the job ran, and the difference.

### Task 21: Say it in the docs

**Done:** `27636d914b`. Checked against the decisions of 2026-11-15: it still holds, with the listener added and one more file.

**Layer:** repo files. **Depends on:** Tasks 27, 28 (it names what they built). **Effort:** `medium`. **Red test:** none: no behavior.

**Files:**
- Modify:
  - `cli/AGENTS.md`, the devices row of the processes table: which app the dial shows and the app in front, in memory; and the devices' own local listener (`services/devicesListener.ts`), a private socket open only while the process runs, which the core neither opens nor knows.
  - `cli/src/services/AGENTS.md`, the paragraph "A service that drives hardware: the devices": one sentence. What a local tool tells the devices (first the app in front, from `harness hardware watch`) goes to their listener, never through the core; a new message is a handler registered there.
  - `device-app/AGENTS.md`, "Rules a change keeps": the app in front is written to the watch's stdin and nowhere else, and is never logged.
  - `docs/specs/2026-11-13-device-without-the-app.md`, "What the dial gets with no window": one ring per app for a dial that says `appFilter`, with a link to this spec.
- Not touched: the rules of `cli/AGENTS.md` (rule 7 is already there, from #4303), and anything that says the Swarm.

- [ ] **Step 1:** Write the four changes, in the files' own words and length.
- [ ] **Step 2:** Check every link resolves, and that none of the four says the core takes, checks or forwards the app in front.
- [ ] **Step 3: Commit** `docs: the dial's app filter, where the daemon and the device app describe themselves`.

### Task 22: The on-dial rig (opt-in)

**Done:** `695eebd84e`. Checked against the decisions of 2026-11-15: it still holds. The watch the Harness Device app runs reaches the rig's devices through their socket in the rig's own data folder, so nothing in the rig's files changes; only the log lines it asserts do.

**Layer:** test rig. **Depends on:** Task 19 (`HOST_HINTS`, exported by `cli/e2e/harness/outsideAgent.ts`), Task 27 (the listener's log lines). **Effort:** `high`. **Red test:** none: no behavior (an opt-in rig for the check a person walks; every run that does not set `ON_DIAL_PORT` skips it).

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
     - `harness`: an executable that runs this checkout's CLI (`CLI_ENTRY`) under the daemon's environment (its data folder and home among it: that is how the watch finds the rig's `devices.sock`, and never the everyday daemon's).
     - `device.sh`: under the daemon's environment, writes the Harness Device app's first-run state with `loginItem` true (`$HOME/Library/Application Support/ai.autonomous.harness.device/state.json`, as `docs/plans/2026-11-13-device-menubar-plan.md` Verification says) and execs `device-app/src-tauri/target/debug/harness-device` with `HARNESS_DEVICE_CLI` at the `harness` above.
  3. Prints the three lines a person pastes (`sh <out>/tab.sh a1`, `sh <out>/device.sh`, `touch <out>/done`), and the dial's line once it greets (`cable: dial … on fw …`, waited for up to 60 s).
  4. Waits, on a condition, for `<out>/done`, up to `ON_DIAL_MINUTES`.
  5. Copies the daemon's log to `<out>/daemon.log`, prints how many `[device] app filter: switched · <cause>` lines each cause has and how many `[device] app filter: picker` lines there are, and closes the daemon (its throwaway root goes with it).
- Asserts: the dial greeted; every `app filter:` line is exactly `[device] app filter: switched · front|pick|empty|notice` or `[device] app filter: picker`; every `[devices] listener` line is exactly `[devices] listener open` or the minute's counts (Task 26), and nothing else; the log has no `dial front` and no `dial_front` at all.

- [ ] **Step 1: Write the file.**
- [ ] **Step 2: Run** `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialAppFilterOnDial.e2e.ts`. Expected: 1 skipped. `npm run typecheck`. Expected: PASS.
- [ ] **Step 3: Rehearse without a dial,** on the developer's Mac: `ON_DIAL_PORT` at a pseudo-terminal nothing answers on, `ON_DIAL_OUT` a scratch folder, `ON_DIAL_MINUTES=5`. The three files are written; `sh <out>/tab.sh a1` in a terminal tab adds a fake session the daemon's log lists; `touch <out>/done` ends the run. The case fails on "the dial never greeted", which is expected here. The everyday daemon (18473), its dial and `~/.harness` are untouched.
- [ ] **Step 4: Commit** `e2e: an opt-in rig for the app filter on a real dial`.

### Task 23: Claude desktop reads "Claude" on the dial

**Done:** `8feb4fede0` (red: `51fcc4ed52`).

The PM, 2026-11-14 (added to this plan's scope): #4296 finds an agent in the Claude desktop app (bundle
`com.anthropic.claudefordesktop`) and opens its session, but the dial reads "Terminal": neither the daemon's `NAMES`
(`hostDetect.ts`) nor the firmware's `host_name` table has `claude`, and `test_touch_ui.py` holds the two tables equal.
`/Applications/Claude.app`'s `CFBundleIdentifier` is `com.anthropic.claudefordesktop` (read by the main session on
Diego's Mac, 2026-11-14).

**Layer:** devices service process and firmware (one table row each; no drawing, so the mockup does not gate it).
**Depends on:** Task 2 (it shares `hostDetect.ts` and its spec). **Effort:** `medium`.

**Files:**
- Modify: `cli/src/cable/hosts/hostDetect.ts` (`NAMES`, and the bundle id in `detectHost` / `detectApp`), `devices/harness-device/firmware/main/ui/habitat/ui_habitat.c` (`host_name`'s table)
- Test: `cli/src/cable/hosts/hostDetect.spec.ts`, `devices/harness-device/firmware/test/test_touch_ui.py`

**Interfaces:**
- `NAMES` gains `claude: 'Claude'`, so `APP_IDS` has 15 ids (Task 2's count test moves from 14 to 15) and `appDisplayName('claude')` is `Claude`.
- `detectHost` and `detectApp`: `__CFBundleIdentifier === 'com.anthropic.claudefordesktop'` gives `claude`.
- Firmware `host_name`: `{"claude", "Claude"}`.

- [x] **Step 1: Write the failing tests:**
  - `hostDetect.spec.ts`: `the Claude desktop app's bundle id is claude, read Claude` (`detectHost` and `detectApp` of `{ __CFBundleIdentifier: 'com.anthropic.claudefordesktop' }` → `claude`; `hostDisplayName('claude')` → `Claude`); `APP_IDS has 15 ids, at most 16, and every one has a display name`.
  - `test_touch_ui.py`: `host_name("claude")` is `Claude`, and the existing check that the firmware's table equals the daemon's `NAMES` (less its "Terminal" rows) passes with the new row on both sides.
- [x] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/hostDetect.spec.ts` and `python3 devices/harness-device/firmware/test/test_touch_ui.py`. Expected: FAIL (`Terminal` where `Claude` is wanted).
- [x] **Step 3: Implement** the two rows and the bundle-id branch.
- [x] **Step 4: Run** the step 2 commands, then `make device-test`. Expected: PASS.
- [x] **Step 5: Commit** `dial: the Claude desktop app reads Claude, in the daemon's names and the firmware's`.

### Task 24: Revert: the core knows nothing of the app in front

The PM, 2026-11-15 (`cli/AGENTS.md`, Protect the core, rule 7): "No rule, list, record or mechanism goes into the core for one component, not even a generic one only it would use." Tasks 8, 9 and 10 put exactly that in the core. This task takes all of it out, in **one commit**.

**Layer:** core (taken out of) and devices service process. **Depends on:** none. **Effort:** `high`.

**Files:**
- Delete: `cli/src/core/dialFront.ts`, `cli/src/core/dialFront.spec.ts`
- Restore to the base, whole (`git checkout "$(git merge-base HEAD fix/dial-swipe-order)" -- <path>`; each file's whole diff against the base is the front, checked 2026-11-15): `cli/src/core/api.ts`, `cli/src/core/api.spec.ts`, `cli/src/core/devicesLink.ts`, `cli/src/core/devicesLink.spec.ts`, `cli/src/core/main.ts`, `cli/src/localWsServer.ts`, `cli/src/localWsServer.spec.ts`, `cli/src/architecture.coreFiles.txt`, `cli/src/services/devicesProcess.ts`, `cli/src/services/devicesProcess.spec.ts`
- Modify: `cli/src/services/devices.ts`, `cli/src/services/devices.spec.ts`, `cli/src/cable/hosts/frontApp.spec.ts`, `cli/src/cable/hosts/hostDetect.spec.ts`
- Not touched: `cli/src/devices/client.ts` and its spec. The watch still reads `dial-front` in `connected.features`; no daemon says it after this task, so the watch sends nothing of the front until Task 28.

**What goes, and what stays:**
- Task 8 goes whole: `createDialFront`, `FRONT_APPS`, `FRONT_PER_SECOND`.
- Task 9 goes whole: `DevicesPort.front` and its fallback (`core/api.ts`), the link's `front` event (`core/devicesLink.ts`), `heard.front` (`services/devicesProcess.ts`: it only served that port member), and the `front` member of the port in `services/devices.ts`.
- Task 10 goes whole: the `dial_front` block, `LocalWsServerOptions.dialFront` and `'dial-front'` in `LOCAL_TOOL_FEATURES` (`localWsServer.ts`), the wiring and the import in `core/main.ts`, the line `core/dialFront.ts` in `architecture.coreFiles.txt`.
- **Stays:** `DaemonCableHost.front` and the filter (Tasks 4, 5), and Task 7's `appTimer: timerIn('dial')`. From Task 9 only one expression is reused, by Task 27: `part.call('dial', () => cableHost.front(app))`, as the body of the listener's `front` handler. Until Task 27, `cableHost.front` is called by tests alone.

**Test expectation** (this task removes behavior, so its red is the base's own tests failing against the code that is still there):

- [ ] **Step 1: Put the tests back first.**
  - Restore the four spec files and `architecture.coreFiles.txt` from the base; delete `core/dialFront.spec.ts`.
  - `devices.spec.ts`: `the inline port takes a front too` is deleted. The three other tests that call `port.front(app)` (`the app in front becomes the shown app 1 s later, and the dial is pushed apps`; `a front with a window open moves nothing on the dial`; `across a run with front changes, nothing but the dial's own frames holds the app in front`) call `host().front(app)` instead, as Task 7's tests beside them do, and drop the `toBe(true)` on its answer. Nothing else in them changes: the privacy test keeps reading every call and every log line.
  - `frontApp.spec.ts`: the last test becomes `every id the table can give is an app id or none` (`APP_IDS.includes(id) || id === FRONT_NONE` for every row); the `FRONT_APPS` import goes.
  - `hostDetect.spec.ts`: the test `the core's front words are the app ids and none, so the two cannot drift` and its import go. There is no second list any more: the listener's handler reads `APP_IDS` itself (Task 26).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/architecture.spec.ts src/localWsServer.spec.ts && npm run test:core`. Expected: FAIL, three ways:
  - `localWsServer.spec.ts`: a tool is told `['openclaw-local', 'dial-watch']`, and the code says three features.
  - `architecture.spec.ts`: the core loads `core/dialFront.ts`, a file the list does not name.
  - `npm run test:core`: under 100% for `core/dialFront.ts` (no test left), `core/devicesLink.ts`, `services/devicesProcess.ts` and `services/devices.ts` (their `front` lines run in no test).
- [ ] **Step 3: Take the code out.** Restore the five source files from the base, delete `core/dialFront.ts`, and delete the `front` member (and its comment) from the port in `services/devices.ts`.
- [ ] **Step 4: Run** `cd cli && npm run typecheck && npx vitest run src/architecture.spec.ts src/localWsServer.spec.ts src/core src/services/devices.spec.ts src/services/devicesProcess.spec.ts src/cable && npm run test:core`. Expected: PASS, 100% per file. Then, from the repo root:
  - `git diff --stat "$(git merge-base HEAD fix/dial-swipe-order)" -- cli/src/core cli/src/localWsServer.ts cli/src/localWsServer.spec.ts cli/src/architecture.coreFiles.txt cli/src/architecture.spec.ts cli/src/services/devicesProcess.ts cli/src/services/devicesProcess.spec.ts`. Expected: no output. The core is as on `fix/dial-swipe-order`.
  - `git grep -n "dialFront\|FRONT_APPS" -- cli/src`. Expected: no output.
  - `git grep -ln "dial_front\|dial-front" -- cli/src`. Expected: `cli/src/devices/client.ts` and `cli/src/devices/client.spec.ts` only (Task 28's).
- [ ] **Step 5: Commit** (one commit, tests and code) `core: the app in front leaves the core; the devices will hear it on a listener of their own`. The message names the three commits it undoes: `ea6b817e24`, `82d30fa91f`, `e3cbfdfc22`.

### Task 25: Where the devices listener is

**Layer:** shared by the devices service process and the CLI; not the core. **Depends on:** none. **Effort:** `medium`.

**Files:**
- Create: `cli/src/devices/listenerPath.ts`, `cli/src/devices/listenerPath.spec.ts`

**Interfaces:**
- Consumes: `socketPathIn(folder, name, home)` from `cli/src/lib/localSocket.ts`. That is how the core's own socket and the connectors' `bridge.sock` (`lib/connectors/agents.ts`) find their place, the short folder included (`~/.harness/s/<16 hex of the folder's sha256>` when `folder/name` is over 96 bytes). It is a `lib/` helper, not a core module; every service process already loads the file (`serviceProcess.ts`); this task does not change it.
- Produces:
  - `export const DEVICES_SOCKET = 'devices.sock'`
  - `export function devicesListenerPath(dataDir: string, platform: NodeJS.Platform = process.platform, home: string = homedir()): string | null` — `null` on `win32` (no listener there yet) and where even the short folder is too long; else `socketPathIn(dataDir, DEVICES_SOCKET, home)`.
- This file is the one thing the listener (Task 26, through Task 27) and the watch (Task 28) share: both find the socket by calling it with the daemon's data folder. It imports nothing else, so the devices process pays nothing for it.

- [ ] **Step 1: Write the failing tests:**
  - `the socket is devices.sock in the data folder`.
  - `a data folder too long for a socket gives the short folder under the home, the one socketPathIn gives` (a 200-character folder: the answer is `join(shortSocketFolder(folder, home), 'devices.sock')`).
  - `null on Windows, whatever the folder`.
  - `null when the home is too long as well`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices/listenerPath.spec.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command and `cd cli && npm run typecheck`. Expected: PASS. Every case passes the platform in, so the spec runs the same on Windows.
- [ ] **Step 5: Commit** `devices: where their own listener is`.

### Task 26: The devices listener

**Layer:** devices service process. **Depends on:** Task 25 (the spec opens the path it gives). **Effort:** `xhigh` (a new way in to a daemon process: who may connect, what a message may be, what a flood costs, what the log may say).

**Files:**
- Create: `cli/src/services/devicesListener.ts`, `cli/src/services/devicesListener.spec.ts`

**How the core's own local socket checks who is calling** (read in the code, 2026-11-15; this task reuses it, and changes none of it):
- The core's socket never reads a peer's uid: Node has no call for it. The **file is the credential** (`lib/localSocket.ts`, its header): the socket is 0600 in a folder that is the owner's alone, so the kernel refuses another account's `connect`.
- `listenLocalSocket(handler, path)` makes that true without a gap: it listens under a private name, `chmod`s it to 0600, and only then hard-links it to its name (a name already taken by a live listener is refused; a dead one's file is replaced); a short folder is made 0700 and checked to be a real folder of this uid (`prepareShortFolder`). The connectors service already serves its own `bridge.sock` this way (`lib/connectors/bridge.ts`), from the edge host.
- A client checks the other half before it sends: `socketIsPrivate(path)` (`lib/localTransport.ts`): a socket of this uid, no group or other bit, in a folder of this uid that nobody else can write to.
- So "another uid refused" is three checks here: the mode, the folder's owner, and the client's look at the socket (Task 28). A second account connecting for real is refused by the kernel on the mode, and no unit test can run as a second account (Open question 1).

**Interfaces:**
- Consumes: `listenLocalSocket`, `LocalSocketServer` (`lib/localSocket.ts`, as `lib/connectors/bridge.ts` does); `APP_IDS` (`cable/hosts/hostDetect.ts`, Task 2); `FRONT_NONE` (`cable/hosts/frontApp.ts`, Task 11).
- Produces:
  - `export const LISTENER_MAX_CONNECTIONS = 16`
  - `export const REFUSED: unique symbol` — what a handler returns for a body that is not a message of its type.
  - `export interface ListenerHandler { maxBytes: number; perSecond: number; handle(message: Record<string, unknown>, gone: AbortSignal): unknown }` — `maxBytes` is the largest body of this type; `perSecond` is how many one connection may send a second; `handle` gets the parsed body (`type` included) and returns `REFUSED`, nothing (taken), or a value or a promise of one (the answer). `gone` aborts when the sender's connection closes before the answer.
  - `export interface DevicesListenerOptions { path: string | null; handlers: Readonly<Record<string, ListenerHandler>>; log(line: string): void; now?: () => number }` — `now` is monotonic milliseconds, `performance.now` by default.
  - `export interface DevicesListener { close(): Promise<void> }`
  - `export function openDevicesListener(options: DevicesListenerOptions): Promise<DevicesListener | null>` — `null` when nothing was opened. It never rejects for a socket it could not open.
  - `export const FRONT_PER_SECOND = 10`, `export const FRONT_MAX_BYTES = 64` (the longest message, `{"type":"front","app":"terminal-app"}`, is 37 bytes)
  - `export function frontHandler(front: (app: string) => void): ListenerHandler` — `maxBytes: FRONT_MAX_BYTES`, `perSecond: FRONT_PER_SECOND`; `handle` calls `front(app)` when `app` is a string in `APP_IDS` or is `FRONT_NONE`, and returns `REFUSED` otherwise. It holds nothing between calls and logs nothing.
- **The wire.** One message is one `POST /` on the socket, its body a JSON object with a string `type`: `{"type":"front","app":"ghostty"}`. It is HTTP because `listenLocalSocket` serves HTTP, and because both kinds of sender already speak it over a private socket: the CLI (`fetchOverSocket`) and the hook scripts #4296's follow-up will point here. A connection is kept alive, so "per connection" is the HTTP connection. The answer's status says what became of the message, and its body is empty unless the handler answered:

  | Status | When | Counted as |
  |---|---|---|
  | `204` | taken; the handler returned nothing | |
  | `200` + the handler's value as JSON | the handler answered | |
  | `400` | not a JSON object, no string `type`, or the handler returned `REFUSED` | `refused` |
  | `404` | no handler for the type (own keys only: `__proto__` and `constructor` are unknown types) | `unknown` |
  | `405` | not `POST /` | `refused` |
  | `413` | the body is over the largest `maxBytes` of any handler (reading stops there and the connection is closed), or over its own type's | `oversized` |
  | `429` | over the type's rate on this connection | `rate` |
  | `500` | the handler threw or its promise rejected | `failed` |

- **Rules:**
  - **Open.** `path: null` (Windows) opens nothing, logs nothing and answers `null`. When the socket's folder exists it must be a real folder of this uid that no one else can write to (`lstat`: a directory, `uid === process.getuid()`, `(mode & 0o022) === 0`: what `socketIsPrivate` asks of a socket's folder); a short folder that does not exist yet is made and checked by `listenLocalSocket`. Then `listenLocalSocket(handler, path)`, `server.maxConnections = LISTENER_MAX_CONNECTIONS`, and `server.unref()` (a listener never keeps a process up).
  - **Seen.** One line when it opens: `[devices] listener open` (no path: a path holds the account's name). One line when it does not: `[devices] listener not opened · folder not private`, `· in use` (a live listener already has the name) or `· failed`.
  - **Order of checks:** method and path, the body's size as it is read, JSON object and `type`, the handler, its own `maxBytes`, its rate, then `handle`.
  - **Rate.** One bucket for each type on each connection, full at `perSecond`, refilled at `perSecond` a second; a clock that stepped back refills nothing. The buckets go with the connection (keyed on its socket, weakly): no table to bound or clean.
  - **Counted, never told.** Dropped messages are counted by the five kinds above and logged at most once a minute, by an unref'd timer started at the first count: `[devices] listener in the last minute: N unknown, N oversized, N over rate, N refused, N failed`. No type a sender made up, no body, no app, no error text, in any log line or answer.
  - **Close.** `close()` stops listening, ends every open connection, aborts every `gone`, removes the socket file and cancels the minute's timer. A second `close()` does nothing.
- **For #4296's follow-up:** `asked`, `inbox` and `observed` are three more entries in `handlers`, each with its own `maxBytes` and `perSecond`. `inbox` is why `handle` may answer with a promise and gets `gone`: its poll is held until a transcript takes it or its client goes. Nothing in this file changes for them.
- **Windows.** No named pipe in this work (the follow-up that builds the Harness Device app for Windows adds it: `listenLocalSocket` already serves a pipe when given a token). Here `devicesListenerPath` is `null` on `win32`, so nothing is opened. The file imports only what a Windows service process already loads. In the spec, every case that binds a socket sits in `describe.skipIf(process.platform === 'win32')`; the no-path case and `frontHandler`'s cases run on every OS. `windows.yml` runs a fixed list of specs, and this one is not in it.

- [ ] **Step 1: Write the failing tests** (real sockets in a short folder of the test's own under `/tmp`, `mkdtempSync('/tmp/hdl-')`, as `shortDir` in `lib/localSocket.spec.ts`: a longer one would send the socket to the short folder under the developer's own home; the spec's client is `node:http` with `socketPath`; a scripted `now`; fake timers only for the minute's line):
  - **Who may connect**
    - `the socket is 0600, and a socket, at the path asked for` (`lstat`: `isSocket()`, `(mode & 0o777) === 0o600`).
    - `a folder that is not this account's own is refused: nothing is opened` (`process.getuid` spied to another uid; the answer is `null`, no socket file, the log is `[devices] listener not opened · folder not private`).
    - `a folder others can write to is refused` (the temp folder `chmod` 0o757).
    - `a live listener already on the path: nothing is opened, and the first still answers` (`· in use`).
    - `the socket file of a process that died is replaced`.
    - `the 17th connection at once is closed, and the 16 go on`.
  - **What a message may be**
    - `an oversized body is dropped and counted, and the handler never runs` (one byte over `maxBytes` → `413`; a 1 MiB body → `413`, the connection closed, and no more than the largest `maxBytes` read).
    - `a body over its own type's limit and under another type's is dropped` (handlers of 64 and 1024 bytes; a 200-byte `front`).
    - `an unknown type is dropped and counted` (`nope`, `__proto__`, `constructor`, `toString` → `404`).
    - `a body that is not a JSON object with a string type is refused` (`[]`, `"front"`, `null`, `{`, `{"type":7}`, `{}` → `400`).
    - `anything but POST / is refused` (`GET /`, `POST /front` → `405`).
  - **What a flood costs**
    - `the 11th front within a second on one connection is dropped; another connection's is taken` (`429`); `a second later ten more pass`; `a clock set back refills nothing`.
    - `each type has a rate of its own on a connection` (`front`'s bucket empty, a second test type still taken).
  - **`front`**
    - `front takes every app id and none` (each of `APP_IDS`, `terminal` among them, and `none` → `204`, and `front` was called with it).
    - `front refuses an unknown app id`: no `app`, a number, `''`, `Ghostty` (a name), `com.mitchellh.ghostty` (a raw value), `other`, `Other` (the old word and the display name), `__proto__` → `400`, and `front` is never called.
    - `the front handler holds nothing: it is its two limits and handle` (the object's own keys).
  - **What is said of it**
    - `opening logs "[devices] listener open" and no path`.
    - `nothing logs or echoes what was sent`: after an unknown type, an oversized body, an over-rate burst and refused bodies that carry `ghostty`, `com.mitchellh.ghostty` and a marker string, every log line and every answer's body is read: none holds any of the three, nor the made-up type. After a minute the one line is exactly `[devices] listener in the last minute: 1 unknown, 1 oversized, 1 over rate, 3 refused, 0 failed`.
    - `a handler that throws is 500, counted failed, logged with no text of the error, and the next message is taken`.
  - **The door for the handlers to come**
    - `a handler's value is the answer, and a promise is waited for`.
    - `gone aborts when the sender's connection closes before the answer`.
  - **Close and Windows**
    - `close removes the socket, ends open connections, aborts every gone and leaves no timer; a second close does nothing`.
    - `with no path (Windows) nothing is opened and nothing is logged`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devicesListener.spec.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** The file imports nothing from `src/core/`, `backendSocket.ts` or `cli.ts`, and nothing from `lib/localTransport.ts` (a client's file, which the devices process does not load).
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npm run test:core && npm run typecheck && npx vitest run src/architecture.spec.ts`. Expected: PASS, 100% for `services/devicesListener.ts`; `architecture.spec.ts` unchanged (a service's file is not in the core's walk).
- [ ] **Step 5: Commit** `devices: a private listener of their own, a handler for each message type; front is the first`.

### Task 27: The devices open their listener

**Layer:** devices service process. **Depends on:** Task 24 (the same four files; the port's `front` is gone), Task 25 (`devicesListenerPath`), Task 26. **Effort:** `xhigh` (privacy; a socket's life tied to a process; `services/devices.ts` and `services/devicesProcess.ts` are in the 100% gate).

**Files:**
- Modify: `cli/src/services/devices.ts` (`DevicesDeps`, after the cable host is built, `port.stop`), `cli/src/services/devicesProcess.ts` (`DevicesServiceOptions`, the `deps` literal)
- Test: `cli/src/services/devices.spec.ts`, `cli/src/services/devicesProcess.spec.ts`

**Interfaces:**
- Consumes: `openDevicesListener`, `frontHandler`, `ListenerHandler`, `DevicesListener` (Task 26); `devicesListenerPath` (Task 25); `DaemonCableHost.front` (Task 5); `part.call` and `log` of `startDevices`.
- Produces:
  - `DevicesDeps.listen?: (handlers: Readonly<Record<string, ListenerHandler>>, log: (line: string) => void) => Promise<DevicesListener | null>` — given by the devices process alone.
  - `startDevices`, when `deps.listen` is given: calls it once, after the cable host exists, with `{ front: frontHandler((app) => part.call('dial', () => cableHost.front(app))) }` and its own `log`. A rejection is one line, `[devices] listener not opened · failed`, and the devices run on. `port.stop` closes the listener first (waiting for an open still under way), so no front reaches a stopped cable.
  - `DevicesServiceOptions.openListener?: typeof openDevicesListener` (for this service's tests, beside `start` and `run`).
  - `runDevicesService`: `deps.listen = (handlers, log) => (options.openListener ?? openDevicesListener)({ path: devicesListenerPath(options.dataDir), handlers, log })`.
- **Only in the devices process.** The start inside the core's process (`core/main.ts`, for `HARNESSD_SERVICES=none` and Harness OS) gives no `listen`, and this task does not touch it: the core's process opens no socket for the devices, in any mode. There the dial filters by app and takes a pick, and does not follow the app in front.
- This is the registration #4296's follow-up copies: one more key in the object given to `deps.listen`.

- [ ] **Step 1: Write the failing tests:**
  - `devices.spec.ts` (a fake `listen` that records its handlers and gives a `close` spy):
    - `the devices open their listener once, with a front handler of 10 a second and 64 bytes`.
    - `the listener is closed when the devices stop, before the cable is`.
    - `stopping while the listener is still opening closes it once it has opened`.
    - `a listener that cannot open is one log line, and the devices run on` (`listen` rejects; and `listen` answering `null` adds no line of the devices' own).
    - `with no listen given (the devices inside the core's process) nothing is opened, and a pick still turns the dial`.
    - `a front through the listener's handler becomes the shown app 1 s later, and the dial is pushed apps` (`handlers.front.handle({ type: 'front', app: 'vscode' }, signal)`; this replaces the `host().front` form Task 24 left).
    - `a front through the handler with a window open moves nothing on the dial, and is shown when the window closes`.
    - **Privacy:** `across a run with fronts through the handler, nothing but the dial's own frames holds the app in front` — Task 24's test, driven through `handlers.front.handle` for `ghostty`, `none`, `vscode`: every log line, and every call the devices made on the core's API, the windows, the fleet, the gateway and `fetch`, is read: none matches `/ghostty|vscode|VS Code/i`, and no argument is `none`. The core's API is called with nothing of the front at all.
    - `a cable host that throws on a front is logged as the dial's failure, and the handler returns as taken`.
  - `devicesProcess.spec.ts`:
    - `the devices process gives the devices its listener, on the data folder's devices socket` (a fake `openListener` records `{ path, handlers, log }`: `path` is `devicesListenerPath(dataDir)`, and the handlers are the ones `listen` was called with).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts src/services/devicesProcess.spec.ts`. Expected: FAIL (`listen` is never called; `openListener` is not an option).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd cli && npm run test:core && npm run typecheck && npx vitest run src/architecture.spec.ts src/leanEntry.spec.ts`. Expected: PASS, 100% for both files; the core's file list and what its process may open are unchanged.
- [ ] **Step 5: Commit** `devices: open the listener with the devices process, and close it with it`.

### Task 28: `harness hardware watch` tells the devices listener

This is the change to Task 12 (the PM, 2026-11-15). Task 12's stdin reading, its line limits and `frontAppId` stay.

**Layer:** CLI only. **Depends on:** Task 25. **Effort:** `xhigh` (the raw name must stop here, and the app id must reach only the owner's own socket).

**Files:**
- Create: `cli/src/devices/listenerClient.ts`, `cli/src/devices/listenerClient.spec.ts`
- Modify: `cli/src/devices/client.ts` (`DialWatchDeps`, `runDialWatch`)
- Test: `cli/src/devices/client.spec.ts`

**Interfaces:**
- Consumes: `devicesListenerPath` (Task 25); `fetchOverSocket` (`lib/localTransport.ts`), which refuses a socket that is missing or not private (`socketIsPrivate`) before a byte is sent; `frontAppId` (Task 11); the wire of Task 26 (`POST /`, a JSON object with `type`; a `2xx` is taken).
- Produces, in `listenerClient.ts`:
  - `export function tellDevices(dataDir: string, message: { type: string } & Record<string, unknown>, options?: { platform?: NodeJS.Platform; fetch?: typeof fetch; timeoutMs?: number }): Promise<boolean>` — true when the listener took it (`2xx`). False, and never a throw, when there is no path (Windows), no socket (an older daemon, the devices process not running), a socket that is not this account's own, any other answer, or no answer in `timeoutMs` (2000 by default, `AbortSignal.timeout`).
- Produces, in `client.ts`:
  - `DialWatchDeps.tell?: (message: { type: 'front'; app: string }) => Promise<boolean>` — by default `tellDevices(deps.dataDir ?? env.ADAPTER_DATA_DIR, message)`.
  - Each stdin line with a string `front` is mapped with `frontAppId`. When the app id differs from the last one the listener took, the watch tells `{ type: 'front', app }`.
  - One tell at a time. When it ends and the app in front has changed meanwhile, the newest is told and the ones between are skipped, so the listener hears them in order and the last one last.
  - A tell that is not taken changes nothing and is not tried again by itself: the next change of the app in front is told (the spec: "it ignores the `front` lines and tries again on the next change").
  - **When the `dial_status` the watch already hears turns to `attached: true`** (from not attached, or at the first status), the watch tells its current app again, even if the listener took the same one before (the PM, 2026-11-15, open question 2: B). The devices process usually starts when the dial is plugged in, after the watch; this gives it the app in front at once. No current app yet (no `front` line read): nothing is told.
  - It does not wait for the core: a `front` line is told as soon as it is read, before or after `connected`. Nothing of the app in front goes on the core's socket: `dial_front`, `frontTaken` and the reading of `dial-front` in `connected.features` are deleted.
  - After stdin closes or the watch has finished, nothing more is told.
  - Nothing of a line is printed, on stdout or stderr, also when a tell fails.

- [ ] **Step 1: Write the failing tests:**
  - `listenerClient.spec.ts` (a real `listenLocalSocket` server stands for the listener, in a short data folder of the test's own under `/tmp`, so the path is beside it and never under the developer's home; the socket cases are skipped on Windows):
    - `tells the data folder's devices socket: POST /, the message as JSON, true on 204`.
    - `false when the listener answers 400, 404, 413, 429 or 500`.
    - `false with no socket there, and nothing is sent`.
    - `false on Windows without a call` (`platform: 'win32'`, a `fetch` spy never called).
    - `a socket of another account, or one looser than 0600, is told nothing` (`process.getuid` spied to another uid; then the socket `chmod` 0o666: the server hears no request).
    - `false when the listener does not answer in time` (`timeoutMs: 50` against a server that never answers; the test waits on the promise).
    - `never throws` (a `fetch` that rejects).
  - `client.spec.ts` (a fake `tell` that records its messages and answers as scripted). Task 12's tests of `dial_front` are replaced by:
    - `a front line is told to the devices listener as an app id` (`{"front":"com.mitchellh.ghostty"}` → `{ type: 'front', app: 'ghostty' }`; `{"front":"Code.exe"}` → `vscode`).
    - `an unknown app is told as none`.
    - `the raw value is never sent or printed`: every message given to `tell`, every frame the fake core socket was sent, and every `print` and `printError`, is read for the bundle id and the exe name.
    - `nothing of the app in front goes on the core's socket`: the frames sent there are `machine_select` and nothing else, also when its `connected.features` names `dial-front`.
    - `the same app twice is told once; Safari then Finder is one none`.
    - `a front line is told at once, before the daemon has answered`.
    - `with no listener the line is ignored, and the next change is told` (`tell` answers false for `ghostty`, then true: `vscode` is told, and `ghostty` after it is told again).
    - `when dial_status turns attached the current app is told again, also one the listener took before; with no front line read yet nothing is told`.
    - `two changes while a tell is under way: the newest is told when it ends, the one between is skipped`.
    - `after stdin closes nothing is told`.
    - Kept from Task 12, unchanged: `a line in two chunks is one line; a 2000-byte line and a line that is not JSON are dropped, and the next line still works`; `dial status lines print as before, and stdin closing still exits 0`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/devices`. Expected: FAIL (`listenerClient` missing; `tell` is never called).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command and `cd cli && npm run typecheck`. Expected: PASS. Then `git grep -n "dial_front\|dial-front" -- cli/src`. Expected: only the one test above that names `dial-front` to prove it is ignored.
- [ ] **Step 5: Commit** `hardware watch: tell the devices' own listener which app is in front, and the core nothing`.

### Task 29: Round firmware: "Hold to switch apps"

The PM, 2026-11-15 (the spec, § The app picker): the same rule that turned "Hold for tabs" into "Hold for apps" (Task 18) turns the resting line "Hold to switch tabs" into "Hold to switch apps". The resting line is the one an engine with no relaxing scene shows (every engine but Claude, Codex and Muse).

**Layer:** firmware UI. **Depends on:** none (Task 18 is done: it added `hold_apps` and `ht_focus_set_hold_apps`). **Effort:** `medium`.

**Files** (under `devices/harness-device/firmware/`):
- Modify: `main/ui/habitat/focus.c` (`resting_line`, a new `#define` beside `HOLD_FOR_TABS`, and the comment above `RESTING`)
- Test: `test/test_touch_ui.py` (beside the "Hold for apps" loop in `app_picker_checks`); `test/test_character.c` only if a check there lists the resting lines by name with `hold_apps` set (it does not today: it never sets it, so it keeps reading "Hold to switch tabs")

**Interfaces:**
- Consumes: `hold_apps` (`focus.c`), set by `ui_habitat.c` from `hold_picks_app()` before each face is drawn: the machine view with `apps` received.
- Produces: `#define HOLD_FOR_APPS "Hold to switch apps"`. `resting_line` returns it in place of `HOLD_FOR_TABS` when `hold_apps` is set, from `RESTING` and from `RESTING_MUTE`. The pick itself is untouched, so the line keeps its weight (5 of 27; 1 of 2 on a face without voice), and "never the same line twice running" still compares the list's own words.
- The rule, as for "Hold for apps": machine view with `apps` → apps; a window → tabs; no `apps` (an older daemon) → unchanged.

- [ ] **Step 1: Write the failing test** in `test_touch_ui.py`, on an agent whose engine has no relaxing scene, over the same four cases as the "Hold for apps" loop, each over 120 fresh resting faces (counted with `scene_says`, as `rest_invitations` counts the resting lines):
  - the machine view with apps: `Hold to switch apps` is seen more than 10 times, and `Hold to switch tabs` never;
  - a window: `Hold to switch tabs` more than 10 times, `Hold to switch apps` never;
  - the machine view with no `apps`: the same as a window;
  - the machine view with apps on a face without voice (`CABLE_CAP_S` only): `Hold to switch apps`, and `Hold to switch tabs` never.
- [ ] **Step 2: Run** `IDF_PATH=~/esp/esp-idf-5.5.4 python3 devices/harness-device/firmware/test/test_touch_ui.py`. Expected: FAIL (the machine view with apps still says "Hold to switch tabs").
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `env -u IDF_PATH make device-test` and every `devices/harness-device/firmware/test/test_*.py`. Expected: PASS (the known macOS exception of Task 16). Build `default` with `-DPROJECT_VER=0.1.0-dev`.
- [ ] **Step 5: Commit** `round dial: the resting hint says Hold to switch apps where a hold opens the apps`.

### Task 30: Not known yet never wins the default

The PM, 2026-11-15 (the spec, § Each agent's app, "Not known yet is not Other"). Diego plugs the dial in with many agents already running. The scan finds them with no hook, so today each is `terminal` and the default, the app with the most agents, is "Other".

**Layer:** devices service process. **Depends on:** none (Tasks 2 to 5 are done). **Effort:** `xhigh` (the one state every dial on the computer reads, and a new way for the shown app to change beside the pick, the front and the counts).

**Files:**
- Modify: `cli/src/cable/hosts/types.ts` (`HostAgent`), `cli/src/cable/hosts/observed.ts` (`entry`, and `ingest` beside `a.app = detectApp(e.hostHints)`), `cli/src/cable/hosts/select.ts` (`AppRings`), `cli/src/cable/hosts/appFilter.ts`, `cli/src/cable/cableHost.ts` (the `AppFilter` it builds in its constructor)
- Test: `cli/src/cable/hosts/observed.spec.ts`, `select.spec.ts`, `appFilter.spec.ts`, `cli/src/cable/cableHost.spec.ts`
- Not touched: `cableSession.ts`, `registry.ts` (it hands on each source's own objects), `harness.ts`, the firmware. **The wire is as it was:** `apps` still counts every agent on a page.

**How "not known yet" is held, and why** (the smallest of the two ways the PM named):
- **Chosen: a flag.** `HostAgent.appPending?: true`, beside an `app` that stays `terminal`. The spec says such an agent "sits in Other's ring and page until its app is known", and `app` is exactly the page an agent is on. So the rings (`AppRings.update` groups by `a.app`), the `apps` counts, `appOf` and the notice that turns the dial to an agent's app (`cableSession.ts`, `agent.open`) are right without a change. Only the default has to tell the two apart, and it reads one more map.
- **Not chosen: `app` undefined.** `app` is a required string read in `select.ts`, `cableHost.ts` (`appOf`, which answers `undefined` only for "not on this list") and every `HostAgent` literal of four spec files. Each read would need the same "else `terminal`", and a notice for an agent not known yet would pick no app.
- The name is `appPending`, not a word with "unknown" in it: `UNKNOWN_APP` is the app that **is** known to be none of the listed ones.

**Interfaces:**
- Produces, in `types.ts`: `HostAgent.appPending?: true` — set while nothing has said where the agent runs: the open scan found it, no hook has told of it, and its parent processes named no app (Task 31). Absent on every other agent.
- `ObservedSource`: a new entry has `app: UNKNOWN_APP, appPending: true`. Every hook event that sets `a.app` also deletes `appPending`, with or without hints: `hostHints: {}` gives `terminal`, known. A waiting prompt (`asked`) says nothing of where a session runs and leaves the flag.
- Produces, in `select.ts`: `AppRings.known(): ReadonlyMap<string, number>` — each app's agents that have no `appPending`, as of the last `update`. An app with none is absent. `counts()`, `apps()` and `ring()` are unchanged: they hold every agent.
- Produces, in `appFilter.ts`: `AppFilterDeps.known(): ReadonlyMap<string, number>` — the same map. `cableHost.ts` passes `known: () => this.rings.known()`.
- Rules of `AppFilter`, changed and kept:
  - **Kept:** "has agents" reads `counts()`, every agent, for the shown app staying, for a pick and for the app in front. So a pick or the front can show a page of agents not known yet, and it stays shown.
  - **The default** (`fallback`): the app in front at the last settle if it has agents, as today. Else the app with the most agents in `known()`. A tie there is drawn once and held while `known()` is what it was drawn for, so an agent not known yet coming or going draws nothing new. Only when `known()` is empty, the app with the most agents in `counts()`: the page of agents not known yet, when no app has a known agent.
  - **New state: `byDefault`.** Set when rule 1 chose the shown app; cleared by a pick that switched and by a settle that showed its app.
  - **New in `shown()`** (Open question 3; the plan's reading of "shown by default only when no other app has an agent"): rule 1 also runs again when `byDefault` is set, the shown app is absent from `known()`, and `known()` is not empty. Its cause is `empty`, as for a shown app that emptied: no new cause, no new measure.

- [ ] **Step 1: Write the failing tests.**
  - `observed.spec.ts` (the first replaces `a session the open scan found is in terminal until its first hook says its app`):
    - `a session the open scan found is not known yet, on the unknown app's page, until its first hook` (after `scanOpen`: `{ app: 'terminal', appPending: true }`; after `turn-start` with `TERM_PROGRAM: 'ghostty'`: `app: 'ghostty'`, and no `appPending` property).
    - `a hook with no hints makes it known to be in the unknown app` (`hostHints: {}` → `app: 'terminal'`, no `appPending`).
    - `an agent a hook told of first is never not known yet`.
    - `a waiting prompt on a session the scan found leaves it not known yet` (`asked` → `state: 'needs-you'`, `appPending: true`).
  - `select.spec.ts`, `AppRings`:
    - `known leaves out the agents not known yet; the counts, the list and the ring keep them` (three `terminal` with `appPending`, one `terminal` without, two `ghostty`: `counts()` is `terminal 4, ghostty 2`; `known()` is `terminal 1, ghostty 2`; `apps()` has `{ id: 'terminal', count: 4 }`; `ring('terminal').rows` has four).
    - `an app whose agents are all not known yet is absent from known`.
    - `an agent that becomes known joins its app's ring at the end, and its known count` (pending in `terminal`, then `app: 'ghostty'` with no flag: last of Ghostty's rows, `known()` Ghostty one more, and `terminal`'s ring dropped once it is empty).
  - `appFilter.spec.ts` (`setup` gains a `known` map that is the counts unless a test gives its own, so every test there today reads as before):
    - `the default counts known agents only: five not known yet lose to two in Ghostty` (counts `terminal 5, ghostty 2`, known `ghostty 2` → `ghostty`).
    - `known agents in the unknown app count as any app's: three there beat two in Ghostty` (known `terminal 3, ghostty 2` → `terminal`).
    - `a tie is drawn over known agents: one not known yet coming or going draws nothing new` (known `ghostty 2, vscode 2` draws once; every agent goes; the same known counts with `terminal 1`, then `terminal 3`, not known yet: the drawn app again, and `random` was called once).
    - `only agents not known yet: their page is the default` (counts `terminal 3`, known empty → `terminal`, and no switch is told).
    - `that default gives way once an app has a known agent, as an empty switch` (then counts `terminal 2, ghostty 1`, known `ghostty 1` → `ghostty`; causes `['empty']`; a second read tells nothing more).
    - `that default stays while only its own agents become known` (then known `terminal 1` → `terminal`, no switch).
    - `a pick of the page of agents not known yet holds while a known app has more` (counts `terminal 3, ghostty 5`, known `ghostty 5`: `ghostty` shown; `pick('terminal')` is `'switched'`; three more reads are `terminal`; causes `['pick']`).
    - `the app in front with only agents not known yet is shown, and holds` (`front('terminal')` settles → `terminal`; a later read with known `ghostty 5` is still `terminal`).
    - `a pick that ended in front of an app with no agents does not give way` (the page picked; `none` settles; known `ghostty 5` → still `terminal`: only a default gives way).
  - `cableHost.spec.ts`:
    - `agents not known yet are counted on Other's page and never win the default` (five `agent(id, 'terminal', { appPending: true })` and two in `ghostty`: `apps.shown` is `ghostty`, the rows are Ghostty's two, `total: 2`, and `apps.apps` holds `{ id: 'terminal', name: 'Other', count: 5, waiting: 0 }` and `{ id: 'ghostty', name: 'Ghostty', count: 2, waiting: 0 }`).
    - `only agents not known yet: Other is shown, and gives way when one of them is known to be in Ghostty` (`appSwitched` hears `empty` once).
    - `a notice for an agent not known yet turns the dial to Other` (`appOf(id)` is `terminal`; `pickApp('terminal', 'notice')` is `'switched'`, and the next list is Other's).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts src/cable/hosts/select.spec.ts src/cable/hosts/appFilter.spec.ts src/cable/cableHost.spec.ts`. Expected: FAIL (`known` is not a function; `appPending` is undefined; the default is `terminal`).
- [ ] **Step 3: Implement.** Update the doc comment of `AppFilter` and of `HostAgent.app`, and the comment in `ingest` ("a plain terminal until its first" becomes "not known yet until its first").
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npm run typecheck && npx vitest run src/cable src/services/devices.spec.ts`. Expected: PASS, with every test that was there before unchanged but the one replaced.
- [ ] **Step 5: Commit** `dial: an agent the scan found is not known yet, on Other's page, and never wins the default`.

### Task 31: The scan learns the app from the parent processes

The PM, 2026-11-15 (the spec, § Each agent's app, "The scan learns the app where that is cheap" and "Never read another process's environment"). With Task 30 alone, the agents Diego already has running sit on Other's page until each one's next hook. This task names their apps at the scan, from what `ps` already says of their parents.

**Layer:** devices service process, and only there. **Depends on:** Task 30 (`appPending`, which a learned app ends; and both change `observed.ts` and its spec). **Effort:** `xhigh` (it looks at other processes: privacy; a bound on every read; a path a process wrote becomes a file read).

**The method, and why this one.**
- **Forbidden, and not used:** a process's environment, by any means (`ps eww`, `ps -E`, `/proc/<pid>/environ`), also to read and drop at once (Global Constraints). The implementer runs no such command, in code, in a test or by hand.
- **Used:** a process table of the scan's own: one `ps -axo pid=,ppid=,comm=` (`comm` last, so macOS prints the whole path, not 16 characters) under a 3 s timeout and 1 MiB, through the patient exec, run only on a scan with sessions whose app is not known yet (`ea2482121c`; it first reused `listProcesses`, whose `comm` macOS cuts to 16 characters there). It holds each process's `pid`, `ppid` and `executable` (`comm`). The walk reads those three and nothing else. **One table a pass, not a `ps -p` per parent:** one spawn, and one picture of the machine, so a parent's id is never matched against a process that took the id a moment later.
- **macOS:** `comm` is the executable's whole path. The outermost `.app` folder of that path is the app, and its `Contents/Info.plist` gives its bundle id (`plutil -extract CFBundleIdentifier raw -o - <file>`, about 10 ms, XML or binary). `frontAppId` maps the bundle id.
- **Linux:** `comm` is the executable's name. `frontAppId` maps it (`code`, `cursor`, `kitty`, `ghostty`, `wezterm-gui`).
- **Measured on Diego's Mac, 2026-11-15** (macOS 26.6.2, names only, `ps -axo pid=,ppid=,comm=`):
  - Orca: `claude` → `bash` → `bash` → `login` → `…/Library/Application Support/orca/daemon-host/macos/terminal-host-<hash>/app.noindex/Orca Terminal Host.app/Contents/MacOS/orca-terminal-host` → launchd. That bundle's id is `com.stablyai.orca`: Orca.
  - Terminal: `-bash` → `login` → `/System/Applications/Utilities/Terminal.app/…`.
  - The Claude desktop app: `claude` → `/Applications/Claude.app/…`; its own engine runs from a bundle of its own (`…/Application Support/Claude/claude-code/<version>/<hash>/claude.app`), which is in no table.
  - tmux and herdr: `claude` → `bash` → `tmux` (or `herdr-core`) → launchd. No app: not known yet.
  - Paths are printed whole (161 characters seen). A process started through a symlink inside `X.app/Contents/MacOS/` is printed with that path (Task 32 builds on it).
  - `comm` is not always a name: rows were seen whose `comm` was hundreds of characters of a prompt. Hence Review Focus 9.
  - **Not measured there** (not installed, or no session open in them): Ghostty, VS Code, Cursor, iTerm2, kitty, WezTerm, Warp. Verification check 5 measures them.
- **Windows:** not here. A parent's id there can be a dead process's, taken by another (Windows re-parents nothing), and the devices read no process table on Windows today (`observed.ts`: "Windows has no `ps` here"). A session on Windows waits for its first hook (Follow-ups).

**Files:**
- Create: `cli/src/cable/hosts/scannedApp.ts`, `cli/src/cable/hosts/scannedApp.spec.ts`
- Modify: `cli/src/cable/hosts/observed.ts` (`ObservedDeps`, `scanOnce`), `cli/src/services/devices.ts` (`observedSource`: one line)
- Test: `cli/src/cable/hosts/observed.spec.ts`, `cli/src/services/devices.spec.ts`
- Not touched: `hostDetect.ts`, `frontApp.ts` (no new row: the list is closed), `lib/processTable.ts`, `lib/sessionSearch/**`, `lib/processEnv.ts`.

**Interfaces:**
- Consumes: `RunningProcess`, `run` (`lib/sessionSearch/externals/types.ts`, `support.ts`); `frontAppId`, `FRONT_NONE` (`frontApp.ts`); `APP_IDS`, `UNKNOWN_APP` (`hostDetect.ts`); `appPending` (Task 30).
- Produces, in `scannedApp.ts`:
  - `type ProcessName = Pick<RunningProcess, 'pid' | 'ppid' | 'executable'>` — all the walk reads of a process. It has no `args`, so the walk cannot hand a command line on.
  - `const WALK_PARENTS = 16`, `const BUNDLES_A_PASS = 16`, `const BUNDLE_ID_TIMEOUT_MS = 1_000`
  - `appRoots(home: string): string[]` — `/Applications/`, `/System/Applications/`, `<home>/Applications/`, `<home>/Library/Application Support/`. The folders macOS asks no permission to read. Desktop, Documents, Downloads, another volume and an app's container can ask, so a bundle there is not read.
  - `bundleOf(executable: string, roots: readonly string[]): string | undefined` — the path up to and with the first `.app` segment, when `executable` starts with `/`, is at most 1024 characters, has no `.` or `..` segment and no control character, and that path starts with one of `roots`. Else `undefined`.
  - `readBundleId(bundle: string, exec: typeof run = run): Promise<string | undefined>` — `exec('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', `${bundle}/Contents/Info.plist`], BUNDLE_ID_TIMEOUT_MS)`, trimmed, and kept only when it matches `/^[A-Za-z0-9.-]{1,128}$/`. Any failure is `undefined`.
  - `interface ScannedAppDeps { platform: NodeJS.Platform; roots: readonly string[]; processes(): Promise<readonly ProcessName[]>; bundleId(bundle: string): Promise<string | undefined> }`
  - `scannedApps(pids: readonly number[], deps: ScannedAppDeps): Promise<Map<number, string>>` — each pid's app id; a pid nothing named is left out.
  - `learnApps(pids: readonly number[]): Promise<Map<number, string>>` — the real one: `scannedApps` with `process.platform`, `appRoots(homedir())`, its own `ps` read (`readProcessNames`) and `readBundleId`.
- Rules of `scannedApps`:
  0. On `darwin` and `linux`, and with at least one pid, it reads the table once (`deps.processes()`). On any other platform, or with no pid, it reads nothing and answers nothing. An empty table (a `ps` that failed) answers nothing.
  1. From the session's own process, then its parent by `ppid`, and so on: at most `WALK_PARENTS` parents. It stops at a `ppid` of 1 or less, at a process the table does not hold, and at one it has already passed.
  2. `darwin`: a process whose `bundleOf` is defined names `frontAppId(await deps.bundleId(bundle))`. `linux`: a process names `frontAppId(executable)`.
  3. A name that is in `APP_IDS` and is not `UNKNOWN_APP` is the answer, and the walk ends. Anything else (`none`, the unknown app) is passed over and the walk goes on. A bundle whose id was not read (past `BUNDLES_A_PASS`, or unreadable) ends the walk with no answer: not known yet, never an outer app's guess (`a3cdb88d67`). **The scan never answers `terminal`.**
  4. One bundle is read once a pass however many sessions sit under it, the distinct bundles of a pass are read together, and at most `BUNDLES_A_PASS` are read: a bundle past that names nothing.
  5. Nothing outlives the call but the map of pid to app id. Nothing is logged here.
- Produces, on `ObservedDeps`: `apps?(pids: readonly number[]): Promise<ReadonlyMap<number, string>>` — the app each of these processes runs in, where its parents name one. Absent, nothing is learned. `services/devices.ts` gives it `learnApps`.
- Rules of `scanOnce`:
  - After the rows are read, and only when at least one session has a row and no entry: one `deps.apps` call for those sessions' owner pids, at most `MAX_SESSIONS` of them. Then the loop as today.
  - A new entry whose pid has an answer starts with that `app` and no `appPending`. `host` and what a tap opens stay as the scan sets them: the spec gives the scan the app alone.
  - A session a hook told of while the apps were read keeps what the hook said (the loop's own `entries.has` check, which now runs after that wait).
  - A call that rejects is no answer for any: every session is listed, not known yet.
  - **Once.** A session the scan listed is never asked about again: its next hook is the next word on where it runs. No timer, no retry.
  - One log line for a pass that listed a session: `[observed] scan · <n> found · <m> app known · <ms> ms`, with `ms` the time of the `deps.apps` call by `deps.now`; and `[observed] scan · apps not read` for a call that rejected. Counts only: no app, no pid, no path, no error text (a path holds the account's name).

- [ ] **Step 1: Write the failing tests.** Every process in them is made up in the test; none reads the machine's own.
  - `scannedApp.spec.ts`, with a made-up table as `processes` and a fake `bundleId` that records what it was asked:
    - `Claude Code under bash, bash and login under Orca's terminal host is in Orca` (the measured chain, with `<home>` a made-up folder; the host's bundle answers `com.stablyai.orca` → `orca`).
    - `the outermost .app of a helper's path is the app` (`/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)`: `bundleId` is asked for `/Applications/Visual Studio Code.app` alone → `vscode`).
    - `a bundle no table lists is passed over, and the nearest listed app decides` (an engine in `…/Application Support/Claude/claude-code/1/x/claude.app` answering `com.example.engine`, under `/Applications/Claude.app` → `claude`; kitty started from a shell in Ghostty → `kitty`).
    - `an app no table lists names nothing: never the unknown app` (`/Applications/Alacritty.app`, `org.alacritty` → the pid is left out of the answer).
    - `tmux, launchd and a parent the table does not hold name nothing`.
    - `a walk stops after 16 parents, and at a loop` (a chain of 40 under Ghostty names nothing; `a → b → a` ends).
    - `a bundle outside the four folders is not read` (`<home>/Downloads/Ghostty.app/…`, `/Volumes/USB/Ghostty.app/…`, `/Applications/../Users/x/Documents/Ghostty.app/…`, a 2000-character path: `bundleId` is never called).
    - `a process name that is not a path is passed over` (`claude`, `-bash`, and a title that holds `/Applications/Ghostty.app/Contents/MacOS/ghostty` after other words).
    - `one bundle is read once a pass, however many sessions; at most 16 bundles a pass` (50 pids under one app: one call; sessions under 20 apps: 16 calls, and the sessions past them are left out).
    - `a bundle id that could not be read names nothing, and the walk goes on` (`bundleId` answers `undefined`, then rejects).
    - `a table that could not be read names nothing` (`processes` answers `[]`).
    - `on Linux the executable's name names the app` (`code` → `vscode`, `cursor`, `kitty`, `ghostty`, `wezterm-gui` → `wezterm`; `bundleId` is never called); `on Linux windowsterminal and a name no table lists name nothing`.
    - `on Windows nothing is learned and nothing is read` (`processes` and `bundleId` are never called); `with no pid nothing is read`; `the table is read once a pass, however many pids`.
    - `nothing of a process is kept or said` — each row's `args` is a getter that throws, and one row's `executable` holds the marker `SECRET-TOKEN`: the call completes, and the answer's JSON holds app ids and pids only.
    - `readBundleId asks plutil for CFBundleIdentifier alone, under 1 s` (a fake `exec`: the command, the six arguments and `1000` exactly); `an answer that is no bundle id is none` (empty, 500 characters, one with a space or a slash, `null`).
    - On macOS only (`describe.skipIf(process.platform !== 'darwin')`): `readBundleId` with the real `plutil` on a bundle made in a temp folder, as XML and as a binary plist, and on a folder with no `Info.plist`.
    - `appRoots gives the four folders, each ending in a slash`.
    - `the scan's files name no environment reader` — the source of `scannedApp.ts` and of `observed.ts` matches none of `/processEnv\.js/`, `/\benviron\b/` (the word alone: "environment" may be written), `/\beww\b/`, `/'-E'/`, `/process\.env/`. Neither file matches any today.
  - `observed.spec.ts` (`setup` takes an `apps` fake):
    - `a session the scan found under a listed app is on that app's page from its first listing, and known` (`apps` answers pid 11 → `ghostty`: `{ app: 'ghostty', host: 'terminal' }`, no `appPending`).
    - `the scan asks once a pass, for the new sessions' pids alone, and never again for one it listed` (pids 11 and 12, then a scan with a third session asks `[13]`; a scan with nothing new asks nothing).
    - `a session nothing was learned of is not known yet, and its first hook still names its app`.
    - `a learn that fails still lists every session, not known yet` (the log has `[observed] scan · apps not read`).
    - `a process table that cannot be read leaves every session not known yet, and listed` (`apps` answers an empty map).
    - `a hook that told of a session while its app was being learned wins` (the `apps` call held; a hook with `TERM_PROGRAM: 'ghostty'`; the call answers `vscode` → `ghostty`).
    - `the scan's log line counts and names nothing` (`[observed] scan · 2 found · 1 app known · 0 ms`; no log line holds an app id, a pid or a path).
    - `with no apps reader the scan lists as before`.
  - `devices.spec.ts` (`vi.mock('../cable/hosts/scannedApp.js')` with `learnApps` a recorded fake, beside the readers it already replaces): `the scan asks which app each session it found runs in, by pid` (the session of pid 77 found open: `learnApps` was called with `[77]`).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/scannedApp.spec.ts src/cable/hosts/observed.spec.ts src/services/devices.spec.ts`. Expected: FAIL (the module is missing; `apps` is never asked).
- [ ] **Step 3: Implement.** In `services/devices.ts` the change is `apps: learnApps` in `observedSource` and its import: no function of its own there, so the file stays at 100%.
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npm run typecheck && npx vitest run src/cable src/architecture.spec.ts && npm run test:core`. Expected: PASS, 100% per file for `services/devices.ts`. On a Mac, so the `plutil` cases run.
- [ ] **Step 5: Commit** `devices: the scan learns an agent's app from its parent processes' executables, never an environment`.

### Task 32: End to end: plugged in over agents already running

**Layer:** test. **Depends on:** Tasks 30, 31. **Effort:** `high`. **Red test:** none: no behavior (it turns an end-to-end test to what Tasks 30 and 31 built, and gives the test's agents a fake app to run under).

**Files:**
- Modify: `cli/e2e/harness/outsideAgent.ts`, `cli/e2e/dialAppFilter.e2e.ts`

**Interfaces:**
- Produces: `Outside.start(d, folder, hints, app?: 'ghostty' | 'vscode')`. With `app`, the tab runs under a fake of that app, so the engine's parents are `python3` (the pseudo-terminal), then the fake app, then the suite:
  - macOS: `<d.env.HOME>/Applications/<Ghostty | Visual Studio Code>.app`, with a `Contents/Info.plist` whose `CFBundleIdentifier` is `com.mitchellh.ghostty` or `com.microsoft.VSCode`, and `Contents/MacOS/<name>`, a symlink to `process.execPath`. The daemon's home is the throwaway one, so this is under one of its four folders.
  - Linux: `<d.root>/apps/<ghostty | code>`, a symlink to `process.execPath`.
  - The tab is that executable running a few lines that start the pseudo-terminal helper on its own stdio and exit with it.
  - Measured on a Mac (2026-11-15): `ps -o comm=` prints such a process with the symlink's path inside the `.app`. On Linux a process is named as it was started; the Linux run of Verification check 1 is the proof.
  - Without `app` the tab is started as today.
- **Which answer the turned test wants: VS Code, by the front.** Ghostty has three agents and VS Code two, so the default alone would be Ghostty. The dial is sent VS Code's ring because the watch told the devices the app in front when the dial attached, and that can only be so when the scan knew the two VS Code agents' app with no hook.

- [ ] **Step 1: Turn the test** `a dial plugged in while VS Code is already in front (the watch started first) is sent VS Code's ring` (it keeps its name, so Review Focus 7 follows it):
  - The five agents are started before the dial, as today: `a1` to `a3` with `app: 'ghostty'`, `a4` and `a5` with `app: 'vscode'`.
  - **Nobody types a prompt.** The line `for (const engine of [...ghostty, ...vscode]) engine.type('the dial is in')` and the comment above it go.
  - It waits, as today, for `apps` with `{ ghostty: 3, vscode: 2 }`, `shown: 'vscode'` and VS Code's two in the list.
  - New: no `apps` frame the dial was sent has a `terminal` entry (the five were never on Other's page), and the daemon's log has a line that matches `/\[observed\] scan · 5 found · 5 app known · \d+ ms/`.
  - Skipped on Windows, which learns nothing at the scan.
- [ ] **Step 2: Show the test tests it.** With `apps: learnApps` taken out of `services/devices.ts` by hand (not committed), run the test: Expected FAIL, the five on Other's page and `shown: 'terminal'`. Put the line back.
- [ ] **Step 3: No other test leans on the terminal the suite is run from.** `git grep -n "Outside.start\|startOutside" cli/e2e`: in every test that reads an `apps` frame, an agent started before its dial is plugged in has an `app`. Today this test is the only one; `deviceWithoutApp.e2e.ts` plugs in no dial that says `appFilter` (`git grep -n appFilter cli/e2e/deviceWithoutApp.e2e.ts` prints nothing). An agent started after the dial is named by its first hook, as before.
- [ ] **Step 4: Run** `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialAppFilter.e2e.ts e2e/deviceWithoutApp.e2e.ts`, three times over. Expected: PASS each time. A failure of the turned test is evidence for Review Focus 7: keep its output for the final review, and do not raise a timeout.
- [ ] **Step 5: Commit** `e2e: a dial plugged in over agents already running knows their apps`.
- **Not end to end:** the default over agents not known yet. An end-to-end agent with no listed app above it has the developer's own terminal above it, so a run could not hold it not known on every machine. Task 30's four specs are its proof.

---

## Verification

**Local gates**, recorded in the pull request (PR CI does not run them):
- `cd cli && npm run typecheck && npm run test:core` — 100% per file for `services/devicesListener.ts`, `services/devices.ts` and `services/devicesProcess.ts`; and `npx vitest run src/architecture.spec.ts src/leanEntry.spec.ts`. These receipts now prove the **core is unchanged**: with them, from the repo root, `git diff --stat <base> -- cli/src/core cli/src/localWsServer.ts cli/src/localWsServer.spec.ts cli/src/architecture.coreFiles.txt cli/src/architecture.spec.ts` prints nothing (`<base>` is `$(git merge-base HEAD fix/dial-swipe-order)`, or `origin/main` once the stack has merged), and `git grep -n "dial_front\|dialFront\|FRONT_APPS" -- cli/src` prints nothing.
- `cd cli && npx vitest run src/cable/hosts src/cable/cableHost.spec.ts src/services/devices.spec.ts`, **on a Mac** (Tasks 30, 31): `scannedApp.spec.ts` has cases that run only there (`readBundleId` with the real `plutil` on a bundle the test makes in a temp folder). A run on Linux skips them, so the Mac run is the one recorded.
- `git grep -nE "processEnv\.js|/environ|\beww\b" -- cli/src/cable cli/src/services/devices.ts cli/src/services/devicesProcess.ts cli/src/services/devicesListener.ts ':!*.spec.ts'` prints nothing (as it does at `4126d89b25`): nothing this work touches reads a process's environment (Global Constraints).
- `python3 -m unittest discover -s scripts/tests -p 'test_ci_plan.py'` — the CI plan still carries every suite (Task 20 changed `device-app-checks`).
- `cd device-app/ui && npm ci && npm run build`, then `cd device-app/src-tauri && cargo test --lib` and `cargo test --locked`, **on a Mac**: PR CI compiles and tests the app's Linux code only, so `front_macos.rs` is compiled nowhere else.
- `env -u IDF_PATH make device-test`, every `devices/harness-device/firmware/test/test_*.py` with `IDF_PATH=~/esp/esp-idf-5.5.4`, and the `default` build with `-DPROJECT_VER=0.1.0-dev`.
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit; its receipts go in the pull request.
- Not needed: `npm run test:harnessd` and the serial specs (nothing of theirs changes).

**Platforms the pull request names:** the daemon and CLI on macOS, Linux and Windows; the Harness Device app on macOS and Linux X11; the round dial. On Windows the dial filters by app and takes a pick, and follows nothing: there is no source of the app in front and no devices listener there (`devicesListenerPath` is `null`, so nothing is opened and the watch tells nothing) until the Harness Device app for Windows (a follow-up). This plan has no Windows check (the PM, answer 2): `windows.yml` runs a fixed list of Windows specs, none of them touched or added to, and is not started. The new specs skip their socket cases on Windows and run the rest. Tasks 30 to 32: "not known yet" and the default are the daemon's on all three platforms; the scan learns an app on macOS and Linux, and on Windows a session waits for its first hook (a follow-up).

**Turns.** The tester asks before using either, and starts nothing until it is granted.
- **A runner turn,** asked of the orchestrator, before the one hand-started run on GitHub: CLI end to end (check 1: eight shards, about 70 minutes of test time).
- **The dial and Diego's turn,** asked of the PM, before check 4. The shared dial is used only after the PM's go, and only for the steps asked for.

**Temporary workflow:** none. The X11 check runs in PR CI's own job (Task 20).

**1. The daemon, a fake dial and the real watch**
- Run: `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialAppFilter.e2e.ts e2e/deviceWithoutApp.e2e.ts e2e/hardwareWatch.e2e.ts e2e/deviceCompat.e2e.ts e2e/devicesProcess.e2e.ts`, on a Mac or a Linux box.
- Isolation: the suite's own (`e2e/harness/daemon.ts`): a throwaway home and data folder, a private port and tmux server, fake engines, a fake dial on a pseudo-terminal, no backend and no sign-in.
- What it proves end to end: the watch's stdin → the devices process's own socket (`devices.sock`, 0600, in the throwaway data folder) → the filter → the fake dial's frames. The core's socket carries none of it.
- A person sees: every test passes; the daemon's log has `[devices] listener open`, and `[device] app filter: switched · front` and `· pick` lines with no app in them.
- Plugged in over agents already running (Task 32): five fake Claude Codes, each under a fake app in the throwaway home (macOS) or root (Linux), are started before the dial and type nothing. The dial is sent `apps` with Ghostty 3 and VS Code 2, never a `terminal` entry, and VS Code's ring; the log has `[observed] scan · 5 found · 5 app known · <n> ms`. That `<n>` on a Mac and on the runner is the number the pull request records for the scan's added time (one `ps`, and on a Mac two `plutil` reads). No process of the developer's own is asked about: the walk ends at the fake app.
- On GitHub, by hand, once on the final head, after a runner turn: Actions → CLI end to end → Run workflow, branch `feat/dial-app-filter` (`.github/workflows/cli-e2e.yml`). Every shard passes. This is also the Linux run of the daemon's side of the spec's check 9.

**2. Linux X11: the front line arrives**
- Where: PR CI's `device-app-checks` on `ubuntu-latest`, its step `X11 front source, live` (Task 20): Xvfb, `openbox`, two `xterm` clients, one of them copied to the name `code`.
- Isolation: the runner. No daemon, no backend, no login, no secret.
- A person sees: the step prints `x11_live ... ok`: the source gave `xterm`, then `code`, as each window was brought to the front.
- That `code` in front becomes `vscode` and turns the dial is Tasks 11 and 28's tests and check 1.
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
  3. **Rig run 2. Check 1:** the same five agents. The dial opens on Ghostty. The face says "Ghostty". A swipe goes around Ghostty's three only. On an agent of an engine with no relaxing scene, the resting hint that names a hold says "Hold to switch apps"; on Claude Code's relaxing face it says "Hold for apps" (Tasks 18, 29).
  4. **Check 2:** hold → `APPS`: Ghostty `3 agents`, VS Code `2 agents`. Browsing changes nothing on the face behind. Pick VS Code: VS Code's two, in the order they started.
  5. **Check 3,** with the debug Harness Device app running (started after the dial greeted, so the rig's devices process and its listener are up): bring Ghostty to the front: the dial turns to Ghostty in about 1 s. Cmd-Tab across three apps and back within a second: nothing moves. Finder in front: nothing moves.
  6. **Check 4:** pick VS Code on the dial with Ghostty in front: it holds. Safari, then Ghostty, in front: the dial returns to Ghostty.
  7. **Check 5:** a VS Code agent asks for approval while the dial shows Ghostty: the bell rings; `APPS` says `2 agents · 1 waiting` on VS Code; opening the notice turns the dial to that agent.
  8. **Check 6:** a fake Claude Code in zellij inside Ghostty is in Ghostty's ring; its face says "Ghostty"; a tap says "See it in Zellij".
  9. **Check 7:** not run on the dial: opening the Harness desktop app would start and reach the everyday daemon. Its two halves are check 1 above (`a window opens: the tab's list and no apps`) and Task 18's host tests (`a hold with a window opens TABS`).
- Evidence: `<out>/daemon.log` of both runs (`[devices] listener open`, `[device] app filter: switched · …`, `[device] app filter: picker` and `cable: agents → N of M` lines), the rig's counts, and a photo of the face and of `APPS`.
- **Afterwards:** end the run and quit the debug app (the rig removes its throwaway root). Flash the released firmware back (`harness flash`), then run `harness start`. Check the dial lists the everyday daemon's agents, and tell the PM and the orchestrator the dial is free.
- Not done, for whatever reason: report check 4 as not verified, never as passed.
- Tasks 30 to 32 add no step here: they change no frame and no firmware, and a dial plugged in over agents already running is check 1's test, on the fake dial. What real apps' processes look like is check 5.
- On GitHub: none. It needs a real dial.

**5. The scan on real apps** (Task 31)
- Why by hand: the walk was measured on one Mac for Orca, Terminal and the Claude desktop app. Ghostty, VS Code, Cursor, iTerm2, kitty, WezTerm and Warp were not installed or had no session open there, and no runner has them.
- Where: a Mac, in a desktop session, in the feature worktree at the final head, with as many of those apps as it has. No Linux desktop is named for this plan, so Linux is Task 31's spec and check 1 on the runner.
- Isolation: no daemon, no backend, no account, no dial, nothing written. The command reads what the everyday daemon's own `ps` reads every 30 s (process ids, parent ids and executable names) and the `Info.plist` of the apps above the tab it is run in. It reads no environment and prints an app id alone.
- Run, in a tab of each app: `cd cli && npx tsx -e "import('./src/cable/hosts/scannedApp.ts').then((m) => m.learnApps([process.pid])).then((apps) => console.log(apps.get(process.pid) ?? 'not known yet'))"`.
- A person sees: `ghostty` in Ghostty, `vscode` in VS Code's terminal, `cursor` in Cursor's, `terminal-app` in Terminal, `kitty`, `wezterm`, `warp`, `orca` in Orca. Under tmux or zellij, and in iTerm2 with its default settings: `not known yet`, which is expected (Open question 4). macOS asks for no permission.
- Record in the pull request one line per app: what it printed, or "not installed here". An app nobody ran it in is reported as not measured, never as passed. A listed app that prints `not known yet` is a finding for the final review, and for Open question 4.
- On GitHub: none. It needs real apps in a desktop session.

## Open questions

**Open, from the PM's decision of 2026-11-15 on agents the scan found** (Tasks 30 to 32). The plan is written to option A of each; B changes only the task named. They are numbered on from the two answered below.

3. **When the page of agents not known yet was the default, and an app then gets a known agent.** The spec says that page "is shown by default only when no other app has an agent", and rule 1 (§ Which app is shown) runs the default again only when the shown app "has no agents left". Diego's morning is exactly the gap: the first list holds only agents not known yet (in tmux, in iTerm2), "Other" is shown, then hooks name apps one by one.
   - A (the plan, Task 30): the default gives way as soon as any app has a known agent, counted as an `empty` switch. Only a default gives way: a pick of that page, and the front showing it, hold. The dial moves once by itself, away from a page nobody chose.
   - B: rule 1 as written. "Other" stays shown until the person brings an app to the front or picks one. Task 30 drops `byDefault` and three tests.
   - If A: is `empty` the right cause to count it under, or does it get a cause of its own (a change to the spec's Measures)?
4. **Terminals whose shells hang under a process of launchd's.** The walk names nothing for a session in tmux, zellij or herdr (measured: `tmux` and `herdr-core` are launchd's children), and by default in iTerm2, whose shells are started by `iTermServer`, not by iTerm2's app (not measured: iTerm2 is not installed on the Mac this was planned on; Verification check 5 measures it).
   - A (the plan): they are not known yet until their first hook, on Other's page, and never win the default.
   - B: a new row for iTerm2's server (its executable's name). The tables are closed ("a new row is a new decision"), so it is the PM's to add, and only once check 5 has shown what the name is. tmux and zellij get no row either way: one server holds sessions seen from any terminal.
5. **The repo already reads other processes' environments, outside this work.** `cli/src/lib/processEnv.ts` runs `ps eww -p <pid> -o command=` and reads `/proc/<pid>/environ`, for the core's own panes (`lib/gatewayRuntime.ts`, `lib/gridAssignment.ts`, `lib/terminalAgentDiscovery.ts`, `engines/discoveries.ts` and others). The PM's rule of 2026-11-15 is written in this spec, for the scan.
   - A (the plan): the rule binds what this work adds. Nothing here imports or calls that file, a test and a grep say so, and the file is not touched (`AGENTS.md`, Scope: build only what the task asks).
   - B: the rule is the repo's. Then it is a proposal to the PM of its own, outside this pull request.

**Answered earlier.** The PM answered both of 2026-11-15 the same day: 1. **A** (exactly as the core: 0600, an owner-only folder, the client checks owner and mode; no native code). 2. **B** (the watch tells its current app again when the dial attaches; Task 28 and one Task 19 test). Kept below for the record.

1. **"The peer's uid, as the core's local socket checks it."** The core's local socket reads no peer uid: Node has no call for it. What it has is the file as the credential: a 0600 socket in a folder that is the owner's alone, so the kernel refuses another account's `connect`, and a client looks at the socket's owner and mode before it sends (`lib/localSocket.ts`, `lib/localTransport.ts` `socketIsPrivate`).
   - A (the plan, Tasks 26 and 28): the devices listener does exactly that, with the same helpers. Its tests prove the mode, the folder's owner and the client's check; a second account connecting for real is not run, as no unit test has one.
   - B: also read the peer's uid from the kernel on each connection (`SO_PEERCRED`, `LOCAL_PEERCRED`). That needs native code in the devices process, which the daemon does not have today: a new decision, and a change to Task 26 alone.
2. **The first app in front after the devices process starts.** The spec says the watch "tries again on the next change". The devices process starts on demand, when a dial is plugged in, and the Harness Device app's watch is usually running before it. So a dial plugged in while Ghostty is in front opens on the app with the most agents, and turns to Ghostty only after the person's next app switch.
   - A (the plan, Task 28, the spec as written): nothing more.
   - B: the watch also tells its current app when the `dial_status` it already hears turns to `attached: true`. One more tell on the same path, no new state in the daemon; a change to Task 28 alone, and one more test in Task 19.

Answered by the PM on 2026-11-15: the core knows nothing of the app in front, and the devices have a shared listener of their own (Tasks 24 to 28); the Swarm's exceptions are gone (Tasks 5, 6, 16, 18 as marked); "Hold to switch apps" (Task 29).

The draft's eight were answered by the PM on 2026-11-14:

1. **The core's change:** first A (a core file, `cli/src/core/dialFront.ts`, Tasks 8 and 10). **Replaced on 2026-11-15:** nothing in the core; Task 24 reverts it.
2. **Windows:** A. macOS and Linux X11 now; the Windows source is a follow-up, and this plan has no Windows check.
3. **Rows the tables lacked:** kitty and WezTerm by bundle id, WezTerm by `TERM_PROGRAM` (kitty sets none), and `ai.autonomous.harness` (Tasks 2, 11, each row with its source). Cursor outside macOS is a follow-up.
4. **Two pages named "Terminal":** B. The unknown app reads "Other"; Apple's Terminal stays "Terminal" (Global Constraints; Tasks 2, 5, 17, 19).
5. **The picker's measure:** A. Each `app.pick` is counted (Tasks 5, 7).
6. **While a Harness window is open:** A. The filter keeps following the app in front (Tasks 5, 27, 19).
7. **The X11 check after this pull request:** B. It runs in PR CI's `device-app-checks` (Task 20); the temporary workflow is gone.
8. **The on-dial check's agents:** A. The suite's fake Claude Code against an isolated daemon, through an opt-in rig (Task 22).

Still waited on, outside this plan: `fix/dial-swipe-order` and PR #4296 reaching `main`, before this branch's pull request can land on it.

## Decided here, where the spec was silent

- The first app shown, when none was, is not counted as a switch. `empty` is an app replacing one that emptied.
- A pick of the shown app is answered with nothing; a pick of an app with no agents is answered with `apps` alone.
- After a notice turned the dial to an agent in another app, an agent the dial cannot bring forward (no `f`) is not "opened": no toast.
- An app with no bundle id, and an X11 window with no pid, are the empty value, which the watch sends as `none`.
- An XWayland `DISPLAY` under a Wayland session reports nothing.
- The measures are daemon log lines, as the notify tally and wave 1a's approvals are: `[device] app filter: switched · <cause>` and `[device] app filter: picker`.
- A new crate for Linux, `x11rb`.
- An agent the open scan found is on the unknown app's page (`terminal`, "Other") until its first hook event names its app. Its face line read "Terminal" before, from its host. (Since 2026-11-15 it is also marked not known yet: see `appPending` below.)
- **The rename** (answer 4 asked for the two to be kept apart): the front value for "no listed app in front" is `none`, not `other`. The unknown app keeps the id `terminal` and reads "Other". On macOS and Linux the dial reaches "Other" by a pick or as the default, never by following: an unknown terminal in front is `none`. The one row that gives the id `terminal` is `WindowsTerminal.exe`, which nothing sends yet; what Windows Terminal reads as is the Windows wave's to settle.
- **kitty off macOS:** kitty sets no `TERM_PROGRAM`, so with no bundle id and no `TERM_PROGRAM`, `KITTY_WINDOW_ID` names kitty as the outer app, also inside zellij (Task 2, step 4). It never decides against a bundle id or a `TERM_PROGRAM`.
- **`ai.autonomous.harness` is a row of both tables:** the front table (the question asked) and `detectApp`'s bundle table, so the two cannot disagree about one bundle id. `detectHost` does not change.
- **The `.exe` rows stay** in the front table, as answer 2's option A says, though nothing sends them until the Windows source exists.
- **The rig runs twice on the dial** (check 4): once on the firmware the dial has, once after the flash, because a daemon that holds the port cannot be flashed past.
- **The listener speaks HTTP on its socket** (2026-11-15). The spec says "message" and "frame" and names no wire. `listenLocalSocket` serves HTTP, the connectors' `bridge.sock` already does, and the hook scripts #4296's follow-up will point at the listener post HTTP to the core today. One message is one `POST /`; "per connection" is the HTTP connection.
- **The listener reuses `lib/localSocket.ts`** (`socketPathIn`, `listenLocalSocket`) rather than a copy of it. It is a `lib/` helper that every service process already loads and the connectors service already serves a socket with; it is not under `src/core/`, and this work does not change it. A second copy of the stage-chmod-link claim would be a second way to do one security-critical thing.
- **A sender that opens a new connection for each message** is not held by a per-connection rate. It is held by the 16 connections the listener takes at once, and each message still costs one bounded parse.
- **What a dropped message is answered:** a status (`400`, `404`, `405`, `413`, `429`, `500`) and an empty body. Nothing a sender wrote comes back or is logged.
- **The listener's log lines:** `[devices] listener open`, `[devices] listener not opened · folder not private|in use|failed`, and the minute's counts. None has a path: a path holds the account's name.
- **`front`'s body limit is 64 bytes.** The spec gives each type "its own body limit" and no number; the longest valid message is 37 bytes.
- **With the devices inside the core's process** (`HARNESSD_SERVICES=none`, Harness OS) there is no listener, by the spec's "runs only in the devices process": the dial filters and takes a pick, and does not follow the app in front.
- **`harness reset` is not changed.** The listener removes its socket when it closes, and a file left by a process that was killed is replaced at the next open. A reset that keeps the data folder leaves such a file there until then: nothing can connect to it.
- **The watch tells the newest app only.** While one tell is under way, changes between it and the newest are skipped: the filter settles on the last one anyway.
- **The revert is one commit** (Task 24), tests and code together, as the PM asked: its red is the base's own tests failing against the code still there, shown before the code goes.
- **Not known yet is a flag, `appPending`, beside `app: 'terminal'`** (Task 30, with its reasons). An agent the scan found is on the unknown app's page, and not known to be in it.
- **`apps` counts an agent not known yet on Other's page.** The spec says it "sits in Other's ring and page", so the page's count is what a swipe there goes around. The wire and the firmware are unchanged. The picker can so read "Other · 5 agents" while the dial opens on Ghostty's two.
- **Any hook makes an agent known,** also one with no hints at all: the spec's "until its first hook". It is then in "Other" for good reason: it spoke and named no app.
- **The scan never answers "Other".** A parent in an app no table lists is passed over, not taken as the unknown app, for two measured reasons: the Claude desktop app runs its engine from a bundle of its own, under Claude's, and a wrong "Other" is the fault this decision exists to end. So an agent in an unlisted terminal (Alacritty) is not known yet until its first hook.
- **The nearest listed app decides,** from the session's own process outward. It is the app whose window holds the session, and it is what the hook's own `__CFBundleIdentifier` names in every chain measured.
- **A learned app sets `app` alone.** `host`, the capabilities and what a tap opens stay as the scan found them, until a hook: the spec gives the scan the app.
- **Four folders are read for a bundle id:** `/Applications`, `/System/Applications`, and `Applications` and `Library/Application Support` under the home. This is the spec's "with no new permission": macOS can ask before a process reads Desktop, Documents, Downloads, another volume or another app's container. The fourth is there because Orca's terminal host lives in it. An app run from anywhere else waits for its first hook.
- **The bundle id is read with `plutil`,** not parsed here: an `Info.plist` is XML or binary, and one tool reads both. The eight read on the Mac this was planned on were all XML.
- **One process table a pass,** the scan's own comm-last `ps -axo pid=,ppid=,comm=`, not a `ps -o ppid=,comm= -p <pid>` for each parent: the same three columns, in one spawn, as one picture.
- **No second try.** A session the scan listed without an app is not asked about again: the spec's "no polling", and its next hook says more than a second walk would.
- **The scan's measure is a log line,** `[observed] scan · <n> found · <m> app known · <ms> ms`, as the other device measures are log lines: counts and a time, no app, pid or path.
- **Windows waits for the first hook** (the brief's own default, kept): a dead parent's id can be another process's there, and the devices read no process table on Windows today.
- **The end-to-end test wants VS Code by the front,** not the default (Task 32): it is the test's old purpose, and it holds only if the scan knew the apps.
- **Task 32 is a task of its own,** not the third part of Task 31: it changes tests alone, and it needs Task 30 too.
