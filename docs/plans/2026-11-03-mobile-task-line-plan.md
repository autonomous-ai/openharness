# Phone Task Lines Implementation Plan

> **For agentic workers:** Implement task-by-task in this Engineer session using test-driven development, followed by independent Swarm Review and Test steps. No execution handoff.

**Goal:** Render server task lines on the phone with Desktop's words and marks and direct task-chat navigation.

**Architecture:** Add a focused task-line widget and loaded-message filter. The chat page supplies navigation only for a task held by its reader; the ordinary message renderer dispatches task-line messages before normal prose.

**Tech Stack:** Flutter 3.47.9, Dart 3.13.7, existing Lucide icons and phone design tokens.

**Spec:** [Phone task lines](2026-11-03-mobile-task-line-design.md), task #2239, Desktop `desktop/lib/super_tabs/task_line.dart`.

## Global Constraints

- Mobile implementation and tests only; these required design/plan files are the first commit.
- No new colors, icons, dependencies, switches or protocol changes.
- Exact Desktop lowercase words; only Answer is capitalized and reader-specific.
- Fakes only; never a real sign-out or physical-phone install.
- PR body begins: Requested by tony@autonomous.ai through Harness.

## Review Focus

- Waiting for another person must never ask this reader to Answer.
- Missing/malformed target must not open an unrelated chat; access changes must invalidate cached row actions.
- Legacy ship suppression must match task id, regardless of message order.
- Long titles, narrow screens and large text must keep the word and tap target usable.
- Unknown state and missing title retain a readable row; ordinary messages after special rows retain their author.

## Task 1: Render and open task lines in chat

**Files:**
- Create `mobile/lib/swarm/swarm_task_line.dart` (presentation and loaded-window filtering).
- Modify `mobile/lib/swarm/swarm_message_row.dart` (special-row dispatch).
- Modify `mobile/lib/swarm/swarm_conversation_page.dart` (target resolution, navigation, filtering and grouping).
- Create `mobile/test/swarm/swarm_task_line_test.dart` (real row and chat widgets using fake transport).

**Interfaces:**
- Produces `SwarmTaskLine({required SuperTabMessage message, required String readerId, VoidCallback? onOpen})`.
- Produces `List<SuperTabMessage> swarmTaskLineMessages(List<SuperTabMessage> messages)`.
- Extends `SwarmMessageRow` with optional `VoidCallback? onOpenTask`.
- Consumes `openSwarmConversation(BuildContext, String swarmId, String conversationId)` and reader snapshot conversations.

- [ ] Write and commit failing widget tests using existing public row/chat APIs: for each state assert literal title, word and Lucide mark; waiting for reader asserts Answer, another reader asserts working. Assert fallback title/unknown state, accessible label, narrow/large-text layout, target chat navigation, inaccessible target, per-task legacy ship suppression and author grouping after special rows.
- [ ] Run `flutter test test/swarm/swarm_task_line_test.dart --reporter expanded`; record expected failures (plain prose, missing state marks, no task navigation, duplicate ship row) on unchanged main production code.
- [ ] Implement the focused widget with phone typography, muted marks and minimum 44-point target. Dispatch before prose, resolve targets through the snapshot, filter redundant ship rows and exclude special rows from author grouping.
- [ ] Repeat the affected tests and commit passing code separately from the red tests. Push after this completed task.
- [ ] Run the full mobile `flutter test` once (20-minute bound), and analyze changed Dart files (5-minute bound). Independent checks may run alongside one another within capacity; no backend or Desktop suites are needed for mobile-only rendering. Record failures honestly and bound baseline diagnosis to 10 minutes.
- [ ] Mark the PR ready once green evidence is recorded. Ask Cleo for independent review and the named local Tester for iOS simulator screenshots of every state plus navigation. Read all acceptance checks before reporting completion.

## Validation and timing

Record implementation, validation, review/test waiting, merge and publication separately in the PR. Task received 2026-11-02 17:15 UTC. Engineer does not merge or release; PM owns those later phases. No deterministic receipt reuse is planned for newly added behavior. Required evidence: red/green task-line tests, full mobile suite, changed-file analysis, simulator screenshots and independent review/test verdicts.
