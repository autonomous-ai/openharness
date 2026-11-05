# A project without a repository can run on other machines, and the owner can share one in the app (task #3211) Plan

> Worked by the Engineer, test first (superpowers test-driven-development): each task's failing test is committed and
> seen red before the code that passes it.

**Goal:** Work that isn't code is no longer pinned to the one machine its Product Manager started on. A project with no
shared repository starts agents on any machine of the Swarm in an empty folder of its own. Its owner can share a GitHub
repository from the app; one with no commit is refused with a plain message.

**Architecture:**
- Backend (`backend/src/superTabs/machines.ts`): `noRepositoryStart(pool, project, request)` turns a start on a machine
  other than the project's source machine, for a project with no repository address, into a start without a worktree
  (`worktree: false`, no `branchRef`). `agent.start` (commands.ts) and the Product Manager's start (leadStart.ts) both
  apply it, so the request the host receives is the one it can carry out.
- CLI host (`cli/src/superTabs/projectFolder.ts`): for such a project, `prepareSwarmStart` asks for no GitHub token
  (there is nothing to clone, and the token route refuses a project with no address), and `prepareSwarmProject` makes
  the project's own folder (`<the Swarm's clone root>/<projectId>`), refusing a folder that is a link or resolves
  anywhere else, `git init`s it so the existing trust step (cloneTrust.ts) records Claude Code's and Codex's folder
  trust for it, and refuses a worktree start (an older backend). A project with a repository keeps today's path.
- Desktop (`desktop/lib/super_tabs/project_options.dart`): the project details' Repository row gets a "Share
  repository" action for the owner when none is set. It takes a GitHub URL, checks on this Mac with `git ls-remote
  --heads` (the owner's own login) that the repository has a commit, and sends `project.repository`.

**Tech Stack:** TypeScript (backend: vitest; CLI: its spec runner), Flutter/Dart (Desktop: flutter test, check-ui-style).

**Spec:** task #3211 brief.

## Global Constraints

- Owned: `cli/src/superTabs/projectFolder.ts`, `backend/src/superTabs`, `desktop/lib/super_tabs/project_options.dart`,
  with their tests and this plan.
- A project that has a repository keeps today's rule: a clone on other machines, and the address-required refusal is
  only gone for projects with no address at all.
- Swarm code stays out of `cli/src/core`. Desktop keeps the dialog's layout (Dee's rule); #3194 (PR #3133) is changing
  Project settings in the same file, so this adds one action to the details dialog's Repository row and nothing else.

## Design

- growth: no new record. One folder per project per machine, as a clone takes today; removed with the Swarm's folders.
- concurrency: the start's request is decided in its command's transaction, as today. Two starts making the same folder
  race on `mkdir`; the second finds it and checks it is a plain directory at the expected place.
- read cost: none new on the backend; the host reads the project row it already has.
- scale: unchanged at 10x.
- compatibility: an older host refuses a no-repository start on another machine, as today ("Share a GitHub
  repository…"). A newer host with an older backend gets `worktree: true` and refuses it plainly. An older Desktop shows
  Repository read-only, as today.
- migration + rollback: none. Rollback brings back the refusal; the empty folders stay, harmless.
- audience: `project.repository` stays owner-or-lead only on the server (commands.ts); the app shows the action only to
  the owner. Start admission is unchanged: the folder must still be the project's own (`projectFolder`).
- identity: the commit check runs with the signed-in owner's own git login on their own Mac; hosts use no login at all
  for a no-repository project.
- failure: every refusal says what to do: a repository with no commit ("add one, for example a README"), an address
  that can't be reached, a folder that isn't the project's, a folder left from before a repository was shared.
- platforms: macOS, Linux and Windows hosts (paths through `node:path`); Desktop on macOS, Windows, Linux.

## Review Focus

- The folder a no-repository start gets: always `<clone root>/<projectId>` (`sameFolder`), never a link, never a
  worktree of anything, and no GitHub token requested.
- The backend change only for a project with no address on a machine other than its source machine.
- The share action: owner only in the app, owner or lead on the server; URL limited to GitHub before git runs.

## Task 1: The backend starts a no-repository project without a worktree on other machines

**Files:** `backend/src/superTabs/machines.ts`, `backend/src/superTabs/commands.ts`, `backend/src/superTabs/leadStart.ts`,
their unit tests.

**Interfaces:** `noRepositoryStart(pool: ContributedMachine | undefined, project: SwarmProject, request: AgentStartRequest): AgentStartRequest`.

- [ ] Test: `agent.start` for a project with no address on a machine other than its source records `worktree: false`
      and no `branchRef`; the same start on the source machine, and any start for a project with an address, keep
      `worktree: true`.
- [ ] Test: a Product Manager's start on another machine for a project with no address has no worktree.
- [ ] Red, then code, then green.

## Task 2: The host prepares an empty folder for a no-repository project

**Files:** `cli/src/superTabs/projectFolder.ts`, `cli/src/superTabs/projectFolder.spec.ts`.

- [ ] Test: a start of a project with no repository on another machine makes `<root>/<projectId>`, a git folder with no
      remote, asks for no token (even on a Team account with the app), and records trust.
- [ ] Test: a worktree start of such a project is refused plainly; a link at the folder is refused; a folder outside
      the project is refused as today.
- [ ] Test: a project with a repository still clones, and a folder left from before a repository was shared is refused
      with a message saying to move it aside.
- [ ] Red, then code, then green.

## Task 3: The owner shares a repository from the app

**Files:** `desktop/lib/super_tabs/project_options.dart`, a Desktop widget test.

- [ ] Test: the owner sees Share repository on a project with none; another member doesn't; a project with one doesn't.
- [ ] Test: a repository with no commit is refused with "add one (for example a README)" and nothing is sent; one with
      a commit sends `project.repository` with the address; a non-GitHub address is refused before git runs.
- [ ] Red, then code, then green; `check-ui-style`.
