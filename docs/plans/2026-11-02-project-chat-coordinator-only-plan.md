# Project chat holds only its coordinator, and member changes leave a row — Implementation Plan

> **For agentic workers:** this plan is worked by the project's Engineer, task by task, test first (project instructions,
> Engineer). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** no agent but the coordinator can be added to a project's chat (`leadConversationId`) by any path, Desktop's
terminal on the project chat opens only the coordinator's pane, and every agent added to or removed from a chat leaves a
system row naming who did it.

**Architecture:** one refusal helper in `applyCommand` (backend/src/superTabs/commands.ts), called wherever a command
puts an agent into a group's `agentIds`; one diff after the command's switch that compares each existing group's
members before and after and writes "X added Y." / "X removed Y." rows (new file memberRows.ts). Desktop filters the
project chat's pane agents to its lead in one snapshot method both the pane sync and the terminal count read.

**Tech Stack:** TypeScript, zod, vitest (backend); Dart, Flutter test (desktop).

**Spec:** task #2207 (Ken), brief in its conversation: Goal, Changes, Constraints, Owns, acceptance checks.

## Global Constraints

- The PR body starts with: Requested by ken15@autonomous.ai through Harness.
- Two independent security reviews before merge: Cleo and Orion.
- PR Design lines: audience (the server enforces it), compatibility (a chat that already holds extra agents keeps them
  until removed; Desktop shows only the coordinator), failure (the refusal says why).
- Full backend Super Tab integration suite (`npm run test:super-tabs`) before Ready.
- Swarm code stays out of cli/src/core.

## Review Focus

1. A person (not only an agent) adding a Reviewer to the project chat is refused too: the person path was the open one.
2. Naming the coordinator itself, or setting a new coordinator (`lead: true`), still works on every path.
3. An agent already stored in the project chat stays (no migration), is not re-added after a session restore, and a post
   naming it is not refused.
4. A command that changes no membership writes no row; an agent removed from the Swarm gets only its existing removal
   row, not a second one per group.
5. A Buddy chat's sessions come and go with threads: no member rows there.

---

### Task 1: The project chat takes no agent but its coordinator

**Files:**
- Modify: `backend/src/superTabs/commands.ts` (`conversation.agent`, `agent.add`, `agent.start`, `work.assign`,
  `message.send` recipients)
- Modify: `backend/src/superTabs/closedAgents.ts` (`restoreSessions`: no re-add to a project chat it does not lead)
- Test: `backend/src/superTabs/commands.test.ts`, `backend/src/superTabs/closedAgents.test.ts` if present, else commands.test.ts

**Interfaces:**
- Produces: `PROJECT_CHAT_COORDINATOR_ONLY` (403) with the message
  `The project chat holds only its coordinator among agents, so NAME cannot join it. Its work and announcements go in its task.`
  and, for a post's recipient,
  `The project chat holds only its coordinator among agents: a post here reaches the coordinator. Tell NAME in its task.`

- [ ] **Step 1: Write the failing tests** — `refuses any agent but the coordinator in the project chat, by every path`:
  a Reviewer added by `conversation.agent` (coordinator and person), by `agent.add` of a person (lead false), by an
  `agent.start` whose conversation is the project chat (coordinator and person), by `work.assign` there, and by a post's
  recipients (coordinator) each throw `PROJECT_CHAT_COORDINATOR_ONLY`, and the chat's members are unchanged;
  `conversation.agent` with `lead: true` still sets a coordinator, `conversation.agent` naming the current coordinator
  passes, and an agent already stored there can still be named in a post. The existing tests that start or assign an
  engineer in the project chat as its coordinator now expect the refusal.
- [ ] **Step 2: Run** `cd backend && npx vitest run src/superTabs/commands.test.ts -t "project chat"` — FAIL (no such code).
- [ ] **Step 3: Implement** `projectChatJoin(group: Conversation, agentId: string | null, name: string, why: 'post' | 'join')`
  in applyCommand: no-op unless `group` is a project's `leadConversationId`, the agent is its `leadId`, or already a
  member; otherwise fail. Call it before each push named above (start: before the start is recorded, with the request's
  name; `agent.add` and `conversation.agent` skip it for `lead: true`). In `restoreSessions` skip a project chat the
  record does not lead.
- [ ] **Step 4: Run** the same tests, then `npx vitest run src/superTabs` — PASS.
- [ ] **Step 5: Commit** test, then code.

### Task 2: Every agent added to or removed from a chat leaves a row naming who did it

**Files:**
- Create: `backend/src/superTabs/memberRows.ts`
- Modify: `backend/src/superTabs/commands.ts` (call after the switch; `agent.started`'s join row names its starter)
- Test: `backend/src/superTabs/memberRows.test.ts`, `backend/src/superTabs/commands.test.ts`

**Interfaces:**
- Produces: `memberChanges(original: SuperTabState, state: SuperTabState): Array<{ group: Conversation; agent: Agent; added: boolean }>`
  — groups present before and after, not Buddy chats, agents still in `state.agents`.
- Produces: `memberRowText(by: { id: string; name: string } , agent: { id: string; name: string }, added: boolean): string`
  — `"BY added NAME."`, `"BY removed NAME."`, or for the agent itself `"NAME joined."` / `"NAME left."`.
- The row: author the command's sender, `recipients: []`, source `{ kind: 'system' }` (shown to the chat's readers,
  wakes nobody), id `stableId(operationId, 'member', group.id, agent.id)`.
- `agent.started`'s worker row becomes `"STARTER added NAME. Preparing its model."` / `"… Ready for an assignment."`, the
  starter read from the start's `actorKey`; that command writes no diff row.

- [ ] **Step 1: Write the failing tests** — memberRows.test.ts for `memberChanges` (an add, a remove, a new group and
  a removed agent ignored, a Buddy chat ignored) and `memberRowText`; commands.test.ts `leaves a row naming who added or
  removed an agent`: Ken (a person) adds Finn 2 to a task — row `ken added Finn 2.`; River (the coordinator) removes it —
  row `River removed Finn 2.`; both with `recipients: []` and source kind `system`; an assign, a post's recipient and a
  start each leave one row naming their actor; an `agent.remove` writes no member row.
- [ ] **Step 2: Run** `npx vitest run src/superTabs/memberRows.test.ts src/superTabs/commands.test.ts -t "row naming"` — FAIL.
- [ ] **Step 3: Implement** memberRows.ts and the call after the switch (before the credential scrub, so its rows are
  scrubbed and bound like any other); the starter's name in `agent.started`.
- [ ] **Step 4: Run** `npx vitest run src/superTabs` and `npx tsc --noEmit -p .` — PASS.
- [ ] **Step 5: Commit** test, then code.

### Task 3: Desktop opens only the coordinator's pane on the project chat

**Files:**
- Modify: `desktop/lib/super_tabs/model.dart` (snapshot), `desktop/lib/super_tabs/controller.dart` (`terminalAgents`),
  `desktop/lib/super_tabs/view.dart` (`_terminalCount`)
- Test: `desktop/test/super_tab_controller_test.dart`

**Interfaces:**
- Produces: `List<String> SuperTabSnapshot.paneAgentIds(String conversationId)` — the project chat's lead alone when it
  is a member, else nothing; any other group's `agentIds`.

- [ ] **Step 1: Write the failing test** `opens only the coordinator's pane on the project chat, even with older members`:
  a snapshot whose project chat holds the lead and a Reviewer; after `selectGroupTerminals`, `terminalAgents` is the
  lead alone; a task's group still gives both.
- [ ] **Step 2: Run** `cd desktop && flutter test test/super_tab_controller_test.dart --plain-name "coordinator's pane"` — FAIL.
- [ ] **Step 3: Implement** `paneAgentIds` and use it in both places.
- [ ] **Step 4: Run** the controller test file and `flutter analyze lib/super_tabs` — PASS.
- [ ] **Step 5: Commit** test, then code.

### Task 4: Validation

- [ ] `cd backend && npx tsc --noEmit -p . && npx vitest run src/superTabs && npm run test:super-tabs`
- [ ] Red/green evidence (the new tests on main's code, then on the branch) in a PR comment.
