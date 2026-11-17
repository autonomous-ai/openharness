# The resume gate passes on agent Macs (task #4405) Plan

> Written with superpowers writing-plans; one pull request.

**Goal:** `npm run test:resume` passes at clean main on the Mac Studio, as its specs do in Linux CI, so pull requests in
that area can record their exact-head receipt.

**Spec:** Task #4405's brief.

## Reproduced at main 27356f78f, Mac Studio, `npm run test:resume`

Three causes, none of them the temp folder, a running Harness or the ES-module marker (so not #4356's or #4370's):

| # | What fails | Cause | Why CI passes |
|---|---|---|---|
| 1 | Two `sessionRepair.spec.ts` native tests | On macOS they stub in the private Darwin process-image helper from `HARNESS_PROCESS_IMAGES_ARTIFACT`, which only the release workflow builds. Unset on an agent Mac, so they fail at once. | Linux skips the Darwin branch. |
| 2 | `stoppedAgents.spec.ts` "bounds cached record count" (some runs) | 2,050 files written and listed three times: 0.8–0.9 s alone, 7.7 s beside six other files at load 6–7, past the 5 s default. | CI runners are not that loaded. |
| 3 | The gate's 100% coverage (`resumeAgentService.ts` 344, 347) | The resume's stop of a conflicting `claude --bg` job is mocked: its log callback never runs, and no test cancels a resume during that stop. | CI does not run the coverage gate. |

## Fixes

1. `src/testing/darwinProcessImages.ts`: the artifact the variable names, else one built once from this checkout by the
   release's own builder (`scripts/build-process-images.py`, ~1 s, Xcode command line tools). The spec uses it.
2. A 30 s limit on that one test, with the measurement as its reason. No sleep, no retry.
3. Two tests: the log line the stop reports, and a resume cancelled during the stop builds nothing.

## Evidence

- Red: main's `npm run test:resume` on the Mac Studio fails (2 tests; with the helper built, then coverage 99.81%).
- Green: the branch's `npm run test:resume` with no artifact set, 454 passed, 100% on every file.
