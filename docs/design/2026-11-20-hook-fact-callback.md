# Keep successful hook checks on one callback

Status: scoped source proposal accepted in the independent JIT diagnosis (`20261120T102937.668316Z-69145`); source approved; performance validation pending. Existing helper and production holds remain.

The trace shows the successful `verifyNativePathFacts` callback site deoptimizing when absent-leaf groups supply a second closure origin. Use the original `checkFile` callback only for valid facts on the reverse pass, for both complete and absent-leaf groups. An independent fifth callback names null-to-present changes from the two mismatch branches, then those branches still refuse unconditionally if it returns. The forward pass needs no successful-fact callback. No filesystem proof or read is removed.

## Design

Growth, persistence, migration, audience and identity: N/A because this changes local verification callbacks only; no new record, process, dependency, core file, data or authority. Concurrency: both fresh passes and all original budgets remain; callbacks are synchronous. Read cost and scale: unchanged reads,32 observations/256 union facts; remove the unnecessary valid forward callback on absent groups. Compatibility and rollback: no public API, stored data, backend or client change. All fourth-argument callers were searched: only grouped hook verification and three direct tests supply one. Failures: the fifth callback names new aliases or changed files; a returning callback still cannot approve either identity or device mismatch. Platforms: shared TypeScript; native Windows test is user-deferred.

## Validation before implementation

The three direct no-bypass controls must fail against the prior code when they request the fifth callback, and prove the fourth callback never sees the mismatched leaf. The original complete-group `checkFile` body and returned fence remain byte-identical to6ae. Run the full existing hook/native path/publication fault matrix and types, then independent source review.

Repeat the same fixed12-scenario/1024-check/fresh-process ABBA+BAAB helper comparison against6ae, retaining every case, first use and control. Missing-leaf gain must still meet the existing15%CPU/main/wall requirement; complete and missing-parent controls keep the same no-repeatable-regression rule. Any whole-scope record is additional and cannot replace per-case gates. The diagnostic predicts callback-site feedback parity only; it does not promise that completed/plain or compiler/GC history holds disappear. Production Close/Resume against the original baseline remains required.

## Evidence

All three new mismatch-callback controls failed on the old source (`20261120T110358.230769Z-1140`,40 other cases passed). After the correction, the unchanged26-file safety matrix passed613 cases with6 existing skips, and TypeScript passed (`20261120T110502.472311Z-2070`). Independent source review approved the final runtime (`20261120T110544.173203Z-2847`). The original6ae successful callback and complete fence bodies remain byte-identical; the retained precondition artifact also records the full caller search. No helper or production hold is cleared by source approval.
