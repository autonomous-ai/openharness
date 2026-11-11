# Agent model A, backend: a Member per person and project: implementation plan

> This plan is carried out by the project's Engineer way of working (test first, task by task, one pull request), not
> subagent-driven-development. There is no execution handoff.

**Goal:** Task #4697, part A of #4693 (anh Dee 11-07 21:20). A person's first accepted task in a project creates their
Member for it. That project's tasks they ask for go to that Member one at a time, and it sleeps between them. A helper
starts only when three checks hold; otherwise the task waits by priority, then age. Every task a person asks for needs
their Accept, and Accept all is refused for subscription accounts.

**Architecture:** One new file, `members.ts`, holds the rules as pure functions over the loaded state. Commands call
them: `task.approve` (the first Accept starts the Member), `member.approvalMode` (Accept all refused), `work.status` (an
ended task puts the Member to sleep, or ends a helper when nothing waits) and a new `member.helper` command. The store's
dispatch pass (`store.ts dispatchCrew`) gains a Member pass: a free Member or helper gets its person's next task
through `work.assign`, sent as the project's Lead as crew picks are, and a waiting task that passes the three checks
gets a `member.helper`. A Member is a Regular agent (`regular`) with `mainProjectId` set and the person as contributor.
A helper also carries `helperOf` (its Member) and `helperFor` (its first task). Both start only on the person's own
listed computer, recorded with the person as machine owner, so the host's grant check at dispatch refuses any other.

**Tech Stack:** TypeScript backend, vitest.

**Spec:** Task #4697's brief; #4693; `docs/specs/2026-11-07-members-and-leads.md` (replaced in its Members part by
#4693).

## Global Constraints

- A Member and its helpers run only on their person's own computer and account: a listed, own, non-Team machine of the
  person, with the person as contributor and machine owner.
- One Member per person and project. Its name is "<free agent name> · <project>".
- One task at a time per agent (the existing `occupiesAgent`).
- Helper checks, all three: the task's owned paths overlap none of the paths of the person's work running in that
  project (no owned paths cannot be told apart, so no helper); the Member's computer has a free slot under its limit
  (`availableSlots`); the engine's quota there is known and every window is above `QUOTA_FLOOR_PERCENT`.
- Waiting order: priority (P0 first, P2 when unset), then age (lower task number first).
- A person's tasks go to their Member and helpers, never to another person's crew agent.
- Accept (River's call, option 2): Accept all is refused unless every engine account on the person's computers is an API key
  (known quota with no windows), and a stored Accept all on a subscription account stages tasks. Accept on every task by
  default, with the test sweep it needs, is its own follow-up pull request.
- A person whose own crew agent works in the project keeps it taking their asks until the migration (#4693 part D).
- Host contract with #4698 (Threadland): starts carry `member`, `helperOf` and `setUpSteps`; the agent keeps `member` and
  `helperOf`; `agent.setUp` records the set-up, and a host saying `memberSetUp` gets work only after it.

## Review Focus

- A person with no computer in the Swarm accepts a task: no start is made, the task's chat says why, nothing breaks.
- A helper is asked for while another helper for the same task is starting: never two.
- A Member's computer goes offline: no helper is started there.
- Another person's agent never gets a task someone else asked for, by dispatch or by a helper.
- A task with no requester (found by the Lead) still goes to crew as before.

---

### Task 1: Accept all only for API accounts

**Files:** `members.ts` (`mayAcceptAll`), `taskApproval.ts` (`stageTaskApproval`), `commands.ts`
(`member.approvalMode`). Test: `members.test.ts`.

- [ ] Failing tests: Ask me stages; Accept all is refused for a subscription or unknown account
  (`ACCEPT_ALL_SUBSCRIPTION`) and allowed for API-only; a stored Accept all on a subscription account still stages.
- [ ] Implement; run; commit.

### Task 2: The first Accept starts the person's Member

**Files:** `members.ts` (`memberOf`, `memberMachine`), `commands.ts` (`task.approve`, `agent.started` copies
`helperOf`/`helperFor`), `model.ts` (fields). Test: `members.test.ts`.

- [ ] Failing tests: the first Accept makes one start on the person's own computer, named "<name> · <project>",
  `regular` with `mainProjectId`; a second Accept makes none; no own computer posts one line in the task's chat and
  starts nothing; another person's or a Team machine is never used.
- [ ] Implement; run; commit.

### Task 3: The Member takes its person's tasks one at a time and sleeps between them

**Files:** `members.ts` (`memberQueue`, `memberPlan`), `store.ts` (Member pass), `commands.ts` (`work.status`),
`dispatch.ts` (crew skips asked tasks). Test: `members.test.ts`, `integration/crewDispatch.test.ts`.

- [ ] Failing tests: the queue orders by priority then age; a free Member is planned its person's next task; a busy one
  is not; a crew agent is never planned an asked task; an ended task with nothing waiting puts the Member to sleep, and
  its next assignment wakes it.
- [ ] Implement; run; commit.

### Task 4: Helpers by the three checks, ended when nothing waits

**Files:** `members.ts` (`helperCheck`), `commands.ts` (`member.helper`, `work.status`). Test: `members.test.ts`.

- [ ] Failing tests: each check alone refuses (overlap, no room, quota at the floor or unknown); all three pass starts
  one helper for that task, on the Member's computer and account; a second request while it starts makes none; a
  helper's ended task with nothing waiting stops it; a free helper is planned the next task only when it overlaps no
  running work.
- [ ] Implement; run; commit.
