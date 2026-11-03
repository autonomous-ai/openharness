# A command naming the PM never reads its dormant groups: Implementation Plan

> Way of working: this project's instructions. The Engineer implements it test first, failing test committed before its code; Reviewer Rowan.

**Goal:** `agent.input`, `agent.alert` and `agent.rebind` naming a project's coordinator read none of its dormant groups.

**Architecture:** `store.ts moreNamed` names an agent, and `parts/load.ts loadActive` then reads every group it is in through `{tabId, agentIds}`. A coordinator is left out of that list for these three commands: its project chat, which is always loaded, already answers what they ask.

**Tech Stack:** TypeScript, Prisma on MongoDB, vitest integration tests on a loopback replica set.

**Spec:** Task #2147 (Ken's prod DB profile, 10:50-12:38 UTC, backend v1.3.86).

## Why not `dormant: false` on the read

Two reasons, both checked:
- **It keeps the cost.** `{tabId, agentIds}` has no `dormant`, so the filter runs after the fetch. On prod, read-only `explain` for the agent with the most dormant groups: 84 groups returned, 1,752 documents still examined.
- **It breaks callers.** `agent.remove`, `machine.remove` and `member.remove` take the agent out of every group it is in, dormant too (`docs/design/2026-10-26-swarm-state-parts.md`, D8). A worker's `agent.alert` may find its only group asleep: `currentGroup` and, for an agent with no stored project, `agentProjectId` read it.

## What a coordinator's three commands read, checked

- `currentGroup`: its active assignment, else its last open group it does not lead, else its project chat. A dormant group is no longer picked; the row goes to an active group or the project chat, where the coordinator reads.
- `agentProjectId`: its stored project, else its first loaded group, and the project chat is always loaded.
- `isConfidential`, `mayDrive`: a Lead is confidential by the project chat, and marked. `agent.input`'s other Swarms check is its own read.
- `agent.rebind`, `loseTasks`: active work only.

## Design

- **Growth:** the read grew with every task the PM was ever in, and nothing deletes those. These three commands now read no more as tasks accumulate.
- **Concurrency:** N/A: fewer parts loaded, and a commit compares only what was loaded.
- **Read cost:** on prod, the agent with the most dormant groups: 1,668 of them, 9.5 MB whole (Ken's slow log: 676 KB light, up to 1.66 s). Now none for these commands. A removal still reads them, and removing a live PM is refused.
- **Scale (10x):** unchanged for these commands. The metric that warns first: slow `SwarmGroup` reads on `{tabId, agentIds}`, from a removal or the watch check below.
- **Compatibility:** server only; old and new clients see the same answers.
- **Migration + rollback:** none. No index is created or dropped. Rolling back restores the read.
- **Audience, identity:** unchanged: the same checks on the same agent.
- **Failure:** if the project chat is not loaded, `ledProject` is false and the agent is named as before.
- **Platforms:** server only.

**Left open, out of this task's owned code:** `store.ts cachedState` (who may open a share) reads an agent's dormant groups by name through the read cache. It is cached until the Swarm changes; it is not `load.ts:63`.

## Global Constraints

- Removals keep reading dormant groups.
- Prod is read only, through the read-only login from its environment file. No index is created or dropped.
- Full Super Tab integration suite before review.
- PR body starts: `Requested by ken15@autonomous.ai through Harness.`

## Review Focus

- A worker whose only group is asleep raising an alert: the row still goes to that group.
- Removing an agent from the Swarm: it leaves its dormant groups too.
- An agent that lost the coordinator role, with no project chat of its own: it is named as any other.
- A coordinator's alert: its row lands in a group its readers can read, not nowhere.
- A coordinator's terminal stays closed to whoever it was closed to.

---

### Task 1: The coordinator is left out

**Files:**
- Modify: `backend/src/superTabs/store.ts` (`moreNamed`)
- Create: `backend/integration/superTabCommandLoads.test.ts`
- Modify: `backend/vitest.super-tabs.config.ts`

**Interfaces:**
- Consumes: `ledProject(state, agentId)`.
- Produces: nothing new.

- [ ] **Step 1: Commit the failing test:** a Swarm with 1,000 dormant groups of the PM: `agent.alert`, `agent.rebind` and `agent.input` naming it read under 100 `SwarmGroup` rows. Guards: a worker's alert reaches its only dormant group; `agent.remove` of a worker leaves its dormant groups; the PM's alert row lands; its terminal stays closed.
- [ ] **Step 2: Watch it fail** on the three reads.
- [ ] **Step 3: Commit the code** that passes it.
- [ ] **Step 4: Run** the new file, the Super Tab unit tests and the full Super Tab integration suite.
- [ ] **Step 5: Open the pull request and the Review step** (Rowan), with the prod measures. The slow log after the release is Ken's: the read-only login cannot read it.
