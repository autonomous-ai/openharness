# A machine's heartbeat no longer wakes a Swarm's reads and redraws Implementation Plan

> **Way of working:** by this project's instructions (Engineer role), not subagent-driven-development: each failing test committed and watched fail before its code, the branch pushed after each task, one independent review of the pull request. There is no Execution Handoff.

**Goal:** A machine's heartbeat changes only what shows machines: no messages read, no chat, roster or Status card rebuild, and a Swarm not on screen keeps its slow pace.

**Architecture:** The server already labels a heartbeat's push `machine` alone. `SuperTabParts.apply` says when a read changed only what a machine reports; the controller then replaces the machines in the snapshot it holds, tells a new `machinesChanged` listenable, and neither reads messages nor notifies its own listeners. The machines list listens to that, and its one-second timer runs only while it shows, redrawing only rows whose words changed.

**Tech Stack:** Flutter, `flutter_test`, `fake_async`, in `desktop/`.

**Spec:** Task #2168 (Dee). Line numbers in its brief are from main at 08e24276a.

## Global Constraints

- The PR body starts with: Requested by dee@autonomous.ai through Harness.
- Desktop tests use a memory store and a fake sign-in; never a test that signs this Mac out of the real CLI.
- Swarm code stays out of `cli/src/core`. No backend change.
- No on/off switch: the change ships on.
- A told `main` change still reads at `pollInterval`, on screen or off: a tag reaches an away Swarm's badge as fast as before.
- The web build's reading (`SuperTabReading` in `web_chrome.dart`) keeps its behaviour for its messages reads.

## Review Focus

- A read that brings a heartbeat and a real change together (a group, an agent, `derived.agents`, a new or removed machine, a renamed or paused one) is not machine-only: everything redraws and messages are read.
- A `main` push arriving while a machine-only read waits on the slow off-screen gap must not wait that gap.
- A machine that goes silent sends no push: anything reading its age (agent marks, the terminal notice) must still say offline when the threshold passes, with no other machine's heartbeat to redraw it.
- A failing read during a heartbeat still says the Swarm can't be reached: a quiet read must not swallow it.
- An open dialog that shows a machine's readings still updates on a heartbeat.

## Design

- **Growth, migration, audience, identity:** N/A because nothing is stored and no read's scope changes; the same read returns the same parts.
- **Concurrency:** N/A because the controller's reads are already one at a time (`refresh`).
- **Read cost:** the point of this task: a heartbeat reads state changes only.
- **Scale:** at 10x machines the on-screen state reads stay capped at one per 3 s and off screen one per 15 s. The first-open log after the Desktop release is the live check.
- **Compatibility:** an older backend sends no push label it does not have; a read that can't be told apart redraws as today.
- **Failure:** a failed read still notifies, by comparing the failing state before and after.
- **Platforms:** all Desktop platforms; the web keeps reading messages as it does.

---

### Task 1: A machine-only read reads no messages and redraws nothing but machines

**Files:**
- Modify: `desktop/lib/super_tabs/parts.dart` (`SuperTabPartsChange`, `apply`), `desktop/lib/super_tabs/model.dart` (`SuperTabSnapshot.machines`), `desktop/lib/super_tabs/controller.dart` (`_read`, `_readParts`)
- Test: `desktop/test/super_tab_heartbeat_test.dart`, `desktop/test/support/super_tab_fixture.dart`

**Interfaces:**
- Produces: `SuperTabPartsChange.machinesOnly` (bool); `SuperTabController.machinesChanged` (`Listenable`); `ConversationServer.heartbeat(machineId)` in the fixture.

- [ ] **Step 1: Write the failing tests:** over a minute of heartbeats from 5 machines on screen: no messages read, the controller's listeners are not told, the snapshot object stays and its machine's reading is new, `machinesChanged` fires. A read carrying a heartbeat and a group change, a renamed machine, a new machine or a changed `derived.agents` does all of today's. A read failing during a heartbeat notifies.
- [ ] **Step 2: Run to verify they fail.** Run: `flutter test test/super_tab_heartbeat_test.dart`. Expected: FAIL.
- [ ] **Step 3: Implement.** `apply` tracks a change to anything but a machine part whose data differs only in `observation` and `lent`/`lentDays`, or `derived.machines`. `_read` asks messages only for a told `main`, is quiet for a told `machine` alone, and on `machinesOnly` replaces the machines in place and moves `_messagesAt` along with `lastChangedAt`.
- [ ] **Step 4: Run to verify they pass.** Same command, then `flutter test test/super_tab_pushes_test.dart test/super_tab_quiet_mode_test.dart test/super_tab_controller_test.dart`.
- [ ] **Step 5: Commit** the test first, then the code; push.

### Task 2: An off-screen Swarm keeps its pace, and a silent machine still shows offline

**Files:**
- Modify: `desktop/lib/super_tabs/controller.dart` (`_readWhenAllowed`, `_pollDue`, `_read`)
- Test: `desktop/test/super_tab_heartbeat_test.dart`

**Interfaces:**
- Consumes: `machinesOnly`; `kSuperTabMachineOfflineAfter`.

- [ ] **Step 1: Write the failing tests:** away, a minute of heartbeats from 5 machines reads state at most once per `awayPoll` (4); a `main` push during that wait reads at `pollInterval`, not after it; a machine whose heartbeats stop tells the controller's listeners once when it passes the offline threshold, and live machines never do.
- [ ] **Step 2: Run to verify they fail.** Same file. Expected: FAIL.
- [ ] **Step 3: Implement.** A told machine alone waits `_every`; a told `main` cancels that wait. One timer for the next machine to pass the threshold, re-armed by each machine read, tells listeners only when the offline set changed.
- [ ] **Step 4: Run to verify they pass.**
- [ ] **Step 5: Commit** the test first, then the code; push.

### Task 3: The machines list listens for itself, and ticks only while it shows

**Files:**
- Modify: `desktop/lib/super_tabs/machines.dart` (`_SuperTabMachinesState`), and each open dialog that shows a machine's readings and listens to the controller
- Test: `desktop/test/super_tab_heartbeat_widgets_test.dart`

**Interfaces:**
- Consumes: `SuperTabController.machinesChanged`, `SuperTabController.away`.

- [ ] **Step 1: Write the failing tests:** with `SuperTabView`, the roster, the Status card and `SuperTabMachines` on screen, a minute of heartbeats from 5 machines: chat, roster and Status card build counts stay put; only the row of the machine that reported rebuilds. The one-second timer is not running while the Swarm is away, or the group is collapsed, and runs again when it shows.
- [ ] **Step 2: Run to verify they fail.** Run: `flutter test test/super_tab_heartbeat_widgets_test.dart`. Expected: FAIL.
- [ ] **Step 3: Implement.** Each row in its own listenable builder; a tick or `machinesChanged` compares each row's words and order with what it shows and redraws only what differs.
- [ ] **Step 4: Run to verify they pass,** then `flutter test test/super_tab_machines_test.dart test/super_tab_roster_test.dart`.
- [ ] **Step 5: Commit** the test first, then the code; push.

### Task 4: Counts before and after

**Files:**
- Test: `desktop/test/super_tab_heartbeat_test.dart`, `desktop/test/super_tab_heartbeat_widgets_test.dart`

- [ ] **Step 1:** Run both files at main's code (the tests' red run) and at the head; record reads and rebuilds per minute on and off screen in a PR comment.
- [ ] **Step 2:** Run the Super Tab Desktop tests affected, by the symbols changed. Mark the PR ready and ask the Reviewer.
