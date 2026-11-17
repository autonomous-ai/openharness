# Remove the CLI end-to-end tests of the deleted Swarm backend

## Problem

#4280 deleted the Swarm from the backend: `POST /api/super-tabs` and the rest of its routes answer
`410 SWARMS_REMOVED` (`backend/src/routes/gone.ts`). Four CLI end-to-end files drive that backend for real
(`cli/e2e/harness/realBackend.ts`) and now fail at their first step. On cli-e2e run 43554999031 they are the only
reds:

| File | Shard | Result |
|---|---|---|
| `cli/e2e/swarmAttachChat.e2e.ts` | 2 | 3 of 3 failed |
| `cli/e2e/superTabTerminal.e2e.ts` | 3 | 1 of 1 failed |
| `cli/e2e/swarmV4Team.e2e.ts` | 6 | 1 failed, 3 skipped after it |
| `cli/e2e/swarmV4Journey.e2e.ts` | 8 | 1 failed, 9 skipped after it |

The Swarm is being deleted from the product (#4278 docs, #4279 mobile/dial/TUI, #4281 desktop). Decision: delete
these tests.

## Change

1. Delete the four files above.
2. `cli/e2e/harness/realBackend.ts` `signIn`: drop the `before` callback and the `options.submissionGate` argument.
   Only the deleted files pass them (`sharedTabs.e2e.ts`, `twoAccounts.spike.e2e.ts` and `cli/scripts/spike-a-stack.ts`
   pass at most three arguments; `docs/performance/2026-10-27-pm-confidential-isolated-run.test.mts` passes three and
   is deleted by #4278). The doc comment loses the sentences about them.
3. Comments that name a deleted file:
   - `.github/workflows/cli-e2e.yml` (the real-backend set-up step): the real-backend specs left are shared tabs,
     socket churn and the two-account spike; the set-up stays.
   - `cli/e2e/harness/daemon.ts` (the grid guard, `ADAPTER_GRID_RUNTIME_METADATA_URL` / `DISABLE_GRID_INSTALL`) and
     `cli/e2e/leftBehind.e2e.ts` (its test): the guard and its test stay, since the CLI's Swarm grid pass
     (`cli/src/superTabs/swarmGrids.ts`) still ships; the comments say why without naming the deleted file.

## Kept, and why

- `realBackend.ts` itself, its `account`, `signIn`, `startRealBackend`, `backendApi`, `stopAll`: used by
  `sharedTabs.e2e.ts`, `socketChurn.e2e.ts`, `twoAccounts.spike.e2e.ts`, `harness/socketScenario.ts`,
  `cli/src/testing/realBackendApi.spec.ts` and `cli/scripts/`.
- Fake engine commands the deleted files used (`!latestart`, `!permit`, `submissionGate`): used by `compat`,
  `engineReaders`, `engineSubmission`, `questions` and `harness/questionWork.ts`.
- `HARNESS_E2E_SERVICES_DIR` and the workflow's backend set-up: the remaining real-backend specs need them.
- `cli/ci-e2e-durations.json` has no entry for the deleted files.
- The Swarm end-to-end files on the fake backend (`superTabs`, `superTabAgentChat`, `superTabChannel`,
  `superTabMachines`, `superTabsCollaboration`, `swarmAttachRestart`, `swarmStartExit`, `swarmWorktreeRemoval`,
  `swarmBasics`, `swarmNoShellGuard`, `swarmSwitch`, and `harness/swarmReads.ts`): they pass, and test CLI Swarm code
  that still ships. They go with the CLI's own Swarm removal.
- Dated records under `docs/plans/` and `docs/research/` that name the deleted files: history, unchanged (two of them
  are in #4278).

## Not touched

Product code; every file of #4278, #4279 and #4281.

## Verification

- Locally: `cd cli && npx vitest list --config vitest.e2e.ci.config.ts --filesOnly` lists every remaining file
  without the four; `e2e/leftBehind.e2e.ts` passes; `git grep` finds no reference to the four deleted files outside
  dated `docs/` records.
- One `CLI end to end` run (`workflow_dispatch`) on the branch, after the orchestrator's go: the four files are gone
  from the inventory, every shard and `e2e-summary` pass, and no file that passed on run 43554999031 fails.

## Plan

One task, agreed with the orchestrator in place of a separate plan file: it changes no behavior, so it is one commit
with no red test.

- **Task 1** (effort `medium`, no dependencies). Files: the four deleted files, `cli/e2e/harness/realBackend.ts`,
  `cli/e2e/harness/daemon.ts`, `cli/e2e/leftBehind.e2e.ts`, `.github/workflows/cli-e2e.yml`. Does items 1-3 of
  Change, then the local checks of Verification.
