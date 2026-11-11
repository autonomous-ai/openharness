# Find in the open chat Implementation Plan

> Implemented by the task's Engineer task by task, each failing test committed before its code (project instructions,
> Engineer). Desktop and phone share no files, so their tasks run in parallel. One independent review on the pull
> request.

**Goal:** In the open chat (main chat or a thread), on Desktop/web and the phone, a find field lights the loaded
messages that match, shows "n of N", and steps through them with the jump-and-light a message link uses. When the
loaded part has no older match, stepping up reads older pages the way scrolling back does, at most 50 per search, then
says "No more matches in the last 50 pages". Case and accents fold: "tieng viet" finds "Tiếng Việt", "dong" finds
"đồng" (task #2826, Tony, phase 1).

**Architecture:** Each app gets one small find model and one find bar in a file of its own, used by both its main chat
and its thread view:

- Desktop/web: `SuperTabChatFind` and `SuperTabFindBar` in `desktop/lib/super_tabs/chat_find.dart`.
- Phone: `SwarmChatFind` and `SwarmFindBar` in `mobile/lib/swarm/swarm_chat_find.dart`.

The model is a `ChangeNotifier`. It is given three callbacks: the rows the view shows (oldest first), whether older
rows remain, and a read of one older page. It folds each row's text, keeps the matching ids, and numbers them from the
newest (1). Older pages then add matches above without moving "n". The page that owns the list does three things:

- It reveals and lights the current match with the jump path it already has (`_revealTarget` + `_light` on Desktop,
  `_jumpTo`'s `_target`/`_reveal`/`_lit` on the phone).
- It gives every match a quiet fill.
- It keeps the current match lit while find is open.

Reading back reuses each view's own older-page read: `_loadEarlier` / `loadThread(earlier: true)` on Desktop,
`loadOlder` / `loadEarlier` on the phone. There is no new route and no index.

**Tech Stack:** Flutter 3.47.2 (Dart 3.13). flutter_test widget tests: Desktop on the Super Tab fixture's
`ConversationServer` (memory store, fake sign-in), the phone on `FakeSwarm`. `unorm_dart` (already a dependency of
both apps) for NFD.

**Spec:** task #2826's brief. The mockup Tony was sent is in the task chat.

## Design

N/A for stored or synced data: nothing is stored, synced or exposed. It only reads pages the chat already reads, from
the same routes and under the same server-side audience checks. Read cost: a search reads at most 50 older pages,
only when the person steps past the oldest loaded match, and never while they type. The cost is measured in the pull
request. Platforms: macOS, Linux, Windows and web (one Desktop screen); iOS and Android (one phone screen).

## Global Constraints

- PR body first line: "Requested by tony@autonomous.ai through Harness."
- At most 50 older pages per search, counted from the moment the query last changed. Copy:
  - after 50 pages: "No more matches in the last 50 pages"
  - when the chat has no older page: "No more matches in this chat"
  - when a page read fails: "Couldn’t read older messages"
  - while reading: "Reading older messages · N of 50"
- Typing never reads a page. Only stepping up past the oldest loaded match does.
- Fold: NFD, strip U+0300–U+036F, `foldDiacritics` (đ→d and other letters NFD leaves whole), lowercase.
- Esc and the close button clear the query, the fills and the light, and stop a read-back in progress.
- No new server route and no index. Swarm code stays out of cli/src/core.
- Desktop tests use the fixture's memory store and fake sign-in. Phone tests run on the VM test runner (simulator
  only), never on a real phone.
- Harness design language: the bar uses the shared field, icon buttons and metadata type. Phone targets are 44
  points.

## Review Focus

1. A new message arriving while find is open: the current match stays the same message, and N grows if it matches.
   Pinned in Tasks 2 and 4 ("a new matching message keeps the current one").
2. Switching chats or opening another thread with find open: the find closes, and no read-back runs on for the old
   chat. Pinned in Tasks 2 and 4.
3. An empty or whitespace-only query matches nothing and reads nothing. Pinned in Tasks 1 and 3.
4. A thread's find matches the root and its replies only, never main-chat messages, and the main chat's find never
   matches thread-only replies. Pinned in Tasks 2 and 4.
5. Pressing up again while a read-back runs starts no second read-back. Pinned in Tasks 1 and 3 ("one read-back at a
   time").

---

### Task 1: Desktop find model and bar

**Files:**
- Create: `desktop/lib/super_tabs/chat_find.dart`
- Test: `desktop/test/super_tab_chat_find_test.dart`

**Interfaces:**
- Produces:
  - `String superTabFindFold(String text)`
  - `const superTabFindPages = 50`
  - `class SuperTabChatFind extends ChangeNotifier`, constructed as
    `SuperTabChatFind({required List<SuperTabMessage> Function() rows, required bool Function() hasOlder, required Future<bool> Function() readOlder})`.
    `readOlder` returns false when the read failed.
  - Members of `SuperTabChatFind`:
    - `String query`
    - `void search(String query)`
    - `List<String> matches` (ids, oldest first)
    - `Set<String> matching`
    - `String? current`
    - `int? number` (1 = newest)
    - `int get total`
    - `int? reading` (pages read so far in this read-back)
    - `String? note`
    - `Future<void> older()`
    - `void newer()`
    - `void refresh()` (rows changed)
    - `void clear()`
  - `SuperTabFindBar({required SuperTabChatFind find, required VoidCallback onClose, FocusNode? focus})`, keyed
    `super-find-field`, `super-find-count`, `super-find-older`, `super-find-newer`, `super-find-close`. In the field,
    Enter steps older and Shift+Enter newer.

- [ ] **Step 1: Write the failing tests**
  - `fold`: `superTabFindFold('Tiếng VIỆT đồng')` == `'tieng viet dong'`. The decomposed form folds the same.
  - `matches in loaded rows`: rows m1..m5, with m2 and m4 matching. After `search('x')`: `current == 'm4'`,
    `number == 1`, `total == 2`.
  - `stepping`: `older()` goes to m2 (2 of 2), and `newer()` back to m4 (1 of 2).
  - `reads older pages until a match`: no older match is loaded. A fake `readOlder` adds a page and only the third page
    matches. Expect `older()` to make 3 reads and leave the match current (3 of 3).
  - `50-page stop`: `readOlder` never matches and `hasOlder` stays true. Expect 50 reads, then
    `note == 'No more matches in the last 50 pages'` and `current` unchanged.
  - `chat start`: with `hasOlder` false, note == 'No more matches in this chat' and no read.
  - `failed read`: `readOlder` returns false, so note == 'Couldn’t read older messages' and the reads stop.
  - `one read-back at a time`: two `older()` calls while a read is held make one read.
  - `blank query`: `search('  ')` gives no matches and no read on `older()`.
  - `a new search starts the 50 again`: after a 50-page stop, `search` of another query can read 50 more.
- [ ] **Step 2: Run** `flutter test test/super_tab_chat_find_test.dart`. Expected: FAIL (no `chat_find.dart`).
- [ ] **Step 3: Implement `chat_find.dart`.** `refresh()` keeps `current` by id when it is still a match; otherwise it
  takes the newest. A generation counter stops a read-back when `search`/`clear` runs during it. The bar's count reads
  "n of N" when there are matches, the note or reading line when there is one, and "No matches" otherwise.
- [ ] **Step 4: Run the test again.** Expected: PASS.
- [ ] **Step 5: Commit** the test first (red), then the code (green).

### Task 2: Desktop main chat and thread panel use it

**Files:**
- Modify:
  - `desktop/lib/super_tabs/view.dart` (find state, bar under `_header`, row fills, reveal, Cmd+F)
  - `desktop/lib/super_tabs/thread_panel.dart` (bar under its header, row fills, reveal)
  - `desktop/lib/super_tabs/message_row.dart` (`SuperTabMessageHighlight` gets `match`)
  - `desktop/lib/shortcuts/keymap_commands.dart`: command `swarm.find_in_chat`, "Find in chat", context `swarmChat`,
    keys cmd+f (ctrl+f where Ctrl is the prefix)
- Test:
  - `desktop/test/super_tab_find_in_chat_test.dart`
  - `desktop/test/super_tab_unread_keys_test.dart` (the key lesson)

**Interfaces:**
- Consumes: Task 1.
- Produces: `SuperTabMessageHighlight({required bool on, bool match = false, required Widget child})`. The match fill is
  `DesktopChrome.selection` at half its alpha, and `on` wins.

- [ ] **Step 1: Write the failing widget tests** on `ConversationServer`, using `show()` as in
  `super_tab_reply_jump_test.dart`:
  - `Cmd+F opens the find field in the chat` (macOS variant). The swarmChat keymap maps cmd+f to
    `swarm.find_in_chat`, and the terminal context still maps it to `terminal.find`.
  - `matches in loaded messages are lit and counted`: 30 messages, 3 of them saying "Tiếng Việt". Typing "tieng viet"
    shows "1 of 3", the newest match row is highlighted, and the other two have the match fill.
  - `Up steps to the older match and brings it into view`.
  - `Up reads older pages until a match`: 250 messages, `messagePage = 50`, and the only match is message 10. Up reads
    pages until the match, then it shows "1 of 1" and is in view. `onRead` counts the pages read.
  - `the 50-page stop`: `messagePage = 1`, 80 messages, and no match. Up makes 50 reads, then shows "No more matches in
    the last 50 pages".
  - `Esc clears it`: the field is gone and no row is filled.
  - `a thread finds its own replies only`: a root with replies saying "lỗi" and a main-chat message saying "lỗi".
    Thread find shows "1 of 2" (root + replies containing it, no main-only message), and the main chat find leaves
    thread-only replies out.
  - `a new matching message keeps the current one`: `server.append` of a matching message while at "2 of 2" shows
    "3 of 3" on the same row.
  - `switching chats closes find`.
- [ ] **Step 2: Run** `flutter test test/super_tab_find_in_chat_test.dart test/super_tab_unread_keys_test.dart`.
  Expected: FAIL.
- [ ] **Step 3: Wire the main chat.**
  - `_find` is a `SuperTabChatFind` per open conversation, made when find opens.
  - Its `rows` are `superTabTranscriptEntries(_shownMessages(id))` with no interruptions.
  - Its `readOlder` is `_loadEarlier(id, keep: _find.current)`, which reports whether rows grew. `_readEarlierNearTop`
    skips while a find read-back runs.
  - A changed `current` sets `_target`, stops following the end and calls `_revealTarget(... arrived: ensureVisible
    .3 + _light)`.
  - The bar sits between the header's rule and the list. `swarm.find_in_chat` goes into `_unreadKeys`' actions: it
    opens the thread's find when the thread panel has focus and the chat's otherwise.
- [ ] **Step 4: Wire the thread panel.**
  - Its rows are root + replies.
  - Its `readOlder` is `_scroll.holdPlace(); await c.loadThread(earlier: true)`.
  - Its `hasOlder` is `c.hasEarlierReplies(root)`.
  - Rows get `GlobalKey`s for `ensureVisible`. Its own Esc closes find first, then the thread.
- [ ] **Step 5: Run the tests again.** Expected: PASS.
- [ ] **Step 6: Screenshots** in light and dark, offscreen (`SUPER_TAB_FIND_SHOTS=<dir>`): the main chat with "2 of
  5", the thread with "1 of 2", and the 50-page note.
- [ ] **Step 7: Commit** the tests first (red), then the code (green).

### Task 3: Phone find model and bar

**Files:**
- Create: `mobile/lib/swarm/swarm_chat_find.dart`
- Test: `mobile/test/swarm/swarm_chat_find_test.dart`

**Interfaces:**
- Produces: `SwarmChatFind` with the same members and contract as Task 1's `SuperTabChatFind` (rows are
  `List<SuperTabMessage>`), `swarmFindPages = 50`, and the same copy.
  - Folding reuses `swarmSearchFold` (`swarm_new_message_sheet.dart`), which already does NFD, the strip,
    `foldDiacritics` and lowercase.
  - `SwarmFindBar({required SwarmChatFind find, required VoidCallback onClose})`, keyed `swarm-find-field`,
    `swarm-find-count`, `swarm-find-older`, `swarm-find-newer`, `swarm-find-close`, with every button at 44 points.
  - Keyboard search action: older.
- [ ] **Steps 1–5:** the same tests and cycle as Task 1, run with `flutter test test/swarm/swarm_chat_find_test.dart`.

### Task 4: Phone chat and thread pages use it

**Files:**
- Modify:
  - `mobile/lib/swarm/swarm_chat_menu.dart` ("Find in chat" sheet action, after Work details)
  - `mobile/lib/swarm/swarm_conversation_page.dart` (bar under `_header`, row fills, reveal)
  - `mobile/lib/swarm/swarm_thread_page.dart` (🔍 button in `_header`, bar, fills, reveal)
  - `mobile/lib/swarm/swarm_message_row.dart` (`match` fill; `lit` kept for the current match)
- Test: `mobile/test/swarm/swarm_find_in_chat_test.dart`

**Interfaces:**
- Consumes: Task 3.
- Produces: `SwarmMessageRow(..., match: bool)`. The fill is `accentOnSurface` at 0.08 for a match and 0.16 when lit.
  `match` and the current match go into the row memo key (`swarm_conversation_page.dart` ~2003).

- [ ] **Step 1: Write the failing widget tests** on `FakeSwarm`, using `pump` from `swarm_chat_test.dart`:
  - the chat menu has "Find in chat" and it opens the field
  - matches in loaded messages are lit and counted
  - Up steps to the older match and shows it
  - Up reads older pages until a match (`routes['$messages?before=..']` chain, `fake.paths` counted)
  - the 50-page stop (51 chained pages, none matching): 50 reads, then the note
  - diacritics fold
  - close clears it
  - the thread page's 🔍 finds root + replies only
  - a new matching message keeps the current one
- [ ] **Step 2: Run** `flutter test test/swarm/swarm_find_in_chat_test.dart`. Expected: FAIL.
- [ ] **Step 3: Wire the conversation page.**
  - Its rows are `c.stream`, its `readOlder` is `c.loadOlder()` (rows grew?), and its `hasOlder` is `c.hasOlder`.
  - A changed current sets `_target`, `_reveal()`, and `_lit = id` for as long as it is current. The near-top reader
    skips while a read-back runs.
- [ ] **Step 4: Wire the thread page.** Its rows are root + replies, its `readOlder` is `loadEarlier()`, its
  `hasOlder` is `hasEarlier`, and it reveals as `_findFocus` does.
- [ ] **Step 5: Run the tests again.** Expected: PASS.
- [ ] **Step 6: Screenshots** in light and dark on the test runner (the chat with "2 of 5", the menu, and the thread).
- [ ] **Step 7: Commit** the tests first (red), then the code (green).

### Task 5: Read cost and evidence

- [ ] Measure a 50-page search: the requests and messages read (from Tasks 2 and 4's counting tests), plus bytes and
  time per page against the live API for a long chat, read with the same `before`/`beforeId` cursor. Put the numbers
  in the PR body.
- [ ] Post red/green evidence as a PR comment, and the screenshots to Tony with a person line.
