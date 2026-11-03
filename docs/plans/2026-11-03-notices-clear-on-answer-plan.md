# Notices Clear On Read And Answer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Swarm tag or an agent's open question stops being a notification once its person reads it or answers the agent, wherever they do it.

**Architecture:** The server resolves tags on two new events (a read mark passing the tag; a post that answers the tag's agent), so every client agrees. Desktop's menu bar applies Activity's read rule locally, and the open thread marks nothing read while hidden. The CLI host closes a Claude Code question with Escape when a person's Swarm message for that agent arrives, so the message is delivered as the answer.

**Tech Stack:** TypeScript + Prisma/Mongo (backend), Dart/Flutter (Desktop), TypeScript (CLI daemon); vitest, flutter test.

**Spec:** `docs/specs/2026-11-03-notices-clear-on-answer.md`

## Global Constraints

- `resolvedBy` values: `'read'` for a read mark, `'answer'` for a post to the tag's agent. Existing `'reply'`, `'done'`, `'worker'` unchanged.
- Only the acting person's own tags (`personId = user.sub`); a Team session is refused before any write, as today.
- Escape is pressed only for engine `claude`, only on `messageHold === 'question_open'`, only for a delivery from a person; never on `permission_open`.
- Read rule (the same as `activity.dart mentionUnread`): a tag on a message shown in the chat goes by the chat mark; a tag on a reply shown only in its thread (`threadsOf` gives it a thread) goes by that thread's mark.
- No phone or web change. No firmware change.
- Base: `origin/main` b8a64b53e or later, worktree `.claude/worktrees/noticlear`, branch `feat/noti-clear-on-answer`.

## Review Focus

1. A tag in a thread reply that was also sent to the chat (`alsoInChat`) resolves by the chat mark, not only the thread mark: Task 1 test "a reply also sent to the chat clears by the chat mark".
2. A post in a project chat that `@`-addresses a worker does not clear the PM's tags unless the PM is also a recipient: Task 2 test "a post addressed to another agent leaves the PM's tags".
3. A person's own Buddy chat clears tags only from coordinators of projects they can read: Task 2 test "the Swarm Buddy chat clears coordinators of readable projects only".
4. A question still on screen after Escape (a second dialog, an engine that ignores it) is withheld as today, never typed into: Task 5 test "still holds when the question stays after Escape".
5. The thread pane becoming visible again marks the replies that came while it was hidden, once: Task 4 test "marks the hidden replies when the pane shows again".

---

### Task 1: Reading past a tag resolves it (backend)

**Files:**
- Modify: `backend/src/superTabs/mentions.ts` (add `resolveRead`; reuse the private `threadsOf`, :313)
- Modify: `backend/src/superTabs/read/service.ts:232-252` (`markRead`, `markThreadRead`)
- Create: `backend/integration/superTabTagsClear.test.ts` (fixture as in `integration/superTabReadMarks.test.ts`)
- Modify: `backend/vitest.super-tabs.config.ts` (include the new file)

**Interfaces:**
- Produces: `resolveRead(db: Prisma.TransactionClient | PrismaClient, input: { tabId: string; personId: string; conversationId: string; threadId: string | null; sequence: number; now: number }): Promise<number>` — the count it resolved.

- [ ] **Step 1: Write the failing tests** in `superTabTagsClear.test.ts`, `describe('reading clears tags')`:
  - "reading the chat past a tag resolves it as read": an agent's chat message tags the peer at sequence n; the peer's `POST …/conversations/:id/read` with n. Expect the peer's `mentions?open=true` read to lack it, its row `resolvedBy === 'read'`, and `mentionsWaiting` 0.
  - "a mark before the tag leaves it waiting": mark n-1 → still listed.
  - "a chat mark does not clear a tag in a thread reply; its thread mark does": tag in a reply (not `alsoInChat`) to a root; chat mark past it → listed; `POST …/threads/:root/read` past it → resolved `'read'`.
  - "a reply also sent to the chat clears by the chat mark".
  - "another person's read leaves my tag": the owner reads the chat past it → the peer's tag still listed.
- [ ] **Step 2: Run** `cd backend && npm run test:super-tabs -- integration/superTabTagsClear.test.ts` — Expected: FAIL (tags stay listed).
- [ ] **Step 3: Implement `resolveRead`**: read the person's waiting rows in that conversation (`tagRows`-style indexed filter plus `conversationId`), stop if none; read their messages (`id, sequence, thread, alsoInChat, conversationId`); `threadsOf` gives each reply's thread; resolve (`updateMany` with `waiting`, `resolvedAt: now`, `resolvedBy: 'read'`) the rows whose message sequence ≤ `sequence` and whose thread equals `threadId` (null meaning: no thread from `threadsOf`). Call it in `markRead` with the stored chat sequence and `threadId: null`, and in `markThreadRead` with the stored thread sequence and `threadId`.
- [ ] **Step 4: Run** the same command — Expected: PASS. Then `cd backend && npx vitest run src/superTabs/mentions.test.ts src/superTabs/read` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(swarm): reading past a tag resolves it`.

### Task 2: A post that answers an agent resolves that agent's tags (backend)

**Files:**
- Modify: `backend/src/superTabs/mentions.ts` (add `answeredAgents`, `resolveByAnswer`)
- Modify: `backend/src/superTabs/store.ts:1765` (call after `resolveByReply`)
- Test: `backend/src/superTabs/mentions.test.ts` (pure), `backend/integration/superTabTagsClear.test.ts` (stored)

**Interfaces:**
- Produces: `answeredAgents(state: SuperTabState, actor: Extract<Actor, { kind: 'person' }>, group: Conversation, recipients: readonly string[]): string[]` — the recipients that are agents in `state.agents`; plus, when `group` is the actor's own Buddy chat, the coordinator (`leadId` of the project's lead conversation) of each project the Buddy speaks for: every project the actor can read (`canReadProject`) for the Swarm Buddy chat (`isSwarmBuddyChat`), the chat's own project for a project Buddy chat. Deduplicated.
- Produces: `resolveByAnswer(tx: Tx, tabId: string, personId: string, agentIds: readonly string[], now: number): Promise<void>` — `updateMany` of the person's waiting tags with `authorAgentId` in `agentIds` and `createdAt ≤ now`, `resolvedBy: 'answer'`; no-op for an empty list.

- [ ] **Step 1: Write the failing tests.**
  - `mentions.test.ts` `describe('answeredAgents')`: "a plain post in a project chat answers its coordinator" (recipients from `applyCommand` message.send's draft); "a post addressed to another agent leaves the PM's tags" (`recipientIds: [worker]` → `[worker]` only); "the Swarm Buddy chat clears coordinators of readable projects only" (a private project the peer cannot read is left out); "a project Buddy chat answers its Buddy and that project's coordinator".
  - `superTabTagsClear.test.ts` `describe('answering clears tags')`: "posting in my Buddy chat clears the PM's tag in a task chat" (PM tags the peer in a task conversation; the peer posts in their Buddy chat → tag resolved `'answer'`); "a tag by another agent stays".
- [ ] **Step 2: Run** `cd backend && npx vitest run src/superTabs/mentions.test.ts` and the integration command from Task 1 — Expected: FAIL (`answeredAgents` not exported; tag still listed).
- [ ] **Step 3: Implement** both functions; in `store.ts` after `resolveByReply`, for `message.send` by a person: find the posted draft in `effects.messages` (`id === effects.result.messageId`), and call `resolveByAnswer(tx, tabId, actor.userId, answeredAgents(effects.state, actor, group, draft.recipients), context.now)`.
- [ ] **Step 4: Run** both commands — Expected: PASS. Then `cd backend && npm run test:super-tabs` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(swarm): a post that answers an agent clears its tags`.

### Task 3: The menu bar lists only tags not read past (Desktop)

**Files:**
- Modify: `desktop/lib/state/status_menu.dart:252-264` (`statusMenuSwarmEntries`)
- Test: `desktop/test/super_tab_menu_bar_notices_test.dart`

**Interfaces:**
- Consumes: `SuperTabActivity.of(controller).mentionUnread(SuperTabMention)` (`activity.dart:174`).

- [ ] **Step 1: Write the failing test** "a tag read past leaves the menu bar's Swarm rows": a controller with a waiting tag at sequence 5 and chat read mark 5 → `statusMenuSwarmEntries(app)` has no `mention` row; mark 4 → it has one.
- [ ] **Step 2: Run** `cd desktop && flutter test test/super_tab_menu_bar_notices_test.dart` — Expected: FAIL.
- [ ] **Step 3: Implement**: skip a waiting tag when `!SuperTabActivity.of(controller).mentionUnread(m)`.
- [ ] **Step 4: Run** the same command and `flutter test test/status_menu_test.dart` — Expected: PASS.
- [ ] **Step 5: Commit** `fix(desktop): the menu bar drops a tag once it is read`.

### Task 4: A hidden thread pane marks nothing read (Desktop, #15)

> Dropped: main fixed this in #2711 (`threadPaneHidden`) while this branch was open.

**Files:**
- Modify: `desktop/lib/super_tabs/controller.dart:862-877, 1436-1445` (`threadPaneVisible`, `_seeThread`)
- Modify: `desktop/lib/super_tabs/view.dart:266-277, 777` (set and clear the callback)
- Test: `desktop/test/super_tab_thread_tags_test.dart`

**Interfaces:**
- Produces: `bool Function()? threadPaneVisible` on `SuperTabController`; null (no view) counts as visible, as today.

- [ ] **Step 1: Write the failing tests**: "a reply to the open thread is not marked read while the pane is hidden" (open a thread, `threadPaneShown()`, set `threadPaneVisible = () => false`, a poll page brings a reply with its `threads` summary → no `POST …/threads/<root>/read`); "marks the hidden replies when the pane shows again" (then visible and `threadPaneShown()` → exactly one mark at the reply's sequence).
- [ ] **Step 2: Run** `cd desktop && flutter test test/super_tab_thread_tags_test.dart` — Expected: FAIL (a mark is posted while hidden).
- [ ] **Step 3: Implement**: at the top of `_seeThread`, if `threadPaneVisible?.call() == false`, set `_threadUnshown = true` and return; the view sets `c.threadPaneVisible = () => _viewIsVisible` in `initState` (beside `chatShown`) and clears it in `dispose`. The existing `threadPaneShown()` call in `_readVisibleTailAfterFrame` (view.dart:513-517) catches up when it shows.
- [ ] **Step 4: Run** the same command and `flutter test test/super_tab_controller_test.dart test/super_tab_threads_test.dart` — Expected: PASS.
- [ ] **Step 5: Commit** `fix(desktop): a thread hidden behind another app marks nothing read`.

### Task 5: A person's Swarm message closes the question it answers (CLI)

**Files:**
- Modify: `cli/src/core/api.ts:237` (`deliver` options), `cli/src/services/turnsLink.ts:44-45` (send them), `cli/src/core/deliveries.ts` (`answer('deliver')` keeps them; `answersQuestion`), `cli/src/core/main.ts:1373` (wire into input deps), `cli/src/core/input.ts:69, 165-171` (`answersQuestion` dep; `beforeTeamWrite`), `cli/src/superTabs/host.ts:1919` (pass it for a person's message)
- Test: `cli/src/core/input.spec.ts`, `cli/src/core/deliveries.spec.ts`, `cli/src/services/turnsLink.spec.ts`, `cli/src/superTabs/host.spec.ts`

**Interfaces:**
- Produces: `export interface DeliveryOptions { answersQuestion?: true }` in `core/api.ts`; `deliver(agentId: string, text: string, deliveryId: string, options?: DeliveryOptions): void`.
- Produces: `answersQuestion(deliveryId: string): boolean` from `core/deliveries.ts` (true while that delivery is unsettled and was sent with the option); `InputDeps.answersQuestion?: (deliveryId: string) => boolean`.

- [ ] **Step 1: Write the failing tests.**
  - `input.spec.ts`: "a person's Swarm message closes a Claude question and is delivered" (screen `messageHold: 'question_open'`, `answersQuestion` true, engine `claude`; after one `Escape` key the next read has no hold → `beforeTeamWrite` returns null and `sendKey` saw `Escape` once); "never presses Escape on a permission prompt" (`permission_open` → `team_waiting_user`, no key); "an agent's message still waits" (`answersQuestion` false → hold, no key); "another engine still waits" (`codex`); "still holds when the question stays after Escape" (second read still `question_open` → `team_waiting_user`, one key only).
  - `deliveries.spec.ts`: "remembers a delivery that answers a question until it settles".
  - `turnsLink.spec.ts`: "sends answersQuestion with the delivery".
  - `host.spec.ts`: "a person's message is delivered as answering a question, an agent's is not".
- [ ] **Step 2: Run** `cd cli && npx vitest run src/core/input.spec.ts src/core/deliveries.spec.ts src/services/turnsLink.spec.ts src/superTabs/host.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**: the host passes `{ answersQuestion: true }` when `object(message.author).kind === 'person'` and the turn is not Buddy news, `agent-only` or `native`; `turnsLink` adds it to the `deliver` query; `core/deliveries.ts` keeps the ids in a Set dropped in `settled`; in `beforeTeamWrite`, when the reading's `messageHold === 'question_open'`, `session.engine === 'claude'` and `deps.answersQuestion?.(deliveryId)`, press `Escape` through `deviceInput().legacyWrite(… keyTerminalAction(id, 'Escape'))`, log `[inject] <sid> question closed for a person's message`, capture and read again, and return `deliveryHold` of the new reading.
- [ ] **Step 4: Run** the same command — Expected: PASS. Then `cd cli && npm run test:core && npm run test:harnessd` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): a person's Swarm message closes the question it answers`.

### Task 6: Pull request

- [ ] Push `feat/noti-clear-on-answer`, open a PR to `main` with the spec link, what each task changes, and the tests run (backend super-tabs suite, Desktop files above on macOS, CLI `test:core` and `test:harnessd`). Mark it ready so `ci/required` runs.
- [ ] Send the PR to Diego's Buddy for the PM to merge (`buddy_post.py`, English): "Please merge PR #N with make merge-pr once ci/required is green; fix any conflict with main and merge. Name diego as the requester."
