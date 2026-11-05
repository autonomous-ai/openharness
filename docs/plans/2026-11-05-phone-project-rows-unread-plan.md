# Phone project rows read as Desktop's Implementation Plan

**Goal:** A project row on the phone's Home stops being bold (and loses its dot) once the person has read the project's
chat, on the phone or on Desktop, as Desktop's sidebar row does (task #3268, Dee 11-05).

**Architecture:** The phone's `swarmProjectNews` (mobile/lib/swarm/swarm_unread.dart) bolds a project while its project
chat or any open task has any message past the read mark, agents' progress and system rows included. Desktop's row
(desktop/lib/super_tabs/project_sidebar.dart `_row`, since #2427 and #2638) is bold only for the project's own chat: a
person's message past the mark (`unreadForPeople`, the chat's `lastPersonSequence`) or a tag of the reader there. Busy
projects always have a task with a fresh agent post, so the phone's row never clears. The phone takes Desktop's rule;
tags and decisions in tasks still keep the project under Home's Unread and Mentions filters (`hasWaitingTag`), as
Desktop's `_hasUnread` keeps a project with tags in its work.

**Tech Stack:** Flutter (mobile/), flutter_test with the Swarm fixture (mobile/test/swarm/swarm_fixture.dart).

**Spec:** task #3268 brief; Desktop's rule in project_sidebar.dart `_row` and controller.dart `unreadForPeople`.

## Global Constraints

- Phone only: the server already sends `lastPersonSequence` and read marks in first loads and in polls (light groups
  leave them out, and the phone keeps a group's last whole copy), and Desktop already reads by this rule.
- Read marks from another device arrive in a poll's `readMarks`; the tests drive both the first load and a poll.
- A chat's own row inside the project (`swarmChatNews`) is unchanged, as Desktop's chat rows are.

## Review Focus

- The project row reads its own chat only, by `lastPersonSequence` against the higher of the server's and the phone's
  marks; muted never bold.
- Tags and decisions in tasks no longer bold the row, but `hasWaitingTag` still lists the project under the filters.

## Task 1: The project row reads as Desktop's

**Files:** mobile/lib/swarm/swarm_unread.dart, mobile/lib/swarm/swarm_read_marks.dart,
mobile/test/swarm/swarm_unread_test.dart, mobile/test/swarm/swarm_project_rows_read_test.dart (new), mobile/lib/swarm/swarm_home_list.dart,
mobile/test/swarm/swarm_home_read_sync_test.dart (new), existing Home and notification tests

**Interfaces:** `SwarmReadMarks.unreadForPeople(SuperTabConversation)`; `swarmProjectNews` keeps its type.

- [x] Failing tests: a project whose open task has agent posts past the mark is not bold; a project chat read on
  Desktop (a poll carrying the server's moved mark) clears the row; a project chat read on the phone clears it and sends
  the mark Desktop reads; an agent-only post in the project chat does not bold it, a person's does; tags in the project
  chat still bold it with its count; tags in a task leave the row quiet but `hasWaitingTag` set.
- [x] Run them; watch them fail.
- [x] `unreadForPeople` and the new `swarmProjectNews`; update the old tests that wrote down the old rule.
- [x] Run swarm_unread_test.dart, the new test and the Home tests that read project news.


## Completed validation and review notes

- The visible change follows the approved rule: after reading, `#openharness •` (bold) becomes
  `#openharness` (normal weight); an unread person message in `#design •` remains bold.
- Home widget tests exercise Desktop marks arriving alongside whole changed groups, and tapping the phone's
  project chat then returning to Home. Both run in light and dark using a fake account, in-memory read marks
  and an in-memory backend. Read-boundary, first-load, older server-mark, thread-only and mute cases have
  focused reader tests. Desktop's existing remote-mark/sidebar tests pass with the same rule.
- Task tags no longer bold the project. They still keep it in the filters and out of Other projects; the folding
  condition now uses the same news predicate as the filters. The existing tests of the previous bolding policy
  were updated with explicit person-message counters where an unread project is intended.
- Screenshot evidence is in `assets/phone-project-unread/`: before and after the production fix for each
  device's read flow in both themes. These are offscreen Flutter renders at 390 × 844 points, not simulator
  captures: this Team Mac has no simulator runtimes. This uses the project's Team-account fallback;
  a simulator run would additionally cover the native renderer/navigation environment.
- No storage, server, wire-format or migration change. iOS and Android share the changed Dart code.
  Rollback is reverting the client change; Desktop and the backend need no rollout changes.
