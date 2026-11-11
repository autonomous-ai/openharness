# Hidden windows stop polling — Implementation Plan

> Way of working: the project's Engineer workflow (docs/plans plan first, then each plan task test first —
> failing test committed before its code — with independent plan tasks run in parallel by subagents and
> merged into one pull request). Steps use checkbox (`- [ ]`) syntax.

**Goal:** A Desktop window or web tab that is hidden or closed, and the phone app in the background, make no
periodic backend requests; on return each poller reads once, then goes live again.

**Architecture:** One visibility signal per app, already in the code, used everywhere:
- Desktop and web app model: `AppNotifier.inSight` (`desktop/lib/state/app_state.dart`, true while the window
  is `resumed` or `inactive`; Flutter web turns `document.visibilityState == 'hidden'` into `hidden`, macOS an
  occluded, minimised or closed window). Long-lived pollers listen to it: off → cancel the timer; on → one
  read, then the timer again.
- Desktop and web widgets: the existing `VisibleTick` mixin (`desktop/lib/super_tabs/visible_tick.dart`:
  TickerMode on and the app shown). A widget poller ticks through it and reads once from
  `onScreenChanged(true)`.
- Swarm reads (`SuperTabClient.pageVisible` / `SuperTabController.away`): while the page is hidden and the
  server pushes, only a push reads; the safety nets wait for the return. Without push the away poll stays,
  so tags and notices still arrive (failure: nothing breaks silently).
- Phone: `AppNotifier.handleAppPaused` / `handleAppResumed` (`mobile/lib/state/app_state.dart`) stop and
  restart the app-model pollers; page pollers use `WidgetsBindingObserver` the way `swarm_machines.dart`
  already does.

Pollers already gated (Harness Monitor, the Swarm machines panel, its usage, machines panel, pull request
badges, model manager, agent messages watches, the web deaf watch, the web Swarm reading, phone desk/deaf
poll/Swarm reads) keep their gate and get a regression test where none pins "no request while hidden".

**Tech Stack:** Flutter 3.47 / Dart 3.13, flutter_test (`testWidgets` fake clock), the existing fakes
(`WsConn` subclasses, `ApiClient` subclasses, `MemoryStore`).

**Spec:** docs/plans/2026-10-28-websocket-optimization-roadmap.md, Phase 3 item 2, and task #2953's brief.

## Global Constraints

- Optimizations ship on, no switches (Ken).
- Phase 3 items 1 (shared E2EE session) and 3 (observer fan-out) are out of scope.
- Never run a test that signs the Mac out of the real CLI; Desktop tests use a memory store and a fake sign-in.
- Swarm code stays out of cli/src/core. No backend change.
- "Hidden" means not seen: Desktop `hidden`/`paused`/`detached` (minimised, occluded, closed to the menu
  bar); web tab hidden; phone `paused`/`hidden`. An unfocused window still in sight (`inactive`) keeps reading.
- Not periodic reads, left alone and listed in the PR: terminal stream heartbeats (`terminal_alive`, a 30 s
  lease the daemon holds the stream on), native pane leases (`renewNative`), WebRTC upgrade probes, socket
  reconnect backoff, the Desktop updater's check (Google Cloud Storage, not the backend), flows a person is
  in the middle of with their own deadline (pairing, Wi-Fi change, held New Harness, pet status).

## Review Focus

1. A window hidden while a read is in flight: the late answer still applies; no second timer is armed.
2. Hide → show → hide quickly: exactly one read on return, never two timers.
3. Sign-out while hidden, then show: nothing reads for the old account (existing sign-out cancels stay).
4. Desktop hidden with Swarm push down: the away poll still runs, so tag notices still arrive.
5. A machine that connects while the window is hidden starts no agent-sync timer until the window shows.

---

### Task 1: Desktop/web app model — agent sync, held sync, machine-list safety net, recovery loops

**Files:**
- Modify: `desktop/lib/state/app_state.dart` (`appLifecycleChanged`, `_startBackgroundRereads`,
  `_startAgentSyncTimer`, `_watchHeldLaunches`, `_scheduleRemoteOfflinePoll`, `_scheduleMachineRecovery`)
- Test: `desktop/test/hidden_window_rereads_test.dart`

**Interfaces:**
- Consumes: `AppNotifier.inSight` (ValueNotifier<bool>), `appLifecycleChanged(AppLifecycleState?)`.
- Produces: `@visibleForTesting Duration agentSyncEvery` (instance, defaults to `agentSyncInterval`), so a
  test can count ticks without a minute of fake time.

- [ ] **Step 1: Failing tests** — with one connected machine (fake `WsConn` counting `agents_list`) and a
  counting `ApiClient`:
  - `hidden: no agents_list for 5 agent-sync intervals; shown: exactly one at once, then on the interval`
  - `hidden: the 5-minute safety net reads no desk, agent messages or machine list; shown: one of each`
  - `a held agent is not re-read while hidden`
  - `a machine connecting while hidden starts reading only when shown`
  - `hide, show, hide within one interval: one read, one timer`
- [ ] **Step 2:** Run `flutter test test/hidden_window_rereads_test.dart` — FAIL (reads while hidden).
- [ ] **Step 3:** Commit the failing test.
- [ ] **Step 4: Implement** — `inSight` false cancels agent-sync, held-sync and the safety-net timers and
  makes the recovery/offline loops skip their read and stop rescheduling; `inSight` true re-arms them and
  reads each once (`_syncAgentsIfChanged` per connected machine, the safety-net tick's reads once).
  `_startAgentSyncTimer` arms nothing while not in sight.
- [ ] **Step 5:** Run the test file and `held_launch_sync_test.dart`, `web_machine_list_watch_test.dart` — PASS.
- [ ] **Step 6:** Commit.

### Task 2: Desktop/web app-level controllers

**Files:**
- Modify: `desktop/lib/super_tabs/client.dart` (discovery), `desktop/lib/super_tabs/controller.dart` (desktop
  non-adaptive poll and receipt reads), `desktop/lib/settings/experimental_features.dart`,
  `desktop/lib/usage/models_menu_controller.dart` + where the app-level one starts
  (`desktop/lib/screens/swarm_screen.dart`), `desktop/lib/super_tabs/pull_request_facts.dart`,
  `desktop/lib/web/update/web_update_watcher.dart`, `desktop/lib/measurement/product_runtime_health.dart`
- Test: `desktop/test/hidden_window_controllers_test.dart`

**Interfaces:**
- Consumes: `SuperTabClient.pageVisible` (already set by `SuperTabWorkspace`), `AppNotifier.inSight`.
- Produces: `ValueListenable<bool>? seen` constructor parameter on `ExperimentalFeatures`,
  `ModelsMenuController` and `WebUpdateWatcher` (null = always seen, every existing caller and test).

- [ ] **Step 1: Failing tests:**
  - `Swarm: page hidden while pushing — no state read for 3 safety nets; shown — one read`
  - `Swarm: page hidden without push — the 15 s away poll still reads` (pins Review Focus 4)
  - `Swarm discovery: page hidden while pushing — no list read for 2 safety nets; shown — one`
  - `experimental settings: unseen — no read for 2 poll intervals; seen — one`
  - `models menu usage: unseen — no usage read; seen — one, then on the interval`
  - `backlog pull request facts: away — no status read; back — one`
  - `web update watcher: hidden — no manifest read; shown — one`
  - `runtime health: hidden — no sample, so no report scheduled`
- [ ] **Step 2:** Run the file — FAIL. **Step 3:** commit it.
- [ ] **Step 4: Implement** each as the test states, through the one listenable each already has or gets.
- [ ] **Step 5:** Run the file and each touched controller's existing test file — PASS. **Step 6:** Commit.

### Task 3: Desktop/web widget pollers (parallel subagent)

**Files:** `desktop/lib/sharing/harness_comments.dart`, `sharing/share_harness_dialog.dart`,
`sharing/shared_terminal_watch.dart`, `sharing/shared_agent_page.dart`,
`settings/sections/tab_invites_section.dart`, `orchestrator/orchestrator_controller.dart` (via its
workspace widget), `state/session_activity.dart` (via its widgets), `devices/devices_screen.dart`,
`store/store_screen.dart`, `widgets/swarm_resource_preview.dart`, `devices/wifi_robots.dart`
- Test: `desktop/test/hidden_widget_pollers_test.dart`

**Interfaces:**
- Consumes: `VisibleTick` (`visibleTick(Duration)`, `onTick()`, `onScreenChanged(bool)`), or for a non-widget
  controller a `bool Function() seen` / listenable handed in by the widget that owns it.

- [ ] **Step 1:** One failing test per poller: `<poller>: hidden app — no request for 3 intervals; resumed — one read at once`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Commit.
- [ ] **Step 4:** Gate each through `VisibleTick` (or the owning widget's lifecycle for controllers).
- [ ] **Step 5:** Run the file and each poller's existing tests — PASS. **Step 6:** Commit.

### Task 4: Phone background (parallel subagent)

**Files:** `mobile/lib/state/app_state.dart` (agent sync, offline retry, key watch in
`handleAppPaused`/`handleAppResumed`), `mobile/lib/usage/usage_controller.dart` + `phone/usage_page.dart`,
`mobile/lib/phone/welcome/your_computer.dart` (`ComputerWatch`), `mobile/lib/swarm/swarm_leaderboard_reader.dart`
(read once on return)
- Test: `mobile/test/background_polling_test.dart`

- [ ] **Step 1:** Failing tests: `<poller>: paused — no request for 3 intervals; resumed — one read`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Commit.
- [ ] **Step 4:** Implement through `handleAppPaused`/`handleAppResumed` and page lifecycle observers.
- [ ] **Step 5:** Run the file and the touched files' existing tests — PASS. **Step 6:** Commit.

### Task 5: Measurement — one idle hidden window, requests per minute

**Files:**
- Test: `desktop/test/hidden_window_requests_test.dart`

- [ ] **Step 1:** A widget test that mounts the real `SwarmScreen`, signed in (memory store, fake sign-in),
  two connected machines (fake `WsConn` counting every request by type), a counting `ApiClient`, and the
  app-level controllers started; sets the window hidden, runs 10 simulated minutes and prints requests per
  minute by kind. Asserts zero periodic requests while hidden, and at least one read of each kind within a
  second of `resumed`.
- [ ] **Step 2:** Run it on main's code (before) and record the printed numbers in the PR; run on the branch
  (after) — PASS with 0/min.
- [ ] **Step 3:** Commit.
