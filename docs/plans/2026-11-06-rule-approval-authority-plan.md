# Rule approval authority implementation plan

> Implement natively, task by task, with a committed failing test before each fix; two independent security reviews at the final head.

**Goal:** Let the project's named top decider approve any instruction-rule change, and recognize explicitly linked accounts of a rule's author.

**Architecture:** Add optional `instructionApprovals` to the existing project rules JSON: `{topDeciderId: string|null, people: [{name, accountIds}]}` or null to disable. Use stable person IDs, never fuzzy names, for the additional authority. Load the policy in the instructions-save transaction and keep existing message-author, source, project, membership and revision-time checks. Seed only the exact Harness tab/project with Dee and Ken's two known account IDs; every other project has no extra authority.

**Tech Stack:** TypeScript, Zod, Prisma/MongoDB, Vitest; no new dependencies.

**Spec:** Task #3710, conversation `6efd6cdba079af3928d94421`: Dee's own recent approval may change anyone's rule; Ken's attribution resolves to ken15 and 0xken15; refusals name who can approve. Existing approval protections remain.

## Global Constraints

- Only a person's own message since the last instruction save counts; never an agent, Buddy relay, old message or another project's message.
- Explicit account links use IDs; similar display names cannot add an unrelated account.
- Only the project owner or its currently configured top decider may change this authority section, acting directly as a person; the PM may not change authority by quoting a message. Other rules edits retain existing access.
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

- [x] Commit tests for optional/disabled policy, bounds/ambiguous aliases, exact Harness seed scope, old saved records and indexed read; reject a collaborator/PM quoted collaborator changing authority, permit owner/current decider, preserve omitted field.
- [x] Observe failures before implementation (`506ba8250`).
- [x] Add optional section and scoped seed/read normalization; authorize section changes against the previous policy, not the proposed one. Keep existing rules revision/history semantics.
- [x] Run affected policy/command/integration tests and typecheck, commit and push (`eb3316329`).

### Task 2: Apply approval authority and exact linked accounts

**Files:** ruleGuard.ts, commands.ts, store.ts; instructions.test.ts, superTabInstructions.test.ts.
**Interfaces:** `allowedDrops(..., merges, instructionApprovals?)`; `membersNamed(..., instructionApprovals?)` resolves explicit names and linked IDs. The same resolver identifies attribution moves. Store loads the project's current policy for saves.

- [x] Commit regressions: Dee's recent own message approves dropping/rewording Ken's rule; either Ken account approves; unrelated similar name, no approval, agent/Buddy, old/missing/foreign approval and removed account fail; original unconfigured behavior remains.
- [x] Observe the authority/alias failures before implementation (`cef9654a7`: four unit failures and the store approval failure).
- [x] Thread validated current policy into the guard; preserve all existing approval filters and notifications; explain who can approve in refusals (`d7b2a4e67`).
- [x] Run changed/importer unit tests, affected real-store integration tests and typecheck. The save's new policy read uses IXSCAN, one document returned and examined. Red/green evidence is in the PR comment; full suites and two independent security reviews run at Ready.

### Follow-up: Bound aliases must outrank display-name collisions

**Files:** ruleGuard.ts, ruleApprovalAuthority.test.ts, superTabInstructions.test.ts.
**Interfaces:** The configured canonical name or a linked account's unique handle/email expands to configured IDs; another account's display name never joins the group.

- [x] Commit the exact-handle/display-name collision regression and observe it incorrectly accept the stranger (`e9460c1f3`).
- [x] Give linked handles priority over display names, preserve unconfigured resolution, and pass the regression plus affected guard/importer tests (`2487d397b`).
- [x] Profile the actual instructions.save policy read: IXSCAN, one document examined/returned; typecheck clean.

## Validation notes

### Security review repair: Tell the affected authors

**Files:** ruleGuard.ts, commands.ts, ruleApprovalAuthority.test.ts, superTabInstructions.test.ts.
**Interfaces:** allowedDrops returns the verified decider ID when used; its notification map includes affected author accounts still permitted to read the project, excluding the saver. Notices attribute the approval to the decider, never to a person who did not approve.

- [x] Commit and observe failing author-notification/private-audience tests (`e47bd2fd3`: two unit failures and zero real-store notices instead of six).
- [x] Notify the decider and affected eligible author accounts once each; keep ordinary author approval notices unchanged.
- [x] Run affected unit/integration tests and typecheck: 500 guard/instructions/commands tests, all 23 instructions integrations and typecheck pass. The other 157 unit tests and seven policy integrations cover unchanged source.
- [ ] Obtain both security reviews again at the new head.

- Task 1: policy tests 25/25; project-rules real-store tests 7/7; typecheck clean.
- Task 2: authority/instructions/commands/policy tests 523/523 before the extra collision regression; real-store instructions/project-rules tests 30/30 after restoring Buddy refusal order. The first combined run hit an ephemeral Mongo port collision and exposed that Buddy refusal-order regression; the retry passed after the access check reused authorizeCommandAccess.
- Collision follow-up: authority/instructions/commands tests 499/499 (including all 10 authority cases); the real-store authority/index-plan case passes; typecheck clean. Review-table/steps tests 27/27; merge-train/release importers 105/105.
- No collection/index changes, backfill or production writes. Production read-only environment absent on this Team machine; no production counts or latency measurements claimed.

### Security review repair: Only direct people change approval authority

**Files:** commands.ts, policy.test.ts, superTabProjectRules.test.ts.
**Interfaces:** rules.set retains its existing message-based PM flow for ordinary rules. Changing instructionApprovals requires the actor to be the project owner or current top decider, acting directly.

- [x] Commit and observe failing tests (`59e2a6133`: two unit failures and real-store save not refused) for the PM quoting either the owner or current decider to replace the decider, relink accounts or disable authority; cover real-store refusal and unchanged revision.
- [x] Require a direct person actor for authority changes, preserving direct owner/decider edits and omitted or unchanged authority on ordinary PM saves.
- [ ] Run affected tests, real-store policy integrations and typecheck; record red/green and obtain both security reviews at the final head.

- Repair validation: 471 affected policy/authority/command unit tests, 11 project-rules real-store tests and backend typecheck pass. Two independent final-head confirmations and automatic CI remain pending.
