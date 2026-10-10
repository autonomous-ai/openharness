# Daemon separation continuation, 2026-10-09

The architectural requirements and remaining order are in the [handoff](2026-10-08-daemon-separation-handoff.md). No release is authorized. The current remaining scope is the [completion checklist](2026-10-09-daemon-core-completion.md); the sections below are the historical implementation record.

## Crash resume

[PR #1072](https://github.com/autonomous-ai/openharness/pull/1072) merged as `9ad4bb087`. The main Codex machine test reproduced the interrupted `!slow 8000` prompt being replayed after a stale attach consumed the relaunch boundary. Core now retains that boundary until installation or session cleanup; a stale, failed or delayed worker answer cannot consume it. An interrupted turn closes before new live records arrive, including when the old shell survives.

Regression specs were committed before the fix. Independent review found retained-tail, delayed-attach, automatic-retry and lifecycle-cleanup gaps, all corrected and reviewed again. Final local evidence: typecheck; 1,643 core tests at 100% statements and branches per file; 265 harnessd tests at 100% with one existing skip; 123 architecture/resume/attach specs; all six machine cases, plus 44 terminal/compaction/engine-reader cases on the identical production implementation. Two initial new e2e cases failed because private process identity and cwd were read from the public agent list; the corrected tests read the disposable registry. The failed combined run is not a passing suite. [Final automatic CI](https://github.com/autonomous-ai/openharness/actions/runs/37862113864) passed every selected check, including `ci/required`.

Time accounting (UTC): request first measured October 8 at 23:26:41; initial implementation and review through 23:44; test-only corrections through 23:55; merged October 9 at 00:00. Local gates took 55 seconds; final combined acceptance 302 seconds and corrected machine acceptance 101 seconds. Diagnosis, implementation, review, validation and waiting overlapped; their individual durations are not additive. Final CI occupied about four minutes of the waiting interval. The merge helper verified both the reviewed target tree and tested full tree. Publication time: zero; nothing released.

## L3: Store launch preparation

[PR #1073](https://github.com/autonomous-ai/openharness/pull/1073) merged as `0ed5636d4` at 01:22:56 UTC. The 61-case DSH golden was re-recorded on `1987fa238` in its own commit before the move. Host tmux and Node paths are placeholders, both platforms are pinned, and execution uses `TZ=UTC TMPDIR=/tmp`. The fixture stays unchanged after moving requests and answers through JSON and the production validators.

Core retains the installed index, compatibility checks, trust decisions, session state and pane ownership. Store owns workspace initialization and runtime preparation. Boot does not wait for Store. A grid package declares both dependencies; after a service cannot answer, later dependent agents in the same pass wait without repeating its deadline. Restore checks current held ownership after preparation and preserves the precise reason in the row and waiting pane.

Store reserves the canonical workspace durably before modifying it. An interrupted or unconfirmed operation prevents another engine, package or new create label from rerunning initialization there. This is a hold for explicit review, not a claim that arbitrary package scripts can be rolled back. User files are preserved. Confirmed initialization can be recovered after a lost reply; runtime inputs are revalidated at each launch. Runtime files are replaced atomically so an existing live session never reads a truncated context. A workspace-specific hold does not prevent other workspaces from launching.

Validation and independent review passed, with the final rejection-path verification and automatic PR checks recorded in the PR body. Four deliberately broken Store contributions (create account, relaunch account, fork source and package argv) are rejected by assertions in the unchanged golden. The new mutation script distinguishes assertion failures from setup/import failures. A small baseline desk workload uses four agents, two active agents and two windows, with ten-second measurement phases; this is a comparison, not a new performance threshold.

Independent review also caught lifecycle races across preparation, tmux dispatch and process verification. Stop now cancels preparation immediately and joins only an already dispatched core pane operation before capturing its target. Hook admission waits for the same route commit. Boot restore, restart and retarget share a generation from startup; old asynchronous answers cannot revive a stopped, rebound or replaced session, or release a newer reconciler hold.

Each held pass gets a fresh tmux inventory. Missing waiting panes are allocated with at most four commands in flight; Stop prevents further dispatch. Core reserves the possible stale route owners while allocating, then commits only a safe set of routes synchronously, after rejecting collision chains against the full current registry. No service wait occurs inside a registry transaction. A waiting pane whose ownership cannot be confirmed stays intact with its exact ID logged for review. This is conservative recovery, not deletion of an ambiguous pane.

The original golden's timezone override was corrected in a separate pre-move checkout (`5e950feef`), rerun under UTC, and merged with the move; its fixture bytes did not change. The complete core gate passed with 1,682 tests at 100% statements and branches per covered production file. Harnessd passed 265 tests with one existing skip; architecture/goldens/recovery passed 234; resume passed 292 at 100%; portability passed at its per-file 100% gates. The isolated Store/fork/held-boot lane passed 16 selected cases and crash/race/lifecycle passed 25. Initial resume attempts failed because the test PATH omitted macOS `lsof`, and a 2,050-file fixture and cleanup exceeded default bounds under concurrent coverage. The passing rerun restored `/usr/sbin`, used one resume worker and declared 45-second test/cleanup bounds. A portability loopback cleanup also passed under the explicit cleanup bound after concurrent e2e load ended. The earlier failed run is retained as failed evidence.

The same staged allocation now covers boot and held retries. Accepted waiting routes commit with `launch: held` and `active: false`. Discovery never archives or forgets a held conversation because its waiting shell is absent. Only missing route owners are reserved, and transient core contention schedules a coalesced retry without relying on another service-ready notice. Cycles, cascading allocation failures, out-of-selection collisions, unrelated pins and bounded Stop joins are covered with disposable fixtures, including the real registry.

A final fallback correction preserves `held` even when showing the waiting shell fails or rejects. The row keeps the conversation and both reasons, and the regression proves a later missing-pane allocation can recover it. Independent review approved the full change and this exact final delta; no reviewer edits or test runs were used as implementation evidence.

L3 timing through the final local gates (UTC): implementation began after the crash fix merged at 00:00 and continued through 01:16; independent review ran alongside implementation and validation, with final approval at 01:14. Validation ran from the baseline measurement at 00:11 through final local checks after 01:16, including failed attempts above. The final six-file e2e run occupied 325 seconds; the successful type/core/recovery/resume/portability run occupied roughly four minutes with independent checks overlapped. Waiting for automatic CI and the merge are recorded separately in the PR body. Publication: zero. These phase intervals overlap and are not added to claim the total request duration.

The closure is 58,498 lines in 340 files versus 58,533 in 339 before L3. This is a reference; the added core recovery controls carry the safety guarantees above.


L3 completion: [automatic CI](https://github.com/autonomous-ai/openharness/actions/runs/37869134630) passed all four Linux shards, typecheck, process checks and `ci/required`. The merge receipt verified both trees against reviewed head `8bd244a26` and base `db6eb769c`. Final CI waiting occupied 01:18–01:22:32; the merge helper occupied 01:22:43–01:22:56. Total request time through this merge was 1 hour 56 minutes 15 seconds, including implementation, review, diagnosis and waiting. Nothing was published.

The final L3 measurement used Node 22.23.2, tmux 3.5a and the same Intel macOS machine with 16 logical CPUs and 64 GiB RAM. Four fake agents, two active agents, two windows and four streams ran ten-second empty/idle/active phases with two seconds of warmup and no history. Only the core PID was measured; workers, engines, tmux and USB were excluded. Baseline versus candidate CPU was 0.72/1.51/7.03% versus 0.80/1.70/6.96%; RSS was 80.2/102.3/99.5 MiB versus 81.3/96.4/99.4 MiB. Event-loop p95 stayed about 12.1 ms. Two turns completed in 6.37 versus 6.98 seconds; this sample is too small for a latency claim.

## L2: assignment classification and saved APIs

[PR #1076](https://github.com/autonomous-ai/openharness/pull/1076) is in progress. Commit `a05dc0060` recorded the former classifier, launch round trips, saved endpoint recognition and API instruction bytes before moving them. A separate type-only correction (`60d0cfd85`) left the fixture unchanged. Both platforms are pinned; execution uses UTC and `/tmp`. The golden now crosses the real models handler and both JSON validators. Six deliberately broken contributions are rejected by assertion failures: endpoint marker, model marker, provider argv, Pi config, OpenCode router and API endpoint normalization.

Discovery collects only declared endpoint/model markers and relevant argv fragments, never API keys or the rest of a process environment. Core publishes readiness and bindings before sending classification requests to models. Every completed observation is classified afresh; there is no assignment cache. Identical pending observations share one bounded request so a slow answer cannot be starved by faster discovery passes. Answers are accepted only for the same process, session, lifecycle revision and newest evidence. Unknown reads, invalid replies and unavailable models preserve the last assignment. Reconciler route holds also reject metadata evidence from an obsolete probe. Restart and retarget commit their verified process before scheduling metadata.

Saved API key access and writes remain with models. Core keeps a read-only metadata parser and the existing instruction preparation behavior. A validated endpoint vocabulary is persisted atomically beside the saved APIs, preserving recognition after an endpoint is edited or removed and the models process restarts. It intentionally survives a whole-daemon restart as well. Old version-one files remain readable; malformed or oversized updates leave the previous file intact. A new models process cannot clear assignments if it cannot read this vocabulary. An already initialized process keeps its validated vocabulary through a transient read failure.

The new killed-models boot test exposed an existing shutdown race: an acknowledged binding could still be deferred by an unrelated discovery transaction when the process exited. Regression commit `ccc9fdc25` precedes the fix. Replaying it against the former registry under pinned Node and UTC fails because the saved session ID is empty instead of `just-bound`. Exit-only flushing now validates the entire live table before the existing locked, atomic merge, bypassing transaction batching only at exit. A half-finished pane swap is rejected without changing disk bytes. Core flushes before graceful shutdown work and at synchronous process exit. Ordinary and strict-close transaction behavior is unchanged.

Validation plan: typecheck; architecture and unchanged golden; core and harnessd coverage; affected discovery, API, registry, models and backend specs; resume and portability coverage; real-tmux discovery; isolated machine, core, lifecycle and killed/hung-models e2e. Final gates follow integration with current main. Initial core and harnessd gates passed, but the combined affected receipt failed on an obsolete test stub and is not passing evidence. The first e2e receipt passed core/lifecycle and two models cases; it failed one fixture that used an intentionally ignored unowned tmux session and the genuine shutdown race above. The fixture now creates a registered terminal first. Final counts and review evidence are recorded when these gates complete.

L2 timing: golden recording and implementation began after the L3 merge at 01:22:56 UTC. Independent review identified endpoint recognition after worker restart, slow-request starvation and held-route evidence races; all three were corrected before final validation. Implementation and review continued through 01:50. Publication remains zero.


L2 integrated main `d364ca98e` before final gates; its CLI launch/account/retention changes were reviewed with the assignment move. Receipt `20261009T015141.373083Z-17943` passed typecheck, 1,704 core tests at per-file 100% coverage, 265 harnessd tests with one existing skip, and 477 affected tests in 17 files. Receipt `20261009T015303.584859Z-32741` passed 292 resume tests, 1,050 portability tests with nine skips at their 100% gates, and 57 real-tmux tests with 15 unavailable-engine skips. The e2e receipt passed all 16 core/lifecycle and six machine tests, plus three models cases, but failed the new assignment-recovery case and remains failed evidence.

That remaining failure was traced to the fake engine's `process.title` rewrite: macOS `ps eww` returned its title with no environment, although the fixture inherited both endpoint and model. Core correctly treated that as unknown. The evidence test now opts into retaining the interpreter and real engine entrypoint, which discovery recognizes on both platforms. It does not weaken the production unknown-read rule. Independent review's final startup finding was also corrected: the exit listener is installed immediately after registry ownership/load, before startup yields, covering a staged update before full teardown exists. The new startup-order regression fails on the former placement and passes after the move. Final validation follows these narrow corrections; publication remains zero.

L2 completed at 02:17:24 UTC as merge `67c2e52b7` ([#1076](https://github.com/autonomous-ai/openharness/pull/1076)). Final head `2e28b47d3` and base `d364ca98e` received independent approval. Automatic CI [37873262697](https://github.com/autonomous-ai/openharness/actions/runs/37873262697) passed all Linux shards, typecheck, process checks and `ci/required`. The merge receipt verified both the reviewed target and full tested tree. Final local receipts passed 1,704 core tests at per-file 100%, 265 harnessd tests with one existing skip at 100%, 489 affected tests, 292 resume tests, 1,050 portability tests with nine skips at 100%, and 57 real-tmux tests with 15 unavailable-engine skips. All four selected models outage/held-boot cases passed. The earlier failed e2e receipt is not passing evidence; its core/lifecycle and machine lanes passed on identical production source, with only the models fixture corrected afterward.

L2 implementation and diagnosis ended at 02:09:44; final review finished at 02:10. Final local validation occupied 02:09:44–02:13:54, CI waiting ended at 02:14:51, measurement ran 02:15:25–02:16:36, and the merge helper ran 02:17:11–02:17:24. L2 elapsed time was 54 minutes 28 seconds; the whole request through that merge took 2 hours 50 minutes 43 seconds. These overlapping phases are not added. Publication remains zero.

The matched L2 measurement used the L3 machine, toolchain and four-agent workload above. Empty/idle/active core CPU was 0.69/1.12/7.66%, RSS 80.4/101.0/97.4 MiB, and event-loop p95 about 12.1 ms. Two-turn p95 was 6.986 seconds versus L3's 6.980 seconds. The short sample supports no latency or long-term memory claim.

## Item 5: usage observations

Former-code commit `12d6b640b` records external session/adoption and usage goldens before either move. Both pin Darwin and Linux, UTC and private `/tmp` fixtures. The usage golden stays unchanged while its composition now crosses the real service reader, JSON serialization and both wire validators. External-session implementation remains unchanged for the next PR; its admission move also needs durable holds and precise process ownership.

Usage transcript, SQLite and private checkpoint reads belong to the usage service. Core frames read a bounded aggregate mirror with no I/O or service wait. The mirror allows four requests at once and 512 targets, coalesces transcript events, and has no recurring idle poll. Replies belong to the full immutable read target and connection epoch; one pending request per target preserves order. Rebinding starts unknown. Service loss, unreadable sources, capacity exhaustion and invalid replies preserve the last same-identity value. Reconnect refreshes even an unchanged warm worker. Aggregate values are copied, URLs and paths are bounded, and each snapshot is limited to 256 KiB. Services receive copies for current owned targets, including rows whose nullable fields are omitted.

Independent review identified starvation when continuous same-target events invalidated pending reads, omitted-field rejection in inline project readers, unbounded PR URLs, and a reader-capacity refusal that looked like a valid null. Each is corrected with a regression. Same-target progress is published while a later refresh is pending; identity changes still discard old replies. Checkpoint filenames remain compatible. In-memory reader entries additionally include the complete read target so concurrent target changes cannot mutate an in-flight read.

Validation selected before execution: typecheck, architecture, unchanged goldens and mutations, core/harnessd 100% gates, affected frame/usage/Git/backend specs, and isolated usage, edge and services e2e. Initial core validation passed 1,713 tests at 100%; affected validation failed two old backend fixtures that still composed usage as a service without a port. Initial usage e2e failed fixture assumptions: Stop's RPC is `agent_delete`, and transcript attachment can follow session binding. The existing five edge and fourteen services cases passed. Failed receipts remain failed; final evidence follows the corrections. No release is authorized or attempted.


### Usage completed

[PR #1078](https://github.com/autonomous-ai/openharness/pull/1078) merged after independent approval of head `e8e98bb22` against base `f5c0f2979`, and [automatic CI](https://github.com/autonomous-ai/openharness/actions/runs/37877120111) passed every selected check including `ci/required`. The final main integration changed only pnpm's lock entries for pngjs packages already declared in package.json and npm's lock; the local tested production, tests and installed npm dependencies stayed identical.

The unchanged former-code usage golden crosses the production service and wire validators. Six deliberate wiring mutations fail assertions. Final local gates passed 1,716 core tests at per-file 100% statements and branches, 265 harnessd tests at 100% with one existing skip, typecheck, architecture and 410 affected specs (`20261009T025300.053066Z-85987`). Three isolated usage e2e cases passed in 73.7 seconds (`20261009T025258.053880Z-85910`), covering unavailable boot, recovery, stopped work, a replacement core receiving an unchanged warm snapshot, and explicit inline mode. The prior warm-worker case failed because it connected after core spawn but before socket readiness; the corrected test waits for the new ready event. The failed receipt is not passing evidence. Five edge-host and fourteen service cases had passed earlier; the final production also passed a 93.9-second two-agent soak/chaos smoke, not a claim about long-term growth.

The matched four-agent/two-active performance sample (`20261009T025602.069419Z-2829`, 69.8 seconds) measured core CPU at 0.55/1.50/6.94% of one logical CPU, and mean RSS 82.5/95.9/101.7 MiB across empty/idle/active windows. Loop-delay p95 stayed near 12.1 ms; both turns completed with p95 7.015 seconds. Same Node 22.23.2, Intel macOS, 16 logical CPUs, 64 GiB, tmux 3.5a, two windows/four streams, ten-second phases, two-second warmup and no history as the L2 baseline. This small fake-engine sample excludes service, engine, tmux and USB costs and sets no threshold.

Time accounting (UTC): production and review corrections through 02:44; the final test-only readiness correction at 02:52. Final local checks ran 02:52:58–about 02:55; performance ran 02:56:02–02:57:12. Main advanced with a lockfile correction; integration and independent review completed about 03:00. Final CI waiting ended about 03:03; the merge helper started at 03:03:27. Request time since 23:26:41 includes all diagnosis, implementation, review and waiting, not just Actions. Publication remains zero.

## Item 5: external sessions

PR [#1081](https://github.com/autonomous-ai/openharness/pull/1081) moves provider and process observations into search, including when SQLite indexing is unavailable. Core retains policy, alias reservations, verified signals, durable admission, cancellation and dispatch. An unavailable reader leaves an inert held pane with a reason. Once admitted, crash restore and Stop/Open use the core's exact conversation identity without search.

Former-code owner-control golden commit `7972e9824` supplements the existing external golden before the move; both fixture files remain unchanged. The new safety rules have separate regression tests. Seven mutations fail assertions: missing owner/busy observations, archived admission, missing Hermes profile, alias reservation loss, suppressed launch and omitted dispatch journal. These checks use pinned platforms, UTC, `/tmp`, and placeholder binaries. The retained former owner-control golden covers the extracted primitive; the new controller's tighter signal fences have direct tests.

Validation selected before final execution: typecheck; architecture and unchanged goldens; core and harnessd per-file 100% gates; resume and portability gates; provider, persistence, restore and real private-tmux tests; isolated adoption, machine, core, lifecycle and search/service e2e; a short process-boundary soak/chaos smoke and the matched four-agent performance sample. Full Linux unit coverage comes from automatic PR CI. Preliminary full-core tests passed but coverage was incomplete; added boundary tests reach 100% in the focused run. The provider diagnostic initially failed an invalid Devin test command (`resume` instead of `-r`); the corrected four-file diagnostic passes 105 tests. Final receipts and independent approval are still pending.

Independent review of the initial checkpoint found races across the pane probe and owner reads, omitted strict-resume forwarding through restart/retarget, incomplete or ambiguous owner records, and a provisional reservation vetoing a real binding. Regression commit `0d992f216` reproduces twelve failures before corrections. The corrected service rereads exact ownership after activity and terminal observations. Ambiguous live engine records and argv-only ownership hold admission. Core checks current bindings and stopped reservations at every signal/journal boundary; verified binding remains independent of search. Provisional and owned reservations are validated separately, while every strict adoption transition still excludes a foreign owner.

The first broad receipt passed core/harnessd/resume/portability coverage but failed one stale startup-order expectation; automatic CI failed the same expectation. The initial control/service e2e run passed 54 cases and failed two inline-search cases because an internal request was returned as a public handler. That wiring is corrected: inline inspection uses the port and only the process wrapper declares the private request. These failed receipts are not passing evidence. Isolating the real tmux fixture with a private home and an empty startup config exposed a vanished-pane cancellation edge; authoritative inventory now makes the repeated close idempotent. All seven wiring mutations still fail assertions after these corrections.

The second review tightened the authority to signal further. A final coherent ownership/activity record is required for idle consent. Unknown activity stays held for idle/wait and cannot generate a continuation prompt under explicit takeover. Every signal, including KILL after the TERM grace period, takes the strict durable reservation check even for an unchanged intent. Same-PID claims for unrelated conversations and Codex-prefix helper processes cannot become stoppable exact owners. Regression tests cross the real registry and controller with synthetic OS signals. The new search request typing and two early-return coverage gaps found in the final gate are corrected; the failed combined receipt remains failed. Its affected, harnessd, resume and portability checks passed, and both adoption plus the two corrected inline-search e2e cases passed separately.

Independent review approved production head `1aced4484` against main `e130ad8e1`, including the coherent activity proof, per-signal durable reservation check, contradictory owner claims and real engine process identity. The final main integration changes no CLI source. Automatic CI [37887475290](https://github.com/autonomous-ai/openharness/actions/runs/37887475290) passed every selected check including `ci/required`.

Final broad receipt `20261009T051228.567255Z-74018` passed typecheck, 1,785 core tests at per-file 100% statements and branches, 265 harnessd tests with one existing skip at 100%, 1,004 affected tests including architecture and the unchanged goldens, 298 resume tests at 100%, and the portability gate at 100%. The two corrected inline-search e2e cases passed. The new strict restart case initially requested a second pane operation before adoption committed its route; its test-only correction completes one private turn first and passes in isolation. The failed combined e2e receipt remains failed. The final adoption lane is rerun after that correction; broad production evidence remains applicable because the final change touches only that test and this note.

A two-agent soak/chaos smoke passed in 105.0 seconds (`20261009T051533.050394Z-3315`). The matched performance run passed in 70.7 seconds (`20261009T051852.532251Z-32229`): empty/idle/active core CPU was 0.75/1.65/6.91% of one logical CPU, mean RSS 81.2/95.1/98.8 MiB and event-loop p95 11.07/11.08/11.12 ms. Both turns completed with p95 6.976 seconds. The preceding usage baseline was 0.55/1.50/6.94%, 82.5/95.9/101.7 MiB and 7.015 seconds, on the same Node, machine, tmux and four-agent/two-active workload. These ten-second windows measure only the core PID, exclude services, engines, tmux and USB, and support neither a new threshold nor a long-term growth claim.

Time accounting (UTC): implementation and diagnosis began after the usage merge at 03:03:42 and production corrections ended at 05:11. Independent production approval followed at about 05:13; the final test-only readiness correction passed at 05:14. Final broad local validation ran 05:12:28–05:17:21, overlapping the short soak/chaos run. The matched measurement ran 05:18:52–05:20:03. Final delta receipt `20261009T052103.008133Z-46578` passed typecheck and both adoption cases in 51.7 seconds. Independent review approved final head `371910cf4` against `e130ad8e1`; [final automatic CI](https://github.com/autonomous-ai/openharness/actions/runs/37888168905) passed all selected checks including `ci/required`. PR #1081 merged as `4cad218c9` at 05:26:10. The merge helper ran 05:25:56–05:26:10; CI waiting ended about 05:25:45. This item took 2 hours 22 minutes 28 seconds; the whole request through that merge took 5 hours 59 minutes 29 seconds. All daemons, homes and tmux servers used for testing are disposable. Publication remains zero.

## Item 6: native runtime readers

[PR #1088](https://github.com/autonomous-ai/openharness/pull/1088) removes the legacy
manager. Former-code commit `996476cf0` recorded 482 other-engine observations and
the public state/control answers on pinned Linux and Darwin. Both fixture files
remain unchanged. The eager owner keeps accepted state, control, waiters and
cleanup; engine facets keep native catalogs, targets and interpretation. Other
engines remain display-only, with the six unreachable drivers retained.

Independent review required monotonic evidence revisions, current registry-row
checks, atomic local parser/profile installation after config and tail-hold
validation, and containment of optional cleanup. It then found the complete
start/cancel control cycle and late cleanup after forget. These were reproduced
and corrected; review approved `08fc7d1fa` against `79c658faa`. The final Linux
shard exposed an old Command Code fixture delivering records before loading the
reader. Matching production ordering then reproduced a queued-refresh race:
a queued read could revoke the explicit config read its caller awaited. The
queue now checks its original read token; core control and confirmation revoke
that token too. Repeated same-model records in one watcher batch preserve the
dependent refresh, which reads the latest accepted model. New tests
cover explicit-read and confirmation supersession; final review/CI are pending.

On `08fc7d1fa`, typecheck, architecture, 1,789 core tests at per-file 100%, 265
harnessd tests with one existing skip at 100%, 1,770 affected tests with seven
existing skips, and 298 resume tests at 100% passed. The resume run first timed
out in the existing 2,050-file fixture under concurrent load; the passing run
used the previously established one-worker/45-second limits. The attempted
receipt reuse did not match the inherited environment and reran checks; that
cost is included in elapsed validation, not hidden. All sixteen wiring mutations
failed golden assertions. The final three state-owner mutations were repeated;
one first hit the five-second compilation deadline, then all three failed the
required assertions with explicit test deadlines. A two-agent half-minute soak
and half-minute chaos smoke passed in 101.7 seconds. Final receipts and landing
times will be recorded after the CI correction is reviewed and validated.

## Added core follow-ups

Item 6 completed as `a9895b02c` at 06:23:02 UTC. Independent review approved
`3af878758` against `79c658faa`; [automatic CI](https://github.com/autonomous-ai/openharness/actions/runs/37892739470)
passed all selected checks and `ci/required`. Final receipt
`20261009T061719.342956Z-78031` passed typecheck, core/harnessd at per-file 100%,
and 622 directly affected tests including architecture and both unchanged goldens.
The broader preceding run passed 1,780 tests with seven existing skips. Full
reader/model/lean/crash lanes passed 28 selected cases; the final rebuilt lean
bundle passed its two cases. The final queue correction changes only dependent
Command Code refresh ordering, covered by the real config and batch regressions.

Matched final measurement `20261009T061834.097319Z-84262` passed in 69.7 seconds:
empty/idle/active CPU 0.75/1.65/6.81%, mean RSS 81.2/95.7/98.9 MiB, event-loop
p95 12.07/12.07/12.06 ms, and two-turn latency p95 6.979 seconds. The baseline
above was 0.75/1.65/6.91%, 81.2/95.1/98.8 MiB and 6.976 seconds, on the same
toolchain and workload. These are short core-only observations, not a new limit.

Runtime timing: golden committed 05:26:02; implementation/review corrections
continued through 06:16; final review approved at 06:17. Local checks ended about
06:18. Measurement ran 06:18:47–06:19:44; CI finished 06:21:19. The merge helper
ran 06:22:48–06:23:02 and verified the full tested tree. Golden commit through
merge took 57 minutes; total request elapsed was 6 hours 56 minutes 21 seconds.
Validation, implementation and review overlap; waiting and merge are separate.
Publication remains zero.

Pane profile polling also needs a session/route snapshot taken before capture:
the entry-time check cannot reject an older screen if the same registry object
changed in place during the capture. This pre-existing limitation is independent
of the runtime extraction's config and staged-history publication checks.

The owner reported that two panes of the same agent started in one millisecond
fail. Onboarding avoids it today. Regressions committed in `be3ed36e1` reproduce
both the duplicate label and a real tmux `duplicate session` failure with two
concurrent private panes. The shared generator now appends a random UUID to the
existing engine/timestamp prefix, avoiding same-clock collisions across calls,
daemon processes and restarts. Discovery still accepts both old and new names;
existing panes are neither renamed nor removed. All native fixtures use private
homes, shell history and sockets. Final validation and review are pending.


## Later follow-ups and remaining safety work

The same-millisecond label fix landed in [#1091](https://github.com/autonomous-ai/openharness/pull/1091).
The capture authority fence landed in [#1093](https://github.com/autonomous-ai/openharness/pull/1093).
Kilo and Hermes adoption/control boundaries landed in [#1095](https://github.com/autonomous-ai/openharness/pull/1095)
and [#1097](https://github.com/autonomous-ai/openharness/pull/1097).
Eager native identity and Muse/Pi repair landed in [#1104](https://github.com/autonomous-ai/openharness/pull/1104)
and [#1106](https://github.com/autonomous-ai/openharness/pull/1106).
OpenCode's version/model control extraction landed in [#1110](https://github.com/autonomous-ai/openharness/pull/1110)
as `ee33093971d27e9dcda7f2ae8c35f54b61cec0bb` at 11:30:10 UTC, with all automatic checks and independent review.
Their detailed evidence is in the dated identity, repair, capture, Kilo and OpenCode notes beside this one.
No release has occurred.

The six original phases have landed. The architectural bar is not complete. Native hook installation now
has its own [golden-first extraction and fault evidence](2026-10-09-native-hook-installation.md).
The required next work is bounded asynchronous executable/version preparation, explicit held preparation
and durable launch intent, retarget authority across native writes, unreadable/unconfirmed native mutation
handling, and the OpenCode v2 Close checkpoint audit. The precise gaps are recorded in
[OpenCode control](2026-10-09-opencode-control.md). Remaining shared-control work includes bounded identity
scans, Cursor pending-task persistence, agy turn backstop/control facts, input verification declarations,
and the final unavailable-service/readiness audit. Line counts do not establish any of those properties.

## Native locations and retry isolation

[PR #1118](https://github.com/autonomous-ai/openharness/pull/1118) bounds exact Cursor/Grok locations and Copilot/agy process claims, rejects incomplete or changing evidence, and retains/retries failed bindings and pending transcript discovery without blocking siblings. The [implementation, independent review corrections, validation and measured cost](2026-10-09-native-location-discovery.md) are recorded separately. Former-code golden artifacts remain unchanged and all 21 broken-wiring variants assertion-fail. Native identity as a whole remains open in the completion checklist: exact resume/legacy records, saved-home catalogs, Hermes pools and shared visible hold state still need completion.

## Fresh Hermes stores and retained Stop homes

[PR #1120](https://github.com/autonomous-ai/openharness/pull/1120) merged as `a847441e5` at 16:39:44 UTC on October 9. Fresh complete native pools hold unreadable, ambiguous, oversized or changing evidence; Stop preserves the proven home. The [report](2026-10-09-hermes-store-pools.md) contains the unchanged golden, 27 assertion-failing mutants, full coverage/native acceptance and matched cost. Final source had independent exact-head/base approval and every automatic head check, including `ci/required`. Implementation/review corrections ended at 15:52, local acceptance and cost by 15:57, and final documentation review at 16:00. CI waiting and integration extended to 16:39 after the recorded legacy-golden safety correction and three documentation-only main advances. The merge helper ran 16:39:30–16:39:44. Publication remains zero. Native identity as a group remains open; exact resume is next, followed by legacy records, saved-home failure handling and shared hold visibility.


## Native descriptor evidence and durable home adoption

[PR #1131](https://github.com/autonomous-ai/openharness/pull/1131) merged as `9eafacf3b512a0b1ffd23e0d446115896b01f7ed` on October 10 at 00:33:06 UTC. Its [report](2026-10-09-native-descriptor-evidence.md) records the unchanged 29-observation golden, 21 assertion-failing mutations, native/private acceptance, full coverage, 150 matched cost samples, and exact-head/base independent review. Automatic CI run `38008750415` completed all applicable checks including `ci/required`. Merge verification ran 00:32:53–00:33:06. No release occurred.

The owner resumed the paused task on October 9 at 22:25:51 UTC. [Durable home adoption](2026-10-10-durable-home-adoption.md) landed in [#1132](https://github.com/autonomous-ai/openharness/pull/1132) as `c7d460b1d8018ed56126c662702fd44db886d07d` at October 10 01:43:24 UTC. Independent review approved exact head `7ae6c83921b76733e96db70a0948c73ff1b55e70` against base `9eafacf3b512a0b1ffd23e0d446115896b01f7ed`. Automatic run `38013783062` passed every applicable check including `ci/required`. Final local validation ran 01:35:58–01:38:38; composed resume and large-transcript checks ran alone 01:40:42–01:41:56. Merge verification ran 01:43:11–01:43:24. Publication remains zero.

Work continues on [saved-binding evidence and recovery](2026-10-10-saved-binding-evidence.md). This is not a claim that the native-identity group or complete refactor is finished.

## Saved binding and atomic hook admission

[PR #1133](https://github.com/autonomous-ai/openharness/pull/1133) landed saved-binding
evidence and visible recovery as `a2a7874f3` at October 10 05:16:31 UTC.
[PR #1137](https://github.com/autonomous-ai/openharness/pull/1137) then landed atomic
native hook admission and live Stop ownership as `9618c2e2c` at 08:36:54 UTC. The
[hook admission report](2026-10-10-native-hook-admission.md) records exact-head review,
unchanged goldens, mutation proofs, costs, acceptance and automatic CI. The guarded
merge occupied 08:36:40–08:36:54; publication remains zero.

The next [Stop/Resume/Close authority change](2026-10-10-control-transcript-authority.md)
has independent source approval and passing unit, core, harnessd and Resume gates;
private lifecycle acceptance, mutation checks, costs and final CI remain under way.
The [completion checklist](2026-10-09-daemon-core-completion.md) still tracks durable
delivery/lifecycle intent and the other concrete architecture gaps.

## October 10: native transcript authority landed

PR #1139 merged as `d852e1d9998e939ec40f3d52d864e1717e74d8ae` after independent
review of `74afc203000c8504dcb88cfb91454f3a894f1968` against main
`526d6bb9d081a5e8afbefd21ddefb28586570adc`. The guarded merge receipt started at
10:03:54 UTC and confirms that the reviewed and tested trees match the squash.
[Automatic CI](https://github.com/autonomous-ai/openharness/actions/runs/38043296667)
passes all four Linux shards, typecheck, process checks and `ci/required`. Private
acceptance passed all 74 cases in six lanes in 694.3 seconds. Core/services and
harnessd retain 100% coverage; serial Resume passed 602 cases with 100% coverage.
Both new healthy goldens remain unchanged; 30 wiring faults fail by assertion.

The initial CI's legacy fixtures were corrected without product-code changes: two
purge fixtures now supply a native header, and two explicitly named unsafe capture
answers now require a typed hold with unchanged inputs. The final fixture delta
passed typecheck and its 18 affected tests; CI covers the complete final source.
Independent review approved the exact final head and the declared evidence reuse.
Implementation, validation, CI/review waiting and guarded merge remain separate
intervals; overlap is not summed into an elapsed duration. No release or publication.

Reviewed native-history deletion is the next isolated migration. The recorded native
consumer golden also preserves the former handoff behavior for its subsequent move.
