# Swarm v3 acceptance plan

> Execute task by task in this session; test first, with no product code changes.

**Goal:** Prove a newly joined member can bring a Buddy, propose to the PM, and receive tasks in Auto approve and Review on current main.

**Architecture:** Use the real SuperTabStore and SwarmReads with a fresh loopback Mongo replica and fake identities. Exercise the existing CLI host and offscreen Desktop tests separately; report their boundaries explicitly. Keep fixes with the owning v3 task.

**Tech Stack:** TypeScript, Vitest, Prisma/MongoMemoryReplSet, Flutter tests.

**Spec:** docs/specs/2026-11-07-swarm-v3.md and task #4172.

## Global Constraints

- No real sign-in, login/credential file read, production data or product code change.
- Temporary files only in mktemp folders; stop only owned processes.
- Test a pinned main revision; report moved-main differences and outstanding dependencies.
- Run affected tests locally; full suites remain PR CI's responsibility.
- Report step results before 06:30 Vietnam, release window opens 09:00.

## Review Focus

- Bringing a Buddy must admit its own computer without a separate machine command.
- Buddy proposals must create actual PM deliveries and retain the requesting person on conversion.
- Auto approve starts ordinary work, whereas Review blocks assignment until that person's decision.
- Suggesting an agent does not approve; rejection prevents assignment and remains visible with its reason.
- Ordinary proposals have no decision controls; stale or foreign memberships gain no authority.

### Task 1: Continuous real-store acceptance

**Files:** Create backend/src/superTabs/__tests__/swarmV3.acceptance.ts and v3.vitest.config.ts.

**Interfaces:** SuperTabStore.create/execute/observeMachine/deliveries; SwarmReads.firstLoad/changes. Existing planDatabase creates and removes a loopback store.

- [ ] Write acceptance assertions before any implementation: join, buddy.create with setup, host launch, proposal delivery, PM conversion, Regular worker, Auto approve assignment, Review suggestion/wait/approve, and reject.
- [ ] Run the acceptance. Report a real failure to its owner without changing product code; passing existing behavior needs no artificial failing implementation.
- [ ] Run existing CLI host start/delivery and own-account reporting tests with isolated fixtures.
- [ ] Run current-main Desktop join/Buddy launcher widgets with fake sign-in and memory state; run Tasks tests when #4138 is merged.
- [ ] Record exact main head, commands, per-step receipts and limitations; push test-only PR for independent review and CI.

## Design

Test-only: no stored contract, query, dependency, runtime, migration or platform behavior changes. Fixtures use bounded fake users/tasks in an ephemeral local store. No production reads or performance claim.
