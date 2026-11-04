# Jump to unread bar and unread-chat shortcuts Implementation Plan

> Written by the task's Engineer, who implements it task by task, test first (project instructions, Engineer role).
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Swarm chat whose New messages line is above the screen shows a flat bar at its top, "N new messages ·
Jump ↑", that scrolls to the line on a click and goes on Esc; Alt+Shift+Up/Down open the previous or next unread chat
on every platform and are listed under Keyboard shortcuts.

**Architecture:** The bar replaces the up-pointing "Jump to first unread" pill inside the existing
`SuperTabUnreadBand` (which already keeps the messages still when it opens or closes); the down-pointing pill for a
chat opened from a link above the line stays as it is. The shortcuts become two keymap commands in the `swarmChat`
context, run by `SuperTabView` through a `KeymapRegion` that adds them to the enclosing quick switcher's actions, so
the keymap (not a hard-coded key handler) dispatches them, a person can rebind them, and on the web and Linux they win
over Move pane only while the chat has focus.

**Tech Stack:** Flutter 3.47 / Dart 3.13, `flutter_test` widget tests with the in-memory `ConversationServer` fixture.

**Spec:** Task #2604's brief (Huy, 2026-11-04), with River's rulings in its thread: the bar shows whenever the line is
above the screen, seen or not; the down pill stays; Move pane keeps Alt+Shift+Up/Down inside panes.

## Global Constraints

- Harness Design Language (desktop/design/desktop-design-system.md): tokens only, flat rows, colour never the only
  signal, no explanatory sentences.
- Copy: `N new messages · Jump` with an up arrow; `N+ new messages · Jump` when newer pages are not loaded yet; one
  message reads `1 new message · Jump`.
- The shortcuts walk `superTabSidebarOrder`, the order of the existing next unread, skipping muted chats.
- Desktop tests use a memory store and a fake sign-in; nothing signs the real CLI out.
- `python3 scripts/check-ui-style.py --only desktop/lib/super_tabs` and `test/laid_out_list_test.dart` pass before Ready.

## Review Focus

- A chat whose newest pages are not loaded: the count is a floor and says so (`12+`).
- A line scrolled far above, no longer laid out, after it was seen: the bar still shows (direction from its place in
  the list, not from "seen").
- Esc pressed with focus on the message list after clicking the bar, not in the composer: the bar goes.
- Alt+Shift+Down in a terminal pane on Linux or the web: Move pane down still runs there.
- A person who rebinds Next unread chat: the old Alt+Shift+Down no longer jumps (no hard-coded fallback).

---

### Task 1: Next and previous unread chat as keymap commands

**Files:**
- Modify: `desktop/lib/shortcuts/keymap_commands.dart` (two `HarnessCommand`s after `swarm.quick_switcher`)
- Modify: `desktop/lib/super_tabs/view.dart` (`_attentionKey` loses its Alt+Shift branch; a `KeymapRegion` around its
  `Focus`)
- Test: `desktop/test/super_tab_unread_keys_test.dart` (new), `desktop/test/super_tab_attention_wave2_test.dart`

**Interfaces:**
- Produces: commands `swarm.next_unread` ("Next unread chat", `alt+shift+down`) and `swarm.previous_unread`
  ("Previous unread chat", `alt+shift+up`), `ShortcutGroup.navigate`, `context: KeymapContext.swarmChat`,
  `repeatable: true`.

- [ ] **Step 1: Write the failing tests**
  - `the unread chat keys are Swarm chat commands on every platform` — for macOS, Linux and Windows:
    `harnessDefaultKeymap.match(KeymapContext.swarmChat, [alt+shift+down]).command == 'swarm.next_unread'`, up gives
    `swarm.previous_unread`; on Linux `match(KeymapContext.terminal, [alt+shift+down]).command` is still Move pane down.
  - `Keyboard shortcuts lists both unread chat keys` — `keyboardLessons()` holds rows labelled `Next unread chat` and
    `Previous unread chat` with their keys.
  - `on Linux, Alt+Shift+Down in the Swarm chat opens the next unread chat` — the wave 2 Swarm under a `KeymapHost`
    (as `swarm_screen.dart` mounts it), Linux variant: `selectedId` moves to `offline`.
  - The two existing wave 2 shortcut tests mount the same `KeymapHost`.
- [ ] **Step 2: Run them and watch them fail** — `flutter test test/super_tab_unread_keys_test.dart
  test/super_tab_attention_wave2_test.dart`: no such commands; Linux stays on `lead`.
- [ ] **Step 3: Add the commands and the view's region**; the region's actions are the enclosing region's plus
  `swarm.next_unread: () => _jumpUnread(1)` and `swarm.previous_unread: () => _jumpUnread(-1)`.
- [ ] **Step 4: Run them and the keymap tests** (`keymap_host_test.dart`, `super_tab_quick_switcher_test.dart`,
  `keymap_edit_test.dart`, `shortcuts_browser` tests): pass.
- [ ] **Step 5: Commit** (test commit first, then code).

### Task 2: The Jump to unread bar

**Files:**
- Modify: `desktop/lib/super_tabs/unread_line.dart` (`SuperTabUnreadBar`; `SuperTabUnreadLines.offersBar`,
  `offersDown`)
- Modify: `desktop/lib/super_tabs/view.dart` (`_checkUnreadLine` direction, the band's child, the count, Esc)
- Test: `desktop/test/super_tab_new_messages_test.dart`

**Interfaces:**
- Produces: `SuperTabUnreadBar({required int count, bool more = false, required VoidCallback onPressed})`, key
  `super-jump-unread` (the key the pill had, so the jump tests keep finding the way back), static
  `String label(int count, bool more)`; `bool offersBar(String id)` (placed, away, above);
  `bool offersDown(String id)` (placed, away, below, not yet seen).

- [ ] **Step 1: Write the failing tests**
  - `scrolled past the line, the bar says how many are new and jumps back to it` — 60 messages read to 20: at the end,
    the bar reads `40 new messages · Jump`, sits above the list, and a tap brings the line on screen and the bar goes.
  - `the bar comes back whenever the line is above the screen, seen or not` — replaces the two "once seen … offers no
    way back" tests.
  - `with newer pages not loaded, the count is a floor` — `40+ new messages`.
  - `Esc with the list focused dismisses the bar` — tap the bar, Esc: no bar, no line, read mark posted.
  - `SuperTabUnreadBar.label` — `1 new message · Jump`, `2 new messages · Jump`, `12+ new messages · Jump`.
- [ ] **Step 2: Run them and watch them fail** — `flutter test test/super_tab_new_messages_test.dart`.
- [ ] **Step 3: Build the bar** — a full-width flat row: `DesktopChrome.selection` fill, hairline `DesktopChrome.rim`
  below, `AppIcons.arrowUp`, the count in semibold `DesktopChrome.accent`, ` · Jump` beside it, a hand cursor and one
  `Semantics` button. `_checkUnreadLine` takes the direction from the line's place in the list whether seen or not;
  the count is the main-stream messages from others from the line's message on, `more` when `c.hasNewer`. Esc in
  `_attentionKey` runs `_readAll()` while the bar shows.
- [ ] **Step 4: Run the file, `super_tab_jump_to_unread_shots_test.dart`, `laid_out_list_test.dart`, the UI style
  check**: pass.
- [ ] **Step 5: Commit** (test commit first, then code).

### Task 3: Screenshots for Huy

**Files:**
- Modify: `desktop/test/super_tab_jump_to_unread_shots_test.dart` (light and dark of the bar)

- [ ] **Step 1:** Write the bar's light and dark pictures with `SUPER_TAB_UNREAD_SHOTS=<dir>`, before (main) and after
  (this branch).
- [ ] **Step 2:** Attach them to the pull request with the red/green evidence comment. No local whole suite: the pull
  request's CI runs Desktop's suite once it is Ready, and that green run is the suite evidence (Ken, 2026-11-04).
