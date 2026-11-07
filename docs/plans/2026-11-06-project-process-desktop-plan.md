# Desktop: pick Simple or Full for a project: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** A project runs the process it needs. A new project chooses Simple (To do, Doing, Done) or Full (Proposal, Next up,
Working, Done, Merged, Shipped, with review, test and merge); the project's owner can change it in Project settings, everyone
else reads it; the Board draws the columns of the project's preset (task #3897, requested by Dee through Harness; the backend
half is #3896, PR #3427).

**Architecture:** Delta to Desktop, no other redesign. The contract is the one #3896's plan documents ("Settings and read
contract"): a head project carries `process` (`simple` | `full`; missing means Full) and `columns` (`[{id, title}]`, Simple ids
are the Board's own ids (#3427, `process.ts`) `nextUp`, `working`, `done` titled To do, Doing, Done; Full ids as today); `project.create` takes an optional `process`; `project.process {projectId, process}`
changes it, and the server refuses anyone but the project's owner and the Swarm's owner.
- Model: `SuperTabProject.process` and `.columns`, read from the head; an older server sends neither and means Full.
- Board: a Simple project draws three columns, the existing Next up, Working and Done placements under the server's titles (To do,
  Doing, Done). It has no Merged or Shipped, no wait on review or merge in a card's words (Simple opens none), and a pending
  proposal sits in To do rather than disappearing. A Full project is unchanged.
- New project: a quiet pill beside Public / Private in the New project form, "Process: Full" by default, a two-option menu with one
  line each on what it means. The choice goes with `project.create` only when Simple (Full is what an older server already does).
- Project settings: a Process row (value Simple or Full) that opens the same two options; enabled for the project's owner and the
  Swarm's owner, read only with one line of why for everyone else. Choosing sends `project.process` and says the server's refusal.

**Tech Stack:** Dart and Flutter widget tests with the fake Swarm of `test/support/super_tab_fixture.dart`; the phone's copy of
the model and parts (`mobile/lib/swarm`) follows because its parity test holds it to Desktop's reads.

**Spec:** Task #3897's brief; #3896's plan and board contract; #3812's six columns and #3787's Board.

## Mockup (for anh Dee; his look follows after merge)

```
 New project                                           Settings > Project settings > Process
+------------------------------------------+          +------------------------------------------+
| Name  [ scout                           ]|          | Project settings                         |
| Task  [ ...                             ]|          |  Rename project                    scout |
|                       (o Public v) (Full v)|         |  Process                           Simple|
|                                          |          +------------------------------------------+
|   Process menu:                          |          |  Process                                 |
|   +--------------------------------------+          |  ( ) Simple  To do, Doing, Done. No      |
|   | Simple  To do, Doing, Done           |          |              review, test or merge.     |
|   | Full    Proposal to Shipped, with    |          |  (o) Full    Proposal, Next up, Working, |
|   |         review, test and merge       |          |              Done, Merged, Shipped.      |
|   +--------------------------------------+          |  Only the project's owner can change it. |
+------------------------------------------+          +------------------------------------------+

 Simple Board                         Full Board (unchanged)
 To do 3      Doing 2     Done 4      Proposal | Next up | Working | Done | Merged | Shipped
+---------+ +---------+ +---------+
| a card  | | a card  | | a card  |
+---------+ +---------+ +---------+
```

## Global Constraints

- PR body first line: "Requested by dee through Harness." Opened ready once #3896's PR exists; it merges right after #3896.
- Owns `desktop/lib/` and `desktop/test/`; the phone's model and parts only to keep the parity test true.
- Harness design language (`scripts/check-ui-style.py`), light and dark. docs/windows-rules.md: no process, no window.
- Desktop tests use a memory store and a fake sign-in. No fixed sleeps.
- An older backend: no `process` means Full and nothing new is sent; Simple on a server that refuses it says so in the form.

## Design

N/A for stored data: Desktop stores nothing new; the project's setting is the server's (#3896's Design). Reads: the two fields
come in the head the Board already reads, no query added. Compatibility: fields only added; absent means Full; `project.create`
carries `process` only for Simple, so a Full project is created exactly as before on any backend. Audience: the server enforces
who changes it; Desktop only offers what it would allow (owner, Swarm owner). Failure: a refusal is shown in the dialog in the
server's words; the picker never claims a change the server did not make. Platforms: Desktop macOS, Linux, Windows and web share
one Dart path; the phone's model only reads the new fields.

## Review Focus

- A non-owner never sees the picker enabled, and no command is sent from it.
- A Full project and a project from an older server look and behave as before.
- A Simple Board has exactly three columns, shows no review or merge words, and loses no card or proposal.

## Task 1: the model reads the preset

**Files:** `desktop/lib/super_tabs/model.dart`, `desktop/test/`, `mobile/lib/swarm/model.dart`.

- [ ] Failing tests: a project with no `process` is Full with six columns; `simple` reads with the server's three columns and
  their titles; an unknown value is Full.
- [ ] `SuperTabProject.process` / `.columns`; the phone's model reads the same. Commit.

## Task 2: the Board draws the preset

**Files:** `desktop/lib/super_tabs/task_groups.dart`, `tasks_view.dart`, tests.

- [ ] Failing tests: a Simple project's Board shows To do, Doing and Done (three columns, in Board and List), a Full one six; a
  Simple card says nothing of review, merge or checks; a proposal sits in To do; no card is lost.
- [ ] Preset-aware placement and columns. Commit.

## Task 3: the picker, in New project and in Project settings

**Files:** new `desktop/lib/super_tabs/project_process.dart`, `project_options.dart`, `view.dart`, `controller.dart`,
`desktop/lib/widgets/new_harness_form.dart`, `desktop/lib/state/harness_launch_integration.dart`, `launch.dart`, tests.

- [ ] Failing tests: the New project form offers Process with Full chosen, and Simple sends `process: simple` with
  `project.create` (Full sends none); Project settings has a Process row that opens the two options; the owner's choice sends
  `project.process`; another member sees them read only and sends nothing; a refusal shows in the dialog.
- [ ] The picker, `setProcess` on the controller, the form's pill, the settings row. Commit.

## Task 4: screenshots and evidence

- [ ] Light and dark screenshots of the picker (form and settings) and of a Simple and a Full Board; red/green in the pull
  request and the task thread.
