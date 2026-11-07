# The chat header, Buddy card and My agents rows fit, follow renames and say what they do: implementation plan

> This plan is carried out by the project's Engineer way of working (test first, task by task, one pull request), not
> subagent-driven-development. There is no execution handoff.

**Goal:** Fix findings 6, 7, 8, 9, 15, 16 and 18 of the Desktop 1.3.89 audit (task #4436,
`docs/audits/2026-11-07-desktop-1.3.89.md` on PR #3526): the most visible problems a person hits in 1.3.89's Swarm v3
screens. This is task #4444.

**Architecture:** Desktop only, each fix in the widget that draws it, with the components and styles already there:

- 6: `SuperTabAgentChatHeader` gives the name its width first; the engine and model labels shrink with "…" after it,
  and ⋮ never leaves the row. The Buddy's model line does the same.
- 7: a launch-flag chip (`launch_flags_field.dart` `_Chip`) is as wide as the field at most, its word cut with "…"
  and whole in a tooltip, and its × inside.
- 8: the Board's Buddy row in My agents takes the Buddy's own name and agent, as the other agent rows do; an agent's
  composer says "Message <agent name>", not the chat's title.
- 9: `SuperTabBuddyRow` draws the activity mark beside the name when it has no second line, says "offline" for an
  agent that is down, drops its two empty right columns and uses the sidebar's row text (`SwarmType.sidebar`), as
  + New agent and the projects do.
- 15: the Buddy card says "Can't reach <computer>" when the computer's list isn't there, and why Restart isn't offered;
  an unconfirmed restart turns Restart into Check status, which checks the same attempt instead of restarting again,
  with copy that fits the card; Remove asks "Remove <name>?" with a red button and shows a failure in the dialog;
  the Board Buddy chat's ⋮ is "Chat options", not a second "Buddy options".
- 16: an agent's own chat's ⋮ is "Agent options", and its Rename renames the agent (`controller.renameAgent`) in the
  app's one rename prompt (`TerminalNamePrompt`).
- 18: a PM's chat on the Board has one header row: its name, Board / Chat, then its icons. The Tasks icon leaves that
  row, its count moving to the Board tab, so the Board has one way in.

**Tech Stack:** Flutter, widget tests with the memory-store fixtures and real fonts; screenshots with
`HARNESS_SUPER_TAB_CAPTURE=<dir>`.

**Spec:** the audit's findings 6, 7, 8, 9, 15, 16 and 18 and their rows in its Proposed tasks.

## Global Constraints

- Desktop only (`desktop/lib/`, `desktop/test/`); no server change is needed: `agent.rename` already exists.
- Change only what the findings name; reuse the existing components, text styles and theme tokens.
- Tests use a memory store and a fake sign-in; nobody signs in and no login is read.
- Light and dark screenshots of every changed screen in `docs/plans/assets/v3-header-card-rows/`.
- Windows rules: no process is started.

## Review Focus

- The header keeps the name and ⋮ on screen at 880 with a long model name, for an agent and for the Buddy.
- Check status reuses the unconfirmed attempt, so a second press never restarts the Buddy twice.
- Agent Rename sends `agent.rename` for the agent, not a chat rename.
- My agents rows on the phone (`compact`) keep their sizes.

---

### Task 1: The chat header keeps the name and ⋮ on screen (finding 6)

**Files:** Modify `desktop/lib/super_tabs/chat/agent_chat_header.dart`, `desktop/lib/super_tabs/buddy_model.dart`;
test `desktop/test/super_tab_agent_chat_header_test.dart`.

**Interfaces:** none new.

- [ ] Test: at 880 with `openrouter/qwen/qwen3-coder-480b-a35b-instruct`, the name is whole or shows more than its
  first letters, the model ends in "…", there is a gap before the engine, and ⋮ is inside the header; the same for the
  Buddy at 880. Light and dark shots.
- [ ] Run it and watch it fail.
- [ ] Implement; run the header test and the Buddy model tests.
- [ ] Commit and push.

### Task 2: A long launch flag stays inside the Buddy card (finding 7)

**Files:** Modify `desktop/lib/super_tabs/launch_flags_field.dart`; test `desktop/test/launch_flags_field_test.dart`.

- [ ] Test: a 200-character flag fits the field with "…", its full text is in a tooltip, its × is inside the field and
  removes it, and nothing overflows. Light and dark shots of the card.
- [ ] Run it and watch it fail.
- [ ] Implement; run the field and Buddy card tests.
- [ ] Commit and push.

### Task 3: My agents rows show the agent's own name, status and the full row (findings 8 and 9)

**Files:** Modify `desktop/lib/super_tabs/project_sidebar.dart`, `desktop/lib/super_tabs/buddy_rows.dart`,
`desktop/lib/super_tabs/view.dart` (`_messageHint`); test `desktop/test/super_tab_v3_left_test.dart`.

**Interfaces:** `SuperTabBuddyRow(..., bool compact = false)`.

- [ ] Test: the Buddy row shows the Buddy's name and avatar; after a rename the composer says the new name; a row
  shows its activity mark beside the name and "offline" when down; names reach the row's right edge; row text is
  the size of + New agent's. Shots at 880 and 1500, light and dark.
- [ ] Run it and watch it fail.
- [ ] Implement; run the left pane, Buddy row and composer tests.
- [ ] Commit and push.

### Task 4: The Buddy card's status, Restart and Remove say what is true (finding 15)

**Files:** Modify `desktop/lib/super_tabs/buddy_card.dart`, `desktop/lib/super_tabs/buddy_restart.dart`,
`desktop/lib/super_tabs/buddies.dart`, `desktop/lib/super_tabs/view.dart` (the ⋮ tooltip); tests
`desktop/test/super_tab_board_buddy_card_test.dart`, `desktop/test/super_tab_buddy_restart_test.dart`.

**Interfaces:** `restartBuddyWithFlags(..., check)` or an equivalent that reuses the pending attempt.

- [ ] Test: with the computer's list missing the card says "Can't reach <computer>" and why Restart isn't there; an
  unconfirmed restart shows card copy and Check status, which sends a status check, not a second restart; Remove says
  "Remove <name>?", its button is red, and a refused remove keeps the dialog open with the reason; the two menus are
  named apart. Light and dark shots.
- [ ] Run it and watch it fail.
- [ ] Implement; run the Buddy card, restart and remove tests.
- [ ] Commit and push.

### Task 5: An agent's ⋮ acts on the agent (finding 16)

**Files:** Modify `desktop/lib/super_tabs/view.dart` (`_options`); test `desktop/test/super_tab_agent_chat_header_test.dart`.

- [ ] Test: an agent chat's ⋮ is "Agent options"; Rename opens the rename prompt with the agent's name and sends
  `agent.rename` for that agent; the header then shows the new name. Light and dark shot of the menu.
- [ ] Run it and watch it fail.
- [ ] Implement; run the header and group menu tests.
- [ ] Commit and push.

### Task 6: A PM's chat has one header row (finding 18)

**Files:** Modify `desktop/lib/super_tabs/view.dart` (`_header`, the full view's column); test
`desktop/test/super_tab_v3_left_test.dart` or a new `desktop/test/super_tab_pm_chat_header_test.dart`.

- [ ] Test: a PM's chat on the Board shows its name, Board / Chat and its icons on one row; there is no Tasks icon
  beside the Board tab; the Board tab carries the needs-you count; Board → Chat keeps the tabs on the same line.
  Light and dark shots.
- [ ] Run it and watch it fail.
- [ ] Implement; run the PM chat, Board and project tab tests.
- [ ] Commit and push.
