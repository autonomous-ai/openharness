# Fresh native route verification in sibling batches

The current launch/Resume V5 comparison is held for regressions. Its follow-up CPU diagnostic uses
the same frozen source bundles and identifies added Create work in native hook preparation's route
and file verification. Six cached Creates use 221.944 → 488.188 ms raw main-thread CPU under profiling;
native lstat sample occupancy is 45.803 → 130.619 ms. Those diagnostic numbers include instrumentation
and are not function CPU or performance acceptance. The completed V5 packet remains the cost gate.

`verifyHookFiles` already shares provisional directory reads among sibling sources. Each source's
`NativePaths.snapshot()` still verifies every fact afresh, and each observed file still gets its final
file-version lstat. Apply that same existing rule to three remaining loops in `nativeHookFiles.ts`:
the destination route verifier, the preparation's observed-file verifier, and its completed proof's
current-file verifier. Each loop creates and discards its own Map; nested calls get separate Maps.
No Map survives an await or becomes part of a retained proof.

All owner/deadline checks, verification callbacks, path snapshots, leaf-version checks, publication
effects, descriptor checks, flushes and their order remain. Checkpoint journal flushes are outside
this correction. No runtime module, protocol, process, setting or long-lived cache is added.

## Design

- Growth: each synchronous loop's Map contains at most 256 provisional directory entries, the existing
  `NativePaths.resolveSync` bound. Beyond that, it reads uncached. The Map becomes unreachable on return.
- Concurrency: no await inside a loop, no shared Map across invocations; existing reservations and
  joining/settling rules remain the authority. A nested proof gets its own provisional reads.
- Read cost: only repeated provisional directory reads within a loop are shared. Every final snapshot
  and file-version read remains fresh. Three siblings change the common directory's route reads from
  six to four and route-plus-observation reads from twelve to eight; actual RED/green results follow.
- Scale: existing bounds remain 32 destinations, 256 path components/facts and 256 provisional directories.
  Existing held states report refused or unavailable proof; this adds no new persistent measure.
- Compatibility: private function callback typing only; public/worker contracts, on-disk formats and
  last-30-day clients are unchanged. No backend rollout is required.
- Migration/rollback: no data migration; revert the code to return to independent provisional walks.
- Audience: existing local process and file-owner checks are retained at the same fences.
- Identity: each file's full original route/alias facts and final identity/version are checked; the
  provisional Map never supplies final authority and never selects a different account or destination.
- Failure: unchanged refusal/logging paths. Injected ancestor replacement, alias introduction, file
  replacement, byte/mode change and nested proof mutation must remain refused before an effect.
- Platforms: portable TypeScript affecting macOS, Linux and Windows. macOS runs locally; Linux is part
  of final CI/native validation. Native Windows remains deferred by the user's instruction.

## Validation plan

Three caller-level count tests fail first: `hookPreparationRoutes.verify`, `attempt.verify` inside
`runHookPreparation`, and the returned completed proof's `current`. Targeted same-cause controls keep
fresh final ancestry/leaf checks, aliases, nested proof calls and the existing 256-entry fallback.
Then run the native hook file/publication and affected launch caller suites with per-file coverage,
plus TypeScript. A short matched actual Create comparison measures the isolated change; final combined
launch/Resume validation waits for the other held runtime corrections. No checkpoint flush is removed.

## Actual RED

At clean source `bee20802aaf8f8b8fa8c6dbf7ad7b2790e915cf4`, the three count cases fail
as intended: destination route reads are 6 rather than 4, and preparation and completed-proof reads
are each 12 rather than 8. The remaining 22 cases were intentionally excluded from this RED run.
The validator records actual exit 1, no timeout, and unchanged source before and after in
`.harness/validation/20261118T203516.030301Z-22470/receipt.json` (0.665 seconds for the test process).
The runtime patch follows this captured RED; the selected caller/authority suite and types follow next.

## First selected gate

At clean source `3f643140bfead530414751cdce5b1b99a5131e6a`, 397 of 398 selected tests pass,
including all 25 new batch cases. The inherited 6,000-line Hermes YAML install returns false after
6.998 seconds under V8 coverage; its fixture suppresses the underlying refusal. TypeScript passes
in 41.688 seconds. The failed suite produces no coverage report. The retained receipt is
`.harness/validation/20261118T203835.915627Z-26155/receipt.json`; source stays clean and unchanged.
The test now includes only error name/message as assertion context so the failure's reason is visible.
The next diagnostic compares unchanged and batched routes on this case; no timeout is relaxed.

## Inherited coverage failure isolated

The same existing case fails once on unchanged routes at `b1706dd080` (7.038 seconds) and once
on batching at `1d294e775a` (6.87 seconds). Both report the native evidence deadline followed by
the preparation deadline. Receipts are retained in the before worktree at
`.harness/validation/20261118T205019.987417Z-38448/receipt.json` and this worktree at
`.harness/validation/20261118T205037.104314Z-38630/receipt.json`. Those single-case coverage reports
are diagnostic only and do not replace the failed 17-file gate or claim complete coverage.

The valid-large-file test now controls its own performance clock and timeout timers. It exercises
the same 6,000 lines, real parser, filesystem and publication, without making acceptance depend
on coverage overhead. Production deadlines stay unchanged. Separate native evidence and hook
attempt/file tests retain expiration, cumulative work/probe limits, joined deadlines, retained
descriptors and reservations, and the final post-filesystem deadline fence. The fixed test still
requires a green gate; no new execution has been used to claim that result.

## Corrected source gate

At clean `c5bacf5c67`, the selected gate passes all 17 files and 398 cases (28.9 seconds), including
all 25 new batching controls; TypeScript passes (7.5 seconds). Receipt:
`.harness/validation/20261118T205442.958559Z-43010/receipt.json`, actual exit 0 and unchanged source.
`nativeHookFiles.ts` coverage is 313/324 lines (96.6%), 425/467 statements (91%), 207/248 branches
(83.46%) and 74/74 functions. All 15 statements starting on added runtime lines are exercised,
including completed-proof success and refusal. Coverage is retained under
`/tmp/core-native-route-batch-coverage`; no full-file 100% claim is made for this engine helper.

Actual caller common-directory reads now meet 4/8/8 instead of 6/12/12, with unchanged fresh final
proofs and alias/cap/overlap controls. A matched actual Create comparison and the final combined
launch/Resume cost gate are still pending; this source gate does not clear the original V5 hold.
