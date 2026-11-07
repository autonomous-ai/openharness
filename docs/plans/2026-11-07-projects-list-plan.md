# Projects list like GitHub's repositories Implementation Plan

> Way of working: the Engineer implements this plan task by task, test first (superpowers test-driven-development); the
> pull request's one review step is the independent review.

**Goal:** The Desktop's Projects page (task #4662, anh Dee 11-07 21:15) reads like GitHub's repository list: each
project's name and visibility, its purpose, its Lead and members, its open work, its repository and when it last moved,
with a 4-week sparkline of tasks shipped.

**Architecture:** Desktop draws the list from what its snapshot already holds (projects, `about`, agents, `leadOf`,
the board pulse's working and next-up counts). One small backend read, `GET /api/super-tabs/:tabId/project-activity`,
answers what the snapshot cannot: each readable project's tasks shipped per day for 28 days and its last activity. It
reuses the leaderboard's cached dormant-group loader (`recentDormantGroups`), so a repeat read at an unchanged stamp reads
no documents. Desktop reads it when the page opens and again when the set of projects changes; nothing polls.

**Tech Stack:** Flutter (Desktop), TypeScript (backend, Fastify route, Prisma/Mongo through the read cache).

**Spec:** task #4662's brief and anh Dee's Buddy's mockup (`e31f2bda-projects-page.png` in the task chat).

## Global Constraints

- Middle pane at most 900 wide. Nothing says None or No description: an empty value is left out (Swarm elements rule 7).
- Grey everywhere; colour only on agent faces; blue only for New project. The sparkline is grey.
- Every element is in `desktop/design/desktop-design-system.md` and the Swarm elements gallery in the same PR.
- Copy: `Projects`, `New project`, `Find a project`, `Sort: Recent` / `Name` / `Most work`, `Public`, `Private`,
  `N working · N to do`, `Updated 2 minutes ago`.
- Offscreen tests only: memory store, fake sign-in.

## Design

- growth: the read stores nothing; its answer is bounded by the Swarm's projects (≤ 100) × 28 numbers.
- concurrency: read only, inside the existing read transaction; no lock.
- read cost: through the read cache's board entry (`board:<floor>:<projects>`), patched from each change; a read at an
  unchanged stamp loads no documents. The live groups come from the parts already read.
- scale: at 10x projects the answer is 1,000 × 28 numbers (~60 KB); the `[weekly-leaderboard] slow read` style warning
  `[project-activity] slow read` over 100 ms warns first.
- compatibility: backend ships first; a Desktop meeting an older backend gets 404 and draws rows without sparkline and
  Updated. Older Desktops never call it. New route only, no contract changed.
- migration and rollback: none; reverting removes the route and the page falls back as above.
- audience: the server checks `canReadProject` and `canReadGroup`; a Team session is refused, as for the leaderboard.
- identity: read as the signed-in person.
- failure: a failed read logs on the server and the page keeps its rows without sparklines; nothing else changes.
- platforms: Desktop on macOS, Linux, Windows and web (same Flutter code); backend.

## Review Focus

- The activity read never counts a conversation the reader may not read, and never loads dormant groups uncached.
- The page leaves out every empty value; nothing reads None.
- Row layout at 880 and 1440, light and dark, against the mockup.

## Task 1: backend project activity read

**Files:** `backend/src/superTabs/read/projectActivity.ts` (+ test), `backend/src/superTabs/read/service.ts`,
`backend/src/routes/superTabs.ts`.

**Interfaces:** `GET /api/super-tabs/:tabId/project-activity` →
`{ through: 'YYYY-MM-DD', projects: [{ projectId, shipped: number[28], updatedAt: number | null }] }`: `shipped` oldest
first, one UTC day each, ending `through` (today); a task (not a step, chat or Buddy chat) counts on the day of its
`ledger.shippedAt`. `updatedAt` is the newest `lastActivityAt` (ms) of the project's readable conversations.

- [ ] Failing test: `projectActivity` counts shipped tasks per day, skips steps, chats and unreadable groups, and gives
      the newest activity.
- [ ] Implement `projectActivity` and the service method and route.
- [ ] Failing test: a reader who cannot read a project gets no row for it; a Team session is refused.

## Task 2: Desktop model and reader

**Files:** `desktop/lib/super_tabs/model.dart` (`SuperTabProject.about`), `desktop/lib/super_tabs/project_activity.dart`,
`desktop/lib/super_tabs/backend_transport.dart`, `desktop/test/support/super_tab_fixture.dart`.

- [ ] Failing test: `about` reads from the project row; the reader parses the activity answer and keeps rows on a 404.
- [ ] Implement.

## Task 3: the Projects list

**Files:** `desktop/lib/super_tabs/projects_page.dart`, `desktop/test/super_tab_projects_page_test.dart`.

- [ ] Failing tests: title and count; search by name and purpose; sort Recent, Name, Most work; each row's three lines
      and sparkline; empty values left out; a row opens its project; at most 900 wide.
- [ ] Implement.

## Task 4: design doc, gallery, click-through and screenshots

**Files:** `desktop/design/desktop-design-system.md`, `desktop/test/swarm_elements_gallery_test.dart` (+ goldens),
`desktop/test/super_tab_projects_click_through_test.dart`.

- [ ] Failing click-through: from the Swarm view, Projects, type a search, change sort, open a row, the Board shows.
- [ ] Gallery entry for the project row, light and dark; design doc row replaced.
- [ ] Screenshots light and dark at 1440 and 880 next to the mockup, in the PR.
