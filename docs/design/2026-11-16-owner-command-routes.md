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
  authenticated `Asker` unchanged for RPC; only the local window entry constructs a local owner. Existing private
  `routeTask`/`routeSend` service handlers remain as adapters for an older core until 2026-12-16. They live solely in
  the devices service, with no core port or inline feature fallback. Backend deployment is N/A because its protocol
  is unchanged; last-30-day clients keep their current wire contracts.
- **Migration and rollback:** no disk format or migration. Revert restores the old core handler. An old core reconnecting
  to the new devices service uses the dated private aliases. New core and service are one installed build; a missing or
  failed service answers unavailable and is never replaced by feature execution inside core.
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

Baseline: `db2d74421b686784b89b93e6fa5c3968a04f7a1c`. Implementation and evidence are pending.
