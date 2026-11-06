# Proposal cards implementation plan

> Native implementation, task by task, test first. One independent review of the complete change by each of two security Reviewers.

**Goal:** Give switched projects durable proposal cards, PM decisions, timed questions and duplicate merging, with server-enforced person and Buddy rights.

**Architecture:** Embed a bounded `Conversation.proposal` in the existing SwarmGroup card, retaining the card when accepted work becomes a task. Commands use the existing transactional receipts, version guards and changed-part feed. A due-time column/index lets the existing singleton time-check worker find questions and deferred proposals even after long inactivity.

**Tech Stack:** TypeScript, Zod, Prisma/MongoDB, Vitest, existing Super Tab parts and delivery workers; no dependency.

**Spec:** [Approved Buddy/Board spec](2026-11-06-buddy-board-final-spec.md), Phase 2, proposal/backend portion of #3817. #3818 owns multiple/default Buddies; #3819 owns project switch, migration orchestration, Board delta API, chat grants and priority/pause rights.

## Global Constraints

- Only projects with `boardMode === true` use new proposal entry and PM input rules. Switching back preserves cards and legacy chat behavior.
- Identity is the consenting person and membership generation plus sending Buddy id, never the machine owner. Preserve existing exact-word consent and attachment checks.
- Every current member, including viewers, may propose and answer questions addressed to them. Only the current project PM decides, asks or merges. Only entitled people originate P0/hotfix proposals.
- Decisions and answers are recorded once. A late answer is visible but does not replace an applied answer/default. Explicit person consent never defaults.
- Use indexed bounded reads, existing changed-part delivery and per-card transaction guards (plus existing head guard for shared rights); no whole-Board polling.
- Run affected unit/importer tests locally. Full backend and four integration shards run in PR CI. Never touch a real CLI sign-in.
- Before Ready, record failing-test commits and observed red/green evidence in a PR comment. Require two independent security reviews.

## Design

- **Growth:** Each card has at most 20 questions and 50 proposers/merged cards; refuse overflow rather than discard history. Proposal text fields and evidence are bounded. Full discussion/decision history uses existing message rows, never an unbounded embedded log. Declined and merged cards are archived/history immediately; shipped cards retain the existing seven-day Board/history policy. Card history remains until project/Swarm deletion, as existing tasks do.
- **Concurrency:** Version-guard the card, both cards of a merge and its flattened merged sources, the current membership and project/coordinator rights. Existing operation receipts make retries once-only. Revisit clears the current Later decision but its message remains in history. Proposal commands retain the existing Swarm head guard to serialize project rights with membership changes; timer writes guard changed cards and the relevant current members/coordinator.
- **Read cost:** Single named-card lookups use the existing unique key index; bounded merged source lookups use that same index. PM gets new proposal/answer messages through existing deliveries, in priority order. Optional `SuperTabDelivery.inputPriority` plus `[tabId,agentId,status,inputPriority,createdAt]` supports the first 100 prioritized rows even beyond an old backlog; union with the oldest 100 supports old rows without that field. Filter current rights before returning at most 100 inputs; source authorization reads up to 200 message ids in one primary-key batch. Existing part changes expose metadata to clients. Due work uses a bounded `proposalDueAt` range, including dormant cards; no scan of cards or messages.
- **Scale:** Bounds stay fixed at ten times the people. Record counts and decision/answer wait durations without content or ids. Pending proposals carry a due time; the owner sees an overdue mark on the card and a needs-you notice. The indexed worker batch and elapsed metrics expose lag.
- **Compatibility:** Extend JSON metadata/commands; existing clients ignore optional metadata. No new conversation kind. Legacy buddy.propose keeps its old schema/meaning unless the destination is switched; switched proposals must supply why/doneWhen/evidence. Rollout switch is owned by #3819. Switching back restores ordinary chat and old proposal creation; decisions, answers and clocks for already stored cards continue so rollback does not strand questions.
- **Migration/rollback:** Export `importLegacyProposal(state, project, ask, now)` where ask is `{messageId,conversationId,personId,text,at,generation?}`. Stable project/message-derived card id is idempotent; migration must load that id before writing and clear the old ask only after creating it. It preserves original words as a legacy proposal and does not fabricate consent or missing details. The store wires it to #3819’s switch and worker: read at most 100 still-owed originals by message id, verify their original author generation, public project audience and unchanged words, and leave missing/inaccessible asks owed. No invented author/body or message-body read from the snapshot. Reverting the switch leaves cards intact; reverting the backend leaves optional data readable and the due index harmless.
- **Audience/identity:** Current project membership checked before receipt replay and before application; merged proposers retain generation-bound identities. Buddy answers require the sender identity on that card (or its person's current default after removal) and a question to that person; no arbitrary card posting or foreign-project reads. Viewer exceptions apply only to these commands.
- **Failure:** Named refusals for missing inputs, stale membership, duplicate decisions/answers, bounds and unavailable Buddy routing. At the proposal deadline mark overdue and notify the current owner, once. Explicit-consent deadlines mark overdue without answering. Worker failures use existing logged retry behavior.
- **Platforms:** Server-only Linux runtime; contract consumed by Desktop macOS/Windows/Linux, web, iOS and Android. No process or UI changes.
- **Storage/index scope:** Optional `SwarmGroup.proposalDueAt` and `[deleted,proposalDueAt,tabId,key]` support dormant timers; optional `SuperTabDelivery.inputPriority` and its index support bounded urgent delivery. Both use existing collection lifecycles (card history retained; delivery TTL unchanged). These columns/indexes in backend/prisma/schema.prisma are the only storage additions; all domain code remains under backend/src/superTabs. No new collection or production data write in implementation.

## Review Focus

1. Membership removal/rejoin and private-project revocation must remove card rights, even for an idempotent retry or queued delivery.
2. Buddy consent must not authorize new private text or another Buddy's card; fallback only follows a removed sender of the same person.
3. Question expiry racing an answer must produce one effective answer, while a later answer remains visible; explicit-consent asks cannot auto-answer.
4. Duplicate merging must retain every proposer's attribution/notices without cycles, cross-project links or abandoned questions.
5. Quiet projects and deferred dates beyond seven days must still wake; rollback must not eat legacy asks or leak ordinary chat to the switched PM.

## Task 1: Create durable, authorized proposal cards

**Files:** Create `backend/src/superTabs/proposalCards.ts` and `proposalCards.test.ts`; modify `model.ts`, `projects.ts`, `commands.ts`, `parts/light.ts`, `taskQueue.ts`, `dispatch.ts` as needed to keep undecided cards out of task dispatch.

**Interfaces:** `ProposalRecord` on `Conversation.proposal`; `proposal.create {projectId,title,text,goal,why,doneWhen,evidence,priority}` for people; extend `buddy.propose` with why/doneWhen/evidence and P0–P3/hotfix priorities on switched projects only. `importLegacyProposal(state,project,ask,now): string` and `legacyProposalId(projectId,messageId): string`. New card ids are stable from command operation ids. `boardMode?: true` is shared with #3819.

- [x] Write/commit tests that create a card as a member/viewer, preserve consenting Buddy identity/exact words, reject incomplete and unauthorized/private/P0 proposals, and preserve legacy output when not switched. Assert no task dispatch before acceptance. Test stable legacy import without inventing structured content.
- [x] Run `cd backend && npm test -- src/superTabs/proposalCards.test.ts`; observe feature failures.
- [x] Implement schema/domain and command integration with bounded metadata and the existing task card/change feed. Use the shared owner/top-decider P0 rule from #3819 when available; keep its identical semantics otherwise.
- [x] Run that test and affected Buddy/queue/dispatch/light tests, then typecheck; commit fix and push.

## Task 2: Decisions, scoped questions and duplicate merge

**Files:** Modify `proposalCards.ts`, `proposalCards.test.ts`, `commands.ts`, `buddies.ts`, `buddyNews.ts`, `parts/touches.ts`.

**Interfaces:** `proposal.decide {conversationId,decision:accept|reshape|later|no,reason,task?,checks?,revisitAt?}`; accept/reshape require the accepted task contract and checks. `proposal.ask {conversationId,personId,question,defaultAnswer,deadline,requiresConsent?}`; `proposal.answer {conversationId,questionId,text}`; `proposal.merge {conversationId,intoConversationId,reason}`. `applyProposalCommand` mutates the transaction state and returns MessageDrafts/result. Use #3818's `buddyFor(state,person,senderBuddyId)` for notices and generation-safe fallback.

- [x] Write/commit tests for all four decisions/reasons, same-card task conversion, duplicate decision refusal, PM-only rights, own-card Buddy answers, viewer answers, removed sender fallback, late/second answers, merge attribution/cycle/cross-project/overflow guards and notifications to every proposer.
- [x] Run focused tests; observe red.
- [x] Implement command handlers, narrow Buddy exception, per-card/member/coordinator guards and notices only for decided/needs-you/shipped. Store full history in card messages; flatten duplicate links in one bounded transaction.
- [x] Run focused tests and affected authorization/Buddy/news/touches tests, typecheck; commit fix and push.

## Task 3: Timers, persistence and PM delivery boundary

**Files:** Modify `proposalCards.ts`, `proposalCards.test.ts`, `store.ts`, `timeChecks.ts`, `parts/write.ts`, `parts/light.ts`, `parts/indexed.ts`, `backend/prisma/schema.prisma`; add focused unit and real-store integration tests under `backend/integration/`.

**Interfaces:** `proposalDueAt(record): number|null`; `advanceProposalCards(state,now): MessageDraft[]`; bounded `dueProposalCards(db,now,limit)` by the due index. Worker loads due cards/chats by named ids. Store commandGroups loads source/canonical/merged/Buddy chats by id, including dormant. PM input policy accepts proposal roots, answers and server notices only when switched; recheck on claim and viewer sender policy. Extend existing privacy-safe metrics with proposal event/wait values.

- [x] Write/commit tests for default-at-deadline exactly once, explicit consent, answer/expiry conflict, Later reentry, overdue owner notice, due cards after long inactivity/dormancy, persistence/delta visibility, revoked rights on receipt replay and delivery, ordinary chat suppressed only when switched, priority delivery ordering and index explain bounds.
- [x] Run focused unit/integration files; observe red.
- [x] Implement the timer and command/delivery loading paths with bounded indexed reads; maintain the due column on every card write. Keep existing worker and transaction retry behavior.
- [x] Run focused unit/importer tests and specific real-store integrations plus typecheck; record query explain and same-workload before/after cost. Commit fix and push.

## Finish

- [x] Wire/test #3819 migration boundary once both helpers exist, without dropping asks. Keep dependency changes explicit in the PR.
- [x] Add red/green, validation/platform/index evidence in the PR; mark ready; preserve head during CI/review.
- [ ] Set task review status with exact head and PR. Two different security Reviewers independently review rights/legacy isolation. Fix Important/Critical findings test first; set done once reviews pass, with exact revision/evidence.

## Implementation evidence

- Task 1: tests `fe18324f4` failed 8/passed 4 before implementation `69a280f03`; 179 affected units and typecheck passed after.
- Task 2: tests `637980493` failed 10/passed 12 before `78dd776e8`; 600 affected units and typecheck passed after.
- Task 3: `751db914b` failed 5/passed 22 units; `6c18e1b20` failed 1/passed 2 integrations. Additional viewer/manual assignment, shipped-notice, notice-delivery and metric failures precede implementation `cedb46698`.
- Shared switch migration: `3dc6c014a` failed 1/passed 6 integrations before `f2d9499ec`; all 7 passed after. P0 past 100-row backlog: `0fcaefdd3` failed 1/passed 7 before `fefb7acca`. Undecided manual start: `ed3159124` failed 1/passed 31 units before `58da9b468`.
- Merged main at `b9c1a79c0`, #3819 at `34aae323d`, #3818 at `f5960398b`. Combined affected verification: 776 units in 16 files, 9 real-store checks in 2 files, and typecheck passed. The new multiple-Buddy overlap then had 2 observed behavior failures at `896fba119` (quiet card unavailable; overdue notice sent to wrong chat), fixed by `1555a55c5`.
- Due query explain uses covered `IXSCAN { deleted: 1, proposalDueAt: 1, tabId: 1, key: 1 }`. Priority backlog read uses its intended index: 100 keys/docs/rows returned from 107 waiting rows.
- Same workload, isolated Mongo, 100 source authorizations: per-row baseline 100 queries / 49.588 ms; primary-key batch 1 query / 1.167 ms, 100 keys/docs/returned. This is a source-read comparison, not a full-request latency claim.
- Production statistics could not be collected: this Team environment has no read-only production environment file. Release owner must collect collection/index sizes and CPU/latency before/after the authorized schema release; no production writes performed here.

- Final overlap verification at `1555a55c5`: 66 real-store checks across proposal cards, command loading and Swarm Buddy flows; 169 focused proposal/Buddy units; typecheck passed. Full component suites and all four integration shards remain PR CI responsibilities.
- CI index repair after `f014e0915`: shard 2 passed 600 tests but its existing oldest-unanswered-delivery plan guard failed because Mongo chose the new priority index. The same focused test failed locally (2 documents, 3 keys, 1 row). Keep the worker on its existing chronological index with an aggregate hint, preserving the query, schema and rights. The original committed guard predates this fix; its new key bound also rejects a scan beyond the two recent rows plus one boundary key per unanswered status. Green: 39 real-store tests across worker plans, time checks and proposal cards, plus typecheck. The repaired query examines at most 2 documents and 7 keys in the same fixture; no production latency claim. No full local suite or manual CI run.

## Security review repairs

**Files:** `commands.ts`, `proposalCards.ts`, `proposalCards.test.ts`, `integration/superTabBuddies.test.ts`, `integration/superTabProposalCards.test.ts`.

**Interfaces:** Keep validated Buddy attachments on the proposal root and optional bounded scope in its record. Return that root's message id so the existing attachment transaction consumes each upload once. Report excluded PM recipients in `message.send` results before delivery-dependent bookkeeping; preserve other recipients, server notices and unswitched behavior. No new query, index or collection.

- [x] Commit and observe the lost-file/scope unit regression and real-store file-opening regression before code.
- [x] Preserve files, scope and root id. Green: 34 proposal units and 3 real-store file flows (switched, legacy and expired uploads). Red unit `7c72f04bf`; red integration `8088bca73` failed because persisted attachments were absent.
- [ ] Commit and observe missing-delivery-feedback regressions for person, agent and partial recipients before code.
- [ ] Compute feedback from final recipients; run affected units, real-store proposal flows and typecheck.
- [ ] Push one repair head including CI fixture repair, request focused independent re-reviews and platform confirmation.

CI fixture repair `47da5780a`: nine automatic integration failures were expired reset holds fixed at 2026-11-06T09:00Z. Reproduced the phone needs-human case failing with HOLD_REASON_MISSING before replacing all 13 resets with each fixture clock plus its original interval. Green: 58 affected checks across seven integration files, then 10 host-attention/Stuck checks across two of those files. Full local suite and manual CI were not run.
