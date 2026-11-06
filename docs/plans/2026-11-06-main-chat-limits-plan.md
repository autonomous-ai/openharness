# Main-chat limits implementation plan

> Implement task by task in this session, test first, with one independent review of the pull request.

**Goal:** Keep project chats useful by refusing agent status/card repeats, a third main-chat post per ask, and duplicate answers, while leaving people untouched.

**Architecture:** Add a focused `chatLimits.ts` guard to `message.send`, beside ACK_ONLY. A bounded, private ledger on the conversation records the newest 50 person asks, their first answer and at most two main posts across all agents. Unlinked main posts belong to the latest top-level person ask; thread follow-ups remain available. Explicit answer links and direct replies to person asks count as answers in either place.

**Tech Stack:** Existing TypeScript, Vitest and transactional MongoDB conversation parts; no dependencies, collections, indexes or new queries.

**Spec:** Task #3598, inventory Table A #7; Dee's 11-04/11-05 chat decisions and 11-06 rules-as-code decision.

## Global Constraints

- Only project chats; people, private/Buddy chats, task chats and agent-only notices retain their behavior.
- Main-chat status labels and pure repeats of existing cards are refused with the next step. Substantive factual results remain allowed.
- Two posts across all agents per ask; newline wrapping does not consume another post. Thread mirrors consume a main post.
- One answer per person message across agents and main/thread locations. Replying to an earlier agent answer continues discussion.
- Commit failing tests before implementation; push each completed task. Run only affected local checks; full backend unit and Super Tab integration suites run in ready PR CI.
- Temp files only in mktemp directories. Never sign out the real CLI or stop another process.

## Design

- **Growth:** At most 50 ask entries per project chat, each two post IDs and one answer. Eviction records an age watermark: an old ask cannot reopen a main budget or a formal answer. Its thread remains readable and replies to the existing agent response remain available. No text is stored in this ledger. Conversation removal deletes it.
- **Concurrency:** Existing optimistic conversation-part transaction serializes each post and counter together; operation receipts make retries idempotent.
- **Read cost:** Reuse the conversation and existing reply lookup. No message-history scan, new query or index. Hide bookkeeping from reader views/light loads.
- **Scale:** At 10x traffic state stays fixed at 50 asks; benchmark guard and full apply path. PRODUCT.md delivery target is p95 <=1s; algorithm timing alone cannot establish delivery latency.
- **Compatibility:** Older clients use the same message.send and see named refusals; no new client fields. Existing conversations initialize on their next person ask; their existing answered ledger still guards prior recorded answers.
- **Migration/rollback:** Optional JSON field, no schema migration. Rollback ignores it, preserving transcript; re-upgrade reuses it.
- **Audience/identity:** Existing access checks run first; no cross-account reading or execution added. Bookkeeping never carries content.
- **Failure/platforms:** Named refusals give thread/reaction guidance. Server behavior is common to every client platform; tests run on macOS and CI Linux.

## Review Focus

- A different agent must not bypass an ask's shared budget (Task 2).
- Main/thread mirrors and direct legacy post links must not bypass limits (Tasks 2/3).
- A new person's ask gets a fresh budget, and old ask links cannot reset after eviction (Task 2).
- Files/tags must not bypass the status/card guard; meaningful questions/results must pass (Task 1).
- People and non-project conversations stay unchanged; ledger never enters reader payloads (Tasks 1/2/3).

### Task 1: Refuse main-chat status and card-only repeats

**Files:** Create `backend/src/superTabs/chatLimits.ts`, `chatLimits.test.ts`; modify `commands.ts`.
**Interfaces:** `requireChatContent(state, group, text): void`, called only for visible agent main posts in a project chat.

- [ ] Commit command-level tests for status labels, known PR/task card repeats, attachments/tags, person/task/thread exemptions, and meaningful results.
- [ ] Run `npm test -- src/superTabs/chatLimits.test.ts`; verify the expected refusal tests fail.
- [ ] Implement conservative, anchored status and exact card-pointer checks; integrate after existing reply validation.
- [ ] Run own tests and `acknowledgements.test.ts`; commit and push green implementation.

### Task 2: Two main posts per ask

**Files:** Modify `chatLimits.ts`, `chatLimits.test.ts`, `commands.ts`, `model.ts`, `read/views.ts`, `read/contract.ts`, `parts/light.ts`, `parts/light.test.ts`; integration coverage in `integration/superTabProjectChatWorkers.test.ts`.
**Interfaces:** `Conversation.chatLimits?: ChatLimits`; `recordChatAsk(group, id, at, topLevel)` and `requireChatPost(group, command, reply)` / `recordChatPost(...)` reuse trusted context.

- [ ] Commit failing command tests for third post across agents, new/old asks, thread-only followups, mirrors, eviction and private reader bookkeeping; add transactional integration test for competing third posts and retry.
- [ ] Run focused tests and observe missing refusals.
- [ ] Implement fixed-size ask ledger, monotonic eviction watermark and atomic post recording; classify/hide the new field in readers.
- [ ] Run affected tests plus focused integration; commit and push.

### Task 3: One answer across agents and locations

**Files:** Modify `chatLimits.ts`, `chatLimits.test.ts`, `answers.test.ts`, `commands.ts`.
**Interfaces:** Store first answer on each ask; explicit `answers` or `answer` and direct person replies are answers. Existing PM owed settlement remains independent.

- [ ] Commit failing tests: plain second answer, Engineer then PM, main then thread and thread then main, distinct person followups, and reply-to-agent continuation. Update the two old expectations superseded by this task.
- [ ] Run focused tests; confirm duplicate-answer refusals are missing.
- [ ] Implement common guard and record first answer only; preserve task/Buddy legacy behavior.
- [ ] Run affected command/answer/read tests, typecheck, diff check and hot-path comparison; post red/green evidence, mark ready for CI and request one independent review.
