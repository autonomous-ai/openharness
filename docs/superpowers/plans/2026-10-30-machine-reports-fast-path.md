# Cheap machine reports (DB roadmap 2.5) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A heartbeat that changes only a machine's reading costs one read and one write of its machine part, and a machine sends one report call per pass for all its Swarms.

**Architecture:** Every full report (today's `observeMachine`) records in Redis what the next report needs to skip the Swarm load: the `main` stamp read before it loaded, the lent count, the next loss deadline, the Team-by-agents answer, the members to push to and the preparable start ids. A later report whose decisions cannot differ (spec section 1) reads and writes only its machine part under the version guard; anything else runs in full. Sweeps take one Redis clock per Swarm across pods. A batch route takes all of a machine's readings; the CLI sends one call per pass and falls back per Swarm.

**Tech Stack:** TypeScript, Fastify, Prisma on MongoDB, ioredis, vitest, `mongodb-memory-server`.

**Spec:** `docs/superpowers/specs/2026-10-30-machine-reports-fast-path-design.md` (decisions final).

## Global Constraints

- Sweep clock: Redis `SET swarm:swept:{tabId} <now> NX PX 30000` (`SWEEP_EVERY_MS`); one sweep per Swarm per 30 s across pods.
- Record: Redis hash `swarm:machine-full:{tabId}`, one field per machine (JSON), key expires 2 minutes (`120_000` ms) after its last write.
- `nextDeadline` is capped at 5 minutes (`300_000` ms) after the full report.
- Fast-path lent: `elapsed × lentCount`, elapsed capped at `MACHINE_FRESH_MS` (45 000), added to the current week as `accrueLent` does.
- Redis or stamps unreadable, a record missing, a bump owed, any failed condition or a version conflict: the full path.
- Replies of the per-Swarm route are unchanged (`{ version }`). The per-Swarm route gains the fast path too.
- Batch route: `POST /api/super-tabs/hosts/:machineId/readings`, body `{ readings: [{ tabId, observation }] }`, answer `{ results: [{ tabId, ok: true } | { tabId, error: { code, message, status } }] }`; at most 64 readings, body limit 8 MiB.
- CLI: route answers 404 (or 403 `TEAM_SESSION_LIMITED` from an older backend) → one call per Swarm, ask again after 10 minutes (`600_000` ms).
- Log `machine reports` per minute with `fast` and `full` counts, per pod.
- Do not commit or push until Ken asks; remove what becomes dead (`store.ts swept`, `sweepDue`).
- Commands from `backend/`: unit `npx vitest run <file>`; integration `npx vitest run --config vitest.super-tabs.config.ts <file>`. CLI: `npm test` (`test:core` only if `cli/src/core` or `cli/src/services` changes).

## Rulings on the spec (found while reading the code)

1. **Progress feeds the loss decision.** `liveness.ts reportRenewedAt` reads `harnessProgress`: a running harness whose entry disappears renews nothing (its lease ends sooner), and a reading with no progress map renews at `receivedAt`. So spec condition 2 also requires, against the stored reading: `harnessProgress` present exactly when it was, the same running harnesses with an entry, and no entry earlier than stored. Then the lease can only end later than the full report computed, and `nextDeadline` stays a safe bound (anti-goal: no task left unlost).
2. **The batch body is validated per reading.** One strict body schema would 400 every Swarm for one bad reading; each `observation` goes through `machineObservationSchema` alone and a failure is that Swarm's `VALIDATION_ERROR`.
3. **Team sessions:** the new route joins `TEAM_ROUTES` with scope `machine`.
4. **Unreachable refusals** (`NOT_FOUND`, `JOIN_UNAVAILABLE`, `WORKSPACE_ACCESS_REVOKED`, `unreachable`) answer that reading as `{ code: 'NOT_AVAILABLE', status: 404 }`, as the per-Swarm route does.

## Review Focus

1. A reading whose running harness drops its progress entry while running (ruling 1): full path, so a lapsed lease is judged — Task 1 (`readingOnly`) and Task 4 tests.
2. A batch with one Swarm the caller lost (removed member, revoked pool): that Swarm's error only, the others stored — Task 5 test.
3. Redis answering stamps but failing the record or sweep commands: reports still succeed in full, sweeps fall back to this process's clock — Task 2 test.
4. A full report that itself wrote beyond its reading (presence, a lost task): the next report runs in full once, then fast — Task 4 test.
5. An older backend (404) or a Team daemon on one (403 `TEAM_SESSION_LIMITED`): the CLI keeps reporting per Swarm and starts still run — Task 6 test.

---

### Task 1: Shared pure pieces: stored reading, lent count, next loss

**Files:**
- Modify: `backend/src/superTabs/machines.ts` (add `storedObservation`, `readingOnly`)
- Modify: `backend/src/superTabs/leaderboard/lent.ts` (split `accrueLent`)
- Modify: `backend/src/superTabs/liveness.ts` (add `nextLossAt`)
- Modify: `backend/src/superTabs/store.ts` (`observeMachine` uses `storedObservation` and the split lent)
- Test: `src/superTabs/machines.test.ts`, `src/superTabs/leaderboard/lent.test.ts`, `src/superTabs/liveness.test.ts`

**Interfaces:**
- Produces:
  - `storedObservation(pool: ContributedMachine, observation: MachineObservation, opts: { team: boolean; now: number; preparable: (startId: string) => boolean }): NonNullable<ContributedMachine['observation']>` — exactly what `observeMachine` stores today (running-only progress/tokens, filtered `preparingStartIds`, `observedPrivacy`, quotas by `contributedEngines`, `sessionKind`, `receivedAt`).
  - `readingOnly(stored: ContributedMachine['observation'] | undefined, observation: MachineObservation): boolean` — spec condition 2 plus ruling 1 (same running and stopped sets, no `stoppedReservations`, same `preparingStartIds` as a set, same progress shape, no entry earlier).
  - `lentAgents(state: SuperTabState, pool: ContributedMachine, running: readonly string[]): number` and `addLent(pool: ContributedMachine, now: number, count: number): void`; `accrueLent(state, pool, now)` becomes `addLent(pool, now, lentAgents(state, pool, pool.observation?.runningHarnessIds ?? []))`.
  - `nextLossAt(state: SuperTabState, machineId: string): number | undefined` — the earliest `leaseEnd` of this machine's workers' active tasks (as `lostReason` reads them), undefined when none can lapse.

- [ ] **Step 1: Write the failing tests**
  - `machines.test.ts`: `storedObservation` keeps progress/tokens of running harnesses only, keeps a preparing id only when `preparable` says so, drops quotas of engines not contributed, sets `sessionKind` `'team'`/`'computer'`; `readingOnly` is false for a changed running set, a changed stopped set, any `stoppedReservations`, changed preparing ids, a progress map added or removed, a running harness losing its entry, an entry earlier than stored; true when only resources, quotas, tools, tokens, privacy or a later progress time differ.
  - `lent.test.ts`: `addLent` after `lentAgents` equals `accrueLent` on the same state (busyMs, pruned weeks, no write when count or elapsed is 0).
  - `liveness.test.ts`: `nextLossAt` equals the lease end of the one active task; for `t = nextLossAt - 1`, `loseTasks` loses nothing, and for `t = nextLossAt + 1` it loses that task; undefined with no active work on the machine.
- [ ] **Step 2: Run** `npx vitest run src/superTabs/machines.test.ts src/superTabs/leaderboard/lent.test.ts src/superTabs/liveness.test.ts` — FAIL: not exported.
- [ ] **Step 3: Implement** the four functions; `observeMachine` calls `storedObservation` (with `preparable` from `state.starts`) and `accrueLent` unchanged in behavior.
- [ ] **Step 4: Run** the three files plus `npx vitest run --config vitest.super-tabs.config.ts integration/superTabLiveness.test.ts` — PASS.

### Task 2: Report memory: the record, the shared sweep clock, the counts

**Files:**
- Create: `backend/src/superTabs/machineReports.ts`
- Modify: `backend/src/superTabs/cache.ts` (export `readStamps(tabIds)` and `stampOwed(tabId)`)
- Modify: `backend/src/routes/superTabs.ts` (`productionStore` wires `reports: redisReportMemory(bus.pub)`), `backend/src/server.ts` (start/stop the log)
- Test: `src/superTabs/machineReports.test.ts`, `src/superTabs/cache.test.ts`

**Interfaces:**
- Produces:
  - `interface ReportRecord { stamp: number; lentCount: number; removals: boolean; deadline: number; team: boolean; members: string[]; preparable: string[]; at: number }`
  - `interface ReportMemory { get(tabId: string, machineId: string): Promise<ReportRecord | undefined>; set(tabId: string, machineId: string, record: ReportRecord): Promise<void>; sweepDue(tabId: string, now: number): Promise<boolean> }`
  - `interface ReportRedis { hget(key, field): Promise<string | null>; hset(key, field, value): Promise<unknown>; pexpire(key, ms): Promise<unknown>; set(key, value, px: 'PX', ms: number, nx: 'NX'): Promise<'OK' | null> }`
  - `redisReportMemory(redis: ReportRedis): ReportMemory` (a failed `sweepDue` falls back to a local clock, a failed `get` reads as missing, a failed `set` is logged once); `localReportMemory(now: () => number): ReportMemory` (one process, the default).
  - `RECORD_TTL_MS = 120_000`, `DEADLINE_CAP_MS = 300_000`.
  - `countReport(path: 'fast' | 'full'): void`, `startMachineReportLog(intervalMs = 60_000): () => void` (logs `'machine reports', { pod, windowMs, fast, full }`, flushes on stop).
  - `cache.ts`: `readStamps(tabIds: readonly string[]): Promise<Map<string, Stamp> | null>` (null without stamps or past `STAMP_TIMEOUT_MS`), `stampOwed(tabId: string): boolean`.

- [ ] **Step 1: Write the failing tests** (`machineReports.test.ts`, a fake Redis with a movable clock as in `pollMemory.test.ts`): a record set then read back equal; gone 120 s after the key's last write; two memories over one fake Redis: `sweepDue` true once per 30 s between them; Redis failing `set NX`: `sweepDue` answers from the local clock; failing `hget`: `get` is undefined; the log line counts and resets. `cache.test.ts`: `readStamps` null with stamps down; `stampOwed` true after a failed bump until paid.
- [ ] **Step 2: Run** `npx vitest run src/superTabs/machineReports.test.ts src/superTabs/cache.test.ts` — FAIL.
- [ ] **Step 3: Implement**; wire production and the log beside `startWsCounterLog()`.
- [ ] **Step 4: Run** the same files — PASS.

### Task 3: The full path records, and sweeps by the shared clock

**Files:**
- Modify: `backend/src/superTabs/store.ts` (`SuperTabStoreHooks.reports?: ReportMemory`; delete `swept`/`sweepDue`; `observeMachine` full path)
- Create: `backend/integration/superTabMachineReports.test.ts` (add to `vitest.super-tabs.config.ts` include)

**Interfaces:**
- Consumes: Task 1 `lentAgents`, `nextLossAt`; Task 2 `ReportMemory`, `readStamps`, `DEADLINE_CAP_MS`.
- Produces: after a full report commits, `reports.set(tabId, machineId, record)` with `stamp` = the `main` stamp read before the transaction (no record when unreadable), `lentCount = lentAgents(state, pool, pool.observation.runningHarnessIds)` after the mutations, `removals = state.machines.some(m => m.removal)`, `deadline = min(nextLossAt ?? ∞, now + DEADLINE_CAP_MS)`, `team = teamByRecord(state, machineId)`, `members = state.people ids`, `preparable` = this machine's dispatched starts with no harness and no error.

- [ ] **Step 1: Write the failing tests** (fixture as `superTabLiveness.test.ts swarm()`, with a shared `localReportMemory`/fake-Redis memory passed in hooks): a report writes the record with each field above; a report whose own write moved `main` records the stamp read before it; two stores sharing one memory sweep a Swarm once per 30 s (count `sweepLiveness` effects: a stalled start failed once).
- [ ] **Step 2: Run** `npx vitest run --config vitest.super-tabs.config.ts integration/superTabMachineReports.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** it and `integration/superTabLiveness.test.ts` (its per-store sweep tests: each store gets its own memory by default) — PASS.

### Task 4: The fast path

**Files:**
- Modify: `backend/src/superTabs/store.ts` (`observeMachine` tries `fastReading` first; counts)
- Modify: `backend/src/superTabs/parts/load.ts` (`loadMachineParts(db, tabIds, machineId)`: `_id $in` through `aggregateRaw`)
- Test: `backend/integration/superTabMachineReports.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `private fastReading(user, tabId, machineId, observation, host: { owned: Machine | null }, part?: Part<MachineData>): Promise<{ version: number } | null>` — null means run in full. Order: stamps readable and equal to `record.stamp`; no bump owed; `now < record.deadline`; `!record.removals`; sweep not due (decided once per report, before either path); `hostFor` + `notTeamMachine` with `record.team`; billing; `store.row`; part live with `contribution`, `contributorId === user.sub`, `generation` equal, no `removal`; `readingOnly`; then `addLent(pool, now, record.lentCount)`, `storedObservation(..., preparable: id => record.preparable.includes(id))`, `readingClearsSuspensions` (changed → null); `guardedWrite` update in `swarmTransaction` (a conflict → null); after commit `hooks.swarmChanged({ tabId, userIds: record.members, lastChangedAt: stamp, parts: ['machine'] })`.

- [ ] **Step 1: Write the failing tests:**
  - **Same as full:** two Swarms written from one state (as `superTabRead.test.ts scene` does), one full report each at the same clock, then the same heartbeat at the same clock: Swarm A's store with the record (fast), Swarm B's with an empty memory (full). The machine parts' `data` are equal (including `lent`), and the `swarmChanged` calls are equal.
  - **Each reason forces full** (assert through `countReport` or a spy hook, and the part read count): running set changed, stopped set changed, stop proof, preparing changed, generation changed, a command since the last full report, pending removal, sweep due, deadline passed, record missing, stamps down, bump owed, a suspension cleared, a running harness's progress entry dropped (ruling 1), a full report that wrote presence (next one full, the one after fast).
  - **Deadline:** a worker whose lease ends between two heartbeats is lost by the first report after it.
  - **Lent:** N fast heartbeats give the same `busyMs` as N full ones, including right after a full report that changed the running set.
  - **Team machine:** the owner's ordinary sign-in reporting for a machine whose agent is on a Team account gets `TEAM_HOST_ONLY`.
  - **Revoked:** a regenerated pool answers `CONTRIBUTION_REVOKED`.
  - **Cost:** a fast heartbeat reads only `SwarmMachine` among part collections (plus `SuperTab`), writes once, bumps only `machine` (`partReads` and `MemoryStamps.bumps`).
- [ ] **Step 2: Run** the file — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file, `superTabLiveness`, `superTabTeam`, `superTabs`, `superTabCache`, `superTabRead` — PASS.

### Task 5: The batch route

**Files:**
- Modify: `backend/src/superTabs/store.ts` (`observeMachines`), `backend/src/routes/superTabs.ts` (route, schema, body limit), `backend/src/lib/teamSession.ts` (`TEAM_ROUTES`)
- Test: `src/routes/superTabs.test.ts`, `src/lib/teamSession.test.ts`, `backend/integration/superTabMachineReports.test.ts`

**Interfaces:**
- Consumes: Task 4 `fastReading`, the full path.
- Produces: `observeMachines(user: AuthUser, machineId: string, readings: Array<{ tabId: string; observation: unknown }>): Promise<{ results: Array<{ tabId: string; ok: true } | { tabId: string; error: { code: string; message: string; status: number } }> }>` — identity (`teamHost`, owned row, `hostFor` without a Swarm) once; fast candidates' parts in one `loadMachineParts`; each reading validated alone, then fast else full, one at a time; errors per reading (ruling 4 for unreachable ones).

- [ ] **Step 1: Write the failing tests:** route test (stub store): 64 readings accepted, 65 refused 400, a non-object reading answered per Swarm, team route listed; integration: one fast, one full, one revoked in one call → per-Swarm results; the `Machine` row read once for the call; a 21-Swarm call stores 21 readings.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.

### Task 6: The CLI sends one call per pass

**Files:**
- Modify: `cli/src/superTabs/machines.ts` (collect → send → starts; `sendAlone` ladder; `beat()` batches; `readingsRefusedUntil`)
- Test: `cli/src/superTabs/machines.spec.ts`, `cli/src/superTabs/host.spec.ts` (`setup()` answers `/readings`)

**Interfaces:**
- Produces: `READINGS_RETRY_MS = 600_000`; `sendAlone(tab, observation, localModels, began, refused?)` — today's field-fallback ladder, starting after the attempt the batch refused.

- [ ] **Step 1: Write the failing tests** (fixture's backend gets a batch emulator that answers per reading from the per-Swarm mock, so existing tests keep their meaning): one call per pass for two Swarms; `beat()` sends one call; a 404 (and a 403 `TEAM_SESSION_LIMITED`) → per-Swarm calls, no batch again until 10 minutes, then the batch; a `VALIDATION_ERROR` for one Swarm resends only it through the ladder; a lost-access error for one Swarm launches only the other Swarm's start.
- [ ] **Step 2: Run** `npx vitest run src/superTabs/machines.spec.ts src/superTabs/host.spec.ts` — FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` and `npm run typecheck` in `cli/` — PASS.

### Task 7: Whole checks

- [ ] `backend/`: `npm run typecheck`, `npm test`, `npm run test:super-tabs`; compare failures with a clean `origin/main`.
- [ ] `cli/`: `npm test`, `npm run typecheck`.
- [ ] After release (Ken): the spec's Measuring section, before and after.
