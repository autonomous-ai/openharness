# Idle Buddies sleep and wake implementation plan

> Implement natively, task by task, with a committed failing test before each production change and one independent review of the finished branch.

**Goal:** Idle Buddies release their running sessions after an hour and resume for their person's message or an authorized question about their proposal.

**Architecture:** Reuse the server-owned agent `asleep` mark and the host's existing rest/resume path. A bounded optional machine report proves which Buddy sessions are idle; the server checks the report, project switch, current identity, idle time, active work and pending deliveries. Numbering an authorized message wakes its Buddy recipients in the same guarded write. A host rechecks engine activity before rest and reopens a managed Buddy only after the server clears its asleep mark.

**Tech Stack:** TypeScript, existing Prisma/MongoDB parts transactions, Vitest, fake CLI core and real local MongoDB integration tests.

**Spec:** `docs/plans/2026-11-06-buddy-board-final-spec.md`, Many Buddies and Phase 2; task #3824.

## Global Constraints

- Projects not switched behave as today. Server enforces rights and identity remains the person's.
- One hour idle (`SLEEP_IDLE_MS`), same as crew. A busy Buddy never closes.
- Only the main Buddy sleeps here; thread-session lifecycle remains its existing host path.
- A Swarm-wide Buddy may sleep only when all projects its person can read are switched; this avoids changing an unswitched project's Buddy behavior. A project Buddy requires its project switched.
- Team-account sessions stay awake: their current close destroys the data a resume needs (existing crew safeguard). No changes to Team purge or identity.
- Preserve the Buddy home and engine conversation during rest. Long-term folder cleanup is not part of this task's memory/quota lifecycle; no new deletion path.
- No new collections, indexes, runtime dependencies, timers or whole-state polling. Optional fields are backend-first and absent on older reports.
- Keep each completed task pushed. Automatic PR CI runs the whole suites; locally run affected checks only.

## Design

- Growth: one bounded idle-session list on an existing machine part, replaced per report; existing asleep field on the agent, cleared on wake/removal. No content or credentials stored.
- Concurrency: the report's sleep decision guards Buddy, home group, member and project parts; every authorized delivery guards its Buddy even when already awake, meeting concurrent sleep. Pending deliveries checked by the existing tab/agent/status index. A host checks live engine state before closing.
- Read cost: one existing machine observation, one batched core activity read for main Buddy sessions on that machine, and an indexed existence read only for sleep candidates. No screen or transcript read added.
- Scale: existing Buddy cap and 1,000-session report bound; measure pure decision and host call count at 10x. No per-Buddy polling loop.
- Compatibility: the pool asks for the optional idle field, so old servers never receive it. An old host has no idle proof and sleeps no Buddy. Existing clients already understand asleep agents for crew.
- Migration/rollback: no migration; absent proof means awake. Once awake, a managed Buddy resumes using existing engine state. Preserve management for a sleeping Buddy if its project switches back, so its next message still wakes it.
- Audience/identity: use current Buddy owner generation and existing recipient permission checks; never change machineOwnerId, contributorId or Buddy ownership.
- Failure: missing/unknown/stale activity is not idle. A failed close retries through existing logged rest handling; a failed reopen uses existing bounded backoff.
- Platforms: backend and CLI on macOS/Linux/Windows; no UI or process-launch implementation changes.

## Review Focus

1. A long-running or unknown engine turn must not be stopped even with an old server roster (Task 3).
2. A person leaving/rejoining or a project still using chat cannot gain a wake or be put to sleep under another identity (Tasks 1/2).
3. A queued/claimed/uncertain delivery prevents sleep; a simultaneous new message must conflict with the sleep decision (Tasks 1/2).
4. A stale unchanged heartbeat cannot refresh idle proof; a new message just before sleep cannot be erased (Tasks 1/3).
5. Two Buddies of one person remain separate; a question wakes only its intended recipient, and a host restart resumes the recorded session (Tasks 2/3).

### Task 1: Server decides idle Buddy sleep

**Files:** create `backend/src/superTabs/buddySleep.ts` and `.test.ts`; modify `machines.ts`, `read/hostRows.ts`, `store.ts`; test `integration/superTabBuddies.test.ts` and relevant machine observations.

**Interfaces:** `buddySleepManaged(state, agent): boolean`; `buddySleepCandidates(state, now): Agent[]`; `sleepBuddies(state, candidates, busy, now): void`. Optional `MachineObservation.idleBuddyHarnessIds: string[]` holds running sessions explicitly idle in that fresh report; pool `buddySleepWanted` opts a host into reporting. Host agent row `buddySleepManaged` grants retention/resume of that main Buddy.

- [x] Commit failing tests for the one-hour boundary, current owner generation, switched/unswitched/mixed projects, main vs thread sessions, unknown/stale/working proof, pending delivery and active task.
- [x] Watch targeted tests fail for missing sleep behavior.
- [x] Implement the pure eligibility/decision and report plumbing; reuse existing asleep mark. Filter report IDs against running sessions; unchanged reports compare the idle set too. Read pending delivery existence for candidates only and guard all state used by sleep.
- [x] Run affected units and the focused real-store sleep case; commit passing implementation and push.

### Task 2: Authorized input wakes the intended Buddy atomically

**Files:** modify `backend/src/superTabs/parts/commit.ts`, `parts/touches.ts`, `buddySleep.ts`; test `buddySleep.test.ts`, `parts/touches.test.ts`, `integration/superTabBuddies.test.ts`.

**Interfaces:** `wakeBuddies(state, message, now): void`, called by `numberMessages` before agent-only rows are skipped. Uses final message recipients and buddyRecipients, with the existing Buddy read checks; clears asleep, renews keptAt/downSince, records startWake for existing timing telemetry.

- [x] Commit failing tests: own-person message and authorized proposal question wake one sleeping main Buddy; another Buddy stays asleep; stale ownership/private source is refused by real command/claim rights; repeated input stays idempotent and a new wake gets a full idle hour.
- [x] Watch them fail before implementation.
- [x] Implement the shared wake before saving messages; guard every recipient Buddy's part even when already awake, so concurrent sleep retries. Do not change delivery rights or authors.
- [x] Run changed units and focused real-store wake/rights cases; commit and push.

### Task 3: CLI reports idle and closes/resumes safely

**Files:** modify `cli/src/superTabs/machines.ts`, `host.ts`, `retention.ts`; test `machines.spec.ts`, `host.spec.ts`, `retention.spec.ts`.

**Interfaces:** a pool asking `buddySleepWanted` receives only running Buddy harnesses that `core.agents.activity` explicitly reports idle. Strip this field from repeated heartbeat bodies. Retention holds a bounded `wakeableBuddies` list for server-managed, non-stopping main Buddies; `retainedLeads` admits only that recorded list to existing core resume authority.

- [x] Commit failing tests for positive/unknown/working activity; one batch, no call without Buddies; old-server omission; repeated heartbeat strips proof; sleep closes once, preserves home, refuses busy/unknown/Team; wake and host restart reopen same session without replaying input; ordinary/unswitched Buddies unchanged.
- [x] Watch focused CLI tests fail.
- [x] Implement minimal report/retention/host changes; check live idle again immediately before sleep and preserve existing failure backoff. Managed awake Buddies use keepAlive without crew continuation text.
- [x] Run affected backend and CLI tests/typechecks. Record same-workload call counts and timing; commit and push, publish red/green evidence and mark ready.


## Validation notes

- Server decision tests were committed at `4afea00e5`, real-store report/delivery tests at `82c0943fb`, and private-report tests at `07a1dd3e3`, before server implementation `8cf3ee094`. Wake tests `f60e62746` preceded `7cddf82f5`. CLI tests `8aa1cea7d` preceded `8aba589cc`.
- The 100-session report failed at 64 returned IDs (`89f70cee3`) before bounded batches (`c0bbe860a`); the duplicate-core-call regression (`134fdc518`) failed at 200 calls before the live-registry fix (`8fcb70b65`).
- Card-question regression `04e567e33` uses #3817's commands. It passed on the temporary combination and failed at the wake assertion with only `wakeBuddies` withheld. After #3387 landed at `50f524878`, main merged cleanly at `b34197e01`; all three #3824 real-store regressions pass on this branch, including the PM question waking the original proposal sender while the newer default stays asleep.
- Final validation after merging main: the three focused #3824 real-store regressions pass; 102 units in `buddySleep`, `machines`, `parts/touches` and `proposalCards` pass; 678 CLI checks in `machines`, `host`, `retention` and `buddyHome` pass. Backend and CLI typechecks are clean. No source edits were needed after the automatic merge.
- 344 affected backend units pass, plus the two extra report/switch-back regressions. The three affected CLI files pass (651 checks); the report file passes again after the scale fix (199 checks). Both typechecks pass. Real-store sleep and input-race cases pass; open-delivery reads use the existing agent/status index, 0 documents examined and at most 3 keys for the empty probe. The broader report integration file passes (32 checks).
- One broadened Buddy integration run found an accidental clock replacement in another fixture; corrected at `057840ae5`, and that case passes. Its failure is not product red evidence.
- The isolated native Buddy test is present, preserving the Buddy folder and exact engine conversation across sleep/wake. This machine is a Team OS account: product policy refuses Buddy starts here even with isolated homes. The run stopped before starting a Buddy, and does not count as native sleep/wake evidence. The test now explicitly requires an owner account; independent Mac/Linux native verification remains with the test steps.
- Synthetic same-workload report timing, macOS Node 22, 30 measured fresh passes after 5 warmups: 50 Buddies p95 0.378 ms before / 0.374 ms after; 500 Buddies p95 2.841 / 2.791 ms. Activity requests: 0 before, 1/8 after, each at most 64 IDs; no new per-session core calls, no activity request on a quiet pass or heartbeat. This excludes actual engine/IPC latency.
- Message numbering adds under 0.01 ms of median CPU at 500 agents in the synthetic workload. Pure candidate selection at 500 agents/homes is p95 9.71 ms; indexed database probes are candidate-only. These are local synthetic measurements, not production latency or native memory measurements.
