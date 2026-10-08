# Security

## Reporting a vulnerability

**Do not open a GitHub issue.** Issues are public, and a report filed there is disclosure.

Email **dee@autonomous.ai** with enough detail to reproduce. We will acknowledge within three
working days and keep you updated until it is resolved. If you would like credit in the fix, say so.

## In scope

The spec and both packages in this repository — in particular anything that lets a provider's output
reach a client it should not, or a credential appear where it should not.

## Not a vulnerability

**`example-provider` runs `claude` with `--dangerously-skip-permissions`.** It executes tools without
asking, inside the directory it is configured with. That is deliberate and documented at the top of
its README: it exists to demonstrate a real agent, not to be deployed. Point it at a scratch
directory.

**Signing in is what makes a device trusted.** Every device signed in to an account publishes its
identity key to the account's device key log, and the account's other devices trust it end to end
with no password. So anyone who can sign in as you — or whoever runs the backend — can add a device.
This is deliberate, and it is not prevented, only made visible: every device announces each key added
after it joined ("New device: X") and keeps it marked New until you look, says who removed a device,
and the device list shows every one with a Remove and the full add/remove history. Devices check the
log against what they already verified and compare it among themselves, so the backend cannot rewrite
or roll back that history, hide a key from one device, or move a device to another account's list
without a fresh sign-in there: the list freezes instead, and keys added after a detected split are
not trusted until someone reviews it. Stopping the backend from adding a device in the first place is
future work.

**A phone can sign a computer in by scanning its QR.** Approving one hands that computer the account's
terminals, so two mistakes matter: approving a stranger's computer (a QR you were shown), and a
stranger approving yours with their phone (a QR they photographed). The phone shows what is asking,
where from, and whether it is on the phone's network — another network takes a two-second hold, not a
tap — and the computer asks its own person whose account approved it before any session exists.
A computer signed in this way can add a phone of its own; that chain is intended. Its session is
Harness's own, so billing still needs a Google or Apple sign-in. Grid does not: the Grid control plane
asks the Harness backend who holds the session (autonomous-grid ADR 0046), so approving a computer
also hands it the account's Grid: its grids and the models on them.

## For implementers

Two obligations in the protocol are security-relevant, and both are easy to get subtly wrong:

- A credential identifies **one** tenant. It must not reach another tenant's data through any method.
- Do not log or forward the credential beyond authenticating the request.

On our side, everything a provider sends is treated as untrusted input: validated, allowlisted, and
dropped if it is neither. Do not rely on being able to inject arbitrary client-side structures — you
cannot, and a stream that keeps trying is closed.
