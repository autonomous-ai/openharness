# P0 #4560: a host poll on the PM's machine reads its running work, not every conversation its agents are in — Plan

> Written by the Engineer and implemented by it, task by task, test first. No Execution Handoff.

**Goal:** Ken's 20:20 VN scan: `SwarmGroup.aggregateRaw` on hosts changes is prod's top slow query (39 in 29 minutes, against 9
in 19), each poll grew from 60 to 76 KB, and agent reach p50 is 6.3 s. On the PM's machine every poll that rebuilds its rows read
every conversation the PM is in (nearly all of them) to say whether each agent is still in one not archived.

**Architecture:** `cachedReads.ts hostMembers` names whose conversations a machine's host state reads by membership: only its
Buddies' (for their chat), plus a lost task's conversation by id. Both host-state paths use it (`read/host.ts hostParts` without
cache patching, `deriveLight` with it). `active` (hostRows.ts) comes from the loaded conversations, or, for an agent in none, one
quiet conversation at most (`read/host.ts quietMembers`).

**Tech Stack:** TypeScript backend, MongoDB through Prisma, vitest.

**Spec:** Task #4560 brief and River's 11-07 note with Ken's 20:20 numbers.

## Global Constraints
- The host's rows stay the same: `active`, Buddy chats, a lost task's resume.
- No new index or schema change.

## Review Focus
- No host row loses a conversation it read before; both cache paths build the same state.

## Tasks

### 1. The PM's machine reads a few conversations
Files: `backend/integration/superTabCommandReads.test.ts`, `backend/src/superTabs/read/host.ts`, `read/hostRows.ts`, `cachedReads.ts`
- [ ] Failing test: on a prod-sized Swarm, a host poll on the PM's machine examines at most 10 conversations by membership, with and without cache patching; an agent only in a quiet conversation is active, one only in an archived one is not.
- [ ] Code: `hostMembers`, `quietMembers`; both host-state paths read by membership only for Buddies.
