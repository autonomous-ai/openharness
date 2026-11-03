# Personal Swarm: tab projects and a project that shows its panes Implementation Plan

> **How this plan runs:** by this project's instructions (Engineer role): task by task, test first (the failing test
> committed and watched failing, then the code); the pull request's Review step is the one independent review.

**Goal:** In the person's own Personal Swarm, a pane with no repo joins a project per tab, named after the tab, and
a project whose chat is empty but which has panes says so in its empty view, with a button that opens them.

**Architecture:** `personalPanes` (desktop/lib/super_tabs/personal_projects.dart) gives a pane with no repo the key
`tab:<tab id>` and remembers the tab's name for its project; the key, not the name, finds the project, so a renamed tab
keeps it, and the desk's tab id is the same on each of the person's computers. The project is created with the request
id `personal-tab-<hash of tab id>` and the tab's name. The project still opens on its chat (Dee's agreed design; River,
2026-11-03: no redesign of a screen that works); only the empty chat changes: with panes, the shared `EmptyState` says
"N panes in this project" over the usual "Discuss the plan with …" line, with a Show panes button that does what the
header's terminals button does.

**Tech Stack:** Flutter (Desktop; the web shares the code), widget and unit tests with the launch fixture.

**Spec:** task #2376's brief (Huy, 2026-11-03).

## Root cause of the empty view

Huy's screenshot is the top-left of a wider window: # scratch selected, its chat empty. A Personal project opened on its
project chat, which is empty, and its panes were behind the header's terminals button (out of the shot). Reproduced
with his desk (tabs code and Harness Monitor, agents with no remote): # scratch holds the 3 agent panes
(`Group terminals (3)`), the Harness Monitor's web viewer is left out as a viewer, and the view opens on the empty chat.
His panes have no remote: a folder with no git remote reports none, and `normalizedRemote` reads every remote form the
daemon sends (existing tests).

## Global Constraints

- Out: team projects. Keep the screen's layout; Harness design language.
- Panes with a repo keep grouping by repo.
- Nothing of a pane is sent but its project's name (now a tab's name for a tab project).
- PR body first line: "Requested by phamngochuy.1989@gmail.com through Harness."

## Review Focus

1. A tab renamed keeps its project (key is the tab id), and its project keeps the name it has.
2. A pane moved to another tab moves to that tab's project; a tab closed leaves its project as it is.
3. Two tabs of one name are two projects of that name (each tab's panes in its own).
4. A project with no panes, or a chat with messages, looks as it does today.
5. # scratch is no longer made for new panes; an existing # scratch project stays (the person may delete it).

---

### Task 1: An empty project chat with panes says so

**Files:** `desktop/lib/super_tabs/view.dart` (the empty chat); test `desktop/test/super_tab_personal_projects_test.dart`.

- [ ] Failing widget test: Huy's desk; the code project's empty chat shows "2 panes in this project" and Show panes,
  which opens its 2 panes; the Personal project (no panes) still shows "Discuss the plan with Product Manager." alone.
- [ ] Implement in the empty-chat branch, from `_terminalCount`'s Personal part.

### Task 2: Panes with no repo group per tab

**Files:** `desktop/lib/super_tabs/personal_projects.dart`; test as above.

- [ ] Failing tests: no-repo panes in tabs code and Harness Monitor make two projects named code and Harness Monitor,
  each with its own panes; panes with a repo still group by repo; a renamed tab keeps its project; two tabs of one name
  are told apart.
- [ ] Implement: key `tab:<id>`, name from the tab, request id `personal-tab-<hash>`.
