# Moving from tabs to the Personal Swarm: migration plan

**Goal:** a step-by-step way to move people from tabs to their Personal Swarm, with a way back at every step, so anh
Dee can decide before any tab is removed (Huy, 11-04). This is a plan only: it changes no code, and no phase starts
until anh Dee says yes to it.

**Agreed design (10-30), kept as it is:** the Swarm screen stays; a project's panes sit behind its [term] button;
every pane joins the project of its repo; panes with no repo go to # scratch (refined below); [term] keeps pane order
and size; old Swarm tabs become switcher entries. No new left bar.

**Spec:** Dee 10-30 design, Dee 10-31 "build the rest, but leave the tabs", Huy's eight points in task #2752.

## Where we are today (Phase 0, shipped)

- Tabs are unchanged. Personal's projects show the same live panes their tabs hold, never a copy
  (`desktop/lib/super_tabs/personal_projects.dart:16-22`, `desktop/lib/super_tabs/workspace.dart:109-114`).
- A pane joins the project of its repo; a pane with no repo joins a project for its tab, keyed by the tab's id
  (`personal_projects.dart:85-87`, `:161-164`). It is named after the tab once, and a later tab rename keeps the
  project and its name (`:340-348`, `:452-492`).
- Left out of Personal: Swarm tabs, utility tabs (Store, Companions, Devices), viewer panes, panes on another person's
  or a shared machine, and Team-account panes (`personal_projects.dart:134-150`; utility kinds in
  `desktop/lib/state/swarm.dart:41-45`).
- Split sizes carry over only when a project's panes are exactly one tab's panes, in that tab's order (`soleTab`,
  `personal_projects.dart:246-263`, used at `workspace.dart:234-237`, copied by `app_state.dart:19829`).
- Personal is created only when the person picks it (`desktop/lib/super_tabs/swarm_switcher.dart:33-35`, `:140-160`).
- The tabs live on the account's **desk**, one server document per person, the same on every computer
  (`desktop/lib/state/desk_sync.dart:1-14`, `backend/src/lib/desk.ts`), at most 24 tabs (`desk.ts:12`). The phone
  reads its tab list from the desk too (`mobile/lib/state/phone_desk.dart:10-27`). Swarm tabs are not on the desk
  (`app_state.dart:21094-21095`).

## The rule every phase keeps

**The desk stays the source of truth for panes until the last phase.** Every pane is still in a tab on the desk, even
while the Desktop does not draw the tab strip. That one rule is what keeps the phone, the web and older Desktops
working, and what makes going back a single switch with nothing to rebuild.

## Phases

Each phase ships on its own, waits a week of real use, and moves on only when anh Dee says so.

### Phase 1: fill the gaps, tabs unchanged

What changes for people: nothing about tabs. Personal's projects get what they need to stand alone later:

1. A no-repo pane started from a project (its [term] or its chat) joins that project; one started from a tab keeps
   today's tab project. Only a pane with neither goes to # scratch. (Point 1.)
2. A project of panes from several tabs gets its own layout, saved the first time the person arranges it, and kept
   with the project, not the tab. (Point 2.)
3. Personal remembers the tab order it saw, so its PROJECTS list can start in that order. (Point 5.)
4. A pane started in a project that has no tab yet is still added to a tab on the desk (the project's tab project,
   or a new tab named after the project), so the phone and older Desktops see it. (Point 7.)

Roll back: these are additions inside Personal. Turning them off leaves tabs exactly as they are; a project's saved
layout is simply not used.

Data kept: the tab-id project keys (`super_tab.repos.<account>`, `personal_projects.dart:185-187`) and every tab on
the desk, unchanged.

### Phase 2: "Use projects instead of tabs", opt-in, off by default

What changes for people who turn it on, on that Desktop only:

- The tab strip is hidden for tabs whose every pane is in a Personal project. A tab holding a pane Personal leaves out
  (point 3) stays visible as a tab. Utility tabs open from their menus as today.
- The Swarm screen opens on Personal. Cmd-1..9 go to the first nine projects in the PROJECTS list instead of tabs
  (today they follow tab order: `app_state.dart:4155-4158`, `desktop/lib/shortcuts/app_shortcuts.dart:928-938`).
- Nothing else changes: the panes, their sessions and the desk are the same.

Roll back: turn the setting off. The tab strip comes back as it was, because the desk was never changed. Nothing is
restored, so nothing can be lost.

Data kept: the whole desk, unchanged; this window's own tab layout (`terminal_pane_layout`,
`desktop/lib/state/pane_layout_store.dart:20`) is still written.

What tells us it works: how many people turn it on, how many turn it off again within a week, and the reasons in
feedback.

### Phase 3: on by default for new people, a one-time choice for everyone else

What changes for people:

- A new install, or someone who never used tabs, starts in projects mode.
- Anyone else is asked once: "Use projects instead of tabs?" with Keep tabs as a full answer. The setting stays in
  Settings either way.

Roll back: the same setting. If many people turn it off, the default goes back to tabs in the next Desktop release,
with no data change.

Data kept: as Phase 2.

### Phase 4: tabs removed (a later decision, not part of this plan's yes)

Only when Phase 3 shows few people keep tabs, and older Desktops are a small share of active ones. Before it, a new
design answers where left-out panes (point 3) live without a tab, and how the phone shows panes without the desk's
tabs. The desk is then kept read-only for at least two releases, so a person who needs it back still has it.

## Huy's eight points

1. **No-repo panes.** Today their project comes from their tab's id (`personal_projects.dart:85-87`, `:164`), which
   works because every pane is in a tab. Phase 1 adds the project the pane was started from as the first source,
   keeps the tab for panes started in a tab, and uses # scratch only when there is neither. Existing tab projects keep
   their keys, so nothing moves.
2. **Split layouts.** Sizes come from a tab only when the project is exactly that tab's panes (`soleTab`,
   `personal_projects.dart:246-263`); a project with panes from several tabs gets the default layout today. Phase 1
   saves each project's own layout once the person arranges it. Until then, [term] keeps pane order (tab order, then
   each tab's reading order, `personal_projects.dart:134-142`).
3. **Panes left out of Personal.** Viewer panes, panes on another person's or a shared machine, Team-account panes,
   Swarm tabs and utility tabs (`personal_projects.dart:134-150`). They show where they show today: in their tab. In
   projects mode a tab holding any of them stays visible. Their home without tabs is a Phase 4 design question.
4. **Updating from a version with no Swarm.** On first launch the Desktop joins the desk and seeds it with this
   computer's tabs (`app_state.dart:21194-21198`). Each pane then maps to a project: its repo's, or its tab's project
   named after the tab (`personal_projects.dart:343-348`). Projects mode never starts by itself until Personal exists
   and its first sync answered. If Personal can't be created (signed out: `swarm_switcher.dart:143-147`; offline or
   a server refusal: the error shown in the tab, `swarm_switcher.dart:208-228`), the Desktop stays in tabs, says why,
   and offers the switch again later. A refused project is asked for again after a wait of up to 5 minutes
   (`personal_projects.dart:182-183`, `:439-450`).
5. **Muscle memory.** Cmd-1..9 follow the visible tab order today (`app_state.dart:4155-4158`); in projects mode they
   follow the PROJECTS order, which starts as the tab order the Desktop saw (Phase 1). Renaming a tab no longer
   renames its project once it is made, and a name the person chose always stays (`personal_projects.dart:340-342`,
   `:452-454`). People who grouped several repos in one tab lose that grouping in projects mode, since each repo is
   its own project. That is the main reason Keep tabs stays a full answer through Phase 3.
6. **A repo that already has a team project.** Not joined in any phase of this plan (`personal_projects.dart:29-30`).
   The pane stays in its Personal project and the team project is unchanged. Joining the two crosses Swarms and
   access, so it needs its own design and two security reviews before it is built.
7. **Mixed versions.** An older Desktop, the phone and the web read tabs from the desk (`desk_sync.dart:1-14`,
   `phone_desk.dart:17-27`). Because every phase keeps every pane on a desk tab, they keep seeing the same tabs and
   panes while a newer Desktop shows projects. Projects mode is a setting of each Desktop, not of the account, so an
   older Desktop on the same account simply shows tabs.
8. **A way back.** The "Use projects instead of tabs" setting, off by default until Phase 3 and always in Settings.
   Restoring needs no saved copy: the desk is never changed by projects mode, and the local tab layout keeps being
   written. Personal's project map (`super_tab.repos.<account>`) stays too, so switching back and forth makes no new
   projects.

## Design

- Growth: one setting per Desktop, and one saved layout per Personal project, deleted with the project.
- Concurrency: the setting is per Desktop, so no lock. A project's layout is written by the Desktop that arranged it;
  last write wins, as tab layouts do on the desk today.
- Read cost: nothing new is read; projects mode reads the desk and Personal it already reads.
- Scale: at 10x tabs the desk's 24-tab limit (`desk.ts:12`) warns first, since Phase 1 may add a tab for a project
  with no tab. It is the metric to watch.
- Compatibility: older Desktops, the phone and the web keep reading the desk, unchanged (point 7).
- Migration and rollback: no data is migrated; each phase rolls back with the setting or a default change.
- Audience: Personal is the person's alone and its projects are created private (`personal_projects.dart:201-214`,
  `:410`); the server enforces who reads a Swarm, as for every Swarm.
- Identity: Personal and its projects belong to the signed-in account, never the machine owner's login
  (`personal_projects.dart:203-213`).
- Failure: if Personal can't be made or read, the Desktop stays in tabs and says why (point 4).
- Platforms: Desktop on macOS, Windows and Linux; the phone and the web keep tabs from the desk through Phase 3.

## Decisions for anh Dee

1. Phase 1 (tabs unchanged): yes or no.
2. Phase 2 (opt-in setting): yes or no, and after how long in Phase 1.
3. Phase 3 and Phase 4 are decided later, on Phase 2's numbers.
