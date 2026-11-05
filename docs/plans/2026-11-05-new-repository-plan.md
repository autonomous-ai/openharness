# New Project can create a new GitHub repository (task #1788) Plan

> Worked by the Engineer, test first (superpowers test-driven-development): each task's failing test is committed and
> seen red before the code that passes it. Tasks 1 to 6 are the backend (this pull request). Tasks 7 and 8 are the
> phone and Desktop. They share no files with the backend and only the contract in Task 6, so they can run in parallel
> on machines with Flutter.

**Goal:** New Project offers "New repository": the person names it, it is created private in an organization the
Swarm uses, through their own GitHub sign-in, and the project's Product Manager starts in it.

**Architecture:** The backend creates the repository in the existing app sign-in callback, with the person's short-lived
user token, and never with an installation token. The outcome is written on the project in the Swarm state
(`repositoryCreation`), so the apps learn it from the state they already sync. On `created`, the app sends today's
`lead.start` with the new address. Installation tokens are pinned so they can never ask for creation permissions.

**Tech Stack:** TypeScript backend (Fastify, Prisma/MongoDB, vitest, mongodb-memory-server integration). Flutter
phone (`mobile/`) and Desktop (`desktop/`).

**Spec:** `docs/plans/2026-11-05-new-repository-design.md`

## Global Constraints

- Administration is never requested. Installation tokens never carry `repository_creation` or
  `installation_repositories`.
- The user token is used for at most four calls and revoked in `finally`. It is never stored or logged.
- People only: an agent is refused (`HUMAN_REQUIRED`). Only the project's owner starts it, and only while the project has
  no repository address.
- Created with `{ name, private, auto_init: true }`. Private by default.
- Name rule: `^[A-Za-z0-9._-]{1,100}$`, and not `.` or `..`. Owner rule: `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`.
- Organizations only in v1 (`/orgs/{owner}/installation`).
- Harness never deletes a repository it created.
- Copy follows the design's failure table (F1 to F12) word for word.
- Swarm code stays out of `cli/src/core`.

## Review Focus

1. A late or replayed callback (second tab, back button) must not overwrite a newer attempt, or create twice: the outcome
   is written only over the matching waiting request (same `by` and `at`). Task 5 tests it.
2. A create state must never pass as an approval state, nor the reverse. Task 4 tests both.
3. Name taken by a repository the same person just made through Harness (lost answer) reads as created, not F2. One
   made by anyone else, or long ago, reads as F2. Task 4 tests it.
4. The token is revoked even when GitHub throws mid-way. Task 3 tests a throwing callback.
5. Owner names with mixed case (`Autonomous-AI` vs `autonomous-ai`) compare without case. Tasks 2 and 4 test it.

---

### Task 1: Installation tokens can never carry creation permissions

**Files:** Modify `backend/src/github/app.ts` (`mint`). Test `backend/src/github/app.test.ts`.

**Interfaces:** Produces `export const NEVER_ON_INSTALLATION_TOKENS = ['administration', 'repository_creation', 'installation_repositories'] as const`.

- [ ] Test `installation tokens never ask for administration or repository creation`: for every exported `*_PERMISSIONS`
  constant and `GRANTED_TOKEN_PERMISSIONS`, no key is in `NEVER_ON_INSTALLATION_TOKENS`. And `createToken(id, repo, { repository_creation: 'write' })`
  rejects with code `GITHUB_APP_PERMISSIONS_FORBIDDEN`, with no call to `/access_tokens` made (fake GitHub `calls`).
- [ ] Run `npx vitest run src/github/app.test.ts`, which fails on the missing export.
- [ ] In `mint`, throw `GitHubAppError('GITHUB_APP_PERMISSIONS_FORBIDDEN', …, 500)` before calling GitHub when any asked
  permission is in the list. Then run it green and commit.

### Task 2: What an organization allows (`ownerReadiness`)

**Files:** Modify `backend/src/github/app.ts`, `backend/src/github/fakeGitHub.ts` (nothing new; it already has `owners`
and `grants`). Test `backend/src/github/app.test.ts`.

**Interfaces:** Produces `GitHubApp.ownerReadiness(owner: string): Promise<OwnerReadiness>`, where
`type OwnerReadiness = { state: 'ready'; installation: number; canAdd: boolean } | { state: 'not-installed'; installUrl: string | null } | { state: 'not-accepted' }`.

- [ ] Test `says whether an organization lets Harness create repositories`:
  - no `/orgs/{owner}/installation` gives `not-installed` with `installUrl` `https://github.com/apps/harness-fixture/installations/new`;
  - installed, with grants lacking `repository_creation: 'write'`, gives `not-accepted`;
  - with it gives `ready` and `canAdd: false`;
  - also with `installation_repositories: 'write'` gives `canAdd: true`;
  - `Example` and `example` read the same installation, asked once within ten minutes.
- [ ] Run it red. Then implement with `/orgs/{owner}/installation` only (users are v1 not-installed), the private
  `granted()` read, and an owner cache of `INSTALLATION_TTL_MS` (`NOT_INSTALLED_TTL_MS` for a missing one). Run it
  green and commit.

### Task 3: Run a callback's user token, then revoke it (`withUserToken`)

**Files:** Modify `backend/src/github/approvals.ts`. Test `backend/src/github/approvals.test.ts`.

**Interfaces:** Produces `type UserCall = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: Record<string, unknown> }>`,
and `GitHubSignIn.withUserToken<T>(code: string, use: (call: UserCall) => Promise<T>): Promise<T | null>`. Null when
GitHub refuses the code. `permission()` is rebuilt on it, with unchanged behaviour.

- [ ] Test `revokes the person's token after use, even when the use throws`: `withUserToken('c', async () => { throw new Error('x') })`
  rejects with `x`, and the last call is `DELETE /applications/Iv23client/token`. A refused code gives `null`, with
  no API call. The existing `permission` tests still pass.
- [ ] Run it red, implement, run `src/github/approvals.test.ts` green, and commit.

### Task 4: Create the repository (`repositoryCreate.ts`)

**Files:** Create `backend/src/github/repositoryCreate.ts`. Test `backend/src/github/repositoryCreate.test.ts`.

**Interfaces:**
- Consumes `UserCall` (Task 3), `GitHubApp.ownerReadiness` and `GitHubApp.installation` (Task 2), `stateSecret` and `STATE_TTL_MS`.
- Produces:
  - `repositoryNameProblem(name: string): string | null` (F1 copy, or null);
  - `interface CreateRequest { userId; autonomousEnv; tabId; projectId; owner; name; private: boolean; at: number }`;
  - `signCreateState(secret, request, now): string` and `readCreateState(secret, state, now): CreateRequest | null`
    (body carries `kind: 'create'`);
  - `type CreateOutcome = { state: 'created'; repository: string; repositoryUrl: string; login: string; reachable: boolean } | { state: 'taken' } | { state: 'refused'; reason: string } | { state: 'failed' }`;
  - `createRepository(call: UserCall, app: GitHubApp, request: CreateRequest): Promise<CreateOutcome>`.
- [ ] Tests, each with a scripted `UserCall` fake:
  - `names follow GitHub's rule`: `notes-app`, `a.b_c` pass; `''`, `.`, `..`, `a b`, 101 characters fail.
  - `a create state is not an approval state, nor the reverse`: `readState` of a create state is null, and
    `readCreateState` of an approval state is null. The same expiry and forgery rules apply as for `readState`.
  - `creates it private with a first commit, as the person`: POST `/orgs/acme/repos` gets body
    `{ name: 'notes', private: true, auto_init: true }`. The result is `created`, with `repositoryUrl`
    `https://github.com/acme/notes`, and `reachable: true` when `app.installation` finds it.
  - `adds it to the installation only where that is granted`: not covered with `canAdd`: PUT
    `/user/installations/91/repositories/{id}`, then `reachable: true`. Not covered without `canAdd`: no PUT, and
    `reachable: false` (F7).
  - `a name taken by someone else is taken; the same person's create since the request is created`: on 422 "name already
    exists", GET `/repos/acme/notes` with `permissions.admin` and `created_at` ≥ `request.at` gives `created`. Otherwise
    `taken`.
  - `GitHub's refusal is said in its words`: 403 `{ message: 'You need admin access…' }` gives `refused` with that
    message cut to 300 characters. A 5xx or a throw gives `failed`.
- [ ] Run them red, implement, run them green, and commit.

### Task 5: The project's `repositoryCreation` in the Swarm state

**Files:** Modify `backend/src/superTabs/projects.ts` (type), `backend/src/superTabs/store.ts`. Test:
`backend/integration/superTabGithub.test.ts` (the store needs MongoDB).

**Interfaces:** Produces:
- `interface RepositoryCreation { owner: string; name: string; private: boolean; by: string; at: number; state: 'waiting' | 'created' | 'taken' | 'refused' | 'failed' | 'cancelled'; repositoryUrl?: string; reachable?: boolean; reason?: string }`
  on `SwarmProject.repositoryCreation?`;
- `store.startRepositoryCreation(user, tabId, projectId, ask: { owner; name; private }, at: number): Promise<void>`. It
  refuses an agent (`HUMAN_REQUIRED`), a non-owner (`PROJECT_OWNER_REQUIRED`), and a project with an address
  (`PROJECT_REPOSITORY_SET`);
- `store.finishRepositoryCreation(tabId, projectId, by: string, at: number, outcome: Omit<RepositoryCreation, 'owner' | 'name' | 'private' | 'by' | 'at'>): Promise<'recorded' | 'stale' | 'gone'>`.
  It moves `githubRevision`.
- [ ] Tests (in the route suite, Task 6): `waiting` then `created` shows on the project. A finish for an older `at`
  is `stale` and changes nothing. A deleted project is `gone`.
- [ ] Red, implement, green, commit (with Task 6's suite).

### Task 6: Routes (the contract the apps use)

**Files:** Modify `backend/src/routes/superTabs.ts`. Test `backend/integration/superTabGithub.test.ts`.

**Contract:**
- `GET /api/super-tabs/:tabId/github/owners/:owner` (a person who reads the Swarm) gives
  `{ state: 'ready' | 'not-installed' | 'not-accepted' | 'not-configured', installUrl?: string }`. `not-configured`
  means the server has no app or no sign-in (F6: hide the choice).
- `POST /api/super-tabs/:tabId/projects/:projectId/github/repository` with body `{ owner, name, private }` gives
  `{ authorizeUrl, at }`. The errors are `REPOSITORY_NAME` (400, F1 copy), `GITHUB_APP_NOT_INSTALLED` (409, with
  `installUrl`, F4), `GITHUB_APP_PERMISSIONS` (409, F5), `GITHUB_APP_NOT_CONFIGURED` / `GITHUB_APPROVAL_NOT_CONFIGURED`
  (503), and the store's refusals.
- `GET /api/github/callback` reads a create state first. Its pages are:
  - created: "owner/name is ready. Go back to Harness.";
  - taken: F2;
  - refused: F3;
  - cancelled or expired: F8;
  - failed: F9;
  - project gone: F11.

  On created it also approves the repository for the project (`approvals.approve`, scope `project`).
- [ ] Tests, with the stub sign-in exposing `withUserToken` over the fake GitHub, which gains
  `POST /orgs/:org/repos`, `GET /repos/:o/:n` for user tokens and `PUT /user/installations/:id/repositories/:rid`:
  - `the owner creates a new repository for their new project and its PM can start in it`: POST, then callback, then the
    project's `repositoryCreation` is `created` with the URL, the approval is recorded, and `lead.start` with that URL
    succeeds;
  - `another member, an agent, or a project with a repository can't start it`;
  - `each organization state is said before sign-in` (F4, F5, F6);
  - `cancel, a taken name and GitHub's refusal come back to the app` (F8, F2, F3 as `repositoryCreation` states);
  - `a second callback for an older request changes nothing` (Review Focus 1).
- [ ] Red, implement, run `npx vitest run --config vitest.super-tabs.config.ts integration/superTabGithub.test.ts` green,
  update `docs/swarm-github-app.md` (permission row, the two endpoints, the callback's create pages), and commit.

### Task 7: Phone (`mobile/`, on a machine with Flutter: Tony's Mac per Routing)

**Files:** `mobile/lib/swarm/swarm_new_project_sheet.dart`, a new `mobile/lib/swarm/swarm_new_repository.dart` (the
subpage and its state), `mobile/lib/swarm/model.dart` (parse `repositoryCreation`). Tests:
`mobile/test/swarm/swarm_new_project_test.dart`, `swarm_new_project_shots_test.dart`.

**Consumes:** Task 6's contract. The outcome is on the project row as `repositoryCreation`.

- [ ] Tests first:
  - the Repository subpage lists "New repository" above "Enter a link" only when the owner check is not
    `not-configured`, and a 404 hides it;
  - the subpage's owner list is the distinct GitHub owners of `swarmProjectRepositories`, most recent first, the first
    chosen;
  - Private is on by default;
  - F1 copy shows while typing, and "Use this name" stays off;
  - F4 and F5 copy shows after the owner check, with Copy message;
  - Create sends `project.create`, then `message.send`, then the POST, opens `authorizeUrl` in the system browser, and
    shows "Creating owner/name…" with Check again;
  - on `repositoryCreation.state == 'created'` with this `at`, it sends `lead.start` with `repositoryUrl`, then
    `project.rename` to the name;
  - `taken`, `refused`, `failed` and `cancelled` show F2, F3, F9 and F8 with Try again;
  - `reachable: false` still starts the PM and shows the F7 line;
  - light and dark shots of the subpage and the sheet.
- [ ] Implement to the design's phone mockups, run those test files green, and commit.

### Task 8: Desktop (`desktop/`, on a Mac with Flutter)

**Files:** `desktop/lib/state/new_harness.dart` (a "New Repository" row and its prompt state),
`desktop/lib/widgets/new_harness_form.dart` (prompt UI and chip), `desktop/lib/super_tabs/launch.dart` (the create
flow), `desktop/lib/super_tabs/model.dart` (parse `repositoryCreation`). Tests: `desktop/test/new_harness_form_test.dart`,
`desktop/test/new_agent_rows_and_task_test.dart`.

- [ ] The same tests as Task 7, Desktop-shaped:
  - the "New Repository" / "Create one on GitHub" row in Choose repo, for a new project only;
  - the prompt with Owner, Name and Private on;
  - the chip "owner/name · new";
  - the button reads "Continue in GitHub";
  - the note "Creates owner/name on GitHub, then clones it on <machine>";
  - the same outcome handling, opening the browser through the existing link launcher (no console window on Windows);
  - light and dark shots.
- [ ] Implement, run those test files green, and commit.
