# Owner commands outside the daemon core

## Design

The paired owner's `route_task` and `route_send` requests currently load `lib/ownerCommands.ts` in core and call
two feature-specific device port members. Move validation, admission and dispatch into the existing devices process.
The existing service-route adapter serves both local window frames and authenticated RPC frames, from declarations;
the backend's ordinary service router remains the only dispatch path. No command names enter the adapter.

- **Growth:** no stored data. The devices retain at most eight active owner commands, at most two for one connection,
  until the underlying operation actually settles. Task text remains trimmed and bounded to 16,000 characters and
  agent ids to 160. A disconnected request does not release its slot while its work continues. Core keeps only its
  existing bounded service requests and deadlines. No new cache, timer loop, process or runtime dependency.
- **Concurrency:** owner admission is synchronous in the devices process. Requests never join the backend's ordered
  frame queue, so a pending classifier cannot delay typing. A send checks the connection signal before its synchronous
  fleet dispatch; dispatch already accepted is not undone. Classification is read-only and retains admission until
  settlement even when its result times out or its connection closes.
- **Read cost:** use the fleet's existing on-demand view refresh and indexed routing. No new scan or polling.
- **Scale:** retain eight total/two per-connection admission and the existing 25-second classification/five-second send
  waits. The existing service link bounds startup separately. Named `BUSY` and unavailable replies are the first
  saturation signals. Benchmark the existing remote and local WebSocket paths, including unrelated terminal traffic,
  against the frozen baseline on the same toolchain before acceptance; line counts are not runtime evidence.
- **Compatibility:** public request/result types, correlation ids, success objects and validation errors are unchanged.
  Local windows keep `route_result` and their historical empty-task and empty-send replies; RPC keeps
  `route_task_result`, strict validation and `INVALID_REQUEST`, `BUSY`, `COMMAND_UNAVAILABLE`. Only genuine transport
  unavailability, timeout or service-host failure maps to the old unrouted/unsent objects. The adapter carries the
  authenticated `Asker` identity unchanged for RPC, with transport-owned `rpcRoute` provenance; only the local window
  entry constructs a local owner. A raw `devices_ws` request remains local-only, even with a forged payload marker.
  The service process copies provenance only from the trusted core envelope, never the request body. Existing private
  `routeTask`/`routeSend` service handlers remain as adapters for an older core until 2026-12-16. They live solely in
  the devices service as direct closures preserving whole success/failure objects, with no core port or inline feature
  fallback. Backend deployment is N/A because its protocol
  is unchanged; last-30-day clients keep their current wire contracts.
- **Migration and rollback:** no disk format or migration. Revert restores the old core handler. An old core reconnecting
  to the new devices service uses the dated private aliases. Normal update re-execution stops services before the new
  core starts (`harnessd/reexec.ts`). If that master cannot re-execute or its unproven-reexecution limit keeps it,
  an already-running older devices process cannot understand RPC provenance: remote commands return `LOCAL_ONLY`
  until a full daemon stop/start loads matching services. Local window commands continue. This limited internal
  skew is accepted for the optional feature; it is not full live-service compatibility. Desktop ends its routing
  spinner on the empty answer and refuses a send without `ok: true`; the TUI likewise reports no route, never success.
  A missing or failed service answers unavailable and is never replaced by feature execution inside core.
- **Audience:** the gateway retains sealed-session and guest checks. The declaration admits owner RPC only; `owner=false`
  or any guest is refused before a service may be woken. The devices recheck owner authority and trust no payload field
  as identity. The local-only spoken-task reply remains local-only.
- **Identity:** no new login or credential access. The existing fleet dispatches under the machine/account boundaries it
  already enforces. Route text and errors containing private material never enter logs; only a fixed failure name does.
- **Failure:** absent, disabled, hung and crashed devices preserve the old visible unavailable object. Handler failures
  preserve `COMMAND_UNAVAILABLE`. Existing connection-closed signals revoke requests held for service startup; no
  second cancellation channel or ineffective abort-controller collection. A timed-out classification may finish but
  cannot become a send, and its late answer cannot answer twice. Failed dispatch is never automatically replayed.
- **Platforms:** TypeScript paths affect macOS, Linux and Windows and every paired client; no process-launch change or
  UI change. Native acceptance uses an isolated macOS daemon and fake relay/engines. Linux unit execution is automatic
  PR CI. Native Windows execution is unverified, not implied by either.

## Validation plan

1. Record old owner-command output goldens before moving code. Add caller-visible failing tests for declared RPC
   forwarding, owner/guest rejection before lazy start, service-side validation/admission and connection cancellation.
2. Run affected adapter, backend, devices, process and architecture tests and TypeScript with one focused worker.
   Check actual settlement retains slots, late results cannot answer twice, and unrelated frames proceed.
3. Freeze for independent root review before broad gates or timing. Run the checked-in local validator at the reviewed
   final commit, including 100% per-file core/services coverage, plus required affected gates it selects.
4. Retained bundled native acceptance: sealed paired owner route/send, local-window compatibility, device rejection,
   device process failure without core restart, and same-client terminal input while classification is held.
5. Coordinate a quiet, fixed-order performance comparison with root; record source/bundle hashes and raw results.

Initial baseline: `db2d74421b686784b89b93e6fa5c3968a04f7a1c`. Retained native comparison uses
`706a43ad1d9a65014268c1847ccc488f4cf133b2`, whose production is unchanged and whose test environment isolates tmux.

## Shared transport bound, reviewed before implementation

Inspection found `serviceLinks` limits only requests queued for a restarting service: first startup and a connected
but hung service can retain unlimited requests. Moving admission into a service must not expose unbounded buffering
in core. Apply the existing 100-request bound per service to every outstanding transport request, including first
startup, restart and connected waits. Track the count beside the existing pending map, so admission is constant time
and does not scan another service's work. Overflow takes the existing unavailable path; a successful answer, timeout,
connection close or failed send releases the transport slot. This is a transport bound for every optional service,
not proof that a timed-out operation has stopped. The device service's eight/two admission separately remains held
until actual work settles. No new queue, command-specific core state or wire error is introduced.

This exposes a real timing difference while the devices start: previously a third owner command on one connection
received `BUSY` immediately in core. Now at most 100 service requests wait in the shared transport, and owner admission
is applied when devices receives them. The third command may get `BUSY` then; if earlier operations already settled
between deliveries, it may run sequentially instead. Preserving queue-residence admission would retain feature logic
in core or add another feature queue outside it. Root accepted this admission-timing change on 2026-11-16 because
`BUSY` is transient capacity feedback, not a guarantee that a particular burst must fail; no performance exception is
implied. The real adapter and device handler are tested together with three requests queued before service startup;
successful wire replies, eight/two concurrent execution, and actual-settlement bounds are unchanged. A disconnected
request queued for startup is never delivered. Bounds and cancellation apply to both callers of the shared adapter.


## Quiet performance result (2026-11-16)

Root measured retained production `8c568225c1f1b3c2cc7c7cccb77f4cd140334773` against
`706a43ad1d9a65014268c1847ccc488f4cf133b2`, Node 24.22.2/macOS. Both private fixture worlds stayed resident.
Six fixed pairs (BA, AB, BA, AB, BA, AB) each used 20 warmups and 500 requests/workload. All 36 samples passed;
raw latencies and separate core/devices CPU are retained. CPU accounting resolves 10 ms per process, not sub-ms
individual requests. These are medians across the six run summaries, not a statistical equivalence claim.

| Workload | Core CPU/request, before → after | Core + devices CPU/request | Request p95, before → after |
| --- | --- | --- | --- |
| Valid route task | 400 → 370 µs | 590 → 570 µs | 0.962 → 0.919 ms |
| Empty-send validation refusal | 50 → 100 µs | 50 → 140 µs | 0.415 → 0.465 ms |
| Ordinary agent list | 210 → 190 µs | 210 → 190 µs | 0.664 → 0.620 ms |

Rejection now crosses the optional worker boundary. Its measured +50 µs core CPU/request, +90 µs combined CPU/request
and +0.051 ms p95 are a real cost; the no-slowdown requirement is not met on that path. No exception is accepted yet.
Do not move validation back into core to hide the isolation cost. Valid routing and ordinary lists used less core CPU.
The fixed P2P typing comparison (ABBA, 60 keys per phase/run) passed all four runs with no channel errors: median run
p95 was 3.8 → 3.5 ms idle and 5.0 → 5.0 ms beside another pane's keyframe. No samples were discarded or adaptively retried.

The first routing attempt failed during warmup, before any timed sample: its fixture assumed an unknown agent was
refused, whereas the existing FleetRouter defaults it to local admission and returns `ok:true`. The corrected fixture
uses an explicit empty-text refusal on both builds and asserts `INVALID_REQUEST`; no product behavior or threshold was
changed. Both failed and corrected reports are retained. The checked-in opt-in rig now contains the corrected workload,
fixed pairing order, separate worker CPU accounting, and partial-result/cleanup reporting used by the measured rig.

Evidence: `/tmp/core-owner-commands-benchmark-manifest-v1.json` and `-v2.json`,
`/tmp/core-owner-commands-bench.json` (failed warmup), `-v2.json` (all raw results), `-summary.json`,
`/tmp/core-owner-commands-typing-{1-A,2-B,3-B,4-A}.json` and `-typing-summary.json`.
Candidate bundle SHA-256: `f76797193f5645add0809e3bfd5758f1350ed91626bac20cd4ccaff2963c523a`;
baseline: `516860c07f9349ab1df86f76ae3ec8dea6efc31734613a36bbf178c2226f8880`.
The later main integration only brings the reviewed resume fixture isolation; production comparison remains unchanged.
