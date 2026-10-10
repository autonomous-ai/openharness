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
journal and native-client acknowledgement/retry migration. Both currently generated
and already-running OpenCode, Kilo, Pi and Amp plugins still need immutable callback
IDs/native order. A timestamp-less conflicting hook currently holds with a reload
explanation, but reloading this build does not resolve that missing client protocol.
That client migration and the corrected recovery explanation are required before release.
Unknown Stop-to-turn correlation remains visible until authoritative native evidence
or explicit Cancel resolves it. Per-engine close facts, asynchronous drain authority,
and complete Cursor task journal ordering remain in the completion checklist.

## Measured cost

The [matched workload](2026-10-10-hook-admission-cost.mts) ran alone under
Node 22.23.2, UTC and `/tmp`, on the same macOS x64 host. Native-evidence platform
is pinned to Linux and host executables are replaced with placeholders. Each tree
runs a fresh process for each workload: 100 complete registry admissions, 100 complete
private HTTP admissions, and five held admissions followed by recovery. Each workload
repeats admission for the same agent and conversation; every iteration asserts durable
admission and callback counts. Baseline is main `cc4983e18`; implementation is
`08afe262b`. [Raw measurements](2026-10-10-hook-admission-cost.json) retain every sample.
Medians average the two middle samples for even counts. Reported p95 uses the sorted
sample at zero-based index `floor((n - 1) * 0.95)`; for five recovery samples, that is
the fourth observation, not the maximum.

| Workload | Tree | Median completion (ms) | p95 completion (ms) | Total CPU (ms) | Peak RSS (MiB) |
| --- | --- | ---: | ---: | ---: | ---: |
| registry (100) | main | 59.87 | 64.84 | 406.50 | 104.66 |
| http (100) | main | 61.18 | 65.81 | 575.84 | 127.06 |
| held (5) | main | 565.37 | 565.87 | 125.62 | 116.93 |
| registry (100) | change | 61.32 | 64.33 | 558.46 | 110.53 |
| http (100) | change | 62.83 | 67.58 | 749.06 | 123.61 |
| held (5) | change | 1073.06 | 1073.20 | 163.63 | 114.47 |

Healthy median completion increased by 1.45 ms for direct registration and 1.64 ms
for HTTP admission. Total CPU increased by 151.96 ms and 173.22 ms across 100
admissions respectively, with the added native evidence and strict durable commit.
Held HTTP responses still returned immediately (median 4.03 ms before, 5.58 ms
after). Recovery moved from the former 500 ms retry to the shared queue's 1 s
cadence; the queue retains the delivery instead of abandoning it after twenty tries.
Five recovery samples are descriptive, not a statistical performance threshold.
These are private-fixture costs, not a benchmark of installed vendor engines.

The before-file startup correction preserves Command Code, Grok, agy and Copilot's
deterministic locators while their directories are still unwritten. That narrow
exception retains the first missing component, surviving owned ancestry and alias
proofs, and rechecks them under the registry lock. Reported paths and existing
files still require their ordinary complete evidence.

## Validation and landing

Planned gates: types; architecture; per-file core/services and harnessd coverage;
affected hook, registry, watcher, worker and native specs; unchanged goldens; composed
resume; private hookclient, races, engine-home, machine, chaos and tmux lanes. The
mutation runner requires a passing baseline and assertion failure for deliberately
broken proof, commit, queue, cancellation and notification wiring. Matched complete
registry/HTTP/held-admission costs run separately and alone. A frozen head receives
independent review and every required CI check before the authorized merge.

[PR #1137](https://github.com/autonomous-ai/openharness/pull/1137) merged as
`9618c2e2c09c078a27a0d76b94f62365bd7a2c89` at October 10 08:36:54 UTC. Independent
review approved final head `5af2d4bd25fd4d82ca1061c6b8ffb686f80ddfb8` against base
`294548e`, following review corrections. Receipt `20261010T083045` passed core/services
(2,114 tests in 165 files, 100%), harnessd (265 passed and one existing skip, 100%),
162 native cases, 22 admission-golden/architecture cases and private hook-client
acceptance (ten passed, one older-release compatibility opt-in skip). Source comparison
and review retained unchanged serial Resume, 63 private lifecycle e2e cases, all 32
assertion-failing mutations and the matched cost evidence above.

Automatic [CI run 38038140466](https://github.com/autonomous-ai/openharness/actions/runs/38038140466)
passed every head check, including `ci/required`. Merge verification occupied
08:36:40–08:36:54; receipt `20261010T083640.654250Z-merge-1137` records the reviewed
trees. The former golden was recorded at 04:33; implementation continued after #1133
merged at 05:16, with review and validation interleaved through the final gate at
08:30:45. Those overlapping intervals are not added to estimate elapsed request time.
Publication remains zero; no release is authorized. Restart-persistent delivery and
legacy native-client acknowledgement/order remain in the completion checklist.
