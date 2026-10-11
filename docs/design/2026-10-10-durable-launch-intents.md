# Durable manual launch intent

Manual model creation previously saved `GRID_UNAVAILABLE` as a completed failed
receipt. The same request could never recover when models returned, and the
receipt lacked the request needed after a core crash. This violates the daemon
bar: unavailable dependencies must hold dependent work with its reason.

## First implemented boundary

Fresh `agent_create` requests with a stable `creationId`, `gridModel` and
`gridName` now persist their complete semantic choices and original local/remote
authorization before model resolution. Only model identifiers are retained;
resolved endpoints and credentials are not cached. Resolution may renew
service-owned credentials, so it is repeatable preflight, not pure read-only work.

Unavailable, disconnected, stalled or temporarily unlisted models leave the
request pending with its reason. The same lookup continues after a five-second
pending reply; slow success is not discarded and reconnects do not start another
lookup for that ID. Core opens recovery after readiness through the ordinary
models port, including its existing on-demand startup. Optional interpreters do
not admit work. This complements `heldLaunches.ts`, which owns registered panes
waiting for dependencies; these intents precede those panes.

## Durable authority

The existing namespace supports v1 outcomes and v2 intents. An immutable private
v2 primary record contains the fingerprint, request, hold reason and checksum.
One canonical claim slot chooses dispatch or cancellation; only its successful
publisher executes. A result names the exact winning claim. Bounded owner-only
files are opened without following symlinks. Publication syncs a complete
temporary file, exclusively hard-links its final name, then syncs the directory.
New directory names are synced through their parents first.

Preflight retains an open receipt-directory descriptor. Before claiming and
again before an effect, it checks directory identity and rereads the complete
current intent. Missing, replaced, corrupt or conflicting evidence cannot
authorize an old callback. Failed claim publication or sync cannot authorize
another attempt merely because that claim can now be read.

Project preparation, configuration, native mutations and terminal dispatch stay
behind the claim. A claimed request without a conclusive result is unconfirmed
after restart, never blindly executed again. A locally known unsaved outcome
stays tied to its exact claim and cannot conceal contradictory disk evidence.
Orphan results, mismatched tokens and conflicting legacy/v2 parts hold work.

`agent_create_cancel` competes for the same claim slot and syncs a winning
cancellation before acknowledgment. An unknown ID gets a durable tombstone, so a
late create cannot undo it. Cancellation losing to dispatch reports the existing
outcome or uncertainty; it does not promise the effect stopped. No user data is
deleted. V1 outcomes remain authoritative. Fresh legacy installation refusals
remain correctable before reservation, while existing IDs are checked before
mutable refusals. Supported DSH former names retain canonical IDs/fingerprints.

## Resources and clients

Core keeps four model preparations and a retry window of 128 IDs. A stalled
promise retains its preparation slot until settlement; its wrapper deadline
allows the port's three-minute credential preparation allowance. Each recovery
pass examines at most 64 directory entries, with a shared 20 ms work budget that
includes retry reads. The cursor yields between passes and pauses at a full
window. Under pressure, settled holds make room for later entries before the
cursor rewinds. Broken or permanently unavailable early requests cannot starve
the tail. Explicit requests still persist when the window is full.

Ordinary holds retry after two seconds; background dispatch is at most four per
250 ms tick. A completed history scan repeats after one minute. Large backlogs
therefore trade recovery latency for bounded resources and responsive control.
No full intent or resolved-model cache lives in the retry window.

Desktop shows the reason and offers **Cancel request**. Lost cancellation replies
retain the original ID and Check status path. Confirmed cancellation releases
the attempt and its tab's pending ownership. All clients seal the new request.
TUI/mobile still have generic pending presentation and no cancellation control.
Desktop can also refuse an unavailable model before submitting a request; this
change covers durable admission of requests actually received by the daemon.

## Evidence and remaining work

The former healthy protocol was recorded from main `10c9e7420` in its own commit,
`ac32477c7`, before implementation. Its unchanged golden covers create, profiles,
model selection, project preparation, fork, resume and restart, duplicates and
reconstructed receipt readers. Linux/Darwin and UTC are pinned, paths are
placeholders and host binaries are forbidden. Mutants must fail assertions.

Fault regressions cover slow success, restart, two-core contention, cancellation
during awaits, changed intent/directory identity, conflicting outcomes, fsync
failure, bounded backlog fairness and client tab cleanup. The private daemon
lane kills models and core, verifies readiness and held reasons, cancels one
request, runs unrelated work and recovers the others exactly once.

This is one bounded part of the completion checklist. Required remaining work:

- Move later `buildGridLaunch` and Store dependency preparation before the effect
  boundary; either can still fail after the current claim.
- Preserve fork/resume/restart/retarget intent and original authorization, with
  target reservations across different IDs, restoration and held-pane recovery.
  Record retarget's former socket protocol before moving it.
- Journal project/clone/branch/Store effects and reserve the chosen path before
  changing it. Reserve agent, terminal and attempt identity before tmux, including
  internal retries. Never choose a second generated folder after a crash.
- Reconcile persistent native-write uncertainty read-only. Make Stop and Close
  durably revoke pending authority through a dispatch/settlement protocol; a dead
  owner can leave a live child, and PID absence never permits replay.
- Publish immutable generated configuration atomically from operation-owned
  paths, preserving foreign configuration and native user data. Retain ID
  tombstones and bound history work without permitting replay.

Final acceptance still requires the full dependency-failure matrix, coverage,
unchanged goldens, mutations, private e2e lanes, matched cost measurements,
independent review and green CI. No release is authorized.
