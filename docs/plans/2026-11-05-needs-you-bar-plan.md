# "Needs you" bar and header count badge Implementation Plan

**Goal:** The "<agent> needs you" bar under a chat shows only when the agent waits on the reader, and a click opens
that question where it is. The Tasks count in a chat's header sits on the icon's top-right corner (Leo and Dee, #3017).

**Architecture:** `desktop/lib/super_tabs/view.dart` only. `_needsHuman` decides who waits on the reader; a new
`_openQuestion` replaces `_openAgent` as the bar's tap; a private `_withCountBadge` places the shared
`SuperTabCountBadge` on a header icon's corner.

**Tech Stack:** Flutter widget tests with the `ConversationServer` fixture. **Spec:** the task brief in #3017
(positioning: Tell the PM what you want, and your crew ships it, by showing the reader only what waits on them).

## Global Constraints
- Stay out of the sidebar and Activity files (#2996). No new setting, no new files in `lib/`.
- Follow `desktop/design/desktop-design-system.md`; the badge keeps its tooltip and `super-tasks-badge` key.

## Review Focus
- A `blocked` task and a `needs_human` asked of someone else show no bar; the sidebar's Tasks count follows.
- The click never lands on a terminal that is already open without saying something.

## Task 1: Who the bar shows for
**Files:** `desktop/lib/super_tabs/view.dart` (`_needsHuman`), `desktop/test/super_tab_needs_you_bar_test.dart`.
- [ ] Failing tests: blocked shows no bar; needs_human asked of another person shows none; asked of the reader
  shows it; an open decision of the reader shows it.
- [ ] Implement `_needsHuman` by `askedOf` (else the liveness person), open decisions and terminal questions.

## Task 2: The click opens the question
**Files:** same.
- [ ] Failing tests: the click scrolls to the agent's latest message in the chat and lights it; an open decision
  opens Notifications; with only a terminal, the click opens it or says why it cannot.
- [ ] Implement `_openQuestion`.

## Task 3: Count badge on the icon's corner
**Files:** same.
- [ ] Failing test: `super-tasks-badge` sits on the Tasks icon's top-right corner and keeps its tooltip.
- [ ] Implement `_withCountBadge` and use it for the Tasks button.
