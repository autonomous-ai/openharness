# A first start on a new machine clones the repository reliably: plan

**Goal:** An agent start on a machine with no checkout yet clones the project, or says exactly why it could not, and a
failed clone never suspends the engine there (task #3096, requested by Ken).

**Architecture:** 11-05: six starts failed on four machines without a checkout, "could not clone the project repository
with the Harness GitHub App's token: Could not clone the repository" or "Cloning stopped making progress", and each pair of
failures suspended the engine on that machine for up to 6 hours. The clone is already partial (`--filter=blob:none
--single-branch`, `lib/projectFolder.ts cloneRepository`) and already ends a clone with 120 s of git silence, so what is
missing is: git's own reason (`cloneFailure` throws it away), a second try (a clone that fails once on GitHub or the
network often works seconds later), and the engine count (`engineHealth.ts counts` treats a clone failure as the engine's
fault). The three changes:

1. `cloneFailure` and the stall timeout carry git's last `fatal:`/`error:` line (credentials cut, bounded).
2. `prepareSwarmProject` with the App's token retries a failed or stalled clone once after a short backoff; a refusal, a
   changed folder or a missing git is never retried.
3. `engineHealth.ts` does not count a start whose reason is a clone failure.

**Tech Stack:** TypeScript (cli, backend), vitest.

**Spec:** task #3096 brief.

## Global Constraints

- Swarm code stays out of cli/src/core. Tests use fakes and temp folders; no real sign-in is touched.
- Git's words reach the message only after credentials and tokens are cut.

## Review Focus

- A retry never leaves a staging folder or a second clone running (`prepareProjectFolder` removes its staging each try).
- The engine count still counts a real engine failure; only a clone failure is excluded.

## Task 1: git's reason in a failed clone
**Files:** cli/src/lib/projectFolder.ts, cli/src/lib/projectFolder.spec.ts
- [ ] Failing tests: a failed clone's message names git's last fatal line without credentials; a stalled clone's names its last output.
- [ ] Implement `gitsWords`.

## Task 2: one retry of the first clone
**Files:** cli/src/superTabs/projectFolder.ts, cli/src/superTabs/projectFolder.spec.ts
- [ ] Failing tests: a failed or stalled token clone is tried once more after the backoff; a second failure is the error; a refusal or other error is not retried.
- [ ] Implement the retry.

## Task 3: a clone failure does not suspend the engine
**Files:** backend/src/superTabs/engineHealth.ts, backend/src/superTabs/engineHealth.test.ts
- [ ] Failing test: two clone failures in a row suspend nothing; two engine failures still do.
- [ ] Implement in `notTheEngine`.
