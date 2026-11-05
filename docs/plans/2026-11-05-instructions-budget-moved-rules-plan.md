# Instructions Size Budget and Moved Rules Implementation Plan

> Implement task by task, test first, following the project's Engineer workflow (project instructions, Engineer).

**Goal:** An instructions save that makes a part of the document bigger than its budget is refused as
`INSTRUCTIONS_OVER_BUDGET`, naming each part's size and budget: core 6 KB, each role section 2 KB, people notes 3 KB, 20 KB
in all. The guard that refuses dropping a person's tagged rule (`INSTRUCTIONS_RULES_DROPPED`) learns "moved": a rule counts as
kept when it moves word for word, with who gave it, into people notes or a role section, into the project's rules record, or
into a code task once that task has merged. A rule moved into a task still open is refused with the task named, so the line
stays until the task merges. One restructure save can then move every rule at once (anh Dee's decision 5).

**Architecture:** Two pure functions in `instructionsDiff.ts`, which already parses the document into items and attributed
rules: `budgetParts(text, budget)` splits a document into its budget parts with their UTF-8 sizes, and `droppedRules` takes an
optional list of places outside the document (`RulePlace`) where a rule may have moved. `ruleGuard.ts` gets
`refuseOverBudget(before, after)` and builds the places for `allowedDrops` from the project's rules record (`state.rules`) and
its code tasks (conversations of the project with a brief). `commands.ts` calls `refuseOverBudget` in `instructions.save`
next to `refuseRepeats`, and takes an optional `tasks` list naming code tasks the rules moved into, which `store.ts namedFor`
loads even when dormant (a merged task goes quiet after a day).

**Tech Stack:** Backend TypeScript, zod command schema, Vitest.

**Spec:** Swarm task #3392 brief (River, for anh Dee, 2026-11-05); readings posted in the task for River: role sections are the
`###` headings under `## Roles`, people notes is a `## People notes` section, the rest is core; a part already over budget may
be saved as long as it does not grow; a rule moved into an open code task keeps its line until that task merges.

## Global Constraints

- New refusal code `INSTRUCTIONS_OVER_BUDGET` (a new name; none of the codes in `removedRefusals.test.ts` comes back).
- Budgets: core 6,144 bytes, each role section 2,048, people notes 3,072, whole document 20,480 (UTF-8 bytes, KB = 1,024
  as `MAX_INSTRUCTIONS_BYTES` counts). They live in one exported `INSTRUCTIONS_BUDGET` object passed into the check, so a
  project-level setting can replace it later without touching the check.
- A part is refused only when it is over its budget and bigger than the same part in the revision the save replaces (a role
  section is the same part by its heading). Today's document (about 31 KB) and the template (its PM section about 2.9 KB)
  are over budget: saves that shrink them, or leave those parts unchanged, still go through.
- The refusal names each part, its size, its budget and its size before, and the next step: move checkable rules to a code
  task, move a person's rule word for word to people notes or their role section, or drop lines that passed.
- Moved means the rule's words in order (the same comparison `droppedRules` already uses) and every person of the rule:
  in the document, in a segment attributed to them; in a rules record, attributed in its text or asked by them; in a code
  task, attributed in its brief.
- A code task counts only once merged (`ledger.mergedAt`). Cancelled tasks never count. An open one makes the rule
  `waiting`, refused with the task's number and "keep the line until it merges".
- Swarm code stays out of `cli/src/core`. Only `backend/src/superTabs/` and this plan change.

## Design

- growth: nothing new is stored. The `tasks` field of a save is at most 20 ids, read once.
- concurrency: the check runs inside the existing save transaction, against the revision the stale check already read.
- read cost: the budget check is one pass over the text; the moved check scans the project's loaded tasks and rules once per
  dropped rule, only when a rule would otherwise be dropped. Named tasks are loaded by id (one indexed read each).
- compatibility: `tasks` is an optional field; older clients never send it. `DroppedRule.why` gains `waiting` (details only).
- failure: each refusal names its next step; the moved form is spelled out in the dropped-rules refusal.
- audience: unchanged; the save's access checks run first.

## Review Focus

- A rule moved into a task brief without its attribution is still refused (the person must come with it).
- A rule whose words moved but changed (a number, a negation) into a task or the rules record is still refused.
- An over-budget part that shrinks or stays the same passes; one that grows is refused, and a new part (new role section)
  over its budget is refused.
- `removedRefusals.test.ts` stays green.

---

### Task 1: Budget parts and the over-budget refusal

**Files:**
- Modify: `backend/src/superTabs/instructionsDiff.ts`, `backend/src/superTabs/ruleGuard.ts`, `backend/src/superTabs/commands.ts`
- Test: `backend/src/superTabs/instructionsDiff.test.ts`, `backend/src/superTabs/instructions.test.ts`

**Interfaces:**
- `INSTRUCTIONS_BUDGET = { core, role, people, total }` (bytes).
- `budgetParts(text, budget?): BudgetPart[]` with `BudgetPart = { part: string; bytes: number; budget: number }`; parts
  `core`, `role: <heading>`, `people notes`, `total`.
- `refuseOverBudget(before, after, budget?)`: throws `INSTRUCTIONS_OVER_BUDGET`, 409, details `{ parts: [{ part, bytes,
  budget, before }] }`.

- [ ] Write failing tests: `budgetParts` splits core, role sections and people notes (fenced headings ignored, UTF-8 bytes);
  a save whose core grows past 6 KB is refused with the sizes in the message; a role section past 2 KB, people notes past
  3 KB and a whole document past 20 KB likewise; a save that shrinks an over-budget part, or leaves it unchanged, passes.
- [ ] Run `cd backend && npx vitest run src/superTabs/instructionsDiff.test.ts src/superTabs/instructions.test.ts`. Expected: FAIL.
- [ ] Implement, wire into `instructions.save` after `refuseRepeats`.
- [ ] Run the same tests plus `src/superTabs/removedRefusals.test.ts`. Expected: PASS.
- [ ] Commit the tests first, then the code.

### Task 1b: The built-in template fits its own budget (River, in the task)

A new project's PM writes its routing line into Routing; the template's core was 6,125 of 6,144 bytes and its PM section
2,943 of 2,048, so that line would be refused. River: trim the template in this PR, core with at least 1 KB of room and the PM
section within 2 KB, cutting wording and repetition, never a rule.

**Files:** Modify `backend/src/superTabs/instructionsTemplate.ts`; Test `backend/src/superTabs/instructions.test.ts`

- [ ] Write a failing test: the template's core is at most 5,120 bytes and each role section at most 2,048.
- [ ] Trim; update the template tests that pinned wrapped or reworded lines, keeping each rule they guard.
- [ ] Run the template tests and the instructions integration files. Expected: PASS.

### Task 2: A tagged rule may move

**Files:**
- Modify: `backend/src/superTabs/instructionsDiff.ts` (`droppedRules` places), `backend/src/superTabs/ruleGuard.ts`
  (`allowedDrops` places, refusal text), `backend/src/superTabs/commands.ts` (`tasks` field), `backend/src/superTabs/store.ts`
  (`namedFor` loads `tasks`)
- Test: `backend/src/superTabs/instructionsDiff.test.ts`, `backend/src/superTabs/instructions.test.ts`

**Interfaces:**
- `RulePlace = { text: string; people: string[]; where: string; open: boolean }` (`people`: identified keys known to have
  given what the place holds, such as a rules record's askedBy).
- `droppedRules(before, after, identify?, places?)`; `DroppedRule.why` adds `'waiting'` and `movedTo?: string`.
- `instructions.save` takes `tasks?: string[]` (conversation ids, at most 20).

- [ ] Write failing tests: a rule moved word for word into a `## People notes` section or a role section is kept; moved into
  the project's rules record (by its askedBy, or attributed in its text) is kept; moved into a merged code task's brief is kept,
  also when that task is dormant and named in `tasks`; moved into an open task is refused naming the task; a real drop, a moved
  copy without its person, and a moved copy with a changed number are still refused; the refusal text spells out the moved form.
- [ ] Run `cd backend && npx vitest run src/superTabs/instructionsDiff.test.ts src/superTabs/instructions.test.ts`. Expected: FAIL.
- [ ] Implement.
- [ ] Run the same tests plus `src/superTabs/removedRefusals.test.ts` and `src/superTabs/commands.test.ts`. Expected: PASS.
- [ ] Commit the tests first, then the code.
