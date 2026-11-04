# Archive: another repository's PR #N Implementation Plan

> **For agentic workers:** Follow the project Engineer workflow: plan first in a draft PR; implement task by task with a committed failing test before its passing code; one independent review step on the pull request.

**Goal:** A finished task whose result or check evidence names another repository's pull request ("Ported from autonomous-harness PR #2716") archives once its own pull requests are merged or closed, and a group the pass still holds for a pull request nobody can read says so in the log. Strengthens "reviewed and tested before merge" and "dozens of agents run at once": a step left open keeps its Reviewer or Tester busy (AGENT_BUSY) forever.

**Architecture:** Three small changes on the archive path. `archiveWaitsFor` (tidy.ts) reads a "PR #N" as the project's only when nothing next to it names another repository. `pullRequestState` (github/app.ts) answers `'missing'` for a 404 instead of null, and the pass (archive.ts `settled`) and the archive write (store.ts `archiveFinished`) count a missing pull request as settled. The pass logs one warning per group it holds only for pull requests it cannot read.

**Tech Stack:** TypeScript, Vitest, MongoDB memory replica set (integration).

**Spec:** Task #2602 in Super Tab conversation c0b45c5f4e35d958d92aa9b4 (Diego, 2026-11-04; brief from River).

## Global Constraints

- Example result `'Merged PR #40. Ported from autonomous-harness PR #2716.'` on repository `acme/openharness` waits only on `https://github.com/acme/openharness/pull/40`.
- A number is another repository's when the word right before "PR" is `owner/repo` other than the project's, or a repository-shaped name (letters, digits, `.`, `_`, `-`, holding at least one of `.`, `_`, `-`) other than the project's name; or when "PR #N" is followed by `in` or `of` and such a name. The project's own `owner/repo` or name keeps it the project's. Common English compounds before "PR" (`follow-up`, `follow-on`, `re-…`, `co-…`, `pre-…`, `non-…`, `one-…`) are words, not repositories.
- 404 means not a pull request of that repository: skipped (settled). 5xx, network errors, refused tokens and no installation stay null: try again next pass.
- Kept as they are: integration cases "waits for a pull request its cancel names only as PR #N" ('Handed off as PR #1875', open, then archives on merge) and "stays open when its work names PR #N and the project has no repository".
- Log line: `logger.warn('[swarm-archive] group held for pull requests GitHub cannot read', { tabId, group, pullRequests })`, and for the no-repository case `logger.warn('[swarm-archive] group held: it names PR #N and its project has no GitHub repository', { tabId, group })`; once per group per pass, and never for a group an open pull request holds.
- Swarm code stays out of cli/src/core. PR body starts with "Requested by diego@autonomous.ai through Harness."

## Review Focus

1. "Follow-up PR #13" or "Re-opened PR #13" must still wait on #13 in the project's repository (pinned in Task 1).
2. A sentence boundary before "PR" ("Merged. PR #3") is no repository name (pinned in Task 1).
3. A number of another repository when the project has no repository archives instead of holding forever; a bare project number with no repository still holds (pinned in Task 1).
4. GitHub down during a pass never archives a group: only a 404 is settled (pinned in Task 2 and Task 3).
5. A review step's close line names a missing pull request readably ("#2716 not found"), not as "missing" (pinned in Task 3).

---

### Task 1: archiveWaitsFor skips another repository's number

**Files:**
- Modify: `backend/src/superTabs/tidy.ts` (PR_NUMBER, archiveWaitsFor)
- Test: `backend/src/superTabs/tidy.test.ts`, `backend/integration/superTabTidy.test.ts`

**Interfaces:**
- Produces: `archiveWaitsFor(group, repositoryUrl): string[] | null`, unchanged signature.

- [ ] **Step 1: Write the failing tests** in tidy.test.ts, `describe('what a finished group\'s archive waits on')`, with `const repo = 'https://github.com/acme/openharness'` and `named = (result: string) => group({ assignment: done({ result }) })`:
  - `archiveWaitsFor(named('Merged PR #40. Ported from autonomous-harness PR #2716.'), repo)` equals `['https://github.com/acme/openharness/pull/40']`.
  - `'other/tool PR #12'`, `'PR #12 in other/tool'`, `'PR #12 of autonomous-harness'` each wait on nothing (`[]`).
  - `'acme/openharness PR #12'`, `'openharness PR #12'`, `'Follow-up PR #12'`, `'Re-opened PR #12'`, `'Merged. PR #12'`, `'PR #12 in review'` each wait on `.../pull/12`.
  - With no repository: `'Ported from autonomous-harness PR #2716.'` waits on `[]`; `'PR #12'` stays `null`.
  - Integration, in `describe('a finished group')`: a cancel with reason `'Merged PR #40. Ported from autonomous-harness PR #2716.'` in a project with repository `https://github.com/acme/app` archives with a stub answering merged for `.../acme/app/pull/40` only, and the stub never read `pull/2716`.
- [ ] **Step 2: Run** `npx vitest run src/superTabs/tidy.test.ts` and `npx vitest run --config vitest.super-tabs.config.ts integration/superTabTidy.test.ts -t "another repository"`: FAIL (2716 is read as acme's).
- [ ] **Step 3: Implement** in archiveWaitsFor: for each PR_NUMBER match, look at the text before it (`/(?:^|[\s(])([A-Za-z0-9][\w.-]*(?:\/[\w.-]*\w)?)\s+$/` on the slice) and after it (`/^\s+(?:in|of)\s+([A-Za-z0-9][\w.-]*(?:\/[\w.-]*\w)?)/i`), and drop the number when either names another repository by the Global Constraints. Compute the repository before the null check, so a project with no repository that names only other repositories' numbers waits on its links alone.
- [ ] **Step 4: Run** the same commands: PASS.
- [ ] **Step 5: Commit** test first, then code.

### Task 2: pullRequestState tells a 404 apart

**Files:**
- Modify: `backend/src/github/app.ts` (pullRequestState), `backend/src/github/fakeGitHub.ts` (a `pullsStatus` control), `backend/src/superTabs/archive.ts` (PullRequestState type)
- Test: `backend/src/github/app.test.ts`, `backend/src/superTabs/archive.test.ts`

**Interfaces:**
- Produces: `pullRequestState(...): Promise<'open' | 'merged' | 'closed' | 'missing' | null>`; `PullRequestState = 'open' | 'merged' | 'closed' | 'missing' | null`.

- [ ] **Step 1: Write the failing tests:** app.test.ts "answers missing for a pull request GitHub does not know, null when GitHub cannot say": unknown `#9` is `'missing'`; with `github.control.pullsStatus = 502` a known `#9` is null; a refused token and `control.down` stay null. archive.test.ts: `prs.state('https://github.com/acme/app/pull/9')` (not in the fake) is `'missing'`.
- [ ] **Step 2: Run** `npx vitest run src/github/app.test.ts src/superTabs/archive.test.ts`: FAIL (null).
- [ ] **Step 3: Implement:** `if (answer.status === 404) return 'missing'` before the 200 check.
- [ ] **Step 4: Run** the same command: PASS.
- [ ] **Step 5: Commit** test first, then code.

### Task 3: the pass and the write settle a missing pull request, and log what holds a group

**Files:**
- Modify: `backend/src/superTabs/archive.ts` (settled, the no-repository skip), `backend/src/superTabs/store.ts` (archiveFinished's checked type and read), `backend/src/superTabs/tidy.ts` (`SettledPullRequest` type, reviewCloseLine)
- Test: `backend/integration/superTabTidy.test.ts`, `backend/src/superTabs/tidy.test.ts`

**Interfaces:**
- Consumes: `PullRequestState` with `'missing'` (Task 2).
- Produces: `export type SettledPullRequest = 'merged' | 'closed' | 'missing'` in tidy.ts; `archiveFinished(tabId, groupId, checked: Readonly<Record<string, SettledPullRequest>>, reviewOf?)`; `reviewCloseLine(..., settled: Readonly<Record<string, SettledPullRequest>>, ...)`.

- [ ] **Step 1: Write the failing tests:**
  - Integration "archives when a pull request it names is not found in the project's repository": repository `https://github.com/acme/app`, cancel reason `'Merged PR #40. Ported from PR #2716.'`, pass with `appPullRequests(fakeApp(...))` over a `fakeGitHub` that has `acme/app` installed, `#40` merged and no `#2716` (a real 404): archived.
  - Integration "logs once a group held only for a pull request GitHub cannot read": spy `logger.warn`; a group linking `PR` with the stub answering null: one `'[swarm-archive] group held for pull requests GitHub cannot read'` call with `{ group: f.group, pullRequests: [PR] }` per pass; with the stub answering open: none. A group naming `PR #1868` with no repository: one `'… its project has no GitHub repository'` call.
  - tidy.test.ts: `reviewCloseLine` with `{ [url]: 'missing' }` reads `#N not found`.
- [ ] **Step 2: Run** `npx vitest run --config vitest.super-tabs.config.ts integration/superTabTidy.test.ts` and `npx vitest run src/superTabs/tidy.test.ts`: FAIL.
- [ ] **Step 3: Implement:** `settled` reads every URL unless one is open (an open one returns false with no log); merged, closed and missing are recorded in `checked`; null ones are collected, logged once, and return false. The `!own` skip logs its line. store.ts `read` accepts `'missing'`. reviewCloseLine prints `not found` for `'missing'`.
- [ ] **Step 4: Run** the same commands: PASS.
- [ ] **Step 5: Commit** test first, then code.

### Finish

- [ ] `npx tsc --noEmit` and the tests of what changed, locally; the PR's CI runs the whole backend suite once it is ready, and its green run is the suite evidence (Ken, 2026-11-04).
- [ ] Red/green evidence in a PR comment; mark the PR ready; add the review step.
