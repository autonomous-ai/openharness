# Guide-answered asks implementation plan

> **For agentic workers:** Implement this plan task by task in this Engineer session, using test-driven development. Commit the failing tests before the implementation; use one independent review of the finished pull request.

**Goal:** Remove an ask from the PM's owed list and the Board count when the project agent entrusted with it answers in its thread.

**Architecture:** Keep `Conversation.owed` as the shared source for the inbox and stored Board pulse. Record an explicit PM handoff on its existing bounded ask record, then settle that ask only when the named project agent answers in that thread. A Guide's role name or unsolicited reply grants no settlement authority. Membership routing remains the PM's decision under the project instructions, rather than being inferred from public-project access or parsed usernames.

**Tech Stack:** TypeScript, existing Super Tab command reducer and conversation parts, Vitest.

**Spec:** Swarm task #3871, conversation `32e69d0f90b212ede93249de`: delegated non-member asks leave both displays after the Guide answers; members' asks answered only by a Guide remain owed; the PM can close a greeting without replying; posting permissions stay unchanged. River confirmed explicit handoff in the task thread on 2026-11-06: only the agent named in the PM handoff settles it; unsolicited replies leave it owed.

## Global Constraints

- Backend only, within `backend/src/superTabs/`.
- No hardcoded people or Guide names; no change to who may post or read.
- An agent reply outside the entrusted ask's thread cannot close it. A handoff needs the PM, a live owed ask, and one explicitly addressed agent of the same project.
- Keep the 50-ask bound, operation idempotency, and existing PM reply/reaction/task settlement.
- Run affected unit tests locally; automatic PR CI supplies the full backend unit and Super Tab integration evidence.

## Design

- Growth: one optional entrusted agent ID belongs to an existing owed ask. The ask disappears on settlement, deletion, departure, or eviction from the newest 50. No new collection or index.
- Concurrency: handoff, answer, answer receipt and pulse update use the existing command transaction and conversation part; duplicate operation receipts keep retries idempotent.
- Read cost: inspect only the loaded conversation's bounded asks and existing project/agent state; no transcript reads or new database query.
- Scale: bounded work per post; measure the same 50-ask command workload before and after. Existing message latency and part size measures warn first.
- Compatibility: backend-only additive optional ask metadata. Old records still await the PM unless explicitly handed off; old clients keep using existing post/reply operations and pulse fields. A new optional `message.send.handoff` names an owed message in the PM's project chat, on its post to exactly one project agent in that agent's task. Existing posts never infer handoff from prose.
- Migration/rollback: no history scan or destructive migration. A rollback ignores optional delegation metadata and resumes PM-only settlement. Already-settled asks stay settled.
- Audience: existing conversation/project checks run before settlement. Delegation cannot grant posting rights or cross project boundaries.
- Identity: compare server-known agent IDs, never names, model roles or machine logins.
- Failure: unmatched or unsolicited replies leave the ask visible as owed; the PM can still answer or give a verdict reaction. No new external call or wait.
- Platforms: backend on Linux; developer checks on macOS; all clients consume unchanged fields.

## Review Focus

- An unsolicited Guide reply to a member's ask must leave both the owed list and Board count unchanged.
- A PM handoff must not itself count as the answer or prevent the entrusted agent's eventual answer.
- A different project agent, another thread, or a private agent-only note must not settle the entrusted ask.
- A follow-up ask or a later PM answer must retain the existing thread and answer-once semantics.
- A greeting can close through a PM verdict reaction; eyes and another agent's reaction cannot close it.

## Task 1: Settle explicitly entrusted asks through the existing command path

**Files:**
- Modify: `backend/src/superTabs/pulse.ts`, `backend/src/superTabs/commands.ts`, `backend/src/superTabs/parts/touches.ts`.
- Test: `backend/src/superTabs/delegatedAsks.test.ts`; use `owedLines` and `storedPulse` to check both consumers and `touchesFor` for concurrency.

**Interfaces:**
- Extend `OwedAsk` with optional `delegatedTo?: string`, the project agent explicitly named by its PM.
- Add `handoffAsk(state, group, agentId, messageId, recipients): void` to validate and record the PM's handoff of its project-chat ask. Add the optional `handoff` message ID to `message.send`; only a public post to one explicitly named recipient may carry it.
- Keep the `settleReply`, `owedLines`, `storedPulse`, and existing command request/response fields unchanged.
- Guard the PM authority check against a concurrent PM replacement by touching the project chat.

- [ ] Add command-level tests: handoff retains the ask; entrusted thread answer removes it from both consumers; member's unsolicited Guide answer remains owed; wrong agent/thread and agent-only replies do not settle; PM can answer later; greeting closes by PM verdict without a message.
- [ ] Commit tests and run `npm test -- src/superTabs/delegatedAsks.test.ts`; capture the expected failures in handoff/settlement behavior.
- [ ] Implement bounded handoff recording and settlement in `pulse.ts`, passing the explicit handoff and validated named recipient from `commands.ts`. Preserve normal PM settlement and answer receipts.
- [ ] Run `delegatedAsks.test.ts`, `parts/touches.test.ts`, `pulse.test.ts`, `inbox.test.ts`, `answers.test.ts`, `chatLimits.test.ts`, `commands.test.ts`, `liveness.test.ts`, and `processNotes.test.ts`, plus backend typecheck. Compare message-path timings with the baseline.
- [ ] Commit and push the implementation; reconcile the membership ruling; add red/green evidence to the PR, mark Ready, and hand it to independent review and testing through task status.
