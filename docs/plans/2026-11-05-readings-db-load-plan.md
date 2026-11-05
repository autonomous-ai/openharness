# Machine readings and machine socket writes stop loading the database — Plan

**Goal:** A machine's 15-second reading loads its Swarm from MongoDB only when something that concerns that machine
changed, the parts it re-reads come in one query, and an adapter socket writes `Machine` at most once a minute for a pure
last-seen time.

**Architecture:** Today a reading is stored "fast" (its machine part only) only while the Swarm's `main` stamp has not
moved since this machine's last full report (store.ts fastReading). In a busy Swarm `main` moves every few seconds (any
message or command), so nearly every reading of every machine runs in full and reads SwarmHead, SwarmMember, SwarmAgent,
SwarmStart, SwarmMachine (one `findUnique` per changed machine) and SwarmGroup: Ken's top slow shapes. Commits now also
bump a per-machine host stamp in the Swarm's existing Redis stamp hash, by the same rule the host read and the host push
already use (commit.ts hostsToTell / plainHost); the fast path compares those instead of `main`. The held parts read
changed machines in one `_id $in` read. The adapter socket's close stamp gets the floor its heartbeats have.

**Tech Stack:** Fastify backend, Prisma on MongoDB, Redis (ioredis, one Lua script), vitest with mongodb-memory-server.

**Spec:** Task #3119 (Ken's 12:20 VN prod scan, Watch Production #2773). Builds on DB roadmap 2.5
(docs/design/2026-10-26-swarm-state-parts.md, machineReports.ts) and the read cache stamps
(docs/design/2026-10-28-swarm-read-cache.md).

Way of working: the project's Engineer workflow (one pull request, test first per task, one independent review).

## Measured before (integration test, Prisma calls per reading, by model.operation)

| Reading | Calls | What |
| --- | --- | --- |
| fast | 4 | Machine.findFirst, SuperTab.findFirst, SwarmMachine.aggregateRaw, SwarmMachine.updateMany |
| full | 13–14 | + SwarmHead.findUnique, SwarmMember/SwarmAgent/SwarmStart.findMany, SwarmMachine.findUnique ×changed (≤4), SwarmGroup.aggregateRaw ×3–4 |
| after one unrelated chat message | full | every machine's next reading |

## Design

- **What concerns a machine.** A write tells host `X` when plainHost says `X` (an agent or start on X) or a group's
  host marker names X. It tells every host (`*`) for the head, a member, a machine's settings (any machine write that
  carries a host marker: a removal, a rename, a team follow) and a group write without a marker. A machine's own
  reading and a touch tell nobody; progress parts are not read by a report and tell nobody.
- **Stamps.** `SwarmStamps.bump(tabId, scopes, hosts)` writes `host:<machineId>` / `host:*` fields with the same
  monotonic rule as `main` in the same Lua call; nothing new is published on the bus. `SwarmStamps.readHost(tabId,
  machineId)` reads `main`, `hosted`, `uncovered`, `host:<id>`, `host:*` in one HMGET.
- **Old pods during a rolling release.** An old pod bumps `main` without host fields. Each new bump sets `hosted` to the
  new `main`; a bump that finds `main != hosted` first records `uncovered = main` (the old bump's stamp). The fast path
  holds while `main` is unchanged (as today), or while `hosted == main`, `uncovered <= record.main` and both host
  stamps are unchanged.
- growth: one hash field per machine that hosted a Swarm part; the hash already expires 30 days after its last bump.
- concurrency: Redis runs the script atomically; Mongo writes keep their per-part version guard.
- read cost: one HMGET per reading (it read one before); a busy Swarm's readings stop reading the Swarm.
- scale: 10x machines is 10x fields of ~30 bytes; the warning metric is `machineReportLine` full/fast share.
- compatibility: old pods covered above; no client or wire change.
- migration + rollback: none stored in Mongo; rolling back leaves unread Redis fields that expire.
- audience, identity: unchanged (the fast path's checks of the caller and the machine stay).
- failure: Redis unreadable or late → full report, as today; a lost bump → owed and retried, as today.
- platforms: backend only (Linux pods).

## Global Constraints

- No new settings or switches. No production write; production reads only through the read-only login, explain() first.
- A reading that changes access, quota or readiness is stored and pushed at once (fast or full).
- A full report decides exactly as before; only when it runs changes.
- Swarm code stays out of cli/src/core. Temp files only in mktemp -d folders.

## Review Focus

- A change concerning machine X committed by one pod while X's reading runs fast on another: the next reading must run in full.
- A group written without a host marker (outside commitParts) and machine settings changes must reach every host.
- Rolling release: an old pod's commit after a new pod's record must force full readings until a full report.
- The fast path must still store and push quota and readiness changes at once.
- Adapter close floor must not hide a real disconnect for longer than one minute.

## Tasks

### Task 1: Count DB calls per reading and per heartbeat (tests only)

**Files:** Test: `backend/integration/superTabMachineReports.test.ts`

- [ ] Add `counted()` (Prisma `$extends` counting `model.operation`) and test "a reading reads a fixed number of times,
  whatever the Swarm's agents, starts and machines": a full reading's reads with 2 agents equal those with +10 agents,
  +10 starts and 4 more machines having read since; no `SwarmMachine.findUnique`.
- [ ] Test "a reading after a change elsewhere in the Swarm is stored fast": message in the Lead chat, then the worker
  machine's reading takes the fast path with ≤ 4 calls.
- [ ] Tests "a change for this machine still runs it in full": a start for test-host, an assignment to its agent, a
  member invited, another machine's removal, a group write with no marker, a commit by an old pod (bumps main only).
- [ ] Test "quota and readiness changes are stored and pushed at once" on the fast path.
- [ ] Run; expect the first two red, the rest green; commit.

### Task 2: Host stamps

**Files:** `backend/src/superTabs/cache.ts`, `cache.test-support.ts`, `cache.test.ts`, `parts/write.ts`,
`parts/commit.ts` (export `writeHosts`), `machineReports.ts` (ReportRecord gains `hosts`), `store.ts`
(fastReading, fullReading).

**Interfaces:** `writeHosts(write: PartWrite): string[] | '*' | null`; `noteChange(tx, tabId, scope, hosts?)`;
`SwarmStamps.bump(tabId, scopes, hosts?: string[])`; `SwarmStamps.readHost(tabId, machineId): Promise<HostStamp>`
with `HostStamp { main, hosted, uncovered, host, all }`; `readHostStamp(tabId, machineId): Promise<HostStamp | null>`.

- [ ] Unit tests in `cache.test.ts` for the Lua script's rules (through a fake Redis evaluating the same rules as
  MemoryStamps): host fields grow, `hosted` follows `main`, an old bump sets `uncovered`.
- [ ] Implement; Task 1's fast-path tests pass; commit.

### Task 3: Changed machines in one read

**Files:** `backend/src/superTabs/parts/held.ts`; Test: `backend/integration/superTabHeldParts.test.ts`

- [ ] Test: two changed machines are read in one `SwarmMachine.aggregateRaw`, no `findUnique`; red; implement with
  `_id $in` (raw, so it is a plain `$in` on `_id`); green; commit.

### Task 4: Adapter close stamp floor

**Files:** `backend/src/lib/adapterWs.ts`; Test: `backend/src/lib/adapterMachineWrites.test.ts`

- [ ] Test: a socket closing within a minute of the row's last stamp writes nothing; one closing later stamps once.
  Red; add `MACHINE_CLOSE_FLOOR_MS = 60_000` beside MACHINE_PRESENCE_WRITE_MS; green; commit.
