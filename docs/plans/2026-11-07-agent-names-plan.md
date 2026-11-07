# Every agent gets a real name: implementation plan

> This plan is carried out by the project's Engineer way of working (test first, task by task, one pull request), not
> subagent-driven-development. There is no execution handoff.

**Goal:** anh Dee (11-07 19:40, task #4568): every agent has a real name, the first one a person brings when they join
included; no more "<person>'s Buddy". Names are unique in the Swarm, an agent can be renamed from its menu, and its face
follows its name.

**Architecture:** One name source, `agentNames.ts`. Its list grows from 32 names to 200, and `freeAgentName` picks the
first free one from a stable start (an id's hash), then two list names together ("Atlas Reed", 39,800 more), and only
past those a numbered one. Every place that gives a new agent its name uses it: a new Buddy (`buddy.create`, so joining's
Bring agent too) keeps it as its chat's chosen name, as a rename does; `agent.new` picks one when the person names none;
`assignAgentDisplayNames` (Leads, sessions named for their role or engine) picks from the same list. An engine's own
name ("Claude Code", "Codex"), which Desktop's local Cmd-N start gives every Member, counts as no name, so those agents
get member names too. A name a person gives with `agent.new` passes the rename checks (`agentRename.ts`), so it is
unique as a rename is. Desktop already shows an agent's name and draws its face from it; its "<person>'s Buddy" default
and "Your Buddy" fallbacks go.

**Tech Stack:** TypeScript backend (vitest), Flutter Desktop (flutter test).

**Spec:** Task #4568's brief; `docs/specs/2026-11-07-members-and-leads.md` (part 4 names existing Buddies when they become
Members).

## Global Constraints

- Names unique in the Swarm, compared as `nameKey` (NFKC, lowercase), against agents, starts, people and chosen Buddy names.
- Existing Buddies keep their names until redesign part 4; one with a chosen name shows it everywhere.
- Old clients keep working: `agent.new` still takes a name; `buddy.rename` with no name gives a fresh list name.
- A name is never a role's, an engine's or a reserved word, as today.

## Review Focus

- Two Buddies started in the same command batch, or one starting while another agent takes the same list name: never alike.
- The first Buddy of a person who joins gets a list name, and a later Bring agent of theirs keeps it.
- Past 200 agents a name still reads as a name; past 40,000 it is numbered, never fails.
- A person naming their agent another person's username or another agent's name is refused, as a rename is.
- A Buddy restarted after its chosen name was taken gets a fresh list name and its owner is told, as today.

---

### Task 1: The name list and `freeAgentName`

**Files:**
- Modify: `backend/src/superTabs/agentNames.ts`
- Test: `backend/src/superTabs/agentNames.test.ts`

**Interfaces:**
- Produces: `freeAgentName(taken: (name: string) => boolean, seed: string): string`; `isEngineName(name): boolean`, folded
  into the unnamed check.

- [ ] **Step 1: Write the failing tests.** 200 distinct names; with all 200 taken, the next reads as two names; with all
  pairs taken, a numbered one; the same seed picks the same name; "Claude Code" and "Codex" get member names.
- [ ] **Step 2: Run** `npx vitest run src/superTabs/agentNames.test.ts`. Expected: FAIL.
- [ ] **Step 3: Commit** the failing tests, then **implement**, run, commit.

### Task 2: New Buddies and new agents get list names

**Files:**
- Modify: `backend/src/superTabs/buddies.ts` (`chosenBuddyName`, `renameBuddy`), `backend/src/superTabs/commands.ts`
  (`agent.new`), `backend/src/superTabs/agentRename.ts` (export the check for a new agent)
- Test: `backend/src/superTabs/agentNamesOnCreate.test.ts`; update tests that expected "<person>'s Buddy" for a new Buddy

**Interfaces:**
- Consumes: `freeAgentName` (task 1).
- Produces: `newAgentName(state, actor, input?: string)`: a person's checked name, or a free list name.

- [ ] **Step 1: Write the failing tests.** Joining's Bring agent makes a Buddy with a list name, its chat titled so; ten
  people's first Buddies get ten different names; clearing a Buddy's name gives a fresh list name, never "<person>'s
  Buddy"; `agent.new` without a name gets a free list name; with another agent's name or a person's username it is
  refused `AGENT_NAME_TAKEN`; a Buddy whose chosen name was taken gets a fresh one with its owner's notice.
- [ ] **Step 2: Run** the test file. Expected: FAIL.
- [ ] **Step 3: Commit** the failing tests, then **implement**; update the tests that asserted the old default; run the
  tests of the changed files; commit.

### Task 3: Desktop shows the name, never "<person>'s Buddy"

**Files:**
- Modify: `desktop/lib/super_tabs/buddies.dart` (rename dialog: no default name), `project_sidebar.dart` and
  `view.dart` (no "Buddy" or "Your Buddy" in place of a name), `chat/agent_chat_header.dart`
- Test: `desktop/test/` widget tests for the sidebar row and header with a named and an unnamed Buddy, and the rename
  dialog

- [ ] **Step 1: Write the failing widget tests**, run them, commit.
- [ ] **Step 2: Implement**, run the changed widgets' tests, commit. Rename from the agent's ⋮ menu and the face drawn from
  the shown name are already there; the tests pin them.
