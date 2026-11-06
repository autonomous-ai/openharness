# Desktop Board, Phase 2: decisions, Needs you, propose, priority and pause, Buddies, Can chat — plan (task #3820)

**Goal:** In a project switched to the Board way of working, Desktop shows each card's decision, open question and
"waiting on you" mark, a Needs you bar over the Board, + New proposal on the Board, priority and pause controls by
role, the person's Buddies as a list with + New Buddy, and Project → People with a Can chat switch; the Chat tab is
read-only for someone without Can chat. A project that is not switched looks and works exactly as today.

**Architecture:** Every new control reads a field the backend's Phase 2 tasks add to the Swarm snapshot, and sends
their commands; with the field absent (a project not switched, or an older backend) the screen is today's. Rights
are the server's: the app hides a control the reader can't use, and when the server refuses anyway it shows the
server's sentence. Contracts (drafts, posted in #3820's chat, followed as they change):
- #3819 (Relay): project `boardMode: true` | absent; `canChat: [personId]` (project owner and Swarm owner always
  may); `decider: personId`; task `paused: {by, at, reason?}`. Commands `project.boardMode`, `project.canChat`,
  `project.decider` (owner or Swarm owner), `work.pause {conversationId, reason?}`, `work.resume {conversationId}`.
  Refusals CHAT_NOT_ALLOWED, PRIORITY_FORBIDDEN, PAUSE_FORBIDDEN (403, saying who can).
- #3818 (Headfix): a person's Buddies are their `swarm-buddy` chats; the default carries `buddyDefault: true` (none
  flagged: the first is the default). `buddy.create {machineId, engine, model?, name?}` makes a new Buddy in a new
  chat; `buddy.rename`, `buddy.remove {conversationId}`, `buddy.default {conversationId}`. Cap `buddyCap` (5 when
  unset), refusal BUDDY_CAP; BUDDY_PERSON for anyone else's.
- #3817 (Fir): a card's `proposal` record on its conversation (decision Accept / Reshape / Later with a date / No,
  reason, the sending person and Buddy, an open question with its default and time, who it waits on), gated by
  `boardMode`. Field names and the person's propose and answer commands: pending Fir's draft.

The Board, cards and header are `tasks_view.dart`, `task_card.dart`, `task_groups.dart` and `view.dart`
(`_boardHeader`, `_boardChat`); parsing is `model.dart`; commands go through `SuperTabController.command`, whose
refusal is `operationError`. Builds on #3812's six columns (PR #3381): this change adds lines and controls to cards
and leaves the columns to it.

**Tech Stack:** Flutter 3.47 (Desktop), `flutter_test` with `ConversationServer` (memory store, fake sign-in).

**Spec:** docs/plans/2026-11-06-buddy-board-final-spec.md (approved by Ken and anh Dee, 11-06): The Task Board,
Many Buddies, Phases (2.2), Design.

This plan is written and carried out by its Engineer, test first; there is no execution handoff.

## Design

- Growth: N/A because the app stores nothing new; cards and Buddies are the server's records and leave with them.
- Concurrency: every change is one server command; the app shows the server's state after it, never a guess.
- Read cost: reads only the snapshot fields above, from the change feed it already follows.
- Scale: the Needs you bar and card lines are built from the board already in memory (no new read per card).
- Compatibility: a field absent is today's screen, so an older backend or a project not switched is unchanged.
- Migration + rollback: N/A because UI only; rollback is a revert.
- Audience: the server enforces every right (Can chat, P0, pause, Buddies); the app only hides what it would refuse.
- Identity: commands go as the signed-in reader, never the machine owner.
- Failure: a refused or failed command shows the server's sentence beside its control; nothing fails silently.
- Platforms: Desktop on macOS, Windows and Linux; no process is started (Windows: no window flash).

## Global Constraints

- Projects not switched (no `boardMode`) behave exactly as today: every new control and line is behind it, and a
  regression test proves the unswitched Board and chat unchanged.
- Rights are the server's; the app hides controls by the same roles and shows refusals.
- Harness design language (`scripts/check-ui-style.py`), light and dark; the four `DesktopChrome` text roles.
- Desktop tests use a memory store and a fake sign-in.

## Review Focus

- Nothing changes for a project without `boardMode`.
- No control offered to a reader the server would refuse; every refusal shown, none swallowed.
- Several Buddies: the right pane's chat follows the selected Buddy, and the default is the one opened first.

## Tasks

### 1. Read the Phase 2 fields (`model.dart`, `task_groups.dart`)

Interfaces: `SuperTabProject.boardMode`, `.canChatIds`, `.deciderId`, `canChat(personId)`, `canSteer(personId)`
(owner, Swarm owner or decider); `SuperTabConversation.paused`, `.proposal` (`SuperTabProposalRecord`),
`.buddyDefault`; controller `buddiesOf(accountId)` (default first).

- [ ] Failing test: a snapshot with and without each field parses as above; with none, every getter is today's.
- [ ] Code.

### 2. Card lines: decision, question, waiting and paused marks (`task_card.dart`, `tasks_view.dart`)

- [ ] Failing test: in a switched project a decided proposal's card shows its decision and one-line reason; an open
      question shows with its default and time; a card waiting on the reader is marked; a paused task shows Paused.
      The same snapshot without `boardMode` draws today's cards.
- [ ] Code.

### 3. Needs you bar (`tasks_view.dart`)

- [ ] Failing test: a switched project's Board shows "Needs you · N" listing what waits on the reader; a click opens
      that card's chat; with nothing waiting, no bar; an unswitched project has none.
- [ ] Code.

### 4. + New proposal on the Board (`view.dart` header, new `proposal_form.dart`)

- [ ] Failing test: in a switched project the header has + New proposal; its form asks goal, why and done when, sends
      Fir's propose command, and shows a refusal's sentence; an unswitched project has no button.
- [ ] Code (after Fir's command shape is known).

### 5. Priority and pause by role (`tasks_view.dart` card menu, `view.dart` task header, `controller.dart`)

- [ ] Failing test: in a switched project a member may set P1–P3 on their own card, P0 is offered only to the owner,
      the Swarm owner or the decider, Pause/Resume only to them; `work.pause`/`work.resume` are sent; a
      PRIORITY_FORBIDDEN or PAUSE_FORBIDDEN refusal shows its sentence. Unswitched: today's priority menu.
- [ ] Code.

### 6. Buddies list and + New Buddy (`view.dart` `_boardChat`, `buddies.dart`, `controller.dart`)

- [ ] Failing test: the right pane lists the reader's Buddies, default first and marked; choosing one shows its chat;
      + New Buddy asks a name and sends `buddy.create` with it; rename, remove and Make default send their commands;
      BUDDY_CAP shows its sentence. One Buddy (today's backend): today's pane.
- [ ] Code.

### 7. Project People → Can chat; the Chat tab read-only without it (`roster.dart`, `view.dart`)

- [ ] Failing test: in a switched project the owner sees a Can chat switch per member, sending `project.canChat`;
      others see no switch; a reader without Can chat gets the project chat read-only with a line saying who can
      grant it; a CHAT_NOT_ALLOWED refusal is shown. Unswitched: today's People and chat.
- [ ] Code.

### 8. Pictures

- [ ] Light and dark screenshots of the switched Board (card lines, Needs you, + New proposal), the Buddies list and
      People with Can chat (`HARNESS_SUPER_TAB_CAPTURE`).
- [ ] Windows recording with no window flash: by the Tester on a Windows machine (this change starts no process).
