# Every project's instructions on the new base — Implementation Plan

> Written by the project's Engineer by the writing-plans skill, as the project instructions say: the Engineer implements it
> task by task, test first, and the pull request's review step is its one independent review.

**Goal:** One approved change (anh Dee, 11-06: "update them all and override all of their existing instructions. ALL OF
THEM") replaces every project's instructions in a Swarm with the new base: the built-in base, that project's own roles and
facts, and every person's rule word for word in its People notes. A dry run shows the before and after of every project and
changes nothing; the run writes exactly what the dry run showed, and each project's PM is told.

**Architecture:** A new Swarm command, `instructions.rebase`, through the existing command endpoint (no new route, no CLI
change: `command OPERATION_ID JSON` sends it). A pure module, `instructionsRebase.ts`, builds each project's new document from
its stored one and checks with the rule guard's own reader (`instructionsDiff.ts droppedRules`) that no person's rule is lost.
The store loads every project's stored document for the command and writes every new revision in the command's transaction.

**Tech Stack:** TypeScript, zod, Prisma (MongoDB), vitest; MongoMemoryReplSet for the store test.

**Spec:** task #3600's brief (conversation 35059e6f472ab0db037bba90). Reuses migration/instructions.ts's way of building a
document from parts and the rule guard (ruleGuard.ts, instructionsDiff.ts); ruleMoves.ts (GitHub merge reads) has nothing
this needs.

## Global Constraints

- Only the Swarm owner, or a project's PM passing on a chat message the owner wrote in the last day (`askedIn`, as every
  Swarm-wide switch: commands.ts swarmOwnerAsked), runs it, dry run included: it reads every project's instructions.
- The dry run changes nothing: no state, no instructions row, no message.
- The run writes only the plan the dry run showed: it names the dry run's `plan` hash, and a project changed since refuses
  the whole run (REBASE_STALE) with the new hash. All projects or none.
- Every attributed rule of a project's document — "(Name, date)" as instructionsDiff.ts reads it — stays word for word with
  who gave it. A project whose new document would drop one is refused, with the rule, and nothing is written.
- "REPLACE 100%" (River's ruling with anh Dee, 11-06): a document becomes only a short intro, the project's facts (repo,
  devices, people's areas; given by the run per project) and People notes. No template and no role section is copied in:
  all process is the Swarm's built-in PM text, which #3603 adds to pmSchedule.ts PM_SCHEDULE_TEXT. A role section's
  attributed rules go to People notes under "Roles › <role>" like any other.
- A document stays within 64 KB (MAX_INSTRUCTIONS_BYTES); the size budget is reported, not enforced (People notes of a
  project with many rules is over 3 KB; later saves may only shrink it, ruleGuard.ts refuseOverBudget).
- Each written project's PM (the coordinator of its project chat) gets one notice only it reads; the CLI host's own
  "instructions changed" notice follows from the new revision as for any save.
- Swarm code stays out of cli/src/core. Owns backend/src/superTabs/.

## Design

- Growth: one revision per project, once; revisions are capped at 50 per project as for any save (instructionsStore.ts).
- Concurrency: the command runs in the Swarm's command transaction (one Swarm lock); the plan hash catches a save between
  the dry run and the run.
- Read cost: one equality read of the Swarm's instruction rows (`tabId`), only for this command.
- Scale: 10x projects in a Swarm is ~300 documents of at most 64 KB in one command result: the dry run's result is the
  first to warn (it is stored with the receipt); it holds texts only for projects that change.
- Compatibility: a new command type; old clients never send it. Agents read the new revision as any save's.
- Migration + rollback: this is the migration; rollback is the Instructions history (each project's previous revision).
- Audience: the server enforces the owner check; a PM relaying needs the owner's own message in this Swarm.
- Identity: `askedBy` is the Swarm owner; `writtenBy` is the sender (owner or relaying PM), never the machine owner's login.
- Failure: a lost rule, a document over 64 KB, an unreadable stored document or a stale plan refuses the whole run, out loud.
- Platforms: server only.

## Review Focus

- A rule whose item holds several attributions ("(Ken, 11-02; Dee, 11-03)", two "(…)" in one bullet): each kept, with all its people.
- A rule already in a `## People notes` section, or written twice: kept once, never doubled.
- A project with no document yet (revision 0, on the template): planned from the template like any other.
- An attributed list item with wrapped lines and items nested under it, or a heading carrying the attribution: carried whole.
- A save between the dry run and the run: the run refuses and names the new plan.

---

### Task 1: Build one project's new document

**Files:**
- Create: `backend/src/superTabs/instructionsRebase.ts`
- Modify: `backend/src/superTabs/instructionsDiff.ts` (export `sectionedRules`)
- Test: `backend/src/superTabs/instructionsRebase.test.ts`

**Interfaces:**
- Produces: `sectionedRules(text: string): Array<AttributedRule & { path: string }>` (instructionsDiff.ts) — every attributed
  rule with its section path ("Roles › PM").
- Produces: `rebasedDocument(before: string, facts?: string): RebasedDocument` where
  `RebasedDocument = { text: string; carried: AttributedRule[]; keptRoles: string[]; lost: DroppedRule[] }`.

- [ ] **Step 1: Write the failing tests** (`describe('a project\'s document on the new base')`):
  - `keeps every person's rule word for word in People notes, under its old section, and nothing else of the old text`:
    from a document with a PM rule "(Ken, 2026-11-02)", a Workflow rule and an unattributed process line, `text` starts with
    the base, has `## People notes` then `### Roles › PM` and `- <rule>`; the unattributed line is gone;
    `droppedRules(before, text)` is `[]`; `lost` is `[]`.
  - `splits an item of several attributions and keeps each with its people`.
  - `writes a rule once: one already in People notes, or written twice`.
  - `keeps a role section the base lacks, with its rules, and copies them nowhere else` (Integrator).
  - `adds the project's facts under "## This project", and none when none are given`.
  - `rebuilds the openharness revision 79 shape without losing any of its 59 rules` (fixture: a trimmed copy with the same
    shapes: nested lists, numbered steps, honorifics, "(Dee, 2026-11-04; repeated 2026-11-05 …)").
- [ ] **Step 2: Run** `npx vitest run src/superTabs/instructionsRebase.test.ts` — FAIL: module not found.
- [ ] **Step 3: Implement** `sectionedRules` from `items()`'s paths; `rebasedDocument`: base roles from TEMPLATE_ROLES' `###`
  names; kept role sections copied as lines; People notes grouped by path (the leading "People notes" dropped), deduped by
  text; `lost = droppedRules(before, text)`.
- [ ] **Step 4: Run** the test — PASS. **Step 5: Commit.**

### Task 2: The `instructions.rebase` command

**Files:**
- Modify: `backend/src/superTabs/commands.ts` (schema, case, context `allInstructions`), `backend/src/superTabs/model.ts`
  (`CommandEffects.rebased`, NOTICE_READERS `instructions-rebased`), `backend/src/superTabs/instructionsRebase.ts`
  (`rebasePlan`)
- Test: `backend/src/superTabs/instructionsRebase.test.ts`

**Interfaces:**
- Consumes: `rebasedDocument` (Task 1).
- Produces: command `{ type: 'instructions.rebase', apply?: boolean, plan?: string, facts?: Record<projectId, string ≤ 4000>,
  askedIn? }`; context `allInstructions?: Array<{ projectId, revision, text }>`; effects `rebased?: InstructionsWrite[]`;
  `rebasePlan(state, stored, facts): { plan: string; projects: RebasedProject[] }`.

- [ ] **Step 1: Write the failing tests** (`describe('instructions.rebase')`):
  - `a dry run lists before and after for every project and changes nothing` (two projects, one on revision 0): result has
    `plan` and per project `before`, `after`, `rules`, `keptRoles`, `dropped`, `parts`; state, effects.rebased and messages
    unchanged/empty.
  - `the run saves each project's new base, keeps every person's rule, and tells every PM`: revisions +1, hashes, every
    `effects.rebased[i].text` keeps each rule; one `instructions-rebased` row per project to its coordinator only.
  - `refuses anyone but the Swarm owner`: a collaborator, a PM without `askedIn`, a PM quoting a member's message → 403
    OWNER_REQUIRED, dry run and run alike; a PM quoting the owner's message from the last day passes.
  - `refuses a run without the dry run's plan, or after a project changed since` → REBASE_PLAN_REQUIRED / REBASE_STALE with
    the new plan.
  - `refuses the whole run when a project's document would lose a rule or pass 64 KB` (an unreadable document too).
- [ ] **Step 2: Run** — FAIL (unknown command type).
- [ ] **Step 3: Implement**: plan hash = sha256 of each changed project's id, revision and new hash, in project order.
- [ ] **Step 4: Run** — PASS. **Step 5: Commit.**

### Task 3: The store loads every document and writes every revision

**Files:**
- Modify: `backend/src/superTabs/store.ts` (context load for `instructions.rebase`; write `effects.rebased`)
- Test: `backend/integration/superTabInstructions.test.ts`

- [ ] **Step 1: Write the failing test** `instructions.rebase writes each project's new revision once, after a dry run that wrote nothing`:
  a Swarm with two projects, a saved rule; the dry run leaves rows and revisions as they were; the run's revisions read back
  with the new text, the History has the revision with its summary, and the PM's read shows it.
- [ ] **Step 2: Run** `npx vitest run --config vitest.super-tabs.config.ts integration/superTabInstructions.test.ts -t rebase` — FAIL.
- [ ] **Step 3: Implement**: `findMany({ where: { tabId } })` for the command; `for (const write of effects.rebased ?? []) writeInstructions(...)`.
- [ ] **Step 4: Run** — PASS. **Step 5: Commit.**
