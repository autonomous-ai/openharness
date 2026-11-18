# Wi-Fi component authority after machine rebinding

## Design

A socket reconnect is not proof that the same account still owns this machine.
`runWifiService` must verify the core's nonempty machine ID before a retained
component can act. Each built component owns a token and its follow cache. The
token survives a confirmed same-machine reconnect; replacing the machine
permanently revokes the old token, even if a later connection names that ID again.
Reset the old cache, subscribers and pending catch-up before building its successor.

Every exposed core read, mutation, window notice, and retained submit/cancel
callback checks both the component token and the verified cloned-core binding.
Check again after each await before a send, private result or delivery update.
No new core API, protocol, list, record or broker is added. Errors carry fixed
codes and no request content or account identifiers.

Store preparation is deliberately durable. Installation, doctor and workspace
work can finish after a same-machine reconnect and create the agent exactly once.
Only a create that has not been sent may wait for machine verification: one
identity promise belongs to each cloned core, created at `onConnected` and bounded
to 15 seconds. This also covers a create before a resume event arrives. Resolve
it after verifying identity and choosing the component owner, before follow
catch-up or `port.resume`; recovery inside resume cannot wait on itself. A repeated
resume on the same connection starts a fresh verification generation when its
ordered handler begins. Disconnect, replacement, invalid identity, timeout and
stop revoke the binding and settle pending creation unavailable. A new connection
is never used to replay a query already sent. Creation receipts keep an unknown
outcome when confirmation is lost.

Transient stop/read/focus/scroll/reveal calls do not wait for an unverified account.
Old Store UI work cannot reveal through a new component. The existing durable UI
retry can continue for the same component only after its new window view is read.
The `followLink.reset` lifecycle clears rows and callbacks, invalidates in-flight
catch-up, and settles its readiness waiters false while clearing their timers.
Ordinary `disconnected` retains its existing same-owner catch-up semantics for
every other component.

## Selected validation

The adapter RED retains old APIs and callbacks across a machine rebuild, attempts
reads and effects, and observes private follow rows in the wrong component. It
also sends creation after `onConnected` but before resume, where identity is not
known. Positive controls cover same-machine continuation and creation within
resume after identity verification. Additional cases cover late replies, identity
ABA, invalid IDs, readiness timeout/disconnect/replacement/stop, late old timers,
and follow-cache reset with pending catch-up/readiness. Actual AutonomousDeviceStore
preparation is suspended at workspace completion across both same and different
machine reconnects; only the same owner can create, once.

Run the adapter and follow helper at 100% per-file coverage. Include existing
followLink callers' suites (agent cleanup, agent browser, search and workspaces)
plus the Store suite, architecture and TypeScript. Parent coordinates packaged
validation. Windows is deferred by the user; all test state and sockets are private.

## Evidence

`/tmp/core-wifi-machine-red.log` records four failing authority cases on the old
adapter and the passing self-resume control. One failed early RED assertion also
left its expectation rejection unhandled; the fixture now consumes that expectation
if an earlier assertion fails. The first full scoped run identified three existing
tests that assumed calls were authorized before identity confirmation. They now
exercise the verified handshake and retain their cancellation/no-replay assertions.

79 adapter/helper cases and TypeScript passed before final branch controls were
added. The final selected plan is `/tmp/core-wifi-machine-validation-plan.json`.
Receipt `.harness/validation/20261118T044515.538118Z-96269/receipt.json` retains the
passing Store suites, architecture and types; its combined coverage check timed
out at 180 seconds because the new timer-spy fixture restored a fake clock for
later tests. The first cleanup-only correction still left that order dependency;
its receipt `20261118T044848.855464Z-99582` records the affected gate stopped after
82.1 seconds, with its owned process group cleaned up. An isolated diagnostic
confirmed the timer case itself passed. Removing its unnecessary fake clock and
restoring real timers after mocks fixed the test isolation.

The affected coverage/caller gate alone was rerun through
`/tmp/core-wifi-machine-final-plan.json`. Final receipt
`.harness/validation/20261118T045024.284967Z-1624/receipt.json` passed in 6.2 seconds
with fixed source before/after, 159 cases across all six helper/caller suites,
and 100% statements, branches, functions and lines for both changed runtime files.
The retained checks cover 39 Store cases, 35 architecture cases and TypeScript.
No runtime changed during those fixture-only
corrections; the earlier passing Store, architecture and type evidence is retained.
