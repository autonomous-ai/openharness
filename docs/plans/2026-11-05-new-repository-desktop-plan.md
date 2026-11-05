# New Project's New Repository on Desktop (task #3374) Plan

> Worked by the Engineer, test first (superpowers test-driven-development): each task's failing test is committed and
> seen red before the code that passes it. No Execution Handoff: the Engineer implements it task by task.

**Goal:** Desktop's New Project offers "New Repository" in Choose repo. The person names it (Owner, Name, Private on),
Harness creates it on GitHub with their own sign-in, and the project's Product Manager starts in it.

**Architecture:** The backend part is PR #3201 (task #1788): `GET /api/super-tabs/:tabId/github/owners/:owner`,
`POST /api/super-tabs/:tabId/projects/:projectId/github/repository` (`{ authorizeUrl, at }`), and the outcome on the
project as `repositoryCreation`. Desktop adds a `NewHarnessProject.newRepository` choice. The prompt is a small dialog
because it takes three fields (Owner, Name, Private), where the composer's other prompts take one. On Start,
`SuperTabLaunch.createRepository` creates the project once (journaled, as today), POSTs the ask, opens `authorizeUrl` in
the system browser (`launchUrl`, external application: no console window on Windows), and waits for the project's
`repositoryCreation` with that `at` in the Swarm state the controller already syncs. **Check again** refreshes it. On
`created`, the choice becomes the clone of that repository, and the start runs as it does for a chosen GitHub
repository: on this Desktop's machine, or through the Swarm with `repositoryUrl`.

**Tech Stack:** Flutter Desktop (`desktop/`), flutter_test widget and unit tests, the Super Tab fixture's fake backend.

**Spec:** `docs/plans/2026-11-05-new-repository-design.md` (Mockups: Desktop; Failure states F1 to F12) and
`docs/plans/2026-11-05-new-repository-plan.md` Task 6 (contract) and Task 8, both on PR #3201. Dee's approved mockup
(project chat, 11-05): Owner, Name with the github.com path under it, Private on by default, "Use this name", and the
button "Create and continue in GitHub".

## Global Constraints

- Only for New Project (`placesLead`), and only when the server can create (`not-configured`, or a 404 from an older
  server, hides the row).
- The person's own sign-in creates it. Desktop never sees a token: it only opens `authorizeUrl`.
- Copy follows the design's failure table. Where the table names a phone screen ("pick it under Repository",
  "pick Enter a link"), Desktop names its own ("choose it under GitHub in Choose repo", "paste its link under GitHub").
- An ask still `waiting` 10 minutes after its `at` (the sign-in state's life) reads as F8. One `creating` for more than
  5 minutes reads as Try again (security review of #3201): a new ask replaces it, and F10 finds a repository already made.
- A retry after `created` never creates again: the journal keeps the created address.
- Opening GitHub uses `launchUrl` with `LaunchMode.externalApplication`, as Project details does.
- Swarm code stays out of `cli/src/core`. Tests use the memory store and the fixture's fake sign-in.

## Review Focus

1. Every failure state F1 to F5, F7 to F9 and F11 shows its line, and none starts a Product Manager.
2. An outcome for another ask (older `at`) is never taken as this one's.
3. A retry after `created` repeats no creation. One after a failure asks again with a new `at`.
4. The row is hidden where the server cannot create.

---

### Task 1: The outcome on the project (`model.dart`)

**Files:** Modify `desktop/lib/super_tabs/model.dart`. Test `desktop/test/new_repository_test.dart`.

**Interfaces:** Produces `SuperTabRepositoryCreation` (owner, name, private, at, state, repositoryUrl, reachable,
reason), read from a project row's `repositoryCreation`, null when absent or malformed, and
`SuperTabProject.repositoryCreation`.

- [ ] Test: a row's `repositoryCreation` is read with each field, and an absent or malformed one reads null.
- [ ] Red, implement, green, commit.

### Task 2: Rules and copy (`new_repository.dart`)

**Files:** Create `desktop/lib/super_tabs/new_repository.dart`. Test `desktop/test/new_repository_test.dart`.

**Interfaces:** Produces `NewRepositoryAsk {owner, name, private}`, `newRepositoryNameProblem(name)` (F1),
`newRepositoryOwners(snapshot)` (the distinct GitHub owners of the Swarm's project repositories, in the snapshot's
order), and `newRepositoryOutcome(creation, at, now)`, which gives waiting, created (url, reachable), or a failure line
(F2, F3, F8, F9, and Try again for a stale `creating`).

- [ ] Tests: F1 for each rule (characters, over 100, `.`, `..`); the owners list; each outcome state's line; an
  outcome with another `at` reads as waiting; 10 minutes waiting reads F8; 5 minutes creating reads Try again.
- [ ] Red, implement, green, commit.

### Task 3: The create flow (`launch.dart`, `harness_launch_integration.dart`)

**Files:** Modify `desktop/lib/super_tabs/launch.dart`, `desktop/lib/state/harness_launch_integration.dart`. Test
`desktop/test/new_repository_launch_test.dart` (the Super Tab fixture with the two routes faked).

**Interfaces:** `HarnessLaunchIntegration` gains `newRepositoryOwners` (null hides the row),
`checkRepositoryOwner(owner)` (`ready`, `not-installed` with `installUrl`, `not-accepted`, `not-configured`),
`createRepository(ask, task)` (gives the created address and whether teammates can reach it) and `checkRepositoryAgain()`.

- [ ] Tests:
  - the owner check reads the route, and a 404 reads `not-configured`;
  - create sends `project.create` once, then the POST with `{owner, name, private}`, opens `authorizeUrl`, and
    finishes when the project's `repositoryCreation` with that `at` is `created`;
  - `taken`, `refused`, `failed` and `cancelled` fail with F2, F3, F9 and F8, and the POST's `GITHUB_APP_NOT_INSTALLED`
    and `GITHUB_APP_PERMISSIONS` fail with F4 (with its install link) and F5;
  - an outcome for an older `at` does not finish it;
  - a retry after `created` sends no second POST; a retry after a failure sends a new one;
  - the project gone reads F11.
- [ ] Red, implement, green, commit.

### Task 4: The choice and its prompt (`new_harness.dart`, `new_harness_form.dart`, a new dialog)

**Files:** Modify `desktop/lib/state/new_harness.dart`, `desktop/lib/widgets/new_harness_form.dart`. Create
`desktop/lib/widgets/new_repository_dialog.dart`. Test `desktop/test/new_repository_form_test.dart`.

- [ ] Tests:
  - Choose repo lists "New Repository" / "Create one on GitHub" for New Project when owners are known, and never for
    New Harness or when the server can't create;
  - the prompt has Owner (the first known owner chosen), Name with `github.com/owner/name` under it, Private on;
    F1 shows while typing and "Use this name" stays off; F4 (with Install on GitHub and Copy message) and F5 (with Copy
    message) show after the owner check;
  - after "Use this name" the chip reads "owner/name · new", the button "Create and continue in GitHub", and the note
    "Creates owner/name on GitHub, then clones it on <machine>";
  - Start creates it (the integration is called with the ask), shows "Creating owner/name…" with Check again, then
    starts the Product Manager in the created repository, through the Swarm with its `repositoryUrl`;
  - each failure shows its line and the button reads Try again;
  - light and dark screenshots of the menu, the prompt and the composer (`HARNESS_SWARM_FORM_CAPTURE`).
- [ ] Red, implement, green, commit.
