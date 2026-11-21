# Package 12: Wi-Fi input and relay ownership

## Dependent compatibility cutover design (2026-11-18)

Status (2026-11-18): the coordinator accepted the private compatibility integration gate after
independent source review and packaged macOS startup/fallback/restart checks, an actual historical
parent refusing a modern child before effects, and a retained modern master changing new → old → new
builds after reaping the old core and workers. The historical transition uses a manually selected
canonical build and an exec-unavailable shim; it does not prove native updater decisions, a canonical
master-load race, Linux or Windows. The seven-case packaged suite has six passes and one real failure:
master RSS is 155.46 MiB against the unchanged 100 MiB ceiling. That failure, final combined validation,
cost acceptance and platform evidence still block publication. Cleanup passed for all nine instances.
This cutover and worker admission must ship together. No admission-only release has been published;
if that changes, the executed private worker contract must advance before this cutover.
The freshness owner confirms `WORKER_CONTRACT=1` represents that combined unpublished release.

The shared-input comparison still sends each correlated operation's generic facts and obsolete
private notices. New workers discard the latter: per 2,000 inputs, 6,000 input-status notices,
2,000 dispatch notices and 2,000 each legacy turn-start/turn-end notices. Remove that translation
only when the master positively admits one immutable cohort: probe and current core/services all
execute its snapshot; startup, upgrade and rollback reap old peers; child entry guards reject an
unsupported retained parent before effects. A retained legacy cohort runs its verified historical
lean core with inline historical features and its master-owned immutable historical updater.

That positive admission replaces the earlier elapsed-30-day removal condition for this private
core/worker link. Public device v1, clients from the last 30 days and durable receipt journals keep
their contracts. Full-product rollback selects the matching historical cohort, not an old worker
beside this core. Unresolved receipts stay unknown and are never replayed.

Core removes the legacy input mode/phase translator, duplicate lifecycle interpretation and obsolete
submit/cancel/started adapters. It keeps the existing synchronous transcript-watch arming and dispatch
count before the generic input fact. A nonlegacy forced `turnEnded` remains. The worker requires the
shared input contract and preserves original-connection, captured-binding and current-reservation
checks around resolve, context, submit and cancel. Generic delivery outcomes and inline onInput/
onDelivery subscriptions remain. The component's internal receipt methods still interpret generic
facts; removing an obsolete private port does not remove those methods.

Design: this deletes transient notices, adapters and a core policy import; no new record, cache,
queue, timer or archive is added. Shared writer ownership, uncertainty and every effect fence remain.
Read cost keeps the same resolve/input queries and removes duplicate serialization. No public or
journal schema, migration, audience, identity or secret handling changes. Unsupported private
contracts fail visibly with the existing bounded wait; disconnect does not retry. This affects common
TypeScript on macOS, Linux and Windows; host-mocked checks do not prove native Windows behavior.

Selected checks: RED actual core/component bridge for one generic fact/batch, receipt completion and
watch arming before dispatch; retain binding mutation/revocation, adjacent Codex busy-turn batches,
forced end, unknown receipts, held-writer wakeups and inline single delivery. Run affected core/service
files at 100% per-file coverage, types and architecture. Native integration and cost require the
coordinator's reviewed frozen sources and quiet slot. The cost fixture needs an explicit version
adapter for each source's composition; disclose that fixture delta while preserving all nine workload
cases, counts, bounds and deadlines. Focused tests alone do not satisfy the compatibility gate;
the scoped integration evidence above is separate from final publication acceptance.

## Shared input cutover design (2026-11-17)

This records the earlier transitional design. The accepted dependent amendment above supersedes its
private compatibility policy in the combined integration; publication remains subject to its gates.

Ordinary messages, tracked whole turns and correlated composer input converge on the session input
operation. Scheduling is `composer` or `turn`; a delivery id asks for correlation, not a device-specific
writer. Its one waiting queue is bounded to eight items, 24 KiB and five minutes. This deliberately
tightens the old two-queue capacity. A cancelled held callback retains its capacity until consumed.
The existing connection's `ServiceQueryAuthority.current` fences validation, paste, Enter and events;
no authority comes from the payload or moves to a replacement connection.
The legacy `deliver` protocol keeps its existing service-held receipt notifications while its effects
use that same original authority. Versioned `input` receipts and input facts stay on their exact
connection; legacy callers do not receive new input-fact traffic.

The devices process retains its existing durable receipt entries, exact prompt hashes, bound sessions
and unique transcript evidence. It admits at most 64 live native inputs, including queued inputs and
unknown outcomes; a proven refusal or consumption releases that admission. This tightens the old
64-dispatched-plus-eight-queued capacity. Its 512-entry durable journal never drops unresolved work
to make room. Same-process core reconnect marks uncertainty and retains live admission slots. A
component restart creates a new server instance, retains old durable unknown receipts and never
replays them. No journal schema or on-disk migration is needed for the admission bound.

New workers probe the versioned shared input contract before effects. An explicit unsupported-query
answer selects an old-core adapter in the devices process; timeout or an ambiguous write never
authorizes a fallback write. Retained old workers use a stateless translation through the new shared
operation: no old queue, retry controller or prompt list survives in the new core. Those workers keep
their existing 512 durable reservation bound; the new component's 64-live bound cannot be imposed on
them without core feature state. Existing old-worker receipts stranded by a pre-cutover core loss
remain unreconciled, with no replay or invented refusal.

Compatibility removal is no earlier than 30 days after the first release carrying the new worker and
requires proof that all supported update/reconnect paths replace or safely translate old workers.
This is a removal condition, not a runtime expiry. The no-exec and unproven-limit `reexec` fallbacks
can keep old workers alive. Legacy `submit` must receive a delivery refusal event when refused:
old workers ignore an error in that query's reply.

The component reuses `CoreApi.conversations.resolve` for a single bounded agent read; handoff remains
its existing other consumer. It checks the returned agent/session against the dispatched input.
Device display modes and same-batch turn-boundary interpretation belong in the component. A core
turn event requests fresh fenced composer evidence; matching an old prompt body is not permission
to release the current writer. Relay/session/presence and transcript-subscription extraction remain
separate residual work.

Status (2026-11-17): root approved the shared operation and old/new worker cutover described above.
The implementation removes `core/deviceInput.ts`, its pending prompt map and its second queue. Actual
ordinary and tracked callers now use `SessionInputController.submitInput`. Focused caller, component,
receipt, and reconnect checks are recorded with this change. Full core coverage, native/platform
validation and before/after cost acceptance remain integration gates; package 12 is not complete.

The existing `input.forget` composition hooks send a stateless compatibility `agentGone` notification,
including binding changes. New components also consume the existing generic agent lifecycle catch-up;
no core receipt map is recreated. Lifecycle batch interpretation reaches the component before recap
publication, and the existing filtered stream follows the recap. Only batches with turn lifecycle
content get the additional interpretation message; original adjacency is preserved.

Design for this slice:

1. Growth: one current operation on the existing per-session input state, one aggregate bounded queue,
   and the existing observation timer. Device labels use weak references to its existing bounded receipt
   entries. There is no new persisted field, core feature table or second service queue.
2. Concurrency: a current session binding and the original connection fence every wait and effect.
   Correlated composer input retains the existing writer through an ambiguous effect until fresh evidence
   says clear. Personal input keeps its exact-draft recovery; ambiguous correlated composer input never retries Enter.
3. Read cost: a new worker probes once per connection and resolves one agent before dispatch. No new
   snapshot API or registry scan. Queue scans are bounded to eight; component receipt scans to 512.
4. Scale: integration must compare the same ordinary/tracked workload, idle memory/CPU, IPC traffic,
   and release of writer/queue state at 1, 16 and 160 agents. Focused tests prove bounds, not performance.
5. Compatibility: new worker/old core uses an adapter only after explicit `UNKNOWN_QUERY` on the probe.
   Old worker/new core receives translated refusal, dispatch, status and turn events. It keeps its own
   existing durable bound. Known lost pre-cutover receipt generations stay unknown and are never replayed.
6. Migration/rollback: journal schema is unchanged. Component restart changes the server instance and
   restores unresolved receipts as unknown. Core reconnect alone never resets native admission capacity.
7. Audience: authenticated service identity and `ServiceQueryAuthority` remain authoritative. An input
   payload cannot carry terminal coordinates, a lease, another connection's token or arbitrary options.

The sections below record the earlier prerequisite and the separately unfinished relay design.

## Earlier finding

`core/deviceInput.ts` is not just the device's delivery queue. Its `legacyWrite` lock is taken by the
window, phone and Agent Messages input paths in `core/input.ts`; its native-input acceptance check keeps
that lock after an ambiguous paste. Moving that object into the devices process would let a component
own session authority and leave pending writes uncontrolled when the link closes.

The existing generic `turns.deliver` is not a replacement for the device submit operation. In
`lib/sessionInput.ts`, a tracked delivery waits while a turn is open. The current Wi-Fi path deliberately
types a second Claude or Codex prompt before the current turn ends. The existing `deviceInput.spec.ts`
tests prove this distinction with the actual AutonomousDeviceService caller. Redirecting to the generic
delivery door would silently remove native queuing and Codex steering.

The device result journal already owns idempotency and exact transcript evidence in its process.
`AutonomousDeviceInput.pending`, however, retains another copy of as many as 64 prompt bodies per agent
for delivery status. Those records and the device's second eight-item, 24 KiB, five-minute queue are
feature state. They must not survive as a renamed device queue in core. The normal input controller
already has the same FIFO bounds; convergence should retain that one shared queue, not add another
copy in the devices process.

## Ownership at completion

Core retains:

- Session identity and launch fencing; terminal runtime validation, capture, paste and key operations.
- One shared input writer and ordering with normal messages, questions and controls. A component never
  receives a lease or supplies terminal coordinates.
- The current atomic input operation, its bounded composer check, and uncertainty after a possibly
  executed paste. A transport timeout is not proof that the effect did not happen.
- Generic input lifecycle events; no device receipt, device pending list, device mode labels or pairing
  records. The existing generic delivery path remains the only tracked-input route.
- Bounded subscriptions needed to avoid copying every transcript or tool event across a process link.

The devices process owns:

- The device's 64-pending receipt admission limit, display mode and phase, receipt persistence, prompt
  hashes and native transcript evidence. Input waits and expiry use the existing shared input queue;
  there is no second service queue for the same delivery. Device revocation requests cancellation of
  unstarted input through the generic input contract.
- Device session hello, presence, replay and held request policy. The gateway continues to own the
  authenticated transport session and seals only to its current identity.
- Native turn-boundary interpretation for device receipts, and all device-only event interpretation.

## Completed writer prerequisite

Before changing the cross-process submit contract, remove the shared writer's dependency on the
feature controller. Put the existing writer exclusion in `SessionInputController`, which already owns
normal input ordering and `acquireControl`; `core/input.ts` wires all actual terminal writers through
that owner. `AutonomousDeviceInput` then asks for a local atomic input reservation through a dependency
and retains no `writers` map or legacy-writer waiters. It does not gain a process-facing lease API.

This is preparation for extraction, not a subprocess move. It should merge only as an explicitly
identified dependency of the extraction, with the remaining row still open. It makes the next move
reviewable without relocating a lock and changing native receipt semantics simultaneously.

Proposed files for this slice:

- `lib/sessionInput.ts`: shared writer admission and release, integrated with the existing input state
  and control reservation rather than a new lock framework.
- `core/input.ts`: normal paste/key writers use the input owner's lock; device deps request a reservation.
- `core/deviceInput.ts`: remove `Writer`, `writers`, `writer` and `legacyWrite`; use the core-owned
  reservation. Keep queue/status behavior unchanged in this slice.
- Their existing specs and the package 12 evidence/audit note. No public protocol, persisted format,
  service request name or launch behavior changes in this slice.

The reservation must retain the old writer object while an in-flight operation settles, even after
`forget`, so forgetting/recreating the same agent cannot release an old write into a new launch. Release
is idempotent. Queued normal writers register before the next native device writer can reserve. A
normal operation already validating when reservation is requested must still prevent overlap.

## Shared operation questions resolved above

The shared native operation has two current consumers: the person's normal message path and the
Wi-Fi native path. Converge those implementations before exposing it through the existing generic
delivery door. Retain the existing default of waiting for the turn for Agent Messages and other
tracked deliveries. An explicit generic scheduling contract is needed for native input; a Wi-Fi-only
flag on `CoreApi` or a second private delivery route does not satisfy the boundary.

The earlier review identified these choices; the approved cutover above resolves them:

1. Use the existing bounded input queue, with the shared native operation as its writer. It already
   has the same item/byte/TTL bounds. Review scheduling and fairness across normal, after-turn and
   native inputs; do not add a second queue or preserve a device-only queue in core.
2. How a caller learns that an ambiguous composer is free without polling or a feature-specific
   readiness event. Session input authority, not the device journal, decides that it is safe to write.
3. How native personal messages preserve their current receipt and rapid-message behavior while using
   the same acceptance logic. Existing `injectLegacy` currently replaces its previous pending receipt;
   the device path instead keeps a bounded pending set. Renaming one implementation does not settle
   that semantic difference.
4. How disconnect cancels not-yet-dispatched effects and fences async continuations. The existing
   `wifi.submit` query only acknowledges queue admission and has no connection-owned cancellation.

This change removes the device queue, pending receipt list and `CoreApi.wifi` submit/cancel/started
doors after that review. The remaining compatibility translation is stateless and separately gated.

## Relay half

`core/wifi.ts` retains session/hello maps and 256 requests for 30 seconds because gateway and devices
only speak through core. Move those to the gateway/devices boundary with a direct authenticated local
link. The gateway already owns the authoritative session identity. It must check the destination again
at send time; a stale connection id must never deliver to a replacement identity.

The current core link remains a bounded fact/feed adapter: transcript watch counts prevent an older
acknowledgement from closing a newer prompt's watch; focus revision checks stop stale window choices.
Neither full transcript fan-out nor retaining a duplicate core session map is an acceptable shortcut.
The direct link requires its own reviewed protocol/skew/restart design and is not included in the first
writer slice.

## Earlier writer-prerequisite design (docs/feature-design-rules.md)

Reviewed revision: the writer prerequisite above, 2026-11-17. Reviewer: root agent. This table covers the first writer slice only; the
unresolved native-operation and relay contracts require a second review before their runtime changes.

1. Growth: one writer record per existing input state. It appears on first write/reservation; counters
   rise only for admitted writes; finish releases and drains existing bounded input work; forget removes
   the record after in-flight writes settle. No persistent record, new queue, timer or all-record reader.
   Forget/recreate keeps old queued work fenced to its old state. A replacement state shares exclusion
   with unfinished old writes until they settle; only that exclusion, not old queued work, is adopted.
2. Concurrency: the unit is the stable agent's pane. All `core/input.ts` paste/key paths take the shared
   writer. Native reservation also takes existing `acquireControl`, in the same order and synchronously.
   Questions/model controls retain their existing reservation checks. Release is idempotent and normal
   writers already waiting get the same priority as before. Async validation checks the captured state.
3. Read cost: no database or IPC read added. One state lookup on admission/release. No per-write scan
   across agents. Existing queue bounds remain the source of backpressure; assert no extra queued copy.
4. Scale: at 1, 16 and 160 synthetic agents, compare the same workload before/after. Count live writer
   records and pending operations after all writes settle/forget; they return to baseline. Record core
   idle CPU/RSS and input latency; do not infer an improvement from lines moved.
5. Compatibility: `core/input.ts`, deviceInput tests and direct callers of `legacyWrite` are the only
   changed internal readers (find all with `rg` before build). CoreApi, `wifiLink`, `wifiProcess`, device
   clients and the persisted result journal see no field/state/request change. Old/new process skew is
   unaffected. No compatibility wrapper or dead export stays behind.
6. Migration/rollback: no stored data or schema change, so no production restore is relevant. Rollback
   restores only internal lock wiring. Existing device receipts are unchanged. Stop/restart with pending
   effects retains the existing unknown/reconcile behavior; never replay ambiguous inputs automatically.
7. Audience: unchanged existing session lookup, launch validation, terminal backend lease and service
   allowlist. No content crosses a new boundary, gets persisted or is added to logs/metrics.
8. Identity: unchanged local authenticated caller and registered session; no new identity fallback or
   owner credential read. Missing session/runtime is refused as before.
9. Failure: operation rejection still rejects its caller; release runs in `finally`. Forget while a write
   is in flight must not release early. Cancel during validation must prevent a paste. Ambiguous paste
   continues to hold the native writer until existing proof clears it. Missing devices has no effect on
   normal input. No new retry/polling loop or detached promise.
10. Platforms: TypeScript change for macOS, Linux and Windows. No socket/path/native-host changes in
    this slice. Exercise existing real-tmux fixture on macOS/Linux and existing Windows terminal-host
    tests on Windows; do not claim Windows runtime validation from macOS mocks.

## RED cases and scheduled evidence

Use the actual `createInput` caller, not a new mock-only lock:

- Normal message starts validation; device prompt arrives; they never overlap at the actual terminal
  writer. Conversely, a held device paste blocks normal message/key input until the paste settles.
- Device A is ambiguous, B is queued, a normal message arrives: no paste or Enter for B/normal until
  A's existing acceptance evidence permits it; subsequent priority matches the existing path.
- A question/control is held, a device request is cancelled while validation waits, and the agent is
  forgotten/recreated: the old continuation never writes into the new launch.
- No device service or device input object is needed for the shared normal writer. Verify through
  the ordinary window `message` entry point with the actual `createInput` wiring.
- Existing AutonomousDeviceService-driven native A/B/C tests remain unchanged: B can be accepted before
  A's turn ends, duplicate request has one effect, identical prompt evidence stays ambiguous, expiry and
  8/24 KiB/64 bounds remain unchanged. These are regression evidence, not extraction completion.

Before runtime changes, add the dependency/ownership regression and observe RED on the base. After
implementation, run the focused input/device/funnel/question tests plus the required core/service
boundary/type checks selected by root. Run `wifiDevice.e2e.ts`, `devicesOnDemand.e2e.ts`,
`devicesProcess.e2e.ts` and `input-safety.e2e.ts` only in root's scheduled workload slot. These use the
isolated daemon/terminal fixtures; no owner daemon or homes.

For cost evidence, pin the same Node/build/config/fixture and workload on base and candidate: ordinary
message + question contention with devices disabled; then native A/B/C plus ambiguity/cancel/revoke
with the devices process enabled. Report core and whole-process-tree CPU, RSS, input p50/p95, IPC
frame/byte count and live state after teardown. Measure each side under the same isolated runs; no
parallel benchmark/test workloads. The first slice adds no IPC, so an IPC increase is a regression.

## Evidence so far

The actual `createInput` ordinary-window-message regression failed on the base as intended: no terminal
paste when the device controller supplies no writer. Command: pinned Node 24.22.2, `vitest run
src/core/input.spec.ts -t 'keeps the ordinary message writer independent of the device controller'
--maxWorkers=1 --reporter=verbose`; actual exit 1, one failed and 45 skipped, 558 ms. Output retained at
`/tmp/harness-wifi-writer-red-20261117.log`.

Focused GREEN: the same pinned Node, `vitest run src/core/input.spec.ts src/core/deviceInput.spec.ts
src/core/deviceInput.edges.spec.ts src/lib/sessionInput.spec.ts --maxWorkers=1 --reporter=verbose`,
actual exit 0, all 229 tests passed in 8.87 s. `tsc --noEmit` then exited 0. Logs:
`/tmp/harness-wifi-writer-green-20261117.log`, `/tmp/harness-wifi-writer-types-20261117.log`.
Broader gates, isolated e2e and cost evidence are still scheduled by root; none is claimed here.

Still pending for this prerequisite: the required full `npm run test:core` coverage gate, boundary
checks, isolated Wi-Fi/dial/input e2e, the fixed before/after writer diagnostic and platform runtime
validation. The focused tests/typecheck ran on macOS; they do not establish Linux or Windows runtime
behavior. No package 12 queue/relay extraction, release or shipping claim follows from this commit.
