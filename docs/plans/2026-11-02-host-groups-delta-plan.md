# Host checks stop reading every live group Implementation Plan

> **For agentic workers:** Written by the writing-plans skill as the project's instructions adapt it (Engineer role, revision 23). The Engineer implements it task by task, test first, in this session; the pull request's Review step is the one independent review. No execution handoff.

**Goal:** `HostReads` builds a Swarm's host signature from a cached, delta-patched list of its conversations' digests, so a check after a change reads only the conversations changed since the last one, and returns the same signature as today.

**Architecture:** The conversations' part of the signature (`inputs()`, read/host.ts:157, a `$group` over every live group: 76 slow ops, 24 s, max 734 ms, planning 189 ms in Ken's 10:50-12:38 UTC profile) becomes a read-cache entry `host:groups` with a patch rule (cache.ts, cachePatch.ts), as the `parts` and `dormant` entries already are. A first load per Swarm and process (then every `DELTA_MAX_AGE_MS`, 10 min) projects `key, hostDigest, dormant` of every live group through the named `live` index (covered, no `$group`, no planning); after that each check applies the `loadDelta` rows. The signature string is built from it exactly as the pipeline built it.

**Tech Stack:** TypeScript, Prisma on MongoDB (`aggregateRaw`), vitest; integration on `mongodb-memory-server`.

**Spec:** [docs/superpowers/specs/2026-11-02-swarm-cache-delta-design.md](../superpowers/specs/2026-11-02-swarm-cache-delta-design.md) (the patch rules and the delta read this reuses); the task's brief (Ken's prod DB profile, item 3).

## Global Constraints

- Same answers as today: `hostInputs` returns the same string, byte for byte, as `inputs()` did for the same stored state, so etags a host holds stay valid across the deploy and old and new pods agree while they roll.
- A conversation with no stored `hostDigest` still makes the signature `null` (a missing digest counts as changed).
- No new index, no schema change, no production write. `GROUP_INDEX.live` already exists and is the covering index.
- Swarm code stays out of `cli/src/core`. Optimizations ship on, with no switch.
- Full Super Tab integration suite before Ready (`npm run test:super-tabs` in `backend/`).

## Review Focus

- A conversation put to sleep or woken (its `dormant` flag is in the signature) changes it exactly then: Task 1, Task 2.
- A conversation that gains its digest after a pass found it missing leaves `null`: Task 1.
- A tombstoned conversation leaves the signature; one added again under the same key returns: Task 1.
- A rename or a post (not in `hostDigest`) leaves the signature unchanged: Task 2.
- A write stamped 20 s before it committed is in the next patch (the cache's overlap): Task 2.
- A delta without digests (a loader that does not carry them) reloads rather than guesses: Task 1.

## Design

- **Growth: what deletes it.** The entry holds one small row (key, 22-char digest, flag) per live conversation of a Swarm a host polls, about 100 bytes: 1,715 groups on prod's busiest Swarm is about 170 KB. It lives in the read cache, which bounds it (`CACHE_MAX_BYTES`, least recently used out; a tombstone removes its row; a Swarm's bump never leaves it past `maxAgeMs`/`DELTA_MAX_AGE_MS`). Nothing new is stored in Mongo.
- **Concurrency: lock level.** None added. Group writes are unchanged (no write to the head or any shared document); a stored digest on the head was rejected because every conversation write would then contend on it. The patch reads under the cache's per-Swarm, per-stamp single flight.
- **Read cost: only what changed.** Cold: one covered read of the Swarm's live conversations (key, digest, flag; no document fetch), once per process and Swarm, then at most every 10 minutes. Warm: `changes` since the entry's last read, less `OVERLAP_MS`, shared with the `parts` entry's delta when both are due (one read per Swarm and stamp). More than `DELTA_MAX_PARTS` (500) changed reloads in full.
- **Scale: 10x and the first warning.** Cold load at 10x (17,000 conversations) is a covered read of ~17,000 keys, about 1.7 MB: the warning is `swarm cache` reload reason `age` and `parts` for `host:groups` (cacheStats) and the profile's `SwarmGroup` `aggregate` count by shape. The signature string is still built per miss in memory (a sort and a concatenation, microseconds at today's size).
- **Compatibility.** The string and its hash input are unchanged, so old and new pods answer the same etag. A pod that predates `loadDelta`'s digests is not mixed in: the rule reloads a delta without them.
- **Migration + rollback.** None: no stored data changes. Rolling back the release restores the `$group` pipeline; nothing to clean up.
- **Audience.** N/A: the signature is built for the machine's owner's host check, as before; no new data reaches any reader.
- **Identity.** N/A: nothing here uses a login.
- **Failure.** A delta that fails or does not apply reloads the entry in full (cache.ts `patched`), with its reason counted; a 1-in-N background check against a full load (`verifyRate`) logs `swarm cache verify mismatch` and drops a drifted entry; the 10-minute full load is the net. Nothing is silently wrong for longer than that.
- **Platforms.** Backend only.

## File Structure

- Create `backend/src/superTabs/read/hostInputs.ts`: `hostInputs()` (moved from `HostReads.inputs`), the `host:groups` loader, `hostGroupsRule`, `hostGroupsSignature`. One responsibility: the host signature.
- Modify `backend/src/superTabs/read/host.ts`: `inputs` calls `hostInputs`; the pipeline goes.
- Modify `backend/src/superTabs/parts/load.ts`: `SwarmDelta.hostDigests`, `CHANGED_FIELDS.hostDigest`.
- Create `backend/src/superTabs/read/hostInputs.test.ts` (unit) and `backend/integration/superTabHostGroups.test.ts`; add the latter to `vitest.super-tabs.config.ts`.

### Task 1: The rule and the signature

**Files:**
- Create: `backend/src/superTabs/read/hostInputs.ts`, `backend/src/superTabs/read/hostInputs.test.ts`
- Modify: `backend/src/superTabs/parts/load.ts` (the delta carries digests)

**Interfaces:**
- Produces: `interface HostGroupRow { digest: string | null; dormant: boolean }`; `type HostGroups = Readonly<Record<string, HostGroupRow>>`; `hostGroupsRule: PatchRule<HostGroups>` (kinds `['group']`; a changed row comes as it is now, so a delta applied twice does nothing, and the cold load carries no version because the `live` index does not, which keeps the read covered); `hostGroupsSignature(groups: HostGroups): { missing: number; all: string }` (rows in key order, `digest + (dormant ? '1' : '0')`, `''` for a missing digest); `SwarmDelta.hostDigests?: ReadonlyMap<string, string | null>` (group key to stored digest).

- [ ] **Step 1: Failing tests** in `hostInputs.test.ts`: (a) `hostGroupsSignature` of three rows given out of key order equals the old pipeline's string for the same rows (`'AAA'+'0'+'BBB'+'1'+...`) and counts `missing` for a null digest; (b) the rule replaces a changed row with its new digest, flips `dormant`, removes a tombstone, adds a new key, and returns the held object itself when the delta holds nothing new; (c) a delta with no `hostDigests` returns `'reload'`; (d) a row that gains its digest leaves `missing` at 0.
- [ ] **Step 2: Run** `cd backend && npx vitest run src/superTabs/read/hostInputs.test.ts`; expect FAIL (module missing). Commit the failing test.
- [ ] **Step 3: Implement** the types, rule and signature in `hostInputs.ts`, and in `parts/load.ts` add `hostDigest: 1` to `CHANGED_FIELDS` and collect `hostDigests` for group rows in `loadDelta` (null for a missing column).
- [ ] **Step 4: Run** the unit test; expect PASS. Commit.

### Task 2: `hostInputs()` through the cache, same answers, bounded read

**Files:**
- Create: `backend/integration/superTabHostGroups.test.ts`
- Modify: `backend/src/superTabs/read/host.ts`, `backend/src/superTabs/read/hostInputs.ts`, `backend/vitest.super-tabs.config.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `hostInputs(tx: Transaction, view: CacheView, tabId: string): Promise<string | null>`, the string `HostReads.inputs` gave.

- [ ] **Step 1: Failing integration test.** On a migrated `richSwarm` with a cache and `readDelta`: (a) *same answers*: after each of ~40 seeded random writes (rename, sleep, wake, agent leaves, assignment status, new group, tombstone, post), `hostInputs` through the cache equals `hostInputs` with `DIRECT`, and equals a reference built in the test from the old pipeline; (b) *exactly when relevant*: a rename and a message post leave it unchanged, a sleep, wake, status change, new group and tombstone each change it; (c) *bounded read*: under `profiledReads`, a check after one conversation changed reads `SwarmGroup` once with `docsExamined` and `returned` at most the changed count, against N on the cold read; no `$group` stage; (d) a group whose `hostDigest` is unset makes it `null`, and a write that sets it brings the string back; (e) the write stamped 20 s earlier is in the next patch.
- [ ] **Step 2: Run** `cd backend && npx vitest run --config vitest.super-tabs.config.ts integration/superTabHostGroups.test.ts`; expect FAIL (`hostInputs` missing). Commit.
- [ ] **Step 3: Implement** `hostInputs` and the `host:groups` loader (`groupsBy(tx, 'live', [{$match:{tabId, deleted:false}},{$project:{_id:0,key:1,hostDigest:1,dormant:1}}])`, read through `view.get(tabId, 'host:groups', 'main', load, hostGroupsRule)`); `HostReads.inputs` passes `cached` and calls it; delete the pipeline.
- [ ] **Step 4: Run** the test; expect PASS. Commit.
- [ ] **Step 5: Run the touched suites** (`superTabGroupPlans`, `superTabRead`, `superTabHotReads`, `superTabCache`, `superTabCacheDelta`) then the full `npm run test:super-tabs`; record red/green in a PR comment.

### Task 3: Measure on production and open the pull request

- [ ] **Step 1:** Count the `SwarmGroup` `$group` ops in the same window length before (v1.3.86) and after (the release that carries this) through the read-only production login only, from its environment file; record numbers in the PR.
- [ ] **Step 2:** Open the pull request (body starts "Requested by ken15@autonomous.ai through Harness."), add the review step for Echo.
