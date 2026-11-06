# Prompt PM delivery and answer time implementation plan

> Implement directly, task by task, test first; commit each failing test before its passing code, then obtain independent PR review.

**Goal:** Deliver people's messages immediately to the working PM, acknowledge receipt once, and measure its first answer.

**Architecture:** Stop gathering person-authored messages into the turn inbox; retain batching for agent notices and crew needs. The authorized host acknowledgement adds the PM's existing eyes reaction transactionally. Derive answer-time figures from existing message records and change the existing board pulse threshold to five minutes.

**Tech Stack:** TypeScript, Vitest, Prisma/MongoDB; existing CLI Swarm input delivery (already accepts input while busy).

**Spec:** Harness task #3609, conversation e6e4f5a93f4ecb99f29f8ff9, River's brief of 2026-11-06.

## Global Constraints

- Backend and CLI Swarm paths only; no cli/src/core changes, production writes, sign-outs or system installs.
- PR starts `Requested by dee through Harness.` Tests first; affected tests locally, complete backend/integration checks in PR CI.
- Preserve access checks, message author attribution, cross-account warnings, unanswered tracking and older hosts.
- Temporary files only in mktemp -d folders; stop only processes started for this task, by id.

## Visible behavior

Existing board strip, unchanged layout: `[ PM · 1 ask · oldest 5m (red) | Working 3 | Next 2 ]`.
Message receipt: `Dee: Is the fix out?  👀 River` (only after successful session receipt).
Daily scorecard adds `PM first answer | median 30s | slowest 90s | 2 answered`.

## Design

Reuse message/reaction/scorecard stores and their lifecycle; no new collection or index. One optional message field, `answers`, preserves a main answer link without opening a thread; older clients ignore it and old rows remain valid. Reaction and receipt share the existing transaction; deterministic reaction identity makes retries idempotent. Readers use current project grants and indexed message pages. A PM reply must be in the same conversation and directly answer the message or occur later in its thread; agent notices, reactions, and task cards do not count. Daily figures cover messages answered during the day, with the existing bounded seven-day lookback and reader cap reported as before. Rollback restores batching and the old threshold; old scorecards omit the optional figure. No backfill, new timer, or platform-specific code. At ten times traffic reads stay bounded by existing page caps; watch capped scorecards and delivery latency. Production read-only credentials are unavailable here; loopback integration/profile evidence substitutes and that limitation is reported.

## Review Focus

- Already-gathered person rows must escape a busy inbox without releasing agent notices.
- Thread and Buddy relay messages preserve author/place and remain owed after eyes.
- Uncertain/retried receipts and non-PM deliveries must not create false or duplicate eyes.
- An unrelated agent post, reaction, or later answer must not replace the PM's first answer time.
- Cross-day replies, zero samples, private chats, deleted rows and missing historical context remain bounded and honest.

### Task 1: Immediate person delivery

**Files:** backend/src/superTabs/inbox.ts, inbox.test.ts, store.ts; backend/integration/superTabNoticeDigest.test.ts; pulse.ts if relay tracking needs correction.
**Interfaces:** gathersForInbox(state, recipient, message): boolean keeps only crew batching; deliveries(user, tab, agent, turn) releases legacy people without releasing other gathered rows. Existing owedLines remains the reminder interface.

- [ ] Commit tests for busy PM project messages, threads and Buddy relays delivered immediately while notices stay gathered; legacy gathered people released; unanswered asks reappear.
- [ ] Run the affected unit/integration cases and observe the behavior fail.
- [ ] Implement the minimal classification/requeue changes, preserving all authorization and attribution.
- [ ] Run affected inbox/digest/pulse tests, commit code and push.

### Task 2: Receipt eyes

**Files:** backend/src/superTabs/store.ts; backend/integration/superTabNoticeDigest.test.ts (or existing delivery integration fixture).
**Interfaces:** deliver(... ack ...) writes eyes under the receiving PM's identity on first confirmed receipt; existing reaction identity and reactionSeq drive reader refresh.

- [ ] Commit tests: claim has no eyes; uncertain ack has no eyes; successful ack adds one, retries keep one and do not settle owed; non-PM/agent messages add none.
- [ ] Run and observe failing tests.
- [ ] Add the transactional reaction write and existing conversation change notification; test concurrent/manual eyes and revocation through current delivery authorization.
- [ ] Run affected receipt/reaction integrations; commit and push.

### Task 3: Answer time and five-minute pulse

**Files:** backend/prisma/schema.prisma (optional message answer link), backend/src/superTabs/{model.ts,commands.ts,store.ts}, backend/src/superTabs/scorecard/{figures.ts,figures.test.ts,records.ts}, scorecard presentation module; backend/src/superTabs/{pulse.ts,pulse.test.ts}; backend/integration/superTabScorecard.test.ts.
**Interfaces:** optional pmAnswer {count, medianSeconds, slowestSeconds} on ScorecardFigures; records includes bounded project message lookback and explicit answer links; PULSE_LIMITS.askMinutes = 5.

- [ ] Commit tests for first PM answers to main/thread/relay messages; wrong agent/place, reactions, task cards and duplicate answers excluded; cross-day, zero samples and subminute timings; redAt equals sent+300000ms.
- [ ] Run and observe failures.
- [ ] Implement pure first-answer matching from stored message links and render daily median/slowest; extend existing indexed reader only as necessary, retaining caps and audience filters.
- [ ] Run figures/pulse/job tests and affected scorecard integrations; profile any changed query against its existing index; typecheck.
- [ ] Commit and push; add red/green PR comment; mark ready and set task review with exact revision and evidence.
