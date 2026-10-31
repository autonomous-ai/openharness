# Finished-worker decisions implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

> Replaced by [2026-10-30-project-instructions-design.md](2026-10-30-project-instructions-design.md): the instruction document and agents' direct messages
> replace what this describes. Replaced in part: the keep, reuse and stop decision, the host's stop handling and the slot return stay; holding routing, starts and assignments while a finished worker awaits a decision goes.

**Goal:** Require the Lead to reuse, keep or stop each finished worker; stopping closes its native session and returns its machine slot.

**Architecture:** Persist the decision on the Swarm agent, independently of the group's replaceable assignment. The backend gates new routing, starting and assignment. The execution host consumes stop requests through the existing identity-bound core lifecycle, including its service-process bridge, and confirms removal through the command transaction, which also cancels deliveries. A global SuperTabRun reservation prevents another public Swarm from assigning the same native session during close. A pending stop cannot be reassigned. An owner or contributor can withdraw a stuck stop with normal Remove; this clears its work reservation and retires that native ID only in this Swarm. Native capacity remains reserved until host stop proof. A separate two-minute close lease protects other Swarms from an already-running close; completion or expiry permits reuse elsewhere. Native core closure accepts only the original recorded Swarm launch and refuses personally resumed sessions throughout saving/stopping.

**Tech stack:** Existing TypeScript, Zod, Prisma/MongoDB, Vitest and Flutter. No new dependencies.

**Spec:** The Lead's brief in this group's assignment: finished work requires reuse, keep or stop; only the project's Lead or the tab owner/contributor decides; active work is never stopped; host-confirmed removal frees slots. Deliver a draft PR only.

## Global constraints

- Work from current origin/main; keep changes within worker release ownership and its necessary model/tests.
- Product = Swarm; coordinating role = Lead; visible copy in plain English.
- CLI tests use Node 24 and disposable data; never touch port 18473, the real tmux or personal agent homes.
- Keep older clients compatible through optional fields; explain unsupported commands from older backends plainly.
- No new dependencies. Do not mark the PR ready, merge or release.
- Preserve the 2,000 UTF-16-unit launch prompt limit and adjacent groups' changes.

## Review focus

- Stop requests remain irreversible until removal; reuse cannot race host closure.
- Decisions survive replacing a brief or archiving the finished group.
- Only the execution host can acknowledge physical stopping. A person may administratively withdraw a stuck stop; an agent cannot impersonate that withdrawal.
- Repeated host polls and lost acknowledgements never close a replacement session or close the same session twice.
- Removing the agent cancels outstanding deliveries. Capacity is released only by host stop evidence; person withdrawal retains its native reservation.

### Task 1: Backend policy and state

**Files:** backend/src/superTabs/model.ts, commands.ts, machines.ts; commands.test.ts, machines.test.ts.

**Interfaces:** Optional agent decision tied to the finished assignment; helpers compute pending decisions by project and reject new work; agent.release accepts keep/stop. A host acknowledgement uses the existing agent.remove command and exact release token. The owner or contributor can use ordinary agent.remove to withdraw a stuck stop without falsely confirming physical closure.

- [x] Add tests for Lead/owner/contributor permissions, active-work refusal, pending guards, keep/reuse/stop, brief replacement and host acknowledgement.
- [x] Run affected tests and observe failures caused by the missing behavior.
- [x] Implement persistence on completion, project guards and irreversible stop requests; expose pending decisions in status.
- [x] Verify affected backend tests pass.

### Task 2: Host lifecycle and integration

**Files:** backend/src/superTabs/store.ts, backend/integration/superTabs.test.ts; cli/src/superTabs/host.ts, host.spec.ts; cli/src/core/api.ts, experimentQueries.ts and their tests; cli/src/services/processCoreApi.ts and its tests. Core API additions are kept in a separate commit.

**Interfaces:** Host roster exposes stop requests only without active work. The CLI passes the creation receipt, native session ID and creation time recorded by agent.started to core.agents.closeSwarm. Core checks agent ownership, the original creation receipt and conversation identity, and refuses personal resume before/after asynchronous lookup and throughout the lifecycle. An authoritatively absent native session counts as stopped even without a stopped-history record. Only a positive close result permits host acknowledgement as that agent. The close request carries the exact native session identity and is exposed only to the Swarm service process. Backend host removal requires the current release token, shares cancellation semantics with ordinary withdrawal, and stores a durable stopped-harness receipt independent of replaceable observations. Stop intent refuses any other Swarm membership, including an idle Lead. Session-scope writes serialize contribution and stop transactions. Optional session-scope stopReleaseId and close-lease fields plus default-empty releasedTabIds preserve compatibility with existing Mongo records. A re-contribution reserves a new generation: unversioned late observations cannot prove that its new runtime stopped, even after membership removal. Host polling includes withdrawn reservations; matching generation-stamped stop observations retire them and persist durable physical-stop proof.

- [x] Add failing tests for host stop pickup, safe retry, refusal/unavailable lifecycle, foreign sessions and slot release through real Mongo transactions.
- [x] Implement stop pickup outside native delivery; withhold new input for stop-requested agents.
- [x] Verify host tests and backend integration pass, including cancelled deliveries and slot counts.

### Task 3: Guidance, validation and delivery

**Files:** cli/src/superTabs/service.ts (release HELP and compatibility only), desktop/lib/super_tabs/launch_prompt.dart, affected tests.

**Interfaces:** HELP lists keep/stop and recommends stopping unless more work is imminent; launch/delivery guidance tells the Lead to decide after completion.

- [x] Add failing tests for release HELP, older-backend error and launch prompt wording/length.
- [x] Implement guidance and plain unsupported-command error.
- [x] Run CLI npm run test:super-tabs (100% coverage), npm run typecheck and affected host/service tests; backend npx tsc --noEmit, vitest run src/superTabs and npm run test:super-tabs; desktop flutter analyze and affected launch tests. Run required full component suites once with bounded workers, recording unavailable or baseline failures explicitly.
- [x] Review the final diff independently; fix material findings and verify affected checks.
- [x] Fetch/rebase current main, inspect new interactions and repeat only invalidated checks. Commit/push the reviewed changes and open a draft PR with exact evidence and timing. Report its URL and head revision.


## Earlier review validation (superseded by final review below)

Earlier validated source: `5f5595e53`, rebased cleanly on current main `f1a67cd22`. The final evidence-only commit does not change component inputs. Node 24.3.0, locked npm dependencies, disposable MongoDB 7.0.24 replica set; Flutter 3.47.5 / Dart 3.13.4 on macOS arm64. Tested component trees: CLI `ef737f3b94e7ff1f67b55f2f2920267f1e0c9d3e`, backend `0ab259684dc680db212ece9e595d4a3d0bffd817`, Desktop `b50fcb14523b4af8c98a7f3c7fe8907536ce737e`.

Every requested review correction had a failing regression before its implementation:

1. Maximum-length 160-character IDs made the Lead prompt 2,054 units and exposed dropped reporting instructions. It is now 1,991, restores “read new reports” and “No per-turn summarizer”, and preserves the worker-release instruction.
2. An offline/old host or deleted native session could leave a permanent stop reservation. Ordinary person Remove now withdraws the stuck contribution, releases its global reservation, and retires its old native ID against future Swarm work. An agent Lead cannot force-withdraw it. Core treats an absent native row as already gone.
3. A worker that also leads another Swarm could be closed. Stop now refuses any other membership; serialized session-scope writes fence concurrent recontribution.
4. A generic core close could stop a personal or replacement session. The Swarm-specific bridge verifies the recorded original creation/session identity, preserves personally contributed and resumed sessions, and carries its original-launch guard through save/stop boundaries and job deduplication. Old backends accept a fallback join without identity; those live sessions require person withdrawal.
5. Route selection of the awaiting worker itself now gets the direct-reuse exemption.

Follow-up independent review found personal-resume and late stopped-observation gaps. Regressions reproduced both; durable recontribution history also covers repeated removal/re-addition. Final read-only review at `5f5595e53` found no remaining material findings.

| Scope | Command | Observed result |
| --- | --- | --- |
| CLI routing coverage | `npm run test:super-tabs` | 111 pass; all four measures 100% |
| CLI types | `npm run typecheck` | Pass after rebase |
| CLI affected Swarm/core/process/native close tests | `vitest run src/core/api.spec.ts src/lib/closeAgentService.spec.ts src/superTabs src/services/processCoreApi.spec.ts src/core/experimentQueries.spec.ts` | 490 pass |
| CLI core/services | `npm run test:core -- --maxWorkers=3 --testTimeout=15000` | 2,945 pass; changed core/service files 100% in all measures. Gate nonzero only on unchanged osDevice.ts:181 (99.16% lines, 99.31% branches, 97.22% functions, 99.37% statements) |
| CLI native E2E | `E2E_BUNDLE=1 vitest run --config vitest.e2e.config.ts e2e/superTabs.e2e.ts` | Pass on rebased source in 74.48s (49.91s test); real private daemon/service process/tmux with fake Claude/Codex; original Swarm launch removed, personal session and Lead preserved, deleted session without stopped record removed |
| Backend types | `npx tsc --noEmit` | Pass after rebase |
| Backend Swarm unit tests | `NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=<fixture> vitest run src/superTabs` | 114 pass before rebase; complete suite below covers integrated source |
| Backend integration | `npm run test:super-tabs` | 64 pass on final rebased source |
| Backend complete unit suite | `npm test -- --maxWorkers=3` | 1,697 pass, 11 skipped on final rebased source |
| Desktop bootstrap/launch | `flutter test --no-pub --concurrency=2 --timeout=60s test/super_tab_startup_recovery_test.dart test/super_tab_launch_test.dart` | 49 pass, including maximum IDs and reporting wording |
| Desktop affected analyzer | `flutter analyze --no-pub lib/super_tabs/launch_prompt.dart test/super_tab_startup_recovery_test.dart` | No issues |
| Desktop complete analyzer | `flutter analyze` | Prior receipt: 44 diagnostics in unchanged files (5 unused-import warnings, 39 infos), no errors; nonzero |

The first review-fix core attempt collided with coverage cleanup from a parallel coverage run; it produced no valid receipt. A sandboxed attempt could not open disposable loopback listeners. An unsandboxed attempt hit an unchanged held-launch test's 5-second timeout; its isolated 25 tests passed. The recorded retry allows 15 seconds for that fake-timer loop and preserves all coverage thresholds.

The original full CLI `npm test -- --maxWorkers=4` run was stopped at its ten-minute budget. It encountered failures in unchanged `sessionRepair.spec.ts`, `stoppedAgents.spec.ts`, `storePool.spec.ts`, `exactTranscript.spec.ts`, `nativeDescriptors.golden.spec.ts`, `messages/rpc.spec.ts` and `publishedGridConfig.spec.ts`. New regressions were added during that broad run, so it is incomplete and is not a final-source pass. Stable affected tests, core results, types, routing coverage and native E2E are separate receipts. No required gate was lowered or silently skipped.

Timing (UTC): initial explicit Go 03:48; draft publication 04:14, first handover 04:17 (29 minutes total, including overlapping implementation/review/validation). Review-fix implementation, follow-up review and validation continued in the same request; final publication timing is recorded in the shared handover. No merge or release occurred. PR #1527 remains draft.


## Second review corrections and final validation

Final source is rebased on `9313c4429`, preserving main's five-part delegation and change-driven Machines publisher. The merged maximum-ID Lead prompt is 1,994 units and its 49 bootstrap/launch tests pass. A conflict-resolution syntax error was caught and corrected before final validation.

All three requested regressions failed before implementation:

- A person withdrawing a stuck stop no longer creates physical-stop receipts or frees capacity. Every new contribution records a native slot reservation independently of membership. Person removal retains it; the host continues polling withdrawn IDs, including contributed sessions without start receipts. Re-contribution invalidates old receipts and uses a new generation. Matching host stop proof persists durably, so older running observations cannot resurrect a confirmed released slot, even while old membership remains. Older unversioned hosts may prove a first contribution stopped; renewed reservations conservatively need generation-stamped host proof or the exact host removal acknowledgement.
- Administrative retirement records only the originating tab. Other Swarms can use the contributor's session after any in-flight close finishes or its bounded lease expires. The Lead explicitly approved a two-minute native-close lease. Its completion and expiration paths have transactional regressions. Core enforces the deadline before/after asynchronous receipt lookup and through save/stop callbacks. The host derives its local deadline from request-start time plus the returned duration, so clock skew and network delay cannot extend server authority; a server-clock-skew regression failed first.
- Making a project private skips rebinding stopping agents while preserving historical audience checks and private-scope updates.

| Scope | Final observed result |
| --- | --- |
| CLI `npm run test:super-tabs` | 111 pass; all four coverage measures 100% |
| CLI `npm run typecheck` | Pass |
| CLI affected tests (same command above) | 517 pass |
| CLI `npm run test:core -- --maxWorkers=3 --testTimeout=15000` | 2,946 pass; changed core/service files 100%; unchanged osDevice.ts:181 keeps gate nonzero |
| CLI isolated native E2E (same command above) | 1 pass, 57.27s; real private daemon/service process/backend/tmux, leased original-launch stop, personal session/Lead preserved |
| Backend `npx tsc --noEmit` | Pass |
| Backend `npm test -- --maxWorkers=3` | 1,702 pass, 11 skipped |
| Backend `npm run test:super-tabs` | 68 pass |
| Desktop bootstrap/launch (same two files above) | 49 pass |
| Desktop affected analyzer | No issues |

The earlier full Desktop analyzer diagnostics and incomplete broad CLI baseline remain explicit validation gaps. Component CI is intentionally deferred while this remains a draft. No coverage threshold was lowered. Final source revision, exact component trees, review result and publication time are recorded at delivery.

Final independent read-only review: no remaining material findings.

Final validated source: `d8ef49df645f131bcfc200f3b6e6eea617e3d015`; CLI tree `e0b9dd89a159cd5732cee605a2025acfccb71148`, backend tree `a5318553728bbc76da167b173b2c93f7821a9022`, Desktop tree `eae4b0e36e8cdcb904215870ec4d24a526fbccec`. The evidence-only commit changes none of those inputs.


## Third review: stop retry bounds

The host used to acquire a fresh close lease every second for a stop that could never close. Seven new regressions failed before the fix. The host now checks recorded original-launch identity, current native ownership/resume state and the native creation receipt before any lease write. A definitive ownership/identity refusal disables retries for that exact stop/runtime. Unknown/transient failures back off for 5, 15, 60 and 120 seconds, at most five attempts. The memo key includes native process identity; a changed runtime or disappeared session gets a fresh check. Removed stop requests discard the memo.

An absent process snapshot is not stop proof: the authoritative core confirms absence without a lease. A failed removal acknowledgement similarly rechecks core absence before retrying, without acquiring another lease. This preserves deleted-session cleanup and refuses a personal resume hidden by a stale process snapshot. Tests cover repeated personal/missing-record/replacement sessions, wrong creation receipts, permanent close refusals, unknown receipt reads, timed retry bounds, changed runtimes, absence recovery and lost acknowledgements.

Rebased cleanly on `9142773b0`; main's full-permission starts changed an old E2E refusal expectation. The fixture now uses an invalid Claude codexHome combination to preserve the same pre-dispatch cancellation/replay assertions. No application permission logic changed in this review fix.

Final checks for this review: CLI `vitest run src/superTabs` 383 pass; `npm run test:super-tabs` 111 pass at 100% in all four coverage measures; CLI typecheck pass. After integrating main, backend `vitest run src/superTabs` 125 pass, backend integration 68 pass and backend types pass; Desktop bootstrap/launch/Machines 79 pass. Native E2E and full Desktop analyzer results are recorded below once complete. Prior core coverage/full backend evidence is reused only for its unchanged scope; the unchanged coverage/broad CLI baseline gaps remain explicit.

Independent read-only review of `5a4d9caeb`: no material findings. Two additional regressions for transient receipt reads and lost-ack authoritative absence also pass in the final 383-test run.

Third-review final native E2E: 1 pass in58.45s (42.02s test), real disposable daemon/service process/backend/tmux. Full Desktop analyzer refreshed:44 diagnostics (5 warnings,39infos), no errors; same unchanged baseline. No core/service implementation changed in this review; its earlier2,946-test coverage receipt remains scoped to unchanged core/services. No coverage threshold was lowered.

Third-review validated source: `c04a8a880b6308c33849e32277e9b72037c96ed2`; CLI tree `65954bc5471951345e651a30d47980f3549be866`, backend tree `472bd37bd0cbd699a23fff815fc436d568c40f99`, Desktop tree `73fc6a9b30e128234fea74789797eec7efc2aee1`. Final evidence-only commit changes none of these inputs.
