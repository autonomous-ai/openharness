# Every project's instructions on the new base — Implementation Plan

> Written by the project's Engineer by the writing-plans skill, as the project instructions say: the Engineer implements it
> task by task, test first, and the pull request's review step is its one independent review.

**Goal:** Every project's instructions move onto the new base once, by themselves, after the backend release (anh Dee 11-06:
"ALL OF THEM"; River's rulings the same day: "REPLACE 100%", no preview, no approval step, one review). Each document
becomes a short intro and every person's rule word for word in People notes; all process is the Swarm's built-in PM text
(#3603). No person's rule may be lost: that is the one check that must be right.

**Architecture:** A pure builder, `instructionsRebase.ts rebasedDocument`, carries every block of the old document that holds
an attributed rule (an item with its wrapped lines and nested items, a paragraph, a fenced block, or a whole section whose
heading names a person) into People notes, filed under its old section. A worker job, `migration/rebase.ts`, moves each
project not yet marked, one Swarm per transaction guarded by the head's version (as migration/instructions.ts writes),
checks with the rule guard's own reader (`droppedRules`) that the document it would write keeps every rule, writes the new
revision as the Swarm, and marks the project (`instructionsBase`) so it never runs on it again. A project that would lose
a rule is held back, unwritten, and logged as an error every hourly pass.

**Tech Stack:** TypeScript, Prisma (MongoDB), vitest; MongoMemoryReplSet for the job's test.

**Spec:** task #3600's brief and River's rulings in its conversation (35059e6f472ab0db037bba90).

## Global Constraints

- Every attributed rule, "(Name, date)" as instructionsDiff.ts reads it, stays word for word with who gave it, checked by
  the job itself on what it writes; a project that would lose one is not written.
- Runs once per project: marked when on the base; a later save is never rewritten.
- The record: the Instructions history keeps the revision before and the new one, written by the Swarm (`system`,
  `rebase`), with every line that went (ruleGuard.ts droppedLines).
- Each PM is told through the new revision and hash, as for any save (the CLI host's "instructions changed" notice).
- A document stays within 64 KB; the size budget is not enforced here (openharness keeps ~22 KB of rules; later saves may
  only shrink People notes, ruleGuard.ts refuseOverBudget).
- Only the Swarm that asked (autonomous.ai, REBASE_SWARMS), recorded as asked by anh Dee (a collaborator there; the owner is
  ken15, who did not ask): another team's document is moved only on
  an explicit ruling from Dee or Ken (review of #3300, Critical).
- A Swarm on the base starts each new project on the base, marked (commands.ts project.create): one way to start a project.
- At most 24 hourly passes; then the job gives up on what is left, saying so as an error.

## Design

- Growth: one revision per project, once; revisions stay capped at 50 per project (instructionsStore.ts).
- Concurrency: one Swarm per transaction, head version guarded: a command in between wins and the Swarm is retried next pass.
- Read cost: one Swarm read per pass; one pass per worker start, then hourly (a day at most) only while something is held back.
- Scale: 10x Swarms is 10x passes of one transaction each; the pass log's counts warn first.
- Compatibility: `instructionsBase` is a new optional project field; old readers ignore it.
- Migration + rollback: this is the migration; rollback is an ordinary save of each project's previous revision from its
  History, and the mark keeps the job from moving it again. A project already at 50 revisions drops its oldest, never the
  one before the move.
- Audience: nothing new is exposed; the History is read by who reads the project.
- Identity: written by the Swarm (`system`), asked by the member REBASE_SWARMS names for the Swarm (anh Dee), never its owner.
- Failure: a held project or failed Swarm is logged as an error every pass, with why; nothing is written for it.
- Platforms: server only.

## Review Focus

- A rule in an item of several attributions, nested under an unattributed item, or under a heading that names a person.
- A rule already in People notes, or written twice: kept once.
- A project with no document yet (revision 0) or still on the template.
- A save between the job's read and write: the head guard makes it retry.
- A faulty builder: the job's own check holds the project back.

---

### Task 1: Build one project's document — `instructionsRebase.ts`, tested in `instructionsRebase.test.ts` (done)
### Task 2: The run-once job — `migration/rebase.ts`, wired in `worker.ts`, tested in `integration/superTabInstructionsRebase.test.ts`
- [x] Failing test: writes each project with every rule, keeps the before in its History; runs once; holds back a project a
  faulty builder would make lose a rule, and logs it every pass.
- [x] Job, marker field (`projects.ts instructionsBase`), worker start and stop.
