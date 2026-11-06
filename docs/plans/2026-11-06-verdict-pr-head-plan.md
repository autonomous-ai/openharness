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

- [ ] Write tests for code PR versus watched brief references, result-named code PR, missing watched head, legacy list and no code PR. Test task and step verdicts including a stale head.
- [ ] Commit tests and watch the regression fail.
- [ ] Implement the shared selector and use it in work.check; choose the code PR independently of whether its head was read.
- [ ] Run affected verdict, command and step tests; commit and push.

## Task 2: Throttle on-demand heads and return Ready promptly

**Files:** Modify `backend/src/superTabs/store.ts`; create `headReadThrottle.ts`, `headReadThrottle.test.ts`; test `backend/integration/superTabPullRequestEvents.test.ts`.

**Interfaces:** A reader wrapper preserving `PullRequestReader`, sharing watch/patch/merge results and promises for 30 seconds, at most 1,000 entries per operation cache. Each caller keeps its own reader cleanup. The store uses Task 1's selector in its pre-check refresh and code PRs for Ready refresh.

- [ ] Integrate current main after reviewed dependency #3337 lands; inspect the combined code before implementation.
- [ ] Write tests: sequential/concurrent old-head checks read once; cache expires at 30 seconds; different PRs and head/base pairs stay independent; failures retry only after expiry; two tasks linking the same PR both learn its head; Ready returns while a deferred head read waits and eventually records it.
- [ ] Commit tests and observe the expected failures before production changes.
- [ ] Add the bounded reader cache, use the common selector for refresh, and make Ready refresh unawaited with existing caught errors.
- [ ] Run affected unit tests, focused real-store integrations and backend typecheck; commit and push. Record exact red/green counts and before/after GitHub read counts.
- [ ] Mark ready, record acceptance evidence at the head and request independent review through task status.
