# Native hook maintenance after daemon readiness

Startup awaited the initial native hook installer pass before it opened the request
gate and reported readiness. A bounded OpenCode version probe still delayed every
session until that probe completed or timed out. This violated the daemon completion
bar even though the installer no longer depended on an optional worker.

Core now starts hook maintenance after opening requests and reporting readiness to
the master. Each launch independently confirms the required native hooks through
its original ownership and executable snapshot. Startup maintenance returns its
shutdown controller immediately. The same revocation predicate reaches all thirteen
native installers, so teardown does not need to await a pending disk operation to
revoke permission for its later writes. Existing adopted-home retries keep their
own shutdown fence.

`settled` observes the initial installer pass for tests; readiness never awaits it.
Failures remain independently reported for each engine. A launch that needs an
unavailable hook remains held with its reason.

The former vendor, port, selected-engine, adopted-home and refusal coordination was
recorded from main `16569f3d2` in the separate golden-only commit `43c76ff1c`, before
changing startup. The golden pins both Linux and macOS platform values and uses
fixture installers and paths. Its artifact remains unchanged.

The private daemon regression keeps an OpenCode startup probe alive behind a
test-owned release file. The daemon must report readiness and answer agent-list
requests while that exact child is still waiting. Releasing it then completes the
hook installation. The former implementation becomes ready only after its deadline
kills the child, so it fails this assertion.

Initial focused validation passed types, architecture, startup ordering and 79 tests, with
100% per-file statement, branch, function and line coverage of the hook coordinator.
Receipt: `20261011T053403.766571Z-65433`. Final receipts and exact-head independent review are recorded in the PR. No release
is authorized.

The first full private hook lane (`20261011T060712.803551Z-48168`) passed seven
of eight cases, including the blocked-installer readiness case and all-vendor
Stop/resume without the optional hooks chunk. The post-rc create fixture read
its private Codex configuration immediately after readiness, before background
maintenance had created it. The fixture now waits for that file before taking
its fault-injection snapshot. All hold, crash and no-replay assertions are unchanged.
Both create and fork cases passed in `20261011T060955.203043Z-61813`.

All five startup wiring mutations passed in `20261011T061203.293017Z-72305`:
unchanged baselines were green, and each broken implementation failed assertions.
The readiness mutant restores the real awaited startup path in a freshly built
bundle. Final dependency #1160 landed as `740fb5286`; merging it into this branch
changed no CLI source or fixture bytes.

The matched workload exposed an immediate-launch race after readiness: OpenCode
maintenance and the captured launch could revoke one another's file reservation.
Different preparations now wait for the previous disk attempt to settle, within
the launch's original deadline, then obtain their own fresh proof. Identical
canonical destination pairs coordinate across parent aliases; each caller retains
its original route evidence. At most sixteen callers can wait on one pair, and
backpressure cannot supersede a caller already admitted. Different or partial
destination sets cannot borrow another preparation's proof. Owner, executable,
route and deadline checks remain required after every wait.

The regression failed on the former coordination before this correction. Review
then found the alias and waiting-capacity gaps; both have dedicated regressions.
The all-vendor private acceptance now launches OpenCode immediately after readiness,
before waiting for background hook files. It retains every Stop/resume assertion.
Final affected validation `20261011T063338.662745Z-68201` passed types, 157 unit and
golden checks, and all eight private daemon cases. Core's 2,503 tests and master's
265 tests (one platform skip) passed all four 100% per-file coverage gates in
`20261011T061515.849504Z-86437`; the final PR carries any subsequent affected checks.
The earlier `20261011T061414.664196Z-81910` orchestration failed during merge conflict
cleanup and a temporary npm executable issue; it is not a passing suite.

## Failure-driven acceptance corrections

The first full Linux/macOS acceptance run, `38118774703`, found one production
failure in the unchanged stall lane. After a 7.9-second core pause, Node's native
subprocess timeout discarded a completed permission probe's unread output and
returned exit zero with empty stdout. Launch preparation cached that as an
unsupported flag and refused Claude creation. A private real-child regression
reproduced the false refusal before correction (`20261011T065951.966421Z-85384`).

Native launch probes now use discovery's bounded patient deadline. A completed
answer survives a core pause; empty help remains unknown and is never cached as
unsupported. A genuinely expired probe returns unknown. After a 250 ms drain it
closes its own pipe ends, so an exited wrapper's descendant cannot hold its reply
or all eight probe slots indefinitely. It signals only its still-live child;
an uninterruptible child retains capacity until actual settlement. The existing
four-window deadline bound remains, rather than treating it as a wall-clock limit.
Private real-process tests cover both the pause and inherited pipes, and a held
child test covers reply/slot separation. Types and 56 affected checks passed in
`20261011T070638.819101Z-12098`; final PR evidence includes the preserved SIGKILL
setting for output-limit kills. The original stall e2e assertions are unchanged.
The final mutation pass caught ten of eleven defects by assertions; the deliberately
released probe slot instead hung its fake ninth child. The capacity test now checks
child admission before awaiting that reply, so this defect must fail an explicit
assertion as required. No production code changed in that correction.

Linux unit CI also exposed an installer fixture assumption: ancestor churn can
legitimately hold enumeration before the intended fsync fault is reached. A
one-shot private sibling mutation reproduced the exact missing-witness failure
(`20261011T065353.731186Z-60572`). The fixture now keeps each fault armed and retries
to that milestone, retaining exact claim/witness, absent-result and no-dispatch
assertions (`20261011T065501.793176Z-65267`). Production ownership fences are unchanged.
The legacy installer-output golden now awaits `settled` and closes its controller
in `finally`; its artifact and all 340 assertions are unchanged
(`20261011T064546.689940Z-26598`).

## Matched startup workload

[Raw samples](2026-10-11-hook-readiness-cost.json) retain four alternating runs of
main and this change on the same private macOS workload, pinned Node 22.23.2 and
tmux 3.5a, with all thirteen installers enabled. Each run starts a cold daemon and
immediately creates two fake OpenCode sessions. No user homes, daemon or tmux server
are involved. Two samples per tree are descriptive, not a performance threshold.

| Median | Main | Readiness change |
| --- | ---: | ---: |
| Ready (ms) | 3,311 | 1,370 |
| Core CPU at ready (ms) | 580 | 390 |
| Core RSS at ready (MiB) | 87.6 | 81.0 |
| First launch request (ms) | 511 | 1,322 |
| Warm launch request (ms) | 422 | 341 |
| Ready plus first launch (ms) | 3,822 | 2,692 |

The first launch owns the preparation wait that formerly delayed every request.
Warm launches retain fresh proof checks. Main advanced with the Agent Messages
cleanup in #1165 while validation ran. The final comparison uses fresh bundles of
main `6d9b787dd` and merged candidate `bf9c02478`, including the alias, caller-limit
and native-probe corrections. Baseline construction passed in
`20261011T071120.736472Z-30164` (15.6 seconds); candidate construction and all four
matched samples passed in `20261011T071228.478825Z-34936` (15.7 and 16.4 seconds,
respectively). No other local heavy checks ran during measurement. The earlier
comparison against main `740fb5286` also passed in `20261011T070759.147272Z-17321`;
it is superseded by the comparison above. The initial cost receipts `20261011T062124.649240Z-13284` and
`20261011T062250.241018Z-19378` failed on the collision; the corrected workload passed
in `20261011T062724.898061Z-40203` without changing its launch assertions.

This readiness slice began with the main golden at 05:16 UTC on October 11.
Implementation, failure diagnosis and local validation overlapped through 07:08 UTC.
Integration of the new main and its matched cost comparison ran from 07:10 through
07:13 UTC; individual receipts retain test durations. Independent review ran alongside checks.
CI waiting and merge duration are recorded separately in the PR; publication is zero.
The original daemon request began October 8 at 23:26:41 UTC, not at this slice's first
workflow.
