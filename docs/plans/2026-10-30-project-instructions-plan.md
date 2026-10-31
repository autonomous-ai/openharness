# Project instructions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One instruction document per project defines its roles, workflow and routing; agents talk to each other
directly; the server enforces only facts and access.

**Architecture:** Six phases, each shippable on its own, in the spec's Order of work. Phase 1 (agents message each other
directly, no copies to the PM) is planned task by task below. Phases 2-6 are outlined with their scope, files and done
criteria; each gets its own task-level plan, written against main as it is when the phase starts, since every phase
reshapes the code the next one touches.

**Tech Stack:** backend Node/TypeScript (Fastify, Prisma on MongoDB, zod, vitest); CLI Node/TypeScript (vitest); Desktop
and phone Flutter/Dart.

**Spec:** `docs/plans/2026-10-30-project-instructions-design.md`

## Global Constraints

- The server and the CLI validate nothing about workflow, roles or routing; they refuse only facts (machine offline,
  removed or paused; engine signed out or suspended; model not served there) and access (project readability, Swarm
  settings, Team accounts, Buddy guards, the starts-pending cap).
- Every project always has a PM (the coordinator): created with the project, never removable by the document.
- A message that names agents reaches exactly those agents. A message that names no one goes to its default addressee
  (an agent's to the coordinator, the coordinator's to the assigned agent, a person's as today); nothing is dropped.
- Server notices to the coordinator are delivered at once; there is no notice period.
- Recipients and posts stay inside the sender's project; Buddy chats, private chats and the Leads conversation keep their
  current membership rules.
- Repo docs and code comments in English; copy follows `docs/naming-system.md`.
- Backend tests run with `NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`;
  run `npx prisma generate` before `tsc` after schema changes.
- Format only changed Dart files (`dart format <file>`), never `dart format lib`.
- Known baseline failure, not caused here: integration `superTabHotReads` "two polls within 15 s read the team machines
  once".

## Review Focus

- An agent names an agent of **another project** of the same Swarm: refused with `INVALID_RECIPIENT`, nothing joins.
  (Task 1 test.)
- An agent posts into a **Buddy chat or the Leads conversation** it is not in: refused as today (`FORBIDDEN`). (Task 1
  test.)
- An agent names **itself** among recipients with other agents: it is dropped from the list, not delivered to itself;
  an `agentOnly` note to itself keeps its rule. (Task 1 test.)
- Two agents answer each other **forever**: the 20th message in a row between them sends one notice to the coordinator,
  not one per message after that. (Task 3 test.)
- An **old CLI** posts with no recipients from a worker: it still reaches the coordinator exactly as today. (Task 2 test.)

---

## Phase 1: agents message each other directly

Shippable alone; relieves the PM under today's roles. Backend, CLI and skill texts ship together (backend first: an old
CLI keeps working, a new CLI on an old backend gets `INVALID_RECIPIENT` only when naming an agent outside the
conversation, which today's agents never do).

### Task 1: Recipients and posts across the project's conversations

**Files:**
- Modify: `backend/src/superTabs/commands.ts` (`postable` ~514, `message.send` ~1995-2050)
- Test: `backend/src/superTabs/commands.test.ts` (next to "delivers an assigned worker's own post to its Lead")

**Interfaces:**
- Produces: `joinsProject(state: SuperTabState, group: Conversation, agentId: string): boolean` in `commands.ts`: true when
  the agent exists, is not a Buddy, `agentProjectId(state, agent) === groupProject(state, group).id`, and the group is
  neither a Buddy chat (`isBuddyChat`), the Leads conversation (`isLeads`) nor private to the coordinator.
- `postable(state, actor, conversationId)` keeps its signature; an agent actor not in the group but `joinsProject` is
  added to `group.agentIds` instead of refused.

- [ ] **Step 1: Write the failing tests**

```ts
it('lets an agent post in another task of its project and name agents outside it, who join', () => {
  const f = fixture()
  const lead = f.add('lead', 'owner', 'lead', true)
  const build = f.group(), review = f.group()
  const engineer = f.add('engineer', 'owner', build), reviewer = f.add('reviewer', 'owner', review)
  const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
  const sent = f.run({ type: 'message.send', conversationId: build, text: 'PR #12 is ready.', replyTo: null, recipientIds: [reviewer] }, as(engineer)).messages[0]!
  expect(sent.recipients).toEqual([reviewer])
  expect(f.state.conversations.find(c => c.id === build)!.agentIds).toContain(reviewer)
  // The reviewer answers in its own review task, naming the engineer, who joins it.
  const answer = f.run({ type: 'message.send', conversationId: review, text: 'Two findings.', replyTo: null, recipientIds: [engineer] }, as(reviewer)).messages[0]!
  expect(answer.recipients).toEqual([engineer])
  expect(f.state.conversations.find(c => c.id === review)!.agentIds).toContain(engineer)
  expect([sent, answer].some(m => m.recipients.includes(lead))).toBe(false)
})
it('keeps recipients and posts inside the project and out of Buddy chats and the Leads conversation', () => {
  // Two projects in one fixture: an agent of project B named from project A is INVALID_RECIPIENT and does not join;
  // posting into the Leads conversation or a Buddy chat the agent is not in stays FORBIDDEN.
})
it('never delivers an agent its own message', () => {
  // recipientIds: [self, other] delivers to [other]; agentOnly: true with [self] still delivers to [self].
})
```

The second and third tests follow the first's shape. A second project comes from
`f.run({ type: 'project.create', name: 'Other', visibility: 'public', brief: '' })` (as at `commands.test.ts` ~1270), its
agent from `f.add(..., result.conversationId)`; a Buddy is an agent given `buddyOf` (as at ~1253-1254); the Leads
conversation is the fixture's `'Leads'` group.

- [ ] **Step 2: Run them to see them fail**

Run: `cd backend && NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= npx vitest run src/superTabs/commands.test.ts -t "outside it|inside the project|its own message"`
Expected: FAIL with `FORBIDDEN` (posting into the review task) and `INVALID_RECIPIENT`.

- [ ] **Step 3: Implement `joinsProject` and use it in `postable` and in the `message.send` recipient loop**

In the recipient loop, replace the `INVALID_RECIPIENT` refusal for non-members with: `joinsProject` → push the id onto
`group.agentIds` (once); otherwise refuse as today. Drop the actor's own id from `recipients` unless `agentOnly`. Keep
`readConversation` access as the first check for the actor.

- [ ] **Step 4: Run the tests to see them pass, then the file**

Run: same command without `-t`. Expected: PASS, including the existing message tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/superTabs/commands.ts backend/src/superTabs/commands.test.ts
git commit -m "Swarm: an agent may post in any task of its project and name any agent of it, who joins"
```

### Task 2: No copies to the coordinator for named messages and terminal turns

**Files:**
- Modify: `backend/src/superTabs/commands.ts` (`memberToLead` in `message.send`)
- Modify: `backend/src/superTabs/native.ts` (`append`, the `recipients` line ~226)
- Test: `backend/src/superTabs/commands.test.ts`; `backend/integration/superTabLiveness.test.ts` (the test near line 1456,
  "A turn typed into a terminal reaches the Lead…")
- Modify: `docs/swarms.md` (a short "Messages between agents" section: who a message reaches)

**Interfaces:**
- Consumes: Task 1's recipient rules.
- Produces: `memberToLead` is non-empty only when `command.recipientIds` is empty; a native turn's message has
  `recipients: []` unless it is a gap whose recovery is required (`recovery?.source.required`).

- [ ] **Step 1: Write the failing tests**

```ts
it('copies nothing to the Lead when an agent names its recipients, and still delivers an unnamed post to it', () => {
  const f = fixture()
  const lead = f.add('lead', 'owner', 'lead', true)
  const group = f.group(), worker = f.add('worker', 'owner', group), other = f.add('other', 'owner', group)
  const post = (agentId: string, recipientIds: string[] = []) => f.run({ type: 'message.send', conversationId: group,
    text: 'Note.', replyTo: null, recipientIds }, { kind: 'agent', agentId, machineOwnerId: 'host-owner' }).messages[0]!.recipients
  expect(post(other, [worker])).toEqual([worker])   // was [worker, lead]
  expect(post(other)).toEqual([lead])               // unnamed: the coordinator, as today
})
```

In `superTabLiveness.test.ts`, change the native-turn expectation: a recorded prompt or answer has `recipientIds: []`;
a gap that needs recovery still reaches the Lead.

- [ ] **Step 2: Run to see them fail**

Run: `cd backend && NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=… npx vitest run src/superTabs/commands.test.ts -t "copies nothing"`
Expected: FAIL, recipients `[worker, lead]`.

- [ ] **Step 3: Implement**

`memberToLead`: add `&& !command.recipientIds.length` to its condition. `native.ts`: `recipients = recovery?.source.required && group.leadId && group.leadId !== target.id ? [group.leadId] : []`. Update the comments above both to say why (spec: Agents message each other).

- [ ] **Step 4: Run the unit file and the liveness and superTabs integration files**

Run: `cd backend && NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=… npx vitest run src/superTabs/commands.test.ts && npx vitest run --config vitest.super-tabs.config.ts integration/superTabLiveness.test.ts integration/superTabs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/superTabs/commands.ts backend/src/superTabs/native.ts backend/src/superTabs/commands.test.ts backend/integration/superTabLiveness.test.ts docs/swarms.md
git commit -m "Swarm: a message that names its agents is not copied to the PM, nor is every terminal turn"
```

### Task 3: Loop notice between two agents

**Files:**
- Modify: `backend/src/superTabs/commands.ts` (new `LOOP_NOTICE_AT`, `pairLoop`, use in `message.send`)
- Modify: `backend/src/superTabs/store.ts` (~1224: the `recent` read takes `LOOP_NOTICE_AT` rows and `createdAt`)
- Test: `backend/src/superTabs/commands.test.ts`

**Interfaces:**
- Consumes: `CommandContext['recent']`, which gains `createdAt?: number`; `toLead(state, target, row)` from `terminal.ts`.
- Produces: `export const LOOP_NOTICE_AT = 20`; `pairLoop(recent, a, b, now): number`: how many messages in a row, newest
  first, were between agents `a` and `b` (each authored by one and naming the other), all within the last 30 minutes,
  stopping at a person's message or any other message.

- [ ] **Step 1: Write the failing test**

```ts
it('tells the coordinator once when two agents have exchanged 20 messages in a row', () => {
  // Build recent = 19 alternating messages between engineer and reviewer within 30 minutes; the 20th send returns one
  // extra message: author the Swarm, recipients [lead], text containing both agents' names and "20 messages".
  // Sending a 21st (recent now 20) returns no extra notice. A person's message in between resets the count.
})
```

- [ ] **Step 2: Run to see it fail**

Run: `… npx vitest run src/superTabs/commands.test.ts -t "20 messages in a row"`
Expected: FAIL, no notice.

- [ ] **Step 3: Implement**

After recipients are settled, for an agent sender naming exactly one other agent, when `pairLoop(...) + 1 === LOOP_NOTICE_AT`
push the notice rows from `toLead(state, senderAgent, { id: stableId(operationId, 'loop'), conversationId: group.id,
author: sender, text, replyTo: null, recipients: [], source: SYSTEM_ROW })`. Text, facts only: "<A> and <B> have
exchanged 20 messages in a row in the last 30 minutes." Delivery is never held. `store.ts` reads
`take: Math.max(PAIR_CHAIN_LIMIT, LOOP_NOTICE_AT)` and selects `createdAt`.

- [ ] **Step 4: Run the file**

Expected: PASS, including the existing `PAIR_CHAIN_LIMIT` tests (they read only the first `PAIR_CHAIN_LIMIT` rows).

- [ ] **Step 5: Commit**

```bash
git add backend/src/superTabs/commands.ts backend/src/superTabs/store.ts backend/src/superTabs/commands.test.ts
git commit -m "Swarm: the PM hears once when two agents keep answering each other"
```

### Task 4: `harness super-tab post --to AGENT`

**Files:**
- Modify: `cli/src/superTabs/command.ts` (`USAGE`, the `post` branch ~105-117)
- Modify: `cli/src/superTabs/service.ts` (`HELP` line for `post`)
- Test: `cli/src/superTabs/command.spec.ts` (beside "passes each --mention as written")

**Interfaces:**
- Produces: `post GROUP TEXT OPERATION_ID [--to AGENT]... [--reply-to …] [--attach …]... [--mention …]...`; each `--to`
  value is an agent id, at most 16, mapped to `recipientIds` in order without duplicates.

- [ ] **Step 1: Write the failing test**

```ts
it('passes each --to as a recipient, at most 16, and keeps a post without one unnamed', () => {
  expect(parseSuperTabArgs([...prefix, 'post', 'g1', 'Ready', 'op-1', '--to', 'a1', '--to', 'a2', '--to', 'a1'], where).payload.command)
    .toMatchObject({ type: 'message.send', conversationId: 'g1', recipientIds: ['a1', 'a2'] })
  expect(parseSuperTabArgs([...prefix, 'post', 'g1', 'Ready', 'op-1'], where).payload.command).toMatchObject({ recipientIds: [] })
  expect(() => parseSuperTabArgs([...prefix, 'post', 'g1', 'Ready', 'op-1', '--to'], where)).toThrow('harness super-tab')
  const many = Array.from({ length: 17 }, (_, i) => ['--to', `a${i}`]).flat()
  expect(() => parseSuperTabArgs([...prefix, 'post', 'g1', 'Ready', 'op-1', ...many], where)).toThrow('harness super-tab')
})
```

- [ ] **Step 2: Run to see it fail**

Run: `cd cli && npx vitest run src/superTabs/command.spec.ts -t "each --to"`
Expected: FAIL (usage error on `--to`).

- [ ] **Step 3: Implement** the flag in the `post` loop with the existing `identifier()` check; update `USAGE` and the
`post` help line: "--to names the agents it reaches (any agent of this project); with none, it reaches the PM."

- [ ] **Step 4: Run the CLI super-tab specs**

Run: `cd cli && npx vitest run src/superTabs/command.spec.ts src/superTabs/service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/superTabs/command.ts cli/src/superTabs/service.ts cli/src/superTabs/command.spec.ts
git commit -m "CLI: harness super-tab post --to names the agents a message reaches"
```

### Task 5: Today's skills name their recipients

**Files:**
- Modify: `cli/src/lib/swarmSkills.ts` (orchestration and Default texts of dev, review and lead)
- Modify: `desktop/lib/super_tabs/roles_editor.dart` (its byte-for-byte copies of the Default texts)
- Test: `cli/src/lib/swarmSkills.spec.ts`; `desktop/test/super_tab_project_skills_test.dart` (the copy test)

**Interfaces:**
- Consumes: Task 4's `--to`.

- [ ] **Step 1: Write the failing test** in `swarmSkills.spec.ts`: for both modes, the dev text contains
`post <group> … --to <Reviewer>` guidance for answering review findings, the review text says to send findings to the
Builder with `--to`, and every role text contains "A post that names no one reaches the PM".

- [ ] **Step 2: Run to see it fail**

Run: `cd cli && npx vitest run src/lib/swarmSkills.spec.ts`

- [ ] **Step 3: Edit the texts.** Only messaging lines change in this phase:
  - dev: answer a Reviewer's findings and tell it a fix is pushed with `--to <its agent id>`; tell the PM by name only
    for blocked, needs a person, or done.
  - review: post findings in the Builder's group with `--to <Builder's agent id>`; the verdict stays a check.
  - lead: name the agent you speak to with `--to`; your unnamed post in a task still reaches its assigned agent.
  - all roles: "A post that names no one reaches the PM."
  Copy the Default texts' changes into `roles_editor.dart` byte for byte.

- [ ] **Step 4: Run both tests**

Run: `cd cli && npx vitest run src/lib/swarmSkills.spec.ts` and
`cd desktop && flutter test test/super_tab_project_skills_test.dart`
Expected: PASS. Then `dart format desktop/lib/super_tabs/roles_editor.dart` only if it changed shape.

- [ ] **Step 5: Commit**

```bash
git add cli/src/lib/swarmSkills.ts cli/src/lib/swarmSkills.spec.ts desktop/lib/super_tabs/roles_editor.dart desktop/test/super_tab_project_skills_test.dart
git commit -m "Swarm skills: Builders and Reviewers talk to each other by name; unnamed posts reach the PM"
```

### Phase 1 validation and release

- Backend: unit `src/superTabs`, integration `vitest.super-tabs.config.ts` (baseline failure above), `tsc`.
- CLI: `npx vitest run src/superTabs src/lib/swarmSkills.spec.ts` and `npm run test:core`.
- Desktop: `super_tab_project_skills_test.dart`.
- Measure after release with the same 24-hour count used in the spec (messages delivered to the PM, by kind); expect the
  198 agent copies a day to fall as skills name recipients.
- Release order: backend, then CLI, then Desktop (only the copied texts changed).

---

## Phase 2: the document, PM notes and role names (backend)

Backend only, additive: nothing here changes enforcement, skills or clients, so it ships alone and old clients ignore the
new fields. Spec sections: The instruction document (Shape and storage, Who changes it, The built-in template), PM notes,
Roles (role names, coordinator, `coordinatorName`), Migration, Design.

**Shared names (phases 3 and 5 build on them):**
- Project fields in the state (head part): `instructionsRevision?: number` (absent = 0, no document yet),
  `instructionsHash?: string` (16 hex of sha256), `notesRevision?: number`, `coordinatorName?: string`. Reads give
  `coordinatorName` its default, "Product Manager".
- Agent field: `roleName?: string` (1-40). Reads give every agent an effective `roleName` in `derived.agents[id]` and in
  host rows: stored, else "Buddy", "PM" (the coordinator), its custom role's name, "Reviewer" or "Engineer".
- Commands: `instructions.save`, `note.add`, `note.remove`, `project.coordinatorName`; optional `roleName` on `agent.add`
  and on `agent.start`'s request.
- Reads: `GET /api/super-tabs/:tabId/projects/:projectId/instructions`, `…/instructions/revisions`,
  `…/instructions/revisions/:revision` (all take `asAgentId`).
- Template: `backend/src/superTabs/instructionsTemplate.ts` `INSTRUCTIONS_TEMPLATE` (and its `TEMPLATE_ROLES`,
  `TEMPLATE_WORKFLOW`, `TEMPLATE_ROUTING` sections, which the migration reuses).

### Task 1: The built-in template and the instruction helpers

**Files:**
- Create: `backend/src/superTabs/instructionsTemplate.ts` (the template text, sections as constants)
- Create: `backend/src/superTabs/instructions.ts` (`MAX_INSTRUCTIONS_BYTES = 65_536`, `instructionsHash(text)`,
  `DEFAULT_COORDINATOR_NAME`, `coordinatorNameOf(project)`, `roleNameOf(state, agent)`, `MAX_NOTES = 100`,
  `MAX_REVISIONS = 50`, zod pieces for the commands)
- Test: `backend/src/superTabs/instructions.test.ts`

Tests: `describes the spec's template` (contains the headings Roles, Workflow, Routing and PM, Engineer, Reviewer, Tester;
says review and test run in parallel, the Tester does not read the code, no Sonnet or Haiku Engineers, grid first for
low-risk docs/tests/fixtures; under 16 KB); `names roles by default` (coordinator → PM, reviewer → Reviewer, builder →
Engineer, Buddy → Buddy, custom role → its name, stored name wins).

### Task 2: Storage and `instructions.save`

**Files:**
- Modify: `backend/prisma/schema.prisma` (`SuperTabInstructions` {id = stableId(tabId, projectId), tabId, projectId,
  revision, hash, text, updatedAt}; `SuperTabInstructionsRevision` {id, tabId, projectId, revision, hash, text,
  writtenByKind, writtenBy, askedBy?, summary, at; @@index([tabId, projectId, revision])})
- Modify: `backend/src/superTabs/model.ts` (`SuperTabError.details`, `fail(…, details)`, `CommandEffects.instructions`)
- Modify: `backend/src/middlewares/errorHandler.ts` (sends `details` with the code)
- Modify: `backend/src/superTabs/commands.ts` (schema, WORDS, `instructions.save`, `project.create` seeds revision 1)
- Modify: `backend/src/superTabs/store.ts` (context.instructions read; writes the document, the revision, trims to 50;
  `create` seeds the first project; project.delete removes the rows)
- Modify: `backend/src/superTabs/projects.ts` (project fields), `model.ts` NOTICE_READERS (`instructions: 'people'`)
- Test: `backend/src/superTabs/instructions.test.ts`, `backend/integration/superTabInstructions.test.ts` (new, added to
  `vitest.super-tabs.config.ts`)

`instructions.save` { projectId, baseRevision, text (1 B-64 KB), summary (1-200, one line), askedBy? }: a person who may
write and read the project, or the project's coordinator (askedBy required: a member who reads the project). Stale base →
`INSTRUCTIONS_STALE` 409 with `details: { revision, text }`. One chat line in the project chat, source
`{ kind: 'instructions', projectId, revision }`: "dee changed the instructions: Reviews run on Opus." / "Product Manager
changed the instructions for dee: …". Result `{ projectId, revision, hash }`.

Unit tests: saves and announces; refuses a stale base with the current text; the coordinator needs askedBy, other agents
and Buddies are refused, a viewer is READ_ONLY; text over 64 KB is refused; a new project starts at revision 1 with the
template's hash. Integration: two members save on the same base, the second gets INSTRUCTIONS_STALE with the first's text;
51 saves keep revisions 2-51; a new Swarm's and a new project's revision 1 text equals the template; project.delete
removes its rows.

### Task 3: PM notes

**Files:** `schema.prisma` (`SuperTabPmNote` {id, tabId, projectId, text, askedBy, at, expiresAt?; @@index([tabId,
projectId])}), `commands.ts`, `store.ts` (context.notes; writes; lazy delete of expired ones), `model.ts`
(NOTICE_READERS `note-removed: 'recipients'`), tests as Task 2.

`note.add` { projectId, text (1-300), askedBy, expiresAt? }: the coordinator only, no chat line, at most 100 live notes,
expired ones deleted on the write. `note.remove` { projectId, noteId }: a person who may write and read the project, or the
coordinator; a person's removal tells the coordinator (recipients [coordinator], `note-removed`). Both bump
`notesRevision`. Unit: coordinator only; 101st refused; an expired note is not counted and is deleted; a person's removal
tells the coordinator, the coordinator's does not; unknown note NOT_FOUND. Integration: expired note not read and gone after
the next write.

### Task 4: Role names and `coordinatorName`

**Files:** `commands.ts` (`roleName` on `agent.add` and `startRequestSchema`, copied at `agent.started`;
`project.coordinatorName` { projectId, name 1-40 }: the coordinator or the project owner), `model.ts` (Agent.roleName,
AgentStartRequest.roleName), `read/views.ts` (derived roleName, head project coordinatorName default), `read/contract.ts`,
`read/hostRows.ts` (`roleName`, `instructions: { projectId, revision, hash, coordinatorName }`). Unit and integration
tests.

### Task 5: Reads

`store.ts` `instructions(user, tabId, projectId, asAgentId)` → `{ projectId, revision, hash, text, template, coordinatorName,
notes }` (revision 0: the template's text, `template: true`; a Buddy of the project gets no notes), `instructionRevisions`
(newest first, no text), `instructionRevision` (one with text); a Buddy gets NOT_FOUND for both. Routes in
`routes/superTabs.ts`. Integration: who reads (member, project agent, Buddy text only, outsider and private project 404).

### Task 6: Migration job

**Files:** `backend/src/superTabs/migration/instructions.ts` (`migrateInstructions(db, { apply })`, `documentFor(…)`),
`backend/scripts/swarm-instructions/migrate.ts` (DATABASE_URL, dry run by default, `--apply`), tests: unit
`migration/instructions.test.ts` (documentFor: template copy plus routing lines; custom roles one section each plus the
template's Workflow and Routing; rules in the owner's words; policy notes, floors, reserve, rows, localModels and
priorOverrides as sentences; nothing cut over 64 KB), integration `superTabInstructions.test.ts` (dry run writes nothing
and lists the documents; apply twice gives the same rows and the second reports nothing to do; a project saved since is
skipped). Open tasks' machine and device requirements are not written.

### Task 7: docs/swarms.md "Instructions" section with the Design checklist

### Phase 2 validation

`npx vitest run src/superTabs src/middlewares src/routes`, `npx prisma generate && npx tsc --noEmit -p .`, integration
`vitest.super-tabs.config.ts` compared with the baseline list (no new failures).
Done when: two members save on the same base, the second is refused with the current text; a note expires; the job run
twice yields the same documents.

## Phase 3: two skills per agent (CLI)

Spec sections: How agents read it, The built-in template, Compatibility, the CLI inventory items for `swarmSkills.ts`,
`host.ts` `prompt()` and `start.ts` prompts. The template text itself lives in the backend (phase 2,
`instructionsTemplate.ts`) and reaches the CLI through the instructions read, so the CLI keeps no copy of it.

**Decisions this phase makes (ledger them):**
- The saved and wire role values stay `lead | dev | review | buddy` and the modes `default | orchestration`. A start's
  `agent_create` goes to another machine's CLI, whose `launches.ts` refuses an unknown value (`INVALID_SWARM_ROLE`), and
  saved registry rows relaunch. The kind now only picks the fallback text for an old backend; phase 4 drops kinds.
- Today's role texts (`swarmSkills.ts`, and Desktop's byte-for-byte copies) do not change: they are what a new CLI runs
  on an old backend, and what an agent started before this release holds until the host moves it.
- The launch writes the Harness tools skill (built in, no backend read) beside today's role file; the host writes
  `swarm-instructions` from the backend, since the core reads nothing from the backend at launch. The launch line sends
  the agent to the `instructions` command, which prints the same text.
- An old backend is a host row without an `instructions` key: everything runs as today. A row with `instructions: null`
  (an agent in no project) keeps its role file too.

**Shared names:**
- `cli/src/lib/swarmTools.ts`: `SWARM_TOOLS_SKILL` (front matter `name: swarm-tools`).
- `cli/src/lib/swarmInstructionsSkill.ts`: `instructionsSkillText(doc: ProjectDoc): string`,
  `refreshProjectSkills(workspace: string, saved: SwarmSkill, doc: ProjectDoc): ProjectSkillsRefresh | null`,
  `recordProjectSkillsNotice(workspace, saved, sent: Pick<ProjectSkillsRefresh, 'version' | 'change'>): void`, where
  `ProjectDoc = { revision: number; text: string; summary: string | null; roleName: string; coordinatorName: string; coordinator: boolean }`
  (`saved.role` tells a Buddy apart)
  and `ProjectSkillsRefresh = { tools: string; instructions: string; version: string; owed: boolean; change: number; notice: string }`
  (`tools`/`instructions`: the two files' paths).
- `swarmSkills.ts` exports `skillFile(workspace, saved, name: 'swarm-tools' | 'swarm-instructions', create: boolean): string | null`
  (today's `skillDirectory` with the skill's name in place of `swarm-${role}`) and `replaceSkillFile`.
- Service action `instructions` `{ tabId, agentId, projectId? }` → `{ ok: true, value: { projectId, revision, text,
  template, coordinatorName, notes } }`; CLI `harness super-tab --tab TAB instructions [PROJECT]` prints it as text.

**Review focus (phase 3):**
- An old backend (rows without `instructions`, no instructions route): skills, refresh and notices exactly as today;
  `instructions` answers `INSTRUCTIONS_UNAVAILABLE`. (Tasks 4 and 5 tests.)
- A start from this CLI to a machine on an older CLI: the `agent_create` payload carries no new key or value. (Task 6:
  assert the payload's keys are unchanged.)
- A Buddy: no new command in its guard (`lib/buddyGuard.ts` `SUPER_TAB` unchanged); it reads its instructions file inside
  its folder's `.harness`, which its folder lock leaves alone. (Task 3/4 tests.)
- Several saves between two roster passes: one notice per pass for the newest revision, never one per revision.
  (Task 4: revisions 2 and 3 seen in one pass → one notice.)
- A 64 KB document: written whole to the skill file and printed whole by `instructions` and `route`. (Task 3 test with a
  64 KB text.)

### Task 1: The Harness tools skill

**Files:** Create `cli/src/lib/swarmTools.ts`, test `cli/src/lib/swarmTools.spec.ts`.

The mechanics from today's role texts, with no workflow: the `harness super-tab` commands (status, messages, message,
post with `--to`/`--reply-to`/`--attach`/`--mention`, react, command with the JSON of `conversation.create`, `work.define`,
`work.assign`, `work.status`, `work.check`, `agent.start` via `start`/`resume`, `route`, `instructions`, decisions, costs,
screen, type, help; and the JSON of `instructions.save` (base revision, summary, `askedBy` for the member who asked; a
stale base hands back the current text to merge), `note.add`, `note.remove`), what `--to` reaches (named agents only; no `--to` reaches the project's coordinator), reactions
mechanics, requests and Done mechanics, cards, threads, shared machines and secrets. Copy wording from today's texts where
it is mechanics; leave out every "only the Lead", "never start a reviewer for your own work", "never merge", automatic
review and fixed role names.

- [ ] **Step 1: Failing test** `describes the commands and no workflow`: `SWARM_TOOLS_SKILL` starts with
  `---\nname: swarm-tools\n`; contains `post GROUP`, `--to AGENT`, `instructions`, `work.status`, `route GROUP`,
  `## Reactions`; `not.toMatch(/\b(Product Manager|Builder|Reviewer|Engineer|Tester|Lead)\b/)`;
  `not.toMatch(/never merge|your own work|only you/i)`; byte length under 24 KB.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/swarmTools.spec.ts` → FAIL (module missing).
- [ ] **Step 3: Write** the text.
- [ ] **Step 4: Run** again → PASS.
- [ ] **Step 5: Commit** `cli/src/lib/swarmTools.ts cli/src/lib/swarmTools.spec.ts` — "Swarm: the Harness tools skill,
  the commands every agent uses, with no workflow (project instructions, phase 3, task 1)".

### Task 2: The launch writes the tools skill and points to the instructions

**Files:** Modify `cli/src/lib/swarmSkills.ts` (`prepareSwarmSkill`, `skillDirectory` → `skillFile`), test
`cli/src/lib/swarmSkills.spec.ts`.

**Interfaces:** Consumes `SWARM_TOOLS_SKILL`. Produces `skillFile`, `replaceSkillFile`, and the tools file's
`version.json` record (today's `SkillRecord` shape, told at launch) that Task 3 reads to tell a new session from an older
one.

- [ ] **Step 1: Failing test** `writes the tools skill beside the role's and sends the agent to its instructions`: for
  lead, dev and review in both modes, `prepareSwarmSkill` writes `swarm-tools/SKILL.md` equal to `SWARM_TOOLS_SKILL` and
  still writes the role file; its `instructions` contain the tools file's path, `instructions` (the command), and the role
  file's path as what to use "if this Swarm has no project instructions". A Buddy gets no tools file and its line is
  unchanged. A relaunch keeps both files' bytes.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/swarmSkills.spec.ts` → FAIL.
- [ ] **Step 3: Implement.** Line for lead/dev/review: `Use the built-in swarm-tools skill for Harness's Swarm commands:
  read ${tools} before working. Your role and how this project works are in its instructions: read them with the
  instructions command (harness super-tab --tab TAB instructions), and work by them. If that command says this Swarm has
  no project instructions, use the swarm-${role} skill instead: read ${file}.`
- [ ] **Step 4: Run** `cd cli && npx vitest run src/lib/swarmSkills.spec.ts src/superTabs src/core/agents` → PASS (update
  launch-line assertions that quote the old line; ledger each).
- [ ] **Step 5: Commit.**

### Task 3: The instructions skill and its refresh

**Files:** Create `cli/src/lib/swarmInstructionsSkill.ts`, test `cli/src/lib/swarmInstructionsSkill.spec.ts`.

`instructionsSkillText(doc)`: front matter `name: swarm-instructions`, description "This project's instructions: its
roles, workflow and routing, and your role in them. Read before any project work."; then `You are this project's
${roleName}${coordinator ? ', its coordinator' : ''}. ${coordinatorName} is the project's coordinator.` (the coordinator
reads `You are this project's ${roleName}, its coordinator: people talk to you when they address no one, and you receive
the server's notices.`), `Instructions revision ${revision}:`, then the text verbatim.

`refreshProjectSkills`: writes `swarm-instructions/SKILL.md` (creating it) and puts `swarm-tools/SKILL.md` on the current
`SWARM_TOOLS_SKILL`, both with `replaceSkillFile`; one record in `swarm-instructions/version.json`
`{ tools, doc, revision, roleName, change, told }` (`tools`/`doc`: sha256 of each file's text; `told`: the same fields as
last confirmed, or null). A rewrite bumps `change`; `owed` is `told?.change !== change`. Null when the workspace is gone.

Notices (one per refresh, naming only what changed since `told`):
- no tools record from the launch (a session started before this release): `Harness now gives you two skills in place of
  your swarm-${role} skill: ${tools}, Harness's Swarm commands, and ${instructions}, this project's instructions and your
  role in them. Before your next step, read both and work by them.`
- otherwise the parts, in order: `The project's instructions changed: ${summary}.` (no summary: `The project's
  instructions changed.`), `You are now this project's ${roleName}.`, `Harness updated your swarm-tools skill.`, then
  `Before your next step, read ${files that changed} again and work by them.`
- the first install for a session whose launch wrote the tools record is recorded as told (it read the instructions
  through the command at launch): no notice.
- a Buddy (`saved.role === 'buddy'`) gets the instructions file only: no tools file, no switch line; its first install
  tells it `Your project's instructions are at ${instructions}: read them as your member's helper; they do not change
  your limits.` once.

- [ ] **Step 1: Failing tests**: `gives a Buddy the instructions file only`; `writes the instructions with the role line` (roleName "Tester", coordinator false →
  file contains `You are this project's Tester.` and the text); `tells nothing on the first install after a new launch`;
  `tells once when the instructions change` (revision 2, summary "Reviews run on Opus" → owed, notice starts `The
  project's instructions changed: Reviews run on Opus.`; after `recordProjectSkillsNotice`, the same doc → not owed);
  `moves a session started before this release` (no tools record → both files written, the switch notice naming
  `swarm-dev`); `tells a role change and a tools update in one notice`; `refuses a symlinked skill folder` (as
  `skillDirectory` does today).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/swarmInstructionsSkill.spec.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.**

### Task 4: The host installs and refreshes them from the roster

**Files:** Modify `cli/src/superTabs/host.ts` (`HostAgent`, `skillSetOf`, `refreshSkill`, `tellSkill`, the pruning at
~833), test `cli/src/superTabs/host.spec.ts` (beside the existing skill refresh tests).

**Interfaces:** Consumes the host row's `instructions` `{ projectId, revision, hash, coordinatorName }` and `roleName`
(phase 2, `read/hostRows.ts`), Task 3's functions, and the reads `GET /api/super-tabs/:tabId/projects/:projectId/instructions?asAgentId=`
and `…/instructions/revisions?asAgentId=` (newest first; a Buddy gets NOT_FOUND).

When the row has `instructions` (an object): every session, a Buddy too, gets `refreshProjectSkills` with the text read
for that revision (cached per tab and project, dropped when no roster row names it; a read whose revision differs from
the row's is retried later, as role texts are today) and the newest revision's summary when it is that revision (null
for a Buddy or on any failure). A Buddy keeps its `swarm-buddy` file and gets no tools file (Task 3 takes `buddy` and
skips the tools part and the switch line). The notice goes through `tellSkill` unchanged; its operation id is
`skill-${agentId}-${version.slice(0, 32)}-${change}`. `skillSetOf` for such a row is
`JSON.stringify(['instructions', projectId, revision, hash, roleName, coordinatorName, lead])`, so a save is acted on at
the next roster, not the next CLI release. Without the key: today's code path, untouched.

- [ ] **Step 1: Failing tests**: `installs a Tester's instructions from the roster and tells it nothing at first`
  (row roleName "Tester", revision 1 → the file holds the read text and `You are this project's Tester.`, no
  `message.send`); `tells it once when a save moves the revision` (revision 2 → one agent-only `message.send` whose text
  starts `The project's instructions changed: <summary>`; a third poll sends nothing); `keeps an old backend's rows on
  the built-in skills` (row without `instructions` → today's `refreshSwarmSkill` path, no instructions read);
  `retries a read that answers another revision`; `gives a Buddy the text without notes or summary`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/superTabs/host.spec.ts -t "instructions"` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd cli && npx vitest run src/superTabs/host.spec.ts` → PASS.
- [ ] **Step 5: Commit.**

### Task 5: `harness super-tab instructions`, and `route` shows them

**Files:** Modify `cli/src/superTabs/command.ts` (parse, `USAGE`, print as text like `screen`), `service.ts` (action,
`HELP.instructions`), `routeCommand.ts` (`routeTask` answer); tests `command.spec.ts`, `serviceReads.spec.ts` (or
`service.spec.ts`, wherever `decisions` is tested), `routeCommand.spec.ts`.

The service resolves the project when none is given: the project the agent leads, else the project of its open groups
(`projectId ?? 'lead'`), else NOT_FOUND. It reads `GET …/projects/:projectId/instructions?asAgentId=` and returns it. A
404 from a backend without the route answers `{ error: 'INSTRUCTIONS_UNAVAILABLE', detail: 'This Swarm has no project
instructions yet: work by the swarm skill Harness gave you at start.' }`. The command prints `Instructions of project
${projectId}, revision ${revision}${template ? ' (the built-in template)' : ''}`, a blank line, the text, then, when there
are notes, `PM's notes:` and one line per note `- ${text} (asked by ${askedBy}, ${at}${expiresAt ? `, until ${expiresAt}` : ''})`;
a failure prints JSON as other commands do. `routeTask` adds `instructions: { revision, text, notes }` to its answer, read
for the group's project; a failed read gives `instructionsUnreadable: true` and the route still answers.

- [ ] **Step 1: Failing tests**: parse `instructions` and `instructions p1` (anything else → usage); the service reads
  the agent's own project and maps a 404 to `INSTRUCTIONS_UNAVAILABLE`; the command prints the header, text and notes; the
  route answer carries `instructions` and survives a failed read.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/superTabs/command.spec.ts src/superTabs/serviceReads.spec.ts src/superTabs/routeCommand.spec.ts` → FAIL.
- [ ] **Step 3: Implement**; the help line: `instructions [PROJECT]: print your project's instructions (its roles,
  workflow and routing) and the PM's notes. Work by them; ask the coordinator, or a person, to change them.`
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.**

### Task 6: Neutral prompts

**Files:** Modify `cli/src/superTabs/start.ts` (`leadPrompt`, the worker and reviewer prompt ~387), `host.ts`
(`prompt()`, `SUPER_TAB_REPLY_STYLE`), `desktop/lib/super_tabs/launch_prompt.dart`; tests `start.spec.ts`,
`host.spec.ts`, `desktop/test/super_tab_startup_recovery_test.dart` and `super_tab_work_details_test.dart`.

What goes: "Discuss first; build when authorized", "Coordinate: assign multi-part or 15+ minute work…", "Route only to
start an agent or assign work…", "Do not review yet…", "Your lead will assign work…", "Each task needs goal, changes,
constraints…", skill names by role, "Leads: route only when…", "Lead: when a Builder finishes, decide reuse, keep or
stop…", and Desktop's equivalents. What stays: run `status` until the harness is in the roster, read the conversation,
how to reply, the reply style (minus its Lead line), the GitHub line, the sandbox line. Each start prompt names the
agent's role when the start request has `roleName` (`You are joining this project's Swarm as its ${roleName}.`), and
says `Read your role in the project's instructions: harness super-tab --tab ${tabId} instructions.` The Buddy prompt is
unchanged. Desktop's prompt stays under 2,000 UTF-16 code units.

- [ ] **Step 1: Failing tests**: the lead and worker prompts contain `instructions` and none of `swarm-lead`,
  `Coordinate:`, `Route only`, `Do not review yet`, `assign work`; a start with `roleName: 'Tester'` names it; `prompt()`
  no longer contains `Leads:` or `decide reuse, keep or stop`; Desktop's prompt for lead and worker contains
  `instructions` and not `swarm-lead`/`swarm-dev`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/superTabs/start.spec.ts src/superTabs/host.spec.ts`; `cd desktop &&
  flutter test test/super_tab_startup_recovery_test.dart test/super_tab_work_details_test.dart` → FAIL.
- [ ] **Step 3: Rewrite** the prompts.
- [ ] **Step 4: Run** the same → PASS; `dart format desktop/lib/super_tabs/launch_prompt.dart` and the two test files
  only; `flutter analyze` on them.
- [ ] **Step 5: Commit.**

### Phase 3 validation

`cd cli && npx vitest run src/superTabs src/lib src/core/agents` and `npx tsc --noEmit -p .`; `npm run test:core` only if
a file under `src/core` or `src/services` changed. Desktop: the two launch prompt tests and
`super_tab_project_skills_test.dart` (unchanged texts, still green).
Done when: Task 4's tests show a session in role "Tester" holding both skills and its role line, a save refreshing its
instructions file and sending exactly one notice, and an old backend's rows running as today.

Release prerequisite (phase 2 review): run the migration in production, with the owner's go, after the backend deploy and
before the release of phases 3-5. A project still at revision 0 reads the template; a first save there (the coordinator
through the tools skill, or Desktop's panel) would build on the template, drop the project's custom roles and rules, and
the migration would then skip it.

## Phase 4: role kinds and routing enforcement removed (backend and CLI)

Spec sections: What the server still enforces; Roles ("Any agent of the project may do…", "What the server did by role
kind becomes generic"); Agents message each other (phase 1's deferred minors); Server notices to the coordinator; Routing;
The nightly routing reflection; Server changes, in brief; the inventory's Backend and CLI lists (every item marked "goes",
"any agent of the project may now do", "Automatic workflow the server stops doing", "Role-shaped bookkeeping that becomes
generic"); Design (Compatibility, Failure). The Desktop, web and phone items are phase 5; docs are phase 6.

Ships in one release with phases 3 and 5, backend first. It relies on phase 3's CLI (the `swarm-tools` skill, the host's
`swarm-instructions` refresh, `instructions`, neutral start prompts) and changes none of it except where named. Tasks 1-10
are backend and run in order (most edit `commands.ts`); 11-13 are CLI (11 reads task 7's read); 14 is the done check.

Phase 4 is done when `removedRefusals.test.ts` and `integration/superTabWorkflow.test.ts` (task 14) pass: no refusal code
in the inventory's list is reachable, and a Tester, an Engineer and a Reviewer run the template's workflow with no
coordinator action between "ready" and "passed".

**Decisions this phase makes (ledger them):**
1. *Role kinds on the wire.* Inside the CLI the role becomes `coordinator | agent | buddy` (`SwarmSkill.role`, the saved
   registry row, `CreateInput.swarmRole`), with `fallback?: 'review'` kept only so a session started as a Reviewer keeps
   its `swarm-review` file and text. `agent_create` keeps sending the old values for this release: `lead`, `dev`, `buddy`,
   and `review` only for a start request that still carries an older client's `role: 'reviewer'`; no new key. A new
   receiver accepts both value sets, so the next release can send the new ones. The role name never rides on the wire:
   the host row (phase 2) is its one source. Cost: an older CLI on the receiving machine installs the built-in dev text
   for every non-coordinator agent a new CLI starts, until it updates; a machine whose CLI is downgraded after this
   release relaunches its newly saved Swarm sessions without their Swarm skill (the old parser refuses `coordinator`).
2. *Old clients' kinds become role names.* The backend still stores the `role` / `roleId` an older client sends, for older
   readers, and no command reads them. `agent.add` and `agent.start` store `roleName ?? legacyRoleName(...)` ("Reviewer"
   for `role: 'reviewer'`, a custom role's name for its `roleId`); `work.assign`'s `roleId` sets the worker's role name
   when it has none. Cost: none for new clients.
3. *Old clients' saves.* `rule.set` appends the rule's words to the document's Routing section as a new revision, like a
   save, with `askedBy` the person whose message `askedIn` names (a person actor: themselves); an agent's `rule.set` with no
   person behind it is `ASKED_BY_REQUIRED`. `rule.remove`, `tab.routingPolicy`, `POST /api/super-tabs/routing-policy`,
   `project.skills` and `project.roles.*` are accepted, store nothing and answer `ignored: true` with a note. The old
   rules, policy rows and role texts stay in place, unread (spec Migration). Cost: an old Desktop's role, skill-set or
   policy edit is lost; its person edits the document instead.
4. *Settings stay the coordinator's under another code.* `controls()` goes; `tab.rename`, `tab.pause`, `tab.project`,
   `project.report` and `lead: true` (on `agent.add` and `conversation.agent`: who coordinates is the project's setting,
   not workflow) are coordinator-or-person and refuse other agents with `COORDINATOR_REQUIRED` (phase 2's code), so
   `LEAD_REQUIRED` is reachable nowhere. Persons keep their current checks. Cost: none.
5. *Links stay inside the project.* `REVIEW_TARGET` goes, but a `reviewOf` naming a conversation outside the actor's
   project, the project chat, a Buddy chat, the Leads conversation or a private chat answers `NOT_FOUND` (never telling
   whether another project's task exists). A link to a linked task is allowed. Cost: none.
6. *Who resumes a start:* the agent that made it, its project's coordinator, or a person (the machine grant still binds a
   dispatch to the machine's owner) — `mayResumeStart`. Cost: a coordinator can finish another agent's stuck start.
7. *Idle agents.* Every agent but the coordinator and Buddies that belongs to no task with active work for 15 minutes is
   reported once per idle spell (`Agent.idleNoticedAt`), whether tidying is on or off; `tab.tidy` now governs only
   auto-archive. The coordinator's poll no longer reads asleep groups. Cost: agents a person added by hand are reported too.
8. *Failed first review:* a notice to the coordinator only for an attempt on a model of the Swarm's grid, the attempts the
   step-up covered. Cost: the coordinator is not woken for subscription attempts' failed first reviews; their findings
   still reach the Engineer directly.
9. *Checks.* A verdict is a check recorded by anyone but the task's assignee; `independent` is still accepted and stored for
   older readers and read by nothing; `work.define` takes zero checks. Review credit and "reviewed by" come from the
   `passedBy` of the task's checks and of its linked tasks' checks, minus the assignee. Cost: a Reviewer that records its
   verdict only on its own review task (as its assignee) earns no credit; the template has it pass the reviewed task's check.
10. *Review capacity notice kept, generic.* On a `review` status it says when no machine the project may use can start
    either engine, without the policy, quality or rules. Cost: one notice the spec's "engine logic removed" might have
    dropped entirely.
11. *Role defaults.* `agent.start` fills none; `lead.start` keeps the built-in coordinator default
    (`BUILT_IN_ROLE_DEFAULTS.lead`, Claude Opus xhigh). Cost: a hand start without a model runs the engine's own model.
12. *Route records* carry `instructionsRevision`, stamped by the server at record time (`project.instructionsRevision ?? 0`),
    not sent by the CLI. Cost: a save between the route's read and its record names the newer revision.
13. *Following another candidate* needs no reason; the override is recorded with `reason: 'No reason given.'` (the type
    stays a string). Cost: readers of route decisions see that text.
14. *The catalog is served in the existing tab routing-policy read* (a `catalog` key beside the built-in default policy,
    which is now derived from the catalog), so one read serves catalog, priors and prices and old CLIs read the same rows
    as a policy. No new route. Cost: none.
15. *A named model the catalog does not list* is offered unrated, on Claude Code for names with claude, opus, sonnet, haiku
    or fable, else on Codex. Cost: a third-party model behind Claude Code gets Codex; the agent can still start it by hand.
16. *`lostTask`* stays as information (a note in the route); any assignment, an agent's or a person's, clears it.
17. *`WORK_REQUIRED`* (keep needs a finished task) goes with the kinds; `finishWorker` marks every finished worker
    `awaiting`, shown and read by no command.
18. *A failed start* is not restarted elsewhere by the CLI; the backend's failure notice reaches the coordinator and the
    agent that made the start (when it is in the task) and names the model it asked for.
19. *Grid models too small or slow* are offered by the route with a note, from the machines' existing `refusedModels`
    reports: no report or backend schema change.
20. *Scheduler:* from a Swarm snapshot every task has floor 1, no `independent_of`, reserve 0 and no machines rule; the
    solver keeps those fields for bench instances.
21. *Reflection.* Each proposal carries one fixed Routing line; the template's PM section says to write it when the owner
    says Yes; the reflection reads the project's document and reports a proposal whose line is already there with how the
    last 7 days actually ran, never asking it again. Cost: a reworded line in the document is proposed again.
22. *Phase 1 minors:* the Lead skill line about unnamed posts stays in the built-in fallback text (phase 3's ruling) and the
    template has none: no work. The loop notice already uses coordinator-only rows (90a13c380).
23. *`leadWorkerBounced` stays.* The spec says both "the coordinator's to the task's assigned agent (`leadToWorker`, with
    its bounce limit)" and, under Loop notice, "`leadWorkerBounced` goes". Ruled for the first: it limits only the
    coordinator's *unnamed* posts to its worker, while the loop notice covers named exchanges, and phase 1 kept it. Cost:
    the coordinator's seventh unnamed post in a row to its worker still reaches nobody until it names the worker.

**Shared names:**
- Backend: `coordinatorOrPerson(state, actor, conversationId?)` and `mayResumeStart(state, actor, start)` in
  `commands.ts`; `legacyRoleName(project, given)` and `appendRouting(text, line)` in `instructions.ts`;
  `Agent.idleNoticedAt?: number`, `IDLE_NOTICE_MS = 15 * 60_000`, `idleNotices(...)` in `tidy.ts`; `linkPending(state,
  linked)` in `tidy.ts`; notice kinds `idle` and `review-failed` (`NOTICE_READERS`: `'recipients'`);
  `RouteRecord.instructionsRevision?: number`; `catalog.ts` `MODEL_CATALOG`, `CatalogModel`, `CatalogRead`, `catalogRead()`;
  `routingLine(p)` in `costs/reflection.ts`.
- CLI: `lib/savedSkill.ts` `SwarmRole = 'coordinator' | 'agent' | 'buddy'`, `WireRole = 'lead' | 'dev' | 'review' | 'buddy'`,
  `roleFromWire(value)`, `wireRole(skill)`, `fallbackSkillName(skill)`, `SwarmSkill.fallback?: 'review'`;
  `superTabs/route.ts` `Catalog`, `catalogFrom(value)`, `strengthOf(...)`, `gridStrength(...)`, `Probe.notes: string[]`,
  `Probe.unrated?: true`.

**Review focus (phase 4):**
- An agent of another project, or a Buddy, uses a newly opened action (assign, start, check, tell, type in a terminal):
  refused, nothing written. (Task 1 tests.)
- A non-coordinator agent tries to change who coordinates or a Swarm setting (`lead: true`, `tab.rename`, releasing the
  coordinator): `COORDINATOR_REQUIRED` / `LEAD_PROTECTED`. (Task 1 tests.)
- A start from this CLI reaches a machine on an older CLI: `agent_create` carries only `lead|dev|review|buddy` and today's
  keys. (Task 13 test.)
- An old Desktop or CLI saves a rule, a policy or a role set: the rule lands in Routing (on a project at revision 0, on the
  template's text), the rest is accepted and stores nothing. (Task 6 tests.)
- An idle agent is reported once per idle spell, not on every coordinator poll; one with a delivery waiting or in a task
  with active work is not reported. (Task 8 test.)

**Tests of removed behavior.** A test that asserted a refusal this phase removes becomes an assertion that the command is
accepted, or is deleted when the behavior is gone. Each task names the blocks it rewrites; ledger every deleted file or
`describe` block, and every integration test changed (some are in the baseline failure list).

### Task 1: Any agent of the project does what only the coordinator did

**Files:**
- Modify: `backend/src/superTabs/commands.ts`: `controls` (~477) → `coordinatorOrPerson`, kept only for `tab.rename`,
  `tab.pause`, `tab.project` (~1293, 1425, 1429) and `lead: true`; removed from `conversation.create` (~1467),
  `conversation.rename` (~1523), `requester` (~1528), `merged` (~1536, `MERGE_RECORDER` ~1541-1543), `archive` (~1570),
  `agent.add` (~1586), `agent.start` (~1662), the start commands (~1830-1832, plus the `actorKey` check → `mayResumeStart`),
  `conversation.agent` (~2060), `route.record` (~2252), `route.modelResult` (~2296), `route.override` (~2307),
  `work.define` (~2327), `work.assign` (~2351); `project.report` (~1050) → `COORDINATOR_REQUIRED`; `work.status` (~2410),
  `work.cancel` (~2484-2488, line ~2499 names `who`), `agent.release` (~1972-1976: `LEAD_REQUIRED` line deleted,
  `LEAD_PROTECTED` stays), `person.tell` (~1764-1765); `leadActed` (~705-712) records any agent of the project
- Modify: `decisions.ts` (`checkAsker` ~66-73), `mentions.ts` (`mayTag` ~116-121, `checkMentions` ~129-134: the Leads
  conversation refusal becomes `INVALID_MENTION`), `profile.ts` (`setAgentAvatar` ~66-70), `terminal.ts` (`mayDrive` ~64-67;
  `TERMINAL_PRIVATE` stays), `store.ts` (`start` ~1030-1035, `githubStart` ~1603-1606)
- Test: `commands.test.ts` (new `describe('any agent of the project')` before 'cancelling work' ~1406; rewrite 'Lead
  mentions' ~3372 and "the Lead's last action on a task" ~845), `decisions.test.ts`, `mentions.test.ts`, `terminal.test.ts`,
  `profile.test.ts`, `integration/superTabs.test.ts` (start resume)

**Interfaces:**
- Produces: `coordinatorOrPerson(state: SuperTabState, actor: Actor, conversationId = 'lead'): void` (reads the conversation;
  an agent that is not its project's coordinator fails `COORDINATOR_REQUIRED` 403);
  `export function mayResumeStart(state: SuperTabState, actor: Actor, start: AgentStart): boolean`.
- Access for every opened action stays `authorizeCommandAccess` / `readConversation` (an agent reads only its own project)
  plus the Buddy guard; persons keep their current checks (`work.cancel`: tab owner; `merged`: an owner, now `FORBIDDEN`).

- [ ] **Step 1: Failing tests**
  - `lets any agent of the project run the task commands`: coordinator, Engineer E and agent A in one project; E runs
    `conversation.create` (brief and one check), `work.define`, `route.record` then `work.assign` of A with that decision
    (`decisionIn`, as at ~690), `conversation.rename`, `conversation.requester`, `work.status` on A's task,
    `conversation.merged` (→ `ledger.shippedAt` set), `work.cancel` (→ status `cancelled`, the line starts
    `${E} cancelled this task`), `agent.release` of A with `stop` (→ `workDecision: 'stop'`), `conversation.archive`.
    None throws; `group.leadAction` is `{ kind: 'route' | 'assign', at: 1000 }` after E's route and assignment.
  - `keeps settings and who coordinates to the coordinator and people`: E's `tab.rename`, `tab.pause`, `project.report`,
    `agent.add … lead: true` and `conversation.agent … lead: true` → `COORDINATOR_REQUIRED`; E's `agent.release` of the
    coordinator → `LEAD_PROTECTED`; the coordinator's `tab.rename` passes.
  - `refuses agents of another project and Buddies`: an agent of project B (`project.create` as at ~1270) assigning in A's
    task → `NOT_FOUND`; a Buddy's `conversation.create` throws; neither changes `state.conversations`.
  - `lets any agent tell a person of its project`: E's `person.tell` → one message in that person's Buddy chat; a person's →
    `FORBIDDEN`.
  - `decisions.test` `lets any agent of the project ask a person`: `checkAsker` for E in its project's task → E's id; in
    the Leads conversation or another project's task → `FORBIDDEN`.
  - `mentions.test` `lets any agent of the project tag people`: `checkMentions` as E in its task → the ids; in the Leads
    conversation → `INVALID_MENTION`.
  - `terminal.test` `lets any agent of the project read or type in another agent's terminal`: `mayDrive` E on A passes; on an
    agent of project B → refused; on the coordinator's terminal → `TERMINAL_PRIVATE` (as today).
  - `profile.test` `lets any agent of the project set an agent's avatar`; an agent of project B → `FORBIDDEN`.
  - integration `resumes a start for the agent that made it and its coordinator, never another agent`: E's `agent.start`;
    `store.start(host, tab, startId, E)` and `(…, coordinator)` answer the start; `(…, A)` → `FORBIDDEN`.
- [ ] **Step 2: Run** `cd backend && NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=… npx vitest run src/superTabs/commands.test.ts src/superTabs/decisions.test.ts src/superTabs/mentions.test.ts src/superTabs/terminal.test.ts src/superTabs/profile.test.ts -t "any agent|settings and who coordinates|another project and Buddies|tell a person|ask a person|tag people|terminal|avatar"`
  → FAIL with `LEAD_REQUIRED`, `MERGE_RECORDER`, `TELL_FORBIDDEN`, `DECISION_FORBIDDEN`, `MENTION_FORBIDDEN`.
- [ ] **Step 3: Implement.** Delete the role checks named under Files; nothing else changes about who may read what.
- [ ] **Step 4: Run** the five unit files whole, then `npx vitest run --config vitest.super-tabs.config.ts integration/superTabs.test.ts`
  → PASS except baseline failures.
- [ ] **Step 5: Commit** — "Swarm: any agent of the project creates, assigns, starts, routes and closes tasks; the
  Swarm's settings stay the coordinator's (project instructions, phase 4, task 1)".

### Task 2: Role kinds decide nothing

**Files:**
- Modify: `commands.ts`: `assignable` (~430-435) keeps only `BUDDY_NOT_ASSIGNABLE`; delete `roleSetOf`, `chosenRole`,
  `keepUsedRoles`, `requireCustomRole` (~437-475) and their callers (`agent.add` ~1601-1606, `agent.start` ~1670-1671,
  `work.assign` ~2361-2362, `conversation.create` ~1481); `REVIEWER_NOT_LEAD` (~1608, ~2068); `TEAM_ACCOUNT_BUSY`
  (~1615) keys on `command.lead`; `conversation.agent` (~2067-2087): `requireTeamWork` for every agent added,
  `STOP_REQUESTED` for any stopping agent added, `workDecision` cleared for any agent added; `work.assign` reviewer loop
  (~2372-2374) deleted, `lostTask` cleared on any assignment (~2371); `work.status` Ready-for-review recipients by kind
  (~2449-2451) deleted; `agent.release` `WORK_REQUIRED` (~1981-1987) deleted; `joinsProject` reviewer clause (~563);
  `requireWorkerDecisions` callers (~1664, ~1841, ~2271, ~2365)
- Modify: `model.ts`: delete `requireWorkerDecisions` (~524-530); `finishWorker` (~531-540) and `awaitingWorkers`
  (~511-523) without `agentRole`; delete `reviewing` (~541-545) once unused
- Modify: `instructions.ts` (`legacyRoleName`)
- Test: `commands.test.ts` (rewrite 'Reviewer role' ~1478: its `REVIEWER_NOT_ASSIGNABLE`, `REVIEW_GROUP`,
  `REVIEWER_NOT_LEAD`, `ROLE_*`, `WORKER_DECISION_REQUIRED` cases), `instructions.test.ts`

**Interfaces:**
- Produces: `legacyRoleName(project: SwarmProject, given: { role?: 'builder' | 'reviewer'; roleId?: string }): string | undefined`.
- The stored `role` / `roleId` stay on agents and start requests for older readers; only `roleNameOf` reads `role`.

- [ ] **Step 1: Failing tests**
  - `assigns any agent any task`: an agent started with `role: 'reviewer'` assigned a plain task, and a builder assigned a
    task with `reviewOf` → both accepted; a Buddy → `BUDDY_NOT_ASSIGNABLE`.
  - `lets an agent of any kind lead or be named into a linked task`: the coordinator's `conversation.agent lead: true` of a
    reviewer-kind agent → `leadId` set; a post naming it in a task with `reviewOf` → it joins.
  - `names an older client's start by its kind`: `agent.start` with `role: 'reviewer'` and no `roleName` → the started
    agent's `roleName` is `'Reviewer'`; with a custom `roleId` → that role's name; with `roleName: 'Tester'` → `'Tester'`.
  - `holds nothing for an undecided worker`: with a finished worker `awaiting`, the coordinator's `agent.start`,
    `work.assign` and `route.record` pass.
  - `keeps or stops any agent on request`: `agent.release keep` of an agent with no assignment → `workDecision: 'keep'`.
  - `wakes nobody by kind on Ready for review`: a reviewer-kind agent in the group; the status row's recipients are
    `[coordinator]` only.
  - `adds any agent with its team access checked`: `conversation.agent` of a teammate's builder on a personal machine into
    another person's project → the team-work refusal (as `requireTeamWork` gives today for Reviewers); a stopping agent →
    `STOP_REQUESTED`.
  - `instructions.test` `names an older client's role`: `legacyRoleName` cases above, and undefined with neither.
- [ ] **Step 2: Run** `… npx vitest run src/superTabs/commands.test.ts src/superTabs/instructions.test.ts -t "any agent any task|any kind lead|older client|undecided|keeps or stops|by kind|team access"` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `… npx vitest run src/superTabs` → PASS.
- [ ] **Step 5: Commit** — "Swarm: an agent's role kind decides nothing; older clients' kinds become role names (project
  instructions, phase 4, task 2)".

### Task 3: Checks are information; review credit goes to whoever passed

**Files:**
- Modify: `commands.ts`: `check` schema (~97, `independent` optional); `work.define` checks `.min(0)` (~223);
  `BRIEF_REQUIRED` (~1471-1473, ~2356); `CHECKS_PENDING` (~2413-2415); `work.check` (~2536-2559): the three
  `INDEPENDENT_REVIEW` refusals and the hand-back to Working (~2557-2559) deleted; the assignment row lists acceptance
  checks only when there are some (~2397)
- Modify: `liveness.ts`: `waitingForReview` (~74-78) is `status === 'review'`; delete `reviewFoundProblems` (~88-94),
  `READY_FOR_REVIEW`, `REVISION`
- Modify: `leaderboard/record.ts` (`recordVerdict` ~271, `recordReview` ~310), `ship.ts` (~20-23)
- Test: `commands.test.ts` (rewrite 'the checks of a review' ~3852), `liveness.test.ts`, `leaderboard/record.test.ts`, `ship.test.ts`

**Interfaces:**
- `recordVerdict(state, group, check, checker: Agent, now)`: counts only when `checker.id !== group.assignment?.agentId`.
- `recordReview(group, check, passed, byAssignee: boolean): void`: ignores the assignee's verdicts; `firstReview` is false
  once any recorded first verdict failed, true while every recorded first verdict passed.
- `shipNotice` `reviewerIds`: agents in `passedBy` (`agent:<id>`) of the group's and its linked tasks' checks, minus the assignee.

- [ ] **Step 1: Failing tests**
  - `lets anyone in the task pass its checks, its assignee too`: the assignee passes an `independent: true` check →
    `passedBy === 'agent:<assignee>'`; another agent in the task passes the other.
  - `marks done without passed checks`: `work.status done` with a result, checks unpassed → status `done`.
  - `creates, defines and assigns a task with no checks`: an agent's `conversation.create` with `checks: []`, `work.define`
    with `checks: []`, then `work.assign` → accepted; the assignment row's text is the brief alone.
  - `keeps a failed check as a finding`: a failed check while the assignment is `review` → status stays `review`, no
    `Working` row.
  - `liveness.test` `waits for review only in the review status`: `working` with "Ready for review @abc1234" → false;
    `review` → true.
  - `record.test` `credits a check passed by anyone but the assignee`: the assignee's → no `ledger.reviews`; another
    agent's on an `independent: false` check → one review counted.
  - `ship.test` `names who passed its checks as reviewers, whatever their role`: a builder-kind agent that passed a check
    on the task and a linked task's passer are listed; the assignee that passed its own is not.
- [ ] **Step 2: Run** `… npx vitest run src/superTabs/commands.test.ts src/superTabs/liveness.test.ts src/superTabs/leaderboard/record.test.ts src/superTabs/ship.test.ts`
  → FAIL with `INDEPENDENT_REVIEW`, `CHECKS_PENDING`, `BRIEF_REQUIRED`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `… npx vitest run src/superTabs` → PASS.
- [ ] **Step 5: Commit** — "Swarm: checks are information, Done is the agent's word, and review credit goes to whoever
  passed a check on another agent's task (project instructions, phase 4, task 3)".

### Task 4: Linked tasks run in parallel; agents open their own reviews

**Files:**
- Modify: `commands.ts`: `conversation.create` (~1475-1485: `REVIEW_TARGET` → `NOT_FOUND` per decision 5, `REVIEW_OPEN`
  deleted; ~1490: the creating agent joins `agentIds`); `conversation.archive` `REVIEW_PENDING` (~1574-1576);
  `work.status` automatic review (~2454-2462) deleted; review capacity call (~2464) without policy and rules
- Delete: `backend/src/superTabs/autoReview.ts` (`verdictPending` moves to `tidy.ts` as `linkPending`)
- Modify: `reviewCapacity.ts` (`seats` ~25-40 and `reviewCapacityNotice` ~49: no policy rows, quality or rules; text
  `No new agent can start: no machine this project may use can run Claude Code or Codex now (${list}).`; the "would
  unblock them" sentence goes), `tidy.ts` (`archivable` ~145 uses `linkPending`)
- Test: `commands.test.ts`, `reviewCapacity.test.ts`, `tidy.test.ts`; integration `superTabTidy.test.ts` ('a review the
  Swarm opens by itself' is deleted: ledger, it leaves the baseline list)

**Interfaces:**
- `linkPending(state: SuperTabState, linked: Conversation): boolean` (today's `verdictPending`).
- `reviewCapacityNotice(state, group, now, teamOk: (machineId: string, contributorId: string) => boolean)`.

- [ ] **Step 1: Failing tests**
  - `opens several linked tasks at once, each with its creator in it`: E creates R and S with `reviewOf: T` → both exist;
    `R.agentIds` holds the coordinator and E; a task linked to R is accepted.
  - `keeps a link inside the project`: `reviewOf` another project's task, the project chat or a Buddy chat → `NOT_FOUND`.
  - `archives a linked task without a verdict`: archive R with no evidence while T is active → archived.
  - `opens no review by itself`: E's `work.status review` with a project pull request URL and a free reviewer-kind agent →
    no new conversation and no row with source kind `auto-review`.
  - `reviewCapacity.test` `says when no machine the project may use can start either engine`: every machine's engines
    out of quota → the notice above; one usable → none; a machine the project may not use is not counted.
- [ ] **Step 2: Run** `… npx vitest run src/superTabs/commands.test.ts src/superTabs/reviewCapacity.test.ts src/superTabs/tidy.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `… npx vitest run src/superTabs` and `npx vitest run --config vitest.super-tabs.config.ts integration/superTabTidy.test.ts` → PASS.
- [ ] **Step 5: Commit** — "Swarm: a task's linked tasks run side by side, opened by agents, and the server opens no
  review (project instructions, phase 4, task 4)".

### Task 5: No routing refusals on the server

**Files:**
- Modify: `commands.ts`: delete `refusal`, `ruled` (~790-810), `routed` (~718-720), `mayRun` (~782-784), `routedWork`
  (~786-787), `defaulted` (~751-769), `policy` (~779), `groupRules`/`machineName`/`macOf` once unused; `lead.start` (~1104)
  fills only `BUILT_IN_ROLE_DEFAULTS.lead`; `agent.start` (~1663, ~1686-1688, ~1713); start dispatch (~1838-1840);
  `route.record` (~2268-2281: no `ruled`, no `stepUp` field, stamps `instructionsRevision`); `route.override` (~2317, text
  ~2321 drops "Hand this task over to it."); `work.assign` (~2352, ~2396); `conversation.agent` (~2084); `linkDecision`
  (~866-881): no `OVERRIDE_REASON_REQUIRED`, override reason `'No reason given.'`, chat lines `${who} started|assigned X
  instead of Y.` plus ` Reason: …` when given; `CommandContext.routingPolicy` deleted
- Modify: `rules.ts`: delete `broken`, `unmet`, `reviewRefusal`, `buildRefusal`, `GRID_BUILDS`, `gridBuilds`, `cheapKind`,
  `liftEffort`, `MayRun`, `policyQuality`, `targetQuality`, `agentQuality`, `agentTarget`, `startTarget` as they lose
  callers; keep the rule schemas, `MAX_RULES`, `RULE_MESSAGE_MS`, `SwarmRule`
- Modify: `stepUp.ts` (`stepUpRefusal` deleted; `cheapAttempt(group)` is `run.grid`, no policy), `engineHealth.ts`
  (`engineUnusable` ~93: the quota line goes), `routeRecord.ts` (`instructionsRevision?: number` on the stored record),
  `store.ts` (`context.routingPolicy` ~1277 goes)
- Test: `commands.test.ts` (rewrite 'agents route before they start or assign' ~1165, "the owner's rules" ~2148, 'a task
  that requires a machine or a device' ~2259, "the owner's rules in a Swarm of projects" ~2353, "the owner's rules, after
  review" ~2568, 'a build at the top tier' ~3802; drop `routingPolicy: FIXTURE_POLICY` from the fixture ~24),
  `engineHealth.test.ts`; delete `buildRules.test.ts`, `reviewRules.test.ts` and the rule cases of `teamRouting.test.ts`
  (its team-access cases stay)

- [ ] **Step 1: Failing tests**
  - `starts, assigns and routes whatever the old rules said`: `state.rules` holds `forbidModel haiku` and `machines
    [other]`; an agent's `agent.start` of Haiku on `host` with no `routeDecisionId`, its `work.assign` of a Haiku agent with
    none, and a `route.record` picking it → accepted, no row with source kind `rule`.
  - `takes any model for a build or a review`: a Sonnet build, a grid-model build of a high-risk task, a grid-model start
    into a task with `reviewOf` → accepted.
  - `ignores a task's machine and device requirement`: a task requiring `[m2]` assigned to an agent on `host` → accepted.
  - `follows another candidate with no reason`: `work.assign` with a decision whose pick is another agent and no
    `overrideReason` → accepted; `effects.routeDecisions` holds `override.reason === 'No reason given.'`; the row reads
    `E assigned A instead of <pick>.`
  - `records the instructions revision a route relied on`: project at revision 3 → the created record's
    `instructionsRevision === 3`; a project without a document → `0`.
  - `starts with no role default`: a person's `agent.start` with no model → the start request has no `model`;
    `lead.start` with engine `claude` → `model: 'opus', effort: 'xhigh'`.
  - `engineHealth.test` `starts on an engine whose quota is used up`: a window at 100% → `engineUnusable` null; signed out
    and suspended → their reasons, as today.
- [ ] **Step 2: Run** `… npx vitest run src/superTabs/commands.test.ts src/superTabs/engineHealth.test.ts -t "old rules|any model|requirement|no reason|instructions revision|role default|used up"`
  → FAIL with `ROUTE_REQUIRED`, `RULE_BROKEN`, `BUILD_REFUSED`, `REVIEW_REFUSED`, `REQUIREMENT_UNMET`,
  `OVERRIDE_REASON_REQUIRED`, `ENGINE_UNAVAILABLE`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `… npx vitest run src/superTabs src/routes` and `npx tsc --noEmit -p .` → PASS.
- [ ] **Step 5: Commit** — "Swarm: the server refuses no start, assignment or route for its model, machine, rules or
  quota (project instructions, phase 4, task 5)".

### Task 6: Old clients' routing and role saves

**Files:**
- Modify: `commands.ts`: `rule.set` (~1443-1453) appends to the document; `rule.remove` (~1454-1462) accepted, no write;
  `ruleChange` (~829-845) → exported `ruleProject` (no `OWNER_REQUIRED` / `OWNER_MESSAGE_REQUIRED`); `tab.routingPolicy`
  (~1438-1442), `project.skills` (~1109-1141), `project.roles.create|role.set|role.remove|roles.reset` (~1142-1176):
  accepted, no write; `removeMachine`'s rules loop (~959-970) deleted
- Modify: `instructions.ts` (`appendRouting`, `INSTRUCTIONS_FULL`), `store.ts` (`context.instructions` also for `rule.set`
  ~1214, for `ruleProject`'s project; `writeRoleTexts` only for `project.delete` ~1462; `saveAccountPolicy` ~604-617 stores
  nothing and answers the default)
- Test: `commands.test.ts` (rewrite 'tab.routingPolicy' ~760, the rule-change cases of the rules blocks, the rules lines of
  'machine.remove' ~2634), `instructions.test.ts`, `routingPolicy.test.ts`, `integration/superTabInstructions.test.ts`

**Interfaces:**
- Produces: `appendRouting(text: string, line: string): string`: `- ${line}` at the end of the first `## Routing` section
  (before the next `## ` heading), else `\n\n## Routing\n\n- ${line}\n` at the end; a result over `MAX_INSTRUCTIONS_BYTES`
  fails `INSTRUCTIONS_FULL` 409. `ruleProject(state, actor, command): SwarmProject` (the project named, else the `askedIn`
  chat's, else the actor's, as `ruleChange` finds it today).
- `ignored` answers: `result.ignored = true`, `result.note = 'Routing and roles live in each project's instructions now. Update Harness to edit them there.'`

- [ ] **Step 1: Failing tests**
  - `writes an old CLI's rule into the instructions' Routing`: the coordinator's `rule.set` (forbidModel haiku, text
    `No Haiku.`, `askedIn` the owner's message) → `effects.instructions.text === appendRouting(stored, 'No Haiku.')`,
    revision +1, `askedBy` the owner, summary `Routing: No Haiku.`, one chat line as a save; `state.rules` unchanged. On a
    project at revision 0 the text it appends to is `INSTRUCTIONS_TEMPLATE`.
  - `needs a person behind an agent's rule`: the coordinator's `rule.set` with no `askedIn` → `ASKED_BY_REQUIRED`.
  - `accepts a rule removal and changes nothing`: `rule.remove` → `ignored: true`, no message, `state.rules` unchanged.
  - `ignores old policy, skill-set and role saves with a note`: `tab.routingPolicy`, `project.skills`, `project.role.set`
    → `ignored: true` and the note; `state.routingPolicy`, the project's `skillSet` and `roles` unchanged; no `Skills:` row.
  - `leaves the old rules alone when a machine leaves`: `machine.remove` → `state.rules` unchanged, no `Rule changed` row.
  - `instructions.test` `appends a routing line`: a section followed by another, a section at the end, no section, a
    65,536-byte text → `INSTRUCTIONS_FULL`.
  - integration `takes an old Desktop's saves`: `POST /api/super-tabs/routing-policy` → 200 `{ isDefault: true }`, no
    `RoutingPolicy` row; `project.role.set` writes no `SuperTabRoleText`; an old `rule.set` makes a new revision whose text
    `GET …/instructions` returns.
- [ ] **Step 2: Run** `… npx vitest run src/superTabs/commands.test.ts src/superTabs/instructions.test.ts -t "old CLI|person behind|rule removal|old policy|machine leaves|routing line"` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `… npx vitest run src/superTabs src/routes` and `npx vitest run --config vitest.super-tabs.config.ts integration/superTabInstructions.test.ts` → PASS.
- [ ] **Step 5: Commit** — "Swarm: an older client's routing rule lands in the project's instructions; its policy, skill
  set and role saves are accepted and kept nowhere (project instructions, phase 4, task 6)".

### Task 7: The model catalog, served in one read

**Files:**
- Create: `backend/src/superTabs/catalog.ts`; test `catalog.test.ts`
- Modify: `routingPolicy.ts`: `DEFAULT_ROUTING_POLICY.models` and `localModels` derived from the catalog (floor
  `{ low: 1, medium: 2, high: 3 }`, `quotaReserve: 10`, `notes: ''` as today); delete `effectivePolicy`, the override and
  save schemas once unused; `priorFor` stays
- Modify: `store.ts` (`accountPolicy` ~596, `tabPolicy` ~619, `policyOf` ~630)
- Test: `routingPolicy.test.ts`, `integration/superTabs.test.ts`

**Interfaces:**
```ts
export interface CatalogModel { engine: 'claude' | 'codex'; model: string; effort: string; strength: 1 | 2 | 3; cost: number; offered: boolean; note?: string }
export interface CatalogGrid { strength: number; models: ReadonlyArray<{ model: string; strength: number }> }
export const MODEL_CATALOG: { models: readonly CatalogModel[]; grid: CatalogGrid }
export interface CatalogRead { models: readonly CatalogModel[]; grid: CatalogGrid; priors: PriorsTable; prices: readonly ModelPrice[] }
export function catalogRead(): CatalogRead
```
Rows, in order: claude opus high 3 cost 3; claude opus xhigh 3 cost 4; codex default default 3 cost 2; codex gpt-6.1-sol
high 3 cost 2; codex gpt-6-astra xhigh 3 cost 5 (all offered); claude sonnet medium 2 cost 2 and claude haiku auto 1 cost 1,
`offered: false`, note `Not offered by default: no Engineer runs on Claude Sonnet or Claude Haiku (Ken and Dee, 2026-10-30).`
Grid: strength 1; `kimi k3` 2, `deepseek v4.1` 2. `GET /api/super-tabs/:tabId/routing-policy` answers `{ policy:
DEFAULT_ROUTING_POLICY, warnings: [], overridden: [], override: null, account: DEFAULT_ROUTING_POLICY, catalog:
catalogRead() }` (a Buddy still refused); `GET /api/super-tabs/routing-policy` answers `{ policy: DEFAULT_ROUTING_POLICY,
revision: 0, isDefault: true }`.

- [ ] **Step 1: Failing tests**
  - `catalog.test` `lists today's models with their strength`: the rows above exactly; every offered row is strength 3.
  - `catalog.test` `gives older CLIs the same rows as a policy`: `DEFAULT_ROUTING_POLICY.models` equals the catalog rows
    as `{ engine, model, effort, quality: strength, cost, enabled: offered }`; `localModels.models` the grid rows.
  - integration `serves the catalog, priors and prices with the default policy, whatever the owner saved`: an account
    policy row and a tab override in place → the read's `policy` is the default and `override` null; `catalog.models`
    has 7 rows; `catalog.prices` holds `claude-opus-5-5`; a Buddy's read is refused.
- [ ] **Step 2: Run** `… npx vitest run src/superTabs/catalog.test.ts src/superTabs/routingPolicy.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `… npx vitest run src/superTabs src/routes` and the integration file → PASS.
- [ ] **Step 5: Commit** — "Swarm: a reviewed model catalog, served to the route with priors and prices (project
  instructions, phase 4, task 7)".

### Task 8: Server notices replace server actions and say only what happened

**Files:**
- Modify: `tidy.ts`: `stopIdleWorkers` (~97-127) → `idleNotices`; delete `asleepMatch`, `ASLEEP_FIELDS`, `GroupActivity`,
  `stoppedMachines`, `recheckPending`, `reportedClean`; `IDLE_STOP_MS` → `IDLE_NOTICE_MS`
- Modify: `store.ts` (the coordinator's poll ~2635-2647, ~2682: no asleep read, no `stoppedMachines`; the stop notice
  text ~2990)
- Delete: `stepUp.ts`; in `commands.ts` `steppedUp` (~811-823) and its callers (~1884, ~2553-2554) become notices,
  `carryOver` (~2397) goes; `agent.startFailed` (~1877-1883) recipients and model
- Modify: `native.ts` (`recovery` ~190-196: no `blocked`, facts-only text; `append` recipients ~222: only a required
  recovery reaches the coordinator — phase 1's deferred change)
- Modify: `model.ts` (`Agent.idleNoticedAt`, `NOTICE_READERS` `idle` and `review-failed` → `'recipients'`), `startFailure.ts`
  (`failureNotice(name, error, model?)`; `LEAD_PICKUP_SUFFIX` → `leadPickupSuffix(name)`)
- Facts-only texts: `liveness.ts` (~179-183, ~377-379: `A task is stalled:` / `N tasks are stalled:` and no "Act on…"),
  `terminal.ts` (~136), `commands.ts` (~975, ~1004 overlaps: no "Agree an order…", ~1340, ~2050, ~2499); the coordinator's
  name from `coordinatorNameOf(project)`: `leadStart.ts` (`LEAD_NAME` uses ~48, 51, 68, 169, 178; the constant stays only
  for `store.ts` ~427's old rows), `commands.ts` `protectLead` (~495) and `lead.start` (~1093-1102), `decisions.ts`
  (`DELEGATED_NOTICE` → `delegatedNotice(name)`)
- Test: `tidy.test.ts`, `commands.test.ts` (delete 'stepping up from a cheap model' ~3878), `native.test.ts`,
  `liveness.test.ts`, `leadStart.test.ts`; integration `superTabTidy.test.ts` (idle stops), `superTabTeam.test.ts` ~235,
  `superTabLiveness.test.ts` ~1456, `superTabs.test.ts` ~1137 (per-turn copies, phase 1's ruling)

**Interfaces:**
- `idleNotices(state: SuperTabState, projectId: string, now: number, busy: ReadonlySet<string>): MessageDraft[]`: for each
  agent of the project, not a Buddy, not its coordinator, not stopping, not in `busy`, not waiting to resume, in no
  loaded group with active work and assignee of none, idle since `idleSince` (its start, keep, own progress or its groups'
  activity; no Reviewer case) for `IDLE_NOTICE_MS` and with `idleNoticedAt !== since`: one `toLead` row,
  `${name} has had no open task for 15 minutes.`, source `{ kind: 'idle', agentId }`; sets `idleNoticedAt = since`.
- The failed first review (`work.check`: `run.firstReview` turns false on a `run.grid` attempt): one `toLead` row,
  `#${n} ${title}: its first review failed. It ran on ${model} on the Swarm's grid. Findings: ${evidence ≤ 500}`, source
  `{ kind: 'review-failed', conversationId }`; nothing is cancelled.

- [ ] **Step 1: Failing tests**
  - `tidy.test` `tells the coordinator once about an agent with no open task for 15 minutes`: started 16 minutes ago →
    one row to the coordinator with the text above, `workDecision` unchanged; a second call → none; idle again after new
    work (a new `since`) → one more. A Buddy, the coordinator, an agent in `busy`, an agent in a task with active work →
    none.
  - `tells the coordinator of a grid attempt's failed first review and steps nothing up`: one notice naming the model and
    the evidence; the assignment stays active, `group.stepUp` undefined; a second failed verdict → none; a subscription
    attempt → none.
  - `tells a failed start to the coordinator and the agent that made it`: E's grid start fails → the row's recipients are
    `[coordinator, E]` and its text names the grid model; nothing cancelled.
  - `native.test` `records a recording gap without blocking its task`: a required recovery → status stays `working`,
    recipients `[coordinator]`; a prompt or answer turn → recipients `[]`.
  - `states what happened, never the next step`: a lost task, a stalled task, a model alert, a person's route override,
    a removed agent, a removed machine, an abandoned start, a host-confirmed stop and an overlap → no text contains any of
    `Assign it to another agent now`, `assign it there now`, `Act on`, `Stop it, or give the work`, `Hand this task over`,
    `needs to be assigned again`, `Start it again`, `If this work should continue`, `Agree an order`.
  - `leadStart.test` `names the coordinator as its project calls it`: `coordinatorName: 'Coordinator'` → `lead.start`'s
    `LEAD_EXISTS` text, the joined line and the started agent's name use `Coordinator`; `protectLead`'s text too.
- [ ] **Step 2: Run** `… npx vitest run src/superTabs/tidy.test.ts src/superTabs/commands.test.ts src/superTabs/native.test.ts src/superTabs/liveness.test.ts src/superTabs/leadStart.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `… npx vitest run src/superTabs` and `npx vitest run --config vitest.super-tabs.config.ts integration/superTabTidy.test.ts integration/superTabTeam.test.ts integration/superTabLiveness.test.ts integration/superTabs.test.ts`
  → PASS except baseline failures; ledger each expectation changed.
- [ ] **Step 5: Commit** — "Swarm: idle agents, failed grid attempts and recording gaps are notices to the coordinator,
  and notices say only what happened (project instructions, phase 4, task 8)".

### Task 9: The nightly reflection writes approved changes into the instructions

**Files:**
- Modify: `costs/reflection.ts`: delete `Approved`, `APPROVED_DAYS`, `LAPSED_DAYS`, `approvedReminder`,
  `ReflectionInput.approved | lapsed | rules` and the rule filter; add `routingLine`, `ReflectionInput.document`;
  `proposalQuestion` (~270-276) says what Yes does now
- Modify: `store.ts` `postReflection` (~2832-2905): reads the project's document (`superTabInstructions`, or
  `INSTRUCTIONS_TEMPLATE` at revision 0); no approved or lapsed maps, no reminder row to the coordinator
- Modify: `instructionsTemplate.ts` (one PM bullet: `When the project owner answers Yes to a nightly routing proposal,
  writes its line into Routing, naming the owner as who asked.`)
- Test: `costs/reflection.test.ts`, `instructions.test.ts`, `integration/superTabReflection.test.ts`

**Interfaces:**
- `routingLine(p: Proposal): string`: `cheaper` → `${Kind} work runs on ${to} instead of ${from}.`; `stop` → `${Kind} work no
  longer runs on ${from}.` (`Kind` is the task kind, capitalized; models as the report names them).
- A proposal whose `routingLine` is in `document` is not proposed; the report says `In the instructions: ${line} The last
  7 days ran ${n} ${kind} tasks on ${from}.`

- [ ] **Step 1: Failing tests**
  - `reflection.test` `reads the instructions instead of an approved list`: a document with the line → not proposed, the
    report's line as above; without it → proposed.
  - `reflection.test` `asks Yes as a change to the instructions`: `options[0]` starts `Yes: the coordinator writes this into
    the Routing section of the instructions`; `unblocks` contains `routingLine(p)`.
  - `instructions.test` `describes the spec's template` also finds `nightly routing proposal` in the PM section.
  - integration `posts no reminder of approved changes`: an owner's Yes within 30 days → no row to the coordinator and no
    `Approved changes` text; a saved revision holding the line → the report says `In the instructions`.
- [ ] **Step 2: Run** `… npx vitest run src/superTabs/costs/reflection.test.ts src/superTabs/instructions.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the unit files and `npx vitest run --config vitest.super-tabs.config.ts integration/superTabReflection.test.ts` → PASS.
- [ ] **Step 5: Commit** — "Swarm: a Yes to a routing proposal is a line in the instructions, and the reflection reads them
  (project instructions, phase 4, task 9)".

### Task 10: Phase 1's deferred minors

**Files:** `commands.ts`: `message.react` (~2114-2116) uses a membership check that never joins (`FORBIDDEN` for an agent
not in the group); the `message.send` recipient loop (~2199-2206) lets only an agent sender's recipients join; `joinsProject`
(~558-564) refuses an agent marked stop; the "Who may post…" comment (~552) moves back above `postable`. Test
`commands.test.ts` (beside phase 1's recipient tests).

- [ ] **Step 1: Failing tests**: `reacts only where the agent already is` (→ `FORBIDDEN`, `agentIds` unchanged);
  `keeps a person's message from adding agents` (a person naming a project agent outside the group →
  `INVALID_RECIPIENT`, nothing joins); `never adds a stopping agent` (named → `INVALID_RECIPIENT`; posting into another
  task → `FORBIDDEN`); `keeps private and Buddy chats closed to posts` (an agent posting into a private chat or a Buddy chat
  it is not in → `FORBIDDEN`).
- [ ] **Step 2: Run** `… npx vitest run src/superTabs/commands.test.ts -t "already is|person's message|stopping agent|closed to posts"` → FAIL (the first three).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `… npx vitest run src/superTabs/commands.test.ts src/superTabs/parts/touches.test.ts` → PASS.
- [ ] **Step 5: Commit** — "Swarm: reacting and a person's message add nobody to a task, nor does naming a stopping agent
  (project instructions, phase 4, task 10)".

### Task 11: The route and the plan rank by facts (CLI)

**Files:**
- Modify: `cli/src/superTabs/route.ts`: `choose` (~437-484) without `rules`, `avoid`, `reviewFloor`, floors, the
  strongest-only cut (~469) and the first-fit-group cut (~475-476); delete `breaks`, `lifted`, `liftEffort`, `softOf`,
  `buildRefusals`, `gridBuilds`, `GRID_BUILDS`, `reviewRefusals`, `stepUpRefusals`, `floorFor`, `NAMED_OFF`, the `remote`
  term of `compare` (~414-418); `rateFor` → `strengthOf`, `gridQuality` → `gridStrength`; `recordOf` sends `floor: 1`,
  `belowFloor: false`, `notes: false`
- Modify: `routeCommand.ts`: `routeTask` (~195-374): no `LEAD_REQUIRED` (~214), no coordinator exclusion (~220-221), every
  member whatever its kind (~233), no forced `review` kind (~223-224), no rules (~228-231), `ELSEWHERE`, `UNCHECKED_DEVICE`,
  lost task (~303-307), stall (~266-268) and avoided account (~336-339) as notes; `memberRefusals` (~115-121) and
  `probeMachine` (~560) quota as information; `unreadyPool` (~75-99) push readiness as a note; `localProbes` (~471-487) also
  offers `refusedModels` with their why as a note; the `next` hint (~366-372) neutral; phase 3's `instructions` answer
  kept
- Modify: `capacity.ts` (~163: an exhausted window goes to `unknown`, not `reasons`), `lib/codingModel.ts` (texts say "a
  coding agent", not "Builders"), `service.ts` (`routeHistory` ~546-552: no `LEAD_REQUIRED`)
- Modify: `planInput.ts` (~80, ~102-107, ~147-182, ~198: no rules, floor 1, linked tasks may take grid models, reserve 0,
  exhausted engines kept), `tools/scheduler/scheduler/swarm.py` (`_allowed` ~111-120 unused, floor ~186 → 1,
  `independent_of` ~192 → `[]`, reserve ~199 → 0)
- Test: `route.spec.ts`, `routeCommand.spec.ts`, `capacity.spec.ts`, `planInput.spec.ts`, `lib/codingModel.spec.ts`,
  `serviceReads.spec.ts` (or wherever `routeHistory` is tested), `tools/scheduler/tests/test_swarm.py`

**Interfaces:**
- Consumes: task 7's read (`catalog` beside `policy`); phase 3's `routeTask` `instructions` field.
- Produces: `Catalog { models: CatalogModel[]; grid: { strength: number; models: Array<{ model: string; strength: number }> } }`;
  `catalogFrom(effective: Json): Catalog` (its `catalog`, else rows derived from its `policy`: an older backend);
  `strengthOf(c, engine, model, effort, engineDefault = false): number | null` (exact row, the model's other effort, the
  engine's default row when launched on it, else null); `gridStrength(c, model, label): number`; `Probe.notes: string[]`,
  `Probe.unrated?: true`, `quality = strength ?? 1`; `choose(probes, catalog, a, now?, open?, held?)`.
- Ranking (`compare`): strength, then effective cost (price, cheaper with an expiring 5-hour window), then fit (`fits`,
  `unknown`, `short`), then an idle member before a new agent, then title.

- [ ] **Step 1: Failing tests**
  - `route.spec` `leaves out only what cannot run`: a probe refused as offline is excluded; a Sonnet row is not offered
    unless named, and named it is offered with its catalog note; a grid model for a high-risk build and a strength-1 model
    for a high-difficulty task are offered.
  - `route.spec` `ranks by strength, then price and quota fit, then idle members`: Codex default (3, cost 2), Opus high (3,
    cost 3), Kimi K3 on the grid (2) → that order; a strong candidate short of quota is shown with fit `short`.
  - `route.spec` `offers a named model the catalog does not list, unrated`: `model: 'gpt-6.2'` → Codex candidates whose
    label says `unrated`; `model: 'claude-opus-6'` → Claude ones.
  - `routeCommand.spec` `lets any agent of the group's project route`: `value.agentId !== group.leadId` → answer `ok: true`.
  - `routeCommand.spec` `shows lost, stalled and avoided accounts as notes`: each such candidate is shown and its `notes`
    say why; an idle coordinator and a reviewer-kind member are candidates for a build.
  - `routeCommand.spec` `reads the catalog, or an older backend's policy`; `offers a small or slow grid model with a note`;
    the `next` hint holds `"roleName":"ROLE"` and none of `Builder`, `Reviewer`, `"role":"reviewer"`.
  - `capacity.spec` `starts on a used-up account and says so`: a 100% window → `allowed: true`, `unknown` names it.
  - `planInput.spec` `plans every open group with no floor, rule or reserve`.
  - `test_swarm.py` `test_tasks_have_no_floor_or_independence`, `test_owner_rules_leave_no_machine_out`,
    `test_the_budget_is_the_weekly_quota_left` (replacing the reserve, machines-rule and review-family cases).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/superTabs/route.spec.ts src/superTabs/routeCommand.spec.ts src/superTabs/capacity.spec.ts src/superTabs/planInput.spec.ts src/lib/codingModel.spec.ts`
  and `cd tools/scheduler && python3 -m unittest tests.test_swarm -v` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd cli && npx vitest run src/superTabs src/lib && npx tsc --noEmit -p .`; the scheduler suite with the
  README's venv (`.venv/bin/python -m unittest discover -s tests -t .`), or `tests.test_swarm tests.test_instance` with
  `python3` when OR-Tools is missing (ledger which) → PASS.
- [ ] **Step 5: Commit** — "CLI: the route and the plan rank every candidate that can run; rules, floors, kinds and
  quota are notes, not filters (project instructions, phase 4, task 11)".

### Task 12: CLI commands, help and the tools skill follow the backend

**Files:**
- Modify: `cli/src/superTabs/service.ts`: `taskCommand` (~162-180) refuses nothing (a complete task as today; an
  incomplete one is sent as its rendered `brief` without `task`); `LEAD_HELP` (~118-128) merged into `HELP`, so every agent's
  help has `--mention`, `plan`, `decision.ask`, `person.tell`; `HELP` texts (~52-115) lose `leads` "agree an order",
  `react`'s rules, `release`'s "prefer stop", `start`'s Reviewer/role lines, `route`'s rules, `screen`/`type` "Only its
  project's Lead", `command`'s rules, floors and step-ups, the `rule.set` / `project.skills` / `tab.tidy` examples' owner
  wording, `startRequest.name: 'Builder'`
- Modify: `cli/src/lib/swarmTools.ts` (lines ~10, 21-22, 28, 56, 63, 68-69, 84-87, 94-95): no "Refused to some agents", no
  "route first", no hard rules, no "rated 3 by the policy"; `rule.set` / `rule.remove` / `project.skills` leave the list
  (agents save the document)
- Modify: `cli/src/superTabs/start.ts`: delete `startElsewhere` (~152-260) and its helpers (`KNOWN_RULES`, `RETRY`,
  `derived`, `blocked`); `startAgent` (~110-122) returns the failed start
- Test: `service.spec.ts`, `lib/swarmTools.spec.ts`, `start.spec.ts`

- [ ] **Step 1: Failing tests**
  - `service.spec` `takes a task as written`: `conversation.create` with `task: { goal: 'Save edits' }` → the command sent
    has `brief: 'Goal:\nSave edits'` and no `task`; a complete task → as today.
  - `service.spec` `gives every agent the same help, with no rule the server dropped`: a non-coordinator's help holds
    `--mention`, `decision.ask`, `person.tell`; `JSON.stringify(HELP)` matches none of `/prefer stop|agree an order|Only its
    project's Lead|without a routeDecisionId is refused|hard rule|top tier|steps the task up|"name":"Builder"|role "reviewer"/i`.
  - `service.spec` `sends no refusal the server dropped`: no non-spec `.ts` under `cli/src/superTabs` contains
    `'LEAD_REQUIRED'` or `'TASK_REQUIRED'`.
  - `swarmTools.spec` `describes the commands the server accepts now`: `SWARM_TOOLS_SKILL` matches none of `/Refused to some
    agents|route first|hard rules|rated 3|rule\.set|project\.skills/`; still contains `post GROUP`, `--to AGENT`, `instructions`.
  - `start.spec` `reports a failed start and moves it nowhere`: a routed start that fails → `{ error: 'START_FAILED' }`; no
    `route.record`, no second `agent_create`, no `message.send`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/superTabs/service.spec.ts src/lib/swarmTools.spec.ts src/superTabs/start.spec.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd cli && npx vitest run src/superTabs src/lib && npx tsc --noEmit -p .` → PASS.
- [ ] **Step 5: Commit** — "CLI: help, the tools skill and starts follow the server: any agent tags, asks and tells, tasks
  are taken as written, and a failed start is reported, not moved (project instructions, phase 4, task 12)".

### Task 13: Role kinds in the CLI: coordinator, agent, buddy

**Files:**
- Modify: `cli/src/lib/savedSkill.ts` (`SwarmRole`, `isSwarmRole`, `parseSwarmSkill`; add `WireRole`, `roleFromWire`,
  `wireRole`, `fallbackSkillName`); create `cli/src/lib/savedSkill.spec.ts`
- Modify: `cli/src/lib/swarmSkills.ts` (`skillDirectory`, `prepareSwarmSkill`, `refreshSwarmSkill`, `swarmSkillUse`: the
  role folder and text by `fallbackSkillName`), `cli/src/lib/swarmInstructionsSkill.ts` (phase 3's switch notice names
  `fallbackSkillName(saved)`), `superTabs/inCore/launch.ts` (`role: isSwarmRole`), `superTabs/inCore/role.ts` (reads the
  answer with `roleFromWire`), `superTabs/host.ts` (`swarmRoleFor` ~52-85), `superTabs/start.ts` (~363-385: `wireRole`)
- Modify: `cli/src/core/agents/launches.ts` (~415-433, ~506: `roleFromWire` before the check; detail `A Swarm role is
  coordinator, agent or buddy (or lead, dev or review from an older Harness), for Claude Code or Codex.`)
- Test: `savedSkill.spec.ts`, `swarmSkills.spec.ts`, `core/agents/launches.spec.ts`, `start.spec.ts`, `host.spec.ts`,
  `superTabs/inCore/role.spec.ts`

**Interfaces:**
- `type SwarmRole = 'coordinator' | 'agent' | 'buddy'`; `interface SwarmSkill { role: SwarmRole; key: string; mode?; github?; fallback?: 'review' }`.
- `roleFromWire(value: unknown): { role: SwarmRole; fallback?: 'review' } | null` (new values; `lead` → coordinator, `dev`
  → agent, `review` → agent + fallback, `buddy`).
- `wireRole(skill: Pick<SwarmSkill, 'role' | 'fallback'>): WireRole`; `fallbackSkillName(skill): 'swarm-lead' | 'swarm-dev' | 'swarm-review' | 'swarm-buddy'`.
- `parseSwarmSkill` reads both shapes; rows are written in the new one.

- [ ] **Step 1: Failing tests**
  - `savedSkill.spec` `reads saved rows of both shapes`: `{ role: 'lead' }` → coordinator, `dev` → agent, `review` → agent
    with `fallback: 'review'`, `{ role: 'agent' }` kept, `{ role: 'pm' }` → undefined; `wireRole` and `roleFromWire` round
    trip; `fallbackSkillName` per case.
  - `launches.spec` `takes older and newer Swarm roles from agent_create`: `swarmRole: 'review'` → the registered
    `swarmSkill` is `{ role: 'agent', fallback: 'review', … }`; `'coordinator'` → coordinator; `'pm'` → `INVALID_SWARM_ROLE`.
  - `start.spec` `sends an older machine only the role values it knows`: a start with `roleName: 'Tester'` → payload
    `swarmRole: 'dev'`; a coordinator's start → `'lead'`; an older client's `role: 'reviewer'` → `'review'`; the payload's
    keys equal today's list (written out in the test).
  - `swarmSkills.spec` `keeps each session's role file`: `{ role: 'agent', fallback: 'review' }` writes
    `swarm-review/SKILL.md` byte-equal to today's review text; coordinator → `swarm-lead`; a row saved as `{ role: 'dev' }`
    relaunches onto its existing `swarm-dev` file.
  - `host.spec` `reads a session's role without its kind`: the coordinator → coordinator; an agent with legacy
    `role: 'reviewer'` → agent with `fallback: 'review'`; any other → agent; a Buddy → buddy.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/savedSkill.spec.ts src/lib/swarmSkills.spec.ts src/core/agents/launches.spec.ts src/superTabs/start.spec.ts src/superTabs/host.spec.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd cli && npx vitest run src/superTabs src/lib src/core/agents && npx tsc --noEmit -p .` and
  `npm run test:core` (100% per file for `src/core`) → PASS; ledger any baseline failure seen in phase 3 task 2's report.
- [ ] **Step 5: Commit** — "CLI: a Swarm session is a coordinator, an agent or a Buddy; older machines still get the role
  values they know (project instructions, phase 4, task 13)".

### Task 14: The template's workflow end to end, and no dropped refusal left

**Files:**
- Create: `backend/src/superTabs/removedRefusals.test.ts`
- Create: `backend/integration/superTabWorkflow.test.ts`; add it to `vitest.super-tabs.config.ts`'s `include`

- [ ] **Step 1: Write the tests**
  - `removedRefusals.test` `reaches none of the refusals the instructions replaced`: no `.ts` file under `backend/src` but
    `*.test.ts` contains a quoted `'CODE'` for: `WORKER_DECISION_REQUIRED`, `LEAD_REQUIRED`, `REVIEW_OPEN`, `REVIEW_PENDING`,
    `REVIEW_TARGET`, `CHECKS_PENDING`, `BRIEF_REQUIRED`, `INDEPENDENT_REVIEW`, `REVIEWER_NOT_ASSIGNABLE`, `REVIEW_GROUP`,
    `REVIEWER_NOT_LEAD`, `ROLE_LEAD`, `ROLE_NAME`, `ROLE_UNAVAILABLE`, `ROLE_KIND`, `ROLE_IN_USE`, `ROLE_GONE`,
    `OVERRIDE_REASON_REQUIRED`, `ROUTE_REQUIRED`, `RULE_BROKEN`, `REQUIREMENT_UNMET`, `REVIEW_REFUSED`, `STEPPED_UP`,
    `BUILD_REFUSED`, `MERGE_RECORDER`, `TELL_FORBIDDEN`, `DECISION_FORBIDDEN`, `MENTION_FORBIDDEN`, `OWNER_MESSAGE_REQUIRED`,
    `WORK_REQUIRED`. (`ENGINE_UNAVAILABLE` stays for signed-out and suspended engines; task 5 pins quota.)
  - `superTabWorkflow` `runs review and test in parallel with no coordinator action between ready and passed`, on the
    pattern of `superTabInstructions.test.ts` (agents added on `test-host`, commands `run(tab, cmd, host, agentId)`):
    coordinator P, Engineer E (`roleName: 'Engineer'`), Reviewer V, Tester X. P creates T with checks `Review passes` and
    `Test passes` and assigns E. Then only E, V and X act: E sets `review` with a result; E creates R and S (`reviewOf: T`)
    and assigns V and X (no `routeDecisionId`); E posts in T naming V and X; V fails `Review passes` with a finding and posts
    it to E; E posts the fix to V; V passes it; X passes `Test passes`; V and X set their own tasks `done`; E posts to P
    `Review and test passed.` Assert: every one of those commands succeeded; R and S were both open when the last check
    passed; T's checks have `passedBy` `agent:V` and `agent:X`; every delivery P received in the window is a status row
    (`Ready for review`, `Done`) or E's message naming P, never a message between E, V and X; V and X each got E's message
    and E got V's finding; T's `ledger.reviews` counts two verdicts.
- [ ] **Step 2: Run** `cd backend && NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=… npx vitest run src/superTabs/removedRefusals.test.ts`
  and `npx vitest run --config vitest.super-tabs.config.ts integration/superTabWorkflow.test.ts` → PASS (red before tasks
  1-6; if either fails now, the task that owns the code fixes it — ledger which).
- [ ] **Step 3: Commit** — "Swarm: the template's workflow runs end to end by agents alone, and no dropped refusal remains
  (project instructions, phase 4, task 14)".

### Phase 4 validation

Prefix every command with `export PATH=~/.harness/runtime/node-v22.23.2-darwin-arm64/bin:$PATH`.
- Backend unit: `cd backend && NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= npx vitest run src/superTabs src/middlewares src/routes`
  → all pass (1907 passed, 5 skipped at 17ee31c30; ledger the new count and the deleted test files and blocks);
  `npx tsc --noEmit -p .` clean (`npx prisma generate` first; no schema change is planned).
- Integration: `npx vitest run --config vitest.super-tabs.config.ts > integration-phase4.log 2>&1` (about 10 minutes);
  compare the failing set with the 25 baseline failures in the progress file using `comm`: no new failures. Baseline
  tests this phase deletes or rewrites leave the list (for example superTabTidy's "a review the Swarm opens by itself",
  superTabLiveness's "a Ready for review while no Reviewer of another engine can start"); ledger each.
- CLI: `cd cli && npx vitest run src/superTabs src/lib src/core/agents`, `npx tsc --noEmit -p .`, and `npm run test:core`
  (task 13 changes `src/core/agents/launches.ts`).
- Scheduler: as task 11, step 4.
- Done when: task 14's two tests pass, task 12's CLI scan passes, and the ledger holds every ruling above with its cost.
- Release: one release with phases 3 and 5, backend first (an old CLI then reads the default policy and its rules
  commands are folded or ignored; nothing it sends is refused for a rule). Phase 3's prerequisite stands: run the
  migration in production, with the owner's go, before this release.

## Phase 5: Desktop, web and phone

Spec sections: The instruction document (Who changes it, How agents read it), PM notes, Roles, What this replaces in main
("Desktop, web and phone"; the `liveness.ts` "Waiting on others" line under Role-shaped bookkeeping), Desktop and phone,
Design (Compatibility, Failure, Platforms), Order of work step 5.

Ships in one release with phases 3 and 4: backend first, then the CLI, then Desktop (and the web build, which is
Desktop's), then the phone. It builds on phase 2's reads and commands and on phase 4's catalog and route records; it
changes no backend or CLI file.

Phase 5 is done when a member who is not the project's owner saves the document from Desktop and the phone shows the
saved revision: task 2's `a member who is not the owner saves a change with its summary` and task 10's `shows the
revision a member saved from Desktop` pass, and the throwaway-Swarm check under "Phase 5 validation" passes after
release.

**Global constraints (phase 5):**
- `<flutter>` is `/private/tmp/claude-501/-Users-mac-harnesses-openharness/81ec7b2c-c155-4a17-9a7e-2fdf05160aef/scratchpad/flutter/bin/flutter`
  (Flutter 3.47.2). Desktop: `cd desktop && <flutter> test <files>`; phone: `cd mobile && <flutter> test <files>`;
  `<flutter> analyze <changed files>` in each package.
- Format only the Dart files you changed (`dart format <file>…`), never a folder.
- Desktop tests use the fixtures' memory stores (`ConversationServer`, `SuperTabLaunchFixture`), never real
  `~/.harness` state, and never call a real CLI logout. Never `pkill` Flutter by pattern.
- Pick each task's tests by grepping its changed symbols and copy across `desktop/test` and `mobile/test`
  (`grep -rln '<symbol or string>' desktop/test mobile/test`), not by file-name prefix; run every hit.
- `python3 scripts/check-ui-style.py` passes after every task that touches `desktop/lib/super_tabs` or
  `mobile/lib/swarm`. New code uses the roles (`DesktopChrome`, `grid.AppDesktop`, `AppSpace`, `AppType`): no numeric
  `EdgeInsets`, `fontSize` or `BorderRadius.circular`, no `Color(0x…)` or `Colors.*`. When a count falls (a deleted
  file, a removed padding), run `python3 scripts/check-ui-style.py --update` and commit the smaller
  `scripts/ui-style-allowlist/desktop.json` or `mobile.json` with the task.
- The phone's model reads every field Desktop's model reads (`mobile/test/swarm/desktop_parity_test.dart`): a field
  added to `desktop/lib/super_tabs/model.dart` is added to `mobile/lib/swarm/model.dart` in the same task, and a file
  listed there as a copy pair stays byte-identical on both sides.
- Copy follows `docs/naming-system.md`: the panel is **Instructions**; a project's coordinator is called by its
  `coordinatorName`; copy states facts, never a fixed workflow. Frames are the existing ones: Desktop's
  `SuperTabDetailDialog` (title, quiet close, scrolling body, actions), `AppMenuItem` rows, `DesktopChrome` text roles;
  the phone's `SwarmTopBar`, `SwarmCaption`, `SwarmGroup`, `SwarmRow`. Screens that work keep their layout; new
  behavior fills the existing menu, form row, dialog frame and Team list. The mockups below are drawn from the real
  widgets named in each task and go to the requester with this plan.
- Compatibility: an old Desktop on the new backend is phase 4's (its saves are accepted and ignored with a note). A new
  Desktop or phone on an older backend (no `coordinatorName` on the project) shows no Instructions, no role field, and
  sends no `roleName`; everything else works as today.

**Decisions this phase makes (ledger them):**
1. *The web client is Desktop.* `website/` is the Next.js host; the browser runs Desktop's Flutter app
   (`desktop/lib/web/`, same `super_tabs` screens). The one web-only change is the browser transport's allow-list
   (`desktop/lib/super_tabs/backend_transport.dart` `_swarmRoute`): it gains the three instructions reads and loses the
   routes nothing calls any more (`projects/:id/roles/:id`, the account `/routing-policy`). The tab's `routing-policy`
   read stays: New Project reads the catalog there (phase 4 decision 14). Cost: none.
2. *How a client knows the backend has instructions:* the project row carries `coordinatorName` (phase 2's head read
   sets it on every project). Absent → no Instructions item, no Team-tab row, no role field. Inside the panel, a 404
   whose code is not `NOT_FOUND` is a backend without the route (phase 3 ruling 1) and reads "This Swarm has no project
   instructions yet." The removed forms are not kept for an older backend. Cost: until the backend is released, a new
   Desktop on an old backend has no routing form or roles editor; the backend ships first.
3. *A stale save re-reads.* On `INSTRUCTIONS_STALE` the panel reads the document again rather than the refusal's
   `details`: the native transport goes through the CLI's backend proxy (`cli/src/superTabs/wire.ts` `backend`), which
   hands back code and message only, and the web transport reads `error.code`/`error.message` only. The draft stays in
   the editor, the newer text shows beside it, and the next Save goes on the newer revision. Cost: one extra read.
4. *Restore loads, Save writes.* Restore puts the old text in the editor with the summary `Restored revision N.`;
   nothing is written until Save, which goes through the same compare-and-set. Cost: one more click.
5. *Notes heading:* `${coordinatorName}'s notes` ("Product Manager's notes" by default). The spec's Names rule (every
   PM in copy reads `coordinatorName`) wins over its literal "PM's notes". Cost: a longer heading.
6. *Roles at start.* A free-text field (1-40 characters) with suggestions from the document's role headings: the
   `### ` headings inside the first `## Roles` section, less the coordinator's own role name. Empty sends nothing and
   the server names the agent ("Engineer"). `agent.add` carries `roleName`. The daemon payload keeps its keys:
   `swarmRole` is `lead` for the coordinator and `dev` for every other agent (`review` is no longer sent), and
   `swarmSkillMode` stays, because phase 4 decision 1 keeps role names off the wire and an older CLI refuses other
   values; the spec's "sends the role name instead of `swarmRole`/`swarmSkillMode`" is ruled out by it. A journal from
   an older Desktop still sends its `roleId` (phase 4 decision 2 names it). Cost: none for new machines.
7. *Adding a running agent from the picker* (`actions.dart` `addSuperTabAgent`) has no form and sends no role: the
   server names it. The spec lists `actions.dart`; nothing there changes. Cost: such an agent is an Engineer by name
   until a role rename command exists.
8. *Role labels.* An agent's label is its `roleName` (phase 2's derived value); its badge is the role name, cut to 12
   characters with "…" (`superTabRoleBadge`), and the row's own ellipsis still applies. Without `roleName` (an older
   backend) the labels and badges are today's (Product Manager/PM, Reviewer/Rev, Engineer/Dev), so old-backend screens
   and their tests stay as they are. Custom role names from an older backend's role set are no longer shown. Cost:
   that one case.
9. *Coordinator name in copy.* Copy about an existing project reads `project.coordinatorName` ("Product Manager" when
   the backend sends none). Copy written before a project exists (New Project on both platforms, `lead_placement.dart`,
   `new_harness.dart`'s lead lines, `launch.dart`'s machine checks) keeps "Product Manager", the name every new project
   starts with. Cost: none.
10. *The roles editor's copies of the CLI skill texts go with it*, and with them the byte-for-byte test in
    `super_tab_project_skills_test.dart`. The CLI's texts in `cli/src/lib/swarmSkills.ts` stay (phase 3: what a new
    CLI runs on an old backend) with no Desktop copy left to keep in step; the team's "sync `roles_editor.dart`" rule
    stops applying (tell the controller so the memory note is updated). Cost: none.
11. *`launch_prompt.dart`* was rewritten by phase 3 task 6; nothing here.
12. *Reviews are linked tasks.* A task's line lists its linked tasks (`reviewOf` it, same project) with their checks'
    results, from one file kept as a copy pair on both platforms (`linked_tasks.dart`); no agent kind and no parsed
    `Ready:` line. `review_verdict.dart` is deleted on both and leaves the parity list. The `review` status reads
    "Waiting on others" (spec, Role-shaped bookkeeping). `work_details.dart` shows the brief as written. Cost: a
    verdict an agent only posted in chat, without a check, shows nowhere but the chat.
13. *Route rows* drop floors and policy order and show the instructions revision from the decision's record
    (`record.instructionsRevision`, phase 4 decision 12); a record without it shows nothing. Cost: none.
14. *Routing gates in the client.* With the catalog in the tab's routing-policy read, New Project's model list rules
    nothing out; an older backend's answer (no `catalog`) keeps today's refusals, since that server still enforces them.
    Quota never makes a machine unusable on either platform; an older server's own refusal shows as the start's error.
    A small or slow local model gets a note instead of losing Get and Run for Swarm. Cost: on an older backend a
    machine out of quota is refused at Start, not before.
15. *The phone shows the document from its Team tab*: an Instructions caption and row after Agents, opening a
    read-only page. Swarm Home C keeps its two tabs (Tony's design). Cost: one tap further than a tab.
16. *Panel reads.* The document is read when the panel opens and again when the project's `instructionsRevision` or
    `notesRevision` moves in the Swarm read; history when History opens; one revision's text when it is picked. Nothing
    is read on a poll. A move while the draft is unchanged replaces the text silently; with unsaved changes it is
    treated as a stale save (decision 3). Cost: none.
17. *The panel is a dialog* in the Swarm's details frame (`SuperTabDetailDialog`, 720 wide), opened from the project
    ⋮ menu's existing Instructions item as today's Instructions dialog is. The frame clamps to the window, so the web's
    phone-width layout gets the same panel. Cost: the chat is covered while it is open.

**Phase 4 assumptions** (the draft at `.superpowers/sdd/…/phase-4-plan-draft.md`; confirm when phase 4 lands): decision 1
(`agent_create` keeps `lead|dev|review|buddy`); 2 (`roleId` names an older client's agent); 3 (old saves accepted,
`ignored: true` with a note); 9 (checks recorded by anyone, `independent` stored and unread); 12 (route records carry
`instructionsRevision`, and `GET …/route-decisions/:id` returns it in `record`); 14 (`GET /api/super-tabs/:tabId/
routing-policy` answers `{ policy, …, catalog: { models: [{ engine, model, effort, strength, cost, offered, note? }],
grid, priors, prices } }`); task 1 (`leadAction` records any agent's `{ kind, at }`, with no actor).

**Shared names:**
- Copy pair `desktop/lib/super_tabs/instructions_model.dart` ⇄ `mobile/lib/swarm/instructions_model.dart` (no imports
  but `dart:convert`): `kInstructionsMaxBytes = 65536`, `kInstructionsSummaryMax = 200`;
  `class SuperTabNote { id, text, askedBy; DateTime at; DateTime? expiresAt }`;
  `class SuperTabInstructions { projectId; int revision; String? hash; text; bool template; coordinatorName; int notesRevision; List<SuperTabNote> notes }`;
  `class SuperTabRevision { int revision; String? hash; String summary; ({String kind, String id}) writtenBy; String? askedBy; DateTime at; String? text }`
  (each with `fromJson(Map<String, dynamic>)`); `String superTabInstructionsPath(String tabId, String projectId, {bool revisions = false, int? revision})`;
  `List<String> superTabInstructionRoleNames(String text)`; `bool superTabMissingRoute(String code, int statusCode)`.
- Both models: `SuperTabProject.coordinatorName` (`String?`), `.instructionsRevision` (`int`, 0), `.notesRevision`
  (`int`, 0), `bool get hasInstructions`; `SuperTabAgent.roleName` (`String?`). Desktop gains `projectById` (the phone
  has it).
- Both models (tasks 6 and 7): `const kDefaultCoordinatorName = 'Product Manager'`; `String superTabRoleBadge(String
  roleName)`; `SuperTabSnapshot.roleOf(String agentId) → ({String name, String badge})?`;
  `SuperTabSnapshot.coordinatorNameOf(String projectId) → String`.
- `desktop/lib/super_tabs/instructions_panel.dart`: `Future<void> showSuperTabInstructions(BuildContext context, SuperTabController c, String projectId)`.
- Copy pair `desktop/lib/super_tabs/linked_tasks.dart` ⇄ `mobile/lib/swarm/linked_tasks.dart` (imports `model.dart`):
  `String? superTabLinkedLine(SuperTabSnapshot snapshot, SuperTabConversation group)`.
- `HarnessLaunchIntegration.roleSuggestions` (`List<String>?`, null hides the field) and `.roleName` (`String?`).
- `mobile/lib/swarm/swarm_instructions_page.dart`: `SwarmInstructionsPage({required SwarmReader reader, required String projectId})`.

**Review focus (phase 5):**
- A viewer opens Instructions: reads the document and the notes, has no Save, no Restore and no Delete. (Tasks 2 and 3.)
- Two members save on the same revision: the second keeps their draft, sees the first one's text, and saves on the new
  revision; nothing is lost silently. (Task 2.)
- An older backend: no Instructions item, no role field, and no `roleName` key in `agent.add` (its strict schema would
  refuse the join). (Tasks 2 and 5.)
- A document of exactly 65,536 bytes saves; one byte more disables Save with a line saying why. (Task 2.)
- The web build: the three instructions reads pass the transport's allow-list; the routes dropped from it are refused
  before anything is sent. (Task 1.)

### Task 1: The instructions model, both platforms, and the web's routes

**Files:**
- Create: `desktop/lib/super_tabs/instructions_model.dart`, `mobile/lib/swarm/instructions_model.dart` (byte-identical)
- Modify: `desktop/lib/super_tabs/model.dart` (`SuperTabAgent` ~114-170: `roleName`; `SuperTabProject` ~321-353: the
  three fields and `hasInstructions`; `SuperTabSnapshot`: `projectById`)
- Modify: `mobile/lib/swarm/model.dart` (`SuperTabAgent` ~114, `SuperTabProject` ~357: the same fields)
- Modify: `desktop/lib/super_tabs/backend_transport.dart` (`_swarmRoute` ~13-25)
- Modify: `mobile/test/swarm/desktop_parity_test.dart` (`_copies`: the new pair)
- Test: create `desktop/test/super_tab_instructions_model_test.dart`; `desktop/test/super_tab_backend_transport_test.dart`

**Interfaces:** Produces everything under Shared names' first two bullets. `fromJson` reads phase 2's answers
(`store.ts` `instructions`, `instructionRevisions`, `instructionRevision`): `at`/`expiresAt` are ISO strings,
`writtenBy` is `{ kind: 'person' | 'agent' | 'system', id }`, `notes` is absent for a Buddy (read as empty).
`superTabInstructionsPath` encodes both ids (`/api/super-tabs/<tab>/projects/<project>/instructions`, `/revisions`,
`/revisions/<n>`). `superTabMissingRoute(code, status)` is `status == 404 && code != 'NOT_FOUND'`.

- [ ] **Step 1: Failing tests**
  - `super_tab_instructions_model_test` `reads the document, its notes and its revisions`: a phase 2 answer with
    revision 3, `template: false`, two notes (one with `expiresAt`) → the fields; one without `notes` → `notes` empty;
    a revisions answer → three `SuperTabRevision`s newest first with `writtenBy.kind` `person`, `agent`, `system`.
  - `finds the role headings of the Roles section`: `INSTRUCTIONS_TEMPLATE`'s shape (`## Roles` with `### PM`,
    `### Engineer`, `### Reviewer`, `### Tester`, then `## Workflow` with a `### Step`) → `['PM', 'Engineer',
    'Reviewer', 'Tester']`; a heading repeated in another case is listed once; a heading over 40 characters is left
    out; no `## Roles` section → `[]`; `## roles` matches.
  - `names the reads`: `superTabInstructionsPath('t 1', 'p1', revision: 4)` →
    `/api/super-tabs/t%201/projects/p1/instructions/revisions/4`; `superTabMissingRoute('BACKEND_UNAVAILABLE', 404)`
    true, `('NOT_FOUND', 404)` false, `('INSTRUCTIONS_UNAVAILABLE', 503)` false.
  - `reads the project's instructions fields and the agent's role name`: a `SuperTabSnapshot` from a parts read whose
    project has `coordinatorName: 'Coordinator'`, `instructionsRevision: 7`, `notesRevision: 2` and whose derived agent
    has `roleName: 'Tester'` → those values, `hasInstructions` true; a project without them → null, 0, 0, false.
  - `super_tab_backend_transport_test` `every Swarm route the web uses goes to the backend`: add
    `GET …/projects/p1/instructions`, `…/instructions/revisions`, `…/instructions/revisions/4`; remove
    `/api/super-tabs/routing-policy` (both methods) and `…/projects/p1/roles/r1` from it and add them to the refused list.
- [ ] **Step 2: Run** `cd desktop && <flutter> test test/super_tab_instructions_model_test.dart test/super_tab_backend_transport_test.dart`
  → FAIL (missing library; routes refused); `cd mobile && <flutter> test test/swarm/desktop_parity_test.dart` → FAIL
  once the pair is listed (phone copy missing).
- [ ] **Step 3: Implement** the model file, copy it byte for byte to the phone, add the fields to both models and the
  routes to `_swarmRoute` (`projects/$_id/(?:github|github/approve|instructions(?:/revisions(?:/[0-9]+)?)?)`; the
  account `/routing-policy` alternative goes).
- [ ] **Step 4: Run** the same → PASS; also `cd mobile && <flutter> test test/swarm/swarm_model_lookups_test.dart`.
- [ ] **Step 5: Commit** — "Desktop and phone: read a project's instructions, notes and history, and the web may ask
  for them (project instructions, phase 5, task 1)".

### Task 2: The Instructions panel: the document, for every member

Replaces the "Instructions for this project" dialog (skill set picker, Create custom set, Edit custom roles) and the
custom roles editor.

**Files:**
- Create: `desktop/lib/super_tabs/instructions_panel.dart`
- Modify: `desktop/lib/super_tabs/view.dart` (`_groupAction` ~1192: `'instructions'` opens the panel before the
  project-lead branch; `_options` ~2187-2193: `Instructions` for every member when `project.hasInstructions`, not only
  an editable owner)
- Modify: `desktop/lib/super_tabs/project_options.dart` (delete the `'skills'` action: `mode` ~104, title ~119, body
  ~205-290, Save's guard ~312-314 and type ~325-335, the `roles_editor.dart` import)
- Delete: `desktop/lib/super_tabs/roles_editor.dart`, `desktop/test/super_tab_project_skills_test.dart`
- Modify: `desktop/test/support/super_tab_fixture.dart` (`ConversationServer`: instructions reads and commands)
- Modify: `scripts/ui-style-allowlist/desktop.json` (`--update`: `roles_editor.dart` and `project_options.dart` fall)
- Test: create `desktop/test/super_tab_instructions_test.dart`

**Interfaces:**
- Consumes: task 1's model, paths and `superTabMissingRoute`; `SuperTabController.request`, `command`,
  `operationErrorCode`, `canWrite`, `saving`, `hasPendingAction`; `SuperTabDetailDialog`, `SuperTabDialogScope`
  (`requireWrite: false`).
- Produces: `showSuperTabInstructions`; keys `super-instructions-editor`, `super-instructions-summary`,
  `super-instructions-save`, `super-instructions-theirs`; the fixture's `ConversationServer.instructions`
  (`Map<String, Map<String, dynamic>>` by project id, the GET answer), `.instructionRevisions` (by project id, newest
  first, each with `text`), `.instructionsRoute` (`bool`, default true; false answers GETs with
  `SuperTabFailure('BACKEND_UNAVAILABLE', 'Not Found', statusCode: 404)`). Its `instructions.save` bumps the project's
  `instructionsRevision` in `state`, stores the text and a revision, and refuses a stale base with
  `SuperTabFailure('INSTRUCTIONS_STALE', …, statusCode: 409)`; `note.remove` drops the note and bumps `notesRevision`.

**Mockups** (frame: `SuperTabDetailDialog`, 720 wide, clamped by the window; real menu: `view.dart` `_options`):

```
Project ⋮ menu, a collaborator          Today                      After
                                        Project details            Project details
                                        Update cadence             Instructions
                                        Swarm routing              Update cadence
                                        Archived conversations     Archived conversations
(The owner's menu keeps Rename project, Sharing and Delete Project; Instructions stays where it is.)

┌ Instructions ─────────────────────────────────────────────────────────── ✕ ┐
│ Revision 7                                                                  │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ ## Roles                                                     (mono,     │ │
│ │                                                               scrolls   │ │
│ │ ### PM                                                        inside)   │ │
│ │ - Talks with people in the project chat and finds out what they want.   │ │
│ │ …                                                                       │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│ ┌ What changed ───────────────────────────────────────────────────────────┐ │
│ │ Reviews run on Opus                                                     │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│ (task 3: notes here)                                                        │
│ [History]                                                  [Cancel] [Save]  │
└─────────────────────────────────────────────────────────────────────────────┘

After a stale save, the same frame:
│ Revision 8 was saved while you edited. Merge what it says into your text,   │
│ then save again.                                                            │
│ ┌ your draft (editor) ───────────────────────────────────────────────────┐  │
│ Revision 8, as saved                                                        │
│ ┌ their text, read only, selectable ─────────────────────────────────────┐  │
```

Copy: title `Instructions`; detail `Revision N`, or `Built-in template` at revision 0; summary field `What changed`
(one line, at most 200 characters); a viewer gets a read-only editor and `Close`; over the limit
`Instructions are limited to 64 KB.`; a missing route `This Swarm has no project instructions yet.`; a failed read its
message and `Try again`; closing with unsaved changes asks `Discard your changes to the instructions?`
(`Keep editing` / `Discard`).

- [ ] **Step 1: Failing tests** (`super_tab_instructions_test.dart`; the project fixture gains
  `coordinatorName: 'Product Manager'`, `instructionsRevision: 3`; accounts `owner`, `peer` (collaborator), `viewer`)
  - `shows Instructions to every member and opens the document`: as `peer` and as `viewer`, the project ⋮ menu has
    `Instructions`; opening it reads `…/projects/lead/instructions` once and shows the text in the editor and
    `Revision 3`.
  - `a member who is not the owner saves a change with its summary`: as `peer`, edit the text, type `Reviews run on
    Opus`, tap Save → the last posted command is exactly `{type: instructions.save, projectId: lead, baseRevision: 3,
    text: <edited>, summary: 'Reviews run on Opus'}` (no `askedBy`); the panel then shows `Revision 4` and an empty
    summary; the Swarm read's project has `instructionsRevision` 4.
  - `Save waits for a change, a summary and the 64 KB limit`: unchanged text → Save disabled; changed with an empty
    summary → disabled; a 65,536-byte text → enabled; 65,537 bytes → disabled and the 64 KB line shows.
  - `a stale save keeps the draft and shows the newer text to merge`: the server moves to revision 4 (`Their line`)
    before Save → after Save, the merge line and `super-instructions-theirs` holding `Their line`, the editor still
    holding the draft; the next Save sends `baseRevision: 4`.
  - `a revision saved elsewhere replaces an unchanged draft`: with the panel open and nothing edited, the server saves
    revision 4 and the controller refreshes → the editor shows revision 4's text, no merge line.
  - `a viewer reads and cannot save`: as `viewer` the editor is read-only, there is no Save and no summary field.
  - `an older Swarm shows no Instructions`: a project without `coordinatorName` → no `Instructions` item;
    `showSuperTabInstructions` with `instructionsRoute = false` → `This Swarm has no project instructions yet.`
  - `closing with unsaved changes asks first`: edit, tap ✕ → the question; `Keep editing` keeps the panel and the
    draft; `Discard` closes it.
  - `the skill set picker and the roles editor are gone`: as `owner`, the panel shows none of
    `Default — the team process`, `Create custom set`, `Edit custom roles`.
- [ ] **Step 2: Run** `cd desktop && <flutter> test test/super_tab_instructions_test.dart` → FAIL (no panel; collaborator
  sees no Instructions).
- [ ] **Step 3: Implement** the panel (decisions 2, 3 and 16), the menu, the fixture; delete the old dialog branch, the
  roles editor and its test file; `python3 scripts/check-ui-style.py --update`.
- [ ] **Step 4: Run** `cd desktop && <flutter> test test/super_tab_instructions_test.dart test/super_tab_view_test.dart`
  plus every file `grep -rln "Instructions\|roles_editor\|project.skills\|showProjectAction" desktop/test` finds →
  PASS; `python3 scripts/check-ui-style.py` → PASS.
- [ ] **Step 5: Commit** — "Desktop: every member reads and edits the project's instructions in one panel; the skill
  set picker and the roles editor go (project instructions, phase 5, task 2)".

### Task 3: The panel's history and the coordinator's notes

**Files:**
- Modify: `desktop/lib/super_tabs/instructions_panel.dart`
- Test: `desktop/test/super_tab_instructions_test.dart`

**Interfaces:** Consumes task 2's panel and fixture (`instructionRevisions`, notes in `instructions[...]['notes']`),
`relativeAgo` (`core/relative_time.dart`), `SuperTabSnapshot.agentName`, the people's `username`. Produces keys
`super-revision-<n>`, `super-revision-text`, `super-restore`, `super-note-<id>`, `super-note-delete-<id>`.

**Mockups:**

```
┌ Instructions › History ───────────────────────────────────────────────── ✕ ┐
│ Revision 8   dee · 2 h ago · Reviews run on Opus.                     (lit) │
│ Revision 7   Product Manager for ken · yesterday · Tester runs on the Mac.  │
│ Revision 1   Harness · Oct 30 · From the project's roles and rules.         │
│ ─────────────────────────────────────────────────────────────────────────── │
│ Revision 7                                                                  │
│ ┌ its text, read only, selectable ───────────────────────────────────────┐  │
│ [Back to the instructions]                          [Restore revision 7]    │
└─────────────────────────────────────────────────────────────────────────────┘

Under the summary field, in the document view:
│ Product Manager's notes                                                     │
│ Don't use Codex on machine A                                       [Delete] │
│ asked by ken · 3 h ago · until 18:00                                        │
│ Prefer Kimi K3 for docs                                            [Delete] │
│ asked by dee · yesterday                                                    │
```

Who wrote a revision: a person by username (`for <asker>` when `askedBy` is someone else); an agent by its name, or
the coordinator's name when it is gone, then `for <asker>`; `system` as `Harness`. Notes newest first;
`asked by <username> · <ago>` and ` · until <local time>` when it ends; `No notes.` when there are none.

- [ ] **Step 1: Failing tests**
  - `History lists revisions newest first with who, when and what changed`: revisions 8 (person `dee`), 7 (agent the
    coordinator, `askedBy` `ken`), 1 (`system`) → three rows in that order reading as in the mockup; one read of
    `…/instructions/revisions`.
  - `a past revision opens read only, and Restore puts it in the editor`: tap revision 7 → one read of
    `…/revisions/7`, its text in `super-revision-text`; tap Restore → the document view with the editor holding
    revision 7's text and the summary `Restored revision 7.`; nothing posted until Save, which sends the current base.
  - `a viewer has no Restore`.
  - `a failed history read says so and reads again`: the first read throws → `Could not read the history.` and
    `Try again`, which reads once more.
  - `notes show under the document with who asked and when`: two notes → the rows above, newest first; none →
    `No notes.`; with `coordinatorName: 'Coordinator'` the heading is `Coordinator's notes`.
  - `a member deletes a note`: as `peer`, tap Delete on one → the posted command is `{type: note.remove, projectId:
    lead, noteId: n1}`; after the read the row is gone; a viewer has no Delete.
- [ ] **Step 2: Run** `cd desktop && <flutter> test test/super_tab_instructions_test.dart` → FAIL.
- [ ] **Step 3: Implement** (decision 4; the notes re-read on a `notesRevision` move never touches the draft).
- [ ] **Step 4: Run** the file → PASS; `python3 scripts/check-ui-style.py` → PASS.
- [ ] **Step 5: Commit** — "Desktop: the instructions' history, any revision to read and restore, and the
  coordinator's notes to read and delete (project instructions, phase 5, task 3)".

### Task 4: Routing settings removed

**Files:**
- Delete: `desktop/lib/super_tabs/routing_policy_form.dart`, `desktop/lib/super_tabs/routing_policy.dart`,
  `desktop/lib/settings/sections/routing_section.dart`, `desktop/test/routing_policy_test.dart`
- Modify: `desktop/lib/super_tabs/route_row.dart` (delete `showSuperTabRouting` and `_RoutingDialog` ~198-end and their
  imports), `desktop/lib/super_tabs/view.dart` (`_groupAction` ~1194-1197 `'routing'`; `_options` ~2196 `Swarm routing`)
- Modify: `desktop/lib/settings/settings_section.dart` (`routing` ~41-45, the Agents group entry ~147-148),
  `desktop/lib/settings/settings_body.dart` (~13, ~51)
- Modify: `scripts/ui-style-allowlist/desktop.json` (`--update`)
- Test: `desktop/test/settings_section_test.dart` (~41, ~68), `desktop/test/super_tab_instructions_test.dart`

**Mockup** (Settings rail, `settings_section.dart` groups): `Agents` lists `Connectors`, `Usage`; `Routing` is gone. The
project ⋮ menu has no `Swarm routing` for anyone (task 2's mockup).

- [ ] **Step 1: Failing tests**: `settings_section_test` both lists drop `SettingsSection.routing` (the Agents group is
  `[connectors (not web), usage]`); `super_tab_instructions_test` `the project menu has no Swarm routing` (owner and
  collaborator).
- [ ] **Step 2: Run** `cd desktop && <flutter> test test/settings_section_test.dart test/super_tab_instructions_test.dart` → FAIL.
- [ ] **Step 3: Delete** the files and entries; `python3 scripts/check-ui-style.py --update`.
- [ ] **Step 4: Run** those files and every hit of `grep -rln "routing\|Routing" desktop/test` → PASS; `<flutter>
  analyze lib/settings lib/super_tabs/route_row.dart lib/super_tabs/view.dart` clean.
- [ ] **Step 5: Commit** — "Desktop: routing lives in the project's instructions; the routing form, Settings ▸ Routing
  and Swarm routing go (project instructions, phase 5, task 4)".

### Task 5: A free-text role when an agent starts

**Files:**
- Modify: `desktop/lib/state/harness_launch_integration.dart` (delete `HarnessLaunchRole` ~20-28, `roles`, `roleId`,
  `chooseRole` ~49-66; add `roleSuggestions`, `roleName`)
- Modify: `desktop/lib/super_tabs/launch.dart` (`open` ~68-79 and ~93-96: read the document instead of the custom
  role set; `swarmRole` ~141-144 and ~191-195: `lead` or `dev`; `prepare` ~173-182: saves `roleName`; `_prepare`
  ~832-848: the role check goes; the join command ~929-936: `roleName`)
- Modify: `desktop/lib/widgets/new_harness_form.dart` (`_desktopStartEnabled` ~96-99: no role gate; the Role dropdown
  ~2575-2614 → the field)
- Test: `desktop/test/super_tab_launch_test.dart` (replace the custom-role tests ~2355-2616)

**Interfaces:** Consumes task 1's `superTabInstructionRoleNames`, `superTabInstructionsPath`,
`SuperTabProject.hasInstructions`, `SuperTabAgent.roleName`, task 2's fixture. Produces `roleSuggestions` (null for
the coordinator's own start, a new project, or an older backend; `[]` when the read fails) and `roleName` (trimmed;
empty is null), saved in the journal as `saved['roleName']` and sent as `agent.add` `roleName` only when set. The field
is a `RawAutocomplete<String>` with key `new-harness-role`, label `Role`, hint `Engineer`, at most 40 characters; its
options are `AppMenuItem` rows, filtered by what is typed (case-insensitive), all of them on focus.

**Mockup** (the launch actions row, `_desktopLaunchActions`):

```
Today (custom role sets only)              After (every agent joining a project that has instructions)
            ┌ Role ─────────┐                         ┌ Role ─────────┐
            │ Engineer    ▾ │  [ Start ]              │ Tes|          │  [ Start ]
            └───────────────┘                         ├───────────────┤
                                                      │ Tester        │  ← the document's role headings
                                                      └───────────────┘    (Engineer, Reviewer, Tester), filtered
```

- [ ] **Step 1: Failing tests**
  - `an agent joining a project takes the role typed`: project with `coordinatorName`, instructions text the template's
    shape → `roleSuggestions` `['Engineer', 'Reviewer', 'Tester']` (the coordinator's `PM` left out); `roleName =
    'Tester'` → the join's `command['roleName'] == 'Tester'`; `agent_create`'s `swarmRole` is `dev` and its keys equal
    today's list (written out in the test).
  - `an empty role sends none`: no `roleName` key in the join.
  - `an older Swarm gets no role field and no roleName`: project without `coordinatorName` → `roleSuggestions` null, no
    instructions read, no `roleName` key; the form shows no `new-harness-role`.
  - `a failed instructions read leaves the field free`: the read throws → `roleSuggestions` `[]`, the field shows and
    takes `Designer`.
  - `the role field offers the document's roles and takes any text` (widget): focusing it lists the three; typing `Te`
    leaves `Tester`; choosing it sets `roleName`; Start is enabled with the field empty.
  - `a recovered launch keeps its role`: a journal with `phase: 'joining'` and `roleName: 'Tester'` → the field shows
    `Tester` and the join sends it; a journal with an older `roleId` still sends `roleId`.
  - `the coordinator's start is lead`: New Project's start → `swarmRole: 'lead'`, no field.
- [ ] **Step 2: Run** `cd desktop && <flutter> test test/super_tab_launch_test.dart` → FAIL.
- [ ] **Step 3: Implement** (decisions 6 and 7).
- [ ] **Step 4: Run** the file and every hit of `grep -rln "HarnessLaunchRole\|chooseRole\|roleKind\|new-harness-role\|swarmRole" desktop/test`
  → PASS.
- [ ] **Step 5: Commit** — "Desktop: an agent starts in any role typed, with the project's roles offered (project
  instructions, phase 5, task 5)".

### Task 6: Desktop names agents by role and the coordinator by its project's name for it

**Files:**
- Modify: `desktop/lib/super_tabs/model.dart`: add `kDefaultCoordinatorName`, `superTabRoleBadge`, `roleOf`,
  `coordinatorNameOf`; `leadProtectionReason` ~517-521 uses `coordinatorNameOf`; delete `activeRoleForAgent`
  ~499-515, `SuperTabRole` ~303-320, `SuperTabProject.roles` and `.skillSet` (keep `skillMode`: decision 6)
- Modify (labels and badges → `roleOf`): `roster.dart` ~338-352, `machines.dart` ~2012-2026, `agent_details.dart`
  ~296-302
- Modify (copy → `coordinatorNameOf`): `view.dart` ~234 (`(<coordinator's badge>) → you`), ~2983
  (`Discuss the plan with <name>.`), ~2985 (`say 'send to the <name>' when it's ready`); `agent_group_picker.dart`
  ~126; `decisions_view.dart` ~190 (`<name> decided`), ~241 (`Let <name> decide`); `project_options.dart` ~62 (the
  row's label), ~180 (`<name> gathers new task reports while work is active.`), ~400 (`Its <name>'s session…`);
  `machines.dart` ~1485, ~1537 (`The open task “X” loses its agent.`), ~2169 (`Add a machine for this
  Swarm's agents to use.`); `workspace.dart` ~491; `buddies.dart` ~205
- Modify: `task_status.dart` ~82-84: `assign` → `Reassigned`, `route` → `Routed again`, `start` → `Starting another
  agent`, `post` → `Answered` (facts: any agent may act now)
- Test: create `desktop/test/super_tab_role_names_test.dart`; `super_tab_roster_test.dart`,
  `super_tab_decisions_test.dart`, `super_tab_task_status_test.dart`, `super_tab_buddies_test.dart`,
  `super_tab_sidebar_test.dart`, `support/super_tab_fixture.dart` (its copy line)

**Interfaces:** Consumes task 1's fields. `superTabRoleBadge(name)`: the name when 12 characters or fewer, else its
first 11 characters and `…`. `roleOf(id)`: null for an unknown agent or a Buddy; with `roleName` →
`(name: roleName, badge: superTabRoleBadge(roleName))`; without (older backend) today's pairs
(`Product Manager`/`PM` for a coordinator, `Reviewer`/`Rev` for `role: 'reviewer'`, `Engineer`/`Dev`).
`coordinatorNameOf(projectId)`: the project's `coordinatorName`, else `kDefaultCoordinatorName`.

**Mockup** (members pane row, `roster.dart` `_agentIdentity`): `Ivy  [Rev]  lamp-os` → `Ivy  [Tester]  lamp-os`;
`Atlas  [PM]` stays `[PM]` (the coordinator's role name in the template); hovering says `Ivy · Tester · lamp-os · …`.

- [ ] **Step 1: Failing tests**
  - `super_tab_role_names_test` `names an agent by its role and the coordinator by its project`: `roleName: 'Tester'`
    → `(Tester, Tester)`; `'Quality assurance lead'` → badge `Quality ass…`; no `roleName` → today's three pairs; a
    Buddy → null; `coordinatorName: 'Coordinator'` → `coordinatorNameOf` `Coordinator`, none → `Product Manager`.
  - `super_tab_roster_test` `shows the role an agent goes by`: a fixture agent with `roleName: 'Tester'` → its chip
    `Tester` and its tooltip `… · Tester · …`; agents without one keep `Dev`/`Rev`/`PM`.
  - `super_tab_decisions_test`: with `coordinatorName: 'Coordinator'`, a delegated decision reads `Coordinator decided:`
    and the button `Let Coordinator decide` (existing `PM decided` assertions become `Product Manager decided`).
  - `super_tab_task_status_test`: the four facts above replace `PM reassigned it`, `PM retrying`, `PM posted`.
  - The Buddy and sidebar copy tests take the new lines.
- [ ] **Step 2: Run** `cd desktop && <flutter> test test/super_tab_role_names_test.dart test/super_tab_roster_test.dart test/super_tab_decisions_test.dart test/super_tab_task_status_test.dart test/super_tab_buddies_test.dart test/super_tab_sidebar_test.dart`
  → FAIL.
- [ ] **Step 3: Implement** (decisions 8 and 9).
- [ ] **Step 4: Run** those and every hit of `grep -rln "activeRoleForAgent\|SuperTabRole\b\|skillSet\|Product Manager\|PM decided\|Let PM\|PM reassigned\|(PM) → you" desktop/test`
  → PASS; `python3 scripts/check-ui-style.py` → PASS.
- [ ] **Step 5: Commit** — "Desktop: agents show the role they go by, and copy calls the coordinator what its
  project calls it (project instructions, phase 5, task 6)".

### Task 7: The phone names agents by role and the coordinator by its project's name for it

**Files:**
- Modify: `mobile/lib/swarm/model.dart`: the same four names as task 6; `leadProtectionReason` ~573-577; delete
  `activeRoleForAgent` ~557-571, `SuperTabRole` ~339-356, `roles`, `skillSet`
- Modify: `swarm_conversation_page.dart` ~1163-1166 (`(<badge>) → you`), `swarmAgentRole` ~2176-2182 (`roleOf(id)?.badge`),
  ~2481 (`pm:`); `swarm_message_row.dart` ~389 and `swarm_thread_line.dart` ~56: `pm:` is
  `snapshot.isLead(authorId)`, never the label; `swarm_project_page.dart` ~1002-1008; `swarm_machines.dart` ~300-306;
  `swarm_task_status.dart` ~129-131 (task 6's four facts, word for word)
- Test: create `mobile/test/swarm/swarm_role_names_test.dart`; `swarm_chat_test.dart`, `swarm_thread_line_faces_test.dart`,
  `swarm_task_status_test.dart`, `swarm_task_rows_test.dart`, `swarm_buddy_chat_test.dart`, `swarm_machines_test.dart`,
  `desktop_parity_test.dart`

**Interfaces:** Consumes task 1's fields; must run after task 6 (the parity test compares the models' reads).

- [ ] **Step 1: Failing tests**
  - `swarm_role_names_test`: the same cases as task 6's model test, on the phone's model.
  - `swarm_thread_line_faces_test` `keeps the coordinator's face whatever its role is called`: a coordinator with
    `roleName: 'Coordinator'` → `SwarmChatAvatar.pm` true and the badge `Coordinator`; a non-coordinator with
    `roleName: 'PM'` → `pm` false.
  - `swarm_chat_test`: a Tester's message header shows `Tester`.
  - `swarm_task_status_test` / `swarm_task_rows_test`: the four facts.
- [ ] **Step 2: Run** `cd mobile && <flutter> test test/swarm/swarm_role_names_test.dart test/swarm/swarm_thread_line_faces_test.dart test/swarm/swarm_chat_test.dart test/swarm/swarm_task_status_test.dart test/swarm/swarm_task_rows_test.dart`
  → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** those, `test/swarm/desktop_parity_test.dart`, and every hit of `grep -rln "'PM'\|'Rev'\|'Dev'\|activeRoleForAgent\|PM reassigned" mobile/test`
  → PASS.
- [ ] **Step 5: Commit** — "Phone: agents show the role they go by, and the coordinator keeps its face whatever it is
  called (project instructions, phase 5, task 7)".

### Task 8: Reviews are a task's linked tasks, on both platforms

**Files:**
- Create: `desktop/lib/super_tabs/linked_tasks.dart`, `mobile/lib/swarm/linked_tasks.dart` (byte-identical)
- Delete: `desktop/lib/super_tabs/review_verdict.dart`, `mobile/lib/swarm/review_verdict.dart`
- Modify: `desktop/lib/super_tabs/controller.dart` (`reviewLine` ~1383-1420 → `linkedLine(group)`, delegating);
  `live_card.dart` ~92, `work_details.dart` ~63, `view.dart` ~1983 (key `super-linked-line`)
- Modify: both `model.dart`: delete `reviewers()` and `isReviewer`
- Modify: `mobile/lib/swarm/swarm_live_card_facts.dart` (`swarmReviewLine` ~22-66 goes; `SwarmCardFacts.review` from
  `superTabLinkedLine`; parameters left unused go)
- Modify ("Waiting on others" for the `review` status, with the agent's note where the row shows one): desktop
  `live_card.dart` ~18, `task_status.dart` ~96, `agent_details.dart` ~152-155; phone `swarm_live_card_facts.dart` ~14,
  `swarm_task_status.dart` ~146, `swarm_project_team.dart` ~120, `team_glance.dart` ~173
- Modify: `desktop/lib/super_tabs/work_details.dart` (~41-61: the brief as written, never the five sections; empty:
  `This task has no description yet.`; ~82-83: `Requires an independent check.` goes)
- Modify: `mobile/test/swarm/desktop_parity_test.dart` (`_copies`: the `review_verdict.dart` pair out, `linked_tasks.dart` in)
- Test: rewrite `desktop/test/super_tab_review_test.dart`; `super_tab_live_card_test.dart`,
  `super_tab_work_details_test.dart`, `super_tab_task_status_test.dart`; `mobile/test/swarm/swarm_live_card_test.dart`,
  `swarm_task_status_test.dart`, `swarm_project_team_test.dart`, `team_glance_test.dart`

**Interfaces:** `superTabLinkedLine(snapshot, group)`: the conversations with `reviewOf == group.id`, of
`group.projectId`, `kind == null`, lowest number first, each `${linked.label}: ${state}`, joined by ` · `; null when
there are none. `state`: no checks → `superTabWorkStatusLabel(assignment status)` or `not started`; any failed (evidence
set, `passedBy` null) → `1 check failed` / `N checks failed`; all passed → `passed`; else `P of N checks passed`.

**Mockup** (chat header subtitle, `view.dart` `_subtitle`, and the live card's last line):
`Reviewer: Ivy · Ready: yes on 1a2b3c4d5` → `#14 Review PR 12: passed · #15 Test PR 12: 1 check failed`.

- [ ] **Step 1: Failing tests**
  - `super_tab_review_test` `lists a task's linked tasks with their checks' results`: task 12 with linked 14 (one check
    passed) and 15 (two checks, one failed) → the mockup's line in `super-linked-line`; a linked task of another
    project or a Buddy chat naming it → left out; no linked task → no line; an agent's `Ready: yes` message in the chat
    changes nothing.
  - `work details repeat the linked line and show the brief as written`: a five-part brief reads as its text;
    `Requires an independent check.` is nowhere.
  - `super_tab_live_card_test` / `swarm_live_card_test`: the card's last line is the linked line (the `Reviewer: Ivy ·
    Ready: …` expectations go).
  - The status tests on both: `review` reads `Waiting on others`.
- [ ] **Step 2: Run** `cd desktop && <flutter> test test/super_tab_review_test.dart test/super_tab_live_card_test.dart test/super_tab_work_details_test.dart test/super_tab_task_status_test.dart`
  and `cd mobile && <flutter> test test/swarm/swarm_live_card_test.dart test/swarm/swarm_task_status_test.dart test/swarm/swarm_project_team_test.dart test/swarm/team_glance_test.dart test/swarm/desktop_parity_test.dart`
  → FAIL.
- [ ] **Step 3: Implement** (decision 12).
- [ ] **Step 4: Run** those and every hit of `grep -rln "reviewLine\|swarmReviewLine\|parseSuperTabVerdict\|isReviewer\|reviewers(\|In review\|Waiting for review\|independent check" desktop/test mobile/test`
  → PASS; `python3 scripts/check-ui-style.py` → PASS.
- [ ] **Step 5: Commit** — "Desktop and phone: a task shows its linked tasks and their checks, not reviewers by kind
  (project instructions, phase 5, task 8)".

### Task 9: Routing in the clients is information

**Files:**
- Modify: `desktop/lib/super_tabs/route_row.dart` (`_how` ~49-57: `jev` → `Jev N%`, `only` → `Only available
  candidate`, otherwise `Ranked by strength, price and quota`; the floor chip ~129-137 and ~177-178 go; details add
  `Relied on instructions revision N`, or `Relied on the built-in instructions` for 0)
- Modify: `desktop/lib/super_tabs/model.dart` (`SuperTabRoute` ~737-785: `belowFloor` and `fallback` go)
- Modify: `desktop/lib/state/lead_placement.dart` (`_engineRefusal` ~136-138: the quota line goes; `LeadModelList.of`
  ~275 takes the read's whole answer: with `catalog`, an empty list)
- Modify: `desktop/lib/super_tabs/launch.dart` (`readRoutingPolicy` ~570-582 returns the answer; ~91)
- Modify: `desktop/lib/super_tabs/machines.dart` (~1094 and `_noQuotaLeft` ~2423-2425: `No quota left until it
  resets.` as information, never struck through)
- Modify: `desktop/lib/models/coding_model.dart` (`codingRefusal` ~29 → `codingNote`, same rule; text `… usually needs
  7B or more`, no "Builders"), `desktop/lib/state/swarm_search.dart` (~539-556: the `capable` gate goes),
  `desktop/lib/widgets/swarm_resource_preview.dart` (~1881-1887, ~2029, ~2033-2037, ~2082: facts about "agents in this
  Swarm", the note without "Not offered to Builders"), `desktop/lib/super_tabs/local_models.dart` (~204-205:
  `Agents in this Swarm can then run on them, at no subscription cost.`)
- Modify: `mobile/lib/swarm/swarm_new_project_sheet.dart` (`swarmLeadEngineRefusals` ~185-187: the quota line goes;
  `swarmLeadModelListRefusals` ~197 takes the answer: with `catalog`, none; the read ~1148-1155 passes the answer)
- Test: `desktop/test/super_tab_route_test.dart`, `super_tab_launch_test.dart` (~1294), `swarm_creation_form_test.dart`,
  `super_tab_machines_test.dart` (~2979), `coding_model_test.dart`, `swarm_search_test.dart`,
  `swarm_search_preview_test.dart`; `mobile/test/swarm/swarm_new_project_test.dart`

**Interfaces:** Consumes phase 4's catalog read and route record (Phase 4 assumptions). `codingNote(LocalModel) → String?`.

**Mockup** (a route row's details, `route_row.dart`):

```
Today                                         After
Routed to Ivy  Below quality floor  Details   Routed to Ivy  Details
  Ivy · Claude opus high · Mac Studio           Ivy · Claude opus high · Mac Studio
  Selection: Policy order (Jev unsure)          Selection: Ranked by strength, price and quota
  Quality floor 3                               Relied on instructions revision 7
  Policy notes applied                          Considered …
  Considered …
```

- [ ] **Step 1: Failing tests**
  - `super_tab_route_test` `shows what a route relied on, never floors`: a route with `belowFloor: true`,
    `fallback: 'unsure'` and a record with `floor: 3`, `notes: true`, `instructionsRevision: 7` → none of `Below
    quality floor`, `Policy order`, `Quality floor`, `Policy notes applied`; `Relied on instructions revision 7`; 0 →
    `Relied on the built-in instructions`; no field → no such line.
  - `swarm_creation_form_test` `New Project rules out no model when the Swarm sends its catalog`: an answer with
    `catalog` and a policy turning Codex off → Codex enabled, no refusal line; without `catalog` → today's refusal.
  - `super_tab_launch_test` ~1294 / `swarm_new_project_test`: a machine whose engine is at 100% stays startable on both
    platforms.
  - `super_tab_machines_test` ~2979: the engine row reads `No quota left until it resets.`, not struck.
  - `coding_model_test`: `codingNote` keeps the rule and its text has no `Builders`; `swarm_search_test`: a 3B local
    model offers `Get` and `Run for Swarm`, and its preview carries the note.
- [ ] **Step 2: Run** `cd desktop && <flutter> test test/super_tab_route_test.dart test/swarm_creation_form_test.dart test/super_tab_launch_test.dart test/super_tab_machines_test.dart test/coding_model_test.dart test/swarm_search_test.dart test/swarm_search_preview_test.dart`
  and `cd mobile && <flutter> test test/swarm/swarm_new_project_test.dart` → FAIL.
- [ ] **Step 3: Implement** (decisions 13 and 14).
- [ ] **Step 4: Run** those and every hit of `grep -rln "belowFloor\|codingRefusal\|no quota left\|LeadModelList\|swarmLeadModelListRefusals\|Policy order\|Builders" desktop/test mobile/test`
  → PASS; `python3 scripts/check-ui-style.py` → PASS (route_row's count falls: `--update`).
- [ ] **Step 5: Commit** — "Desktop and phone: routes, models and quota are information; nothing is refused for a
  floor, a model list or quota (project instructions, phase 5, task 9)".

### Task 10: The phone shows the instructions, read only

**Files:**
- Create: `mobile/lib/swarm/swarm_instructions_page.dart`
- Modify: `mobile/lib/swarm/swarm_project_team.dart` (after the Agents group ~460: an `Instructions` caption and one
  `SwarmRow`, only when `project.hasInstructions`)
- Test: create `mobile/test/swarm/swarm_instructions_page_test.dart`; `mobile/test/swarm/swarm_project_c_test.dart`

**Interfaces:** Consumes task 1's copy pair and fields, `SwarmReader.request`/`tabId`, `phoneRoute`, `swarmTextParts`
and `SwarmCodeBlock` (the chat's text and code), `core/relative_time.dart`. The page reads the document on open and
again when the project's `instructionsRevision` or `notesRevision` moves in the reader; pull to refresh reads again.
Keys `swarm-team-instructions` (the row), `swarm-instructions-text`, `swarm-instructions-note-<id>`.

**Mockups** (Team tab, Swarm Home C, `swarm_project_team.dart`; the page in `SwarmTopBar` with a back button):

```
Team tab                                 Instructions page
 TASKS · 2 working                        ‹  Instructions
  …                                          #lamp-os · revision 7
 HUMANS                                   ─────────────────────────────────
  …                                       ## Roles
 AGENTS · 2 working                       ### PM
  …                                       - Talks with people in the project
 INSTRUCTIONS                    ← new      chat and finds out what they want.
 ┌───────────────────────────────┐        …               (selectable)
 │ Instructions               ›  │
 │ Revision 7                    │        PRODUCT MANAGER'S NOTES
 └───────────────────────────────┘        Don't use Codex on machine A
                                          asked by ken · 3 h ago · until 18:00

                                          Change them in Harness on a computer,
                                          or ask Product Manager in the project
                                          chat.
```

Copy: the row's detail `Revision N`, or `Built-in template` at 0; notes heading `${coordinatorName}'s notes`, `No
notes.` when none; a missing route `This Swarm has no project instructions yet.`; a failed read its message and `Try
again`.

- [ ] **Step 1: Failing tests**
  - `swarm_project_c_test` `Team lists the instructions after the agents`: a project with `coordinatorName` and
    `instructionsRevision: 7` → `swarm-team-instructions` reading `Revision 7`, below the Agents caption; tapping it
    opens the page; a project without `coordinatorName` → no row.
  - `swarm_instructions_page_test` `shows the document and the notes, read only`: one read of `…/projects/p1/instructions`;
    the text in `swarm-instructions-text`, a fenced block as a code block; two notes newest first with who and when; no
    field, no button that writes; `No notes.` with none.
  - `shows the revision a member saved from Desktop` (the done check's phone half): open at revision 3; the next Swarm
    read moves the project to 4 and the route answers revision 4's text → the page shows it without reopening, after
    exactly one more read.
  - `a backend without instructions says so`: the route throws `SuperTabFailure('BACKEND_UNAVAILABLE', …, statusCode:
    404)` → the missing-route line; a 503 → its message and `Try again`.
- [ ] **Step 2: Run** `cd mobile && <flutter> test test/swarm/swarm_instructions_page_test.dart test/swarm/swarm_project_c_test.dart` → FAIL.
- [ ] **Step 3: Implement** (decision 15).
- [ ] **Step 4: Run** those, `test/swarm/swarm_project_team_test.dart` and `test/swarm/swarm_project_c_shots_test.dart`
  → PASS; `python3 scripts/check-ui-style.py` → PASS.
- [ ] **Step 5: Commit** — "Phone: a project's Team opens its instructions and the coordinator's notes, read only
  (project instructions, phase 5, task 10)".

### Phase 5 validation

Run once the ten tasks are in, from the worktree:
- Desktop: `cd desktop && <flutter> analyze` (whole package: files were deleted) and `make -C .. desktop-test` (the
  bounded VM suite; a broad change to `super_tabs`); compare any failure with a run of the same suite on the phase's
  base commit before calling it new.
- Phone: `cd mobile && <flutter> analyze` and `<flutter> test test/swarm test/phone/phone_shell_swarm_link_test.dart`.
- `python3 scripts/check-ui-style.py` → PASS, and its allowlists only shrank (`--against` the base branch).
- `grep -rn "Swarm routing\|routing_policy\|roles_editor\|activeRoleForAgent\|parseSuperTabVerdict\|belowFloor\|codingRefusal" desktop/lib mobile/lib`
  → nothing.
- Screenshots for the PR (design system UI checklist): the panel's document, merge and history views, the role field
  with its suggestions, a roster row with a role badge, the phone's Team row and page; light and dark, 200% text, an
  empty and a failed state each; through the existing capture helpers (`desktop/test/support/capture.dart`,
  the phone's `*_shots_test.dart`). Paste the UI checklist into the PR with what each item covered.
- Done when: task 2's `a member who is not the owner saves a change with its summary` and task 10's `shows the revision
  a member saved from Desktop` pass; then, after the release, an agent runs the check on a throwaway Swarm (the team's
  rule for checks needing the new backend), removed afterwards: a collaborator who is not the owner saves a change
  from Desktop; the phone, signed in as a member, shows the new revision's text and the project chat shows the save's
  line.
- Release: with phases 3 and 4, in that order: backend, CLI, then Desktop (`make release-desktop ARGS="--prepare"`
  from the final branch while checks run; merge and release only after they pass), then the phone per
  `mobile/RELEASE.md`. Phase 3's prerequisite stands: the migration runs in production, with the owner's go, before
  these clients ship.

## Phase 6: docs

Spec sections: the inventory's Docs list; Agents message each other; Server notices to the coordinator; The instruction
document; PM notes; Roles; Routing; The nightly routing reflection; Design; Order of work step 6. Docs only: no code, test or
script changes, and no change to a file outside `docs/`.

Phase 6 follows the release of phases 3-5 (or is written against their merged code), since it states what shipped. Each
task reads the merged code or the phase's Decisions ledger for facts and never invents a name; where a doc and the code
differ, the code wins and the task says so in its report.

Phase 6 is done when `docs/swarms.md` describes the instruction document, messaging and notices, and no section of it
still says the server enforces a role, a routing rule or a review rule; and every replaced plan carries a "Replaced by
2026-10-30-project-instructions-design.md" line (Task 3's greps).

**Decisions this phase makes (ledger them):**
1. *Extend, do not duplicate.* `docs/swarms.md` already has "Messages between agents" (phase 1) and "Instructions" (phase 2,
   with its Design checklist). Each is rewritten in place to state the shipped behavior and its "phase N" / "nothing reads
   them yet" wording removed. The new section is "Notices to the coordinator" only. Cost: none.
2. *The Routing section is rewritten to the new shape, not appended to.* The sections that describe enforcement (grid
   models, builds at the top tier, no Haiku/Sonnet by default, stepping up, reviews and their floors) are removed as rules;
   what survives is stated as advice and catalog data (Task 1 lists each). Cost: the 2026-10-30 owner rulings (Ken and Dee)
   are no longer in `swarms.md`; they live on in the template text and the catalog, and in the replaced plans.
3. *Plans are marked, not edited.* A replaced plan or spec gets one blockquote line under its title and nothing else
   changes, so history stays readable. Cost: none.
4. *Role words.* On screen the coordinator is the project's `coordinatorName` (default Product Manager); prose in
   `swarms.md` says "product manager" for the default and "coordinator" for the server concept, never "Lead" for the agent.
   "Lead" stays only in the Leads conversation and in quoted system names (`lead.start`, `leadChoices`, `lead` in the wire
   role). Cost: none.
5. *The `docs/naming-system.md` role table keeps its three rows* (Product Manager, Engineer, Reviewer) as the **template's**
   default roles, marked as defaults a project's document may rename or replace; the system names become `coordinator`,
   `agent`, `buddy` with the wire values noted. Cost: none.
6. *No link checker exists in the repo* (no `scripts/` or Makefile target; CI has no markdown link job). Each task checks
   the relative links it touches with the `ls` script in its verification step instead. Cost: none.

**Review focus (phase 6):**
- A doc still says the server refuses a start, assignment or pick on a quality floor, a grid-model rule, an owner rule or a
  role (`REVIEWER_NOT_LEAD`, `LEAD_REQUIRED`, `RULE_BROKEN`, `REVIEW_REFUSED`, `STEPPED_UP`, `BUILD_REFUSED`,
  `INDEPENDENT_REVIEW`, `REVIEWER_NOT_ASSIGNABLE`, `REVIEW_GROUP`). (Task 1 grep.)
- A doc names a command, field, code or file that does not exist in merged code (`rule.set` described as a feature, the
  `harness super-tab instructions` command misnamed, `COORDINATOR_REQUIRED`). (Each task's "names exist" step.)
- Old-client behavior is described as new-client behavior (an old Desktop's role-set or policy save is accepted and
  ignored, not applied). (Task 1.)
- The sentence "a notice period" or "delayed delivery of notices" survives: notices are delivered at once. (Task 1 grep.)
- A plan marked replaced is one the design says nothing about, or a replaced plan is missed (the spec's list is nine files
  plus two edits). (Task 3 greps.)

### Task 1: `docs/swarms.md` describes the instruction document, messaging, notices and routing as advice

**Files:** Modify `docs/swarms.md` only.

**What each section must say** (state facts in the present tense; keep each section's existing Design checklist, updated;
sections not listed are only swept for the words in Step 3):

- **Starting work** (lines ~11-36): the project's first agent is its coordinator; people usually work through it; the
  project menu has **Instructions** where it had "Swarm routing" (Desktop and web; the phone shows the document read-only).
  The lead's name is the project's `coordinatorName`.
- **People, agents and machines** (~38-170): an agent carries a role name chosen when it is started (free text, 40
  characters; empty is named by the server "Engineer"); the roster shows the role name; any agent of the project may create,
  assign and start tasks and agents (access and facts bind them: project membership, machine slots, the starts-pending cap);
  the settings of the Swarm (`tab.rename`, `tab.pause`, `project.report`, who coordinates) stay the coordinator's or a
  person's (`COORDINATOR_REQUIRED`). Remove "The lead's routing policy still determines eligible engines".
- **Buddies** (~190-340): a Buddy reads the document as its member's helper, never the history or the notes, and changes it
  only by asking the coordinator; its Swarm read shows no machines, starts or routing rows (as today, reword "routing
  rules").
- **Leaderboard** (~342-408) and **Cost records** (~500-575): review credit goes to whoever passes a check on another agent's
  task, whatever its role name; "the kind of job the Lead gave" reads "the coordinator gave".
- **Avatars, status and celebrations** (~575-628): role names and the coordinator's name as shown; the phone's coordinator
  avatar does not depend on the label.
- **Routing** (~410-498), rewritten whole, in this order:
  1. *Advice, not rules.* `harness super-tab route` ranks candidates for the coordinator, or whichever role the document
     gives routing to. It leaves out only facts (machine offline, removed or paused; engine signed out or suspended; a model
     the machine does not serve) and ranks the rest by strength, price, quota fit and idle agents. The document says what
     the project prefers; where it says nothing the route's order stands. A route decision records the document revision it
     relied on (server-stamped). A person or the coordinator may follow any candidate; overriding needs no reason.
  2. *The model catalog*: a reviewed, read-only list in the backend (`catalog.ts` `MODEL_CATALOG`) of each engine's models
     and offered efforts with a strength rating, served to the CLI in the tab's routing-policy read beside priors and
     prices. Name the default offered rows as the code has them (Opus high and xhigh, Codex default, GPT-6.1 Sol, Astra
     xhigh; Sonnet and Haiku listed, not offered). A model a member names that is not listed may still be started and
     is shown unrated. Grid models keep their built-in ratings as catalog data (Kimi K3 and DeepSeek v4.1 2; others 1).
     Adding a model is a data change. Point to `docs/benchmark-priors.md`.
  3. *What the server no longer does*: no floors for builds, reviews or grid models, no step-up and no cancelling of a
     Builder, no owner rules, no task requirements (`TaskRequirement` is stored, not enforced), no automatic review step. A
     failed first review on a grid model, a failed grid start and a failed start are notices to the coordinator with the
     failure, the model and the findings; the document's workflow says what happens next.
  4. *Old clients*: an old Desktop's or CLI's `rule.set` appends its words to the document's Routing section as a new
     revision (an agent's with no person behind it is refused `ASKED_BY_REQUIRED`); `rule.remove`, `tab.routingPolicy`,
     `project.skills` and `project.roles.*` are accepted, store nothing and answer `ignored: true` (phase 4 decision 3).
  5. *The nightly routing reflection*: proposals up to three; a Yes means the coordinator writes the approved change as one
     fixed Routing line in the document (announced like any save, `askedBy` the owner); the reflection reads the document
     and reports a proposal whose line is already there with how the last 7 days ran. The approved list, its nightly
     reminder and the lapsed-approval recall are gone (phase 4 decision 21).
  6. *Design* block: rewrite each line (Growth: catalog is code, route records one revision number; Concurrency: none new;
     Compatibility: old clients above; Migration and rollback: additive, old policy rows stay unread; Failure: a route that
     lists nothing says which fact removed each candidate; Platforms: CLI reads, server-side the same everywhere).
- **Messages between agents** (~643-682): keep the existing bullets and Design, and add: a post that names no one is never
  lost, it is posted and reaches the coordinator as a notice (the 10-29 alarm that reached no one for 4 h 50 min); a person's
  message is unchanged; the loop notice names the pair and holds nothing; the coordinator's unnamed posts to its assigned
  agent keep their bounce limit (`leadWorkerBounced` stays, phase 4 decision 23); the command is
  `harness super-tab post GROUP TEXT OPERATION_ID --to AGENT`, with the exact usage copied from `harness super-tab help`.
- **New section "Notices to the coordinator"**, placed right after "Messages between agents": what is a notice (a task's
  status change, a task lost or stalled, a failed start with the model asked for, a failed first review on a grid model, a
  terminal alert, a recording gap, an idle agent, a possible loop, an agent's post that named no one, a review-capacity
  note) and what is not (a person's message, a Buddy proposal, an agent's message that names the coordinator); delivered at
  once, there is no notice period; idle means in no task with active work for 15 minutes, reported once per idle spell,
  and the server stops no agent (the document says whether the coordinator stops or keeps it; `tab.tidy` governs only
  auto-archive); the update cadence and daily digest are unchanged; the 24-hour measurement (486 messages to the PM, 198
  copies, 63 notices) as the reason. Include a Design block.
- **Instructions** (~684-766), rewritten from "phase 2 adds the data" to the feature as shipped:
  1. *The document*: Markdown, 64 KB, one per project, free text; the template suggests Roles, Workflow and Routing with
     one heading per role (nothing parses them); it is what agents read, in two skills (**Harness tools** and **Project
     instructions**), which refresh within a roster pass of a save, with one notice per pass for the newest revision;
     `harness super-tab instructions [PROJECT]` and `route` print it with the PM's notes. An agent in no project and a
     backend without the route keep today's role file (`INSTRUCTIONS_UNAVAILABLE`).
  2. *Who changes it*: any member who can read the project edits it in the Instructions panel on Desktop and web, or asks
     the coordinator in the project chat or through their Buddy; the phone shows it read-only. A stale save is refused
     (`INSTRUCTIONS_STALE`) and the panel reads again and keeps the draft; Restore loads an old revision into the editor and
     Save writes it. Each save posts one line in the project chat. When a request contradicts the document the coordinator
     changes it, says so and tells the author of the replaced line.
  3. *Every project has a coordinator*, created with the project, never removable by the document; the document may rename
     it (`coordinatorName`, default "Product Manager") and say what it does. A document with no coordinator section leaves
     it running on the template's part.
  4. *Roles are names.* The server stores a role name, parses nothing and refuses nothing against the document; an agent
     whose role is not in the document says so to the coordinator. Its first start from New Project keeps the machine
     choice and the built-in model default.
  5. *PM's notes* (heading `${coordinatorName}'s notes` in the panel): the coordinator writes them freely, without chat line;
     every member sees them and can delete one; 1-300 characters, at most 100, expiring; the coordinator follows the newer
     of note and document; they are not in the instructions skill file.
  6. *The template* in one paragraph: what its Workflow does with no coordinator action between "ready" and "passed" (the
     agent whose work is ready opens its own linked review; a reviewer, not the agent that did the work, passes the verdict;
     test and review in parallel; idle Engineers stopped, Reviewers and Testers kept while the checked work is open).
  7. *Older projects*: keep the migration paragraph; add the release prerequisite (migration run before clients ship).
  8. *Design* block: keep and update (Compatibility now includes the old-client behaviors in Routing; Failure adds the
     panel's no-route message "This Swarm has no project instructions yet.").
- **Compatibility and rollout** (~820 on): add one entry per release note the phases left (the order backend, CLI, Desktop,
  phone; a new client on an older backend shows no Instructions and sends no `roleName`; an older CLI on a newer backend).

**Interfaces:** Consumes the merged names in phases 2-5 (copy them from the code, not from this plan): routes under
`/api/super-tabs/:tabId/projects/:projectId/instructions`, commands `instructions.save`, `note.add`, `note.remove`,
`project.coordinatorName`, codes `INSTRUCTIONS_STALE`, `INSTRUCTIONS_UNAVAILABLE`, `COORDINATOR_REQUIRED`,
`ASKED_BY_REQUIRED`, `INVALID_RECIPIENT`. Produces: the anchors `#instructions`, `#notices-to-the-coordinator`,
`#messages-between-agents`, `#routing`, which Task 2 links to.

- [ ] **Step 1: Names exist.** For every command, code, route, field and file named in the bullets above, grep it in
  `backend/src`, `cli/src` and `desktop/lib`; list any that is missing and use the merged name (or drop the sentence).
  Check `harness super-tab help` for the `post --to`, `instructions` and `route` usage.
- [ ] **Step 2: Write** the sections above. Keep the file's style (80-column wrap, `Design:` lists with the ten rule-1 lines
  from `docs/feature-design-rules.md`, each answered or "N/A because").
- [ ] **Step 3: Sweep greps** (each must print nothing, or only the lines this task keeps on purpose and lists in its report):
  `grep -n -E "quality floor|Below quality|step(s|ping)? up|forbidModel|noGridFirst|hard rule|soft rule|owner's rules|REVIEWER_NOT_LEAD|LEAD_REQUIRED|RULE_BROKEN|REVIEW_REFUSED|STEPPED_UP|BUILD_REFUSED|INDEPENDENT_REVIEW|REVIEWER_NOT_ASSIGNABLE|REVIEW_GROUP|never reviews it|rates? Sonnet|No Sonnet|No Haiku|Builds at the top tier" docs/swarms.md`;
  `grep -n -i -E "notice period|until phase|nothing reads them yet|work as before until" docs/swarms.md`;
  `grep -n -E "\bthe Lead\b|\blead's\b|project lead" docs/swarms.md` (remaining hits are only the Leads conversation,
  `lead.start`, `leadChoices` and wire names).
- [ ] **Step 4: Copy check** against `docs/naming-system.md`: `grep -n -E "\bBuilder\b|\bLead\b" docs/swarms.md` leaves only
  system names in code spans and the Leads conversation; user-visible names are Product Manager (or the project's name for
  it), Engineer, Reviewer, Instructions, workgroup.
- [ ] **Step 5: Links.** `grep -o -E "\]\([^)#]+\.(md|png)" docs/swarms.md | sed 's/](//' | sort -u` then `ls` each path
  relative to `docs/`; every one exists.
- [ ] **Step 6: Commit** `Docs: swarms.md describes the instruction document, messaging, notices and routing as advice (project instructions, phase 6, task 1)`

### Task 2: The other docs the inventory names

**Files:** Modify `docs/naming-system.md`, `docs/feature-design-rules.md`, `docs/benchmark-priors.md`,
`docs/pr-triage/roles.md`, `docs/specs/2026-10-30-buddy-read-access.md`.

- `docs/naming-system.md`: (a) the table row **Instructions** (line ~59): the visible name for a project's instruction
  document (and, on an older backend, its skill set); system name: instructions (skill: the two agent skills
  `swarm-tools` and `swarm-instructions`); example "Open Instructions; edit the Reviewer section." (b) the **Product
  Manager** row: the agent coordinating a Swarm project; a project may name it otherwise, and then that name replaces
  Product Manager and PM everywhere on screen; system name: coordinator (the saved/wire value stays `lead`). (c) the three-role
  table (line ~78): relabel it "The template's roles"; columns On screen / Short label / System name / Skill become
  Product Manager / PM / coordinator (wire `lead`) / `swarm-instructions`; Engineer / Dev / agent (wire `dev`); Reviewer /
  Rev / agent (wire `review`, sent only for an older client's start); add one sentence: roles are names in the project's
  document; the server checks none of them; badges show the role name cut to 12 characters. (d) line ~87 and ~152: the
  sentence "The Lead does only answers, lookups and work under 15 minutes" and "The stored `lead` and `builder` routing
  roles" are replaced by the compatibility fact (wire values `lead | dev | review | buddy` stay for older CLIs). (e) Add a
  **Notice** row: a message the server posts to the coordinator about what happened; example "Atlas's task is Ready for
  review."
- `docs/feature-design-rules.md` line 164: `Reviewer (another engine)` becomes `Reviewer`; the guide says nothing else
  about the other-engine rule (`grep -n "another engine"` shows no other hit after the edit). Do not touch the rest.
- `docs/benchmark-priors.md` "Owner override" (lines ~40-44): the override now lives in the model catalog (`catalog.ts`)
  and the Routing section of a project's document: a project that wants a model rated differently says so in words
  there; `priorOverrides` rows in a saved policy are read by nothing (phase 4 decision 3). Say which of the two the code
  does by reading `backend/src/superTabs/catalog.ts` and `costs/` first; if `priorOverrides` is still read by the
  catalog, keep the section and change only its "routing policy" wording.
- `docs/pr-triage/roles.md`: the file says "choose Custom and copy the Default texts" and addresses Lead / Reviewer /
  Builder sections. Rewrite its Setup step 3 to "paste each section below under its role in the project's Instructions
  (Roles section), or ask the product manager to"; rename the headings' role words to the project's role names (Product
  Manager, Reviewer, Engineer) in prose, keeping the section bodies' behavior text. Keep `gh` machine setup as is.
- `docs/specs/2026-10-30-buddy-read-access.md`: line ~227 ("it copies only the Lead, Engineer and Reviewer texts") and
  the "PM assigns work" lines: add under the Status line a one-line note "Under the project instructions design a Buddy
  reads the project's document instead of copying role texts: see `docs/swarms.md#instructions`", and change line ~227's
  statement to match what `cli/src/lib/swarmInstructionsSkill.ts` does for a Buddy (read it first). Do not rewrite its
  threat table.

**Interfaces:** Consumes Task 1's anchors (`#instructions`). Produces nothing a later task reads.

- [ ] **Step 1: Read** `catalog.ts`, `swarmInstructionsSkill.ts` and the five files' lines named above.
- [ ] **Step 2: Edit** the five files as listed.
- [ ] **Step 3: Greps.** `grep -n "another engine" docs/feature-design-rules.md` prints nothing;
  `grep -n -E "Lead, Reviewer, Builder|choose Custom|Default texts" docs/pr-triage/roles.md` prints nothing;
  `grep -n -E "swarm-lead|swarm-dev|swarm-review" docs/naming-system.md` prints nothing unless a line says they are the
  fallback skills for older backends; `grep -n "Instructions" docs/naming-system.md` shows the new row.
- [ ] **Step 4: Links.** Every relative link and anchor added resolves (`ls` for files; `grep -n "^## Instructions"
  docs/swarms.md` for the anchor).
- [ ] **Step 5: Commit** `Docs: naming system, design rules, priors, PR triage roles and Buddy spec follow the project instructions (project instructions, phase 6, task 2)`

### Task 3: Mark the replaced plans and specs

**Files:** Modify, one added line each under the title:
`docs/plans/2026-10-22-swarm-rules-routing.md`, `docs/plans/2026-10-22-swarm-lead-dev-skills.md`,
`docs/plans/2026-10-19-super-tab-routing-v1.md`, `docs/superpowers/specs/2026-10-19-super-tab-routing-v1-design.md`,
`docs/plans/2026-10-21-swarm-routing-phase1.md`, `docs/plans/2026-10-22-swarm-legacy-role-skills.md`,
`docs/plans/2026-10-22-worker-release.md`, `docs/plans/2026-10-22-five-part-tasks.md`,
`docs/plans/2026-10-23-swarm-local-models.md`.

The line, placed directly below the first `# ` heading (and below any existing blockquote header block, so a plan's agent
note stays first), with a blank line either side:

```markdown
> Replaced by [2026-10-30-project-instructions-design.md](PATH): the instruction document and agents' direct messages
> replace what this describes. Kept as history; do not build from it.
```

PATH is `2026-10-30-project-instructions-design.md` in the `docs/plans/` files and
`../../plans/2026-10-30-project-instructions-design.md` in the one `docs/superpowers/specs/` file. Where the plan is only
partly replaced (`2026-10-23-swarm-local-models.md`: the grid models, their hosting and the add-on stay;
`2026-10-22-worker-release.md`: say which finished-worker decisions the design removes by reading both), the second
sentence reads "Replaced in part: <what stays> stays." instead of "Kept as history; do not build from it." The first
words are always exactly `Replaced by [2026-10-30-project-instructions-design.md](`. Read each file's body first and state
the part truthfully; do not mark a plan whose subject the design leaves entirely in place, and report it instead.

**Interfaces:** none.

- [ ] **Step 1: Read** each of the nine files' first 40 lines and the design's inventory entry for it
  (`grep -n "<file name>" docs/plans/2026-10-30-project-instructions-design.md`).
- [ ] **Step 2: Insert** the line in each file (Edit, no rewrite of other lines).
- [ ] **Step 3: Greps.**
  `grep -L "Replaced by \[2026-10-30-project-instructions-design.md\](" docs/plans/2026-10-22-swarm-rules-routing.md docs/plans/2026-10-22-swarm-lead-dev-skills.md docs/plans/2026-10-19-super-tab-routing-v1.md docs/superpowers/specs/2026-10-19-super-tab-routing-v1-design.md docs/plans/2026-10-21-swarm-routing-phase1.md docs/plans/2026-10-22-swarm-legacy-role-skills.md docs/plans/2026-10-22-worker-release.md docs/plans/2026-10-22-five-part-tasks.md docs/plans/2026-10-23-swarm-local-models.md`
  prints nothing (every file has the line), and
  `grep -c "Replaced by \[2026-10-30-project-instructions-design.md\](" <each file>` prints 1 for each.
  `git diff --stat` shows nine files, one or two added lines each, no deletions.
- [ ] **Step 4: Links.** From each file's directory, `ls` the path written in its line; it resolves.
- [ ] **Step 5: Whole-phase greps** (Phase 6 validation below), then commit
  `Docs: earlier routing and role-skill plans marked replaced by the project instructions design (project instructions, phase 6, task 3)`

### Phase 6 validation

No test suite applies (docs only; confirm `git diff --stat main...` lists only files under `docs/`, and that
`python3 scripts/check-ui-style.py` is not needed). Run once at the end, from the worktree root:

- Task 3's `grep -L` over the nine files prints nothing; `grep -rn "Replaced by" docs/plans/2026-10-30-project-instructions-plan.md`
  shows only the done criterion.
- Task 1's sweep greps over `docs/swarms.md` print nothing unexpected; the same codes
  (`REVIEWER_NOT_LEAD|LEAD_REQUIRED|RULE_BROKEN|STEPPED_UP|BUILD_REFUSED|INDEPENDENT_REVIEW`) appear nowhere in `docs/*.md`
  or `docs/pr-triage` except as "removed" in the Routing section's list of what the server no longer does:
  `grep -rn -E "REVIEWER_NOT_LEAD|LEAD_REQUIRED|RULE_BROKEN|STEPPED_UP|BUILD_REFUSED|INDEPENDENT_REVIEW" docs --include=*.md`
  then read each hit outside `docs/plans/` and `docs/superpowers/`.
- Names exist: for each code and command in `docs/swarms.md`'s new text, a grep in `backend/src`, `cli/src` or `desktop/lib`
  finds it.
- Done when `docs/swarms.md` has the sections Instructions, Messages between agents, Notices to the coordinator and Routing
  (advice), the nine files carry the line, and the report lists any sentence kept on purpose by a sweep grep.
- PR: docs-only, so PR CI runs process checks only; open it ready, record the greps above in the PR description. Docs ship
  with the phases 3-5 release train and need no release of their own.
