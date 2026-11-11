# Manage ▸ Backlog to Scholes's mockup — plan

**Goal:** Make the Desktop and web Manage ▸ Backlog tab readable at a glance, as Scholes's mockup draws it (task
#2774): summary cards, search with Mine/Everyone and a project menu, collapsible groups with one-line meanings, and
card rows with priority, project, pull request and CI chips.

**Architecture:** One view, `desktop/lib/super_tabs/backlog_view.dart`, redrawn; the grouping in `backlog.dart` is
unchanged (what counts as each state is out of scope). `backlog.dart` gains one pure helper,
`superTabTitlePriority`: tasks carry no priority field, so the URGENT/HIGH badge reads the title's own marker (a
leading `URGENT`, or a trailing `(Name, high)` / `(Name, urgent)`), which the row then drops from the title, as the
mockup shows. The controller exposes when it last read the Swarm (`syncedAt`) for "Synced just now".

**Tech Stack:** Flutter (Desktop and web share the code), Harness Design Language tokens (`DesktopChrome`,
`grid.AppPalette`, `grid.AppDesktop`, `AppIcons`), widget tests with the memory-store fixtures.

**Spec:** Task #2774 brief and the mockup attached to Scholes's message in the project chat.

This plan is carried out by the Engineer directly, test first; there is no execution handoff.

## Global Constraints

- All six existing groups stay, Waiting for a machine included, in their order; their rules do not change.
- No hard-coded colors, insets, radii or font sizes (`scripts/check-ui-style.py`).
- Mine with nothing open keeps its explanation and its link to what the reader shipped (#2551).

## Review Focus

- Counts on the summary cards and in each heading follow the same filters as the rows.
- Search matches title, number and agent, together with Mine and the project.
- The priority marker parse never strips an ordinary parenthetical.

## Task 1: the redesigned tab

**Files:** `desktop/lib/super_tabs/backlog.dart`, `desktop/lib/super_tabs/backlog_view.dart`,
`desktop/lib/super_tabs/controller.dart` (one getter), `desktop/test/super_tab_backlog_test.dart`,
`desktop/test/super_tab_backlog_shots_test.dart`.

**Interfaces:** `enum SuperTabTaskPriority { urgent, high }`;
`({SuperTabTaskPriority? priority, String title}) superTabTitlePriority(String title)`;
`DateTime? SuperTabController.syncedAt`.

- [ ] Failing tests: the title's priority marker; summary counts follow the filters; search by title, number and
      agent with Mine and the project menu; each group's meaning and its fold; Shipped's newest 7 and Show N more;
      the badge on a row; Synced just now. Existing view tests updated to the new rows and headings.
- [ ] Run them and watch them fail.
- [ ] Redraw the view; add the helper and the getter.
- [ ] Run the Backlog tests and the Manage page tests; light and dark screenshots offscreen, to Scholes.
