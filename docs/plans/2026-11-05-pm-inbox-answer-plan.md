# PM inbox, answer command and turn-end delivery Implementation Plan

> Task #3403, requested by Dee through Harness. Written by the project's Engineer way of working (docs/plans, test first,
> one PR, one review): each plan task commits its failing test, then the code that passes it. No Execution Handoff.

## As built (Rowan, 11-05; scope agreed with River in the task)

- **Task 1** as planned, with one change: `answer` is a mode of `message.send` (`answer: true` with `answers`), not a new
  command type, so it goes through every store path a post goes through (reply context, attachments, owed asks, deliveries).
  `placeAnswer` turns it into a reply when the ask is inside a thread. The CLI's `answer` subcommand sends it.
- **Task 3** as planned, with River's rulings (11-05): a post by an agent other than the PM, with no system source, waits
  when it goes to any agent except a PM or a Buddy. That is crew as the board counts it, not only #3222's standing crew.
  A person's message, the PM's own post (a redirect), every system row (stop, cancel, assignment, moved task), and
  anything to a PM or a Buddy go at once.
  `waitsUntil` is cleared one row at a time by the agent's own `work.status`, and the list row carries `waitsForTurnEnd`
  by the server's clock.
- **Task 4** changed: the host can run outside the core's process, so a per-delivery flag in `inCore/deliveries.ts` would
  not reach the core's idle check. Instead the host asks `core.agents.activity` and holds a waiting row through its existing
  refused-write path (same claim, local retry each tick, list re-read every 30 s, reclaim every 2 min). Nothing in
  `cli/src/core` changes.
- **Order:** a held agent post can be overtaken by a later row to the same agent that goes at once (a system row, a person's
  message). That is the ruling's intent: what someone must see now is not queued behind routine posts.
- **Rollback:** the new stored fields, `SuperTabDelivery.waitsUntil` and `Conversation.answered`, are optional and need no
  migration. Rolling the code back leaves them unread: an older backend ignores both, and an older host never sees
  `waitsForTurnEnd`. Rows written with them stay valid.
- **Task 2** in two parts. #3403: the PM's digest starts with its owed asks (`inbox.ts owedLines`). #3545, the rest:
  - Sections in order, empty ones left out: Owed asks, New from people (by username, up to 1000 characters), Crew needs (the
    question, the options, the one recommended; `crewNeedOf` reads crew-need rows and needs_human rows), then the notices.
  - People's messages and crew needs to a PM are gathered only when its machine reports `turnInbox`, which its host sends
    once it sends the PM's turn. An older host is unchanged: nothing more is gathered for it, so nothing is delayed.
  - With `?turn=idle|busy` on the PM's list read, the inbox is due at idle when anything is gathered, or once its oldest row
    is TURN_END_WAIT_MS old. A read with no turn keeps the 5-minute notice clock, and on a `turnInbox` machine it puts the
    people's messages and crew needs it gathered back in the queue in that same read.
  - An idle read with something gathered skips the fast answer (one indexed read), so the inbox goes in the read after the
    turn ends. The host reads the PM's list on the tick its turn ends. It waits at most 200 ms for the core's activity read,
    one at a time per PM, so a slow core never holds the machine's deliveries.
  - The inbox stays the digest message with its stable id, so it is written once.

**Goal:** The PM gets one inbox per turn and answers each ask once, in its place; crew members get their messages at turn end,
on a status change or within 15 minutes, never typed mid-task; stop and cancel still go at once.

**Architecture:** Three parts on today's delivery rows, keeping their claim/ack exactly-once path unchanged.
(1) An `answer` command that posts a reply in the ask's place and records it, refusing a second answer with where the first is.
(2) The coordinator's digest becomes its inbox: the same gathered rows, written in four sections, and released at the PM's turn
end (an idle signal its host sends on the delivery list read) instead of only on the 5-minute clock.
(3) Each crew delivery row says whether it waits for the turn end; a new CLI host then holds it until the pane is idle (the
core's own idle check, already used for Agent Messages); an old CLI ignores the field and types as today.

**Tech Stack:** TypeScript, Fastify backend with Prisma on MongoDB (vitest), CLI host (vitest specs).

**Spec:** the task's brief (#3403). Interfaces from sibling tasks: #3384 / PR #3209 (`pulse.ts`: `Conversation.owed`,
`OwedAsk { id, personId, at, thread }`, `settleReply`, `settleReaction`, `settleRequest`) and #3404 (`crewNeeds.ts`:
`crewNeedOf(source): CrewNeed | null`, `CrewNeed { agentId, personIds, messageId, question?, options?, recommended? }`;
source kind `crew-need`).

## Global Constraints

- P1, anh Dee. Backend + CLI. One review. Keep exactly-once delivery.
- PR body first line: "Requested by Dee through Harness."
- Before Ready: a test that fails without the fix for every risk named here, red/green evidence in a PR comment, backend
  unit suite (`npm test`); the Super Tab integration suite runs in PR CI.
- Swarm code stays out of `cli/src/core`. Owns `backend/src/superTabs/` and `cli/src/superTabs/` (+ one optional Prisma field).
- Numbers live in one place as constants until the project rules record (#3393) lands: `TURN_END_WAIT_MS = 15 * 60_000`.
- Team-written: #3209 and #3404 are Team-written, so this task's code is built and tested only in a Harness Team account.

## Review Focus

1. Exactly once: a delivery held for the turn end is claimed once and typed once, also across a host restart (journal) and a
   reclaim every 2 minutes (host.ts `HELD_RECLAIM_MS`).
2. Old CLI: a host that sends no turn signal and ignores the row field gets every delivery as today, with no added delay
   (people's messages to the PM included).
3. Never stuck: a crew agent in one 3-hour turn still gets its message after 15 minutes; a PM in one long turn gets its inbox
   after 15 minutes.
4. Cancel goes at once: a `work.cancel` row ("Stop working on it.") and a moved-task notice are never held.
5. Answer placement: an ask inside a thread is answered in that thread; a top-level ask in the main chat right below it;
   never both, and a retry with the same operation id is not a "second answer".

---

### Task 1: `answer` command

**Files:**
- Create: `backend/src/superTabs/answers.ts`
- Modify: `backend/src/superTabs/commands.ts` (schema next to `message.send` ~line 359; handler next to `message.send`)
- Modify: `backend/src/superTabs/model.ts` (`Conversation.answered?: AnsweredAsk[]`)
- Modify: `cli/src/superTabs/command.ts` (+ `harness super-tab answer GROUP MESSAGE_ID TEXT OPERATION_ID` in its help)
- Test: `backend/src/superTabs/answers.test.ts`, `cli/src/superTabs/command.spec.ts`

**Interfaces:**
- Consumes: `pulse.ts` `settleReply(state, group, agentId, { answers, thread })`, `Conversation.owed`.
- Produces: command `{ type: 'answer', conversationId, messageId, text }`; `AnsweredAsk { id: string; answerId: string;
  thread: string | null; at: number }`; `MAX_ANSWERED = 50`; refusal `ALREADY_ANSWERED` (409) whose message names where:
  "Answered already in its thread at HH:MM UTC (message ANSWER_ID)." or "... right below it ...".

- [ ] **Step 1: failing tests** (`answers.test.ts`, on the commands test harness):
  - a person's top-level message in the project chat → PM `answer` → the stored reply has `replyTo` = the ask, `thread` = the
    ask's id, `answers` placement (main chat, below it); the ask leaves `group.owed`; `group.answered` holds it.
  - a person's message inside a thread (root R) → PM `answer` → the reply is in thread R (reply-to), not in the main chat.
  - second `answer` on the same message (new operation id) → `ALREADY_ANSWERED`, message names the first answer's id.
  - same operation id retried → the store's exact-retry answer, not a refusal.
  - an ask settled by a plain `message.send --answers` by the PM, then `answer` → `ALREADY_ANSWERED` (the message.send path
    records `answered` too).
  - a message that was never owed and never answered → posted in place (act, don't refuse).
- [ ] **Step 2:** run `npm test -- src/superTabs/answers.test.ts` → FAIL (unknown command type).
- [ ] **Step 3:** implement: the handler reads the ask (`context.reply`, as `--answers` does), refuses when
  `group.answered` names it, else builds the same post `message.send` would with `answers` (top-level ask) or `replyTo`
  (ask in a thread), calls `settleReply`, and appends `{ id, answerId, thread, at }` (newest 50 kept). The `message.send`
  path appends the same record where it calls `settleReply` for an owed ask.
- [ ] **Step 4:** tests pass; CLI spec for the new subcommand's argv → JSON.
- [ ] **Step 5:** commit.

### Task 2: the PM's inbox (`inbox.ts`, extending `noticeDigest.ts`)

**Files:**
- Create: `backend/src/superTabs/inbox.ts`
- Modify: `backend/src/superTabs/noticeDigest.ts` (`gatheredNotice` gains people's messages and crew needs for a coordinator
  whose host sends the turn signal), `backend/src/superTabs/store.ts` (`writeMessages` ~3008: gathered also announces the
  coordinator's machine for a person's message or crew need; `fullDeliveries`/digest release ~4043: due on turn end)
- Test: `backend/src/superTabs/inbox.test.ts`, `backend/src/superTabs/noticeDigest.test.ts`

**Interfaces:**
- Consumes: `Conversation.owed` (#3209), `crewNeedOf` (#3404), `noticeLine`, `digestMessage`.
- Produces: `inboxSection(source, author): 'people' | 'crew' | 'results'`; `inboxText(since, { owed, people, crew, results },
  more): string` — sections in that order, headed "Owed asks (N, oldest Xm, from NAME)", "New from people", "Crew needs",
  "Results"; empty sections left out. Owed asks are listed only in an inbox that something else released (no turn of its own).
  `INBOX_PERSON_MAX = 1000` characters per person's line (a notice line stays 200).
- Turn signal: the host's delivery list read carries `?turn=idle|busy`. Due when `turn=idle` and anything is gathered, or the
  oldest gathered row is `TURN_END_WAIT_MS` old; with no `turn` parameter (old CLI) people's messages and crew needs are put
  back to `queued` and listed in that same read (today's behaviour), and notices keep the 5-minute digest.

- [ ] **Step 1: failing tests:** section order and headers; a person's message gathered for a coordinator and released at
  `turn=idle` in one inbox with two notices (one message, one turn); `turn=busy` holds it until 15 minutes; no `turn` → the
  person's message is listed as an ordinary delivery in the same read; exactly once: two racing polls write one inbox
  (stable id, status-guarded `updateMany` as today).
- [ ] **Step 2:** run `npm test -- src/superTabs/inbox.test.ts src/superTabs/noticeDigest.test.ts` → FAIL.
- [ ] **Step 3:** implement as above; the inbox is the digest message (same id scheme `stableId('notice-digest', …)`), so
  writes, retries and `digested` marking are unchanged.
- [ ] **Step 4:** pass. **Step 5:** commit.

### Task 3: crew deliveries wait for the turn end (backend)

**Files:**
- Modify: `backend/prisma/schema.prisma` (`SuperTabDelivery.waitsUntil DateTime?`, optional: no migration, old rows null)
- Modify: `backend/src/superTabs/store.ts` (`writeMessages`: set `waitsUntil = now + TURN_END_WAIT_MS` for a crew recipient;
  `deliveries()`: each returned row gains `waitsForTurnEnd: boolean` = `waitsUntil > now`; the agent's own `work.status`
  clears `waitsUntil` on its open deliveries, one by one by id, and announces its machine)
- Create: `backend/src/superTabs/turnEnd.ts` (`waitsForTurnEnd(state, recipient, source): boolean`, `TURN_END_WAIT_MS`)
- Test: `backend/src/superTabs/turnEnd.test.ts`, `backend/src/superTabs/deliverySettle.test.ts` (no change in claim quiet rules)

**Interfaces:**
- Produces: list row field `waitsForTurnEnd: boolean` (absent on old servers).
- Crew = an agent of the project that is not its coordinator and not a Buddy. Never waits: a `work.cancel` row (source gains
  `cancel: true`), a moved/lost-task notice to the agent that lost it, a resume.

- [ ] **Step 1: failing tests:** a review verdict to an Engineer lists `waitsForTurnEnd: true`; after the Engineer's
  `work.status` it lists `false`; after 15 minutes `false`; a cancel row `false`; a coordinator's or Buddy's row `false`.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** pass. **Step 5:** commit.

### Task 4: CLI host holds them until the turn ends, and sends the turn signal

**Files:**
- Modify: `cli/src/superTabs/inCore/deliveries.ts` (`typesWhileBusy(deliveryId)` is false for a typed id registered as waiting:
  `waitForTurnEnd(typedId, waits: boolean)`; nothing in `cli/src/core` changes — core/input.ts already asks this per delivery
  and then applies the pane's idle check, `team_waiting_idle`)
- Modify: `cli/src/superTabs/host.ts` (`accept()`: register from the list row's `waitsForTurnEnd` before the write; the
  coordinator's list read adds `?turn=idle|busy` from the core's turn state; a turn end of a held agent marks its list due)
- Test: `cli/src/superTabs/host.spec.ts`, `cli/src/superTabs/inCore/deliveries.spec.ts`

- [ ] **Step 1: failing tests:** a row with `waitsForTurnEnd: true` to a busy pane is refused `team_waiting_idle`, claimed once,
  and typed once when the pane turns idle (one claim POST, one ack); the same row with `false` types while busy (today);
  a row without the field types while busy (old server); the list read sends `turn=busy` while a turn is open and
  `turn=idle` after `turn_ended`.
- [ ] **Step 2:** run `npx vitest run src/superTabs/host.spec.ts src/superTabs/inCore` in `cli/` → FAIL.
- [ ] **Step 3:** implement. **Step 4:** pass; run `npm run test:core` coverage gate locally (CI does not). **Step 5:** commit.

### Task 5: Ready

- [ ] Red/green evidence comment (each test above failing on the parent commit, passing at head), backend `npm test`,
  CLI specs; PR body first line "Requested by Dee through Harness."; one review step.
