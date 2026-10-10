# Native Change agent handoff authority

This change addresses the handoff consumer in the daemon-core completion checklist.
History reading, normalization, redaction, rendering and git commands remain in the
edge service. The core owns the final bounded publication, including current session
and native identity, request lifetime, the project destination and git exclusion.
Unavailable evidence holds the original Change agent request before Close.

## Former-code baseline

Before changing runtime code, `nativeHandoff.golden.spec.ts` recorded twelve healthy
observations from `a395b72cf20d2d574b80eb737f2f39cae58e3b7e` at October 10 11:06 UTC.
Both Linux and macOS behavior are explicitly pinned. Each covers own history,
fork-parent history and discovered history through the inline service and the real
JSON service-link/query composition. Actual private native files, reader, renderer
and writer run; host binaries are forbidden. The clock, UTC and fixture identities
are fixed. No test uses an owner's home, daemon, tmux or clients.

The artifact SHA-256 is
`b921e24e4e321820fa65f14852f48ff1648c2c82447a2ea131bd7a075e958f11`.
Recording passed; unchanged replay of this golden and the prior 38-observation
native-consumer golden passed (four platform cases, two files), then typecheck passed.
An initial recording command used a doubled config path and ran no tests; the
corrected command ran from the CLI directory. The prior artifact stayed unchanged.
This baseline is committed separately before implementation.

## Accepted design and selected validation

Independent read-only architecture review approved a core-owned final commit with
injected session/lifecycle facts and an eager bounded filesystem helper. It must not
import history readers, rendering, git execution or `agentHandoff`. No architecture
exception is needed. The review requires:

- Exact descriptor identity and finite content version carried from the actual read.
- The complete fork/selection facts and fresh ownership after asynchronous discovery.
- A core-owned request deadline and connection witness checked inside publication.
- Git exclusion authorized together with every other project write.
- Private durable receipts: same ID/different input conflicts; partial publication or
  an uncertain reply is never inferred to be a completed handoff.
- Explicit holds through malformed/disconnected process replies and both Desktop and
  TUI, before Close; no fallback from unavailable identity to cached conversation data.

The former code fails twelve composed native-authority assertions while its healthy
golden passes. Additional regressions cover body replacement with an unchanged
header, ancestor/project changes, intermediate fork changes, stale request/connection,
publication failures and recovery, and both clients receiving a hold without Close.

Before landing: typecheck, architecture, full core and harnessd coverage at the
repository thresholds, affected native/reader/handoff/process specs, touched client
specs, private handoff/lifecycle/service-process e2e lanes, behavioral wiring mutations,
and matched runtime-cost samples. Record exact input/toolchain scopes before formal
validation. Keep all golden artifacts unchanged, obtain independent exact-head/base
review, and wait for every automatic check including `ci/required`. Merge with the
repository helper. No release is authorized.

## Implementation and review in progress

PR #1144 (native history deletion) merged on October 10 at 11:21 UTC as
`cb242cf4c7d21b7b7cd95ac727fedb30317e9878`; this branch includes that result.
Handoff implementation remains in progress and has not been approved or landed.
Independent review found and the implementation now addresses mutable discovery
rows, lib-to-core composition, missing project/selection authority, interrupted
exclude recovery, directory durability, and unbounded special-file reads. Final
review and the selected gates are still required.

The baseline fixture reused one agent/change ID across otherwise independent
observations in different projects. Durable intent checking correctly rejected that
reuse. Each observation now has an independent private daemon-data directory. The
corrected fixture was replayed against the former unchanged runtime
`a61cba5bc967cbfd8e888995987cc42cbf6556ee` at 11:20:47 UTC and passed. The committed
artifact remains byte-for-byte unchanged. The platform test budget is now twenty
seconds for its six durable transactions; each actual preparation still has its
original five-second deadline.

Exploratory checks are not final gate receipts. Typecheck and the unchanged healthy
goldens passed after the initial authority move. Twelve original native regressions
now hold; the expanded composition covers altered JSON project/conversation/profile/
engine/owner/intent, omitted evidence, a closed/expired/replaced request, and an
intermediate fork changed after reading. The discovery regression mutates the actual
registry object in place. Seven interrupted-publication cases passed across a fresh
publisher instance: partial receipt write, receipt-directory sync, project-directory
sync, partial output stage, exclusion rename, transcript link and completion-receipt
sync. Unavailable old fallback expectations are being migrated; an incomplete suite
is not a passing gate.

The normalization/rendering unit suite injects its synthetic transcript reader
boundary; its real git and filesystem publication still run. Native identity remains
real in the core `handoffPublication.native.spec.ts`, golden and service/lifecycle composition tests.
The first formatter-only command ran from the wrong directory and found no tests;
the corrected CLI-directory run exposed the legacy fallback assertions.

A completed clean checkout for #1144 was retired after preserving its validation,
review, merge receipt and earlier archived evidence, while retaining its Git branch.
No owner checkout or user data was changed. Publication remains zero: no release.

The second independent implementation audit remains blocking, not an approval. Its
eight findings now have implementation changes: stable TUI intent across connection
generations, a last opened-descriptor content fence, receipts for confirmed-empty
outcomes, final ignore/exclude confirmation, exact ancestor selection, recovery of a
reserved native snapshot after an append, conflict propagation and explicit client
reselection, and rejection of unknown JSON fields before filesystem work. Inline and
process retries also exposed property-order-dependent intent hashes; hashes now use
explicit field tuples. Thirty-five native/process cases passed after these fixes.

The first durable private reservation owns the immutable redacted snapshot. New
reservations require the exact current native content version. Recovery verifies a
fresh current candidate and the retained owner, native header, root, path and file key;
it can finish the reserved snapshot after the live body appends. It never adopts an
unrecorded document stage or silently replaces changed public files or exclusions.

Broader exploratory composition passed 249 cases and failed three: one stale
process-record expectation and two responsiveness assertions. Publication's repeated
synchronous durable fences delayed the event loop by 1.26 seconds in the wire test.
That responsiveness defect must be fixed before final validation. All seventy
Desktop switch tests passed, but the separate reply-validation test file failed to
load because the Flutter VM WebSocket upgrade failed; the combined run is not a pass.
The TUI build passed and fifteen switch cases passed; its reconnect fixture needs to
mark the synthetic link usable before capturing the generation. All client tests use
private homes; the reconnect fixture targets port zero. No installed daemon is used.

Two inactive evidence worktrees were narrowed to their tracked CLI files to reclaim
space, preserving their branches, untracked golden files and private evidence. The
validation runner's two-GiB free-space guard remains unchanged.
