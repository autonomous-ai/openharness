# Cmd-N new agent (Lead or Member) implementation plan

> Written by the writing-plans skill as the project's Engineer role uses it: implemented task by task in this session,
> each failing test committed before its code, then one independent review of the pull request. No execution handoff.

**Goal:** + New agent opens the existing Cmd-N form with every picker unchanged and one new choice, Lead or Member; the
separate New agent dialog goes, and creating an agent stops waiting on a server start.

**Architecture:** Cmd-N already reaches a Swarm through `HarnessLaunchIntegration` (`SuperTabLaunch.open`): the agent
starts on the person's own machine through `AppNotifier.createAgent`, and the running session then joins the Swarm with
`agent.add`. A Lead reuses its New Project path (`project.create`, then `agent.add` as lead). A Member gets its own chat
from `agent.new` with `local: true` (no server start), and `agent.add` takes the running session into that chat as a
Regular agent. The form gains one capsule for the choice and offers only the person's own machines.

**Tech Stack:** Flutter/Dart (Desktop), TypeScript and Vitest (backend).

**Spec:** Task #4196 (anh Dee, 2026-11-07 06:10 VN, by River), and its addition: the Cmd-N task box starts at 3 rows and
grows to 7.

## Global Constraints

- Change only the delta to the existing Cmd-N form; no redesign. Every picker (agent, model, computer, project: GitHub,
  new, folder) stays as it is.
- One new choice: Lead (names and starts a project) or Member. Member is the default.
- The machine picker offers only the person's own machines: no shared or guest machine, no Team account.
- Agents run on the person's own account and settings. No login read.
- The separate New agent dialog is removed; its entry points (left pane, join) open Cmd-N.
- The backend ships first; the contract is only extended. A backend without it says "Update Harness", never falls back.
- Ships in Desktop 1.3.88 with #4191 and #4192.

## Design

- Growth: a Member's chat is one conversation per agent, as `agent.new` makes today; a chat whose start failed is
  archived by Discard. Bounded by the existing 32 pending starts only for server starts; a local chat holds one agent.
- Concurrency: the Swarm's existing per-tab command transaction; each step keeps its own operation id in the launch
  journal, so a retry repeats the same command.
- Read cost: no new reads; the journal and the existing snapshot reads of the New Project path.
- Scale: one command per step, no fan-out. Warning metric: the new-agent timing log (time to a running agent).
- Compatibility: backend first. An older backend refuses `local` as VALIDATION_ERROR and the form says to update
  Harness. Older Desktops keep `agent.new` server starts, which stay.
- Migration and rollback: none; reverting Desktop restores the old dialog; reverting backend refuses `local`.
- Audience: the server checks that the chat is the actor's own and the machine and account are theirs.
- Identity: the session runs under the person's own CLI login on their own machine; never another person's.
- Failure: every step's refusal is shown in the form with Retry or Discard; Discard archives an empty Member chat or
  deletes an empty project, as New Project does.
- Platforms: macOS, Linux, Windows Desktop (shared code; no new process launch).

## Review Focus

- A retried Member create after a lost reply makes one chat and one agent, not two.
- A Member start on a machine that is not the person's own is refused by the server, whatever the client sends.
- A second session added to a Member chat is refused: one agent per chat.
- Switching Lead and Member after a request went out cannot change what was created (the choice locks).
- The form never offers a shared, guest or Team machine in this mode, also after the machine list changes.

---

### Task 1: The task box starts three rows tall

**Files:**
- Modify: `desktop/lib/widgets/new_harness_form.dart` (`_desktopTaskBox`, `minLines`)
- Test: `desktop/test/desktop_composer_layout_test.dart`

- [ ] Write `the task opens three rows tall and grows to seven`: heights of 0, 1, 3, 4, 7 and 10 typed lines; empty
  equals 1 and 3 lines, 4 is taller, 10 equals 7.
- [ ] Run it: FAIL (empty 19 px, three lines 57 px).
- [ ] `minLines: 3`, `maxLines: 7`.
- [ ] Run the form's tests: PASS. Capture light and dark with `COMPOSER_LAYOUT_RENDER_DIR`.

### Task 2: Backend: a Member's chat for a session running on its own machine

**Files:**
- Modify: `backend/src/superTabs/commands.ts` (`agent.new` schema and case; `agent.add` case)
- Test: `backend/src/superTabs/agentNew.test.ts`

**Interfaces:**
- Produces: `agent.new {kind: 'regular', machineId, engine, name, local: true}` → `{conversationId}`, no start.
- Produces: `agent.add {conversationId: <agent chat>, machineId, harnessId, name, configuration, initialMessage?}` →
  `{agentId}`; the agent has `regular: true` and no project.

- [ ] Tests, failing first: local `agent.new` opens the chat and queues no start; it is refused with `kind: 'pm'`, on
  another person's machine and for a viewer; `agent.add` into the chat adds a Regular agent once (same operation again
  adds nothing), refuses a second session, another person's chat and another person's machine.
- [ ] Implement: `local: z.literal(true).optional()`; the local case skips the listed-machine and host-capability
  checks (nothing starts there) and keeps the own-machine grant check. `agent.add` on an agent chat checks the chat's
  audience is the actor, the grant is their own machine and account, the chat has no agent, and pushes the agent as a
  started Regular agent is pushed.
- [ ] Run `agentNew.test.ts` and the tests of `commands.ts` callers it touches: PASS.

### Task 3: The form's Lead or Member choice and own machines

**Files:**
- Modify: `desktop/lib/state/harness_launch_integration.dart` (fields), `desktop/lib/state/new_harness.dart`
  (`machineChoices`, `agentKind`), `desktop/lib/widgets/new_harness_form.dart` (`_desktopHeader`)
- Test: `desktop/test/new_harness_agent_kind_test.dart`

**Interfaces:**
- Produces: `HarnessLaunchIntegration.agentKind` (`'lead' | 'member' | null`; null shows no choice),
  `agentKindLocked`, `ownMachinesOnly`; `NewHarnessController.setAgentKind(String kind)`.

- [ ] Tests, failing first: with an integration whose `agentKind` is `member`, the header shows a `Member` capsule
  after the project capsule; its menu offers Lead and Member and choosing Lead changes `integration.agentKind`; the
  computer menu lists this computer and a remote own machine, not a shared, guest or Team one; without an integration
  the header is unchanged. Light and dark pictures.
- [ ] Implement the capsule as the computer capsule is built (`DesktopPill` in an `AppDropdown`), locked with
  `box.locked || agentKindLocked`.
- [ ] Run the test and the form's existing tests: PASS.

### Task 4: New agent through Cmd-N, Lead or Member

**Files:**
- Modify: `desktop/lib/super_tabs/launch.dart` (`SuperTabLaunch.open` `newAgent`, `prepare`, `complete`, `discard`)
- Test: `desktop/test/super_tab_new_agent_launch_test.dart`

**Interfaces:**
- Consumes: Task 2's commands; Task 3's fields.
- Produces: `SuperTabLaunch.open(app, tab, 'new-agent', newAgent: true)`.

- [ ] Tests, failing first, with recorded Swarm requests and a fake local create: Member sends `agent.new` with
  `local: true`, then creates locally with a prompt naming the returned chat, then `agent.add` into it, then selects
  the chat; Lead sends `project.create`, creates locally, then `agent.add` as lead and `project.rename`; a lost
  `agent.add` reply retried sends the same operation id; Discard after a failed Member start archives its chat; the
  choice locks once the first command is sent; one timing log line names the kind and milliseconds, nothing else.
- [ ] Implement; the journal keeps `agentKind` beside the New Project keys.
- [ ] Run the test and `super_tab` launch tests: PASS.

### Task 5: + New agent and join open Cmd-N; the old dialog goes

**Files:**
- Modify: `desktop/lib/super_tabs/view.dart`, `desktop/lib/super_tabs/workspace.dart`,
  `desktop/lib/screens/swarm_screen.dart` (`onNewAgent` → `_newAgent(swarmNewAgent: true)`),
  `desktop/lib/super_tabs/join_dialog.dart`
- Delete: `desktop/lib/super_tabs/join/new_agent_dialog.dart`, `agent_dialog.dart`; `agent_launcher.dart` unless the
  join's Buddy still needs it; their tests.
- Test: `desktop/test/swarm_v3_agent_entry_test.dart`

- [ ] Tests, failing first: the left pane's + New agent opens the Cmd-N form with the Member capsule; after a join,
  the same form opens for the person's own agent; no `SwarmAgentDialog` exists.
- [ ] Implement. Join keeps its Buddy (River's ruling pending; Buddy start unchanged, only its form).
- [ ] Run the entry, join and sidebar tests: PASS.

### Task 6: Evidence

- [ ] Before: server starts in this Swarm (118 on record, 2026-11-07): dispatch p50 18 s, p95 233 s; engine session
  p50 23 s, p95 91 s, max 375 s; plus the old dialog's waits before it (engine probe, machine preparation, contribute).
- [ ] After: the timing log of a Lead and a Member created through Cmd-N on this Mac.
- [ ] Light and dark pictures of the form with the choice; the 3-row task box.
