# Swarm screen: six rules, one surface, a quiet top bar (task #4465)

**Goal:** anh Dee's redrawn Swarm screen (11-07 15:35, "sure"): write the six rules into the design system's Swarm
elements section and its gallery, give the left, middle and right panes one background split by hairlines, and make
every agent's chat bar the same quiet 44-high row.

**Architecture:** The bar stays `SuperTabAgentChatHeader`. Its right side becomes one widget,
`SuperTabEngineModelLine` (new, `chat/engine_model_line.dart`): `Claude Code · Opus 5.5` in 12-point `textFaint`,
plain until hover. For the reader's own Swarm Buddy it opens one menu holding the engine rows (today's
`BuddyEnginePicker` rows) and the shared models (today's `BuddyModelLine` rows), so the two menus' rows are pulled into
functions both callers share. Other agents' lines are the same text and open nothing, since the server switches no
other agent. The one surface is `AppPalette.swarmField`, the colour the left and middle panes already sit on in the app
and the one the selected native tab joins; the Tasks pane paints it instead of the theme surface, and `SuperTabView`
paints it under all three panes so no pane depends on its host.

**Tech Stack:** Flutter (Desktop), flutter_test widget and screenshot tests.

**Spec:** task #4465 brief; the six rules: 1. Grey everywhere; colour only on agent faces. 2. Blue only for the main
action; red only for failed. 3. Three text sizes: 14 chat, 13 names, 12 details; in lists, bold means unread. 4. Every
row: face, name, one quiet detail on the right. 5. Dropdowns stay plain text until you hover. 6. If it doesn't help you
decide, it's gone.

Way of working: the project's Engineer flow: plan first, each task's failing test committed before its code, one pull
request, one independent review.

## Global Constraints

- Desktop only. Light and dark, at 880 and wide. Windows rules apply (nothing here starts a process).
- Named roles only; `scripts/check-ui-style.py` stays clean.
- Builds on #4461 (faces, gold Lead ring, status marks) and its gallery test: main is merged in after it lands, last.
- Out of scope: dropping Buddy as a kind; the left pane's rows (#4461 and later tasks).
- A palette the person chose that names its own sidebar (Plum) keeps it; the rule is one surface for the rest.

## Review Focus

- The combined menu does exactly what the two menus did: the current engine on a shared model goes back with
  `switchBuddyModel(null)` (was Your subscription), another engine with `switchBuddyEngine`, a shared model with
  `switchBuddyModel(model)`; a named Buddy still targets its own chat; busy states still disable rows.
- The bar keeps its geometry through hover (the chevron's room is kept at rest).
- Nothing else in the bar: no subscription, machine or "reads all your projects".

## Task 1: the quiet top bar

**Files:** `desktop/lib/super_tabs/chat/agent_chat_header.dart`, `desktop/lib/super_tabs/chat/engine_model_line.dart`
(new), `desktop/lib/super_tabs/buddy_engine.dart`, `desktop/lib/super_tabs/buddy_model.dart`,
`desktop/lib/super_tabs/buddy_card.dart`, `desktop/lib/super_tabs/view.dart` (the ⋯ icon),
`desktop/test/super_tab_agent_chat_header_test.dart`, tests that tapped the header's two pickers.

**Interfaces:** `SuperTabEngineModelLine({controller, agent, machine, buddy})`, key `super-agent-engine-model`;
`buddyEngineMenuRows(...)`, `buddyModelMenuRows(...)` → `List<Widget>`; `BuddyModelLine.rest` required.

- [ ] Test: every agent's bar is 44 high with a 22 face and the name in 13 semibold; on the right one line
      `engine · model` in 12 `textFaint`, no chevron at rest, a chevron and primary ink on hover with the same
      bounds; the Buddy's line opens one menu with its engines and the shared models and sends the same commands
      as before; another agent's line opens nothing; no subscription, machine or "reads all your projects"
      anywhere in the bar; the menu button is ⋯.
- [ ] Watch it fail.
- [ ] Build the line, share the menu rows, drop `BuddyModelLine`'s header-only branch, hide the Buddy card's chevron
      until hover, switch ⋮ to ⋯.
- [ ] Pass; run the Buddy engine, model and header tests.

## Task 2: one surface

**Files:** `desktop/lib/super_tabs/view.dart`, `desktop/lib/super_tabs/tasks/personal_tasks_pane.dart`,
`desktop/test/super_tab_tasks_pane_surface_test.dart`, `desktop/test/super_tab_one_surface_test.dart` (new).

- [ ] Test: over a host of another colour, the left, middle and right panes' pixels away from content are all
      `swarmField`, and the only lines between them are the 1-point `rim` hairlines; light and dark, at 880 and 1600.
- [ ] Watch it fail (the Tasks pane is the theme surface).
- [ ] Paint `swarmField` under the panes and in the Tasks pane.
- [ ] Pass; run the pane layout and Tasks pane tests.

## Task 3: design system and gallery

**Files:** `desktop/design/desktop-design-system.md`, `desktop/test/swarm_elements_gallery_test.dart` and its images
(from #4461).

- [ ] Gallery: the top bar of a Buddy and of a member agent, at rest and hovered, in light and dark; fails before the
      images exist.
- [ ] Generate, inspect, commit the images.
- [ ] Doc: the six rules, one surface, and the top bar's anatomy in the Swarm elements section.
