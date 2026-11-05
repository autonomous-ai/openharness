# Super Tab Read Costs Implementation Plan

> **For agentic workers:** Use the Harness Engineer workflow in project instructions: implement each plan task test first, commit the failing test, then commit the code that passes it.

**Goal:** Reduce Super Tab read traffic while preserving mention counts and promptly observing Swarm deletion.

**Architecture:** Project only conversation fields needed for person mention visibility and held-tag eligibility. A changes poll carries its already-read waiting tags into the derived mention count. Each `SwarmReads` instance caches only the Super Tab format and deletion fields for a short bounded window, with failures and expired entries refreshed from MongoDB.

**Tech Stack:** TypeScript, Prisma, MongoDB, Vitest, MongoDB Memory Replica Set.

**Spec:** Task #3261 in Harness Super Tab conversation `8901918033bb2fd0e85480b5`.

## Global Constraints

- Backend only; do not change `cli/src/core`.
- Changed backend reads use indexed MongoDB query shapes and are checked with `explain()` against a test database.
- Waiting-tag counts and digests remain unchanged; each changes poll reads `SuperTabMention` once.
- A cached deleted Swarm becomes unavailable after at most the metadata hold window.
- Before Ready, run affected integration files and the backend unit suite (`npm test`); Super Tab integration coverage runs in PR CI.
- PR evidence includes before/after examined documents and returned bytes per request; start its body with `Requested by 0xKen15 through Harness.`

## Review Focus

- Quiet conversations may contain large task or status payloads; the projected row must retain exactly the fields used by visibility and held-tag checks, tested against counts and digests.
- A tag or group update racing a changes poll must use one coherent tag query and still load each tagged conversation.
- Missing, deleted, and newly migrated Swarms must retain their existing refusal and migration behavior across cache expiration.
- Cache entries must be isolated by environment and tab, bounded, and refreshed after expiry or a failed read.
- The projection must preserve query index use; a test-database explain records the plan and examined-document count.

---

### Task 1: Project quiet conversations during mention checks

**Files:**
- Modify: `backend/src/superTabs/mentions.ts`
- Test: `backend/integration/superTabRead.test.ts`

**Interfaces:**
- Consume: `waitingMentions(tx, tabId, state, actor, now)` and existing group-by-key index helper.
- Produce: an aggregate projection containing the conversation `key` plus `data.kind`, `data.projectId`, `data.audience`, `data.archived`, and `data.assignment.status`, sufficient for `canReadGroup`, `isLeads`, and held-tag listing.

- [ ] **Step 1: Write failing coverage** proving waiting-tag counts remain unchanged when 21 quiet groups contain large unrelated conversation fields, and that the fetched BSON excludes those fields.
- [ ] **Step 2: Run the targeted test** and record its expected failure against full conversation payloads.
- [ ] **Step 3: Project only the fields required by the mention check** in the missing-conversations aggregate.
- [ ] **Step 4: Run the targeted test** and capture before/after `explain("executionStats")`, examined documents, and returned BSON bytes on the same test fixture.
- [ ] **Step 5: Commit** the test and implementation separately, test first.

### Task 2: Reuse waiting tags within a changes poll

**Files:**
- Modify: `backend/src/superTabs/mentions.ts`
- Modify: `backend/src/superTabs/read/service.ts`
- Test: `backend/integration/superTabRead.test.ts`

**Interfaces:**
- Consume: `changes()`' waiting-tag lookup and `waitingMentions()`' count/digest calculation.
- Produce: projected waiting-tag rows (id, conversation id, creation time, resolution time, and hold time) reusable by `waitingMentions`; the existing `waitingTagConversations()` result remains a list of distinct conversation ids.

- [ ] **Step 1: Write failing coverage** profiling a changes poll with a waiting tag and asserting exactly one read of `SuperTabMention` with unchanged derived count and digest.
- [ ] **Step 2: Run the targeted test** and record its expected failure with two tag reads.
- [ ] **Step 3: Pass the one projected tag-row set from `changes()` into `load()` and `waitingMentions()`**, avoiding a second tag query while retaining the separate indexed conversation lookup.
- [ ] **Step 4: Run the targeted test** and report before/after `SuperTabMention` reads and request bytes.
- [ ] **Step 5: Commit** the test and implementation separately, test first.

### Task 3: Hold Swarm format and deletion metadata per pod

**Files:**
- Modify: `backend/src/superTabs/read/service.ts`
- Test: `backend/integration/superTabCache.test.ts`

**Interfaces:**
- Consume: the scoped `SuperTab.findFirst` selection of `format` and `deletedAt` in `SwarmReads.read()`.
- Produce: a per-instance cache keyed by environment and tab id, with a short exported/testable hold duration, bounded size, and cached metadata only.

- [ ] **Step 1: Write failing coverage** proving repeated reads share one metadata lookup, soft deletion is observed at hold expiry, and another environment cannot reuse a cached row.
- [ ] **Step 2: Run the targeted test** and record its expected failure against one metadata lookup per request.
- [ ] **Step 3: Add the bounded per-instance metadata cache**, expiring entries by the injected clock and discarding failed lookups.
- [ ] **Step 4: Run the targeted test** and report before/after row reads and deletion visibility latency.
- [ ] **Step 5: Commit** the test and implementation separately, test first.
