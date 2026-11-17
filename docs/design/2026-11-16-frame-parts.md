# Agent frame parts

## Design

Browser and viewers currently expose separate `frameContext` ports and keep separate core-side maps. Replace those
two consumers together with one bounded frame-part publisher; the existing client fields and their ordering remain
unchanged. Stream routing and Browser wake behavior are separate work.

- Growth: only live agents retain parts. End/purge removes them; inline service failure clears its parts. A process
  disconnect keeps the last known display fields, matching today's behavior. Each part is at most 2 MiB of JSON,
  16,384 values, depth 8 and 32 top-level fields. All parts together are at most 4 MiB and 4096 service/agent entries.
  The former 16 KiB / 512-value cap could not carry existing Git histories; the measurements and bounded expansion
  are in [Git facts outside the core](2026-11-16-git-frame-facts.md). Arrays and nested objects still admit at most 512 members.
  Publication leases are bounded to 4096 live agents; refused updates have a named result and a content-free log.
- Concurrency: one synchronous core commit. `SERVICE_HOSTS` declares exclusive field ownership outside core policy.
  Services cannot publish reserved identity/authority fields or prototype keys. `follow({frames:true})` alone receives
  an ephemeral `frameEpoch` on its detached agent view; a per-core random nonce and monotonically increasing counter are never reused after end or a core restart.
  End invalidates that lease before notifying followers. The service publishes the view captured for its running
  lifecycle. Current-connection authority is checked after asynchronous query dispatch, before committing.
- Read cost: push changed parts only; no polling or I/O on projection. Validation copies bounded JSON once at publish.
  Frames read the cached merged part, after asynchronous projection, so an ended agent cannot regain an old part.
- Scale: explicit per-part, entry and total bounds above; reaching a bound reports `FRAME_PART_LIMIT`. Existing query
  and frame measurements cover the path; compare matched frame projection CPU/memory before acceptance.
- Compatibility: client keys remain byte-identical: `dsh` falls back to the registered value, four companion fields
  remain null when unknown, and `browser` remains absent when off. Current services use `frame_part`; an explicit
  `UNKNOWN_QUERY` alone allows their process-side `context`/`browser_state` adapters, removable 2026-12-18. New core
  requires a lease and does not accept old tokenless publication. Supported update paths restart services onto the
  matching build before the new core starts, as detailed below. Existing 30-day client contracts are unchanged.
- Migration/rollback: no disk schema or data migration. Process restart rebuilds projections from service state;
  rollback rebuilds them through the prior ports. No credentials enter a part.
- Audience: only an authenticated service connection or the scoped inline API can publish that service's declared
  fields. Existing agent/client authorization controls who receives the final frame.
- Identity: no new account or login. Leases identify an agent's current running lifecycle, not a person's identity.
- Failure: invalid, stale or over-limit publication is refused with a named result. Failure logs contain only a stable
  code. Service outage cannot block sessions or frame construction. Inline off revokes its publisher before cleanup.
- Platforms: TypeScript core path affects macOS/Linux/Windows; Browser remains unsupported on Windows. Focused coverage
  and byte goldens run on macOS here; parent owns broader core gates, native daemon and platform validation.

## Validation selected before implementation

### Projection allocation correction

The first frozen natural-GC comparison found a 4.24–8.25% CPU increase and
1.34–18.02% RSS increase at 32/512/2048 rows. All byte-parity checks passed; the
results are retained in `/tmp/core-frame-cost/result.json` and are not acceptance
clearance. A separate 200,000-frame Inspector profile attributes 53.8 MB of new
sampled allocations to `read`, principally its Map-entry iteration and per-read
predicate, and another 15.9 MB to projection/callback construction. Inspector
results are diagnostic only (`/tmp/core-frame-profile-v1/attribution.json`).

Replace each agent's part Map with one ordered array of its existing bounded
parts. Publication and removal preserve field order; projection visits that
array directly, without creating Map-entry pairs or a predicate closure.
Required-field, current-row, lifecycle and service-availability checks still
run on each read. This changes no authority, persisted data, client contract,
entry/byte limit or failure behavior, and adds no parallel cache. The public
reader test first measures the iterator allocation being removed, while
asserting both services' values and immediate removal when a required field or
service disappears. Run frame boundary/lease tests, wire goldens and per-file
coverage plus TypeScript before handing the result to independent review.
Final CPU/RSS comparison belongs to the parent after the corrected source is
frozen; no improvement is inferred from the allocation count alone.

The reader regression failed first with 100 iterators for 100 frames, then
passed with zero. The final narrow run passed 81 cases across frame parts,
lifecycle and frame goldens, with 100% statements, branches, functions and lines
in `core/frameParts.ts`; TypeScript passed. The earlier 80-case run passed
behavior but missed the absent-service clear branch, now covered with public
ordering assertions. A changed-source heap diagnostic over the same 200,000
frames reduced sampled allocation from 1,339,158,112 to 1,287,872,120 bytes
(3.83%); `read` no longer appears as a sampled allocator. Output length and final
frame digest match the original profile. This is an instrumented diagnostic,
not CPU/RSS acceptance. Logs: `/tmp/core-frame-projection-array-red.log`,
`/tmp/core-frame-projection-array-green-final.log` and
`/tmp/core-frame-projection-array-types-final.log`; diagnostic attribution:
`/tmp/core-frame-profile-v2/attribution.json`.

Independent acceptance reproduced 5,000 outstanding empty publications while only
one agent was live at a time. The byte bound alone allowed ended lifecycles to
retain too many pending query promises and deadlines. Bound the existing pending
map to 4096 entries as well; coalescing an existing entry remains allowed at the
limit, and completion frees capacity. A caller test drives lifecycle churn,
coalescing at the limit and recovery after completion before the runtime fix.
This changes no persisted data, client contract, authority or core state.
The caller regression failed with 4097 queries against the 4096 limit before the
guard, then all 84 publisher/Browser/Viewers process cases passed in 2.04 seconds,
with 100% per-file publisher coverage. Logs are
`/tmp/core-frame-publisher-count-red.log` and
`/tmp/core-frame-publisher-count-green.log`. Exact-head native acceptance also
found the custody fixture still using removed `context`; it now follows with
`frames:true` and publishes through the captured lease, preserving all credential
custody assertions. Its original failure is retained; corrected native evidence
is pending.

Independent review found that settled unchanged publications were still sent on
each Viewers observation. Core suppressed the redundant client frame, but still
paid for IPC, parsing and snapshot validation. The publisher will retain only a
SHA-256 digest of the last acknowledged projection in each existing bounded live
entry (at most 4096 digests), and skip an unchanged update when no write is in
flight. Failed replies do not become acknowledged state. Pending changes still
coalesce to the latest value, including a return to the last acknowledged value;
new lifecycle leases and reconnects must publish again. This adds no core state
or retained payload cache. Caller tests establish RED on unchanged repeated
observations and cover failure, reconnect and in-flight reversion before coding.

The three RED cases are preserved in `/tmp/core-frame-publisher-dedup-red-final.log`.
The correction passes all 83 publisher/Browser/Viewers process cases with 100%
per-file publisher coverage (2.03 seconds) and TypeScript. The intermediate
82-case run passed behavior but missed one coverage branch; a public old-fallback
acknowledgement test closes it. Broader exact-`70b1cdb4` coverage already passed
4,773 core, 371 harnessd and 1,069 portability cases; those receipts precede this
process-publisher-only correction and are not relabeled as a final-head full run.

Byte goldens through `agentFrame` and `BackendSocket` list/push projection, including no service, non-DSH, stopped,
Browser omitted and complete viewer/browser values. Generic boundary tests cover ownership, JSON bounds, detached
copies, total bounds, duplicate suppression, end→same-id restart, old connection, inline revocation and outage retention.
Affected service/link and lifecycle tests, per-file 100% core/service coverage, typecheck and exact import closure.
Parent coordinates native and performance runs so no timed workload overlaps other checks.

## Producer lifetimes

A lease is not copied onto an older pending result. Process publication captures the agent id and lease before
queuing; reconnect, end and purge invalidate pending authority, including the dated fallback. Browser rechecks its
existing container through its own generation fence when a new core supplies a new lease. Viewers keep their producers
across a lease replacement: a new core's lease is the same agent's, so its viewer stays up on its port and its URL is
published again under the new lease. Only `ended`, or another folder or harness, replaces a viewer. Viewer halt clears its old
child and URL before asynchronously closing the watch; queued old watch/verdict callbacks cannot touch the replacement.
Watch close has a 10-second bound and named failure. These are service-side lifetimes, not feature records in core.

## Supported update handover

The compatibility decision in `2026-11-15-core-plan/browser.md` (PR1, lines 130–135) applies here: masters from
2026-10-05 onward stop and reap services before updating, covering the 30-day window. `harnessd/master.ts` wires
`createReexec.stopChildren` to `ServiceSupervisor.stop`; `harnessd/reexec.ts` stops those children before its probe,
exec or Windows handover. Every failed-probe/exec/marker `carryOn` restarts children; master `script()` and
`leanServices.scriptFor()` then select the installed build. The core never accepts tokenless frame publication.

Existing tests cover this contract: `harnessd/reexec.spec.ts` “stops its children, probes the bundle…” and “carries on
as itself when the probe fails or the exec does, with its children back”; its Windows handover cases require children
stopped before handover; `harnessd/master.spec.ts` covers failed exec continuing with a core from the new bundle.
Supported macOS/Linux installations run Node 24 with exec, and Windows uses handover. An unsupported master with neither
exec nor handover, or a repeated-unproven-bundle escape path, can retain an old service and is not covered by this
rollover guarantee. No unsafe tokenless adapter is added for those configurations.

## Validation evidence

Golden JSON was captured from the base before runtime edits: five passing fixtures for absent services, registered
DSH before service start, complete Viewers and Browser data, Browser failure and stopped frames. Switching those
fixtures to the new seam first produced two expected failures, then all five passed after implementation. Public
regressions also failed first for stale viewer halt/verdict callbacks, purge lease invalidation, mutable queued
publication identity, Browser work across core restart, and fallback after end.

On macOS, pinned Node 24.22.2:

- Full selected run: 682 passing tests across 24 files, including exact import closure and all affected service suites.
- Final gap closure: 47 passing tests for `frameParts` and `serviceLinks`, each 100% statements, branches, functions and
  lines. Combined with the full run, all 15 touched runtime files under core/services/harnessd meet per-file 100%.
- Public request/push frame parity and existing re-exec ordering/failure tests: 3 passing selected tests.
- Typecheck and `git diff --check`: clean. DSH viewer/verdict source lifetime tests pass, including a held watch close,
  its deadline, a superseded start, and an old queued verdict callback.

Receipts are `/tmp/core-frame-parts-coverage-fourth.log`, `/tmp/core-frame-parts-core-final.log`,
`/tmp/core-frame-parts-public-final.log` and `/tmp/core-frame-parts-types-accepted.log`; coverage JSON is retained in
`/tmp/core-frame-parts-coverage` and `/tmp/core-frame-parts-core-final`. The evidence manifest records source hashes and
commands. The full run's only gaps were the two files covered at 100% by the final gap-closure run; no threshold was
lowered. Review's hidden `toJSON` regression failed before the detached serializer and passed afterwards, along with
Viewers renewal and nonblocking viewer replacement.

Parent owns broader gates, real daemon flows, supported-platform checks and matched performance comparison; none is
claimed complete by this task. Stream relay and generic Browser wake remain the separately planned extraction. The
Viewers process still uses its existing dated catch-up adapter; consolidation onto `followLink` is not bundled with
this frame-parts change.

The final combined frame/Git acceptance is recorded in
[Git facts outside the core](2026-11-16-git-frame-facts.md#final-combined-acceptance-16-november).
It includes the required broader gates, native failure/ownership proofs and both
micro and native before/after costs. Earlier standalone frame-parts regressions
remain failed comparisons; the accepted implementation includes its Git producer.
