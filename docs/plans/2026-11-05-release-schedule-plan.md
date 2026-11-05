# Releases scheduled by the Swarm, tasks marked Shipped — Implementation Plan

> **For agentic workers:** Follow the project's Engineer workflow: this plan is the pull request's first commit; implement
> task by task, each failing test committed before the code that passes it; one review on the pull request. No Execution
> Handoff.

**Goal:** The server opens a release step for the project's Integrator inside the release window (Desktop, CLI and web after
each visible batch; the backend at most every 2 hours), and a verified release (its tag's release workflow succeeded) marks
the merged tasks it carries Shipped, so the board's Shipped column is true without anyone typing it (task #3405, anh Dee's
Swarm redesign, 11-05). Strengthens "Tell the PM what you want, and your crew ships it": shipped means people have it.

**Architecture:** Three pieces in `backend/src/superTabs/`.

1. `releases.ts` (pure): the release rules (window and pace, the same shape as the project rules record's `releaseWindow`
   and `releasePace`, #3393, with `backendPause` 09:00-10:00 per River 11-05; constants in this one file until that record
   lands), the release components (backend, CLI,
   Desktop, web: tag suffix, release workflow, visible paths), and the decisions: `inReleaseWindow`, `componentsOf(files)`,
   `releaseDue`, `shippedNow`. A per-project ledger on the project (`SwarmProject.releases`): merged tasks not shipped yet
   (`pending`), the last verified release per component (`last`), and the open release step per component (`steps`).
2. A merge recorded on a task (`conversation.merged`, and any server merge through the same `notePendingRelease`) adds the
   task to its project's `pending`.
3. `releaseWatch.ts` (worker, every 5 minutes): for each Swarm with recent work, each project with a ledger to settle and a
   GitHub repository the app reads: resolve new pending entries (the merged pull request's merge commit; the task's own
   pull request's files → components), read each component's newest successful tag-push run of its release workflow (the
   verified release: tag + its artifacts built and checked by that workflow) and check that its tag sits on main. Main is
   linear (squash merges only) and the merge train records the original pull request with its merge time, so a release
   carries every merge recorded at or before its tag's commit landed on main. Then `SuperTabStore.settleReleases` writes in one transaction: tasks shipped (`Conversation.released`, a line
   in the release step), and a new release step for each due component, the Integrator named in it.

**Tech Stack:** TypeScript, vitest, Prisma on MongoDB (no schema change), the Harness GitHub App (read-only token:
contents, pull requests, actions).

**Spec:** task #3405 brief; project instructions rev 78 (Integrator role; release window; PM schedule "Releases go out
through the day"); sibling #3393 (`policy.ts` `ProjectRules.releaseWindow/releasePace`), #3402 (merge train records merges),
#3397 (crew roles).

## Global Constraints

- Swarm code stays out of `cli/src/core`. Backend only; no Prisma schema change, no new collection, no new index.
- Numbers live in one place (`RELEASE_RULES` in `releases.ts`) until the project rules record lands; then it reads the record.
- Identity: the server writes as the Swarm (system rows), never as a person's or the machine owner's login.
- Fail closed: a GitHub read that fails marks nothing shipped and opens no step on a guess; it is logged and retried.
- No release switches: the schedule ships on.

## Design

- Growth: `pending` holds merged, unshipped tasks only; an entry leaves when its task ships, or after 14 days with a warning
  (a merge no release carried). At most 100 entries; the oldest leaves first with a warning. `last` is one row per
  component; `steps` one pointer per component, cleared when its release is verified or its step ends.
- Concurrency: `settleReleases` loads the head and the groups it writes in one transaction (the store's optimistic part
  versions); a concurrent write retries. Steps are opened by a stable id per (project, component, release slot), so a
  retry or a second worker pass never opens two.
- Read cost: one head read per candidate Swarm a pass; GitHub only for projects with pending entries or open steps; each
  pending entry's pull request read once (cached in the entry); per project a pass, one workflow-run read and one compare for
  each component something waits for; the Swarm candidates' aggregation once an hour.
- Scale: 10x merges = ~300 pending a day at peak, still cleared by each release; the warning "pending full" and the
  GitHub rate (5 minutes × 4 reads × projects) warn first.
- Compatibility: older clients ignore `released`; Desktop keeps its merged = Shipped until a follow-up reads `released`
  (proposal to the PM). Reads strip `releases` from projects, as they strip `schedule`.
- Migration + rollback: none. An absent ledger starts empty; tasks merged before the release are not backfilled.
  Rollback leaves harmless fields.
- Audience: only the server writes the ledger; no command sets it. The step is a task in the project, read as any task.
- Identity: system rows; the GitHub App's own token.
- Failure: every skipped project or unreadable pull request is logged with its reason; a step that ends without a verified
  release lets the next pass open a new one, so a failed release is seen again.
- Platforms: server only.

## Review Focus

- The window, pause and pace edges (08:59/09:00/09:59/10:00/17:59/18:00 VN, 119/120 minutes).
- That only a successful tag-push run of the component's own release workflow counts as verified, only for a tag on main,
  and only for merges recorded at or before its tag's commit.
- A task touching two components ships only when both are released; docs-only work ships at its merge.

## Task 1: release rules and decisions (pure)

**Files:** `backend/src/superTabs/releases.ts` (new), `backend/src/superTabs/releases.test.ts` (new).

**Interfaces:** `RELEASE_RULES`, `RELEASE_COMPONENTS`, `inReleaseWindow(rules, now)`, `componentsOf(files)`,
`releaseDue(ledger, component, now, rules)`, `shippedNow(entry, ledger)`, `ReleaseLedger`, `PendingRelease`.

- [ ] Failing tests: window edges in Asia/Ho_Chi_Minh; backend due only 120 minutes after the last verified backend release;
      Desktop/CLI/web due right after a visible merge; nothing due with an open step; test-only and docs-only files map to
      no component; an entry ships only when every component carries it.
- [ ] Implement.

## Task 2: merges join the ledger

**Files:** `backend/src/superTabs/releases.ts`, `backend/src/superTabs/commands.ts`, `backend/src/superTabs/projects.ts`,
`backend/src/superTabs/read/views.ts`, tests in `releases.test.ts` and `commands.test.ts`.

**Interfaces:** `notePendingRelease(project, group, mergedUrl, mergedAt)`; `SwarmProject.releases?: ReleaseLedger`;
`Conversation.released?: { at: number; tags: string[] }`.

- [ ] Failing tests: `conversation.merged` adds the task once (a second record of the same merge adds nothing); the cap
      drops the oldest; a project read carries no `releases`.
- [ ] Implement.

## Task 3: the store write

**Files:** `backend/src/superTabs/store.ts`, `backend/src/superTabs/releases.ts`, `backend/src/superTabs/releases.test.ts`.

**Interfaces:** `SuperTabStore.settleReleases(tabId, projectId, facts: ReleaseFacts): Promise<SettledReleases>`.

- [ ] Failing tests (memory store): a verified release marks its tasks `released` and posts the line in the step; a due
      component inside the window opens one release step naming the Integrator (role "Integrator", crew or start role);
      outside the window none; at the pace none; a second call opens no second step; with no Integrator the step says the
      PM assigns it.
- [ ] Implement.

## Task 4: the worker pass

**Files:** `backend/src/superTabs/releaseWatch.ts` (new), `backend/src/superTabs/releaseWatch.test.ts` (new),
`backend/src/github/app.ts` (a read-only `reader(repository)`), `backend/src/worker.ts`.

**Interfaces:** `ReleaseReader` (`pull(url)`, `latestRelease(repository, component)`, `contains(repository, base, head)`),
`appReleaseReader(app)`, `watchReleases(db, store, reader, now)`, `startReleaseWatch(db, store, reader, everyMs)`.

- [ ] Failing tests with a fake GitHub: only a successful `push` run whose branch is `v<x.y.z><suffix>` counts; a failed or
      missing read marks nothing and opens nothing; entries resolve once; the pass calls `settleReleases` with the facts.
- [ ] Implement; start it in the worker.
