# Main-chat limits implementation plan

> Implement task by task in this session, test first, with one independent review of the pull request.

**Goal:** Keep project chats useful by refusing agent status/card repeats, a third main-chat post per ask, and duplicate answers, while leaving people untouched.

**Architecture:** Add a focused `chatLimits.ts` guard to `message.send`, beside ACK_ONLY. A bounded, private ledger on the conversation records the newest 50 person asks, their first answer and at most two main posts across all agents. Only explicit ask/thread links consume that ask’s main budget; unlinked announcements stay independent. Explicit answer links and person replies shown in main count as answers; plain thread replies remain discussion.

**Tech Stack:** Existing TypeScript, Vitest and transactional MongoDB conversation parts; no dependencies, collections, indexes or new queries.

**Spec:** Task #3598, inventory Table A #7; Dee's 11-04/11-05 chat decisions and 11-06 rules-as-code decision.

## Global Constraints

- Only project chats; people, private/Buddy chats, task chats and agent-only notices retain their behavior.
- Main-chat status labels and pure repeats of existing cards are refused with the next step. Substantive factual results remain allowed.
- Two posts across all agents per ask; newline wrapping does not consume another post. Thread mirrors consume a main post.
- One formal answer per message across agents and main/thread locations. Plain thread replies, including replies to the person’s ask itself, continue discussion.
- Commit failing tests before implementation; push each completed task. Run only affected local checks; full backend unit and Super Tab integration suites run in ready PR CI.
- Temp files only in mktemp directories. Never sign out the real CLI or stop another process.

## Design

- **Growth:** At most 50 ask entries per project chat, each two post IDs and one answer. Eviction records an age watermark: an old ask cannot reopen a main budget or a formal answer. Its thread remains readable and plain thread discussion remains available. No text is stored in this ledger. Conversation removal deletes it.
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

- [x] Commit command-level tests for status labels, known PR/task card repeats, attachments/tags, person/task/thread exemptions, and meaningful results.
- [x] Run `npm test -- src/superTabs/chatLimits.test.ts`; verify the expected refusal tests fail.
- [x] Implement conservative, anchored status and exact card-pointer checks; integrate after existing reply validation.
- [x] Run own tests and `acknowledgements.test.ts`; commit and push green implementation.

### Task 2: Two main posts per ask

**Files:** Modify `chatLimits.ts`, `chatLimits.test.ts`, `commands.ts`, `model.ts`, `read/views.ts`, `read/contract.ts`, `parts/light.ts`, `parts/light.test.ts`; integration coverage in `integration/superTabProjectChatWorkers.test.ts`.
**Interfaces:** `Conversation.chatLimits?: ChatLimits`; `recordChatAsk(group, id, at)` and `requireChatPost(group, command, reply)` / `recordChatPost(...)` reuse trusted context.

- [x] Commit failing command tests for third post across agents, new/old asks, thread-only followups, mirrors, eviction and private reader bookkeeping; add transactional integration test for competing third posts and retry.
- [x] Run focused tests and observe missing refusals.
- [x] Implement fixed-size ask ledger, monotonic eviction watermark and atomic post recording; classify/hide the new field in readers.
- [x] Run affected tests plus focused integration; commit and push.

### Task 3: One answer across agents and locations

**Files:** Modify `chatLimits.ts`, `chatLimits.test.ts`, `answers.test.ts`, `commands.ts`.
**Interfaces:** Store first answer on each ask; explicit `answers` or `answer` and direct person replies shown in main are answers; plain thread replies are discussion. Existing PM owed settlement remains independent.

- [x] Commit failing tests: plain second answer, Engineer then PM, main then thread and thread then main, distinct person followups, and reply-to-agent continuation. Update the two old expectations superseded by this task.
- [x] Run focused tests; confirm duplicate-answer refusals are missing.
- [x] Implement common guard and record first answer only; preserve task/Buddy legacy behavior.
- [x] Run affected command/answer/read tests, typecheck, diff check and hot-path comparison; post red/green evidence, mark ready for CI and request one independent review.


## Evidence

- Content guard: `3ac59da35` produced 9 failures / 1 pass; `07f9488c8` passed content + acknowledgement checks (48 tests).
- Main budget: `2cc8137d5` produced 5 failures / 11 passes. Its transactional test let both competing posts through (expected only one). `fd3520c32` passed the focused integration file (3 tests), including replay and concurrent writes.
- Duplicate answers: `bfbf589f4` produced 6 failures / 25 passes; `bd4cf457a` fixed them. Formal answer links remain guarded; the review fixes below preserve ordinary discussion under the ask root.
- Card-number bypass: `e3e37988f` failed on a repeated `PR #12` without its URL; `e274001c7` passed it. File/tag status bypasses are also covered.
- Current-main merge: `d299e264e`; initial affected run passed 575 tests across 9 files; backend typecheck passed. Focused store integration passed 3 tests. Ready PR CI supplies full backend unit/integration evidence.
- Linked-answer posting benchmark vs main `bb34f2907`: 2,000 tasks and 50 active asks, 20 warmup pairs + 200 interleaved measured pairs. Median 4.025 -> 3.973 ms; p95 4.733 -> 4.488 ms. This measures applyCommand only, not delivery/database latency. No query/index changed.
- Empty-answer ledger with 50 asks is 2,710 JSON bytes. Each entry adds at most two 24-character post IDs and one first-answer record. The ledger stays bounded well below the conversation part's 4 MiB cap and disappears with the conversation. Production count/size/growth measurements could not be collected: the required read-only environment file is absent on this Team machine. No production access or write attempted; bounded local payload measurement replaces that evidence for this optional JSON field.
- Rollout: existing chats initialize with the next person ask; existing recorded PM answers still apply. The ledger retains 50 asks. After eviction older main budgets and formal answers close conservatively, including equal-timestamp unknown asks; plain thread discussion remains available under the ask or an existing response. No transcript is removed. Revert the backend change to roll back; no schema migration.
- Independent review and ready PR CI are the remaining delivery gates, owned by their steps/CI after submission.

### Review and CI corrections

- [x] Commit review regressions (`5ed2b2931`): three failures / 20 passes. An outage and older result after a full newer ask must pass; a second agent’s plain thread follow-up must pass.
- [x] Implement linked-only budgets and formal-answer distinction (`95f0527db`); 551 affected unit tests and three transactional integration tests passed.
- [x] Reproduce ready CI’s Buddy scope failure: three failures / 144 passes in buddies/buddyModel. Detect project chats by project lead-conversation ID without resolving a Swarm-wide Buddy’s nonexistent project (`c54f6e4ac`); 147 passes. The two affected activity/Buddy integration cases pass (92 unrelated cases skipped).
- [x] Commit boundary regression (`f2d3b7390`): answering an earlier agent response with 50 retained asks evicted its main-budget entry before recording the post and threw. Record the main slot before adding an answer target (`ac48a1dad`); 34 focused tests pass.
- [x] Final affected run: 651 tests across seven files, typecheck clean, three project-chat transactional integration tests pass. Reviewer’s light-load note requires no code change: chatLimits is in GROUP_FIELDS.unread and removed by both reader views.
- [ ] Same independent reviewer reads the corrected head; ready PR CI supplies complete backend and integration evidence.
