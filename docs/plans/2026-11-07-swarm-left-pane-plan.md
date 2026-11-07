# Swarm left pane: one quiet row style (task #4466) Implementation Plan

Way of working: the project's Engineer flow (plan first; each task's failing test committed before its code; one pull
request; one independent review). No subagent-driven development and no execution handoff.

**Goal:** Redraw the Desktop's Swarm left pane as anh Dee agreed (11-07 15:35): the org name, Decisions with its count,
one Projects link that opens a grid of projects in the middle, My agents, then Humans with their points, all in one
quiet row style.

**Architecture:** One new row widget, `SuperTabQuietRow`, and one heading, `SuperTabQuietHeading`, in `buddy_rows.dart`
draw every Desktop left-pane line (face or icon, name, one detail on the right). `ProjectSidebar` lays them out top to
bottom when `board` is true; the phone and web layout (`board: false`) keeps today's rows. A new `SwarmPage.projects`
shows `SuperTabProjectsPage` (`projects_page.dart`) in the middle, a grid of project cards, most recent first.

**Tech Stack:** Flutter (Desktop), flutter_test widget tests with captured screenshots, light and dark.

**Spec:** task #4466 brief (anh Dee, 11-07 15:35 'sure'), quoted in Global Constraints.

```text
 autonomous.ai ⌄               <- semibold 13 primary; ⌄ only on hover
 ⊡  Decisions               3  <- inbox icon; count 12 tertiary, right
 ▦  Projects                   <- grid icon; opens the grid in the middle

 My agents ⌄                   <- 12 quiet heading; ⌄ only on hover
 ◉  Buddy
 ◎  River             harness  <- a Lead: the project it leads
 ◉  Leftquiet         offline
 +  New agent

 Humans                        <- 12 quiet heading; opens the Leaderboard
 D  dee                    120 <- photo or initial on a grey disc; points
 K  ken15                   80

 ⚙  Manage                     <- at the foot, as today

 middle, Projects:  ┌ harness ────────────┐ ┌ website ───────────┐
                    │ autonomous-ai/open… │ │ Private            │
                    └─────────────────────┘ └────────────────────┘
```

## Global Constraints

- Six rules: 1. Grey everywhere; colour only on agent faces. 2. Blue only for the main action; red only for failed.
  3. Three text sizes: 14 chat, 13 names, 12 details; in lists, bold means unread. 4. Every row: face, name, one quiet
  detail on the right. 5. Dropdowns stay plain text until you hover. 6. If it doesn't help you decide, it's gone.
- Rows are 30 high with a 20 face in a fixed column, so all names start on one line. The right detail is 12 tertiary
  (`AppPalette.textFaint`, the third of the three greys), right-aligned in one column, with no brackets.
- Read names are secondary text, unread semibold primary, the selected row a neutral fill (`SidebarInk.selected`).
- People keep a photo or an initial on a neutral grey disc.
- Desktop only (`ProjectSidebar.board`); phone and web rows unchanged. Named roles only; `check-ui-style.py` allowlist
  never grows. Light and dark, at 880 and wide. Out of scope: dropping Buddy as a kind; the top bar (#4465); the
  faces, Lead ring and task marks themselves (#4461), which this builds on after main has them.
- Every element changed goes into the design doc's Swarm elements section and the gallery test in this PR.

## Review Focus

- A Swarm with many people: Humans lists at most 8, most points first; the heading opens the whole board.
- No board yet (loading, an older server, a read that failed): Humans shows the heading and no rows, never a spinner.
- A Board open in the middle lights Projects, and nothing else; Decisions or the grid open light their own row.
- A long org, agent or project name truncates before the right detail, which never wraps or moves its column.
- 200% text: rows grow rather than clip (min height 30, not a fixed height).

---

### Task 1: the quiet row and heading

**Files:**
- Modify: `desktop/lib/super_tabs/buddy_rows.dart`
- Test: `desktop/test/super_tab_quiet_rows_test.dart` (new)

**Interfaces:**
- Produces: `SuperTabQuietRow({Key? key, required Widget leading, required String name, String? detail, bool selected,
  bool unread, String? tooltip, VoidCallback? onTap, bool strong = false})`; `SuperTabQuietRow.height = 30`,
  `SuperTabQuietRow.faceSize = 20`. `strong` draws the name semibold primary whatever its unread (the org name).
  `SuperTabQuietHeading(String title, {Key? key, VoidCallback? onTap, bool? collapsed})`: 12, secondary; with
  [collapsed] given, a chevron after the title only while hovered. `SuperTabHoverChevron` is internal.
- [ ] Test: a row is at least 30 high; its leading column is the same width for a face and an icon, so two rows' names
  start at one x; the detail is 12, `textFaint`, right-aligned at the row's end; a read name is `textSecondary`
  regular, an unread one `textPrimary` semibold; selected fills `SidebarInk.selected`; Semantics says "Unread" when
  unread. A heading draws no chevron until hovered, then `chevronDown` (or `chevronRight` when collapsed).
- [ ] Run, watch it fail (no such widgets).
- [ ] Implement both in `buddy_rows.dart`.
- [ ] Run, pass. Commit.

### Task 2: the Desktop left pane, top to bottom

**Files:**
- Modify: `desktop/lib/super_tabs/project_sidebar.dart`, `desktop/lib/super_tabs/places.dart` (`SwarmPage.projects`),
  `desktop/lib/super_tabs/controller.dart` (remove the Projects fold: `projectsGroupOpen`, `projectsOpen`,
  `toggleProjectsGroup`, which only the Desktop's Projects section used)
- Modify: `desktop/lib/super_tabs/buddy_rows.dart` (drop `SuperTabBuddyRow.agent`, `crown` and the status-at-end
  branch, used only by the Desktop's rows)
- Test: `desktop/test/super_tab_v3_left_test.dart` (rewrite the Projects-folding, status and crown cases)

**Interfaces:**
- Consumes: Task 1.
- Produces: `ProjectSidebar.leaderboard` (`SuperTabLeaderboardReader?`); keys `super-swarm-switcher`,
  `super-decisions`, `super-projects`, `project-sidebar-agents`, `super-agent-<id>`, `super-swarm-buddy`,
  `super-new-agent-row`, `project-sidebar-humans`, `super-human-<personId>`, `super-manage`.
- [ ] Test: on the Desktop the order is org, Decisions, Projects, My agents, Humans, Manage; the org row shows no
  chevron until hovered; Decisions shows its waiting count on the right; there is no project row, Leaderboard row or
  unread filter; Projects calls `onPage(SwarmPage.projects)` and is lit while the projects page or a Board is open; a
  Lead's detail is its project's name and an offline agent's is "offline"; no `ActivityMark` and no brackets in the
  pane; Humans lists the board's people, most points first, at most 8, with points on the right, and a tap on the
  heading or a person calls `onPage(SwarmPage.leaderboard)`; `board: false` keeps today's rows.
- [ ] Run, watch it fail.
- [ ] Implement; remove what the Desktop no longer draws.
- [ ] Run the test and the other left-pane tests (`super_tab_sidebar_test.dart`, `super_tab_v3_left_shots_test.dart`).
  Commit.

### Task 3: the Projects grid in the middle

**Files:**
- Create: `desktop/lib/super_tabs/projects_page.dart`
- Modify: `desktop/lib/super_tabs/view.dart` (show it for `SwarmPage.projects`, title "Projects", pass `_board` to the
  sidebar as `leaderboard`)
- Test: `desktop/test/super_tab_projects_page_test.dart` (new); every Desktop test that opened a Board by tapping its
  project row now taps `super-projects` first (the card keeps the key `super-group-<leadConversationId>`).

**Interfaces:**
- Produces: `SuperTabProjectsPage({required SuperTabController controller, required ValueChanged<SuperTabProject>
  onOpen, VoidCallback? onNewProject})`; `superTabProjectsByRecent(SuperTabController) → List<SuperTabProject>`, most
  recent first by the greatest `lastMessageSequence` of the project's conversations, then by name.
- [ ] Test: the page lists every project as a card, most recent first; a card shows the name (13 semibold primary)
  and one 12 tertiary line (the repository's `owner/name`, or "Private" for a private project without one); a tap
  opens that project's Board; New project is the one blue button and opens the New project form; an empty Swarm
  says "No projects yet".
- [ ] Run, watch it fail.
- [ ] Implement; `GridView` with a max card width so the grid fills 880 and wide windows.
- [ ] Run; move the Board-opening tests. Commit.

### Task 4: people on a grey disc

**Files:**
- Modify: `desktop/lib/super_tabs/avatar_art.dart` (a `person:` identity's initial disc is neutral)
- Test: `desktop/test/super_tab_avatar_test.dart`
- [ ] Test: a person without a photo draws its initial on `AppSurface` neutral grey with `textSecondary` ink, the same
  for every name; an agent's initial (no face) keeps its hue.
- [ ] Run, fail; implement; pass. Commit.

### Task 5: the design doc and the gallery

**Files:**
- Modify: `desktop/design/desktop-design-system.md` (Swarm elements: the quiet row, the quiet heading, the org row,
  the Projects grid card; replace the left pane's People lines in Numbers and rankings)
- Modify: the Swarm elements gallery test from #4461, once main has it (`desktop/test/swarm_elements_gallery_test.dart`
  and its light and dark images)
- [ ] Gallery entries for each element, light and dark; regenerate the images, inspect, commit.
- [ ] Screenshots of the whole pane and the grid, light and dark, 880 and 1440, for the PR.
