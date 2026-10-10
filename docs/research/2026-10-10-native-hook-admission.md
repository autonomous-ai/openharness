# Native hook admission and atomic registration

This change follows saved-binding recovery (#1133). It makes registration atomic
and gives the live core ownership of pending native admissions. It does not complete
the restart-persistent native delivery journal or the remaining launch/control audit
in the [completion checklist](2026-10-09-daemon-core-completion.md).

## Former behavior and goldens

The former core HTTP admission golden was recorded from main `c7d460b1d` in
`d331c49a4`; #1133 already carries its unchanged artifact. The additional former
registration golden, `dba98c53d`, records twenty Linux/macOS observations of first
bind, repeat bind, rotation, terminal promotion, active and dormant ownership
transfer, delegated rejection, and resulting live/durable rows. Both platform
values are explicit, host binaries are forbidden, and runs use UTC and private
roots under `/tmp`. Neither golden artifact changes with this implementation.

Former registration could publish a terminal promotion or release an owner before
a save whose errors were contained. Ordinary hooks credited prompts before that
save, and missing-file admission abandoned its retry after twenty attempts. The
Hermes queue likewise advanced accepted order before its registration callback
committed. These paths could report success without owning the resulting work.

## Transaction and live admission

Registration prepares every affected row without mutating live state. Its registry
lock compares the original durable owners, rechecks complete native evidence,
validates the combined ownership indices, and atomically writes the full batch.
Only a successful durable commit publishes the new rows. A rename followed by an
uncertain directory sync retains a deep receipt of the written and prior images.
The next strict operation confirms, reverses, or reconciles that affected ownership
group while preserving unrelated peer writes. A peer-changed group revokes the
stale operation, including a draft that would displace one of its owners.

Every ordinary and Hermes admission uses the same core queue. A failed source or
commit retains its original body, process incarnation, native order and delivery
ID. Distinct prompt deliveries remain ordered; ambiguous competing conversations
are revisited fairly. A same-process route change refreshes the inspected routing,
while loss of the original hinted pane holds the job. Inspection and commit are
fenced to the binding revision. Stop owns its admission fence before its first
asynchronous operation. Prompt credit and optional registration notifications occur
only after durable binding, and a notification failure cannot replay the commit.

Admission holds are visible in session frames without changing binding authority.
Reasons belong to individual deliveries, so completing one cannot hide another.
They are transient and excluded from registry and stopped-session persistence.
Native process-resolution waits and queue/receipt pressure explicitly say that
admission is not queued; they do not claim ownership of an unretained delivery.

## Linked Stop and cancellation

Cursor and Command Code's catch hooks register and deliver Stop under one immutable
native ID. Delayed, newly bound, rebuilding or missing interpretation retains the
unmatched completion in the eager core before attachment can install a later turn.
It stays visibly held rather than guessing which recovered turn to close. A failed
status announcement cannot replay that retained obligation after explicit Cancel.

For an already-bound conversation, a preliminary lookup captures a revocation-only
Cancel witness before process resolution yields. It applies only if the subsequently
proved process and conversation match. Cancel or forget revokes it before queued
commit and before/after follow-up verification. Concurrent registration retries
share the original witness. Completion claims are checked again after awaits; a
duplicate acknowledgement cannot invoke Stop or clear a newer Cursor task journal.
A native linked Stop whose registration was not retained receives an unowned retry
response instead of bypassing admission through the legacy standalone endpoint.

The private Cursor e2e exercises the actual daemon's capture/Cancel wiring, its
native process proof and transcript watcher. The private Codex e2e places a directory
at its own registry file path, observes the admission reason in a real session frame,
and verifies that the exact prompt commits after that fixture failure is removed.

## Bounds and remaining work

The live server bounds receipt count to 65,536 and retained native payload/provenance
to 16 MiB, with a separate bounded admission queue. Accepted receipts last for their
process incarnation; they are not evicted to make a duplicate look like a new event.
Each lookup retry is bounded, readiness waits on none of them, and a full queue
returns explicit unowned backpressure. Process exit/replacement prunes receipts.

This ownership is **in memory**. A daemon restart still requires a durable delivery
journal and native-client acknowledgement/retry migration. Existing long-running
OpenCode, Kilo, Pi and Amp plugins also need immutable callback IDs/native order;
an old timestamp-less conflicting hook currently holds with a reload explanation.
Unknown Stop-to-turn correlation remains visible until authoritative native evidence
or explicit Cancel resolves it. Per-engine close facts, asynchronous drain authority,
and complete Cursor task journal ordering remain in the completion checklist.

## Validation and landing

Planned gates: types; architecture; per-file core/services and harnessd coverage;
affected hook, registry, watcher, worker and native specs; unchanged goldens; composed
resume; private hookclient, races, engine-home, machine, chaos and tmux lanes. The
mutation runner requires a passing baseline and assertion failure for deliberately
broken proof, commit, queue, cancellation and notification wiring. Matched complete
registry/HTTP/held-admission costs run separately and alone. A frozen head receives
independent review and every required CI check before the authorized merge.

Validation, exact-head review, runtime costs and merge receipts are pending. Record
implementation, validation, review/CI waiting, merge and publication separately.
The former golden was recorded at 04:33 UTC on October 10; this implementation
continued after #1133 merged at 05:16 UTC. Publication remains zero; no release is
authorized.
