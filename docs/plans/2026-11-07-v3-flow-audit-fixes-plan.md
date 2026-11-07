# v3 flow audit fixes Implementation Plan

> This plan is carried out by its Engineer task by task, test first (the project's Engineer rules): each task's failing
> test is committed and seen failing before the code that passes it. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix the bugs from the v3 flow audit (#4212) that no other task covers, each verified in code first, with a test
that fails without the fix (task #4252).

**Architecture:** Each fix is the smallest change at the layer where the behavior lives: the backend's command rules
(`commands.ts`, `machines.ts`), its reads (`read/personalTasks.ts`, `leaderboard/stats.ts`), and the CLI's quota report
(`hook/statusline.mjs`, `lib/quotaReports.ts`, `services/usage.ts`). No new data, no new command, no Desktop change.

**Tech Stack:** TypeScript backend and CLI, vitest.

**Spec:** the #4212 audit posts (findings 2, 3/18, 9, 10, 11, 12, 15, 20, 29); docs/specs/2026-11-07-swarm-v3.md.

## Triage of the 35 findings

| Finding | Became |
|---|---|
| 1, 7, 8 | #4248 (Flowp0) |
| 6 | #4194, merged |
| 16 | #4249 |
| 17, and the idea "dispatch skips idle Regular agents" | #4218 (its tasks 6 and 3) |
| 5, 19, 28 | #4220 |
| 35 (stale reports) | #4217 |
| 2, 3/18, 9, 10, 11 (server half), 12, 15, 20, 29 | this plan, tasks 1-9 |
| 13, 14, 21, 27, 11 (Desktop half), Regular name field, Bring agent seen early | Desktop only, outside this task's files: proposed to the PM as one Desktop task |
| 34 | not a bug: a contributed computer takes the Swarm's work by its person's choice, which is what contributing is |
| 4, 22, 23, 24, 25, 26, 30, 31, 32, 33, 35 (profile), batch 3 backend polish | polish, after these bugs |

## Global Constraints

- Owns backend/src/superTabs/ and cli/src/ (and cli/hook/statusline.mjs, which cli/src writes out at launch).
- Never read or print a secret or login. The quota report keeps only percentages and reset times.
- No new collection, field or command; older clients keep working (published contracts only extended).
- The person's own status line still prints unchanged; nothing in the recording may stop it.

## Design

- growth: none new. A declined proposal is already kept (archived); it now stays in its person's Tasks until it goes dormant.
- concurrency: the Swarm's single write per command, unchanged.
- read cost: Tasks reads only changed parts, as today; the Leaderboard reads the state it already holds.
- scale: unchanged.
- compatibility: backend first; CLI 0.5.63 hosts keep working. A report written by an older status line under the old key is
  read until the new one replaces it (task 3).
- migration and rollback: none; rolled back, the bugs return and no data needs undoing.
- audience: the server enforces it, unchanged. The Leaderboard's agent count is a number, not the agents.
- identity: unchanged; no start under another person's login.
- failure: each refusal names its cause (connecting, cleaning up) instead of a wrong one.
- platforms: backend (Linux in CI); CLI on macOS, Linux and Windows (path resolution in task 3).

## Review Focus

- A person who sets CLAUDE_CONFIG_DIR to `~/.claude` (the default) explicitly, or with a trailing slash: one report key.
- A report written before this change: still read (no "not reported yet" after updating).
- A declined proposal merged into another card: still leaves Tasks (it was merged, not declined).
- Approve when the suggested agent was removed: refused with a reason that says so, not a crash.
- Listing a computer while another person's start is pending there: still refused.

---

### Task 1: a declined proposal stays in Tasks with its reason (findings 3, 18)

**Files:** backend/src/superTabs/read/personalTasks.ts, backend/src/superTabs/commands.ts (`proposal.close`),
backend/src/superTabs/read/personalTasks.test.ts, backend/src/superTabs/taskApproval.test.ts

- [ ] Test (personalTasks.test.ts): an archived proposal card with `proposal.decision.kind === 'no'` is an upsert with
      `status: 'rejected'` and `reason` = the decision's reason; a merged one (`mergedInto`) is still removed. Watch it fail.
- [ ] Test (taskApproval.test.ts): `proposal.close` on an older-path proposal sends its sender the 'decided' notice, as
      `proposal.decide no` does. Watch it fail.
- [ ] personalTasksFor keeps a declined card; `proposal.close` pushes `proposalNotices(state, mirror, 'decided', …)`. Pass.

### Task 2: "agents brought" is one count for every reader (finding 2)

**Files:** backend/src/superTabs/leaderboard/stats.ts, backend/src/superTabs/read/service.ts,
backend/src/superTabs/leaderboard/weekly.test.ts

- [ ] Test: the weekly org board counts a member's idle Regular agent the same whether or not `visibleAgents` holds it.
      Watch it fail.
- [ ] Count from `state.agents` with the same filters; drop the `visibleAgents` input and its computation in service.ts. Pass.

### Task 3: the quota report has one key per Claude folder (finding 9)

**Files:** cli/hook/statusline.mjs, cli/src/lib/quotaReports.ts, cli/src/services/usage.ts, their specs

**Interfaces:** `claudeReportKey(configDir?: string, home = homedir()): string` in quotaReports.ts: '' for unset, empty,
or the default folder (`~/.claude`) however written; else the absolute path, resolved, real path where it exists, with no
trailing separator. statusline.mjs carries the same rule (it imports nothing of the CLI).

- [ ] Test: `~/.claude`, `~/.claude/` and unset give one report path; a moved folder with a trailing slash matches the one
      without. Watch it fail.
- [ ] Test: usage_read finds the report of the folder the login shell sets (launch environment), not the daemon's. Watch fail.
- [ ] Both sides use the rule; usage.ts reads `launchClaudeConfigDir()`'s variable through engineHomes' launch environment,
      and Codex's read the launch CODEX_HOME. A report under the old raw key is read when none is under the new. Pass.

### Task 4: a 5-hour usage above 100% reads as 100 (finding 10)

**Files:** cli/hook/statusline.mjs, cli/src/lib/quotaReports.ts, their specs

- [ ] Test: a status with `used_percentage: 103` records 100; a report file holding 103 reads as 100. Watch it fail.
- [ ] Clamp to 100 in both `windowOf`s; a negative or non-number stays refused. Pass.

### Task 5: + New agent on a computer with no reading yet says it is connecting (finding 11, server half)

**Files:** backend/src/superTabs/commands.ts (`agent.new`), backend/src/superTabs/agentNew.test.ts

- [ ] Test: a listed computer with no `observation` refuses a Regular agent with `HOST_CONNECTING` and a "still connecting"
      text, not `HOST_OUTDATED`. Watch it fail. Pass with the one branch.

### Task 6: your own Buddy starting doesn't block listing your computer (finding 12)

**Files:** backend/src/superTabs/commands.ts (`machine.contribute`), backend/src/superTabs/agentNew.test.ts

- [ ] Test: the person's Buddy start pending on their Buddy-only record; `machine.contribute` of that computer succeeds and
      the start carries over (`poolGeneration` = the new generation), so it still settles. Another start pending still
      refuses. Watch it fail.
- [ ] Only the actor's own Buddy starts on a Buddy-only record of theirs are carried over. Pass.

### Task 7: rejoining while the old contribution cleans up says so (finding 15)

**Files:** backend/src/superTabs/machines.ts (`machineContribution`), backend/src/superTabs/leadStart.test.ts

- [ ] Test: a rejoined person's computer whose old record is still being removed refuses Bring agent with
      `MACHINE_CLEANING` ("finishing its cleanup"), not "withdrawn". Watch it fail. Pass.

### Task 8: Approve records consent; availability is the assignment's (finding 20)

**Files:** backend/src/superTabs/commands.ts (`task.approve`), backend/src/superTabs/taskApproval.test.ts

- [ ] Test: approving while the suggested agent is busy records `approved`; the PM's later work.assign still checks it.
      A removed suggested agent refuses with `SUGGESTED_AGENT_GONE`. Watch it fail.
- [ ] Approve checks the agent exists and is readable, not its availability. Pass.

### Task 9: a Regular agent may say "Thanks!" in its own chat (finding 29)

**Files:** backend/src/superTabs/commands.ts (`message.send`), backend/src/superTabs/agentNew.test.ts

- [ ] Test: a Regular agent's "Thanks!" in its agent chat is posted; in a task it is still ACK_ONLY. Watch it fail.
- [ ] The agent chat is exempt as a Buddy chat is. Pass.
