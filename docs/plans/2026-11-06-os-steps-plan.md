# A step named for an OS goes only to an agent on that OS: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** A step named for an OS ("Test on a Linux machine", "Test on a Mac", "Test on a Windows machine") is handed on,
assigned and routed only to an agent on a machine reporting that OS. With none free, the step waits, says so in its own
conversation ("No Linux Tester free"), and the PM is told once (task #3926, found by the PM 11-06: with daniel-pc's Linux
Testers down, #3872's Linux step went to WinTest3348 on Windows and #3861's to Wintest2 on macOS, and both stalled).

**Architecture:** The OS is read from the step's name only (`stepOs`, reviewTable.ts, beside `osesIn` and `reportsOs`): a
step whose name names exactly one OS. A step without one changes in nothing (the brief's constraint), including a plain
"Test" whose plan carried an OS: that one is matched where it is first opened, as today.

- Handed on (the bug): dispatch.ts `candidatesFor` asks `reviewerCandidates` for a lost step's agents without its OS, so any
  free Tester matched. It passes `stepOs(step)`.
- Assigned: commands.ts `assignRefusal` (work.assign, the server's own review-step and dispatch picks) refuses an agent whose
  machine does not report the step's OS: `STEP_OS`, naming the step's OS and the machine's.
- Routed: route.record's `candidateRefusal` gives the same refusal, so a wrong-OS candidate moves to the decision's exclusions
  with its reason, as a Team-work refusal does; and agent.start for such a step refuses a machine of another OS.
- Waits and says so: when a lost OS step has no free agent of its OS (`reviewerCandidates` with the OS is empty), the loss
  row the PM already gets once (liveness.ts `loseTask`) adds "No Linux Tester is free: the step waits for one", and the step's
  own conversation gets the row "No Linux Tester free: this step waits until one is.", by the loss's stable id, so a later
  sweep writes nothing again.

One function says what a machine reports: `machineOs(state, machineId, contributorId?)`, the pool's own reading (a Team
account's pool reports its own), as reviewerPick.ts reads it today.

**Tech Stack:** TypeScript backend (vitest).

**Spec:** task #3926 brief.

## Global Constraints

- No change to steps without an OS in their name.
- A machine the Swarm does not list, or one with no reading, reports no OS: it never takes an OS step (as reviewerPick.ts).
- Owns backend/src/superTabs/. No client change: the step's row carries the words.

## Design

- growth: N/A because nothing new is stored: one system row per lost OS step with nobody free, by the loss's id.
- concurrency: N/A because every check runs inside the existing command or sweep write.
- read cost: N/A because it reads only the loaded state (the machine list and agents already loaded).
- scale: one more candidate filter per step per dispatch pass; the pass is already bounded by DISPATCH_TRIES.
- compatibility: a new refusal code `STEP_OS` on work.assign and agent.start, which clients show as any refusal's message.
- migration and rollback: none; revert the commit.
- audience: the server enforces it; the rows go to the step's conversation and the PM as the loss row does.
- identity: N/A because no work runs under anyone new.
- failure: the refusal names the step's OS and the machine's; a waiting step says why.
- platforms: backend only (Linux CI).

## Review Focus

- Every path that gives a step an agent goes through `assignRefusal` (work.assign, `openReviewSteps`, dispatch's work.assign).
- `stepOs` reads only the name, so no existing step without an OS changes.

## Task 1: a lost OS step is never handed to an agent of another OS

**Files:** backend/src/superTabs/reviewTable.ts, dispatch.ts, commands.ts, stepOs.test.ts (new).

**Interfaces:** `stepOs(step: Pick<Conversation, 'step' | 'title' | 'reviewOf'>): StepOs | undefined`;
`machineOs(state, machineId, contributorId?): string | undefined`.

- [ ] Test: a Linux step whose Linux Tester was lost, with a Mac Tester and a Windows Tester free, is in neither one's
      dispatch candidates; work.assign of either is refused STEP_OS; a free Linux Tester gets it. A plain "Test" step
      still goes to any free Tester.
- [ ] Watch it fail.
- [ ] Code: `stepOs`, `machineOs`; `candidatesFor` passes the OS; `assignRefusal` refuses.
- [ ] Watch it pass; commit.

## Task 2: routing and starts keep to the step's OS

**Files:** backend/src/superTabs/commands.ts, stepOs.test.ts.

- [ ] Test: route.record for a Linux step moves a Mac candidate to its exclusions with the reason, and refuses when every
      candidate is of another OS; agent.start for it on a Mac is refused STEP_OS.
- [ ] Watch it fail.
- [ ] Code: `candidateRefusal` and agent.start call the same OS refusal.
- [ ] Watch it pass; commit.

## Task 3: with no Tester of its OS free, the step waits and says so; the PM is told once

**Files:** backend/src/superTabs/liveness.ts, stepOs.test.ts.

- [ ] Test: the Linux Tester's machine goes offline with no other Linux Tester: the PM's loss row says no Linux Tester is
      free, the step's conversation has "No Linux Tester free", and a second sweep writes neither again.
- [ ] Watch it fail.
- [ ] Code: `loseTask` adds both for an OS step with no candidate of its OS.
- [ ] Watch it pass; commit.
