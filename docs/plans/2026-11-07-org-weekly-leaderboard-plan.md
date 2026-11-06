# Org-wide weekly Leaderboard implementation plan

**Working method:** Engineer implements each task test first, then independent whole-PR review and testing.

**Goal:** Open this week's org-wide leaderboard directly below Decisions, celebrating shipped work and helpful teammates.

**Architecture:** Reuse the existing authenticated leaderboard endpoint with `scope=all` and no rolling period. Its server-filtered project set supplies one weekly aggregate. Extend its rows with accepted tasks and agents brought, and show a dedicated page using the existing identity and theme components. Preserve rolling/per-project contracts for clients from the last 30 days.

**Tech Stack:** TypeScript, existing Swarm parts cache, Flutter; no dependencies or database schema changes.

**Spec:** Harness task #4122, conversation df920dc0232ebbcf644ad9f7. Integrate navigation on #4118's layout, merge after #4118.

## Global Constraints

- No change to who can read a project; server filters projects, groups and agents before aggregation.
- Weekly org rank: shipped count descending, then points; equal shipped and points share rank. Points: existing 3 per ship and 1–3 per unblock, plus 1 per accepted task. Accepted means a request's first assignment this week, credited to its requester, consistent with shipped credit. Retries and review steps earn no acceptance credit.
- Agents brought is the current count of visible, own-account agents contributed by each person, excluding Buddy sessions and Team accounts; it earns no points. No lent column on the weekly page.
- Light and dark; Desktop tests use memory fixtures and fake sign-in. No release or production writes.

## Review Focus

- Hidden project activity or agent counts must never leak through a cached aggregate.
- Agents brought and machine lending must never change weekly org points or rank.
- Week boundaries, retries, review steps and private chats must not inflate accepted/shipped counts.
- A failed read, revoked access or changing org must not show another audience's stale board.
- The sidebar slot and browser-style back navigation must work with #4118's v3 layout.

## Design

1. Growth: no stored rows added; reuse the five-week ledger and bounded SwarmCache (byte, age and entry limits). Weekly aggregate entries expire/evict; week/day keys keep streaks current.
2. Concurrency: reads only; existing command locks and cache stamps invalidate after mutations. Audience is checked before every cache lookup; cache key includes actor, anchor project and week. No new lock.
3. Read cost: reuse existing indexed, projected dormant-group read and patched parts. Cache the weekly result so an unchanged stamp does not reread profiles or recompute scores. No new database query. Page refreshes on controller changes, coalescing in-flight requests; no new timer.
4. Scale: existing limits bound projects, people, agents and the retained ledger. Measure the same 10x synthetic workload before/after; cache-hit reads should avoid aggregation. A content-free warning names slow weekly reads above 100 ms; no IDs or paths in it.
5. Compatibility: backend first. Extend PersonScore with optional `accepted` and `agentsBrought`; Desktop understands their absence and shows an unavailable state for the weekly page until supported. Existing Desktop/mobile rolling and per-project consumers retain existing scoring and payload fields, including legacy lent fields for old clients.
6. Migration/rollback: none; no persisted changes. Roll back Desktop or backend independently; the weekly page detects missing fields instead of mislabeling old scores. Existing clients ignore additive fields.
7. Audience: existing readProject/canReadProject/canReadGroup checks and visibleState agents; cache is actor-specific and invalidated on membership/project changes. API is the only new presentation path; no messages, private titles, telemetry content, notifications or shares added.
8. Identity: authenticated person's request, never the machine owner's identity; existing Team-session refusal remains.
9. Failure: page shows loading, empty, unsupported or error with Retry; revoked access clears results. Existing cache bypass when stamps unavailable remains correct. No writes or retry loops.
10. Platforms: backend Linux; shared Desktop macOS/Linux/Windows code. No process starts, new native calls, phone or web changes. Validate affected unit tests on macOS and rely on required Linux CI for full component suites.

## Mockup

```text
Decisions              Leaderboard                 This week · all readable projects
Leaderboard            Rank  Teammate   Shipped  Accepted  Unblocked  Streak  Agents  Points
My agents                 1  Dee             9         11         4      5d       3      42
Projects                  2  Ken             6          8         3      3d       2      29
                       Agents brought are a count, with no points.
```

### Task 1: Weekly org scoring

**Files:** `backend/src/superTabs/leaderboard/{stats.ts,contract.ts,weekly.test.ts}`.
**Interfaces:** existing `leaderboard(LeaderboardInput): Leaderboard`; weekly all-project rows add `accepted: number` and `agentsBrought: number`; optional `visibleAgents: Agent[]` input supplies server-filtered agents.

- [ ] Commit failing tests for cross-project ships/rank, accepted first assignments, excluded review/private/hidden projects, zero agent/lending points and week boundaries.
- [ ] Run `npm test -- src/superTabs/leaderboard/weekly.test.ts`; record red.
- [ ] Implement weekly-only scoring, count agents once per person, preserve legacy scoring and fields.
- [ ] Run the new tests and existing stats/rolling/brought tests; commit green and push.

### Task 2: Cached authenticated weekly read

**Files:** `backend/src/superTabs/read/service.ts`, `backend/src/superTabs/leaderboard/{read.ts,read.test.ts}`, `backend/src/routes/superTabs.ts`, `backend/integration/superTabLeaderboard.test.ts`.
**Interfaces:** cache helper `weeklyBoard(cached, tabId, actorKey, projectId, week, now, load): Promise<Leaderboard>`; existing endpoint remains unchanged.

- [ ] Commit tests proving unchanged-stamp reuse, actor separation, mutation invalidation and day/week rollover.
- [ ] Run affected test, observe red; use the existing CacheView rather than a new cache.
- [ ] Cache weekly aggregation after authorization, supply visible agents, emit a content-free slow-read warning.
- [ ] Run affected read/cache tests and typecheck; commit green and push.
- [ ] Extend route validation to allow `scope=all` without a rolling period. First watch the integration tests fail with 400, then verify weekly project/agent audience isolation through the real API.

### Task 3: Weekly board page

**Files:** `desktop/lib/super_tabs/leaderboard/{model.dart,weekly_page.dart}`, `desktop/test/super_tab_weekly_leaderboard_test.dart`.
**Interfaces:** `SuperTabWeeklyLeaderboardPage(controller: SuperTabController)`; request existing endpoint with `scope=all`, without period; derive anchor from readable snapshot projects. Add optional accepted/agentsBrought parsed fields.

- [ ] Commit widget tests for all weekly columns/order, loading/empty/error/unsupported/revocation, coalesced change refresh and light/dark screenshots.
- [ ] Run the new widget file, observe red.
- [ ] Implement page with existing theme/identity, horizontal scroll at narrow widths, bounded lazy rows and request timeout.
- [ ] Run affected widget/model tests, analyze and capture light/dark screenshots; commit green and push.

### Task 4: v3 navigation and handoff

**Files:** #4118's `desktop/lib/super_tabs/{places.dart,project_sidebar.dart,view.dart}` and affected sidebar/view tests.
**Interfaces:** `SwarmPage.leaderboard` opens Task 3's page, with title and Back/Forward support.

- [ ] Integrate #4118 after coordination; commit a test that tapping the row immediately below Decisions opens this week's board.
- [ ] Observe red, then add the slot and page wiring; verify dark/light, navigation and existing affected tests.
- [ ] Record before/after same-workload numbers, red/green evidence, platforms and design in the PR. Mark ready and keep head stable for independent review/test and ci/required. Merge only after #4118.
