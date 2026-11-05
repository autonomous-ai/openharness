# Repository reach before a start: implementation plan

> Written by the Engineer and implemented by the same Engineer, task by task, test first
> (superpowers writing-plans and test-driven-development, as the project's instructions set out).

**Goal:** A start or assignment whose agent would reach GitHub only through the Harness GitHub App, for a repository the
app does not cover, is refused at once with one plain sentence naming what the owner must install or approve. A start
that failed for want of repository access never suspends Claude or Codex on its machine. Task #3266 (Huy's groupme:
a Reviewer held to the Team account by an unknown push origin, two failed Team starts, Claude suspended).

**Architecture:** The store reads the project's GitHub access before the command's transaction, as it reads who pushed
(store.ts `pushOriginFor`), through a new hook built on `projectGitHubAccess` (github/projectAccess.ts, the read the app
already shows in Project details). The answer goes into `CommandContext.repositoryReach`. `agent.start` and `work.assign`
refuse with `REPOSITORY_UNREACHABLE` when the account the agent runs in needs the app's token (a Harness Team account,
or a machine whose owner does not own the project: the cases `github-token` serves) and the read says `not-installed`
or `not-approved`. An unknown or absent read refuses nothing: the token endpoint still enforces access, so this is only
the early, plain answer. The push-origin refusal for an uncovered repository names the install instead of "try again
in a minute". engineHealth.ts excuses failed starts whose reason is a repository-access refusal, as it excuses clone
failures.

**Tech Stack:** TypeScript, the backend's Swarm command model, vitest.

**Spec:** the task brief of #3266; the cause posted in its conversation.

## Design

- growth: N/A because nothing is stored; the read is cached by the GitHub App client (installation 10 minutes,
  not-installed 1 minute).
- concurrency: N/A because the read happens outside the transaction and can only refuse.
- read cost: one state load and one cached GitHub/approval read per `agent.start` and `work.assign` that names a GitHub
  project; never on delivery or other hot paths.
- scale: 10x starts are 10x cached reads; the installation lookup's GitHub rate is the first metric to warn.
- compatibility: old clients see a new refusal code with a sentence, as any refusal; old CLIs' failure reasons are
  matched by the backend, so no CLI release is needed for the suspension fix.
- migration + rollback: none; reverting the change restores today's behaviour.
- audience: the server decides; the sentence names only the repository and the install link, both already shown in
  Project details.
- identity: the access read uses the app and the Swarm's approvals, never the machine owner's login.
- failure: a read that fails refuses nothing and is logged by the caller as today; the start then fails as before, now
  without suspending the engine.
- platforms: backend only; every client shows the refusal sentence.

## Global Constraints

- The Team-written rule (audit H2) is unchanged: unknown push origin still keeps work out of the main account.
- Swarm code stays out of cli/src/core. Owned: backend/src/superTabs/ (plus the one-line hook wiring in
  backend/src/routes/superTabs.ts).
- PR body starts with "Requested by phamngochuy.1989 through Harness."

## Review Focus

- The refusal never loosens access: it only refuses earlier; the token endpoint is still the gate.
- Which account needs the app's token matches `github-token` (routes/superTabs.ts) and the CLI's `startGitHub`.
- The excused failure reasons are repository access only, never an engine problem.

## Tasks

### Task 1: a repository-access failure never suspends the engine

**Files:** backend/src/superTabs/engineHealth.ts, backend/src/superTabs/engineHealth.test.ts

**Interfaces:** `notTheEngine(error)` gains a `REPOSITORY_ACCESS` pattern: the CLI's "could not get a Harness GitHub App
token for this project" (any refusal the backend decided), its no-app-on-Team-account sentence, and "Share a GitHub
repository for this project".

- [ ] Write the failing test: two starts failing with each reason leave no failure count and no suspension, for Claude
  and Codex; a real failure in between still counts.
- [ ] Run it and watch it fail.
- [ ] Add the pattern.
- [ ] Run engineHealth.test.ts green; commit.

### Task 2: a start or assignment the account cannot reach is refused at once

**Files:** backend/src/superTabs/repositoryReach.ts (new), backend/src/superTabs/repositoryReach.test.ts (new),
backend/src/superTabs/commands.ts, backend/src/superTabs/teamWritten.ts

**Interfaces:**
- `type RepositoryReach = { state: 'covered' | 'not-installed' | 'not-approved' | 'unknown'; repository: string; installUrl?: string | null }`
- `CommandContext.repositoryReach?: RepositoryReach`
- `requireRepositoryReach(state, machineId, machineOwnerId, project, reach)`: throws `REPOSITORY_UNREACHABLE` (409)
  with the sentence when the account needs the app's token and the reach is `not-installed` or `not-approved`.
- `failPushUnknown(reach?)`: names the install when the repository is not covered.

- [ ] Write the failing tests: a review step's start on the Mac moved to its Team account, for a repository the app is
  not installed on, is refused with the sentence naming the repository and the install link, and no start is queued;
  the same for not approved; an assignment of a Team agent is refused the same way; the owner's own project in their
  own account starts (own login); a covered or unknown read refuses nothing; an own-account start held by an unknown
  push origin on an uncovered repository names the install.
- [ ] Run them and watch them fail.
- [ ] Implement repositoryReach.ts and the calls in `agent.start` and `work.assign`.
- [ ] Run repositoryReach.test.ts, teamWritten.test.ts and commands.test.ts green; commit.

### Task 3: the store reads the access before the command

**Files:** backend/src/superTabs/store.ts, backend/src/routes/superTabs.ts, a store test beside the push-origin one

**Interfaces:** `SuperTabStoreHooks.repositoryReach?: (autonomousEnv, tabId, projectId, repositoryUrl) => Promise<RepositoryReach>`

- [ ] Write the failing test: with the hook answering `not-installed`, an `agent.start` through the store is refused
  with `REPOSITORY_UNREACHABLE`; a hook that throws refuses nothing.
- [ ] Run it and watch it fail.
- [ ] Read it in the store for `agent.start` and `work.assign`, and wire the hook from `projectGitHubAccess` in routes.
- [ ] Run the store test green; commit.
