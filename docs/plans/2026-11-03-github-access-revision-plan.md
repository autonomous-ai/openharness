# GitHub access clears within one Swarm refresh: implementation plan

> Worked by this project's instructions (Engineer role): this plan is the pull request's first commit, then each task
> test first, one Engineer, one Review step on the pull request. Steps use checkbox (`- [ ]`) syntax.

**Goal:** after someone allows a repository for a project, every member's Desktop drops "Set up GitHub for teammates"
within one Swarm refresh (seconds), and an install done on GitHub's own site is picked up for everyone once anyone opens
the setup dialog or Project details.

**Architecture:** each Swarm project gets a GitHub revision in its Swarm state (`githubRevision`, as `notesRevision`
for notes). The backend moves it when an approval is written, when GitHub sends a person back after installing, and
when a dialog read asking GitHub again (`refresh=1`) finds a different state from the one it last recorded
(`githubSeen`). That state write reaches every member through the Swarm read they already poll. Desktop keeps the
revision it read GitHub access at. When the revision changes, it reads again at once with `refresh=1`, without waiting
out the 5-minute keep, which stays as the fallback.

**Tech Stack:** backend TypeScript (Fastify, Prisma on MongoDB, vitest integration suite on a loopback MongoDB and
`fakeGitHub`); Desktop Flutter 3.47.2 (`flutter_test` with `ConversationServer` fixture).

**Spec:** task #2316 brief (Lead, 2026-11-03 11:51 VN), "Set up GitHub for teammates" clears on every computer within
seconds of allowing it (Dee).

## Global Constraints

- PR body first line: "Requested by dee@autonomous.ai through Harness."
- Approvals decide who can push through the app; this changes only when apps re-read, never who is allowed.
- Before Ready: a test that fails without the fix for every risk named here, red/green evidence in a PR comment, and the
  full Super Tab integration suite for the backend change.
- Never run a test that signs the Mac out of the real CLI (Desktop tests use a memory store and a fake sign-in).
- Swarm code stays out of cli/src/core. Stop only processes you started, by id. Temp files only in mktemp -d folders.
- The 5-minute re-read stays as the fallback (`readGitHubAccess`).

## Design

- Growth: one counter and one state word per project, inside the project's own record; they go when the project or
  Swarm is deleted. Nothing new is stored per read or per person.
- Concurrency: each move is one Swarm state transaction on the head part (where projects live), as every command is;
  a concurrent writer retries. A dialog read writes only when the state it found differs from `githubSeen`, re-checked
  inside the transaction.
- Read cost: the revision rides in the Swarm read clients already make. A client re-reads GitHub access only for the
  project whose revision moved. The backend asks GitHub again at most every 15 s per repository per server
  (`GitHubApp.forget`).
- Scale 10x: each move is one head write plus one GitHub access read per member watching the line. The first metric
  to warn is GitHub API calls of the app's installation (rate limit) from `refresh=1` reads; these are bounded per
  repository by the 15 s forget limit.
- Compatibility: older clients ignore the new fields and keep the 5-minute re-read. New clients reading an older
  backend see revision 0 that never moves, so they behave as today.
- Migration + rollback: none. The fields are optional. Rolling back leaves them in the state, unread.
- Audience: the fields are part of the project as `visibleState` already filters it (readers of the project). The
  GitHub access route checks the reader as before, and the move needs no reader beyond a person the route already let in.
- Identity: N/A because nothing here acts on GitHub as anyone; the read uses the app as before.
- Failure: a move that fails is logged (`[github] access change not recorded`). The approval page still says it was
  allowed and the GitHub read still answers. Clients then fall back to the 5-minute re-read.
- Platforms: Desktop shows the line (project_github.dart). Web and the phone app do not show it (checked:
  no "Set up GitHub for teammates" in web/ or mobile/), so they need no change.

## Review Focus

1. Two servers with different "not installed" caches: a refresh read on a stale server must not keep moving the
   revision back and forth. Only `refresh=1` reads record a state, and `forget` runs first. Test: a second refresh read
   finding the same state moves nothing (Task 1).
2. A swarm-wide approval (`scope: swarm`) must move every project on that repository, not just the one asked from
   (Task 1 test).
3. A failed move must not turn an allowed repository's page into an error (Task 1 test: the approval page is still
   200 when the move throws).
4. A read already in flight when the revision moves must be read again once it lands, not lost (Task 2 test).
5. A project whose revision never moves (an older backend) keeps the 5-minute keep exactly (Task 2 test).

---

### Task 1: backend moves a project's GitHub revision

**Files:**
- Modify: `backend/src/superTabs/projects.ts` (SwarmProject fields)
- Modify: `backend/src/superTabs/store.ts` (two methods near `projectRepository`)
- Modify: `backend/src/routes/superTabs.ts` (callback and GitHub access route)
- Test: `backend/integration/superTabGithub.test.ts`

**Interfaces:**
- Produces: `SwarmProject.githubRevision?: number`, `SwarmProject.githubSeen?: 'not-installed' | 'not-approved' | 'covered'`.
- Produces: `SuperTabStore.githubChanged(tabId: string, repository: string): Promise<void>` moves `githubRevision` of
  every project of the Swarm whose repository is that GitHub repository (owner/name, any case or `.git`). It does nothing
  for a deleted or missing Swarm.
- Produces: `SuperTabStore.githubSeen(tabId: string, projectId: string, state: ProjectGitHubAccess['state']): Promise<boolean>`
  records the state and moves the revision when it differs from `githubSeen`. It returns whether it moved. It ignores any state other than the
  three above.

- [ ] **Step 1: write the failing tests** in a new `describe('the GitHub revision')`:
  - `moves every project on the repository when someone allows it, and a swarm-wide approval moves them all`: two
    projects on example/app plus one on example/other. A project-scope approval through the callback moves both on
    example/app by 1 and leaves example/other at its revision. A swarm-scope approval moves both again.
  - `a dialog read that finds the app installed now moves it once; the same answer again moves nothing`: delete
    example/app from `github.installed`, read `?refresh=1`, which records `not-installed` and moves the revision. Install it, then
    read `?refresh=1`: the revision moves again. Read `?refresh=1` again: no move. Read without refresh after an
    uninstall: no move.
  - `GitHub sending a person back after installing forgets the cache and moves it`: callback with `installation_id` and
    no code moves the revision.
  - `an approval whose move fails still says it is allowed`: `store.githubChanged` stubbed to throw; the page is 200,
    "example/app is allowed", and `log.warn` was called.
  - Revisions read with `store.load(tx, owner, tab)` in a transaction.
- [ ] **Step 2: run them and see them fail** (`cd backend && npx vitest run integration/superTabGithub.test.ts -t
  "GitHub revision"`): fails with "githubChanged is not a function" or revision undefined.
- [ ] **Step 3: implement.** Store methods load the row as `postReflection` does (no reader), use `cloneData`, change the
  matched projects, and `save` with a head touch. Route: after `approvals.approve` call `store.githubChanged`, catching and
  logging a failure. In the no-code callback, call `github.app.forget(named)` and then `store.githubChanged`. In the GitHub access
  route, when `refresh=1`, call `store.githubSeen` with the answer's state (caught and logged).
- [ ] **Step 4: run them and see them pass**, plus `npm test -- src/github` and the GitHub integration file.
- [ ] **Step 5: commit** test first, then code.

### Task 2: Desktop re-reads GitHub access when the revision moves

**Files:**
- Modify: `desktop/lib/super_tabs/model.dart` (`SuperTabProject.githubRevision`)
- Modify: `desktop/lib/super_tabs/controller.dart` (`readGitHubAccess`)
- Modify: `desktop/lib/super_tabs/project_github.dart` (dialog and Project details read with refresh)
- Test: `desktop/test/super_tab_project_github_test.dart`

**Interfaces:**
- Consumes: the project row's `githubRevision` (Task 1).
- Produces: `SuperTabProject.githubRevision` (int, 0 when absent).

- [ ] **Step 1: write the failing tests:**
  - `the sidebar line clears when the project's GitHub revision moves, without waiting 5 minutes`: the line is shown for
    `not-approved`. The answer becomes `covered` and the fixture's project `githubRevision` becomes 1. After `c.refresh()`
    and a pump, the line is gone and the last GitHub read asked `?refresh=1`.
  - `a revision that does not move keeps the 5-minute keep`: a refresh with the same revision asks nothing.
  - `a read in flight when the revision moves is read again after it lands`: a held read with the revision moving
    during it reads once more.
  - `opening the setup dialog asks GitHub again`: a read within 5 minutes still asks `?refresh=1` when the dialog opens.
- [ ] **Step 2: run them and see them fail** (`flutter test test/super_tab_project_github_test.dart`).
- [ ] **Step 3: implement.** `readGitHubAccess` records the snapshot revision it asked at (`_githubRevisionAsked`).
  A different revision now passes the keep and reads with `refresh=1`. `ProjectGitHubAccess.initState` reads with
  `refresh: true`.
- [ ] **Step 4: run them and see them pass**, plus every `super_tab*` test that names `readGitHubAccess`,
  `githubAccessOf` or `ProjectGitHubAccess`, and `check-ui-style`.
- [ ] **Step 5: commit** test first, then code.
