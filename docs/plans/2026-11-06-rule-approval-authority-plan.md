# Rule approval authority implementation plan

> Implement natively, task by task, with a committed failing test before each fix; two independent security reviews at the final head.

**Goal:** Let the project's named top decider approve any instruction-rule change, and recognize explicitly linked accounts of a rule's author.

**Architecture:** Add optional `instructionApprovals` to the existing project rules JSON: `{topDeciderId: string|null, people: [{name, accountIds}]}` or null to disable. Use stable person IDs, never fuzzy names, for the additional authority. Load the policy in the instructions-save transaction and keep existing message-author, source, project, membership and revision-time checks. Seed only the exact Harness tab/project with Dee and Ken's two known account IDs; every other project has no extra authority.

**Tech Stack:** TypeScript, Zod, Prisma/MongoDB, Vitest; no new dependencies.

**Spec:** Task #3710, conversation `6efd6cdba079af3928d94421`: Dee's own recent approval may change anyone's rule; Ken's attribution resolves to ken15 and 0xken15; refusals name who can approve. Existing approval protections remain.

## Global Constraints

- Only a person's own message since the last instruction save counts; never an agent, Buddy relay, old message or another project's message.
- Explicit account links use IDs; similar display names cannot add an unrelated account.
- Only the project owner or its currently configured top decider may change this authority section, directly or through the PM quoting their existing validated message. Other rules edits retain existing access.
- An older client omitting the new field preserves the current authority. Explicit null disables it through the same protected edit.
- First PR body line: Requested by dee through Harness.
- No production writes, secrets, sign-outs, dependency installs or CLI core changes. Temp files only in mktemp -d folders.
- Run affected tests locally; full backend/integration suites run in ready PR CI. Record red/green in a PR comment. Two security reviews; minor findings wait.

## Design

- **Growth/concurrency:** At most 50 named people, 10 accounts each, inside the existing 16 KB record and 50-revision retention. Same Swarm write transaction/revision fence; no new collection or index.
- **Read cost/scale:** One existing indexed latest-policy read on instruction saves; approvals retain at most 20 equality reads by message ID. In-memory matching is bounded. Profile the real-store policy read with its existing integration query-plan support. Production read-only environment is absent on this Team machine.
- **Compatibility/migration/rollback:** Optional additive JSON; no schema migration/backfill. Scoped Harness seed applies when absent, including a saved old record; explicit null opts out. Roll back backend to restore prior approval semantics; saved additive JSON remains readable by the old repair path but must be removed before strict worker reads on the old binary.
- **Audience/identity:** Project access is checked before policy reads/changes. Only stable configured account IDs confer authority. Existing project membership checks apply to each linked account's approval; only the account that actually approved is notified.
- **Failure/platforms:** Refuse visibly with eligible approvers; malformed stored authority fails closed. Shared backend behavior on every client/platform. No screen changes.

## Review Focus

- A collaborator must not install themselves as top decider or forge a link to someone else's attribution (Task 1).
- Canonical Harness seeding must not grant Dee authority in a second project/tab with a similar name (Task 1).
- An agent/Buddy, stale approval, removed member or another project's approval must never inherit the configured person's authority (Task 2).
- Explicit alias names/IDs must take precedence over a similar display name; no prefix or partial-name expansion (Task 2).
- An omitted policy field must not disable a saved authority, and old unconfigured projects retain their current approval semantics (Tasks 1/2).

### Task 1: Store and protect scoped approval policy

**Files:** policy.ts, policyStore.ts, commands.ts, store.ts; policy.test.ts, superTabProjectRules.test.ts.
**Interfaces:** `ProjectRules.instructionApprovals?`; `seedRules(tabId, projectId): ProjectRules`; bound section schema, scoped Harness defaults and protected rules.set edits.

- [ ] Commit tests for optional/disabled policy, bounds/ambiguous aliases, exact Harness seed scope, old saved records and indexed read; reject a collaborator/PM quoted collaborator changing authority, permit owner/current decider, preserve omitted field.
- [ ] Observe failures before implementation.
- [ ] Add optional section and scoped seed/read normalization; authorize section changes against the previous policy, not the proposed one. Keep existing rules revision/history semantics.
- [ ] Run affected policy/command/integration tests and typecheck, commit and push.

### Task 2: Apply approval authority and exact linked accounts

**Files:** ruleGuard.ts, commands.ts, store.ts; instructions.test.ts, superTabInstructions.test.ts.
**Interfaces:** `allowedDrops(..., merges, instructionApprovals?)`; `membersNamed(..., instructionApprovals?)` resolves explicit names and linked IDs. The same resolver identifies attribution moves. Store loads the project's current policy for saves.

- [ ] Commit regressions: Dee's recent own message approves dropping/rewording Ken's rule; either Ken account approves; unrelated similar name, no approval, agent/Buddy, old/missing/foreign approval and removed account fail; original unconfigured behavior remains.
- [ ] Observe the authority/alias failures before implementation.
- [ ] Thread validated current policy into the guard; preserve all existing approval filters and notifications; explain who can approve in refusals.
- [ ] Run changed/importer unit tests, affected real-store integration tests and typecheck. Record red/green and query-plan evidence; Ready for CI and two independent security reviews.
