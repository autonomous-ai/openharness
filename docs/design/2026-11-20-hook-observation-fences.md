# Verify completed hook observations together

Close/Resume profiling still identifies repeated native route reconstruction in
completed hook proofs. The first V9 middle-source arm records 2,960 Resume
`lstatSync` calls through `verifyParts` and 2,896 through `resolveSync` over eight
cycles. This is a counts diagnostic, not CPU attribution or performance acceptance.
The current source retains that observation code unchanged.

`inspectHookFile.verify()` already has a two-pass path for a complete existing
route. Its batch callers always supply a provisional directory map, bypassing it.
They reconstruct each route and check the same shared ancestors repeatedly.

Keep private metadata beside each complete observation's verifier, with the same
lifetime as that verifier. Assemble the group when observations are captured or
replaced, not during each verification. A batch of at most 32 complete observations may combine
at most 256 compatible route facts. Check that union in two fresh passes, with a
shared operation budget and device identities compared between passes. The second
pass walks the captured facts backwards and checks each selected file's original
version from that same fresh stat, before its ancestors. A later file read must
not leave an already-checked common ancestor stale. This is a synchronous fence: no results
are reused at the next call, across an await, or between independent callers.

Unknown/custom verifiers, absent files or ancestors, conflicting observations and
larger unions retain the existing provisional-walk path without rebuilding a
union on every call. The optional-source caller captures its verifier once;
publication replaces its verifier whenever an observation changes. A change made
during a verification refuses that fence before an effect. A complete single-file
batch uses its existing verifier directly. Publication, ownership, deadlines,
flushes, leaf bytes, modes and alias checks retain their existing authority.

## Design

- Growth: one weakly held metadata record per live complete observation; batches
  are limited to 32 observations and 256 facts. No persistent data or cache.
- Concurrency: synchronous verification only; each call owns its fresh reads.
  Nested verification gets independent state.
- Read cost: two reads per unique complete route fact, including every file's
  version fence; incomplete routes keep their current reads.
- Scale: bounds are unchanged from destination-route verification. The diagnostic
  reports filesystem call counts; helper and production CPU/latency checks follow.
- Compatibility: no public protocol, schema, backend or client change.
- Migration/rollback: no migration; revert the optimization without changing data.
- Audience/identity: N/A because no new data is stored or exposed. Existing local
  account ownership and native path checks remain in force.
- Failure: conflicting or changed evidence refuses publication using the existing
  named errors; an optimization miss executes the existing verifier.
- Platforms: macOS, Linux and Windows filesystem paths. Native Windows validation
  remains deferred by the user's instruction; no process-launch changes.

## Validation plan

First fail caller-level read-count tests on unchanged source. Preserve the
ancestor replacement, alias, leaf identity/content/mode, missing-parent,
oversized-union, nested verification and custom-observation controls. Add complete
source-batch and conflicting-observation cases. Run the affected native hook,
publication and setup tests plus typecheck; obtain independent source review.
Measure actual-source helper CPU and elapsed time against the parent, including
incomplete routes. Only then build and compare the real Close/Resume workload.
The existing performance holds remain until their own measurements pass.

## Source evidence

Eight caller read-count tests fail on the parent
(`20261120T090041.772156Z-48696`) and all 72 focused tests pass after the initial
change (`20261120T090148.203962Z-49645`). Self-review reproduces observation-set
replacement during a fence (`20261120T090304.021951Z-50759`) and a later source
read replacing or aliasing its shared ancestor while preserving the child files
(`20261120T090825.712715Z-58223`). The final implementation refuses both cases.

The corrected source passes 569 tests (six skipped) across 25 affected files and
typecheck (`20261120T090945.844380Z-63352`). The preceding source also passed
packaging and architecture checks with the same import graph (635 tests, six
skipped; `20261120T090334.695168Z-51170`). Independent review approves the final
source (`20261120T090950.615654Z-63661`), conditional on the now-passing final
checks. Its additional compiled-fence replacement control passes with the full
batch suite (`20261120T091349.297922Z-68400`). At commit `153f737199`, the only subsequent runtime-source
change was an explanatory ordering comment. NativeEvidenceBudget allows 32,768
steps; this bounded union uses at most 513. Production observe calls are after
publication/removal, outside the synchronous fence.

This source approval is not performance acceptance. Helper measurement and a
fresh packaged Close/Resume comparison remain required; all prior holds remain.

## Incomplete-route correction

The fixed eight-arm helper comparison against `209a7e2d00` passes all custody and
functional checks (`20261120T091718.797817Z-74231`). Complete-route CPU falls
38–61% across the three callers and both orders. However, attempt verification
with missing parents costs 6.30%/5.09% more CPU, and completed proofs cost
4.07%/4.25% more there. The completed missing-leaf case also regresses. The
predeclared comparison retains these holds; no packaged comparison was run.

When a batch cannot use the complete-route optimization, keep its original caller
loop and collection representation. Do not dispatch it through an additional
closure over a converted array. Compiling returns no optimized verifier in that
case. Optional-source fallback keeps its original object loop; attempt fallback
keeps its live Map iteration; completed-proof fallback keeps its original record
loop. Each still creates one fresh provisional directory map per call. A revision
counter rejects observation replacement during either branch, including replacing
an entry the fallback loop already visited. The two-pass complete-route proof is
unchanged. This changes no stored data, bounds, identity, protocol, platform or
publication authority from the design above.

The helper result is the pre-change performance failure. Rerun the same fixed
eight-arm workload against the corrected source, retaining all earlier results.
The production comparison remains gated on resolving the fallback regression.

The correction passes the 25 affected test files and typecheck
(`20261120T092155.252151Z-81996`); independent source review approves it
(`20261120T092159.420762Z-82077`). Runtime and regression-test bytes are unchanged
from that review. The optional-source caller creates its observations locally
and never mutates the array or replaces an observation after capture. Initial
attempt population occurs before its work callback, between verification fences.
The measured fallback regression is not attributed to one closure with certainty;
the repeated fixed workload must establish whether this correction removes it.
