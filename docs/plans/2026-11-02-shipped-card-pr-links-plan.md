# Shipped card: PR links of the project's repository, Shipped after the merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Shipped card shows one chip per pull request of the project's own repository, and the project chat says Shipped only once the work's pull requests have merged.

**Architecture:** The backend keeps pull request links to the project's repository (one helper in `model.ts`, used by every place that records a link) and records each merge by link on the group's ledger; the ship line posts when a Done's delivered pull requests are all merged, at Done or at the last merge. Desktop and phone dedupe and label chips for rows already posted.

**Tech Stack:** TypeScript (vitest, mongodb-memory-server integration suite), Dart/Flutter (Desktop, phone).

**Spec:** Task #2081 (Diego), brief in the Swarm; ruling by the Lead in the task: an owner is never changed; another owner's link is dropped from text and refused when a command records it. Process note: the project's instructions could not be read when work began (`TEAM_SESSION_LIMITED`), so this plan was written after the first code commit rather than before it.

> **Merged with main, 2026-11-03 (River's call in task #2081):** main replaced the project chat's Shipped line with each task's
> own line, which reads shipped at its first recorded merge (`taskLine.ts`, #2633). Task 2 below is therefore superseded and
> removed: its ship logic, ledger fields and tests are gone, and the task line is the ship moment. Tasks 1 and 3 stay; Task 1
> now uses main's `githubRepository` (`backend/src/github/repository.ts`) instead of a second parser. Waiting for every pull
> request before "shipped" would be a follow-up task.

## Global Constraints

- A recorded PR link points at the project's own repository (`autonomous-ai/openharness`); an owner is never guessed or corrected.
- One entry per PR number: a spelling (case) of the project's repository is the project's own.
- Shipped posts once per group, never at a Done with a delivered PR still open, never twice, never for work already announced.
- Chips: one per owner/repo/number; `owner/repo` shown when it differs from the project's repository.
- Feature design rules (AGENTS.md): see Design below.
- The PR body starts with: Requested by diego@autonomous.ai through Harness.

## Review Focus

- A PR merely mentioned in the task (chat, brief) or closed unmerged must not keep Shipped from posting.
- A merge recorded for a PR with no card (named only in evidence or a thread) must still count.
- A Done that names no PR must ship at its merge; a repeated merge record must not post a second line.
- Work Done and announced under the old rule, then merged or Done again, must not be announced again.
- A fork's PR of the same name (`other-org/openharness`) must not become ours; a project with no GitHub repository must behave as before.

## Design

- growth: a few small ledger fields per group (merged links, awaited links, two marks); link lists only shrink.
- concurrency: inside the command's existing Swarm transaction.
- read cost: no new reads; cleaning touches only groups already loaded for the command.
- scale: constant work per group per command.
- compatibility: old clients draw chips from the same fields; old rows keep their text; a group from before (no `ledger.shipsAfterMerge`) keeps the old announce-once guard.
- migration + rollback: stored groups clean themselves on the next command (task #2002 drops its bad entry, keeps the right one); rolling back leaves cleaned links, which older code accepts.
- audience: the ship line stays in the project chat, never a private conversation.
- identity: N/A.
- failure: a link in another repository through `conversation.merged` is refused with a clear message; links in text are dropped.
- platforms: backend, Desktop, phone.

## What people see

```
Before (task #2002, posted at Done, PRs open)
  🎉 Shipped: <title>      Requested by diego · Built by … · Reviewed by …
  [openharness · PR #2527] [openharness · PR #2527] [openharness · PR #2528] [openharness · PR #2529]
After
  Done, a delivered PR open -> no Shipped line
  all delivered PRs merged  -> 🎉 Shipped: <title>   [openharness · PR #2527] [openharness · PR #2528] [openharness · PR #2529]
  a link outside the project's repository (old rows only): [other-org/openharness · PR #2527]
```

---

### Task 1: Links of the project's repository (backend)

**Files:**
- Modify: `backend/src/superTabs/model.ts`, `cards.ts`, `projects.ts`, `commands.ts`, `store.ts`, `native.ts`, `migration/links.ts`
- Test: `backend/src/superTabs/pullRequestRepository.test.ts`, `backend/integration/superTabs.test.ts`

**Interfaces:**
- Produces: `githubRepository(url): {owner, repo} | null`; `projectPullRequestUrl(url, repositoryUrl): string | null`; `pullRequestLinks(text, repositoryUrl?)`; `appendPullRequestUrls(group, texts, repositoryUrl?)`; `cleanPullRequestLinks(group, repositoryUrl)`; `groupRepositoryUrl(state, group)`.

- [x] **Step 1: Write the failing tests** — `pullRequestRepository.test.ts`: other owner dropped, spelling kept, other repository refused by `conversation.merged` with `not in the project's repository (autonomous-ai/openharness)`, any link taken without a GitHub repository, stored group cleaned (links, cards, merged and awaited lists), cards bound once.
- [x] **Step 2: Run them to see them fail** — `cd backend && npx vitest run src/superTabs/pullRequestRepository.test.ts` (failed on `main`).
- [x] **Step 3: Implement the helpers in `model.ts` and `cards.ts`; use them where links are recorded** (`commands.ts` merged and Done, `store.ts` per group each command, `native.ts`, `migration/links.ts`).
- [x] **Step 4: Run them to see them pass.**
- [x] **Step 5: Integration test** — `superTabs.test.ts` "records a link under the project's repository and corrects the record it held before".
- [x] **Step 6: Commit.**

### Task 2: Shipped after the merge (backend) — superseded by main's task line (see the note above)

**Files:**
- Modify: `backend/src/superTabs/ship.ts`, `commands.ts`, `leaderboard/record.ts`
- Test: `backend/src/superTabs/ship.test.ts`, `buddyNews.test.ts`, `leaderboard/record.test.ts`, `backend/integration/superTabProfile.test.ts`

**Interfaces:**
- Consumes: Task 1's `pullRequestLinks`.
- Produces: `ledger.mergedUrls`, `ledger.shipWaiting` (the PRs a Done awaits), `ledger.shipPostedAt`, `ledger.shipsAfterMerge`; `mergedPullRequests(group)`, `deliveredPullRequests(group, named)`, `celebrable(before)`, `shipNotice(state, group, author, operationId, named)`.

- [x] **Step 1: Write the failing tests** — `ship.test.ts`: Done with an open PR posts nothing and the merge posts it once; merge first then Done posts at Done; several PRs wait for the last, with or without cards; a mentioned or closed PR never blocks; a Done naming no PR ships at its merge; Done, reassigned, merged, Done posts once and a repeated merge record posts nothing; a group from before this rule is not announced again.
- [x] **Step 2: Run them to see them fail** — failed on `main` (16 failed) and on the first implementation (reviewer's findings).
- [x] **Step 3: Implement** — merge recorded by link in `conversation.merged`; Done awaits the PRs its result names (else its checks'); the merge that completes them posts and clears the wait.
- [x] **Step 4: Run them to see them pass** — `npx vitest run src/superTabs` all pass.
- [x] **Step 5: Existing ship tests record the merge before Done** (`ship.test.ts` `finish`, `buddyNews.test.ts`, `superTabProfile.test.ts`).
- [x] **Step 6: Full Super Tab suite** — `cd backend && npm run test:super-tabs`; result in a PR comment.
- [x] **Step 7: Commit.**

### Task 3: Chips on Desktop and phone

**Files:**
- Modify: `desktop/lib/super_tabs/pull_requests.dart`, `ship_row.dart`, `mobile/lib/swarm/swarm_ship_row.dart`
- Test: `desktop/test/super_tab_ship_test.dart`, `mobile/test/swarm/swarm_ship_row_test.dart`

**Interfaces:**
- Produces: `superTabPullRequestLinks(text)` (one per owner/repo/number, case-insensitive), `superTabPullRequestLabels(links, {repositoryUrl})`, `SuperTabPullRequestLinks(text, {repositoryUrl})`; phone `swarmPullRequestLabels`, `SwarmShip.pullRequests` deduped.

- [x] **Step 1: Write the failing tests** — two links for one PR give one chip; a link outside the project's repository shows `owner/repo`; without the repository, owners sharing a name show.
- [x] **Step 2: Run them** — Flutter is not installed on the builder's Mac: they run in PR CI and in the Tester's step.
- [x] **Step 3: Implement** the helpers and pass the project's repository from the ship row (`snapshot.projectFor(conversationId).repository['repositoryUrl']`).
- [x] **Step 4: Commit.**
