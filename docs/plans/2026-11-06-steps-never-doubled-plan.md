# Review and test steps are never doubled, and only Reviewers and Testers get them (task #3602)

> Implemented by its Engineer test first, by superpowers:test-driven-development, as the project's instructions say
> (Engineer role). No subagent-driven-development and no execution handoff.

**Goal:** On 11-06 #3561 got Security review 1, Security review 2 and Test from the server and then review, review and test from
its Engineer (two duplicates cancelled by the PM). #3576's Test step went to an Engineer whose own task was in review, on a Mac
only, when its check needed a Mac and a Linux machine.

**Architecture:**
1. Doubling: the server's openReviewSteps already reuses an open step of the same name or kind, whoever opened it. The other
   order was open: an agent's `conversation.create` with `reviewOf` and `step` is refused (STEP_OPEN, naming the open step) when
   the task already has an open step of the same name, or the server already opened an open step of that kind. Server steps are
   marked when opened (`openedBy: 'server'`). An agent's own second step of a kind under another name ("Security review 2")
   still opens.
2. Who gets a step: the server's pick (reviewerPick.ts reviewerCandidates) takes only the step's role, Reviewer for a review or
   security step and Tester for a test step; no other free agent stands in. A test step needs the machines its check names:
   "a Mac", "a Linux machine". When it names more than one, one test step opens per machine ("Test on a Mac", "Test on a Linux
   machine"), each given only to a Tester on that OS (the machine's reported `os`). One nobody can take stays open, and the PM
   hears it once, as today.
3. Not a refusal on `work.assign`: the server refuses only facts and access (removedRefusals.test.ts pins ROLE_* and
   REVIEWER_NOT_ASSIGNABLE as removed); a person or the PM may still hand a step to anyone.

**Tech Stack:** TypeScript, vitest.

**Spec:** task #3602's brief (River, 11-06).

## Global Constraints

- removedRefusals.test.ts stays green.
- The step names and checks stay readable for the Engineer and the reviewer.

## Design

- growth: one marker on a server-opened step; per-OS test steps replace one, never more than the OSes named.
- concurrency: inside the command's transaction, as steps open today.
- read cost: none added; the pick already reads agents and machines.
- scale: candidates filtered by role and OS before ranking; linear in agents, as today.
- compatibility: an older step has no marker and counts as the Engineer's; an older client sees ordinary steps.
- migration + rollback: none.
- audience: n/a, no new data exposed.
- identity: agents by id and role; machines by their own report.
- failure: a refused step names the open one to use; a step nobody may take stays open and the PM hears it.
- platforms: picks by the OS each machine reports (macOS, Linux, Windows).

## Review Focus

- No path still doubles a step; a legitimate second step of a kind still opens.
- No Engineer, Guide or other role is picked for a step; a test step's OS is right.

## Task 1: steps are never doubled

**Files:** backend/src/superTabs/commands.ts (conversation.create with reviewOf, openStep), tests in reviewSteps.test.ts.

- [ ] Failing test: an agent's step after the server's of the same kind, or of the same name, is refused, naming the open one;
  an agent's own second step under another name opens; the server reuses an agent's open step.
- [ ] Code.

## Task 2: only Reviewers and Testers, on the OS a test needs

**Files:** reviewerPick.ts, reviewTable.ts (OS needs from `where`), commands.ts openReviewSteps; tests in reviewerPick.test.ts and
reviewSteps.test.ts.

- [ ] Failing test: an Engineer (or another role) is never picked for a step; a test step whose check names a Mac and a Linux
  machine opens one step per OS, each given only to a Tester on that OS.
- [ ] Code.
