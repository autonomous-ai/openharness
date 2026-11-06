# Closed Personal tab projects Implementation Plan

> **How this plan runs:** Engineer implements task by task, test first, with each failing test committed before its fix. Independent Swarm review and test steps verify the final head.

**Goal:** Closing a no-repo desk tab removes its empty Personal project, preserves messages, and frees project capacity; temporary window IDs never create projects.

**Architecture:** Keep pane-to-project mapping in `PersonalProjects`. Require a real desk ID before creating a no-repo tab project. Cleanup runs before project creation, only in the signed-in person's verified Personal Swarm, and uses a deterministic operation per project shared across computers. Destructive cleanup requires an atomic server check, rather than trusting a possibly stale Desktop snapshot.

**Tech Stack:** Flutter/Dart Desktop, memory-store/fake-sign-in tests; existing Super Tab commands.

**Spec:** Task #3903, conversation `4d29527dcb34beb1612f6249`.

## Global Constraints

- Delete only empty `tab:` projects of the person's own Personal Swarm; never repo projects or projects with messages.
- Preserve projects with messages by archiving, not deleting.
- No project for temporary `swarm-N` IDs before desk join.
- Two independent security reviews by different Reviewers.
- Owns `desktop/lib/super_tabs/personal_projects.dart` and `desktop/test/super_tab_personal_projects_test.dart`, plus plans.
- PR body begins `Requested by diego through Harness.`
- Build, then merge using main's `make merge-pr` after required CI and independent checks pass.

## Design

- Growth: closing the tab removes its empty project; projects remain limited to 100 per Swarm. Message-bearing projects need a supported archive lifecycle.
- Concurrency: existing per-account/Swarm client serialization; deterministic operations deduplicate across computers. Empty-only deletion must be checked inside the server's write transaction.
- Read cost: use current mappings/snapshot and authoritative desk state only for candidate cleanup; no per-pane polling.
- Scale: bounded by desk tabs and 100 projects; project-cap refusal is the warning signal.
- Compatibility: do not issue unsupported archive commands. The current server has no project archive and refuses archiving a project Lead conversation. Backend prerequisite is task #3929 (PM decision): integrate its atomic cleanup command once merged, before enabling Desktop cleanup.
- Migration/rollback: retained mappings identify old tab projects; no repo mappings change. Reverting stops further automatic cleanup; messages must never have been deleted.
- Audience/identity: existing Personal eligibility checks plus server ownership; signed-in person's account, never host identity.
- Failure: reuse named, content-free errors and bounded retry backoff; fail closed if desk presence or server safeguards are unavailable.
- Platforms: shared Desktop code on macOS, Windows, Linux and web; affected tests on macOS and CI.

## Review Focus

1. A tab absent before desk synchronization must not be mistaken for closed.
2. A message arriving between snapshot and command must prevent deletion atomically.
3. Repo projects, other Swarms, other accounts and project-owned tabs are never cleanup candidates.
4. Two computers send the same operation for cleanup, including after interruption.
5. An existing tab with no panes remains; only a closed tab qualifies.

### Task 1: Require shared desk identity

**Files:** `desktop/lib/super_tabs/personal_projects.dart`; `desktop/test/super_tab_personal_projects_test.dart`.

**Interfaces:** consume `isDeskId(String)` from `state/desk_sync.dart`; retain `PersonalProjects.sync(SuperTabController)` and pane lookup behavior.

- [x] Add `a swarm-N tab makes no project before the desk join`: sync no-repo panes in `swarm-1`, assert no project creation; give the tab a real desk ID and assert one project on subsequent sync. Repo panes continue to work before join.
- [x] Run that test, observe failure, commit test (`7c26058bb`; two creates instead of one).
- [x] Gate only tab-project creation on real desk identity; update existing fixture tabs to realistic IDs while preserving their human names.
- [x] Run the changed file and tests importing `personal_projects.dart`; commit passing implementation. Four tests in
  `personal_project_tabs_test.dart`, `super_tab_personal_lead_test.dart` and `super_tab_personal_lead_card_test.dart`
  named their no-repo tab with an invented id; they now use a 32-hex desk id.

### Task 2: Safely retire closed-tab projects (moved to task #3940)

The PM split this task (2026-11-06): this pull request ships Task 1 alone. Deleting an empty closed tab's project and
archiving one with messages is task #3940, which starts once #3929's atomic server cleanup command merges; the growth
line in `docs/plans/2026-11-03-personal-tab-projects-plan.md` lands with it.
