# Swarm sidebar reads light like Slack Implementation Plan

> Way of working: this project's instructions (Engineer role): implemented by the Engineer task by task, each failing test
> committed before its code; one review and one test on the pull request. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The Swarm sidebar reads like Slack's: names in regular weight and grey unless something is unread, one line per
task with its state as a small mark at the right, a quieter task number, and a compact tooltip that does not cover the
list.

**Architecture:** Today a task row is bold for any new message, and in a busy Swarm agents post all the time, so nearly
every row is bold (Huy's screenshot). A task row now counts as unread only for what is for a person: a new message from a
person, a mention of the reader, or the task waiting on the reader. The backend records each conversation's newest main
message from a person (`lastPersonSequence`, set where `lastMainSequence` is); Desktop compares it with the reader's mark.
The row drops its second line (the status stays readable to screen readers and in the tooltip), the number gets a smaller,
fainter style, and the tooltip sits to the right of the row through Flutter's `TooltipPositionDelegate`.

**Tech Stack:** Flutter 3.47 (Desktop and web), TypeScript backend (parts commit), Vitest, flutter_test.

**Spec:** Task #2427 brief (Huy, 11-03, PM: Accept) and the mockup posted to Huy in the task chat on 11-03 (default: build
as shown, his answer by 19:00 VN wins).

## Global Constraints

- Keyboard order and screen-reader labels unchanged; a task's state stays readable to assistive tech.
- Design-system roles only (`SwarmType`, `DesktopChrome`, `grid` tokens); `python3 scripts/check-ui-style.py --only
  desktop/lib/super_tabs` passes.
- Builds on #2733 (task groups): the row is the same widget inside its groups; main is merged once #2733 lands.
- PR body first line: "Requested by phamngochuy.1989@gmail.com through Harness."
- Desktop tests use a memory store and a fake sign-in.

## Design

- **Growth:** one number per conversation, overwritten; nothing accumulates.
- **Concurrency:** written in the same parts commit that writes `lastMainSequence`, under the Swarm's write lock.
- **Read cost:** no new read: the field rides in the conversation every read already returns. Not added to light loads
  (`GROUP_FIELDS.unread`): no check reads it.
- **Scale:** one integer per conversation; 10x conversations adds 10x integers to reads already sending them.
- **Compatibility:** a conversation without the field (before this backend) counts as having no person's message: its row
  is bold only for a mention or a wait until a person writes there. Desktop ships after the backend (release order).
- **Migration + rollback:** none; rolling back leaves the field unread.
- **Audience:** a sequence number only, in conversations the reader may already read.
- **Identity:** N/A because it records no person, only that the author was one.
- **Failure:** N/A because nothing new can fail: a missing field reads as 0.
- **Platforms:** backend; Desktop on macOS, Windows, Linux and the web (same widget).

## Review Focus

- A row the reader is in (selected) must stay findable without bold: its highlight carries it.
- A muted chat stays grey even with a person's message (today's rule).
- A collapsed project is bold only when a task it hides counts as unread by the new rule.
- The reader's own message must not make a row bold (their mark moves when they send).
- The tooltip must stay on screen near the window's right edge (sidebar on the left, so room is always to its right).

---

### Task 1: A conversation's newest message from a person (backend)

**Files:** Modify `backend/src/superTabs/model.ts` (`lastPersonSequence?: number`), `backend/src/superTabs/parts/commit.ts:105`,
`backend/src/superTabs/parts/light.ts` (`GROUP_FIELDS.unread`). Test: `backend/src/superTabs/parts/commit.test.ts` (or the
nearest unit test of message commits), integration `backend/integration/superTabRead.test.ts` (the read carries it).

- [ ] Failing tests: `a person's main message sets lastPersonSequence; an agent's, a system row and a thread-only reply do
  not`; integration: `a Swarm read gives each conversation its lastPersonSequence`.
- [ ] Red, commit; implement; green (`npm test`, `npm run test:super-tabs -- integration/superTabRead.test.ts`); commit.

### Task 2: Bold only for what is for a person (Desktop)

**Files:** `desktop/lib/super_tabs/model.dart` (`lastPersonSequence`), `controller.dart` (`unreadForPeople(group)`),
`project_sidebar.dart` (`_ProjectReading` unread set, task rows), test `desktop/test/super_tab_sidebar_reads_light_test.dart`.

**Interfaces:** `bool SuperTabController.unreadForPeople(SuperTabConversation group)`: not muted and
`(group.lastPersonSequence ?? 0) > readMark(group.id)`. A task row is bold when that, or a mention, or a wait on the reader.

- [ ] Failing widget tests: `a task with only agents' new messages reads regular and grey`; `a person's new message, a
  mention, or a wait makes it bold`; `a muted one stays grey`; `the selected row is regular weight, highlighted`; `a
  collapsed project is bold only for a task that counts`.
- [ ] Red, commit; implement; green; commit.

### Task 3: One line per task, a quieter number, a compact tooltip beside the list (Desktop)

**Files:** `project_sidebar.dart`, `workgroup_name.dart` (`quietNumber`), `task_status.dart` (tooltip text), test in the same file.

- [ ] Failing widget tests: `a task row is one line high, its state mark at the right`; `its state is in its semantics label`;
  `the number is smaller and fainter than the title`; `the tooltip opens to the right of the row, not over the rows below`.
- [ ] Red, commit; implement; green; commit.

### Task 4: Screenshots and before Ready

- [ ] Before/after, light and dark, from an in-memory render (`SIDEBAR_LIGHT_SHOTS=dir`), beside Huy's Slack screenshot.
- [ ] Backend unit + full Super Tab integration suite; Desktop sidebar tests; `flutter analyze`; style check.
- [ ] Red/green PR comment; Ready; a Reviewer and a Tester (Desktop on a Mac) by Routing.
