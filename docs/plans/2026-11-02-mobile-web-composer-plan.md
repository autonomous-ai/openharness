# Mobile web: two-level message composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On mobile web the message field spans the full width and grows to about 5 lines, with New session and attach left and send right on a row below it, right above the keyboard.

**Architecture:** One branch in `SuperTabView`'s composer on `_phone` (`workspaceIsCompact`, true only on the web below `compactBelow`), which already decides every phone layout there. The field and each action stay the same widgets, so sending, drafts, drop and paste are shared; only their arrangement differs. Nothing changes where `_phone` is false.

**Tech Stack:** Flutter 3.47, widget tests with `test/support/super_tab_phone.dart`.

**Spec:** Task #2114 (Huy, IMG_4431), its ASCII mockup in the task chat.

## Global Constraints

- Mobile web only; desktop and wide layouts unchanged.
- The Harness design language: existing tokens and widgets (`AppIconButton`, `SuperTabComposerToggle`, `DesktopChrome`), finger-size targets on a phone.
- Short placeholder: "Message Buddy" in the reader's Buddy chat, on one line.
- The field grows to 5 lines, then scrolls.
- Safari's own password/card/location row above the keyboard cannot be removed from a web page: the composer sits against it.
- PR body starts: `Requested by phamngochuy.1989@gmail.com through Harness.`

## Review Focus

- A long draft at 5 lines: the field scrolls inside itself and the send row stays visible, even with little height left above the keyboard.
- Typing across a rotation or a resize past the compact width: the draft, its cursor and focus survive the change of arrangement.
- Text scaled up, or a narrow 320 px phone with New session and its project menu both showing: the action row does not overflow.
- A chat that does not offer New session (a task, the project chat): attach and send still sit on the row below, send at the right.
- Files attached: their chips stay above the field, and a long title's placeholder stays on one line in every chat.

---

### Task 1: The phone arrangement

**Files:**
- Modify: `desktop/lib/super_tabs/view.dart` (composer around `super-message-composer-surface`, the note below it, `_messageHint`)
- Test: `desktop/test/super_tab_phone_composer_test.dart` (new)

**Interfaces:**
- Consumes: `mountPhoneSuperTab(tester, Size)`, `unmountPhoneSuperTab` from `test/support/super_tab_phone.dart`.
- Produces: `ValueKey('super-message-composer-actions')` on the row below the field, for the Tester and later tests.

- [ ] **Step 1: Write the failing tests** at 390x844: the field spans the surface's inner width; the actions sit below it, attach left of send and send at the right edge; 5 lines of text grow the field and 8 do not grow it further; a 1 line hint; at 320 px with New session no overflow; 1280 wide keeps one row.
- [ ] **Step 2: Run them and watch them fail** with `flutter test test/super_tab_phone_composer_test.dart`.
- [ ] **Step 3: Implement**: build the field and actions once; `_phone` lays them out as a Column, else the existing Row. `maxLines` 5 on a phone. Short hint on a phone.
- [ ] **Step 4: Run them and watch them pass.**
- [ ] **Step 5: Commit.**

### Task 2: Against the keyboard

**Files:**
- Modify: `desktop/lib/super_tabs/view.dart` (row padding, `super-chat-session-note`)
- Test: `desktop/test/super_tab_phone_composer_test.dart`

**Interfaces:**
- Consumes: `super-message-composer-surface`, `super-chat-session-note`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**: on a phone, the distance from the surface's bottom to the screen's bottom is at most 8 with New session off and on; the note, shown only while on, sits above the surface; a wider window keeps its reserved line.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement**: on a phone no reserved note line, the note above the box only while on, side padding 12, bottom 8.
- [ ] **Step 4: Run them, and the composer test files that name changed symbols (`grep -l super-message-composer`, `super-chat-session-note`).**
- [ ] **Step 5: Commit, open the pull request, add the review step (Rowan) and test step (Tester on Tony's Mac).**
