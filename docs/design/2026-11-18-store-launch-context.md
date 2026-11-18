# Store-owned launch context

## Design

Core Create still recognizes the Model Manager by package id, starts Grid setup, waits eight seconds,
and selects the account name. This policy belongs to Store and models. Moving it into materialization
would remove the current authority check between the account read and workspace writes, so keep the
existing phases and make the context read a bounded Store contribution.

Add `dshContext` to the existing Store port, beside description, materialization and launch. Create
asks it only after native/package/backend/Grid admission has succeeded, in the same place it currently
starts setup. Store resolves the installed package and owns the Model Manager id check. Core validates
the returned account shape, rechecks the original Create authority, and passes that same detached
account into materialization and launch. Store unavailability holds this launch. No installed index,
model catalogue, package policy or feature-state cache is added to core.

Models exposes an additive owner-only `grid_launch_context` request on the existing service router.
It accepts only the setup boolean. Setup uses the existing shared Grid access queue and eight-second
bounded wait; it continues in models if that wait expires. The request then reads the backend-first
private Grid name through models' existing implementation, without listing models or pushing picker
events. Store first uses the existing non-secret account-name read for ordinary packages, so a known backend
name does not start Models. After Model Manager setup, Models reads the current name; if Models is
unavailable, Store retains the backend name and only falls back to null when that read has no name,
with a fixed diagnostic. No caller-supplied Grid name is accepted. Ordinary packages never trigger setup.

Store reaches this route as the local owner's tool through the authenticated socket/named pipe. Reuse
the existing confirmed-cancel one-shot transport for this second real caller: exact machine/protocol
handshake, exact reply type/id, bounded reply, one deadline across connect/handshake/reply, no retry,
abort/current-connection checks, and capacity retained until physical socket close. Cancel's existing
15-second behavior and diagnostics remain unchanged. Context needs the existing eight-second setup
plus two-minute name lookup allowance; its deadline is finite. Share the transport, not either
feature's policy or budget. Each component owns its already bounded admission; no new core queue.

The Store process obtains the daemon address through the existing shared `daemon` query and binds the
read to its current physical core connection. Disconnect/stop abort pending context sockets. Explicit
inline composition uses the same component request/transport and releases its own pending operations
when stopped; inline composition also closes its settings watch. Neither mode silently falls back to loading models implementation in core. The unused
private Models `ensure` port, core Create callback and Model Manager id import are removed together.

- Growth: no new persisted data or history. Pending local requests are bounded by the existing service
  request ceiling (100 across Store lifetimes in a process), with capacity held through actual close. Context replies fit 32 KiB and names fit the existing 4 KiB
  launch-text limit; no transcript, credential, catalogue or arbitrary request payload crosses here.
- Concurrency: Grid access retains its existing serialized setup; Store preparations retain their
  existing workspace lock. Core's original authority check still precedes workspace effects after the
  new context await. There is no second preparation or setup queue.
- Read cost/scale: one selected package lookup and one account-name read, no model enumeration. Measure
  the same package-create path before/after, including IPC and failure paths, before acceptance.
- Compatibility: public request is additive and owner-checked. Private Store changes travel with the
  final admitted worker cohort; explicit inline/older-master composition uses that same build. No
  published public request is removed. Runtime implementation and its obsolete private call are replaced
  in the same change.
- Migration/rollback: no disk schema change. Existing materialization receipts still include the
  exact selected account as input; the new context phase does not write a receipt. Rollback retains
  the previous admitted bundle and identical durable preparation format.
- Audience/identity: existing local owner authentication and current machine binding; no borrowed
  token, provider login or remote machine selection. A non-owner request performs no setup or read.
- Failure: Store loss refuses package preparation; models loss retains the historical null-account
  behavior when the backend also has no name, and a fixed diagnostic. Setup timeout is reported by the component and continues only in
  its existing setup queue. Unknown/replaced connections cannot supply context for workspace effects.
- Platforms: TypeScript and existing local transport on macOS/Linux/Windows. No new process launch.
  Native Windows execution is deferred by the owner; mobile is out of scope.

## Validation plan

RED first through Create, Store and models callers: selected package setup precedes account read and
materialization; ordinary packages do not set up Grid; refused/stale Create never writes a workspace;
Store/models outage and setup timeout retain their named outcomes; the chosen account is the one
validated for launch. Cover owner refusal, malformed fields/oversize, physical connection replacement,
late connect/reply, exact reply correlation, queue exhaustion and credit held until close.

Run affected source/architecture tests and per-file coverage, then native packaged Create with Store
and models stopped/hung/restarted, plus the matched package-create workload. Preserve existing
confirmed-cancel source/native tests because its transport is shared. This document is the intended
boundary; implementation and acceptance remain unfinished.

## Source checkpoint, 18 November

The intended boundary is implemented in this isolated branch. The original three REDs were observed
through actual Create, Store and Models callers (`/tmp/core-store-context-red-20261118.log`): revoked
context authority, missing Store context, and missing Models request. The old private Models `ensure`
port and core setup/name callbacks are removed. Existing public clients keep their old requests.

- First complete selected caller pass: 385 tests in 12 files plus types, receipt
  `20261118T140030.592064Z-38323`.
- The next selected boundary/architecture run passed all 471 tests in 16 files. All 12 explicitly
  included runtime files reached 100% statements, branches, functions and lines. The overall receipt
  `20261118T140654.601703Z-49966` failed only on two test-port type errors; both were corrected, and
  their affected fixtures plus the full typecheck passed in `20261118T140824.428671Z-62133`. This is
  combined evidence, not one uninterrupted green run.
- Follow-up lifecycle RED `20261118T141611.223854Z-74596` observed an inline settings watch still open
  after Store stop. The same packet's 100 concurrent requests sharing one lifetime was a passing
  capacity control. The watch now closes with that lifetime; no listener-limit override was needed.
- The shared one-shot preserves all 36 confirmed-cancel regressions. Store cases cover exact
  correlation/machine binding, bounded account/reply, timeout, late connect, component replacement,
  abort, process capacity retained until physical close, and no workspace effects from stale context.
- Added packaged `storeProcess.e2e.ts` cases cover ordinary package context/init in supervised and
  explicit inline modes, plus a hung Models worker while an unrelated agent continues and package
  init completes once. These fixtures are prepared, not executed against a final artifact yet.

Final source receipt `20261118T141854.144433Z-76943` passes 482 tests in 18 files, all twelve included
runtime files at 100% in all four coverage metrics, full types, and syntax-only checking of the prepared
native fixture. It includes the actual inline watch fix and the correct inline adapter suite. No native,
end-to-end latency or matched package-create cost pass is claimed. Independent review and packaged
failure/recovery/cost acceptance remain required before release.

## Review corrections

Review reproduced three more failing caller cases in `20261118T142424.654449Z-84149`: both ordinary
and Model Manager packages lost a known backend name with Models off, and cancel returned an already
settled success after authority changed before its new wrapper continuation. Both are corrected.
Models and Store now share the existing non-secret account-name reader in `accountQueries.ts`; Store
gains no token/lane access. Ordinary packages with a known backend name still skip Models entirely.
Model Manager setup still precedes the final name read. Every awaited account/read fallback is bound
to the same physical connection/current-machine predicate. Cancel rechecks current/abort after await.

Corrected source receipt `20261118T142753.061594Z-91177` passes 496 tests in 19 files, full types, prepared
native-fixture syntax, and all thirteen included runtime files at 100% statements/branches/functions/
lines. It includes positive 100-request shared-lifetime capacity, exact account/no-credential answers,
known-empty name behavior and connection replacement during backend fallback. Native, matched cost and
independent final review remain open; the earlier source-only checkpoint is not the final correction.
