# Windows test steps open only where a Windows machine can take them: implementation plan

> This plan is carried out by the project's Engineer way of working (test first, task by task, one pull request), not
> subagent-driven-development. There is no execution handoff.

**Goal:** A Ready opens a Windows test step only when an own-account Windows machine can take it. Otherwise the task says
"No Windows machine: a person's Windows check is owed.", and the step opens by itself within 30 seconds of such a machine
showing up. This is task #4410, which applies #4278's Linux rule to Windows.

**Architecture:** #4278 (PR #3484) made a Linux step wait for a Linux machine: `linuxSteps.ts` (`testsOnLinux`,
`waitForLinux`, `openWaitingSteps`), the task's `waitingLinuxStep`, a branch in `commands.ts openReviewSteps`, and the time
checks' pass (`store.ts runTimeChecks`). The same functions now take the OS, `linux` or `windows`, in `osSteps.ts`, which
replaces `linuxSteps.ts`. A task keeps one waiting step per OS: `waitingLinuxStep`, as already stored, and
`waitingWindowsStep` beside it, so no stored task needs a migration. Mac steps never wait.

**Tech Stack:** TypeScript backend, vitest.

**Spec:** Task #4410's brief; #4278's plan (`docs/plans/2026-11-07-linux-test-steps-plan.md`).

## Global Constraints

- Backend only.
- The Windows rules are not weakened: the card says a person's Windows check is owed. No CI run stands in for Windows.
- Mac and Linux behaviour unchanged: Linux keeps its line, its stored field and its message ids.
- A step the PM closed stays closed at later heads.

## Review Focus

- A task that needs both a Linux and a Windows step, with neither machine there: both wait, each line is said once, and
  each step opens when its own OS's machine shows up.
- A Windows machine that is another person's with no project agent, on a Team account, offline, paused, or kept for other
  projects does not count, as for Linux.
- A task stored by the current release with `waitingLinuxStep` still opens its Linux step.

---

### Task 1: The Linux step tests, run for Windows too

**Files:**
- Modify: `backend/src/superTabs/linuxSteps.test.ts`: each case runs for `linux` and `windows`. Windows uses project rules
  that test `cli/**` on a Mac and on a Windows machine.
- Modify: `backend/src/superTabs/parts/light.test.ts`: the light projection keeps `waitingWindowsStep`.

- [ ] **Step 1: Write the failing tests.** For Windows: with only a Mac, the Ready opens `Review` and `Test on a Mac`, and
  the task says "No Windows machine: a person's Windows check is owed." once. Every unreachable machine counts as none. The
  PM's own Windows computer, or another person's with their own project agent, opens `Test on a Windows machine`. A closed
  step stays closed. A waiting step opens at the recorded head, and the PM hears about it once. Plus one case where both
  OSes wait.
- [ ] **Step 2: Run** `npx vitest run src/superTabs/linuxSteps.test.ts src/superTabs/parts/light.test.ts`. Expected: the
  Windows cases fail (the Windows step opens with no Windows machine); Linux passes.
- [ ] **Step 3: Commit.**

### Task 2: OS test steps wait for their OS's machine

**Files:**
- Rename: `linuxSteps.ts` → `osSteps.ts`, `linuxSteps.test.ts` → `osSteps.test.ts`
- Modify: `osSteps.ts`, `commands.ts` (`openReviewSteps`), `store.ts` (import), `model.ts` (`waitingWindowsStep`),
  `parts/light.ts` (`GROUP_FIELDS`), `stepOpen.ts` (comment), `reviewTable.ts` (export `OS_PLACE`)

**Interfaces:**
- `type WaitingOs = 'linux' | 'windows'`; `waits(os?: StepOs): os is WaitingOs`
- `WAIT_LINE: Record<WaitingOs, string>`: the Linux line unchanged.
- `testsOn(state, project, now, os: WaitingOs): boolean`, which replaces `testsOnLinux`
- `waitFor(task, step, pulls): boolean`, which replaces `waitForLinux` (the OS is `step.os`); `stopWaiting(task, os)`
- `openWaitingSteps(state, now): MessageDraft[]`, which opens each OS's waiting step

- [ ] **Step 1: Implement.** The Linux message ids stay `stableId(operationId, 'linux-wait')` and
  `stableId(task.id, 'linux-step', …)`.
- [ ] **Step 2: Run** the Task 1 tests and `integration/superTabReviewSteps.test.ts`. Expected: PASS.
- [ ] **Step 3: Commit.**
