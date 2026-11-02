# Phone Swarm Message Markdown Implementation Plan

> **Execution:** The assigned Engineer implements each task natively in this worktree, test first, then requests one independent review from Cleo.

**Goal:** Render Swarm phone message prose with the same Markdown subset as Desktop and make web links and numbered conversations open from messages.

**Architecture:** Replace the phone message's plain prose span with a focused Markdown widget styled with existing phone tokens. Keep the existing fenced-code widget and message-row actions, and pass conversation-number references from the loaded Swarm snapshot so links can use existing navigation.

**Tech Stack:** Flutter, `flutter_markdown_plus` and its `markdown` syntax extensions (the same maintained Markdown renderer Desktop uses), existing `url_launcher`, Flutter widget tests.

**Spec:** Harness task #2256, conversation `e91e0b56aa51d3beeb519dd7`.

## Screen sketch

```text
┌─────────────────────────────────────────┐
│ River · PM                         10:42 │
│                                         │
│ Findings                                │
│                                         │
│ The **reconnect** change is ready.      │
│ • Handles *slow* networks               │
│ • See #42 and the review link           │
│                                         │
│ ┃ “No agent work was lost.”             │
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │ name.txt                       Copy │ │
│ │ one line of code                    │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

Web links and `#42` render as phone link text and open their destination when tapped. The message surface still opens its existing reply action on a non-link tap and its existing long-press menu on a hold.

## Global Constraints

- Mobile only (`mobile/`); base the change on current `main`.
- Follow the existing Swarm screen styles and design tokens; add no colors or icons.
- Never install builds on anyone's phone; tests use fakes and never sign out a real account.
- Keep long press, reply tap, code Copy/Show more, and scrolling for long reports working.
- Add no on/off switch. If the Markdown package is added to mobile, use the maintained renderer already used by Desktop and note that choice in the PR.
- Put the ASCII sketch and this plan in the draft PR before implementation; commit failing tests before production changes.

## Review Focus

- A tap on a Markdown link or `#N` must not also trigger the message's reply action; exercise the real nested gesture behavior.
- A long press over rendered Markdown must still open the message's existing menu.
- Long reports with headings, lists, tables, and links must lay out and scroll without overflow.
- Code spans and fenced or indented code must not become tappable links or lose literal Markdown characters.
- Unknown conversation numbers and non-HTTP(S) link schemes must not open an unintended destination.

---

### Task 1: Render Markdown in message prose

**Files:**
- Create: `mobile/lib/swarm/swarm_message_text.dart`
- Modify: `mobile/lib/swarm/swarm_message_row.dart`
- Test: `mobile/test/swarm/swarm_message_markdown_test.dart`
- Modify: `mobile/pubspec.yaml`, `mobile/pubspec.lock` (only if the renderer is not already a mobile dependency)

**Interfaces:**
- Consumes: `SwarmTextPart` from `swarm_code_block.dart`, `SwarmMentions`, `swarmChatText`, `AppPalette`, and the existing code-block row.
- Produces: `SwarmMessageText({required String text, required SwarmMentions mentions, Iterable<String> tagged = const [], Map<String, String> addresses = const {}})`, which renders Markdown prose; `SwarmMessageRow` continues to own code blocks and message actions.

- [ ] **Step 1: Write failing widget tests** named `headings render as headings`, `strong and emphasis render with Markdown styles`, `ordered and unordered lists render their items`, `inline code is styled as code`, `quotes render as blockquotes`, `GFM tables render rows and cells`, `prose tap still opens reply`, and `a long report scrolls and keeps the message long press`.
- [ ] **Step 2: Run the focused widget test on the unchanged implementation** and record the expected failures where Markdown is still literal.
- [ ] **Step 3: Implement `SwarmMessageText`** with `MarkdownBody`, the GitHub Flavored Markdown extension set, and phone design tokens; preserve the existing message prose tap and mention styling.
- [ ] **Step 4: Run the focused widget test** and confirm each element renders and long content has no layout exception.
- [ ] **Step 5: Commit the failing tests, then commit the passing implementation.**

### Task 2: Open web links and numbered conversations

**Files:**
- Modify: `mobile/lib/swarm/swarm_message_text.dart`
- Modify: `mobile/lib/swarm/swarm_message_row.dart`
- Modify: `mobile/lib/swarm/swarm_conversation_page.dart`
- Test: `mobile/test/swarm/swarm_message_markdown_test.dart`

**Interfaces:**
- Consumes: Task 1's `SwarmMessageText`, and loaded `SuperTabConversation.number` values from the Swarm snapshot.
- Produces: message link taps call `launchUrl` only for validated HTTP(S) URLs; a known `#N` calls the existing conversation opener with that conversation id; unknown references remain plain text.

- [ ] **Step 1: Write failing widget tests** named `Markdown web links open only their HTTP destination`, `bare web links open in the in-app browser`, `a known conversation number opens that conversation`, `an unknown conversation number remains plain text`, and `tapping a link does not trigger message reply`.
- [ ] **Step 2: Run the focused widget tests on the unchanged implementation** and confirm the missing link behaviors fail.
- [ ] **Step 3: Implement validated web-link handling and snapshot-backed `#N` routing** without changing the message row's outer long-press behavior.
- [ ] **Step 4: Run the focused widget tests** and confirm expected destinations and no unintended reply tap.
- [ ] **Step 5: Commit the failing tests, then commit the passing implementation.**

### Task 3: Capture the long agent report

**Files:**
- Test: `mobile/test/swarm/swarm_message_markdown_shots_test.dart`
- Screenshot: `$SWARM_MESSAGE_MARKDOWN_SHOTS/swarm-message-markdown.png` (the repository's established environment-selected screenshot output pattern)

**Interfaces:**
- Consumes: the production message row and deterministic fake message/conversation data.
- Produces: a reviewable image of a long agent report with Markdown and links, included in the PR.

- [ ] **Step 1: Add a screenshot test** for a long report containing headings, emphasis, a list, a quote, a table, a web link, `#N`, and a code block, following `swarm_project_c_shots_test.dart`'s environment-selected output convention.
- [ ] **Step 2: Capture the screenshot and inspect that it shows a readable long report.**
- [ ] **Step 3: Attach the screenshot in the PR and commit the screenshot test.**

## Validation

- Run `flutter test test/swarm/swarm_message_markdown_test.dart` from `mobile/` for each Task 1 and Task 2 red/green cycle.
- Run the affected mobile Swarm widget tests, including existing code-block and chat tests.
- Generate and inspect the long-report screenshot, then attach it to the PR.
