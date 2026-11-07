# Trust fixes (task #4217) Implementation Plan

> Written by the Engineer by the project's way of working: superpowers writing-plans, then each task test first
> (test-driven-development), one pull request.

**Goal:** Six things the Swarm says or counts that it cannot back: fix each, with a test that fails without the fix.

**Architecture:** Each fix stays in the module that owns the behavior: Buddy news (`buddyNews.ts`, `taskLine.ts`,
`releases.ts`), assignment (`commands.ts`), liveness (`liveness.ts`), task approval (`commands.ts`), the Leaderboard
(`leaderboard/stats.ts`, `leaderboard/brought.ts`), and the CLI's Claude allowance reading (`cli/src/services/usage.ts`).

**Tech Stack:** TypeScript, vitest (backend), the CLI's spec runner, Flutter for the one Desktop line.

**Spec:** Task #4217's brief, from anh Dee's Buddy's review of main 0413586e.

## Verification (before any code)

| Finding | Verdict | Evidence |
|---|---|---|
| `conversation.merged` sends "shipped" with no release check (taskLine.ts:143) | Real | `moved()` sends `shippedNotice` when `ledger.mergedAt` is first set; `settleReleases` marks `released` later and tells only proposals. |
| Assigned news repeats for every replacement agent (commands.ts:1946) | Real | `assignTo` calls `assignedNotice` on every assignment; a lost task re-assigned tells the Buddy again. |
| "Which they requested" trusts an unproven field (buddyNews.ts:65) | Partly real | `requesterId` is checked only to be a person who reads the project; an agent may name anyone, and it wins over the request message's author. The Buddy states it as the person's own request. |
| Waiting at a person's prompt is lost as no progress (liveness.ts:268) | Real | `waitingOnPerson` reads only `needs_human`/`blocked`; a terminal at a permission prompt (`alerting: 'prompt'`, `agent.alert`) prints nothing, so its lease runs out. |
| `task.approve` names no agent (commands.ts:446) | Real | The command carries only the conversation; a `task.suggest` between the person's look and the tap approves an agent they never saw. |
| Leaderboard counts any done task as Shipped (leaderboard/record.ts:111) | Real | `recordStatus` sets `shippedAt` at Done; the board counts `shippedAt` plus any linked PR, merged or not. |
| Claude reports never expire; unknown counts as available (usage.ts, route.ts:495) | Real | `claudeReading` keeps a report however old, and a window whose reset passed reads as 0% used, so the route says it fits with all its allowance. |

## Global Constraints

- Never read or print a secret or a login. Clients from the last 30 days keep working.
- No new stored field; no new query.

## Review Focus

- The release path tells the Buddy once per release, by a stable id.
- The approval refusal cannot block a client that sends no agent (compatibility until 2026-12-07).

## Task 1: Shipped news only when a release holds the work

**Files:** `backend/src/superTabs/taskLine.ts`, `releases.ts`, `buddyNews.ts`, `releases.test.ts`
**Interfaces:** `settleReleases` adds `shippedNotice` drafts to `outcome.messages`.

- [x] Test: a merge sends the Buddy no shipped news; the settle that marks it released does, once.
- [x] Run it: fails (news at merge, none at release).
- [x] Move the notice from `taskLine.ts moved()` to `settleReleases`, authored by the project's lead.
- [x] Run it: passes.

## Task 2: Assigned news once per task

**Files:** `backend/src/superTabs/commands.ts`, `buddyNews.test.ts`

- [x] Test: a task lost and assigned to a replacement tells the Buddy once.
- [x] Run it: fails. Send the notice only on the task's first assignment (`ledger.firstAssignedAt` unset before it). Passes.

## Task 3: The Buddy says only what the server knows

**Files:** `backend/src/superTabs/buddyNews.ts`, `buddyNews.test.ts`

- [x] Test: the news says the task is in the person's name, not that they requested it.
- [x] Run it: fails. Change both notices' words. Passes.

## Task 4: A task at a person's prompt is not lost

**Files:** `backend/src/superTabs/liveness.ts`, `liveness.test.ts`

- [x] Test: a working task whose agent's terminal waits at a prompt, quiet past its lease, is not lost; once the prompt
      closes it is lost as before.
- [x] Run it: fails. `waitingOnPerson` also reads the agent's open `prompt` alert. Passes.

## Task 5: Approval names the agent shown

**Files:** `backend/src/superTabs/commands.ts`, `taskApproval.test.ts`, `desktop/lib/super_tabs/tasks/personal_tasks_pane.dart`, its test

- [x] Test: `task.approve` naming an agent other than the current suggestion is refused and approves nothing.
- [x] Run it: fails (schema refuses the field). Add `suggestedAgentId` (nullable, optional until 2026-12-07; compared, never read as an agent) and refuse a mismatch.
- [x] Desktop sends the agent it shows.

## Task 6: Leaderboard counts merges

**Files:** `backend/src/superTabs/leaderboard/stats.ts`, `leaderboard/brought.ts`, a stats test

- [x] Test: a done task with a linked, unmerged PR is not Shipped on the board.
- [x] Run it: fails. Count `ledger.mergedAt`. Passes.

## Task 7: Claude reports expire; unknown is unknown

**Files:** `cli/src/services/usage.ts`, `usage.spec.ts`

- [x] Test: a report older than an hour, and a window whose reset passed, read as unknown with a reason.
- [x] Run it: fails. Expire reports after an hour; leave a passed window out. Passes.
