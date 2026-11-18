# Wi-Fi connection completion ownership

## Design

`runServiceProcess` reuses one `CoreConnection` facade across sockets. The Wi-Fi
adapter already clones it in each `onConnected` callback, so its input, cancel,
conversation, view, resume and inbound-notice checks distinguish connections.
The existing same-facade tests cover input resolution, context binding and input
completion. Keep those guards.

The remaining generic `ask` calls (`recent`, `stop`, `create`, `stepFocus`) return
their answer without checking which connection completed it. A reply can settle
just before a disconnect while its continuation runs afterward. Capture the
adapter's cloned connection before the query and reject the completion if that
owner is no longer current. Never retry the operation. The existing mutation
receipt handlers retain an unknown outcome when confirmation is lost.

The cached view also needs an owner. Retain `{ origin, view }`, revoke it on
disconnect, and send window notices only through that captured owner while it is
current. Scroll and focus still require a window in the view. Reveal remains a
durable Store UI intent and can be sent again after a fresh view on a replacement
connection; this change does not cancel or replay creation, installation, doctor
checks or workspace preparation. No new core API, state or protocol is introduced.

## Selected validation

Before implementation, reproduce each late generic completion and stale cached
window notice through the real Wi-Fi adapter, reconnecting the same facade. Use
explicit promise settlement, no sleeps. Positive controls must accept fresh
answers and send notices after a fresh view. Retain the existing reconnect tests
for the already guarded paths. Run `wifiProcess.spec.ts` with its per-file 100%
core coverage gate, the architecture gate and TypeScript. Parent coordinates
packaged integration validation; Windows is deferred by the user.

## Evidence

The selected RED run failed all five new cases on the old runtime:
`/tmp/core-wifi-connection-red.log`. All four generic operations returned a late
answer, and scroll reported success from the disconnected view.

The first full scoped run passed 47 cases, but the existing real observer test
could not bind its private Unix socket under the filesystem sandbox (`EPERM`).
The unchanged check was then run with that test capability available through
`/tmp/core-wifi-connection-validation-plan.json`. Receipt
`.harness/validation/20261118T042648.369908Z-73990/receipt.json` passed:
48 adapter cases with 100% statements, branches, functions and lines for
`services/wifiProcess.ts`; 35 architecture cases; TypeScript. No runtime changes
followed that receipt. No native benchmark was run for this constant-time
ownership correction.
