# Cmd-N picks a main project (task #4541) Implementation Plan

Way of working: the project's Engineer flow (plan first; each task's failing test committed before its code; one pull
request; one independent review). No subagent-driven development and no execution handoff.

**Goal:** In the Swarm, + New agent and Join's Bring agent use one Cmd-N form that picks a main project from a list
(name, purpose, Lead, waiting tasks) or New project for a Lead, with no folder, worktree, branch or Member/Lead pill;
plus the one-line purpose in Project settings and the new words in the Naming System.

**Architecture:** A small reader, `SuperTabProjectChoices` (`super_tabs/project_choices.dart`), reads the server's
project list once when the form opens. `HarnessLaunchIntegration` carries the list and the pick. The form, given a
list, draws one project list row in place of the folder, worktree and branch rows and the kind pill. A Member pick is
started by the Swarm, as Join's start is today (`agent.new` or `buddy.create` with `mainProjectId`): Harness owns its
folder, so the Desktop picks none. New project keeps today's Lead path. Against a backend without the list (404), the
form is today's, pill included.

**Tech Stack:** Flutter (Desktop), flutter_test widget tests on a memory store and a fake sign-in.

**Spec:** `docs/specs/2026-11-07-members-and-leads.md` (PR #3542), sections 1 and 7, build tasks 1, 2 (Desktop row)
and 5. Wire shapes proposed to the backend task (#4540) on 11-07:

- `GET /api/super-tabs/{tab}/project-list?invitedTo={projectId}` →
  `{projects: [{id, name, about, repositoryName, lead: {agentId, name} | null, waiting}], pick}`; 404 = older backend.
- `agent.new` and `buddy.create` take an optional `mainProjectId`; `project.about` {projectId, about} (≤ 80).

```text
 New agent                                                    Mac Studio ▾
 [ Claude Code ▾ ]  [ Opus 5.5 ▾ ]
 Main project
 (o) harness     The Harness app and Swarm       ◎ River     12
 ( ) lamp        Lamp OS firmware                ◎ Wren       3
 ( ) New project [ Name ______________ ]
 [ First message for your agent …                                    ]
                                                        [ New agent ]
```

## Global Constraints

- Desktop and docs only; offscreen tests, memory store, fake sign-in; light and dark at 1440 and 880; macOS, Windows,
  Linux. Merges after the backend part (#4540) is released.
- Copy: one idea per line, buttons verb first in one or two words, no filler, empty means empty (anh Dee 11-07).
- A row: the name, the purpose (else the repository's name), the Lead's face and name, the waiting count. No other
  columns, no filters. The server's `pick` starts picked; a person with no project sees only New project.
- Purpose: plain text, at most 80 characters, set in Project settings by the owner or Lead.
- Every element changed goes into the design doc and the gallery in this PR. Named roles only.

## Review Focus

- An older backend (404 on the list): today's form, pill included, never a half form.
- The list fails (500, timeout): one line with Retry; New project still works.
- A long purpose or project name truncates in its column; the waiting count never wraps.
- Join from an invitation: the invited project starts picked, whatever the server's order.
- A retried start after a lost answer sends the same operation once (the launch journal's receipt).

---

### Task 1: the words
**Files:** `docs/naming-system.md`. Member, Lead, Main project, Helping, Set up and Waiting, from the spec's table;
Buddy, Regular agent and PM agent leave the on-screen words. Docs only, no test.

### Task 2: the project list read
**Files:** create `desktop/lib/super_tabs/project_choices.dart`; test `desktop/test/super_tab_project_choices_test.dart`.
**Interfaces:** `SuperTabProjectChoice {id, name, about, repositoryName, lead (agentId, name)?, waiting}`, `String
get purpose` (about, else repositoryName, else empty); `SuperTabProjectChoices.read(SuperTabRequest, tabId,
{invitedTo})` → `({List<SuperTabProjectChoice> projects, String? pick})?`, null on 404.
- [ ] Test: parses the shape; purpose falls back to the repository name; a 404 answers null; another failure throws;
  `invitedTo` goes in the query.
- [ ] Fail, implement, pass, commit.

### Task 3: the project list in the form
**Files:** `desktop/lib/state/harness_launch_integration.dart`, `desktop/lib/state/new_harness.dart`,
`desktop/lib/widgets/new_harness_form.dart`; test `desktop/test/new_harness_main_project_test.dart`.
**Interfaces:** `HarnessLaunchIntegration.projectChoices` (the read's answer, or null), `.projectsFailed` (the line),
`.mainProjectId` (a project id, or `kNewProjectChoice`), `.newProjectName`, `.startMember(machineId, engine,
mainProjectId)`. `NewHarnessController.choosesProject`.
- [ ] Test: with a list, the form shows Main project with a row per project (name, purpose, Lead, waiting), the
  server's pick selected, New project last with a name field; no folder, worktree or branch row and no Member/Lead
  pill; choosing a row sets the pick; without a list (older backend) the pill and folder rows are as today; a failed
  read shows its line and Retry, and New project still shows.
- [ ] Fail, implement, pass, commit.

### Task 4: starting from the pick
**Files:** `desktop/lib/super_tabs/launch.dart`, `desktop/lib/super_tabs/join/agent_launcher.dart`,
`desktop/lib/super_tabs/join/bring_agent.dart`; tests beside them.
- [ ] Test: + New agent with a project picked sends `agent.new` {kind regular, machineId, engine, mainProjectId} once
  (no `local`), and the first message to its chat; New project goes the Lead path with its name; Join's Bring agent
  shows the same list, the invited project picked, and sends `buddy.create` with `mainProjectId`.
- [ ] Fail, implement, pass, commit.

### Task 5: what a project is, in Project settings
**Files:** the Project settings screen (`desktop/lib/super_tabs/project_options.dart`), `model.dart` (`about`).
- [ ] Test: owner or Lead sees a one-line Purpose field, at most 80 characters, saved with `project.about`; others see
  it read only; a failed save says so.
- [ ] Fail, implement, pass, commit.

### Task 6: design doc and gallery
**Files:** `desktop/design/desktop-design-system.md`, `desktop/test/swarm_elements_gallery_test.dart` and images.
- [ ] The project list row and New project row in the gallery, light and dark; doc lines; screenshots at 1440 and 880.
