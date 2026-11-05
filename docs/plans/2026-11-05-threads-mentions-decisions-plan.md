# Threads, Mentions and Decisions in the sidebar Implementation Plan

> Implemented by the task's Engineer task by task, each failing test committed before its code (project instructions,
> Engineer). Independent tasks (the server's typed answer, the Threads page) run in parallel, each test first, and
> are merged into one pull request.

**Goal:** Task #2996 (anh Dee, 11-05): finding what waits on you and getting back to threads is hard; adapt Slack's
way. The Swarm's sidebar gets three rows, each one thing and with no tabs: Decisions, Mentions, Threads. The Activity
page goes away, Buddy becomes the first row under Projects, and back/forward arrows (⌘[ / ⌘]) step through the reader's
places.

**Architecture:**

- `SwarmPage { decisions, mentions, threads }` names the three pages. The view's `_showNotifications` bool becomes
  `SwarmPage? _page`; each page is its own widget over the existing `SuperTabActivity` model, which already reads
  the decisions, tags, reminders and followed threads. `activity_view.dart`'s tabs go; its row (`_ActivityRow`, the
  day headings, the error bar, the read-more sentinel) moves to `page_rows.dart` as public building blocks the pages
  share.
- Counts: Decisions is `SuperTabActivity.needsCount` (decisions, agents waiting on the reader, due reminders), red.
  Mentions is the unread tags (`mentionsUnread`, the server's `mentionsWaiting` until read), red. Threads is the
  followed threads with unread replies (`attention.unread.length`), bold with a plain count, never red. The old
  Activity total (`count`, `unread`) goes.
- Decisions page: today's Needs you list. Each decision keeps its option buttons and gains "Or type your answer…" with
  Send: `SuperTabDecisions.answerInWords` sends `decision.answer` with `note` and no `choice`. A server before this
  change refuses it (400): the text stays in the field, and the row offers Open the chat. An agent waiting on the reader
  gets the same field; Send posts the text in its task to that agent, and the row leaves until the agent asks again
  (its question changes).
- Server: `decision.answer` takes `note` alone (a typed answer): stored with `choice` null and the note, so the asker
  reads it with `decisions --answered` as any answer. The schema already allows a null choice.
- Mentions page: each row is the tagging message: who, when, the text with the reader's tag highlighted, and
  `Mention in # project › thread`; unread first, then the read ones; Mark all read. Opening one opens its chat at that
  message, highlighted (the existing `_openMention`).
- Threads page: Slack's Threads view, one scrolling page of cards, unread threads first and then read ones, 50 at a
  time (`attention.readMore`). A card: `# project · thread title`, who is in it, the root in full, `Show N more
  replies` (opens the thread beside its chat), the last two replies in full with a `New` line above unread ones, their
  reactions, and a reply box with `Also send to # project`. A card's messages come from one read of the thread's newest
  page (`SuperTabThreadCards`, per controller, read again only when the thread's newest reply moves), drawn by the
  chat's own message row. A card shown marks its thread read. The title opens the thread beside its chat.
- Places: `SuperTabPlaces` (per controller) keeps the reader's places (a chat, a thread, a page) as a trail with a
  cursor, capped at 64. The view records where it is after each build; Back and Forward ask the view to go there.
  Arrows at the top of the sidebar; ⌘[ / ⌘] in a Swarm tab step its places first, and the tab/pane history as today
  everywhere else (and once a Swarm has no place to step to).
- The menu bar's Swarm section opens a decision on the Decisions page, a tag at its message, as before.

**Tech Stack:** Flutter (Desktop and web share the code), TypeScript backend (Vitest).

**Spec:** task #2996's brief and anh Dee's final mockup (River's last replies in his thread, 11-05), with his three
changes: the order Decisions, Mentions, Threads; no ▾ after Projects; typed answers on the Decisions page.

## Global Constraints

- Nothing else on the screen changes (anh Dee: don't redesign working UI).
- Threads never red; only Mentions and Decisions carry red counts.
- Option+Shift+Up/Down keep their order (Buddy, then the projects A to Z).
- Copy follows the Naming System: Decisions, Mentions, Threads, Buddy, "Or type your answer…", "Send", "Open the
  chat", "Mark all read", "Show N more replies", "New", "Also send to #project".
- Tests use a memory store and a fake sign-in; nothing signs the Mac out of the real CLI. Temp files only in
  `mktemp -d` folders.
- Before Ready: widget tests for each page, the sidebar counts and Buddy's place, back/forward, the Desktop guard
  tests (`check-ui-style`, `laid_out_list_test`), and light/dark screenshots of the sidebar and each page.

## Design

- growth: the thread cards' cache holds only the threads the Threads page lists (at most 250), dropped when the page
  closes; the places trail is capped at 64 and lives in memory only. The typed answer is the existing decision row's
  note (2,000 characters).
- concurrency: a decision answer is the existing per-tab command; a typed one is no different.
- read cost: a card reads its thread's newest page once, and again only when the followed-threads read says its newest
  reply moved; cards are built lazily as the list scrolls, so only cards near the screen read.
- scale: 10x threads means 10x cards in the list, 50 at a time; the first warning is the thread read count while the
  page is open (`GET messages?thread=`).
- compatibility: an older app never sends a typed answer. A newer app meeting an older server keeps the text and
  offers Open the chat. Old agents read a null `choice` with a note, as they read a withdrawn decision's null choice.
- migration + rollback: none; a rollback refuses typed answers again, which the app handles.
- audience: the server checks who may answer (`answerable`), as for an option.
- identity: N/A because nothing runs as a person's login.
- failure: a refused or failed answer stays in its field with its reason and Retry or Open the chat; a failed thread
  read says so on its card with Retry.
- platforms: macOS, Linux, Windows, web (shared Flutter code); the backend.

## Review Focus

- A decision answered elsewhere while text is typed: the row leaves and the text goes with it (the answer was given).
- A thread whose root is beyond its newest page: the card reads the root by id, as the thread panel does.
- A reply sent from a card while another thread is open beside the chat goes to the card's thread, not the open one.
- Back after the conversation was closed or lost: the place is skipped.
- ⌘[ in a terminal pane of a Swarm tab: places, not the terminal.

---

### Task 1: Server takes a typed answer

**Files:** Modify `backend/src/superTabs/commands.ts:349-351`, `backend/src/superTabs/decisions.ts:56,128-150`;
Test `backend/src/superTabs/decisions.test.ts`.

**Interfaces:** Produces: `decision.answer` with `{decisionId, note}` and no `choice`; `DecisionAnswer.choice:
number | null`.

- [ ] Write the failing tests: a typed answer (`note: 'Use the Mac Studio'`, no choice) answers the decision with
      `choice` null and that note, posts the answered notice to the asker, and the asker's `decisions --answered`
      read shows the note; neither choice nor note nor delegate is still refused.
- [ ] Run `npx vitest run src/superTabs/decisions.test.ts`: FAIL (refused, "Choose one of its options").
- [ ] Allow `note` alone in `answerDecision`; keep `delegate` and `choice` as they are.
- [ ] Run the tests: PASS. Commit.

### Task 2: Counts, typed answers and places in the model

**Files:** Modify `desktop/lib/super_tabs/activity.dart`, `desktop/lib/super_tabs/decisions.dart`; Create
`desktop/lib/super_tabs/places.dart`; Test `desktop/test/super_tab_pages_model_test.dart`.

**Interfaces:** Produces: `SuperTabActivity.mentionsCount`, `threadsCount`, `answeredWaiting(SuperTabNeed)`,
`answerWaiting(SuperTabNeed, String) -> Future<bool>`; `SuperTabDecisions.answerInWords(SuperTabDecision, String) ->
Future<bool>`, `refusedWords(SuperTabDecision) -> bool`; `enum SwarmPage {decisions, mentions, threads}`;
`SuperTabPlace({SwarmPage? page, String? conversationId, String? root})`; `SuperTabPlaces.of(controller)` with
`record(SuperTabPlace)`, `canGoBack`, `canGoForward`, `step(int)`, `takeStep() -> SuperTabPlace?`.

- [ ] Failing tests: Mentions and Threads counts; a typed answer sends `note` and no `choice` and the row leaves; a
      400 refusal keeps it open with `refusedWords` true; an agent waiting answered in words leaves until its question
      changes; places record, step back and forward, drop the forward trail on a new place, skip a place `valid`
      refuses, cap at 64.
- [ ] Run them: FAIL. Implement. Run: PASS. Commit.

### Task 3: Sidebar rows, Buddy under Projects, arrows

**Files:** Modify `desktop/lib/super_tabs/project_sidebar.dart`, `desktop/lib/shared/theme/app_icons.dart` (flag);
Test `desktop/test/super_tab_sidebar_pages_test.dart`.

**Interfaces:** `ProjectSidebar` takes `onPage(SwarmPage)`, `page: SwarmPage?`, `places: SuperTabPlaces?`
in place of `onNotifications` / `notificationsSelected`.

- [ ] Failing tests: rows Decisions, Mentions, Threads in that order under the Swarm row; Decisions and Mentions show
      a red `SuperTabCountBadge`, Threads a plain count and a bold label and never a badge; Buddy is the first row
      under Projects; Projects has no collapse chevron and keeps its filter and +; the arrows are disabled with no
      place to go and step when there is.
- [ ] Run: FAIL. Implement. Run: PASS. Commit.

### Task 4: The three pages

**Files:** Move `desktop/lib/super_tabs/activity_view.dart` to `page_rows.dart` (row, day headings, error bar,
read-more); Create `decisions_page.dart`, `mentions_page.dart`, `threads_page.dart`, `thread_cards.dart`; Tests
`desktop/test/super_tab_decisions_page_test.dart`, `super_tab_mentions_page_test.dart`,
`super_tab_threads_page_test.dart`; the old view tests move to the page they test.

- [ ] Failing tests per page (the brief's elements, each named above), including the refused typed answer offering
      Open the chat with the text kept, and a card's reply going to its own thread with Also send.
- [ ] Run: FAIL. Implement. Run: PASS. Commit.

### Task 5: The view, the menu bar and ⌘[ / ⌘]

**Files:** Modify `desktop/lib/super_tabs/view.dart`, `desktop/lib/screens/swarm_screen.dart` (history step and
`canGoBack`); Test `desktop/test/super_tab_places_view_test.dart`.

- [ ] Failing tests: each sidebar row opens its page with its title; a menu bar decision opens Decisions; Back from a
      thread opened from Threads returns to Threads, Forward returns to the thread; ⌘[ in a Swarm steps its places.
- [ ] Run: FAIL. Implement. Run: PASS. Commit.

### Task 6: Evidence

- [ ] Run the changed tests, `check-ui-style`, `laid_out_list_test`, `flutter analyze`; light and dark screenshots of
      the sidebar and each page; post them in the task.
