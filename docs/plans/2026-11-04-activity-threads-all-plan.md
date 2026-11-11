# Activity › Threads lists every thread you took part in — plan

> Way of working: this project's Engineer role (project instructions): plan first, each plan task test first, one pull
> request, one review step. No Execution Handoff.

**Goal:** Darren (11-04, task #2835, follow-up to #2929): Activity's Threads tab lists every thread the person follows
(started, replied in, tagged in, or followed), across their projects: unread ones on top as today, then read ones below,
plainly, newest reply first. Each row: project, thread title, last replier and time. Clicking opens the thread beside its
chat. Paged: the first 50 read threads, the next 50 on scroll. No change to counts or the red badge.

**Architecture:** the server's followed-threads read (`backend/src/superTabs/read/followedThreads.ts`) already answers
`unread` and up to 30 `read` threads; Desktop reads both (`attention.dart`) and shows only `unread`
(`activity.dart threadRows`). So: the read takes how many read threads to answer (`?read=N`, 1 to 250, default 30 as
today), and Desktop asks for 50 more each time the list reaches its end; the Threads tab draws the read ones below.

**Tech stack:** backend TypeScript (Fastify, Prisma on Mongo, vitest), Desktop Flutter.

**Spec:** task #2835's brief; #2929's spec `docs/specs/2026-11-04-activity-needs-you.md` (Threads).

## Global constraints

- Reuse #2929's Threads tab and read path; no new collection, index or count. The tab's number and the red badge stay
  the unread count.
- Read cost per page measured by existing indexes only, in the PR.
- Harness design language; read rows use the existing `_ActivityRow`, plain (not bold).
- An older backend refuses the new query (strict schema, 400): Desktop then reads as today, without paging.

## Review focus

- The read's cost grows with N only through the candidates it checks (2N mark rows of at most 500 already in memory,
  their roots by id, their thread summaries by root id): no scan.
- Order: unread first (as today), then read newest reply first; the same thread never in both.
- Paging never loops: Desktop asks for more only when the server said `more`, and at most 250.

## Design

- Growth: N/A because nothing is stored; the read lists what thread marks (capped at 500 per person per Swarm, 180-day
  sweep) and tags already hold.
- Concurrency: N/A because the read writes nothing; it runs as today, outside a transaction.
- Read cost: one more page reads 2×50 more candidates' roots by `_id` and summaries by root id (SuperTabThread `_id`);
  the mark rows are already loaded once by the inbox read. Measured per page in the PR. Only the open Activity view asks
  for pages: each of its refreshes (every Swarm change, at most every 3 s while open) reads the pages it shows, up to
  250 threads (500 candidates). Closed, the reads on every Swarm change ask for none and cost what they did (30, 60
  candidates), and the next visit starts at 50 again (review of #2993).
- Scale: at 10x threads per person the cap (500 marks, 250 answered) bounds a read; the first metric to warn is the
  threads read's p95 in the route's timing.
- Compatibility: an old Desktop sends no `read` and gets 30 as today; a new Desktop on an old backend gets 400 and reads
  without it.
- Migration + rollback: none; rolling back the backend makes Desktop fall back as above.
- Audience: the server already lists only chats the person reads and threads they are in (`readable`, `inIt`).
- Identity: the signed-in person's own marks and tags only.
- Failure: a failed page keeps the rows shown and shows the tab's existing error line with Retry.
- Platforms: Desktop and web share this code; the phone's Activity is its own package and is not changed here.

## Tasks

### Task 1: the read answers N read threads (backend)

Files: `backend/src/superTabs/read/followedThreads.ts`, `backend/src/routes/superTabs.ts`,
`backend/integration/superTabFollowedThreads.test.ts`.
Interface: `GET /api/super-tabs/:tabId/threads?read=N` (integer 1..250); `readFollowedThreads(store, user, tabId, read = 30)`.

- [ ] Failing test: 60 read threads; `?read=50` answers the 50 with the newest replies and `more: true`; `?read=100`
      answers all 60 and `more: false`; no `read` answers 30 as today; `read=0` and `read=251` are refused (400).
- [ ] Code: candidates `2 × read` mark rows plus tags; answer `read` threads; route query schema.
- [ ] Measure: commands and documents read for `read=50` and `read=100` under the profiler; into the PR.

### Task 2: Desktop lists read threads below the unread ones, 50 at a time

Files: `desktop/lib/super_tabs/attention.dart`, `desktop/lib/super_tabs/activity.dart`,
`desktop/lib/super_tabs/activity_view.dart`, `desktop/test/super_tab_activity_threads_all_test.dart`.

- [ ] Failing tests: unread on top (bold, "N new"), then a "Read" heading and read rows (plain, time of last reply),
      newest reply first; reaching the end asks for 50 more only when the server said more; opening a read row opens
      its thread; tab count unchanged; an old backend (400 on `read`) still lists what it answers.
- [ ] Code: `SuperTabAttention.readWanted` (50, +50 up to 250) and `loadMoreRead()`; `GET /threads?read=`; fallback;
      the Threads tab's read section; empty text when there are none at all.
- [ ] Guard tests (`check-ui-style`, `laid_out_list_test`); light and dark screenshots to Darren.
