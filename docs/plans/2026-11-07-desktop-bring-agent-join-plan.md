# Bring agent and Join dialog fixes Implementation Plan

> Written by the writing-plans skill as this project's Engineer role adapts it: the Engineer implements it task by
> task, test first, each failing test committed before its code; the pull request's review step is the one review.

**Goal:** A new joiner's first Bring agent starts their Buddy on one click, the bring-agent form says what it is and
survives a stray click, its errors are plain words or the server's own reason, and the Join dialog offers Retry only
after a failure that a retry can fix (audit findings 2, 10 and 13, task #4442).

**Architecture:** `SwarmAgentLauncher` (`super_tabs/join/agent_launcher.dart`) asks the computer to prepare again
every second while it answers `preparing`, as Add computer does (`super_tabs/machines.dart` `_prepareContribution`),
and turns a timeout or any other raw failure into a `SwarmAgentLaunchFailure` sentence. `showBringAgentForm` passes a
heading and one sentence to the Cmd-N form through `HarnessLaunchIntegration`, which the form shows above its pickers
with a Not now button beside Bring agent; the dialog no longer closes on a click outside. `SwarmJoinDialog` labels
its button by what it will do.

**Tech Stack:** Flutter (Dart), flutter_test, fake_async, the `SuperTabLaunchFixture` memory store and fake sign-in.

**Spec:** `docs/audits/2026-11-07-desktop-1.3.89.md` findings 2, 10 and 13 (PR #3526, task #4436).

## Global Constraints

- Desktop only (`desktop/lib/`); no server change.
- Reuse existing components and styles: `DesktopChrome` text styles, the form's own buttons.
- Desktop tests use a memory store and a fake sign-in; never sign in or read a login.
- Copy says "Swarm", never "org".
- Light and dark screenshots of each changed screen in the pull request.
- Platforms: shared Flutter code, so macOS, Windows and Linux alike; checked offscreen on macOS.

## Review Focus

- A computer that stays `preparing` for minutes: the form keeps "Starting your Buddy on <computer>…" and gives up
  after 5 minutes with a sentence, never a spinner forever (Task 1 test: never-ready computer).
- The account changing while it polls: no start is sent (Task 1 keeps `_guard()` after every answer).
- A refused start versus a lost answer: a refusal shows the server's sentence; a lost answer keeps "not confirmed,
  try again" and its receipt, so a second click cannot start a second Buddy (Task 2 tests both).
- Esc still closes the form: a key press is a choice, a click outside is not; the copy says how to start later.
- A link that fails on the network keeps Retry; only an unavailable link loses it (Task 3 tests both).

---

### Task 1: Bring agent waits while the folder is prepared (finding 2)

**Files:**
- Modify: `desktop/lib/super_tabs/join/agent_launcher.dart`
- Modify: `desktop/lib/super_tabs/join/bring_agent.dart:72-98`
- Test: `desktop/test/swarm_v3_agent_launcher_test.dart`, `desktop/test/swarm_first_join_widget_test.dart`

**Interfaces:**
- `SwarmAgentLauncher.prepare` may now return `{'state': 'preparing'}`; any other answer is the setup.
- `create` polls `prepare` with the same operation id every 1 s, each ask bounded by 25 s, for at most 5 minutes.

- [ ] **Step 1: Write the failing tests**
  - `a computer still preparing is asked again until ready, and starts once` (fake_async): prepare answers
    preparing, preparing, then the setup; expect 3 asks, all `op-prepare`, and one `buddy.create`.
  - `a computer that never finishes preparing gives up in plain words`: prepare always answers preparing; after
    5 minutes `create` throws `SwarmAgentLaunchFailure` whose message names the computer and no command is sent.
  - In `swarm_first_join_widget_test.dart`, remove the second click: one click on Bring agent starts the Buddy.
- [ ] **Step 2: Run them and see them fail**: `flutter test test/swarm_v3_agent_launcher_test.dart
  test/swarm_first_join_widget_test.dart`; expected: "still being prepared" failures.
- [ ] **Step 3: Implement the poll in `create`; `bring_agent.dart`'s prepare returns the preparing answer as is.**
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit.**

### Task 2: The bring-agent form explains itself and keeps its offer (finding 10)

**Files:**
- Modify: `desktop/lib/state/harness_launch_integration.dart` (add `heading`, `intro`)
- Modify: `desktop/lib/widgets/new_harness_form.dart` (show them; Not now beside the action for a Buddy)
- Modify: `desktop/lib/super_tabs/join/bring_agent.dart`, `desktop/lib/super_tabs/join/agent_launcher.dart`,
- Test: `desktop/test/swarm_first_join_widget_test.dart`, `desktop/test/swarm_v3_agent_launcher_test.dart`

**Interfaces:**
- `HarnessLaunchIntegration({String? heading, String? intro})`: null shows nothing, as today.
- The Swarm's name is the controller's snapshot name; `showBringAgentForm` keeps its signature.

Copy, exact:
- Heading: `Bring your agent to <Swarm>`.
- Intro: `Your Buddy is your own agent in <Swarm>: it runs on your computer, under your sign-in, and you can also
  start it later from your Buddy chat.`
- Not now: `Not now`.
- Timeout: `<computer> didn’t answer in time. Check that Harness is running there, then try again.`
- Any other raw failure: `Couldn’t reach Harness on <computer>. Check that it’s running, then try again.`
- No local computer: main's waiting box from task #4220 (`Waiting for this computer’s Harness connection. This goes on
  by itself once it is up.`) stays as it is.
- Closing while the computer prepares (×, Esc or Not now) stops the wait at once: nothing exists before `buddy.create`
  is sent (review of #3530).
- Pending action: `Finish or retry the pending action in this Swarm first.`
- A refused start: the server's sentence as the controller keeps it (`operationError`).

- [ ] **Step 1: Write the failing tests**
  - Widget, light and dark: the form shows the heading with `Pilot`, the intro and `Not now`; a tap outside the form
    leaves it open; `Not now` closes it with no enrollment.
  - Widget: the backend refuses `buddy.create` with 409 "This computer is full." and the form shows that sentence.
  - Unit: prepare that never answers times out to the timeout sentence, not `TimeoutException`; a `StateError` from
    the command becomes the could-not-reach sentence.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement; `showAppDialog(barrierDismissible: false)` for the form.**
- [ ] **Step 4: Run them, the form's own tests (`test/new_harness_form*_test.dart`) and see them pass.**
- [ ] **Step 5: Commit.**

### Task 3: Join dialog offers Retry only after a failure a retry can fix (finding 13)

**Files:**
- Modify: `desktop/lib/super_tabs/join_dialog.dart:257-332`
- Test: `desktop/test/swarm_sharing_test.dart`

**Interfaces:** none new.

- [ ] **Step 1: Write the failing tests**
  - `while the invitation loads the button reads Join Swarm, greyed`: a request that never answers; the confirm
    button reads `Join Swarm` and is disabled; no `Retry`.
  - The revoked-link test expects `Close` and no `Retry`; tapping Close closes the dialog.
  - `a network failure keeps Retry`: a request that throws a non-link failure shows `Retry`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement: keep whether the failure is an unavailable link; the button is Close for it, Retry for any
  other failure, and Join Swarm (disabled) while loading.**
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit.**

### Task 4: Screenshots

- [ ] Run the shot tests with `HARNESS_V3_JOIN_SHOTS=<dir>` for the form and the Join dialog, light and dark, and
  attach them to the pull request.
