# Native Change agent handoff authority

This change addresses the handoff consumer in the daemon-core completion checklist.
History reading, normalization, redaction, rendering and git commands remain in the
edge service. The core owns bounded publication steps, including current session
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

## Async publication review and validation

Publication now yields between durable steps and keeps token-owned locks over the
physical project, receipt and shared Git exclusion until completion. Every resumed
step obtains fresh session, native, request, receipt and destination evidence. Stop
and readiness never join these locks. A separate cheap request check immediately
before each link/rename and successful completion catches deadlines crossed during
synchronous reads or fsyncs.

The third independent implementation review found three concrete recovery gaps,
now covered by regressions: a peer replacing a staged exclusion, expiry during guard
fsyncs, and an interrupted nonempty Git snapshot retried after history becomes empty.
Before any output is staged, a fresh preparation can update only its exclusion
baseline, preserving the current user contents and the original redacted snapshot.
Old private stages are retained. Completed or output-staged transactions continue
to reject changed public files. A retained nonempty snapshot derives its exclusion
even when the fresh candidate itself has no documents.

At 12:35–12:36 UTC, 158 focused cases passed; both new core modules reached 100%
statements, branches, functions and lines. These are exploratory results, not the
full component gate. Five additional Desktop cases passed: a delayed handoff never
closes a source whose creation, session, engine, project or existence changed.
The earlier client failures were resolved: sixteen TUI switch and two TUI handoff
cases passed, including a genuine connection-generation change at fixture port zero;
the forty Desktop reply cases passed separately after the documented pre-test VM
loader failure. The original seventy Desktop switch cases had passed. Analysis
identified an existing unused test import and one new bracing advisory; both are
removed, while unrelated existing advisories remain outside this change.

The two responsiveness regressions passed with their original 2-second/5-second
request limits and 1-second maximum callback delay. The cost workload additionally
waits for a timer after completion so the final synchronous stage cannot escape
measurement. The golden artifact remains unchanged. Private handoff e2e now checks
both engines holding an unreadable native header without publication and recovering
the same request before continuing their conversation.

The draft automatic run's process checks passed. Its `ci/required` rejection is the
planner's deliberate draft-PR guard: component validation starts at ready-for-review.
No manual run or rerun was requested. Final full gates, mutations, matched cost,
exact-head review and ready-PR checks remain required before merging #1145.

## Matched runtime cost

The [raw samples](2026-10-10-native-handoff-cost.json) compare the former runtime
`a61cba5bc967cbfd8e888995987cc42cbf6556ee` with the candidate runtime based on
`90b5049c6e68705bee8d1fe7a5d7bd103f08b11d`; the file records the exact runtime-diff
SHA-256. At 12:43:24–12:43:41 UTC, eighteen fresh processes ran three interleaved
samples per revision/workload, three measured operations per sample. Each used the
same 45,151-byte, twenty-turn native transcript, private homes, pinned Linux evidence
semantics and Node 22.23.2 on the same macOS x64 host. Host binaries were replaced
with fixture responses. Each project was outside Git: these measurements do not
exercise Git commands or the exclusion stage. The separate real-Git wire
responsiveness checks and private e2e cover those paths. All 54 measured operations
confirmed the selected history.

| Workload | Former mean latency | Candidate mean latency | Candidate maximum callback delay | Former/candidate CPU per operation | Former/candidate peak RSS |
|---|---:|---:|---:|---:|---:|
| Own conversation | 10.54 ms | 502.45 ms | 275.08 ms | 16.07 / 115.43 ms | 96.68 / 116.64 MiB |
| Fork ancestor | 11.54 ms | 495.80 ms | 189.67 ms | 17.06 / 136.19 ms | 100.21 / 118.16 MiB |
| Same-intent retry | 1.44 ms | 44.22 ms | 110.73 ms | 2.11 / 34.68 ms | 99.09 / 118.61 MiB |

Current identity checks and durable reservations add about half a second to a new
handoff in this workload; a verified retry adds about 43 ms. This is a measured cost,
not a speed improvement. The request remains within its existing five-second
budget, and the longest measured callback remains below the existing one-second
responsiveness assertion. These samples cover explicit handoffs, not startup,
turn throughput or all possible filesystems. Synchronous filesystem calls have
practical bounded reads and revalidation, but cannot cancel a stuck kernel call.
No numerical gate was relaxed.

## Final fixture and client review

The full local core gate passed 2,310 tests with 100% statements, branches,
functions and lines; harnessd passed 265 tests with its one existing skip and
100% coverage. All fifteen deliberately broken handoff wirings failed behavioral
assertions after their unchanged baselines passed. The affected gate initially
passed 463 cases and failed five. Two socket expectations predated typed held
replies, the concurrency-limit fixture unintentionally shared one physical project,
and one test put three durable handoffs inside Vitest's single five-second limit.
The three fork states now have separate cases; production deadlines are unchanged.
The remaining expectation conflated a conclusively older process incarnation with
a current process record naming the wrong folder. The former is ignored; the latter
holds. The corrected three files passed all 195 cases.

Independent review also found that TUI handoff callbacks compared session and
creation identity but omitted the source engine and project. Those fields now fence
the picker, delayed replies and held-intent reuse. Explicitly reopening Change
agent discards a stale preparation only before Close was sent, allowing a fresh
request ID. An uncertain Close or create keeps its original receipt. Regression
cases cover late replies, held retries, stale pickers and uncertain operations.
The final isolated TUI run passed nineteen switch and two handoff cases; independent
review approved the correction at `562a5630ab9eb6be0b6cf62de1f2b728938b590e`
against `cb242cf4c7d21b7b7cd95ac727fedb30317e9878`, conditional on the remaining
required validation and automatic CI. Review ran no tests and made no edits.

Touched Desktop analysis passed without warnings or errors; eleven preexisting
bracing advisories in the larger state file remain. The invalid initial analyzer
option exited before analysis and was rerun with supported arguments. The worktree
was narrowed to relevant tracked components to recover space; branches, edits and
private evidence remain intact, and the two-GiB validation guard is unchanged.

At 13:02–13:08 UTC the final CLI receipt passed typecheck, all 2,310 core
cases at 100% coverage, all 265 harnessd cases (one existing skip) at 100%,
and all 470 affected cases across sixteen files. The affected set includes
architecture, lean-entry, real Git/wire responsiveness, both unchanged native
goldens, descriptor evidence and transcript readers. The source was frozen at
`4eea2be7dcceac7e978123170f54676cd2c56209` throughout. The offered prior receipt
was not reused because its declared CLI scope included the corrected test files.

The following private e2e plan did not start: free space fell to 1.59 GiB and then
continued falling. Its two-GiB guard rejected the run before tests. The existing
GitHub e2e workflow will supply the remaining acceptance evidence; no local guard
is weakened and no unrelated data is removed. See the
[takeover note](2026-10-10-daemon-core-takeover.md) and #1145 for final check/merge
state. The owner requested finishing this PR and handing off, with no new item started.
