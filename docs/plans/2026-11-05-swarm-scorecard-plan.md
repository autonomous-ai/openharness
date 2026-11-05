# Daily Swarm scorecard — Plan

**Goal:** Each night the server computes, for every project of every Swarm, one scorecard row for the project's local day,
from the Swarm's own records. It stores the row and Desktop shows the last days as a small table, so each process change
can be judged by numbers, day over day (anh Dee, task #3386).
**Architecture:** A pure function turns one project's records for one local day into figures (`scorecard/figures.ts`). A
reader gathers those records from Mongo on the secondaries (`scorecard/records.ts`). A worker pass every 15 minutes
computes each finished day that has no row yet, for the last two days, and stores it (`scorecard/job.ts`, collection
`SuperTabScorecard`). The read route returns rows the reader may see, and Desktop shows them under Manage → Scorecard.
The first pass after release fills 11-04 and 11-05 by itself; the PR's baseline comes from the same code run read-only
against production (`backend/scripts/scorecard-baseline.ts`).
**Tech Stack:** Fastify backend, Prisma on MongoDB (raw finds on indexes), vitest; Flutter Desktop with memory-store tests.
**Spec:** Task #3386 (Dee, P1). Engineer works this plan test-first itself, task by task, one PR.

## Figures (one row per project and local day)

| Figure | From |
| --- | --- |
| `asksShipped`, `askToShipMinutes` (median, max) | tasks (number, no `reviewOf`) whose `ledger.shippedAt` is in the day; `shippedAt − askedAt` |
| `unansweredAsks`, `oldestUnansweredAskMinutes` (at day end) | people's top-level posts in the project chat in the 7 days before day end with no answer by then: no agent reply in their thread or `replyTo`, no delivery `answeredAt`, no task opened from them (`cards.line` / `ledger.proposal`) |
| `idleMinutes` | minutes of the day with no task or step Working while one open task waits (no assignment, planned or lost), from each task's timeline: `ledger.runs[].at` (assigned, working), status rows (`source.status`), `work-lost` rows, cancel rows |
| `lostLeftAlone`, `lostLeftMinutes` | `work-lost` rows of the day whose task got no next event (assignment, status, route, start) within 10 minutes; minutes past those 10 |
| `fixesAfterMerge` | tasks whose `ledger.fixedAfterMergeAt` is in the day (the Swarm's record of a merged change that needed a fix: reverts) |
| `corrections` | people's posts in the project's conversations that reply to (or quote) a post of the project's PM |
| `starts`, `startsFailed` | `SwarmStart` rows of the project's conversations requested in the day; failed = `data.error` |
| `routeDecisions` | `SuperTabRouteDecision` rows of the project's conversations created in the day |
| `typedIntoPm` | `terminal-input` rows naming the PM's agent, created in the day |
| `ackPosts`, `agentPosts` | agents' own posts (no `source`) of the day; ack = text that is only an acknowledgement ("on it", "taken", "confirmed", "thanks", "done", …) |

The limits each figure uses (10 minutes for a lost task, 7 days for an unanswered ask) are written into each row with
its figures, so a row says what it measured and a later change of limit never reinterprets an old row.

## Design (feature design rules)

- **Growth:** one row per project per local day, about 1 KB. Rows older than 120 days are deleted by the job's own
  pass (`deleteMany` on `[tabId, projectId, on]`); a Swarm's rows go with its purge (`purge.ts PURGED_BY_TAB_ID`).
- **Concurrency:** the job runs only in the singleton worker, one pass at a time. The write is an upsert by the row's
  stable id (`stableId('scorecard', tabId, projectId, on)`), so a pass that runs twice writes the same row once.
- **Read cost:** the job reads only groups active in the day (`[tabId, projectId, dormant, lastActivityAt, key]`), each
  group's messages backwards from its newest until the day starts plus one earlier status row (capped at 5,000 rows a
  task, 20,000 for the project chat's 7-day ask lookback), route decisions by `[tabId, createdAt]`, starts by `[tabId, changedAt]`, deliveries by `[tabId, messageId]`.
  All on the secondaries. Candidates: one `$group` over `SwarmGroup [dormant, lastActivityAt]` (groups active in the last
  7 days), read again every 3 hours. The Desktop read is one
  indexed find of at most 14 rows per project.
- **Scale:** 10x projects = 10x one small pass per project per day, spread over the night by time zone. The warning
  metric is the pass's logged duration and `capped` count (a group that hit the 5,000-row cap).
- **Compatibility:** new collection, new route, new Desktop tab. An older Desktop never asks; a new Desktop on an older
  backend gets 404 and shows "The scorecard needs a newer Harness server."
- **Migration + rollback:** no migration. Rollback: revert the PR; the collection is left and can be dropped.
- **Audience:** the server returns only projects the reader may read (`canReadProject`); Team sessions are refused, as
  for the leaderboard. Rows hold counts and minutes only: no text, names or ids.
- **Identity:** the job reads as the server; no person's login is used.
- **Failure:** a project whose computation fails is logged with its Swarm and project ids and retried on the next pass
  (at most 4 times a night); its day then shows as missing in the table, not as zeros.
- **Platforms:** backend (Linux). Desktop on macOS, Windows, Linux, web through the shared Flutter screen.

## Global Constraints

- Swarm code stays in `backend/src/superTabs/` and `desktop/lib/super_tabs/` (plus the one route line, the worker
  start, the schema model and the purge list). Nothing in `cli/src/core`.
- No new refusal of any command; the job only reads and writes its own rows.
- No switch: it ships on.
- Desktop tests use a memory store and a fake sign-in; nothing signs the Mac's CLI out.

## Review Focus

- Each figure's definition against fixture records (edge cases at day bounds and time zones).
- The job reads only indexed paths and has bounded pages; no read of a whole Swarm's history.
- The read route's audience check.

## Tasks

- [ ] 1. `scorecard/figures.ts` `scorecardDay(input)`: tests in `scorecard/figures.test.ts`, one per figure, from fixture
  groups, message rows, starts and route decisions (failing first), including day-bound and time-zone cases.
- [ ] 2. Cancel rows carry `status: 'cancelled'` in their source (`commands.ts work.cancel`) so the timeline sees a cancel:
  test in `commands.test.ts`.
- [ ] 3. `scorecard/records.ts` gathers one project's day from Mongo; `scorecard/store.ts` writes, prunes and reads rows;
  Prisma model `SuperTabScorecard`, purge list entry. Tests against the test database (`scorecard/records.test.ts`).
- [ ] 4. `scorecard/job.ts` `startScorecards`: due days per project time zone, candidates, settle set, retries; started
  in `worker.ts`. Tests with a fake clock (`scorecard/job.test.ts`).
- [ ] 5. Read route `GET /api/super-tabs/:tabId/scorecard?projectId=&days=` through `read/service.ts`: audience test.
- [ ] 6. Desktop: `super_tabs/scorecard.dart` reader and table, Manage → Scorecard tab; widget tests with a memory
  store (rows, missing day, older server), light and dark screenshots.
- [ ] 7. `backend/scripts/scorecard-baseline.ts`: the same code read-only against production for 11-04 and 11-05;
  table posted in the PR.
