# Verdict PR Selection and Head Read Throttle Implementation Plan

> Implement natively, task by task, with failing tests committed before their fix and one independent PR review.

**Goal:** Judge a verdict on the task's own code PR and avoid repeated GitHub head reads or waiting on them after Ready.

**Architecture:** Share one PR selector between verdict recording and the pre-verdict refresh. Prefer the Engineer's named result among its code PRs, otherwise the newest code PR; never choose an unrelated watched link just because it has a head. Wrap on-demand readers in a bounded 30-second cache sharing in-flight reads by PR, head and base, while applying cached observations to each task independently. Run the post-Ready refresh in the background with its existing error handling.

**Tech Stack:** TypeScript, Vitest, existing Super Tab command/store and GitHub reader interfaces.

**Spec:** Swarm task #3731, conversation `67c8b6952389798eb5c24677`; follows #3628 / PR #3337.

## Global Constraints

- Keep #3628's behaviour: a verdict at the PR's real head counts.
- Never print a token.
- Owns backend/src/superTabs only; no database/query/index, client or dependency changes.
- Preserve exact head/base checks, stale verdicts, patch carry and token cleanup.
- Full backend and four integration shards run in ready PR CI; affected tests locally.

## Review Focus

- Brief links another task's watched PR: the task's code PR wins even before it has a watched head.
- Ready names one of several code PRs: both the refresh and the verdict choose that PR; older records retain their existing fallback.
- Concurrent and repeated reads of the same PR: one external watch within 30 seconds, refreshed at the boundary; another task still records the cached real head.
- GitHub cannot read or throws: failures are throttled too, no fabricated pass, cleanup still runs.
- Ready with a pending GitHub read: command completes; the head is recorded eventually, and background errors remain caught.

## Task 1: Select the task's code PR

**Files:** Modify `backend/src/superTabs/checkVerdicts.ts`, `commands.ts`; test `checkVerdicts.test.ts`, `steps.test.ts`.

**Interfaces:** Export `verdictPullRequest(task: Conversation, repositoryUrl?: string | null): string | undefined`; consume existing code PR list and Engineer result; preserve old-list fallback through `codePullRequests`.

- [x] Write tests for code PR versus watched brief references, result-named code PR, missing watched head, legacy list and no code PR. Test task and step verdicts including a stale head.
- [x] Commit tests and watch the regression fail.
- [x] Implement the shared selector and use it in work.check; choose the code PR independently of whether its head was read.
- [x] Run affected verdict, command and step tests; commit and push.

## Task 2: Throttle on-demand heads and return Ready promptly

**Files:** Modify `backend/src/superTabs/store.ts`; create `headReadThrottle.ts`, `headReadThrottle.test.ts`; test `backend/integration/superTabPullRequestEvents.test.ts`.

**Interfaces:** A reader wrapper preserving `PullRequestReader`, sharing watch/patch/merge results and promises for 30 seconds, at most 1,000 entries per operation cache. Each caller keeps its own reader cleanup. The store uses Task 1's selector in its pre-check refresh and code PRs for Ready refresh.

- [x] Integrate current main and reviewed dependency #3337 into the draft; inspect the combined code before implementation. Main will be merged again once the dependency lands so the final review diff contains only this task.
- [x] Write tests: sequential/concurrent old-head checks read once; cache expires at 30 seconds; different PRs and head/base pairs stay independent; failures retry only after expiry; two tasks linking the same PR both learn its head; Ready returns while a deferred head read waits and eventually records it.
- [x] Commit tests and observe the expected failures before production changes.
- [x] Add the bounded reader cache, use the common selector for refresh, and make Ready refresh unawaited with existing caught errors.
- [x] Run affected unit tests, focused real-store integrations and backend typecheck; commit and push. Record exact red/green counts and before/after GitHub read counts.
- [x] Mark ready, record acceptance evidence at the head and request independent review through task status (handoff follows this commit).

## Validation notes

- Own-PR regressions: 3 expected failures before selection code; an additional brief-only case failed before preserving the no-code boundary.
- Reader throttle: 6 behavioral failures with a passthrough reader, then green; store regressions showed 3 external watches instead of 1, 2 instead of 1 across tasks, and Ready blocked by a deferred read.
- A later real-store regression showed cached observations could undo a newer watcher record. The cache now refuses that older observation against the caller's newer stored head; test committed and failed before the guard.
- 660 affected unit tests, 10 focused real-store integration tests and backend typecheck pass. The local client was already generated from the unchanged schema.
- Cache entries expire after 30 seconds, including failures; active reads are shared and never evicted. Each operation cache has at most 1,000 entries, with no timer or stored tokens. A verdict for a newer push within that window may wait for expiry or the independent minute watcher; it is never approved by assuming a head.
