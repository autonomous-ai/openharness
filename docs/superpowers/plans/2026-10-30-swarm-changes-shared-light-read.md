# Swarm `changes`: a small, shared light read — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Desktop/web `GET /api/super-tabs/:tabId/changes` miss reads only what its reply needs, once per Swarm per stamp per pod, whoever reads.

**Architecture:** `loadLight` stops loading every live start's conversation and the progress part; it adds legacy agents' active conversations and matches `awaitingWorkers`' busy rule. The poll reads one shared light base (no per-person ids in its cache name) and adds per-reader conversations (waiting tags, `unheld`) through a new per-group cached read. `SwarmCache` indexes entries per Swarm so per-group entries do not slow every bump.

**Tech Stack:** TypeScript, Fastify, Prisma on MongoDB, vitest, `mongodb-memory-server` for integration tests.

**Spec:** `docs/superpowers/specs/2026-10-30-swarm-changes-shared-light-read-design.md`

## Global Constraints

- The reference reply is what the full state gives (`readParts`, as `firstLoad` reads it): active conversations only (spec section 0).
- No stored data changes; no migration; no client change; reply shapes unchanged.
- Held cache values stay the stored state, the same for every reader; permissions stay after the cache (`readerView`, `changesFor`, `readableMarks`).
- Do not commit. Ken commits; each task ends with a diff checkpoint instead.
- Remove what becomes dead (`recentStartGroups`, the all-time mention `distinct`); no inert stubs.
- Commands from `backend/`. Unit: `npx vitest run <file>`. Integration: `npx vitest run --config vitest.super-tabs.config.ts <file>`.

## Review Focus

1. A Buddy reading `changes` after the change: replies still carry no machine or start ids (`changesFor` buddy rules) — Task 5 equality test includes a Buddy reader.
2. A reader tagged in a conversation they can no longer read (removed from a private project): the tag's conversation is loaded but `readable` must not count it — Task 5 test.
3. A finished start, listed by a machine record, whose conversation is dormant and private: the collaborator's reply must not name it (existing #2247 test, must stay green; Task 5 re-runs it).
4. A cache entry for a conversation id that does not exist: held as "none", read once per stamp, never throws — Task 4 test.
5. A Swarm bumped many times while other Swarms hold entries: other Swarms' entries and the byte/entry counts survive — Task 1 test.

---

### Task 1: `SwarmCache` indexes its entries per Swarm

**Files:**
- Modify: `backend/src/superTabs/cache.ts` (`SwarmCache`: `drop`, `held`, `load`, `drop1`, eviction loop)
- Test: `backend/src/superTabs/cache.test.ts`

**Interfaces:**
- Produces: unchanged public API (`drop(tabId, scopes)`, `held`, `load`, `size`); `drop` now touches only that Swarm's entries.

- [ ] **Step 1: Write the failing test** in `describe('SwarmCache')`:

```ts
it('drops only the bumped Swarm\'s entries, keeping counts right through drops, evictions and expiry', async () => {
  // Fill tabs 'a' and 'b' with 3 entries each at their stamps; drop('a').
  // expect(cache.size.entries).toBe(3); expect(cache.size.bytes).toBe(bytesOfB)
  // Then: a machine-only drop('b', ['machine']) keeps b's 'main'-scoped entries.
  // Then: exceed maxBytes so the oldest of b is evicted; expire one past maxAgeMs and read it (held removes it);
  // after each, size.entries and size.bytes equal the sums over what get() still serves without loading.
})
```

- [ ] **Step 2: Run** `npx vitest run src/superTabs/cache.test.ts` — the new test passes or fails only on counts; it must fail if `drop('a')` touched b. If it already passes (behaviour is the same today), keep it as the guard and continue: this task is a cost change.

- [ ] **Step 3: Implement** a `private readonly bySwarm = new Map<string, Set<string>>()` (tabId → entry keys). Store `tabId` on `Entry`. Add to the set in `load`; remove in `drop1`, the stale branch of `held`, the eviction loop and `drop`; delete a Swarm's set when it empties. `drop` iterates `bySwarm.get(tabId)` only.

- [ ] **Step 4: Run** `npx vitest run src/superTabs/cache.test.ts src/superTabs/cacheRedis.test.ts` — all pass.

- [ ] **Step 5: Checkpoint** `git diff --stat` shows only `cache.ts` and `cache.test.ts`.

### Task 2: `loadLight` reads only what light readers need

**Files:**
- Modify: `backend/src/superTabs/parts/light.ts` (`undecidedWork`, `loadLight`)
- Modify: `backend/src/superTabs/read/service.ts:35` (`LoadOptions` loses `recentStartGroups`)
- Test: `backend/integration/superTabRead.test.ts` (new `describe('a change poll reads only what its reply needs (DB 2.3)')`)

**Interfaces:**
- Produces: `loadLight(tx, tabId, opts: { groupIds?; agentIds?; projectIds?; includeRecentStarts?; groups?: 'active' | 'working'; machines?: boolean })` — `recentStartGroups` removed; returned `progress` is always `[]`.

- [ ] **Step 1: Write the failing tests** (use the file's `scene`, `get`, `keys`, `clock` helpers):

```ts
it('reads an agent that is only a member of running work as awaiting its decision, as a full read does', async () => {
  // Scene: agent X has no stored workDecision; X is assignee of finished (status 'done') work in active conversation A
  // with no start; X is in agentIds (not assignee) of running conversation B.
  // After a post (cursor before it): changes.derived.agents[X].workDecision === 'awaiting'
  // and equals (await get(`/api/super-tabs/${tabId}/parts`, owner)).body.data.derived.agents[X].workDecision
})
```

- [ ] **Step 2: Run** `npx vitest run --config vitest.super-tabs.config.ts integration/superTabRead.test.ts -t "member of running work"` — FAIL once Step 3's start-conversation removal is in (today the start conversations can mask it; if it passes today, keep it as the guard).

- [ ] **Step 3: Implement in `parts/light.ts`:**
  - `undecidedWork`: busy = Lead of a loaded conversation, or assignee of its active work (drop `...g.data!.agentIds`); Reviewers (`agentRole(a) === 'reviewer'`) are never undecided — the same rule as `model.ts awaitingWorkers`.
  - `loadLight`: delete `recentStartGroups` and the `distinct` on `SwarmStart`; `working` takes `starts.map(s => s.data!.request.conversationId)`.
  - `loadLight`, `groups === 'working'` only: after members/agents load, add active conversations of agents with no `data.projectId` through `['agents', { agentIds: { $in: legacy }, dormant: false }]` (as `parts/load.ts loadObserved`); run it beside `undecidedWork` in one `Promise.all`; no query when `legacy` is empty.
  - `loadLight`: no `SwarmProgress` read; return `progress: []`.

- [ ] **Step 4: Run** `npx vitest run --config vitest.super-tabs.config.ts integration/superTabRead.test.ts integration/superTabGroupPlans.test.ts` and `npx vitest run src/superTabs/parts/light.test.ts src/superTabs/read` — all pass, including `an agent stored with no project stays hidden from a collaborator…` and the host-form tests.

- [ ] **Step 5: Checkpoint** `git diff --stat`.

### Task 3: A person's waiting-tag conversations

**Files:**
- Modify: `backend/src/superTabs/mentions.ts` (export a helper beside `readable`)
- Test: `backend/integration/superTabRead.test.ts` (same new describe)

**Interfaces:**
- Produces: `waitingTagConversations(tx: Tx, tabId: string, personId: string, now: number): Promise<string[]>` — distinct `conversationId`s of the rows `readable(..., open = true)` reads: `tabId`, `personId`, `createdAt > now - MENTION_EXPIRY_MS`, `waiting`, newest first, `take: 500`. `readable` uses the same `where` (one shared constant, not a copy).

- [ ] **Step 1: Write the failing test:**

```ts
it('names only the conversations of a person\'s waiting tags', async () => {
  // Tags for owner: waiting in C1, resolved in C2, waiting but older than 30 days in C3.
  // expect(await waitingTagConversations(db, tabId, owner.sub, clock)).toEqual([C1])
})
```

- [ ] **Step 2: Run** `-t "waiting tags"` — FAIL: not exported.
- [ ] **Step 3: Implement** the helper and share the `where` with `readable`.
- [ ] **Step 4: Run** the test and the file's existing tag tests (`marks which tags wait…`) — PASS.
- [ ] **Step 5: Checkpoint** `git diff --stat`.

### Task 4: `readLightGroups`: named conversations held per group

**Files:**
- Modify: `backend/src/superTabs/cachedReads.ts`
- Test: `backend/integration/superTabCache.test.ts` (`describe('composing a read from what the cache holds')`)

**Interfaces:**
- Consumes: `parts/light.ts loadLightGroups(tx, tabId, 'key', { key: { $in: ids } })`; `CacheView.get`.
- Produces: `readLightGroups(db: Db, view: CacheView, tabId: string, ids: readonly string[]): Promise<Part<GroupData>[]>` — one entry per id named `light-group:<id>`, scope `'main'`, value `Part<GroupData> | null` (null = deleted or unknown); misses of one call batched into one query, as `readLastChangedAts` batches; result in `ids` order, nulls left out; without stamps reads Mongo directly.

- [ ] **Step 1: Write the failing test:**

```ts
it('holds named light conversations per group: a second reader and an unknown id read nothing at the same stamp', async () => {
  // privateScene(); pick a dormant conversation D (make one dormant via a command or guardedWrite).
  // const { cache } = pod(); view = await cache.at([tabId])
  // first = await partReads(() => readLightGroups(db, view, tabId, [D, 'nope'])) -> first.reads === 1, value keys [D]
  // again with a fresh view at the same stamp -> reads === 0
  // after a bump (send a message) -> one read again
})
```

- [ ] **Step 2: Run** `npx vitest run --config vitest.super-tabs.config.ts integration/superTabCache.test.ts -t "named light"` — FAIL: not exported.
- [ ] **Step 3: Implement** `readLightGroups`.
- [ ] **Step 4: Run** the whole `integration/superTabCache.test.ts` — PASS.
- [ ] **Step 5: Checkpoint** `git diff --stat`.

### Task 5: The `changes` poll reads one shared base

**Files:**
- Modify: `backend/src/superTabs/read/service.ts` (`changes`, lines 114-145)
- Test: `backend/integration/superTabCache.test.ts`, `backend/integration/superTabRead.test.ts`

**Interfaces:**
- Consumes: Task 2 `loadLight` (no `recentStartGroups`), Task 3 `waitingTagConversations`, Task 4 `readLightGroups`.
- Produces: no new exports. Inside `changes`: `const LIGHT = { groups: 'working' as const }`; `base = await readLight(tx, cached, tabId, LIGHT)`; named ids = `asAgentId ? [] : await waitingTagConversations(tx, tabId, user.sub, t0)`; the loader passed to `load` returns `withStarts(withGroups(base, await readLightGroups(tx, cached, tabId, ids not in base)), extra)`, where `withGroups(parts, groups)` is a pure helper beside `withStarts`; `unheld` also takes the conversation ids of `extra` (the `pollStarts` starts). No call in `changes` passes `groupIds` to `readLight`.

- [ ] **Step 1: Write the failing tests.** In `superTabCache.test.ts`, extend `partReads` to also return reads by collection (`byCollection: Record<string, number>`), then:

```ts
it('three readers polling one Swarm at one stamp load its light base once, and once more after a write', async () => {
  // privateScene(); one pod; firstLoad for owner and peer (cursors); also an agent reader via asAgentId.
  // m = await partReads(() => Promise.all([owner, peer, agent].map(r => reads.changes(...))))
  // expect(m.byCollection.SwarmHead).toBe(1); expect(m.byCollection.SwarmProgress ?? 0).toBe(0)
  // send(...) then the same three polls: SwarmHead === 1 again
})
it('a second reader tagged in the same dormant conversation reads no part at the same stamp', async () => {
  // owner and peer each hold a waiting tag in dormant D; owner polls, then peer polls: peer's partReads.reads === 0
})
```

In `superTabRead.test.ts` (Task 2's describe):

```ts
it('gives every reader the derived values a full read gives', async () => {
  // Scene with owner, peer (outside the secret project), a Buddy reader, and an agent via asAgentId; waiting tags in an
  // active and a dormant conversation; a tag in a secret-project conversation for peer (Review Focus 2); a moved read mark;
  // a progress change; finished starts in a dormant conversation.
  // For each reader: const { readMarks: _a, avatars: _b, ...derived } = changes.derived, and the same from /parts:
  // expect(derived).toEqual(fullDerived); peer's mentionsWaiting excludes the secret tag.
  // Changed progress part appears in changes.progress exactly as before.
})
```

- [ ] **Step 2: Run** both files with `-t` on the new names — FAIL (SwarmHead reads are 3; second reader reads parts).
- [ ] **Step 3: Implement** the `changes` rewiring above; delete the all-time `superTabMention.findMany(... distinct ...)` at `service.ts:120`.
- [ ] **Step 4: Run** `npx vitest run --config vitest.super-tabs.config.ts integration/superTabRead.test.ts integration/superTabCache.test.ts integration/superTabHotReads.test.ts integration/superTabReadMarks.test.ts integration/superTabBuddies.test.ts` and `npx vitest run src/superTabs src/routes/superTabs.test.ts` — all pass, including #2247's `a change poll of a Swarm with 1000 finished starts reads a few tens of KB`.
- [ ] **Step 5: Checkpoint** `git diff --stat`.

### Task 6: Whole-backend checks and the prod measurement

**Files:** none new.

- [ ] **Step 1: Run** `npm run typecheck` in `backend/` — no errors.
- [ ] **Step 2: Run** `npm run test:super-tabs` and `npm test` in `backend/` — compare failures with a clean `origin/main` worktree; only pre-existing failures allowed, listed in the PR.
- [ ] **Step 3: Record the baseline** before deploy, same weekday hours (07:00–16:00 VN), 30 min of logs: `argocd app logs production-autonomous-code-be --kind Pod --since-seconds 1800 --grpc-web`; from `cpu by kind`, `db by shape`, `route latency`, `cpu profile`: the route's busy ms per pod-minute (2026-10-30 baseline 2.06 s), calls/docs/MB per shape under the route (`SwarmGroup key $in` 52/244/6.97, `SwarmProgress` 33/1/1.85), Prisma and GC shares. Put the table in the PR.
- [ ] **Step 4: After release**, the same 30-minute read. Done when `SwarmGroup key $in` + `SwarmProgress` under the route are under 1 MB a minute per pod; report the route's busy-time before/after beside it.
