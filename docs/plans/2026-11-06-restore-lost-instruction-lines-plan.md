# Restore the lines the move onto the new base lost: plan (task #3679)

> Way of working: the Engineer implements this plan task by task, test first (project instructions, Engineer). No Execution Handoff.

**Goal:** The move onto the new base (#3600) dropped lines from projects' instructions that no person's name guarded: the safety rules, Ken's "optimizations ship on", the PM schedule items, the routing order and quota. Make the move refuse to lose any line, and restore every project's lost lines word for word, once, with a per-project report.

**Architecture:** Cause: `rebasedDocument` (instructionsRebase.ts) carried only blocks holding a "(Name, date)" attribution, and the job's check (`droppedRules`) only looked at such rules, so a line with no name was neither carried nor missed. (1) The builder now carries every block, filed under its section in People notes, and reports `lostLines` (instructionsDiff.ts `removedLines`: any non-heading item of the old document not word for word in the new); the job holds a project back for one. (2) A new run-once job (migration/restoreRebase.ts) compares each moved project's revision before the move (its History) with the revision the move wrote; where that revision is still the current one it appends the missing lines as one saved revision, and reports per project what came back.

**Tech Stack:** TypeScript, vitest, `backend/src/superTabs/`, Mongo through Prisma.

**Spec:** River's brief for task #3679 (anh Dee, P0); anh Dee 11-06 "restore safety rules the rewrite lost".

## Global Constraints
- A project's text is never rewritten by the restore except by appending: no line the project has is removed or reworded.
- A project saved since the move (its PM already acted, as harness's did at revision 81) is left alone and only reported.
- Once: a project restored is recognised by its own History (a revision with the restore's summary after the move), no new field.

## Review Focus
- The new check refuses an unnamed line, and a dated schedule line, that the old builder dropped.
- The restore never touches a project saved since the move, and never writes twice.
- The restored document is within 64 KB and contains every line of the old one (the job's own check, not the builder's).
- Two security-style reads, as every project's document is rewritten: the Swarm scope (REBASE_SWARMS), who is recorded as asking.

## Design
- growth: one extra revision per project, once; the History keeps 50 revisions already.
- concurrency: guarded by the head's version, a Swarm per transaction, as the move is; a command in between wins and the pass tries again.
- read cost: one stored document and two revisions per project, once.
- scale: 10x projects is 10x one pass; the metric is the pass's report.
- compatibility: hosts compare the revision, so each PM is told the instructions changed.
- migration + rollback: the previous revision is in History; restoring it is an ordinary save.
- audience: the same Swarm scope as the move; the server decides.
- identity: recorded as asked by the member named for the Swarm, never the owner.
- failure: a project that cannot be restored is held back with why, logged as an error each pass.
- platforms: N/A.

### Task 1: the builder carries every line, and the check refuses a lost one
**Files:** `instructionsDiff.ts` (removedLines), `instructionsRebase.ts`, `instructionsRebase.test.ts`, `migration/rebase.ts`.
- [ ] Failing tests: an unnamed safety line and a dated schedule line survive the move; `lost` and `lostLines` are empty; a builder that drops one is held back by the job.
- [ ] Code.

### Task 2: the restore job
**Files:** `migration/restoreRebase.ts`, `restoreRebase.test.ts` (unit), `integration/superTabInstructionsRestore.test.ts`, `worker.ts`.
- [ ] Failing tests: a moved project that lost lines gets one revision with them, word for word; a project saved since is left alone and reported; a second pass writes nothing.
- [ ] Code, started by the worker after the move.
