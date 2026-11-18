# Desk gestures between cohosted device components

The default devices worker already hosts both devices and Wi-Fi. A Wi-Fi step
previously left that worker, entered the core, and returned to its devices
component before focusing a window. A scroll made the same round trip. The
components now share one private endpoint for those two operations. The core
gains no query, record, bus or callback.

## Design

`services/deviceDesk.ts` publishes at most one endpoint in a worker, with its
resolved data directory, verified machine and current devices connection owner.
Only the matching Wi-Fi component may select it. Disconnect, stop and machine
replacement revoke it; a stale revoker cannot remove a replacement. Nothing is
persisted or sent over another socket. Payloads and identifiers are not logged.

The devices adapter clones each core connection and assigns a generation. Its
cached view and outstanding refresh belong to that generation. Disconnect clears
the view before notifying the component; a new generation starts its own refresh
and cannot accept an older answer. Publication requires the view's machine and
this process's computer to agree. A same-generation list refresh preserves the
endpoint, so a step does not revoke itself by reading its desk.

A direct step carries the Wi-Fi service epoch, its verified adapter binding and
the devices publication owner through the asynchronous list. `CableHost` checks
the predicate immediately before its synchronous focus, covering both the
window notice and an outside app's `markSeen`. Scroll checks both owners and
their current window views before its synchronous notice. A stale completion
does not confirm a result, retry it or dispatch through another route.

The endpoint preserves the existing named `devices.stepFocus` and
`devices.scroll` fault boundaries. Steps have a five-second deadline, matching
the existing devices-link deadline. A shared `DeviceWorkBudget` admits at most
100 retained calls and 16 MiB across endpoint generations. Logical expiry
invalidates the effect predicate; capacity is released only when the actual
list settles. Fixed logs identify `DESK_TIMEOUT`, `DESK_BACKPRESSURE` and
`DESK_FAILED`. Scroll retains the existing accepted-notice result, which does
not claim a confirmed UI mutation.

## Compatibility and limits

Explicit inline composition uses its existing guarded `ports.devices`. Its
Wi-Fi lifetime fence withdraws late results and the devices stop fence prevents
late focus after devices shutdown. The shared public port has no caller-lifetime
callback; it does not acquire the direct endpoint's cross-component effect fence.

If no matching cohost endpoint exists before dispatch, an explicitly mixed
service layout or older composition uses the existing core route once. A failed
or expired direct call never falls back. These compatibility doors still exist
in the core. This change does not claim removal of exclusive workspace
admission, confirmed cancellation, first-window focus/reveal or the duplicate
agent projection. Those require their own semantics-preserving extraction.

## Validation

Behavior tests first reproduced stale devices views across a reused connection
facade, the core round trip despite an available cohost, a late host focus after
caller departure, and a late Wi-Fi confirmation. Controls cover current direct
calls, inline and mixed composition, wrong-machine selection, window loss,
outside-agent seen state, named faults, timeout without replay, and capacity
retained across generation changes. Selected core/service files require 100%
coverage; CableHost behavior, architecture and types are checked alongside them.
The integration owner coordinates packaged/native and runtime-cost evidence on
macOS. Windows validation is deferred by the user; mobile is outside this work.
