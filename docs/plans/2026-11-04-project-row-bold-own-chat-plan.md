# Project row bold for its own chat Implementation Plan

> **For agentic workers:** Follow the project Engineer workflow: plan first in a draft PR; implement test first, with the failing test committed before its code; one independent review step on the pull request.

**Goal:** A sidebar project row is bold only for an unread person message, or a tag of the reader, in the project chat itself, folded or not. An unread task under it no longer makes it bold. Strengthens "Tell the PM what you want, and your crew ships it": the project row says when the PM's chat has something for the person, and nothing else.

**Architecture:** `_ProjectReading.unread` (desktop/lib/super_tabs/project_sidebar.dart) holds every open conversation of the project with something for a person. The row's bold reads only the project chat's entry there. A task's unread stays where the Tasks view (#2569) put it: its card, Activity, and the row's needs-you number.

**Tech Stack:** Flutter/Dart Desktop, widget tests with the memory store and a fake sign-in.

**Spec:** Swarm task #2638, conversation 68db455fee2929ca3f2803b3 (Huy, 11-04). Built on main cb6bb430, with the Tasks view merged (#2883 in batch #2908).

## Global Constraints

- Only the row's bold changes. The needs-you badge, Activity and the tasks' own cards are unchanged.
- The Unread filter (`_hasUnread`) is left as it is: it still keeps a project with an unread task or a tag of the reader. The brief owns the bold rule only, and the PR says so.
- Harness Design Language: the row's existing semibold and colour; no new style.
- PR body's first line: `Requested by phamngochuy.1989@gmail.com through Harness.`

## Design

N/A: nothing stored, synced or exposed changes. The row reads state the client already holds.

## Review Focus

- A folded project and an unfolded one read the same rule.
- A muted project chat is still never bold.
- A screen reader hears "Unread messages" on the project row only for its own chat.

---

### Task 1: The project row's bold

**Files:**
- Modify: `desktop/lib/super_tabs/project_sidebar.dart` (`_row`)
- Test: `desktop/test/super_tab_sidebar_reads_light_test.dart`, `desktop/test/super_tab_sidebar_rows_test.dart`, `desktop/test/super_tab_attention_test.dart`

- [ ] Step 1: failing tests:
  - With the project chat read and a task under it unread, the row is not bold.
  - A person's new message in the project chat makes it bold.
  - A tag of the reader in a task leaves the row regular; the tag is still its needs-you number.
  - A screen reader hears "Unread messages" on the row only for its own chat.
- [ ] Step 2: run them and see them fail on the old rule.
- [ ] Step 3: `_row` reads `reading.unread.contains(project.leadConversationId)`.
- [ ] Step 4: run the changed tests, plus Desktop's guard tests, and expect PASS. Before and after screenshots in light and dark, offscreen.
