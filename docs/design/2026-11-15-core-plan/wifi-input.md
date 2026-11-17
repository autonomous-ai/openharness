# Package 12: Wi-Fi input and relay ownership

Status: the root agent reviewed and approved only the shared-writer prerequisite, 2026-11-17, against
`18360932870c66673a3bceaa5a4a9ba3ef0fc129`. The focused tests and typecheck pass; broader validation
and before/after cost evidence are pending.
Package 12 is not complete. No native-input or relay protocol change is approved by this review.

## Finding

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

## Smallest safe first slice

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

## Required next slice: one input operation, then queue removal

The shared native operation has two current consumers: the person's normal message path and the
Wi-Fi native path. Converge those implementations before exposing it through the existing generic
delivery door. Retain the existing default of waiting for the turn for Agent Messages and other
tracked deliveries. An explicit generic scheduling contract is needed for native input; a Wi-Fi-only
flag on `CoreApi` or a second private delivery route does not satisfy the boundary.

That contract needs design review of these unresolved choices before implementation:

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

Only after these are resolved should the device queue, pending receipt list and `CoreApi.wifi`
submit/cancel/started doors be removed. Do not count this design or the writer slice as that removal.

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

## Design (docs/feature-design-rules.md)

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
