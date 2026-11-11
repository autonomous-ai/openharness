# Host readings and host changes read only what changed Implementation Plan

> **For agentic workers:** Written by the writing-plans skill as the project's instructions adapt it (Engineer role,
> revision 54). The Engineer implements it task by task, test first, in this session; the pull request's Review step is
> the one independent review. No execution handoff.

**Goal:** A machine's full reading (POST /hosts/:machineId/readings) and a host's changes read (POST
/hosts/:machineId/changes) stop reading from MongoDB, again and again, Swarm data that did not change, and every host
sees exactly the rows and decisions it sees today.

**Architecture:** B3: a full reading's machine parts and conversations (parts/load.ts `loadObserved`) come from a
per-process store of parts held at their exact version (`parts/held.ts`). Inside the reading's transaction each read
first asks MongoDB only for the selected parts' version columns (`key, version, changedAt, readAt, dormant`), then reads
whole only the parts whose columns differ from what the process holds. A part is reused only when every column a write
moves is equal, so what the reading works on is what the old read returned. B4: the host state's dormant conversations of
the machine's agents (cachedReads.ts `deriveLight`) are read through the light projection (parts/light.ts
`loadLightGroups`) and held as their own cache entry, patched as today, instead of whole conversations projected after
the read.

**Tech Stack:** TypeScript, Prisma on MongoDB (`aggregateRaw`), vitest; integration on `mongodb-memory-server`.

**Spec:** the task's brief (#2597, Ken's plan of 2026-11-04, group B items 3 and 4); backend/AGENTS.md (one index per
query, measure before and after); docs/superpowers/specs/2026-11-02-swarm-cache-delta-design.md (patch rules).

## Global Constraints

- Hosts see exactly the same changes as before: same reading decisions, same stored parts, same host rows and etags.
- No schema change, no new index, no production write. Every read names an index it already uses.
- No `in` list through Prisma on these paths (it is sent as an N-branch `$or`, and an empty one as `$or: []`, a scan):
  raw `$match` with `$in`, and no read at all for an empty list.
- Optimizations ship on, with no switch. Swarm code stays out of `cli/src/core`.
- Backend unit suite (`npm test`) before Ready; the Super Tab integration suite runs in PR CI.

## Review Focus

- A part written with no visible change to `changedAt` (a reading, dated `readAt`): the version moves, so it is read again.
- A part purged and added again under the same key, starting again at an old version: `changedAt` differs, read again.
- A part removed (tombstoned) or put to sleep (`dormant`) since the last read: it leaves the selection as before.
- Two readings of one Swarm at once in one process: held parts are frozen and shared, never mutated (store.ts
  `loadedFrom` freezes them, the reading works on a clone).
- A transaction retried after a conflict reads the version columns again; nothing it held from the failed attempt is
  trusted without that check.

## Design

- **Growth: what deletes it.** Nothing is stored in MongoDB. The held parts live in process memory, capped at 32 MB
  (least recently used Swarm out), measured as the read cache measures (cache.ts `sizeOf`). A part that leaves the
  selection leaves the held set on the next read of its Swarm. The B4 entry lives in the existing read cache, under its
  cap.
- **Concurrency: lock level.** None added. The reading's transaction reads the version columns and the changed parts in
  one snapshot; writes stay version-guarded (parts/write.ts). Held parts are frozen and shared read-only.
- **Read cost: only what changed.** B3: per full reading, one small columns read per selection plus the whole rows of
  the parts that changed since this process last read them (usually the reporting machine alone). B4: a miss reads light
  rows instead of whole conversations; a hit patches from the delta as today.
- **Scale: 10x, and the first warning.** 10x machines per Swarm: the columns read grows to ~1 KB per 10 machines; the
  first warning is `db by shape` bytes for `SwarmMachine aggregate` on the readings route. Held memory at 10x Swarms
  per process hits the 32 MB cap and falls back to whole reads, seen as `swarm cache` misses for `held`.
- **Compatibility: old and new clients.** No wire change: hosts and clients get the same answers.
- **Migration + rollback.** None: no stored data changes. Rolling back the release restores the whole reads.
- **Audience: the server enforces it.** N/A because no new data reaches any reader; the same checks run on the same parts.
- **Identity.** N/A because nothing here uses a login.
- **Failure: nothing breaks without saying so.** A failed read fails the reading as today. A held part is never used
  without its columns matching the database's in the same snapshot, so there is no stale state to go unseen.
- **Platforms.** Backend only.

## File Structure

- Create `backend/src/superTabs/parts/held.ts`: `HeldParts`, the process store, and `heldMachines`, `heldGroups`.
- Modify `backend/src/superTabs/parts/load.ts`: `loadObserved` reads machines and conversations through `parts/held.ts`.
- Modify `backend/src/superTabs/cachedReads.ts`: `deriveLight` reads `light-dormant:agent:{id}`.
- Modify `backend/src/superTabs/cachePatch.ts`: `lightDormantAgentRule`.
- Tests: `backend/integration/superTabMachineReports.test.ts` (B3), `backend/src/superTabs/cachePatch.test.ts` and
  `backend/integration/superTabCacheDelta.test.ts` (B4).

### Task 1: A full reading reads only the parts that changed (B3)

**Files:**
- Create: `backend/src/superTabs/parts/held.ts`
- Modify: `backend/src/superTabs/parts/load.ts` (`loadObserved`), `backend/src/superTabs/parts/index.ts` (export)
- Test: `backend/integration/superTabMachineReports.test.ts`

**Interfaces:**
- Produces: `class HeldParts { constructor(maxBytes?: number) }`; `heldMachines(tx, tabId, held?: HeldParts):
  Promise<Part<MachineData>[]>` (every live machine part, in key order); `heldGroups(tx, tabId, reads: GroupReads, held?:
  HeldParts): Promise<PartRow[]>` (as `liveGroups`: each read's rows in its index order, each key once);
  `loadObserved(tx, tabId, machineId, held?: HeldParts)`.

- [ ] **Step 1: Failing tests** in `superTabMachineReports.test.ts`, describe "a full report reads only what changed
  (B3)": (a) with three machines contributed, a second full report (a server that remembers no report) returns from
  `SwarmMachine` and `SwarmGroup` under half the bytes of the first (profiler `responseLength`), and stores the same
  machine part a fresh server stores; (b) for each change kind, `loadObserved` through a warm `HeldParts` equals it
  through a new one: another machine's settings, another machine's reading only, a machine removed, a machine added, a
  post in a running conversation, a conversation put to sleep and woken, a conversation removed, a new Lead conversation,
  and a part rewritten at the same version with a new `changedAt`.
- [ ] **Step 2: Run** `npx vitest run --config vitest.super-tabs.config.ts integration/superTabMachineReports.test.ts`;
  expect (a) to FAIL on bytes, (b) to FAIL to compile (no `held` argument). Commit the failing tests.
- [ ] **Step 3: Implement** `parts/held.ts`: per selection, a raw `$match` (machines: `{ tabId, deleted: false }` on the
  `(tabId, key)` index; conversations: each `GroupReads` entry through its named index) projecting the columns; the
  changed keys read whole in one raw `$match` by `_id`/`key` `$in` (no read for none); held entries replaced and LRU'd.
  `loadObserved` uses them; `assemble` reads no machines for it.
- [ ] **Step 4: Run** the file and `src/superTabs` unit tests; expect PASS. Commit.

### Task 2: A host's dormant conversations are read light (B4)

**Files:**
- Modify: `backend/src/superTabs/cachedReads.ts` (`deriveLight`), `backend/src/superTabs/cachePatch.ts`
- Test: `backend/src/superTabs/cachePatch.test.ts`, `backend/integration/superTabCacheDelta.test.ts`

**Interfaces:**
- Consumes: `store.loadLightGroups(db, tabId, 'agents', match)`, `projectLightGroup`.
- Produces: `lightDormantAgentRule(agentId): PatchRule<Part<GroupData>[]>` (as `dormantAgentRule`, holding each changed
  part projected light).

- [ ] **Step 1: Failing tests**: (a) unit: the rule keeps a light projection of a changed dormant group of the agent,
  drops one it left or that woke, ignores an older version; (b) integration: a host's changes read on a cold cache reads
  its agent's dormant conversations with the light projection (profiler shows no whole `SwarmGroup` rows for the
  `agents` read; bytes under a quarter of the whole rows), and its rows and etag equal the rows built from whole
  conversations; after a dormant conversation changes, the patched entry equals a fresh load.
- [ ] **Step 2: Run** them; expect FAIL. Commit the failing tests.
- [ ] **Step 3: Implement**: `deriveLight` reads `light-dormant:agent:{id}` through `loadLightGroups` with
  `lightDormantAgentRule(id)`, and no longer projects after the read.
- [ ] **Step 4: Run** the tests, `npm test`, and the bench (`integration/bench/observeReads.ts`) for the numbers; expect
  PASS. Commit.
