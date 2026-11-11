# Swarm goal: where Desktop shows the score

- Date: 2026-11-11
- Scope: the Desktop app only. No phone, no web.
- Serves: [the Swarm plan](../../plans/2026-11-10-swarm-plan.md), rule 1 ("a goal that can be checked") and step 1,
  item 0 ("No new pane, leaderboard or phone work").
- Mockup: [mockup.html](mockup.html). Open it in a browser. Tabs: A · B · Compare; each has its states; Light and Dark.
  A link can name a state: `mockup.html#A.open.dark`.
- Status: **Decided: A (2026-11-11). Built in this change.**

## The decision

Where the score lives: **A, the project's bar**, or **B, the left pane's project row**.

## What is given

A project states its goal in `agents/GOAL.md`: a table of milestones, each with the command that checks it. CI runs
each on main as a check run named `goal: <milestone>`. A milestone passes, fails or has not run yet. The score is how
many pass out of how many the file lists. The CLI and daemon read the file and the check runs; that is built apart from
this.

Sample in the mockup: lampOS, 60 milestones, 41 pass, 3 fail, 16 not run. The names are invented.

## A. The project's bar (recommended)

```text
 # lampOS ⌄   Goal 41 of 60                                     ⌕  ▦  ⑂
            ┌──────────────────────────────────────┐
            │ ⌕ Search                             │
            │ Update rolls back on failure   fails │   red
            │ Voice timer survives a restart fails │
            │ Spotify plays by voice         fails │
            │ Busy room is detected        not run │   faint grey
            │ Desk talk is left alone      not run │
            │ …                                    │
            └──────────────────────────────────────┘
```

- **At rest:** `Goal 41 of 60` after the project's name, in 12-point metadata grey, tabular figures. An agent's bar puts
  `Mac Studio · Claude Code` in the same place and the same style.
- **Hover:** the chevron and the primary ink come in; its room is kept at rest, so nothing moves (Swarm elements, rule 5).
- **A click:** the app's dropdown. Milestones that fail come first, then those not run, each in the file's order. A row
  opens its check run on GitHub, or `agents/GOAL.md` when it has none yet.
- **All pass:** `Goal 60 of 60` as plain text. There is nothing to list, so there is no menu.
- **No goal file:** nothing. The bar is as it is today.
- **Reuses:** the bar's detail line (`DesktopChrome.metadata`, as `_agentHeader` in `super_tabs/view.dart`),
  `AppDropdown` and `AppMenuItem` (`shared/widgets/app_menu.dart`), and the hover chevron of
  `SuperTabQuietHeading.org` (`super_tabs/quiet_rows.dart`).

## B. The left pane's project row

```text
 Projects ⌄                +        # lampOS ⌄
 #  lampOS             41/60        ┌──────────────────────┐┌─────────────────────────────┐
 #  lamp-skills         7/12        │ Project settings…    ││ ⌕ Search                    │
 #  harness                         │ Goal               › ││ Update rolls back…    fails │
                                    └──────────────────────┘│ …                           │
```

- **At rest:** `41/60` as the row's one quiet detail (Swarm elements, rule 4): 12-point faint grey, tabular, on the
  edge every detail ends on. Every listed project shows its own.
- **A click:** the row opens the project, as today. So the list goes in the menu the project's name opens: `Goal ›`, a
  submenu of the same rows as A. Two clicks, and not beside the number.
- **No goal file:** no detail on the row, no `Goal` in the menu.
- **Reuses:** `SuperTabQuietRow`'s detail, `AppDropdown`, `AppSubmenuItem`.

## Recommendation: A

- **Smallest.** One element in one bar. B is three: a row detail, a menu row and a submenu.
- **One place.** The number and its list are together. In B they are in different panes.
- **It says what it counts.** `Goal 41 of 60` reads by itself. `41/60` beside a project's name does not, and the row
  has room for one detail only.
- **One read.** A reads the open project's goal. B reads one for every listed project while the Swarm shows.
- **Less to change.** A project's row is not a `SuperTabQuietRow` today (`ProjectSidebar._drawRow` draws its own, with
  no detail), so B rebuilds it first.

B earns its place once a person follows several projects with goals. It can be added then, on top of A, with no change
to A.

## What stays out

- No pane, tab, page or board for the goal. No ring, bar or chart: a score is plain figures (Numbers and rankings).
- No count of failures at rest (`41 of 60 · 3 fail`). The PM acts on a failed check, not the person, and the list puts
  failures first. One word to add later if a number asks for it.
- No history, trend or "what landed by the hour". No tree of tasks under a milestone. Those are the project map of a
  later step, with its own mockup.
- No editing the goal in the app. The file changes by pull request.
- No celebration at 60 of 60, no post in the channel, no notification.
- Nothing on the phone or the web. Nothing in the Leaderboard, Tasks or Pull requests.

## For the build

As built (`SwarmGoalScore`, `desktop/lib/super_tabs/goal_score.dart`):

- The project's bar (`_header`, `super_tabs/view.dart`) holds the title and the score in one row, as `_agentHeader`
  lays out its name and detail, with the name giving way first.
- Rule 5 has no shared widget. `SuperTabQuietHeading.org` draws its own hover chevron, which is absent at rest; the
  score's keeps its room. They are two copies.
- `AppMenuItem` has a state word it colours itself (`state`): a `trailing` widget keeps its own colours, and a red
  `fails` there would stay red on the active row's blue. The dropdown's search finds a row by that word too.
- `AppDropdown` opens on a search field past 8 rows (`defaultSearchAfter`) and scrolls past 480 points. The mockup
  draws both.
- Desktop reads the goal itself with `gh` (`SwarmGitHub.goal`, `super_tabs/github_issues.dart`), by the REST calls the
  daemon makes (`cli/src/superTabs/goal.ts` `goalOf`): the goal file, the repository's default branch, that branch's
  last 100 commits and a commit's check runs, up to 300 of them. GitHub's GraphQL roll-up of a commit's checks is not
  used: it leaves out check runs REST lists and counts commit statuses among them. The file's rows are read by the
  daemon's own reader, ported step for step (`super_tabs/goal.dart`), and both are held to one fixture
  (`cli/src/superTabs/__fixtures__/goal-rows.json`).
- `gh` hands over no control character as it is: it writes each in caret notation (U+0007 as `^G`), where the daemon
  asks GitHub itself. A milestone is matched to its check with both names written gh's way, so one with a control
  character in its name scores as it does for the daemon.
- The Naming System has entries for Goal and Milestone.

Decided in the build:

- How often it is read: when the project's bar comes on screen, every five minutes while it stays, and when the menu
  opens, each only on a reading older than a minute. An answer that comes after a later read's is dropped.
- A reading that fails: the last score stays, and the menu's first line says why in the board's own words
  (`Sign in to GitHub: run gh auth login.`).
- The limit on the list: the file's rows, 100 at most, in a menu that scrolls.
- A row opens only a page of github.com over https, and shows a milestone's name without control characters and the
  marks that turn a line's direction.
- The element is in Swarm elements and the gallery, with a Flutter test that clicks it
  (`desktop/test/swarm_goal_score_test.dart`).

## The mockup's limits

The window frame and the tab strip are schematic, and the footer is left out. Colours, type sizes and spacing are read
from `desktop/lib/shared/theme` (Paper in light, Graphite in dark) and the design system; the faces use the app's own
hash. It is a browser page, not the app: system fonts and hover differ a little from Flutter's.
