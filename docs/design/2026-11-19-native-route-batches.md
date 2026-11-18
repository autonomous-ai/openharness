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
