# Bounded daemon hook closeout

The daemon separation phases, Codex crash-resume correction, readiness boundary
and same-millisecond pane fix are merged. The current closeout addresses four
reproduced native delivery failures: acknowledged pending work lost after restart,
repeated completion notifications, accepted changed payloads under a reused ID,
and a paused core leaving Cursor Stop held. The larger draft also introduced a
healthy-running Cursor Stop regression; that must pass before anything lands.

Independent review on October 14 found that the generation controller, new initial
launch schemas, allocation compaction and saved/live handoff in draft #1172 are
not prerequisites for these failures. That work remains preserved on its draft
branch through `f864d6e9e`. It is neither activated nor claimed complete here.

## Fixed scope

- Retain immutable intake, exclusive effect claims, terminal receipts and
  conflicting delivery IDs across restart, with bounded storage and work.
- Keep the installed hook protocol and configuration compatible. A slow durability
  boundary is pending work, not evidence that a Stop belongs to another turn.
- Retain the original live turn boundary through registration, transcript/task
  drains, closure and cleanup. Cancel, a successor or reconstructed interpretation
  cannot inherit an older Stop's authority.
- Confirm actual Stop completion before reporting it complete. An interrupted
  effect with no conclusive result stays visibly held; recovery cannot replay it.
- Start recovery after readiness and prevent unavailable recovery from authorizing
  automatic Close. Preserve current-main behavior unrelated to this change.

Durable client outboxes, automatic reconciliation of uncertain Stop effects,
native generation activation and generalized launch/lifecycle work are deferred.
This change must not be presented as completing every item in the broader
[completion checklist](2026-10-09-daemon-core-completion.md).

## Acceptance

Keep one matrix: the three HTTP/Registry restart regressions; installed legacy
client completion with running and paused core, both with and without its later
transcript marker; duplicate/conflicting deliveries; Cancel and successor
isolation; crash during Stop processing; readiness and visible holds during
unavailable dependencies; relevant runtime cost. Keep the existing failing
acceptance assertions enabled. A callback invocation alone is not completion.

Required gates remain types, architecture, full core and master coverage, touched
specs, unchanged goldens with assertion-failing wiring mutations, relevant private
end-to-end lanes, independent integrated review and every required head check.
Merge with the repository helper after those pass. No release is authorized.

## Evidence and timing

Work on this narrowed branch began about 00:29 UTC on October 14 from main
`402ee861c`. The former hook acknowledgement, client transport and native probe
goldens were recorded before the move and committed alone as `5eb121db0`.
Recording receipts are source-changed; the first playback aggregate failed only
because its copied probe fixture used an argument absent from main's API. The
corrected unchanged playback and types pass in
`20261014T003358.204854Z-86443` (2.7/4.6 seconds).

The reviewed server-delivery prefix through `3bd0dd7cb` is transplanted onto
current main. Its one conflict retains main's agent settings. The already-landed
Close recovery guard is connected. Types and 48 cases in six complete delivery,
storage, golden and architecture files pass in
`20261014T003659.224384Z-971` (24.4/82.5 seconds). The linked-Stop correction and
whole-change acceptance were unfinished at that checkpoint. Earlier draft receipts cover only
their original inputs; they do not establish this branch's acceptance.

Draft [PR #1304](https://github.com/autonomous-ai/openharness/pull/1304) now keeps
Stop inside the registration's existing exclusive claim. It captures the original
core turn, parser, binding and cancellation witness before any admission wait.
Completion waits for the bounded task/transcript drain, actual closure and removal
of the original task IDs. Persistence retries retain that one result. The legacy
follow-up request confirms it without deleting a newer turn's queued tasks.
Cold recovery without the original live witness remains held for explicit Cancel.

Review found and corrected four races: an overdue Promise could beat its deadline
timer, uncertain intake followed by a later request could stall recovery, a late
Stop could publish a hold after shutdown, and legitimate recovery attachment could
invalidate its own delayed cleanup. Preparing receipts now retain the original
witness within the existing capacity limit, including queue refusal. Exact task
IDs survive legitimate reattachment; shutdown still revokes cleanup. Empty task
sets need no storage, and inaccessible storage is a hold rather than absence.

Focused core validation `20261014T012521.698743Z-36595` passes all 100% per-file
coverage measures for the four changed Stop, task, funnel and normalizer modules.
The targeted HTTP restart, uncertainty, queue-pressure and shutdown regressions
pass in `20261014T012554.521658Z-40380` (12.3 seconds). All four shipped-client
Cursor Stop cases pass in `20261014T012639.404954Z-44965` (54.2 seconds), using a
release bundle and verified native helper against private daemons and fake engines.
Both healthy and paused cores complete, with and without a later native completion
record. No acceptance deadline or Stop assertion was relaxed.

The full core/service gate passes in `20261014T012923.357586Z-63604`:
2,751 tests across 185 files, with 100% statements, branches, functions and lines
per covered file (175.1 seconds). Main subsequently advanced to `17ee12593`;
its reporting-route overlap and changed gateway counter boundary require combined
validation before merge. Its unrelated product work does not expand this scope.

The combined-main gate `20261014T013717.105031Z-14571` passes full core/service
coverage (2,752 tests, 170.1 seconds), master coverage (273 passed, one existing
platform skip, 22.7 seconds), and the native helper protocol (3.4 seconds). Both
coverage gates remain 100% per file across all measures. The touched-spec check
in that aggregate failed: 969 tests passed, and two failed during initial setup.
The unchanged catalog suite passes alone, all 83 cases, in
`20261014T015525.878232Z-5667` (76.2 seconds). Its failed observation saw ancestor
directory stamps change before the test deleted any authority; no production
fence or corruption assertion was weakened.

The versioned receipt fixture had deferred recovery without starting it. An
interruption after allocation could leave its initial namespace unsealed, which
receipt-only lookup correctly refuses to repair. The ordinary ready-core case
now starts the existing recovery loop. A controlled interruption proves that
receipt retries leave that namespace untouched and original-owner recovery then
completes exactly one intake. Independent review caught a test spy dropping the
read-only snapshot argument; it now forwards that argument unchanged. Final types
and all 19 protocol cases pass in `20261014T015750.448086Z-15668` (4.6/42.2 seconds).
These corrections change fixtures only, so the completed production coverage
and native checks remain applicable. The Stop notification assertion retains its
original condition and 20-second deadline. The wiring mutant will require an
assertion failure when the composition root's captured-Stop wiring is removed.

Earlier diagnostic aggregates failed and are not passing evidence. The unbundled
run lacked the macOS helper; a later fixture needed to wait for its fake process
record before registration. Concurrent HTTP/coverage/e2e checks then exceeded
fixture or native storage deadlines. Separate runs above passed with the original
deadlines. The capacity regression's first assertion also incorrectly expected a
secondary hold reason to override an existing active hold; it now verifies actual
queue refusal and eventual completion. Remaining gates are full affected
end-to-end lanes, causal mutations, runtime cost, final independent head/base
review and ready-state CI.

Runtime investigation found unnecessary client-outbox scanning even though the
installed client has no durable outbox. Internal client replay is now opt-in;
server recovery still starts after readiness. A default-off regression confirms
recovered server intake completes without a client-outbox read. Full related
HTTP/admission, storage, golden and architecture checks pass: 252 cases in eight
files, plus types, in `20261014T020558.563256Z-73387` (193.8/6.1 seconds).

A local unfinished admission also already denies a legacy mutation. The server
now avoids a redundant journal confirmation in that case. This only refuses;
every possible acceptance still requires fresh native and journal proof. The
denial checks the exact process scope, so an old process's pending receipt cannot
hold its replacement. Both deterministic regressions and types pass in
`20261014T022256.326783Z-72642` (5.7/5.4 seconds). All 16 protocol mutations,
including removal of either guard and the default-off replay check, fail by
assertion in `20261014T022453.904061Z-81024` (105.6 seconds). The owned mutation
worktree is restored clean. No covered core/master production file changed after
their passing combined-main gates; the affected HTTP and end-to-end gates are
being completed on the final source.

Main advanced to `3b3c552d2`; the merge at `c4682a167` changes only the backend's
measurement storage and documentation. Independent review approved that exact
head/base, conditional on the remaining acceptance gates. The measured CLI
baseline and existing CLI evidence retain identical relevant inputs.

### Runtime cost

The matched comparison uses Node 22.23.2, tmux 3.5a and Darwin 25.6.0 on the same
16-logical-CPU machine. Both frozen release bundles use their matching verified
native helper. There are four fake engines, two active agents, two windows, four
terminal streams, no added history, the benchmark's standard 20-second warmup,
and three 10-second measurement windows. Samples alternate baseline/candidate
twice. The baseline is `17ee12593`; the candidate is `c4682a167`. The benchmark
runner is the same for both. Sanitized raw measurements are preserved in
[the runtime report](2026-10-14-daemon-hook-runtime.json).

| Core measurement | Baseline, two samples | Candidate, two samples |
| --- | --- | --- |
| Empty CPU, percent of one logical CPU | 0.63 / 0.68 | 0.64 / 0.69 |
| Populated idle CPU | 2.34 / 2.17 | 3.03 / 3.13 |
| Active CPU | 7.33 / 7.03 | 38.94 / 29.65 |
| Populated idle mean RSS, MiB | 104.4 / 105.3 | 117.0 / 112.8 |
| Active mean RSS, MiB | 107.6 / 107.9 | 121.3 / 118.8 |
| Active turn latency p95, ms | 6253 / 6379 | 6559 / 6522 |
| Active event-loop delay p99, ms | 12.84 / 12.87 | 35.29 / 33.47 |
| Active event-loop maximum delay, ms | 228 / 222 | 155 / 327 |

All four workloads pass their ownership, session, stream and no-core-restart
assertions; each active window completes two turns. Receipt
`20261014T023107.238918Z-8881` records the build (15.7 seconds) and samples
(92.0/100.5/91.9/101.6 seconds). This is a short fake-engine measurement, not a
long-term stability or real-model benchmark. Two turn observations per sample
also do not establish a latency distribution.

Active CPU cost is materially higher. Durability adds repeated journal, route
and ownership observations plus synchronization; the diagnostic CPU profile
shows this work in native read fences, metadata and admission completion. Earlier
two-second-warmup measurements included unfinished admission work in the idle
window. Their receipts and reports remain retained, including
`20261014T015947.942574Z-22932`, `20261014T020945.663454Z-88645` and diagnostic
profile `20261014T021234.467234Z-16044`. Changing warmup and the denial guard
together does not isolate either one's performance benefit. The final matched
comparison above is the evidence for the resulting behavior. No numerical limit
is invented, and no durability check is relaxed to lower this cost. Independent
review found no concrete control or safety blocker in the first pair; final
acceptance still requires the private control/deadline lanes and CI.

The working target given to the owner is one to two focused days including
validation and review, not a guaranteed completion date. The earlier two-to-three
day estimate was wrong. Scope is frozen; additional blockers need a concrete
violation and reproducer. Implementation and validation overlap; merge,
publication and external waiting remain zero at this checkpoint.

## Final acceptance findings, October 14

The ready-state Linux unit run [38502330644](https://github.com/autonomous-ai/openharness/actions/runs/38502330644)
failed on four fixture mismatches. The platform-pinned descriptor fixture now
supplies the helper's identity mode, startup ordering includes non-awaited server
recovery, the default-off test waits for confirmed recovery readiness, and the
replacement-transcript fixture keeps the old inode alive so replacement is a
proven precondition. The former-main golden JSON is unchanged. These do not
weaken the production ownership fences or establish general inode ABA exclusion.

Private acceptance reproduced a one-shot prompt lost when its initial journal
snapshot failed before the server retained its body. The bounded preparing receipt
now retains original input and arrival order before that snapshot; recovery retries
it without a client. No unpersisted input receives a durable-ownership acknowledgement.
Capacity, conflicts, replacement processes and cold Stop effect authority remain
fenced. Review also found that a cold durable predecessor with no local receipt
could be overtaken by a fresh same-conversation request. Such requests now wait
outside the live queue until recovery admits their predecessor. Both equal-time
and headerless reproductions failed by assertion before that correction in
`20261014T030912.108976Z-28758`.

The full affected HTTP, storage, admission, golden and architecture run
`20261014T031032.807838Z-33548` passes 260 tests and fails one stale Hermes capacity
expectation; its typecheck also found a test-only header-map type. The completed
corrections pass types and both capacity cases in
`20261014T031633.308506Z-59933` (5.9/17.7 seconds). The capacity case now says why a
distinct request waits behind the newly retained local predecessor, while still
requiring an unowned retry response. Normal journal-capacity refusal remains
asserted. Independent review approved this recovery slice and its cold Cancel
test, which proves no replacement-turn effect and eventual explicit revocation.

The full [end-to-end run 38502341357](https://github.com/autonomous-ai/openharness/actions/runs/38502341357)
failed and is not acceptance evidence. Failures include the reproduced missing
prompt, cold recovery ordering and a legacy Claude Stop received while admission
is pending: the one-shot client exits after an unowned retry response. The Stop
case remains blocking. macOS disk tests also lacked the required native helper;
their workflow now builds the verified helper and requires its embedding before
testing. Independent review approved that wiring; an exercised workflow remains
required. No extra run was started to hide an unchanged failure.

The legacy Claude Stop correction now retains a bounded local continuation with
its original parser, turn, process and Cancel witness before admission waits. It
does not claim durable ownership or activate a different installed client. Native
ancestry capture finishes before the initial or duplicate HTTP response can end
the caller. Fresh process and journal proof precede dispatch and follow transcript
drains. Cancel can retire this local notification while an independent native
recovery hold remains. Ordinary recovery attachment preserves its parser; a
previously requested SessionStart reset remains a reset and grants no authority
to an older Stop.

Independent review identified those caller-lifetime, forced-reset and unavailable-
admission Cancel paths; composed regressions now cover them. Types and 34 focused
cases pass in `20261014T034732.603873Z-24449` (5.1/9.4 seconds). An initial composed
fixture failed first on an unbound registry method and then on checking the
engine-stopped callback before actual closure; its passing assertion now waits
for the turn-ended effect. The shipped-client gate
`20261014T035102.780285Z-40394` passes all three cases (74.4 seconds): an original
Claude Stop through a real private registry outage with no terminal transcript
record, a delayed Stop leaving the next question open, and installed hooks with
an unusable routes path. These use private daemons, homes and tmux servers.

New mutations cover early caller replies, Cancel, replaced parsers, missing turn
observations, the actual main recovery attachment, local intake capacity and
cold predecessor ordering. Their final run, full core coverage, affected HTTP
acceptance, final runtime measurements, integrated review and new head checks are
still pending. The earlier failed Linux and full end-to-end runs remain failures;
this checkpoint is neither merge nor refactor completion. Publication remains
unauthorized.

The corrected core gate passes 2,780 tests with all four coverage measures at
100% per file in `20261014T035440.798888Z-64237` (168.7 seconds). Full affected
HTTP, storage, admission, architecture and unchanged goldens pass 268 cases in
eight files in `20261014T035807.706676Z-80885` (types 4.7 seconds, tests 247.0).
Independent review carries to combined head `64105ede1` against main `5519be61a`;
that conflict-free integration changes only firmware, Desktop, website and docs,
with identical CLI, Store and scripts trees.

Linux [run 38508805283](https://github.com/autonomous-ai/openharness/actions/runs/38508805283)
then exposed a fixture race: startup allocation could refuse a deliberately
replaced process before the test reached its intended resolver-snapshot fence.
The fixture now waits for the original journal's readiness before injecting that
replacement. Its exact stale-hook, no-prompt, no-registration and unbound-row
assertions remain, and pass in `20261014T040355.123441Z-9266` (1.8 seconds).
Independent review approved the correction; its existing disconnected-snapshot
mutation still must fail. No production code changed for this failure.

Corrected full [end-to-end run 38509153975](https://github.com/autonomous-ai/openharness/actions/runs/38509153975)
is running on `64105ede1`. Subsequent unit-fixture and documentation edits do not
change that run's production, end-to-end harness, helper, workflow or dependencies.
The final mutation, runtime and current-head CI gates remain outstanding.

The final mutation aggregate `20261014T040515.982940Z-15735` is not a passing
receipt: ten groups prove 145 deliberate wiring faults, but linked Stop has two
framework timeouts among its 17 cases, native admission exceeds its 180-second
full-baseline deadline, and two identity-mode faults target a control-only golden.
The correction retains every golden and production byte: give the composed Stop
its existing six-second assertion window inside a ten-second test limit, advance
the existing fake grace clock before the parser-isolation assertion, and target
the existing identity-only unit oracle. Each selected admission mutation now runs
its exact positive file/pattern first and requires at least one passing test.
Independent review approved these test/script corrections; only the three affected
mutation groups need to run again.

Current-head Linux CI for `251d9e0d0` is fully green, including `ci/required` in
run `38509558339`. Manual e2e run `38509153975` has failures in restored-session
interpretation, paused-core prompt hooks and the macOS disk/update lane. It is not
passing evidence. Diagnostics show engines answering after normal restart while
some transcript readers stay unattached. Shutdown currently revokes journals
before all dispatched receipt writes finish; that explanation needs a regression
and a bounded correction. Full-disk setup also fills storage after discovery
binding but before initial hook admission; review requires a confirmed setup
precondition while retaining recovery assertions. No merge or release occurred.

Graceful shutdown now stops new admissions synchronously, allows only terminal
receipt writes already dispatched to settle for at most one second, and then
revokes storage. Immediate stop still revokes immediately. Private HTTP tests
prove durable recovery without redispatch, absolute timeout, write rejection,
and no new publication from an accepted or rejected claim suspended across the
shutdown cutoff. The rejected-claim regression failed before its final guard;
independent review approved that boundary. Focused types and shutdown/Stop tests
pass in `20261014T043606.552401Z-85825` (9.1 and 10.5 seconds).

The retained Claude Stop also memoized a temporary hold before any effect began.
Two tests reproduced that with identity and interpretation holds, and review
found the same problem when initial journal verification throws. All three fail
before correction. Initial confirmation is now retryable; after the original
effect begins, its result remains memoized and fenced to its original turn.
All 126 turn-hook tests pass. The full core coverage gate and affected restart
end-to-end lanes must still run on these changes.

The paused-core failures are regressions: both exact hook-client cases pass on
main `f9c261a038` in [run 38359280628](https://github.com/autonomous-ai/openharness/actions/runs/38359280628),
and the intervening main changes leave their client, hook declarations and test
inputs unchanged. They cannot be waived as baseline failures. The emitted
Claude/Codex hook needs to retain its original caller before the short-lived
shell exits, while the server still requires fresh native engine proof.

Both build layouts now emit a standalone Claude/Codex client with the shared,
descriptor-free origin reader. It freezes caller IDs before awaiting, uses the
original hook deadline with one second reserved for transport and exit, and sends
a bounded optional header. Older cores ignore that header and receive the former
body. Unavailable capture stays latched: the new core returns an unowned hold,
without native recapture, retained intake, callback or agent-wide ownership claim;
the client says why and cannot enter offline registry fallback. Cursor keeps its
existing matching. Direct `tsx` source execution still uses the raw legacy hook;
source-script goldens do not exercise the emitted origin capture.

Independent review approved this slice conditionally on acceptance. Types, 82
client/origin/unchanged-golden cases and nine header HTTP cases pass in
`20261014T044551.454661Z-49657` (5.2, 5.3 and 4.5 seconds). The actual emitted
artifact tests replace the host kernel and tmux with fixtures, including caller
reparenting, stalled boot evidence, missing credentials and an offline daemon.
Private Darwin e2e `20261014T044648.813727Z-53354` passes six of seven cases,
including both paused-core hooks, retained Claude Stop and ordinary restarts.
It is not a passing aggregate: the Codex awkward-folder case hits a journal
confirmation deadline before initial registration, then remains behind an
unconfirmed claim. That recovery defect needs correction before another full
acceptance run. Emitted-client Linux acceptance remains outstanding.

The Codex folder failure published an exclusive claim, then missed disk
confirmation before returning its execution capability. Its own live journal
treated that never-returned claim as if another core had been interrupted.
Two regression cases fail before correction. The journal now retains the
exclusive publisher's exact original witness, observed mirror and namespace
proof before fallible post-publication sync. Only that same live journal may
confirm its never-delivered claim, after both actual cleanup and its original
public reply settle. Returned capabilities, reconstructed journals, changed
owners and equal-byte replacement records never inherit this permission.

An undelivered claim keeps its queue position without overriding a later
accepted binding or fresh rejection. Three queue regressions fail before the
correction. Composed HTTP cases confirm original prompt then successor exactly
once, and reject the old prompt if binding has independently advanced. No new
request from the original producer is needed. Independent review approved this
slice after adding absolute deadline checks after cleanup and final proof;
tests cover a clock crossing before the timeout callback can run.

Types and composed HTTP tests pass in `20261014T050855.689853Z-98801` (5.9 and
3.8 seconds). Its combined journal, file, queue and architecture check is not a
passing aggregate: 154 cases pass and one actual-process case exceeds its
unchanged 4.5-second deadline while other files run. All 11 actual-process cases
then pass alone in 20.6 seconds. Native process checks will continue serially;
the deadline is unchanged. The new causal mutations and final broad gates remain
pending, as do runtime measurements, acceptance, head CI and merge.

The full-disk fixtures now confirm the exact initial SessionStart before filling
their private volume: same delivery ID, firing time and original body, including
its origin. Only an ordinary successful server acknowledgement establishes that
precondition. Reading its journal is insufficient; no warm-up turn is sent.
The cold-turn test still requires no orchestrator directory before filling the
disk. Independent review approved this setup change conditionally on macOS
acceptance. No release has been requested or performed.

The exact-head Linux unit run [38515540213](https://github.com/autonomous-ai/openharness/actions/runs/38515540213)
passes on `7d9ca51fd`, including `ci/required`. Bundled Darwin acceptance
`20261014T051318.250520Z-22389` passes both paused clients, both awkward-folder
restart cases and both tmux configuration cases; its retained Claude Stop fails.
The macOS setup helper also looked in the data directory instead of its
`native-hook-deliveries` child. Those failures are not passing aggregate evidence.

A bounded private trace reproduces the Claude failure: its first post-drain
confirmation rejects while another confirmation is active, before any Stop effect
runs. The old completion memoized that transient preparation failure. Each
preparation attempt now retains its own execution proof, deadline and revoked
callbacks. Only an actually settled attempt that entered no mirror, close or
emission may retry on the original captured turn. The server refreshes admission
for that retry; after any effect entry, an uncertain result stays held. A second
preflight confirmation is needed only after the configured asynchronous delay.
Three regressions fail before correction. Types, all turn-hook tests and affected
legacy HTTP cases pass in `20261014T053457.512951Z-97100` (6.9/0.9/8.9 seconds).
Independent review approves this correction conditionally on the remaining gates.

The shipped Claude Stop passes in `20261014T053547.431358Z-2280` (35.8 seconds),
with the original 20-second acceptance deadline. Its macOS lane passes both disk
cases and the first two update cases, but fails the last two update recoveries:
Claude's conversation does not reattach after the full-disk restart, while Codex
recovers. The setup now confirms the exact stored intake through the original
body and origin header. The remaining recovery failure is blocking; no merge or
release has occurred. Final coverage, causal mutations, runtime comparison and
corrected full end-to-end acceptance remain required.


### Cold restart: observing a bound transcript without replaying a hook

The failing full-disk update reproduced an exclusive UserPromptSubmit claim with
no result after the former core exited. Both copies preserved that uncertainty.
Replaying the claim would be unsafe, but the strict recovery gate also prevented
an already-bound conversation from attaching, so later native answers never
reached the daemon. This is a session-control availability defect, not a reason
to infer that the interrupted callback did or did not run.

Attachment now has a separate permission. It requires a confirmed earlier
accepted registration for the same agent and conversation in the same native
process journal, a currently validated stored binding, fresh precise native
process proof, and a complete confirmed frontier whose unresolved deliveries
are same-conversation UserPromptSubmit registrations with no conflicting path.
A first binding, Stop, other conversation/path, changed binding, unavailable
proof, or unconfirmed incoming delivery cannot use it. The grant checks the full
frontier and its original native deadline again before returning. It is revoked
by shutdown, process/binding changes, or changed journal evidence. Ordinary
transcript lifecycle, input and recap observation may proceed; no hook receipt,
prompt credit, Stop capture or registration callback is manufactured.

Automatic Close continues to use strict effect recovery readiness and the visible
admission hold. The uncertain claim is neither completed nor replayed. This does
not activate the separate generation/launch/outbox draft.

A regression first failed against the strict attachment gate. Cold persisted
registry and journal fixtures now prove observation, exact delivery retry without
repeating callbacks, preservation of the original uncertain claim, and refusal
for conflicting or unavailable authority. The real Watcher-to-ingest-to-Close
composition observes a later native turn while automatic Close remains held.
Independent review required final proof/binding rechecks and process-scoped local
receipts; both corrections are implemented. Nine additional mutation cases target
these permission boundaries and require actual assertion failures.

Validation receipt `20261014T061214.446282Z-57047` records passing types
(5.4 seconds), 479 passing affected cases and one failed newly written fixture
(133.9 seconds), and all four formerly failing macOS full-disk update cases passing
(144.5 seconds). The aggregate remains failed: the new external-frontier fixture
mistakenly supplied the proof's function along with its serializable owner data.
That fixture now passes only the owner key and evidence, with no runtime change.
The positive observation test also has a larger outer test limit so the unchanged
four-second assertion deadline remains the failure oracle for disconnected wiring.
Final coverage, affected mutations and full end-to-end acceptance remain pending.

Receipt `20261014T061751.701322Z-91582` passes types (6.3 seconds), all 17
new cold-observation cases (15.1 seconds), and all 2,790 core tests in 185 files.
The core gate nevertheless fails (172.8 seconds): statements and branches are
99.99%, with one unexercised refusal in the new Claude Stop callback. A focused
causal test now invokes a revoked preparation's late close callback while its
retry owns the turn, and verifies that only the retry may close it. The full
coverage gate will be rerun; the earlier near-complete gate is not called green.
