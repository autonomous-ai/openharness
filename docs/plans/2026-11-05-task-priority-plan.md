# Task Priority (P0–P3) Implementation Plan

> Implement task by task, test first, following the project's Engineer workflow (project instructions, Engineer).

**Goal:** Every task carries a priority P0–P3. People and agents can see it on the Tasks board, in the Backlog, in the task header, and in the CLI's `status` and `mine`. P0 goes first everywhere work is ordered.

**Architecture:** One optional `priority` field on the backend `Conversation`. `conversation.create` sets it, with P2 as the default and a warning in the reply. A proposal's low/normal/high maps onto it. A new `work.priority` command changes it and writes one plain-words system line into the task. Clients read an *effective* priority: the field, else the legacy title marker ("URGENT …", "(urgent)" → P0, "(high)" → P1), else P2. Clients sort by it inside each column or group.

**Tech Stack:** Backend TypeScript (zod commands, Vitest), CLI TypeScript (Vitest specs), Desktop Flutter/Dart (widget tests with a memory store and fake sign-in).

**Spec:** Swarm task #3117 brief; River's addition (one scale: proposal high→P1, normal→P2, low→P3; only the PM or a person sets P0); the ASCII mockup posted in the task's chat for Ken on 2026-11-05.

## Global Constraints

- Priorities are exactly `P0`, `P1`, `P2`, `P3`. Meanings (visible copy): P0 "Hotfix: something shipped is broken", P1 "Needed by users soon", P2 "Planned goal", P3 "Tools, docs or process".
- A task created without a priority gets P2, and the reply says so (`warnings` entry: `No priority given: this task is P2. Set P0–P3 with work.priority.`).
- Only the project's PM (coordinator) or a person sets P0 or changes a priority. A Buddy proposal maps high→P1, normal→P2, low→P3. A priority the PM writes on `conversation.create` wins over the proposal's.
- The change line, posted as a system row in the task: `{actor} changed the priority to {P}, {meaning lower-cased first letter} (was {old}).` For example: `Ken changed the priority to P0, hotfix: something shipped is broken (was P2).` Setting the same priority again changes nothing and posts nothing.
- Steps (`step` + `reviewOf`) and private chats (`audience`) carry no priority.
- Badge tokens: P0 `AppPalette.usageCritical`, P1 `AppPalette.warn`, P2/P3 `DesktopChrome.muted`. No new colors.
- Desktop tests use a memory store and a fake sign-in. Swarm code stays out of cli/src/core.

## Design

- growth: one short enum string per task, deleted with the task's conversation document. One system line per real change; same-value sets post nothing.
- concurrency: `work.priority` runs inside the existing per-Swarm command transaction like `work.queue`. Last write wins, and each write records its line.
- read cost: the field rides in the existing group part. No new read, query or index. The light loader lists it under `unread` (`parts/light.ts`).
- scale: 10x tasks is 10x four-byte fields, so it is not a factor. The metric that warns first stays the group-part size that is already tracked.
- compatibility: the field is additive. Old Desktop and CLI ignore it and keep reading the title marker. New clients treat a missing field as the title marker, else P2. Old backends never send it, and an old backend refuses `work.priority` as an unknown command, which Desktop shows as the menu's error.
- migration + rollback: no migration. Rolling back the backend leaves `priority` stored, and the old code ignores it.
- audience: the server enforces it. `coordinatorOrPerson` gates `work.priority`. `conversation.create` refuses P0 from an agent that is not the project's coordinator.
- identity: the change line names the actor (person's shown name or agent name). It never uses the machine owner's login.
- failure: a refused change returns a named error (`COORDINATOR_REQUIRED`, `PRIORITY_TASK_ONLY`). Desktop's header menu shows it inline.
- platforms: backend; CLI on macOS/Linux/Windows; Desktop on macOS, Linux, Windows and the web (shared Flutter).

## Review Focus

- Next up drag on Desktop after the priority sort: a card dropped between cards of another priority must still land in the shared queue at a sensible place. It stays inside its own priority band, so dropping it above a higher priority puts it first in its own band.
- A legacy task with no field but a "(urgent)" title shows P0 on the board, in the header and in `mine`, and the title shows without the marker.
- An Engineer opening a linked task with `priority: "P0"` is refused, but opening it with P1–P3 or none works.
- `work.priority` on a step, on the project chat or on a Buddy chat is refused (`PRIORITY_TASK_ONLY`), and the answer gives nothing away about other projects.
- A proposal with no or an unknown priority string maps to P2, without the "no priority given" warning.

---

### Task 1: Backend field, create default, proposal mapping, work.priority

**Files:**
- Create: `backend/src/superTabs/taskPriority.ts`, `backend/src/superTabs/taskPriority.test.ts`
- Modify: `backend/src/superTabs/model.ts` (Conversation), `backend/src/superTabs/commands.ts` (schema, `conversation.create`, new `work.priority` case), `backend/src/superTabs/parts/light.ts` (`GROUP_FIELDS.unread`), `backend/src/superTabs/proposals.ts` (`OpenProposal.priority`)

**Interfaces:**
- Produces: `type TaskPriority = 'P0' | 'P1' | 'P2' | 'P3'`; `TASK_PRIORITIES`; `PRIORITY_MEANING: Record<TaskPriority, string>`; `proposalPriority(value: unknown): TaskPriority` (high→P1, low→P3, else P2); `priorityLine(actorName: string, next: TaskPriority, previous: TaskPriority): string`.
- Wire: `Conversation.priority?: TaskPriority`. `conversation.create` takes an optional `priority`, and its result carries `priority`. Command `{ type: 'work.priority', conversationId, priority }`. `OpenProposal.priority: 'P1'|'P2'|'P3'`.

- [ ] Write failing tests in `taskPriority.test.ts`. A create with `priority: 'P0'` by the coordinator stores P0. A create without one stores P2 and the result has `priority: 'P2'` plus the warning. A create from a proposal whose source says `high` stores P1 with no warning. An Engineer's create with P0 is refused `PRIORITY_P0`. `work.priority` by a person stores the new value and posts the change line. A same-value set posts nothing. `work.priority` by a non-coordinator agent is refused `COORDINATOR_REQUIRED`. On a step it is refused `PRIORITY_TASK_ONLY`. The open proposals read carries the mapped priority.
- [ ] Run `cd backend && npx vitest run src/superTabs/taskPriority.test.ts`. Expected: FAIL.
- [ ] Implement it. Add `priority` to `GROUP_FIELDS.unread` so `light.test.ts` stays green.
- [ ] Run `npx vitest run src/superTabs/taskPriority.test.ts src/superTabs/parts/light.test.ts src/superTabs/proposals.test.ts src/superTabs/commands.test.ts`. Expected: PASS.
- [ ] Commit the test first, then the code.

### Task 2: CLI shows and asks for it

**Files:**
- Modify: `cli/src/superTabs/agentContext.ts` (label, `mine` order), `cli/src/superTabs/service.ts` (help text: `conversation.create` example gets `"priority":"P0|P1|P2|P3"` with the meanings, plus a `work.priority` example)
- Create: `cli/src/superTabs/taskPriority.ts`, `cli/src/superTabs/taskPriority.spec.ts`

**Interfaces:**
- Consumes: the `priority` field from Task 1.
- Produces: `effectivePriority(group: { priority?: unknown; title?: unknown }): 'P0'|'P1'|'P2'|'P3'`, which uses the field, else the title marker (leading `URGENT` → P0; trailing `(urgent)`/`(… , urgent)` → P0; `(high)`/`(… , high priority)` → P1), else P2.

- [ ] Write failing specs. `mineText` for the coordinator lists a P0 task before an older P2 task, and each line reads `#N P0 Title (conversation …)`. A legacy "(urgent)" title reads P0. An own-task line shows its priority. The help for `command` names `work.priority` and P0–P3.
- [ ] Run `cd cli && npx vitest run src/superTabs/taskPriority.spec.ts src/superTabs/agentContext.spec.ts`. Expected: FAIL.
- [ ] Implement it. Sort with a stable sort by priority rank and keep the existing order within a rank. `status` already prints the conversation JSON, so check in the spec that `priority` survives in the status payload.
- [ ] Run the same specs. Expected: PASS. Commit the test, then the code.

### Task 3: Desktop model, badge, sort, header menu

**Files:**
- Modify: `desktop/lib/super_tabs/model.dart` (`SuperTabConversation.priority`), `desktop/lib/super_tabs/backlog.dart` (`SuperTabTaskPriority` p0–p3 with `badge`/`meaning`; `superTabTaskPriority(task)` effective value; the title marker stays for stripping), `desktop/lib/super_tabs/task_groups.dart` (sort by priority first in every column; Next up then by queue order), `desktop/lib/super_tabs/task_card.dart` (badge leading the caption), `desktop/lib/super_tabs/tasks_view.dart` (pass priority; Next up moves stay inside their band), `desktop/lib/super_tabs/backlog_view.dart` (Px badge replaces URGENT/HIGH; sort within group), `desktop/lib/super_tabs/view.dart` (header badge button with a P0–P3 menu for tasks only), `desktop/lib/super_tabs/controller.dart` (`Future<String?> setTaskPriority(String taskId, SuperTabTaskPriority p)` sending `work.priority`, returning the refusal text or null), proposals (`SuperTabProposal.priority`)
- Test: `desktop/test/super_tab_task_priority_test.dart`

**Interfaces:**
- Consumes: `priority` on conversations and proposals; command `work.priority`.
- Produces: `enum SuperTabTaskPriority { p0, p1, p2, p3 }` with `badge` ('P0'…) and `meaning`; `SuperTabTaskPriority superTabTaskPriority(SuperTabConversation task)`.

- [ ] Write failing widget tests. A P0 task created after a P2 task shows the "P0" badge on its board card and sorts first in Next up and in Working. A legacy "(urgent)" title shows P0 and loses its marker. The header shows the badge and its menu lists the four meanings. Choosing P0 sends `work.priority` with P0. A refusal shows inline. The Backlog shows the Px badge and sorts P0 first. Dragging a P2 card above a P0 card in Next up places it first among P2s.
- [ ] Run `cd desktop && flutter test test/super_tab_task_priority_test.dart`. Expected: FAIL.
- [ ] Implement it, then run that file plus the affected existing tests (`super_tab_tasks_view_test.dart`, `super_tab_backlog_*`, `super_tab_task_groups_test.dart`). Expected: PASS. Run `flutter analyze` on the changed files.
- [ ] Commit the test first, then the code. Take light and dark screenshots of the board and the header for the PR.
