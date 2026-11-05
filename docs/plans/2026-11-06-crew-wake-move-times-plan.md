# The Swarm measures how long a crew member takes to wake or move: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** Each wake and each move of a crew member is recorded when it finishes, with its start, the moment the agent runs
again and its reason. The daily scorecard shows the median and slowest wake and move of the day, so "wakes in seconds" and
"moved and running again within 5 minutes" are measured (task #3462, requested by Dee through Harness).

**Architecture:** Built on #3229 (crew sleep, wake and move: `crewKeep.ts`) and #3212 (the daily scorecard: `scorecard/`),
both open; this branch merges their heads and its own commits come after. A finished wake or move is one row in the
project chat, coordinator-only (`NOTICE_READERS` `crew-timing`: `agent`), whose source carries
`{ kind: 'crew-timing', what: 'wake' | 'move', agentId, startedAt, runningAt, reason }`. The scorecard already reads the
project chat's rows of the day (scorecard/records.ts), so the figures need no new read and survive the member's removal.

- **Wake:** starts when work.assign wakes an asleep member (`wakeCrewMember`): the agent gets `crewWaking { at, conversationId }`.
  It finishes in the crew sweep on machine reports (store.ts, beside `applyCrewKeep`) when its machine's reading lists the
  session running again (`runningHarnessIds`), at that reading's time. Reason: the task that woke it (`work #N`).
- **Move:** starts when the keeper picks a machine (`movedTo.at`); finishes when the new session starts and takes the member
  over (`takeOverCrewMember`, agent.started), at that command's time. Reason: the move's trouble (offline, signed-out, quota,
  disk).
- **Scorecard:** `crewWake` and `crewMove` figures, each `{ count, medianSeconds, slowestSeconds }` (nulls with none), from
  the day's `crew-timing` rows.
- The crew check is `crew.ts isCrew`; `crewKeep.ts`'s second copy (`isCrewMember`) goes (brief).

**Tech Stack:** TypeScript backend (vitest unit tests; the Super Tab integration suite runs in PR CI).

**Spec:** task #3462 brief and its two acceptance checks.

## Design

- growth: one row per finished wake or move in the project chat (a few a day per member); rows age as any chat row.
  `crewWaking` is cleared when the wake finishes, or by the next sleep.
- concurrency: the wake starts in work.assign's write and finishes in the sweep's write of the same Swarm; a move finishes in
  agent.started's write. No new lock.
- read cost: none new: the scorecard reads the project chat's day already; the sweep reads only the loaded agents.
- scale: 10x crew is 10x rows a day, still small next to the chat's own rows (CHAT_ROW_CAP 20,000 over 7 days).
- compatibility: older clients do not show the row (coordinator-only notice); older scorecard rows have no crew figures and
  read as none.
- migration + rollback: none; rolling back leaves rows nobody reads.
- audience: the server writes the row; its times come from the server's own clock and machine readings, never a client.
- identity: N/A because nothing here acts as a person.
- failure: a wake whose session never runs again is not recorded and is not counted; the scorecard counts only finished
  ones and says how many (count).
- platforms: backend only.

## Global Constraints

- Owns backend/src/superTabs/ only. Swarm code stays out of cli/src/core.
- Numbers none new. No new refusal code.
- Tests use fixture events and fixed clocks; temp files only in mktemp -d folders.

## Review Focus

- A wake is timed from the assignment that woke it to the first reading that shows the session running, not earlier.
- A move is timed from the keeper's pick to the takeover, and the row survives the old agent's removal.
- Median and slowest are right for odd, even and empty days.

## Task 1: a wake and a move are timed from start to running

**Files:** backend/src/superTabs/crewTimes.ts (new), crewTimes.test.ts (new), crewKeep.ts, commands.ts, store.ts, model.ts

**Interfaces:** `startWake(agent, conversationId, now)`, `finishedWakes(state, now): MessageDraft[]`,
`moveTimingRow(state, from, moved, now): MessageDraft | null`, `crewTimingOf(source)`.

- [ ] Test: work.assign wakes an asleep member and marks `crewWaking`; a reading without the session finishes nothing; the
  first reading with it writes one row with startedAt, runningAt and the reason, and clears the mark.
- [ ] Test: a move's takeover writes one row timed from `movedTo.at` to the takeover, with the trouble as reason.
- [ ] Test: crewKeep uses `isCrew` (one crew check).
- [ ] Code.

## Task 2: the scorecard shows median and slowest wake and move times

**Files:** backend/src/superTabs/scorecard/figures.ts, figures.test.ts

- [ ] Test: from fixture rows, median and slowest per kind, odd and even counts, rows outside the day ignored, none -> nulls.
- [ ] Code.
