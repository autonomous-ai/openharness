# Windows test step implementation plan

> **Execution:** Native implementation in this Engineer session, test first, followed by one independent pull request review. No subagent handoff or approval wait.

**Goal:** Ready Desktop and Windows-capable CLI changes automatically receive a Windows test step.

**Architecture:** Extend the existing review planner with a Windows requirement for shared Desktop code, native Windows code and CLI source. Preserve saved test rules and existing Mac/Linux steps; reuse the OS-aware independent Tester routing. Keep named OS steps from being reused for another OS.

**Tech Stack:** TypeScript, Vitest, existing Super Tab command reducer and observed machine resources.

**Spec:** Task #3778, conversation `8ce6034c6df4aaa55d8566fa`; AGENTS.md Windows rules and docs/windows-rules.md.

## Global constraints

- The step is named `Test on Windows`, uses a Swarm Windows machine and an independent Tester.
- Its brief requires docs/windows-rules.md, no unwanted window even momentarily, and a recording in the person's real Windows session on the signed build.
- Docs-only, backend-only, tests-only and Mac-only Team account scripts get no Windows step. Shared Team setup and Windows Team code still do.
- Preserve existing project test rules, access checks, Team-account boundaries and review independence. No schema, query, release or production changes.
- Run affected unit tests and typecheck locally; full backend and Super Tab integration suites run in Ready PR CI.

## Review focus

- Saved rules predating Windows support must still receive the new step.
- Mac-only file exclusions must not exclude shared Team code or names such as machineResources.
- Without an eligible Windows Tester the step stays open, never assigned to a Mac or the Engineer.
- Repeated Ready reuses the Windows step; adding another OS must not consume it through kind-based fallback.
- A custom Windows test row must not produce duplicate Windows steps.

## Task 1: Plan and route Windows tests

**Files:** Modify `backend/src/superTabs/reviewTable.ts`, `backend/src/superTabs/commands.ts`; test `reviewTable.test.ts`, `reviewSteps.test.ts` alongside them.

**Interfaces:** Preserve `reviewPlan(files, rules): PlannedStep[]` and `stepBrief(step, task): string`. Windows plans have `os: 'windows'`; existing `reviewerCandidates(..., os)` and assignment authorization remain the routing boundary.

- [x] Commit failing planner cases for desktop/lib, desktop/windows and CLI process/paths/Buddy/setup/daemon code; assert one Windows step, exclusions and custom-rule deduplication.
- [x] Commit failing command cases proving Windows assignment, independent Tester selection, missing-seat behavior, repeated Ready and OS-safe reuse. Brief must carry the recording requirements.
- [x] Run `npm --prefix backend test -- src/superTabs/reviewTable.test.ts src/superTabs/reviewSteps.test.ts` and record behavioral failures before production changes.
- [x] Implement the minimal Windows path classification and extra step, Windows brief, and OS-safe reuse of named test steps. Keep existing Mac/Linux names and requirements.
- [x] Run those files plus direct importer tests (`commands`, `dispatch`, `reviewerPick`, `teamWritten`) and `npm --prefix backend run typecheck`; inspect every failure.
- [ ] Commit/push the passing change, record red/green evidence in the PR, mark Ready and record the acceptance check at the full head on main. Independent review runs while CI runs.

## Task 2: Keep Windows routing after a lost Tester

**Files:** Modify `backend/src/superTabs/dispatch.ts`; test `backend/src/superTabs/dispatch.test.ts`.

**Interfaces:** Lost-step recovery passes the named test step's OS to the existing `reviewerCandidates` filter. Ordinary tasks and unnamed steps retain their current routing.

- [x] Commit a failing dispatch test: a lost `Test on Windows` step passes over a Mac Tester for a Windows Tester, or waits if none is available.
- [x] Observe the wrong-Mac assignment before the fix with the focused dispatch test.
- [x] Pass the named step OS through recovery, then run dispatch, reviewerPick, reviewSteps, reviewTable, commands and teamWritten tests and typecheck.
- [ ] Commit/push and include this red/green evidence with Task 1 before Ready.
