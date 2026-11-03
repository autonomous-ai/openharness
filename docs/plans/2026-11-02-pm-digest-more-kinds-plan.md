# The PM's digest gathers three more kinds of notice: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (Ken
> chose inline execution with one independent final review). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A step's Stuck, the coordinator's own skills notices, and usage-limit or failing-model alerts reach the PM in its
5-minute digest instead of one by one.

**Architecture:** `gatheredNotice` (backend `noticeDigest.ts`) decides per message and recipient whether the coordinator's
delivery is gathered; it gains the message's group and three rules. `message.send` gains an optional `notice: "skills"` mark
for agent-only self-notices, which the CLI host sets. The release (`store.ts releasableNotices`) cancels an alert that ended.

**Tech Stack:** TypeScript, Fastify + Prisma on MongoDB (backend), Vitest with MongoMemoryReplSet (integration), the Node CLI
host with its spec suite.

**Spec:** [2026-11-02-pm-digest-more-kinds-design.md](2026-11-02-pm-digest-more-kinds-design.md), extending
[2026-11-02-pm-notice-digest-design.md](2026-11-02-pm-notice-digest-design.md).

## Global Constraints

- Gathered only for the coordinator (the existing `ledProject(state, recipient)` check); every other recipient is unchanged.
- Still at once: `needs_human` anywhere, `blocked` on a task (no `reviewOf`), `terminal-alert` `prompt`, every `agent-only`
  without `notice: "skills"` (a decision answered among them), every post.
- `notice` is accepted only as the literal `"skills"`, only with `agentOnly: true`; `agentOnly`'s own rule (an agent, to itself
  alone, no mentions) still applies. The row's source is `{ kind: 'agent-only', notice: 'skills' }`.
- 5 minutes, 50 lines, the 30-minute backstop, release checks and every cancel path stay as they are.
- No client (Desktop, phone, web) change. Never edit `cli/src/lib/e2ee/core.ts`.
- Each commit: the failing test first, then the code that passes it; push after each task.

## Review Focus

1. A step's `needs_human` must still reach the PM at once; only `blocked` in a step is gathered. (Task 1 and Task 3 tests.)
2. A gathered step `blocked` still reaches the task's owner at once (queued for the owner). (Task 3 test.)
3. `notice: "skills"` from a person, to another agent, or without `agentOnly` is refused, so nobody can hide a message in a
   digest. (Task 2 tests.)
4. An alert that ended and was raised again before the release is delivered, not cancelled: `alerting` holds it again.
   (Task 3 test.)
5. An old backend refusing `notice` still gets an agent-only notice (not a visible one), and an older one refusing
   `agentOnly` still gets the plain one, each once. (Task 4 tests.)

---

### Task 1: What is gathered (`noticeDigest.ts`)

**Files:**
- Modify: `backend/src/superTabs/noticeDigest.ts` (`gatheredNotice`, `DIGEST_KINDS` comment)
- Test: `backend/src/superTabs/noticeDigest.test.ts` (`describe('what is gathered')`)

**Interfaces:**
- Produces: `gatheredNotice(source: unknown, group?: Pick<Conversation, 'reviewOf'>): boolean`. Without a group it answers as
  today for every source; a `blocked` status row counts only with `group.reviewOf`.

- [ ] **Step 1: Write the failing tests** in `describe('what is gathered')`:

```ts
it('a step\'s Stuck, never a task\'s, and Needs a human nowhere', () => {
  expect(gatheredNotice({ kind: 'system', status: 'blocked' }, step)).toBe(true)
  expect(gatheredNotice({ kind: 'system', status: 'blocked' }, task)).toBe(false)
  expect(gatheredNotice({ kind: 'system', status: 'blocked' })).toBe(false)
  expect(gatheredNotice({ kind: 'system', status: 'needs_human' }, step)).toBe(false)
})
it('the coordinator\'s own skills notice, and no other agent-only row', () => {
  expect(gatheredNotice({ kind: 'agent-only', notice: 'skills' })).toBe(true)
  expect(gatheredNotice({ kind: 'agent-only' })).toBe(false)
  expect(gatheredNotice({ kind: 'agent-only', decisionId: 'd1' })).toBe(false)
  expect(gatheredNotice({ kind: 'agent-only', notice: 'other' })).toBe(false)
})
it('a usage limit or a failing model, never an agent waiting at a prompt', () => {
  expect(gatheredNotice({ kind: 'terminal-alert', alert: 'limit' })).toBe(true)
  expect(gatheredNotice({ kind: 'terminal-alert', alert: 'model' })).toBe(true)
  expect(gatheredNotice({ kind: 'terminal-alert', alert: 'prompt' })).toBe(false)
  expect(gatheredNotice({ kind: 'terminal-alert' })).toBe(false)
})
```

The existing `it.each([... 'terminal-alert', ... 'agent-only' ...])('not %s')` and the "no other status" test stay as they
are (a bare kind stays not gathered; `blocked` without a group stays not gathered).

- [ ] **Step 2: Run, watch them fail**

Run: `cd backend && npm test -- src/superTabs/noticeDigest.test.ts`
Expected: the three new tests FAIL (`expected false to be true`).

- [ ] **Step 3: Implement** the signature above in `noticeDigest.ts`. Update the `DIGEST_KINDS` comment: `terminal-alert`
  and `agent-only` are no longer "each delivers at once", only their marked forms are gathered.

- [ ] **Step 4: Run, watch them pass**, plus the whole file. Expected: PASS.

- [ ] **Step 5: Commit and push**

```bash
git add backend/src/superTabs/noticeDigest.ts backend/src/superTabs/noticeDigest.test.ts
git commit -m "Swarm digest: a step's Stuck, skills notices, usage limits and failing models are gathered"
```

### Task 2: The `notice` mark on `message.send` (`commands.ts`)

**Files:**
- Modify: `backend/src/superTabs/commands.ts` (the `message.send` schema near `agentOnly: z.literal(true).optional()`, the
  `agentOnly` check near line 2753, the `message(...)` call near line 2757)
- Test: `backend/src/superTabs/commands.test.ts` (next to the existing agent-only `message.send` tests)

**Interfaces:**
- Produces: `message.send` accepts `notice?: 'skills'`; the written message's `source` is `{ kind: 'agent-only', notice: 'skills' }`.
- Consumes: Task 1's rule reads `source.notice`.

- [ ] **Step 1: Write the failing tests**
  - `'marks an agent\'s own skills notice'`: an agent sends `{ agentOnly: true, notice: 'skills', recipientIds: [self] }`;
    the message's `source` equals `{ kind: 'agent-only', notice: 'skills' }`.
  - `'refuses the skills mark anywhere but an agent\'s own agent-only notice'`: `notice: 'skills'` without `agentOnly`, from
    a person, and to another agent each throw `VALIDATION_ERROR`; `notice: 'other'` fails the schema.

- [ ] **Step 2: Run, watch them fail**

Run: `cd backend && npm test -- src/superTabs/commands.test.ts -t "skills"`
Expected: FAIL (`Unrecognized key: "notice"`).

- [ ] **Step 3: Implement**: schema `notice: z.literal('skills').optional()`; `notice` without `agentOnly` refused with the
  same `VALIDATION_ERROR` style as the `agentOnly` check; source `{ ...AGENT_ONLY, notice }` when set.

- [ ] **Step 4: Run, watch them pass**, plus the whole file. Expected: PASS.

- [ ] **Step 5: Commit and push**

### Task 3: Gathering and release in the store

**Files:**
- Modify: `backend/src/superTabs/store.ts` (`writeMessages` gathering line `gatheredNotice(message.source) && ...`;
  `releasableNotices`)
- Test: `backend/integration/superTabNoticeDigest.test.ts`

**Interfaces:**
- Consumes: Task 1 `gatheredNotice(source, group)`; Task 2's source shape.

- [ ] **Step 1: Write the failing tests** (use the file's `swarm()`, `write()`, `deliveryOf()`, `poll()`, `digests()`):
  - `'a step\'s Stuck is gathered for the coordinator and goes at once to the task\'s owner'`: create a step
    (`conversation.create` with `reviewOf: group`, title `Review: Ship the parser`), add and assign a Reviewer on `test-host`,
    the Reviewer sets `blocked`; the `Stuck` row's delivery is `gathered` for `lead`, `queued` for `worker`.
  - `'a step\'s Needs a human goes at once to the coordinator'`: same step, `needs_human`; `queued` for `lead`.
  - `'the coordinator\'s skills notice is gathered; its other agent-only notices are not'`: `write({ kind: 'agent-only',
    notice: 'skills' }, lead, leadConversation, 'The project\'s instructions changed.', lead)` is `gathered`;
    `write({ kind: 'agent-only' }, lead, ..., lead)` is `queued`.
  - `'a usage limit and a failing model are gathered; a prompt goes at once'`: `write({ kind: 'terminal-alert', agentId:
    worker, alert })` for `limit`, `model` (gathered) and `prompt` (queued).
  - `'an alert that ended before the release is cancelled and left out'`: the worker raises `agent.alert` `{ agentId: worker,
    alert: 'limit', active: true }` (as `host`, `asAgentId` worker), which writes the real alert, gathered for `lead`; then
    `active: false`; advance `DUE`, poll: that row is `cancelled` and no digest names its message id.
  - `'an alert raised again before the release is delivered'`: `limit` active, inactive, active again before the poll: the
    first row is named in the digest (its agent holds the alert again).

- [ ] **Step 2: Run, watch them fail**

Run: `cd backend && npx vitest run --config vitest.super-tabs.config.ts integration/superTabNoticeDigest.test.ts`
Expected: the new tests FAIL (`expected 'queued' to be 'gathered'`, and the ended alert delivered).

- [ ] **Step 3: Implement**: `writeMessages` passes `group` to `gatheredNotice`. In `releasableNotices`, a row whose message
  source is `terminal-alert` and whose `agent(state, source.agentId)?.alerting` lacks `source.alert` is cancelled exactly as
  a refused row is (same `updateMany` guarded by `status: 'gathered'`, counted in `refused`).

- [ ] **Step 4: Run, watch them pass**, then the whole Super Tab integration suite.

Run: `cd backend && npm run test:super-tabs`
Expected: all files pass.

- [ ] **Step 5: Commit and push**

### Task 4: The CLI host marks its skills notices

**Files:**
- Modify: `cli/src/superTabs/host.ts` (`tellSkill`)
- Test: `cli/src/superTabs/host.spec.ts` (next to `'sends each notice the old way, once, when an older backend refuses the
  agent-only mark'`)

**Interfaces:**
- Consumes: Task 2's `notice: 'skills'`.

- [ ] **Step 1: Write the failing tests**
  - In `'rewrites each running Lead, Builder and Reviewer skill once …'`: every sent command has `notice: 'skills'`.
  - `'drops the skills mark, once, when a backend refuses it, and keeps the notice agent-only'`: refuse requests with
    `notice` (`VALIDATION_ERROR`, `Unrecognized key: "notice"`); each notice is sent once with `agentOnly: true` and no
    `notice`.
  - The existing older-backend test (refuses `agentOnly`) still ends with each notice sent once with neither key.

- [ ] **Step 2: Run, watch them fail**

Run: `cd cli && npx vitest run src/superTabs/host.spec.ts -t "skill"`
Expected: FAIL (`notice` missing).

- [ ] **Step 3: Implement**: `send(agentOnly, notice)`; try `(true, true)`, on a refusal naming `"notice"` retry `(true,
  false)`, on one naming `"agentOnly"` retry `(false, false)`; any other refusal is thrown as today.

- [ ] **Step 4: Run, watch them pass**, then `cd cli && npm run typecheck && npx vitest run src/superTabs`. Expected: PASS.

- [ ] **Step 5: Commit and push**

### Finish

- [ ] `cd backend && npx tsc --noEmit -p . && npm test && npm run test:super-tabs`; `cd cli && npm run typecheck`.
- [ ] Red/green evidence in a PR comment (each new test's failing assertion on `origin/main`, then passing).
- [ ] One independent final review of the whole branch on the most capable model.
