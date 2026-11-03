# Plain chat proposals and tasks Implementation Plan

> **For agentic workers:** Follow the project Engineer workflow: plan first in a draft PR; implement task by task with a committed failing test before its passing code; one independent Review step and user Test step at the end. Independent client tasks may run in parallel.

**Goal:** Show proposals and tasks as one ordinary requester-authored “Let's build: <name>” chat message, with details and updates in its ordinary thread on Desktop and phone.

**Architecture:** Keep existing messages, replies, thread summaries, and task conversations. Post proposal roots as their person and proposal details as their Buddy. Link a task to a single project-chat root, reuse its proposal root where supplied, and publish updates as replies without state edits. Both clients use their ordinary message/thread widgets, including for legacy stored shapes.

**Tech Stack:** TypeScript, Zod, Prisma/MongoDB, Vitest; Flutter/Dart Desktop and phone.

**Spec:** Task #2294 in Super Tab conversation 1e4d3f730a915adc0c541e14 (Dee, 2026-11-03); requirements preserved below.

## Global Constraints

- Root copy is exactly `Let's build: <name>`, with the requester's ordinary avatar/name. No special rows, state word, status line or mark.
- Proposal title is optional, trimmed, at most 80 characters. Without it use the goal's first sentence after removing a leading `Requested by X.`.
- Full proposal (Goal, Scope, Priority, attachments) is the first thread reply from the Buddy; PM receives the full text. Full task brief is a thread reply; proposal-to-task conversion reuses its root.
- Later progress and PR/merge news are ordinary replies, at most one per change. Ordinary reactions, Activity, unread counts, mentions, and Threads continue working.
- Stored old messages remain readable; phone model/parts retain Desktop parity.
- PR body begins `Requested by dee@autonomous.ai through Harness.` Include red/green evidence and Desktop/phone screenshots.
- Never sign out the real CLI; use memory/fake sign-in for Desktop tests. No Swarm code in cli/src/core, no production writes, releases, firmware publication, or manifest edits. Stop only owned process IDs. Temporary folders use mktemp -d.

## Design

- Growth: use existing message retention/deletion; no new log/table. One root plus details and actual updates only; repeated unchanged status emits none.
- Concurrency: existing per-Swarm transactional command lock and operation-id idempotency commit roots/details/link state atomically.
- Read cost: normal incremental message/thread pages and summaries; no whole-history scans. Task links live in existing task card metadata.
- Scale: 10x tasks adds bounded messages per transition; first warning is command latency/message write volume. Avoid per-task database lookups on unrelated commands.
- Compatibility: optional title only; retain existing task-line/proposal source interpretation and old stored roots. New roots contain useful plain text for older clients. Keep task CLI conversations functional.
- Migration + rollback: no destructive migration or schema change; old and new roots coexist. Rollback reads useful root/reply text, with old special styling until updated again.
- Audience: existing server project access, proposal validation, attachment validation, and thread routing apply; no cross-project message reuse.
- Identity: server derives proposer from Buddy owner and requester from validated Swarm membership, never machine owner login. Keep membership generation.
- Failure: transaction rollback leaves neither half-posted proposal nor task link. Existing command errors and delivery failures remain visible.
- Platforms: backend, Desktop, phone, and CLI proposal instructions. No platform-specific APIs.

## Review Focus

1. Empty/overlong titles, sentence-less goals and a leading requester prefix: fallback stays useful and bounded (Task 1).
2. Proposal conversion, duplicate retries, repeated status and repeated merge: one root, one update per actual change (Tasks 1–2).
3. Private projects, departed requesters and a removed Buddy: author attribution and reuse never bypass read access (Tasks 1–2).
4. Old task-line and Buddy proposal records: full text remains available in ordinary message/thread widgets (Tasks 3–4).
5. Thread summaries, unread marks, mentions, reactions and attachments: details stay out of main stream and replies stay usable (Tasks 1–4).

### Task 1: Ordinary proposal roots and details

**Files:** Modify backend/src/superTabs/buddies.ts, commands.ts; test buddies.test.ts and integration/superTabBuddies.test.ts. Update cli/src/lib/swarmSkills.ts and cli/src/superTabs/service.ts proposal instructions.

**Interfaces:** Consumes existing buddy.propose and validated proposalAsk/attachments. Produces optional `title?: string` on buddy.propose, one person-authored root with existing buddy-proposal source plus Buddy attribution, one Buddy-authored reply (`replyTo` and `thread` equal root id) with full proposal and attachments. Existing command result/message ids remain stable.

- [x] Write/commit failing tests: explicit title produces `Let's build: Offline drafts` from the Buddy owner; first reply has full Goal/Scope/Priority and attachments and PM recipient. Test fallback `Requested by Dee. Save drafts. Keep them.` gives `Let's build: Save drafts.`; title boundary; owner generation; duplicate asks; project access.
- [x] Run `cd backend && npm test -- src/superTabs/buddies.test.ts src/superTabs/buddyNews.test.ts --maxWorkers=2`; record expected missing-root/details failures.
- [x] Add title schema and root-name helper in buddies.ts; write two ordinary messages in buddy.propose preserving validated owner/attachment/PM delivery. Update Buddy instructions/help to supply a short title.
- [x] Run affected tests and proposal integration tests; commit passing code and push.

### Task 2: One task root and ordinary progress thread

**Files:** Modify backend/src/superTabs/taskLine.ts, commands.ts, store.ts as needed; test taskLine.test.ts, buddyNews.test.ts, integration/superTabTaskLines.test.ts and related thread tests.

**Interfaces:** Consumes existing Conversation/cards.line, proposalMessageId and proposal context; produces one linked ordinary project root at conversation.create, first brief reply, and append-only transition replies. Existing task conversation ids and CLI work commands stay valid. Reused proposal source carries Buddy id for credit. Existing source kind remains readable; no client needs new rendering fields.

- [x] Write/commit failing tests: opening a task immediately posts requester-authored `Let's build: Offline drafts` plus brief reply; no requester uses PM. Assignment/status/PR/merge produce replies, no root edit; unchanged/retried status and repeated merge produce none. Proposal conversion reuses root. Exclude steps/project/Buddy chats; private project isolation; old lines remain readable. Verify task posts appear in linked thread without repeated delivery.
- [x] Run `cd backend && npm test -- src/superTabs/taskLine.test.ts src/superTabs/buddyNews.test.ts --maxWorkers=2`; record red.
- [x] Replace root-state editing with transactional root/link/reply handling. Preserve legacy metadata and assignment tracking, validate proposal reuse and stable operation IDs. Use existing ordinary thread summary/read/delivery paths.
- [x] Run affected tests and `npm run test:super-tabs -- --maxWorkers=2` (full integration suite); commit passing code and push.

### Task 3: Desktop ordinary message/thread rendering

**Files:** Modify desktop/lib/super_tabs/view.dart, task_line.dart and related ordinary message filtering only as needed; tests desktop/test/super_tab_task_line_test.dart and a screenshot fixture.

**Interfaces:** Consumes existing SuperTabMessage text, author, thread, replyTo and source. Produces ordinary SuperTabMessageRow and normal thread opener for proposal/task roots, including legacy source kinds. No backend or phone file changes.

- [x] Write/commit failing widget tests proving requester avatar/name, full root text, ordinary Reply/reactions/thread affordances, and root-to-normal-thread navigation. Include legacy proposal/task-line fixtures and narrow viewport.
- [x] Run bounded affected widget tests and record red before implementation.
- [x] Remove special proposal/task rendering and task-panel navigation from the chat row path; use ordinary message/thread behavior. Preserve unrelated task management surfaces.
- [x] Run affected tests and capture Desktop screenshot with fake sign-in/memory state. Commit passing code and push.

### Task 4: Phone ordinary message/thread rendering

**Files:** Modify mobile/lib/swarm/swarm_message_row.dart, swarm_conversation_page.dart, swarm_task_line.dart as needed; tests mobile/test/swarm/swarm_task_line_test.dart and screenshot fixture.

**Interfaces:** Consumes existing phone SuperTabMessage ordinary author/text/thread fields; produces ordinary SwarmMessageRow with standard avatar, reactions, reply and thread opening. No backend or Desktop file changes; no new model fields required.

- [x] Write/commit failing widget tests for ordinary task/proposal roots and legacy messages, requester identity, reactions, reply/thread affordance, and narrow screen reading.
- [x] Run affected Flutter tests and record red before implementation.
- [x] Remove special task row routing/rendering, retaining unrelated task status screens and legacy text; use existing thread navigation.
- [x] Run affected tests, `test/swarm/desktop_parity_test.dart`, and capture phone screenshot. Commit passing code and push.

## Validation and handoff

- Record implementation, validation, review/CI waiting, merge and publication durations separately from task start (2026-11-03 04:15 UTC). Engineer does not merge or release.
- Inputs: complete backend source/schema/lockfiles with Node 22.23.2; Desktop and phone complete component trees, shared fixtures, Flutter 3.47.2 and pub locks; CLI source/lockfiles for proposal instruction change. Deterministic evidence reuse requires matching these inputs/toolchain and `--reuse` receipt.
- Choose checks before running: backend typecheck and affected unit tests; full Super Tab integration suite; bounded Desktop/phone affected widget tests and phone parity; CLI affected swarmSkills/command tests. Automatic ready PR CI supplies full affected component Linux suites. Native user testing on Mac/simulator supplies screenshots and ordinary thread interaction evidence.
- Start independent checks within machine capacity, maximum two local workers per check. Time-bound each scoped check to 180–300 seconds, integration suite to 900 seconds. Investigate new failures; record known unrelated failures explicitly without claiming a pass.
- Post red/green PR evidence, make the stable head Ready, route/assign independent Review and Test steps, and request both directly. Complete acceptance checks only with actual evidence; read task before setting Done for PM batch merge.

### Task 5: Dee's approved thread copy and chat-asked roots (resumed by Sorrel, 2026-11-03)

Dee approved the exact thread lines on 2026-11-03 (task conversation, River's copy). Tasks 1–4 posted their own wording and
copied every plain post of the task's conversation into the chat thread; this task replaces both.

**Files:** Modify backend/src/superTabs/taskLine.ts, buddies.ts, commands.ts, store.ts (load the asked-in message as the
proposal is loaded); tests taskLine.test.ts, buddies.test.ts, integration/superTabTaskLines.test.ts,
integration/superTabBuddies.test.ts, integration/superTabSwarmBuddy.test.ts. Update cli/src/lib/swarmSkills.ts and
cli/src/superTabs/service.ts help text.

**Interfaces:** conversation.create takes optional `requestMessageId`: a person's own top-level message in the project's chat
that asked for the work. It becomes the task's root (no new message, no brief reply) and its author the requester when none
is named. Every thread reply is authored by the project's coordinator, wakes nobody, and is one of:

- assigned: `On it: <agent> is building it.`
- needs a person (with ask): `@<user> Your call: <question>. Default: <recommended option>.`
- review: `Ready for review: PR #<n>` (`Ready for review.` without a pull request)
- review → working: `Changes needed: <first line of the result>. <agent> is fixing it.`
- blocked: `Stuck: <first line of the result>. Next: <PM> is looking at it.`; lost: `Stuck: <agent> stopped. Next: another engineer takes it over.`
- merged: `Merged: PR #<n>. Ships in the next release.`
- cancelled or stopped: `Not building this: <reason>.`
- done without a pull request: `Done.`; done with one says nothing (the merge reply follows).

Agents' posts in the task's own conversation stay there. A proposal's first reply is `Goal: …\nScope: …\nPriority: …` from the
Buddy, and a task from it adds no brief reply. Queued, Released and Duplicate have no server event yet and are not posted.

- [x] Write/commit failing tests for each line, coordinator authorship, no mirrored chatter, no brief reply under a proposal,
  the chat-asked root (and refusals: another chat, a reply, a server row, an agent's message), and the proposal details text.
- [x] Run `cd backend && npm test -- src/superTabs/taskLine.test.ts src/superTabs/buddies.test.ts`; record red.
- [x] Implement; run affected tests, typecheck and `npm run test:super-tabs -- --maxWorkers=2`; commit and push.
