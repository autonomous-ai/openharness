# Backend CPU, November round: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the backend's CPU and DB load per request with five changes, delivered together:
- the Swarm read cache refreshes by delta;
- hot and cold parts are held apart;
- `freeze` walks each value once;
- relay publishes are counted, gated and guarded more cheaply;
- the hot nested loops become single passes.

**Architecture:**
- **Swarm cache.** A bump marks cache entries stale instead of dropping them. The next read loads one delta per Swarm
  (`loadChanged` since the entry's read start − 30 s) and patches each entry by a per-entry rule, with a verify
  sample and a minute log.
- **Cold parts.** Finished starts and dormant groups move to their own entries.
- **Relay gate.** The daemon's gateway stops broadcasting live events while the backend says no UI client is
  attached.
- **The rest** are local rewrites with unchanged answers.

**Tech Stack:** TypeScript, Node 20, Fastify, Prisma on MongoDB, ioredis, vitest (backend and CLI).

**Spec:** `docs/superpowers/specs/2026-11-02-swarm-cache-delta-design.md` (read it first; this plan does not repeat its reasoning).

## Global Constraints

- **No commits or pushes until Ken asks.** Each task ends with its tests green and the change left in the working
  tree. Branch `perf/swarm-cache-delta` from `main`.
- **Repository conventions:** docs and code comments in English; comments say why in plain sentences; no dead code.
- **Backend test env:** `NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`.
  Integration tests run with `--config vitest.super-tabs.config.ts`; real-Redis tests with
  `REDIS_TEST_URL=redis://127.0.0.1:6379/15`.
- **Exact values from the spec:**
  - `OVERLAP_MS` = 30 000 (reuse `read/cursor.ts`, do not copy it);
  - `CACHE_MAX_AGE_MS` = 60 000, now meaning "patch after", not "reload after";
  - `DELTA_MAX_AGE_MS` = 600 000 (full reload at least every 10 min);
  - `DELTA_MAX_PARTS` = 500;
  - `SWARM_CACHE_DELTA` `on|off`, default `on`;
  - `SWARM_CACHE_VERIFY_RATE`, number 0–1, default `0.01`;
  - `RELAY_UI_GATE` `on|off`, default `on`;
  - the gate's quiet window for remote web frames is 60 000 ms.
- **Responses never change.** Every read returns what it returns today. Commands keep loading in their own
  transaction and never read the cache.
- **Logs carry counts and ids only, never data.**
- **Release order:** backend first, then the CLI.

## Review Focus

1. **A bump that never arrives** (owed, or a process killed after commit). The entry must still pick up the change
   within 60 s, through the age-triggered delta. Test: Task 4, step 1, "age patch without a bump".
2. **A Swarm deleted or purged while held** (head gone). The delta must not resurrect it: the read reloads and fails
   `PARTS_MISSING` as today. Test: Task 4, "head gone → full load".
3. **One delta moving a group between entries.** A group that wakes leaves `dormant`, `dormant:agent:*` and
   `dormant:project:*`, and joins `parts`, all at the same stamp. Test: Task 9 equivalence, sweep then wake.
4. **An agent removed while its dormant selection is held.** Its conversations are rewritten without it, so the
   selection empties. Test: Task 8, step 1.
5. **The gate and the first app.** An app attaching to a quiet machine must see live events from its first frame on.
   A guest web client counts as UI too. Test: Task 12 and Task 10.

---

### Task 1: `freeze` walks each value once (Part 3)

**Files:**
- Modify: `backend/src/superTabs/cache.ts` (`freeze`, `SwarmCache.load`)
- Test: `backend/src/superTabs/cache.test.ts`

**Interfaces:**
- Produces:
  - `freeze(value: unknown): number`: same estimate as today. A frozen object returns its remembered size without
    visiting children.
  - `sizeOf(value: unknown): number`: the remembered size of a frozen object, or `freeze(value)` when not frozen.
    Used by Task 4's patch accounting.

- [ ] **Step 1: Write the failing tests** in `describe('freeze')`:
  - `'freezes every nested object and tells the same size as before'`: a fixture `{ a: [{ b: 'x' }, new Date(0)],
    c: 1 }`. Assert `Object.isFrozen` on each object, and that the size equals the value hard-coded from today's
    implementation, computed once and pasted in.
  - `'a second freeze visits no child'`: freeze a value, then wrap a child's property in a getter spy via a Proxy
    defined *before* freezing. Assert the second `freeze(value)` returns the same size and the spy count stays 0.
    Equivalently, spy on `Object.entries` with `vi.spyOn` and assert no call on the second freeze.
  - `'sizeOf reads a frozen value without walking it'`.
- [ ] **Step 2: Run, verify they fail.** `npx vitest run src/superTabs/cache.test.ts -t freeze`. Expected: FAIL on the
  second-walk test.
- [ ] **Step 3: Implement.** A module `WeakMap<object, number>`. `freeze` returns the cached size when
  `Object.isFrozen(value)` and the map has it. Otherwise it recurses as today, stores the size, then freezes. Export
  `sizeOf`.
- [ ] **Step 4: Run the whole file.** `npx vitest run src/superTabs/cache.test.ts`. Expected: PASS.

### Task 2: one delta read per Swarm (Phase 1)

**Files:**
- Modify: `backend/src/superTabs/parts/load.ts` (`loadChanged` runs kinds in parallel; new `loadDelta`;
  `CHANGED_FIELDS` gains the head columns)
- Test: `backend/integration/superTabCache.test.ts` (Mongo memory server; add a `describe('loadDelta')`)

**Interfaces:**
- Produces, in `parts/load.ts` (re-exported through `parts/index.ts`):
  ```ts
  export interface SwarmDelta { parts: Part[]; head: HeadColumns | null }   // HeadColumns from parts/write.ts
  export function loadDelta(tx: Prisma.TransactionClient, tabId: string, since: number, kinds: readonly PartKind[]): Promise<SwarmDelta>
  ```
  - `parts`: every part of `kinds` with `changedAt > since`. Machines also come by `readAt > since`, as
    `loadChanged` reads them, with tombstones and dormant groups.
  - `head`: the head row's `groupCounter`, `visibilityEpoch` and `sequenceBase` when `kinds` has `head` and the head
    changed, else `null`.

- [ ] **Step 1: Write the failing tests:**
  - `'loadDelta returns only what changed after since, tombstones and dormancy included'`: write a group, a start, a
    machine reading and a removal after `since`. Assert the keys returned, `deleted` / `dormant` on the parts, and
    that nothing older comes back.
  - `'loadDelta carries the head columns when the head changed'`.
  - `'loadDelta reads only the kinds asked'`: `['machine']` issues no query on other part collections. Use
    `profiledReads` from the file.
- [ ] **Step 2: Run, verify they fail.** `npx vitest run --config vitest.super-tabs.config.ts integration/superTabCache.test.ts -t loadDelta`
- [ ] **Step 3: Implement.**
  - `loadChanged`'s per-kind loop becomes `Promise.all` over kinds, keeping the result order by kind.
  - `loadDelta(tx, tabId, since, kinds)` calls it for one Swarm and adds the head columns.
  - Add `groupCounter`, `visibilityEpoch` and `sequenceBase` to `CHANGED_FIELDS`. The other collections lack them,
    and `toPart` ignores them.
- [ ] **Step 4: Run** the step 2 command plus `npx vitest run src/superTabs`. Expected: PASS, including the existing
  `loadChanged` tests.

### Task 3: patch rules and the digest (Phase 1)

**Files:**
- Create: `backend/src/superTabs/cachePatch.ts`
- Test: `backend/src/superTabs/cachePatch.test.ts`

**Interfaces:**
- Consumes: `SwarmDelta` (Task 2), `startFinished` (`parts/write.ts`).
- Produces:
  ```ts
  export interface PatchRule<T> { kinds: readonly PartKind[]; apply(held: T, delta: SwarmDelta): T | 'reload' }
  export const baseRule: PatchRule<SwarmParts>          // the 'parts' entry (loadReadBase)
  export const machinesRule: PatchRule<Part<MachineData>[]>
  export const dormantRule: PatchRule<Part<GroupData>[]>                    // all dormant groups
  export function groupRule(key: string): PatchRule<Part<GroupData>[]>     // 'group:{id}' entries (0 or 1 part)
  export const lastChangedAtRule: PatchRule<number | null>
  export function cacheDigest(value: unknown): string
  ```
- **Rules.** A part is applied only when its `version` is greater than the held one with the same key. Each rule:
  - **`baseRule`:**
    - replace or add by key in the kind's list;
    - drop a `deleted` part;
    - drop a group that is `dormant`;
    - a non-dormant group joins;
    - head data and the three head columns are replaced;
    - a changed `visibilityEpoch` returns `'reload'`;
    - machine parts are ignored, since the base holds none.
  - **`machinesRule`:** by key; `deleted` drops.
  - **`dormantRule`:** a part that is `dormant` and not `deleted` is added or replaced; otherwise the key is dropped.
  - **`groupRule(key)`:** only that key; a `deleted` part empties the list.
  - **`lastChangedAtRule`:** `max(held ?? 0, newest changedAt in delta.parts)`. Use `changedAt`, never `readAt`.
- **Values stay frozen.** Return a new object or array when anything changed, and the same reference when nothing
  did. Call `freeze` on new parts only (Task 1).
- **`cacheDigest`:**
  - canonical JSON with keys sorted;
  - every array whose items are parts (have `kind`, `key`, `version`) sorted by `kind` then `key`;
  - `version` dropped from parts;
  - `sha256` hex.

- [ ] **Step 1: Write the failing tests**, one `it` per rule behaviour above, each asserting the returned value's
  content and that unchanged parts are the same references:
  - `'an older or equal version is ignored'`;
  - `'a tombstone removes'`;
  - `'a group put to sleep leaves the base and joins dormant'` (two rules, one delta);
  - `'a woken group leaves dormant and joins the base'`;
  - `'a finished start stays in the base'` (Phase 2 changes this in Task 7);
  - `'head columns are patched'`;
  - `'a visibilityEpoch change asks for a reload'`;
  - `'groupRule ignores other keys and empties on a tombstone'`;
  - `'lastChangedAt takes the newest changedAt, not readAt'`;
  - `'cacheDigest ignores part order and versions but not data'`.
- [ ] **Step 2: Run, verify they fail.** `npx vitest run src/superTabs/cachePatch.test.ts`
- [ ] **Step 3: Implement** `cachePatch.ts`. One shared helper
  `applyByKey<T>(list: readonly Part<T>[], changed: Part[], keep: (p: Part) => boolean): Part<T>[]` carries the
  version rule.
- [ ] **Step 4: Run.** Expected: PASS.

### Task 4: the cache patches stale entries (Phase 1)

**Files:**
- Modify: `backend/src/superTabs/cache.ts` (`SwarmCache`, `CacheView`, `configureSwarmStamps`)
- Create: `backend/src/superTabs/cacheStats.ts` (minute log, `retryStats.ts` style)
- Test: `backend/src/superTabs/cache.test.ts`, `backend/src/superTabs/cacheStats.test.ts`

**Interfaces:**
- Consumes: `PatchRule`, `SwarmDelta`, `sizeOf`, `OVERLAP_MS` (`read/cursor.ts`).
- Produces:
  - **`CacheOptions` gains:**
    - `delta?: (tabId: string, since: number, kinds: readonly PartKind[]) => Promise<SwarmDelta>`; absent means
      today's drop-and-reload;
    - `deltaMaxAgeMs?` (600 000);
    - `deltaMaxParts?` (500);
    - `verifyRate?` (0, used by Task 5).
  - **`CacheView`** records `at`, the time its stamps were read. `CacheView.get<T>(tabId, name, scope, load,
    patch?: PatchRule<T>)`: a fifth parameter; every existing caller keeps working.
  - **`Entry`** gains `readStart`, `fullAt`, `stale`, `patch?`, `load`.
  - **`cacheStats.ts`:**
    - `recordCache(name: string, event: 'hit' | 'full' | 'patch', detail?: { bytes?: number; parts?: number; reason?: ReloadReason })`;
    - `type ReloadReason = 'cold' | 'age' | 'epoch' | 'parts' | 'error' | 'off' | 'since'`;
    - `startCacheStats({ everyMs, log }): () => void`, which logs `'swarm cache'` with `{ windowMs, entries }` and
      nothing for an empty window.
    - `name` is the entry name up to its first `:` (`group:abc` → `group`).
- **Behaviour.** `drop` (bus or stamp mismatch) marks entries that have `patch` as stale and deletes the others. A
  `get` then goes one of four ways:
  - **Hit:** a fresh entry at the view's stamps, younger than `CACHE_MAX_AGE_MS`.
  - **Patch:** a stale entry or one past 60 s, with `delta` configured and `now − fullAt < deltaMaxAgeMs`:
    - fetch the Swarm's delta through a single flight keyed
      `tabId|stamp.main|stamp.machine|kinds.sort().join()`;
    - `since` = min `readStart` of that Swarm's stale entries needing those kinds, minus `OVERLAP_MS`;
    - an entry whose `readStart − OVERLAP_MS` is before the flight's `since` reloads with reason `since`;
    - apply the rule. `'reload'`, or more than `deltaMaxParts` parts, means a full load with reason `epoch` or
      `parts`. A delta error means a full load with reason `error`;
    - on success, store the entry with the view's stamps, `readStart` = the view's `at` and `bytes` re-summed with
      `sizeOf`.
  - **Full load:** as today, with `fullAt` = `readStart` = the view's `at`.
  - **Eviction:** over budget, evict stale entries first, then least recently used.
- **Kinds per bump.** A machine-only bump marks only scope `all` entries stale, so their delta asks only for
  `['machine']`.

- [ ] **Step 1: Write the failing tests.** Use a fake `delta` that returns scripted parts and counts calls, and
  `MemoryStamps`:
  - `'a bump patches a held entry instead of loading it'`: `load` called once, `delta` once, value patched;
  - `'readers of one Swarm at one stamp share one delta'`;
  - `'a machine-only bump asks the delta for machines only'`;
  - `'age patch without a bump'`: advance `now` 61 s, assert a delta call, no load;
  - `'past DELTA_MAX_AGE_MS it loads in full'`;
  - `'over DELTA_MAX_PARTS it loads in full'`;
  - `'a delta error loads in full and counts error'`;
  - `'reload from the rule loads in full'`;
  - `'head gone → full load'`: the full load throws `PARTS_MISSING` to the reader;
  - `'entries without a rule are dropped as before'`;
  - `'without delta configured the cache behaves as today'`: rerun the existing tests unchanged;
  - `'stale entries are evicted first'`.

  In `cacheStats.test.ts`:
  - `'counts by entry name and reason and logs nothing in an empty window'`.
- [ ] **Step 2: Run, verify they fail.** `npx vitest run src/superTabs/cache.test.ts src/superTabs/cacheStats.test.ts`
- [ ] **Step 3: Implement** in `cache.ts` and `cacheStats.ts`. The `stamps.subscribe` listener now calls the
  stale-marking `drop`.
- [ ] **Step 4: Run** the step 2 command and `npx vitest run src/superTabs/cacheRedis.test.ts` (with
  `REDIS_TEST_URL`). Expected: PASS.

### Task 5: verify sample (Phase 1)

**Files:**
- Modify: `backend/src/superTabs/cache.ts`
- Modify: `backend/src/superTabs/cacheStats.ts` (events `verify` and `mismatch`)
- Test: `backend/src/superTabs/cache.test.ts`

**Interfaces:**
- Consumes: `cacheDigest`, `CacheOptions.verifyRate`, `options.random?: () => number` (test seam, default
  `Math.random`).
- **Behaviour.** After a successful patch, if `random() < verifyRate` and no verify runs on this process:
  - read the Swarm's stamps;
  - run the entry's `load` in the background;
  - read the stamps again. If they moved, the check is inconclusive and nothing is counted.
  - Otherwise compare `cacheDigest`. A mismatch:
    - drops the entry;
    - logs `logger.warn('swarm cache verify mismatch', { entry, tabId, kinds, keys })`, where `keys` are the
      differing part keys, up to 20, with no data;
    - counts `mismatch`.
  - Never on the request path: the reader already has its value.

- [ ] **Step 1: Write the failing tests:**
  - `'a sampled patch is checked against a full load'`: `random = () => 0`, equal values, one `verify`, no
    mismatch;
  - `'a mismatch drops the entry and logs ids only'`: the load returns a part with different data; assert the warn
    arguments contain the key and no data field;
  - `'a stamp move during the check counts nothing'`;
  - `'one check at a time per process'`.
- [ ] **Step 2: Run, verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/superTabs/cache.test.ts`. Expected: PASS.

### Task 6: wire the entries, switches and log (Phase 1)

**Files:**
- Modify: `backend/src/superTabs/cachedReads.ts`:
  - `base` passes `baseRule`;
  - `readMachines` passes `machinesRule`;
  - the `dormant` get passes `dormantRule`;
  - `group:${id}` passes `groupRule(id)`;
  - `readLastChangedAt` / `readLastChangedAts` pass `lastChangedAtRule`;
  - `light:*`, `light-group:*`, `feed` and `host:inputs` pass none.
- Modify: `backend/src/config/env.ts`:
  - `SWARM_CACHE_DELTA: z.enum(['on','off']).default('on')`;
  - `SWARM_CACHE_VERIFY_RATE: z.coerce.number().min(0).max(1).default(0.01)`.
- Modify: `backend/src/server.ts`:
  - `configureSwarmStamps(..., { reads, maxBytes, delta: env.SWARM_CACHE_DELTA === 'on' ? (tabId, since, kinds) => loadDelta(prisma, tabId, since, kinds) : undefined, verifyRate: env.SWARM_CACHE_VERIFY_RATE })`;
  - `const stopCacheStats = startCacheStats()` beside `startRetryStats`, stopped on shutdown beside it.
- Test: `backend/src/superTabs/cachedReads.test.ts`

- [ ] **Step 1: Write the failing test** `'each patchable read passes its rule'`. Spy on `CacheView.get` and assert the
  fifth argument per entry name, and `undefined` for `light:`, `light-group:` and `feed`.
- [ ] **Step 2: Run, verify it fails.** `npx vitest run src/superTabs/cachedReads.test.ts`
- [ ] **Step 3: Implement** the wiring above.
- [ ] **Step 4: Run** `npx tsc --noEmit` and `npx vitest run src/superTabs src/lib`. Expected: PASS.

### Task 7: finished starts leave the base (Phase 2)

**Files:**
- Modify: `backend/src/superTabs/parts/load.ts`:
  - `loadReadBase`'s start match becomes `{ deleted: false, finishedAt: null }`;
  - new `loadFinishedStarts`.
- Modify: `backend/src/superTabs/cachePatch.ts`:
  - `baseRule` drops a start whose data is finished (`startFinished`);
  - new `finishedStartsRule`.
- Modify: `backend/src/superTabs/cachedReads.ts` (`readParts`, `namedStarts`)
- Test: `backend/src/superTabs/cachePatch.test.ts`, `backend/src/superTabs/cachedReads.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function loadFinishedStarts(tx: Prisma.TransactionClient, tabId: string): Promise<Part<AgentStart>[]>
  // aggregateRaw $match { tabId, deleted: false, finishedAt: { $ne: null } }: a plain match, not Prisma's `not`
  export const finishedStartsRule: PatchRule<Part<AgentStart>[]>   // kinds ['start']: finished and live → upsert, else drop
  export function namedStarts(hot: Part<AgentStart>[], finished: Part<AgentStart>[] | null, named: ReadNamed): Part<AgentStart>[]
  ```
- **`readParts` reads the `finished-starts` entry only when** `named.includeRecentStarts`, any `named.startIds` key
  is not among the hot starts, or `named.startAgentIds` is non-empty. A `WeakMap` keyed by the held array, built
  once, gives the finished starts by agent (`stableId(machineId, harnessId)`).
- **Order unchanged:** the hot starts first, then the finished ones the read named. `reassemble` sorts by `ordinal`.

- [ ] **Step 1: Write the failing tests:**
  - **In `cachePatch.test.ts`:**
    - `'a start that finishes moves from the base to finished-starts'`;
    - `'the 7-day expiry tombstone leaves finished-starts'`.
  - **In `cachedReads.test.ts`:**
    - `'a read naming nothing never loads finished starts'`: the `finished-starts` loader is not called;
    - `'first loads, a named finished start and an agent's starts read them'`;
    - `'the agent index is built once per held array'`.
- [ ] **Step 2: Run, verify they fail.**
- [ ] **Step 3: Implement.**
  - Update `baseRule`, and its Task 3 test `'a finished start stays in the base'`, to "leaves the base".
  - Update the existing `namedStarts` tests in `cachedReads.test.ts` (four calls) to the new signature. Split
    `all` into its unfinished and finished lists, and keep each expected key set.
- [ ] **Step 4: Run** `npx vitest run src/superTabs`. Expected: PASS.

### Task 8: dormant groups by selection (Phase 2)

**Files:**
- Modify: `backend/src/superTabs/cachedReads.ts` (`readParts` dormant branch)
- Modify: `backend/src/superTabs/cachePatch.ts` (new rules)
- Test: `backend/src/superTabs/cachePatch.test.ts`, `backend/src/superTabs/cachedReads.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function dormantAgentRule(agentId: string): PatchRule<Part<GroupData>[]>     // dormant, live, data.agentIds includes agentId
  export function dormantProjectRule(projectId: string): PatchRule<Part<GroupData>[]> // dormant, live, (data.projectId ?? 'lead') === projectId
  ```
- **Entries:**

  | Entry | Loads |
  |---|---|
  | `dormant:agent:{id}` | `store.loadGroups(db, tabId, 'agents', { agentIds: { $in: [id] }, dormant: true })` |
  | `dormant:project:{id}` | `store.loadGroups(db, tabId, 'project', { projectId: { $in: id === 'lead' ? ['lead', null] : [id] }, dormant: true })` |

  `allGroups` keeps the whole `dormant` entry with `dormantRule`. A read naming several agents or projects merges
  their entries by key, each group once, in the order today's filter yields: dormant entry order filtered.
  Equivalence is by set, since `reassemble` sorts.

- [ ] **Step 1: Write the failing tests:**
  - `'a read naming one agent loads that agent's dormant groups only'`: the loader is called with that agent's
    match, and `dormant` is never loaded;
  - `'several agents and projects merge without duplicates'`;
  - `'lead includes groups stored with no project'`;
  - `'an agent removed while its selection is held'`: a delta rewriting its groups without it empties
    `dormant:agent:{id}`;
  - `'a woken group leaves every dormant selection'`.
- [ ] **Step 2: Run, verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/superTabs`. Expected: PASS.

### Task 9: equivalence with real commands (Phases 1–2)

**Files:**
- Create: `backend/integration/superTabCacheDelta.test.ts`, using `superTabCache.test.ts`'s `pod`, `privateScene`
  and `MemoryStamps` setup (copy the setup block; do not import from another test file)
- Modify: `backend/vitest.super-tabs.config.ts` (add the file to `include`)

**Tests:**
- **`'patched entries equal fresh loads after every command'`:**
  - one pod configured with `delta: loadDelta`, and a second pod with no cache as the oracle;
  - a seeded random sequence of 60 commands through `SuperTabStore` on `privateScene()`:
    - `message.send`;
    - a task assigned and finished;
    - an `agent.start` that finishes;
    - `sweepSwarms` putting a group to sleep, then a message waking it;
    - `agent.remove`;
    - a project rename;
    - a machine reading (`observeMachine`);
  - after each, for each held entry (`parts`, `machines`, `dormant`, `dormant:agent:*`, `dormant:project:*`,
    `finished-starts`, `group:*`, `lastChangedAt`): `cacheDigest(patched) === cacheDigest(fresh load of the same
    entry)`;
  - also `readParts` for first-load, `startIds`, `startAgentIds`, `agentIds`, `projectIds` and `allGroups` equal to
    `loadActive` in a transaction, compared by digest.
- **`'a write committed after the load but stamped 20 s earlier is in the next patch'`:**
  - write a part with `guardedWrite(tx, tabId, write, Date.now() - 20_000)` after the entry loaded;
  - bump, read, and assert the patch has it.
- **`'versions from reads are never a write guard'`:** grep-style. Read `superTabs/**/*.ts` and assert every
  `guardedWrite(` call site's `seen:` comes from a variable loaded in the same function through `tx`. If this cannot
  be checked mechanically, replace it with a note in the PR and a code-review item; do not ship a test that asserts
  nothing.

- [ ] **Step 1: Write the tests.**
- [ ] **Step 2: Run** `npx vitest run --config vitest.super-tabs.config.ts integration/superTabCacheDelta.test.ts`.
  Expected: PASS. A failure here is a bug in Tasks 3–8: fix it there.

### Task 10: count publishes nobody receives, and offer the gate (Part 4, backend)

**Files:**
- Modify: `backend/src/lib/relayStats.ts` (`Counts` gains `none`; `recordRelay` counts `published` with
  `receivers === 0`)
- Modify: `backend/src/config/env.ts` (`RELAY_UI_GATE: z.enum(['on','off']).default('on')`)
- Modify: `backend/src/lib/hub.ts` (`recomputeAndSendClients` payload adds `uiGate: true` unless
  `env.RELAY_UI_GATE === 'off'`)
- Test: `backend/src/lib/relayStats.test.ts`, `backend/src/lib/hub.test.ts`, `backend/src/lib/registry.test.ts`
  (create if missing)

- [ ] **Step 1: Write the failing tests:**
  - `'a publish reaching no subscriber counts as none'`;
  - `'__clients carries uiGate, and none with RELAY_UI_GATE=off'`;
  - `'ui counts web and guest web clients, never commanders'` (`registry.clientCounts`).
- [ ] **Step 2: Run, verify they fail.** `npx vitest run src/lib/relayStats.test.ts src/lib/hub.test.ts src/lib/registry.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.

### Task 11: one guard, no extra promise, per Redis command (Part 4)

**Files:**
- Modify: `backend/src/lib/circuitBreaker.ts`:
  - `withTimeout` builds no `AbortController` without `timeoutMs`; pass a module-level never-aborted signal;
  - the interface gains `success(): void` and `failure(err: unknown): void`, the same accounting `run` applies.
- Modify: `backend/src/lib/redisGuard.ts`:
  - while `breaker.state() === 'closed'`: `send(command)`, then
    `command.promise.then(() => breaker.success(), err => breaker.failure(err))`, and return `command.promise`;
  - otherwise today's `breaker.run` path.
- Test: `backend/src/lib/circuitBreaker.test.ts`, `backend/src/lib/redisGuard.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - `'a closed circuit sends without run'`: spy `run`, assert 0 calls;
  - `'five failures through the fast path open it'`;
  - `'open refuses, and after 5 s one trial closes it on success'`;
  - `'a reply error does not count as a failure'`.

  Keep every existing test in both files unchanged and passing.
- [ ] **Step 2: Run, verify they fail.** `npx vitest run src/lib/circuitBreaker.test.ts src/lib/redisGuard.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command, plus `npx vitest run src/lib` with `REDIS_TEST_URL`. Expected: PASS.

### Task 12: the daemon stops live events nobody views (Part 4, CLI)

**Files:**
- Modify: `cli/src/gateway/gateway.ts`
- Test: `cli/src/gateway/gateway.spec.ts`

**Interfaces:**
- Produces:
  - `export const UI_GATED_EVENTS: ReadonlySet<string>`, exactly: `text_delta`, `tool_start`, `tool_end`,
    `user_message`, `thinking_delta`, `thinking_title`, `turn_heartbeat`, `agent_activity`, `turn_ended`,
    `turn_summary`, `subagent_finished`, `done`, `context_compact`;
  - `export const UI_QUIET_MS = 60_000`.
- **State.** `private uiGate: { ui: number } | null = null`, set from `__clients` only when its payload has
  `uiGate === true`, and reset to `null` in `linkGone()`. Also `private lastRemoteFrameAt = 0`.
- **Recording remote frames.** In `dispatchDown`, after the observer hand-off, stamp `lastRemoteFrameAt = Date.now()`
  for every frame whose `connId` is non-empty, not `observer:`, not a device connection (`isDeviceConn`), and
  arriving over `relay` or `p2p`. This includes `e2e_*`, so place it before the `e2e_` branch.
- **The check.** `private heldForNoUi(type: unknown): boolean` is true only if all hold:
  - `uiGate !== null`;
  - `uiGate.ui === 0`;
  - `Date.now() - lastRemoteFrameAt >= UI_QUIET_MS`;
  - `type` is in `UI_GATED_EVENTS`.
- **In `broadcast`,** the untargeted enqueue is also skipped when `heldForNoUi(frame.type)`. Guest copies, and
  `commander`, `user`, `observer` and `sendTo`, are untouched.

- [ ] **Step 1: Write the failing tests**, in `describe('ui gate')`:
  - `'a live event is not relayed while the backend says no UI and none spoke for 60 s'`;
  - `'relayed with ui > 0'`;
  - `'relayed again at once when a remote web frame arrives (its e2e hello)'`;
  - `'relayed before any __clients, and after the link drops'`;
  - `'relayed when __clients has no uiGate (older backend or switch off)'`;
  - `'turn_started, agent_synced and agent_deleted are never held'`;
  - `'guest copies, device, user and targeted frames are never held'`.
- [ ] **Step 2: Run, verify they fail.** `cd cli && npx vitest run src/gateway/gateway.spec.ts -t "ui gate"`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/gateway` and `npm run typecheck`. Expected: PASS.

### Task 13: confidential marks, Leads and waiting workers in one pass (Part 5)

**Files:**
- Modify: `backend/src/superTabs/projects.ts`:
  - `ledProject` in O(projects + conversations);
  - new `confidentialSets`;
  - `markConfidential`, `requireSingleRegistration` and `confidentialSession` use it.
- Modify: `backend/src/superTabs/model.ts`:
  - `awaitingWorkers` takes an optional index;
  - `visibleState` builds it once for all projects.
- Modify: `backend/src/superTabs/migration/normalize.ts`: pass one index for its loop too.
- Test: `backend/src/superTabs/projects.test.ts`, `backend/src/superTabs/model.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // projects.ts
  export function confidentialSets(state: SuperTabState): { leaders: ReadonlySet<string>; privateMembers: ReadonlySet<string> }
  // model.ts
  export interface WorkerIndex { leaders: ReadonlySet<string>; working: ReadonlySet<string>; groupsByAgent: ReadonlyMap<string, Conversation[]> }
  export function workerIndex(state: SuperTabState): WorkerIndex
  export function awaitingWorkers(state: SuperTabState, projectId: string, index?: WorkerIndex): Agent[]
  ```
- **What each lookup holds:**
  - `leaders`: agents that are `leadId` of a conversation whose id is a project's `leadConversationId`.
  - `privateMembers`: every agent id in a conversation with `audience`.
  - `groupsByAgent`: groups in conversation order, `assignment.agentId` set and not `lost`.
  - `ledProject` collects the matching Lead conversation ids in one scan. It then returns
    `projectsOf(state).find(p => matched.has(p.leadConversationId))`, the same project order as today.
- **Lookups are built per call** (or per caller loop), never stored on the state.

- [ ] **Step 1: Write the failing tests:**
  - **`'new and old answers agree on generated Swarms'`:**
    - keep the current implementations as `legacyLedProject`, `legacyMarkConfidential` and
      `legacyAwaitingWorkers` *inside the test file*, copied from today's source;
    - generate 200 seeded Swarms of up to 2,000 conversations, 50 agents and 20 projects, including:
      - no projects;
      - private projects;
      - Leads without a conversation;
      - an agent leading two projects;
      - lost assignments;
      - audience conversations;
      - an agent already marked;
    - assert equal results for `ledProject` (every agent), `markConfidential` (the set of marked agents),
      `requireSingleRegistration` (throws or not, same code) and `awaitingWorkers` (every project).
  - **`'markConfidential scans the conversations a constant number of times'`:** wrap `state.conversations` in a
    Proxy counting iterator calls; assert ≤ 3 for a 50-agent Swarm.
- [ ] **Step 2: Run, verify the scan test fails.** `npx vitest run src/superTabs/projects.test.ts src/superTabs/model.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/superTabs`. Expected: PASS.

### Task 14: cost shipping and the messages page's join (Part 5)

**Files:**
- Modify: `backend/src/superTabs/costs/read.ts` (`shipping` groups rows by `conversationId` once)
- Create: `backend/src/superTabs/read/pageDeliveries.ts`
- Modify: `backend/src/superTabs/store.ts` (the messages return uses the new function)
- Test: `backend/src/superTabs/costs/read.test.ts`, `backend/src/superTabs/read/pageDeliveries.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function deliveriesByMessage<D extends { messageId: string }>(deliveries: readonly D[]): ReadonlyMap<string, D[]>   // each list in input order
  ```
  `store.ts` becomes
  `(byMessage.get(m.id) ?? []).filter(d => shownTo(m, d)).sort(receiptOrder(m))`.

- [ ] **Step 1: Write the failing tests:**
  - `'deliveriesByMessage keeps input order per message'`;
  - `'shipping answers as before'`: legacy copy in the test, seeded rows and groups, including several attempts and
    no attempt before `shippedAt`.

  The messages route's existing tests (`superTabs.test.ts` integration: agent, person and Buddy readers) must stay
  green unchanged.
- [ ] **Step 2: Run, verify they fail.** `npx vitest run src/superTabs/costs/read.test.ts src/superTabs/read/pageDeliveries.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command and `npx vitest run --config vitest.super-tabs.config.ts integration/superTabs.test.ts`.
  Expected: PASS.

### Task 15: validation and measurement

- [ ] **Step 1: Typecheck.** `cd backend && npm run typecheck`; `cd cli && npm run typecheck`. Expected: clean.
- [ ] **Step 2: Backend unit suite with real Redis.**
  `cd backend && REDIS_TEST_URL=redis://127.0.0.1:6379/15 npx vitest run`. Expected: 0 failed.
- [ ] **Step 3: Backend integration suite.** `npx vitest run --config vitest.super-tabs.config.ts`. Expected: 0 failed
  except the documented flaky `superTabCache` "named light conversations"; rerun it alone once.
- [ ] **Step 4: CLI.** `cd cli && npx vitest run src/gateway`, then `npm test`. Compare any red against `main`'s known
  failures (memory: test-suite baseline).
- [ ] **Step 5: Benchmark on prod's busiest Swarm copy** (`harness_profile` Mongo, local Redis):
  - `npm run bench:swarm-state -- --cache redis://127.0.0.1:6379/15`, before (on `main`) and after;
  - record bytes read and ms per bump for one `message.send` and one task finish, and the `swarm cache` log.
- [ ] **Step 6: Local CPU profile** of the same load (`SELF_PROFILE` as in the 2026-10-30 runs). Record `calls` and
  self-time for:
  - `freeze`;
  - `ledProject`'s callback;
  - `privateMember`;
  - `awaitingWorkers`, `activeWork`;
  - the messages join;
  - `redisGuard`.

  Compare against the spec's table.
- [ ] **Step 7: Independent review.** Dispatch one fresh reviewer (Opus) with the spec, this plan and the full diff
  versus `origin/main`. Fix what it finds, then rerun Steps 1–4.
- [ ] **Step 8: Report to Ken:** results, numbers, review outcome, and anything that deviated from the spec. Wait for
  his word before committing.
