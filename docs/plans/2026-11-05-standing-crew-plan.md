# A standing crew Implementation Plan

> Implemented by the task's Engineer, test first, task by task (project instructions: Engineer). No Execution Handoff.

**Goal:** A project names agents as its crew (role, machine, engine). The Swarm keeps each one alive: a crashed or
frozen session is reopened in place with its task, and no idle path (the CLI's 30-minute idle close, the server's idle
notice, the server's removal of closed agents) closes or removes a crew member. A Crew panel lists each member's
name, role, machine, state and task.

**Architecture:** The backend stores `crew` on the agent record (`crew.add` / `crew.remove`, by the project's PM or a
person of the project). The record already reaches every reader and each machine's host, so status shows it and the
host reads it from its roster row. The host keeps crew rows alive with the same keep-alive the PM has (reopen a gone
session in place), adds a frozen-screen restart for crew, and writes crew into its retention file, which the CLI's idle
cleanup and the core's reopen guard read. The backend gives a crashed crew member's task a short grace, so its reopened
session still holds it, and the host types one continue line into the reopened session. Desktop adds a Crew panel.

**Tech Stack:** TypeScript (backend: vitest; CLI: vitest), Flutter (desktop: flutter_test).

**Spec:** Task #3397 (anh Dee, Swarm redesign approved 11-05). Constants live in one place per component
(`backend/src/superTabs/crew.ts`, `cli/src/superTabs/crew.ts`) until the project rules record (sibling task) lands.

## Global Constraints

- Owns only `backend/src/superTabs/`, `cli/src/superTabs/`, `cli/src/services/agentCleanup.ts`, `desktop/lib/super_tabs/`.
  Swarm code stays out of `cli/src/core` (no change to `core/api.ts` or `core/main.ts`).
- Lifecycle code is tested with a fake host and fake core; no test signs the Mac out of the real CLI; never two PMs.
- Non-crew behaviour is unchanged, and each test file pins that next to the crew case.
- PR body first line: "Requested by dee through Harness." One review and one security review.

## Design

- **Growth:** one small object per crew agent (`{ role, at, by }`), deleted by `crew.remove` or with the agent.
- **Concurrency:** `crew.add`/`crew.remove` write the agent's own part (the command names `agentId`, parts/touches.ts D3)
  and read the project's Lead conversation for the PM check (`leadCheck`), as `agent.release` does.
- **Read cost:** no new read; the field rides the agent part and the host roster row already sent.
- **Scale:** crew is a handful per project. At 10x the cost is one screen read a minute per crew member on its host;
  the host log line "reopened crew" rate warns first.
- **Compatibility:** an older client ignores the field. An older host ignores `crew` and treats the agent as today
  (closed when idle); a newer host on an older server sees no `crew` and changes nothing.
- **Migration + rollback:** none; an absent field is "not crew". Rollback leaves a harmless field.
- **Audience:** the server enforces who may mark crew (the project's PM, or a non-viewer person who reads the project).
- **Identity:** the actor is the command's own (person or agent); never the machine owner's login.
- **Failure:** a reopen or restart that fails backs off and is logged once per reason; a frozen confidential session on
  a Team account is not restarted (closing one deletes its data) and the log says so.
- **Platforms:** host code is platform-neutral (core close/resume); the panel is the shared Desktop UI.

## Review Focus

- A crew member that is also the PM: refused by `crew.add` (the PM is already kept alive), so it never has two paths.
- A frozen check must never restart a session that is only waiting at its prompt or running a long silent command:
  frozen means the engine says it is working and the whole screen, status line included, did not change for 30 min.
- A crew member's task is kept only for the reopen grace (5 min); a session that stays gone still loses it as today.
- A crew member removed from the crew goes back to normal idle handling at once (retention rewritten on next roster).
- A person who cannot read the project, or a viewer, cannot add or remove crew; the refusal names no hidden agent.

---

### Task 1: Backend crew flag and commands

**Files:**
- Create: `backend/src/superTabs/crew.ts`, `backend/src/superTabs/crew.test.ts`
- Modify: `backend/src/superTabs/model.ts` (Agent `crew?`), `backend/src/superTabs/commands.ts` (schema, WORDS, switch)

**Interfaces:**
- Produces: `Agent.crew?: { role: string; at: number; by: string }`; commands
  `{ type: 'crew.add', agentId, role? }` (role defaults to the agent's role name, 1 to 40 characters) and
  `{ type: 'crew.remove', agentId }`; `isCrew(agent): boolean` and `CREW_REOPEN_GRACE_MS = 5 * 60_000` in `crew.ts`.

- [ ] Failing tests in `crew.test.ts`: the PM adds and removes a crew member; a project person adds one; a viewer,
  another project's agent and a non-PM agent are refused (`FORBIDDEN`); the PM itself and a Buddy are refused
  (`CREW_LEAD`, `CREW_BUDDY`); the role defaults to the agent's role name; status (the agent part) carries `crew`.
- [ ] Implement `addCrew`/`removeCrew` in `crew.ts`, wire them in `commands.ts`.
- [ ] Commit test, then code.

### Task 2: Backend idle and removal paths skip crew, crashed crew keeps its task briefly

**Files:**
- Modify: `backend/src/superTabs/tidy.ts` (`idleNotices`), `backend/src/superTabs/closedAgents.ts` (`removable`),
  `backend/src/superTabs/liveness.ts` (`lostReason`)
- Test: `backend/src/superTabs/tidy.test.ts`, `closedAgents.test.ts`, `liveness.test.ts`

- [ ] Failing tests: no idle notice for a crew member (one for the same agent without crew); `closedAgents` never
  returns a crew member (returns the same agent without crew); a crew worker whose session is listed stopped keeps its
  task until `CREW_REOPEN_GRACE_MS` after `downSince`, then loses it; a non-crew worker loses it at once.
- [ ] Implement; commit test, then code.

### Task 3: CLI retention keeps crew

**Files:**
- Create: `cli/src/superTabs/crew.ts` (constants, `isCrewRow`)
- Modify: `cli/src/superTabs/retention.ts`
- Test: `cli/src/superTabs/retention.spec.ts`, `cli/src/services/agentCleanup.spec.ts`

**Interfaces:**
- Produces: retention file `crew?: string[]`; crew harnesses are always in `harnesses` (also with no open group) and
  never lapse; `retainedLeads(dataDir)` returns Leads and crew (the sessions the core may reopen, read by
  `core/main.ts` unchanged). `isCrewRow(row): boolean` (row.agent.crew has a role).

- [ ] Failing tests: a crew row in no active group is retained; after the lapse a crew harness is still retained;
  `retainedLeads` names crew; the idle cleanup never closes a crew member that sat idle 31 minutes, and still closes
  the same harness without crew.
- [ ] Implement; commit test, then code.

### Task 4: CLI host keeps crew alive, restarts a frozen one, continues its task

**Files:**
- Modify: `cli/src/superTabs/crew.ts` (`CrewKeeper`), `cli/src/superTabs/host.ts` (keep-alive for crew rows, tick)
- Test: `cli/src/superTabs/crew.spec.ts`, `cli/src/superTabs/host.spec.ts`

**Interfaces:**
- `CREW_FROZEN_MS = 30 * 60_000`, `CREW_LOOK_MS = 60_000`, `CREW_CONTINUE` (the line typed after a reopen).
- `new CrewKeeper(core, { now, log, owns })`, `tick(rows)`, `reopened(harnessId)`.

- [ ] Failing tests (fake core): a crew row whose session is gone is reopened through `keepLeadAlive`; a non-crew row
  is not; after the reopen the continue line is typed once, only while the session holds its assignment and no prompt
  waits; a crew session working with an unchanged screen for 30 min is closed (`closeMember`) and then reopened; one
  idle at its prompt, or whose screen changes, is not; a confidential one is not restarted.
- [ ] Implement; commit test, then code.

### Task 5: Desktop Crew panel

**Files:**
- Create: `desktop/lib/super_tabs/crew_panel.dart`, `desktop/test/super_tab_crew_panel_test.dart`
- Modify: `desktop/lib/super_tabs/model.dart` (`SuperTabAgent.crew`), `desktop/lib/super_tabs/view.dart` (menu item)

- [ ] Mockup posted in the task first.
- [ ] Failing widget test (memory store, fake sign-in): the panel lists each crew member with name, role, machine,
  state (Running, Reopening, Down) and task title, or "No task"; no crew shows the empty line; non-crew agents are absent.
- [ ] Implement; commit test, then code.
