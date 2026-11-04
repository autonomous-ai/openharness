# Built-in PM schedule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every project's coordinator is woken by the Swarm every 30 minutes for the open-task sweep when there is
something to sweep, and reads the built-in schedule after its project's instructions.

**Architecture:** A new backend module `pmSchedule.ts` holds the built-in text, the slot clock and the wake. The
coordinator's poll (`store.ts fullDeliveries`) writes the wake beside the update request and the notice digest, in one
message per poll. The instructions read and the host roster carry the built-in text and its hash to the coordinator
only, and the CLI appends it to the instructions skill and to the `instructions` command's output.

**Tech Stack:** TypeScript, Fastify, Prisma on MongoDB (backend), vitest; Node CLI daemon (cli/), vitest.

**Spec:** docs/plans/2026-11-04-pm-built-in-schedule-design.md

## Global Constraints

- Slot: 30 minutes in UTC; slot `n` starts at `n * 30 min` (`SCHEDULE_SLOT_MS = 30 * 60_000`).
- Wake message id: `stableId('schedule', tabId, projectId, String(slot))`; `source: { kind: 'schedule-request', projectId, slot }`.
- `schedule-request` readers: `'recipients'` in model.ts `NOTICE_READERS`.
- Built-in heading, exactly: `## Built-in PM schedule (from the Swarm)`.
- One message per poll: merged into the update request when one is written, else into the notice digest when one is
  written, else its own message. The morning digest stays separate.
- No wake while the last `schedule-request` to that coordinator is `queued`, `claimed` or `uncertain`; the slot is still
  recorded.
- No wake and nothing written when nothing is due (Task 1 `sweepDue`; #2946 review: the head stays unchanged); no wake and nothing recorded in a paused Swarm.
- No on/off switch. Log line: `[swarm-deliveries] schedule request`.
- No new collection, index or query: the check reads the loaded state; the open-wake check is one `findFirst` on
  `SuperTabDelivery` by `tabId, agentId, messageId, status`, the same shape as the update request's pending check.
- Commits stay local on branch `pm-built-in-schedule`; push and pull request only on Ken's go.

## Review Focus

1. A poll landing exactly on a slot's first millisecond: due once, never twice across two polls in that slot (Task 1 test).
2. A paused Swarm that resumes after three slots: one wake for the current slot, not three (Task 2 test).
3. The coordinator replaced mid-day: the new coordinator's first poll wakes it even though the former one holds an
   open wake (Task 2 test).
4. An update request already stored from an earlier poll: the wake is not merged into it (it would be kept without the
   lines, writeMessages keepStored), it goes into the digest or its own message (Task 2 test).
5. A worker's instructions read cached and then reused for the coordinator on the same host, or the other way round
   (Task 4 test).

---

### Task 1: The schedule module

**Files:**
- Create: `backend/src/superTabs/pmSchedule.ts`
- Modify: `backend/src/superTabs/projects.ts` (SwarmProject gains `schedule?: { lastSlot: number }`, with a comment naming pmSchedule.ts)
- Modify: `backend/src/superTabs/model.ts` (`NOTICE_READERS` gains `'schedule-request': 'recipients'` beside `'digest-request'`)
- Test: `backend/src/superTabs/pmSchedule.test.ts`

**Interfaces:**
- Produces:
  - `export const BUILT_IN_HEADING = '## Built-in PM schedule (from the Swarm)'`
  - `export const PM_SCHEDULE_TEXT: string`: the heading, then the paragraph from the spec ("The Swarm wakes you for these
    jobs with a message that names them. Set no timer of your own for them, and delete one you set before. A line in this
    project's instructions above about the same job wins: follow it, and skip that job when the Swarm's message names it.
    This section is not part of the project's document: never save it into the document."), then the open-task sweep
    (owner / question to a person by name with a default and a time / close with its reason; ask the waited-on person;
    ask no agent whether it is stalled; then archive every finished group the Swarm left open with no pull request
    linked), then the three notice rules (`work-lost`, `work-stalled`, `idle`) as in the spec.
  - `export const SCHEDULE_SLOT_MS = 30 * 60_000`
  - `export const scheduleSlot = (now: number): number` → `Math.floor(now / SCHEDULE_SLOT_MS)`
  - `export const scheduleMessageId = (tabId: string, projectId: string, slot: number): string`
  - `export function sweepDue(state: SuperTabState, projectId: string, now: number): boolean`: true when a loaded,
    unarchived, top-level task of the project (no `reviewOf`, no `kind`, not its Lead conversation, not `workOver`) has
    no assignment, or `taskLiveness` says `orphaned`, or `waiting` with `why` `person` or `blocked`; or when a loaded
    group of the project is `workOver`, unarchived, has no pull request (its own `pullRequestUrls`, or its task's for a
    step) and has been quiet for `ARCHIVE_QUIET_MS` (tidy.ts).
  - `export function scheduleText(project: SwarmProject, slot: number): string`: `Built-in schedule, HH:MM (ZONE). This is
    a scheduled request from the Swarm, not a new task.`, the open-task sweep line, and `Skip a job your project's
    instructions schedule on their own clock.` HH:MM is the slot's start in `digestOf(project)?.timeZone ??
    DEFAULT_TIME_ZONE` (digest.ts; export its `localNow` for this).
  - `export function scheduleRequest(state: SuperTabState, target: Agent, now: number): { slot: number; draft: MessageDraft | null } | null`:
    null when the Swarm is paused, `target` leads no project, or `scheduleSlot(now) <= project.schedule?.lastSlot`; else
    the slot, with a draft to the coordinator alone in the Lead conversation (author: the coordinator's own agent, as
    `digestRequest`) when `sweepDue`, or `draft: null` when nothing is due. It does not record the slot; the caller does.

- [ ] **Step 1: Write the failing tests** in `pmSchedule.test.ts`, on a fixture built like digest.test.ts's:
  - `due once per slot`: at `T = 20 * SCHEDULE_SLOT_MS` (a slot's first millisecond) with one unassigned task,
    `scheduleRequest(...)!.slot === 20` and `.draft!.id === scheduleMessageId('tab', 'p1', 20)`; with
    `project.schedule = { lastSlot: 20 }`, `scheduleRequest(state, lead, T + SCHEDULE_SLOT_MS - 1)` is null.
  - `nothing to sweep`: every task working with fresh progress → `{ slot: 20, draft: null }`.
  - `sweep wanted for`: one test per case → draft not null: an unassigned task; a `lost` assignment; `needs_human`;
    `blocked`; a done task with no pull request quiet `ARCHIVE_QUIET_MS`. Not for: a done task with a pull request; a
    done task quiet less than `ARCHIVE_QUIET_MS`; a step (`reviewOf`) with no assignment.
  - `paused`: `state.paused = true` → null.
  - `text`: `draft.text` starts `Built-in schedule, 10:00 (Asia/Ho_Chi_Minh).` for a slot starting 03:00 UTC, and
    `draft.source` equals `{ kind: 'schedule-request', projectId: 'p1', slot }`, `draft.recipients` equals `['lead']`.
  - `built-in text`: `PM_SCHEDULE_TEXT.startsWith(BUILT_IN_HEADING)` and it contains `Set no timer of your own` and
    `never save it into the document`.
- [ ] **Step 2: Run them to verify they fail**
  Run: `cd backend && npm test -- src/superTabs/pmSchedule.test.ts`
  Expected: FAIL, cannot resolve `./pmSchedule.js`.
- [ ] **Step 3: Implement** the Produces block above, and the `projects.ts` and `model.ts` lines.
- [ ] **Step 4: Run them to verify they pass**
  Run: `cd backend && npm test -- src/superTabs/pmSchedule.test.ts src/superTabs/digest.test.ts && npx tsc --noEmit -p .`
  Expected: PASS, tsc clean.
- [ ] **Step 5: Commit** `git add backend/src/superTabs/pmSchedule.ts backend/src/superTabs/pmSchedule.test.ts backend/src/superTabs/projects.ts backend/src/superTabs/model.ts backend/src/superTabs/digest.ts && git commit -m "Swarm: the built-in PM schedule's text, slot clock and wake"`

### Task 2: The coordinator's poll writes the wake

**Files:**
- Modify: `backend/src/superTabs/store.ts` (`fullDeliveries`, after the notice digest block, before the morning digest)
- Modify: `backend/integration/noDefaultDigest.test-support.ts` (the schedule is off unless a test calls `wantSchedule()`)
- Create: `backend/integration/superTabPmSchedule.test.ts`
- Modify: `backend/vitest.super-tabs.config.ts` and `backend/vitest.super-tabs.ci.config.ts` (add the new file wherever
  `integration/superTabNoticeDigest.test.ts` is listed)

**Interfaces:**
- Consumes: Task 1's `scheduleRequest`, `scheduleText`, `scheduleMessageId`.
- Produces: `export const wantSchedule = (): void` in noDefaultDigest.test-support.ts, mocking `pmSchedule.js`'s
  `scheduleRequest` to return null unless called, reset `beforeEach`, as `wantDefaultDigest` does for the digest.

In `fullDeliveries`: call `scheduleRequest(state, target, this.now())` when `led`. When it returns a slot, set
`project.schedule = { lastSlot: slot }` on the cloned state (saved by the poll's single `this.save`). When it has a draft,
read the last wake's open delivery: `tx.superTabDelivery.findFirst({ where: { tabId, agentId, messageId:
scheduleMessageId(tabId, project.id, previousLastSlot), status: { in: ['queued', 'claimed', 'uncertain'] } } })`, skipped
when there was no previous slot. With none open: append `\n\n` + the draft's text to the update request when this poll
pushed one and it is not already stored (the existing `merged` check), else to the notice digest message this poll
pushed, else push the draft. Merged rows keep their `source` and gain `schedule: slot`. Log `[swarm-deliveries]
schedule request` with `{ tabId, slot, placed: 'update' | 'digest' | 'own' | 'skipped-open' }` after commit (none when nothing is due).

- [ ] **Step 1: Write the failing integration tests** in `superTabPmSchedule.test.ts`, with the swarm setup copied from
  superTabNoticeDigest.test.ts and `wantSchedule()` in each test:
  - `wakes once per slot`: an unassigned task; the coordinator's poll returns one delivery whose message has
    `source.kind === 'schedule-request'`; a second poll in the same slot returns none new.
  - `no wake when nothing is due`: the only task is working with fresh progress → no `schedule-request` message, and
    the project's `schedule.lastSlot` is the current slot.
  - `one unread wake at a time`: leave the first wake unclaimed, move the clock one slot, poll → no second
    `schedule-request`; `lastSlot` moved.
  - `merged into the update request`: a change that makes this poll write an update request → one message, its text
    containing `Built-in schedule,`, no separate `schedule-request` message.
  - `merged into the notice digest`: a gathered notice due in the same poll, no update request → the digest's message
    text contains `Built-in schedule,`.
  - `paused then resumed`: pause, advance three slots, poll → no wake; resume, poll → exactly one wake.
  - `new coordinator`: the wake to coordinator A is open; switch the project's lead to agent B; B's poll → one wake to B.
  - `stored update request`: an update request already written by an earlier poll and re-pushed by this poll → the wake
    is not in it.
- [ ] **Step 2: Run to verify they fail**
  Run: `cd backend && npx vitest run --config vitest.super-tabs.config.ts integration/superTabPmSchedule.test.ts`
  Expected: FAIL, no `schedule-request` message (and `wantSchedule` not exported).
- [ ] **Step 3: Implement** the store change and `wantSchedule()`.
- [ ] **Step 4: Run to verify they pass, with the suites that count coordinator messages**
  Run: `cd backend && npx vitest run --config vitest.super-tabs.config.ts integration/superTabPmSchedule.test.ts integration/superTabNoticeDigest.test.ts integration/superTabDigestHour.test.ts integration/superTabLiveness.test.ts integration/superTabs.test.ts`
  Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "Swarm: the coordinator's poll wakes it for the built-in schedule, in one message per poll"` (add the new test file first).

### Task 3: The coordinator's instructions read, roster and save guard

**Files:**
- Modify: `backend/src/superTabs/store.ts` `instructions()` (≈ line 2302): add `builtIn: PM_SCHEDULE_TEXT` to the answer
  when the actor is an agent and `ledProject(state, actor.agentId)?.id === projectId`; absent otherwise.
- Modify: `backend/src/superTabs/read/hostRows.ts` (the `instructions` row ≈ line 87): add
  `builtInHash: ledProject(state, target.id)?.id === home.id ? instructionsHash(PM_SCHEDULE_TEXT) : null`.
- Modify: `backend/src/superTabs/commands.ts` `case 'instructions.save'` (≈ line 1706): before the revision check,
  `fail('INSTRUCTIONS_BUILT_IN', 'Remove the "Built-in PM schedule" section: the Swarm adds it to every read, so it is never saved in the document.', 400)`
  when a line of `command.text` equals `BUILT_IN_HEADING` (trimmed).
- Test: `backend/integration/superTabInstructions.test.ts`

- [ ] **Step 1: Write the failing tests** in superTabInstructions.test.ts:
  - `the coordinator's read carries the built-in schedule`: read as the coordinator → `builtIn === PM_SCHEDULE_TEXT`;
    as a worker, and as a person → `builtIn` undefined; `text` and `hash` equal those of a read before this change.
  - `the roster names the built-in hash for the coordinator only`: the coordinator's host row has
    `instructions.builtInHash === instructionsHash(PM_SCHEDULE_TEXT)`; a worker's row has `null` (read the rows as the
    file already does, or through `poolRows` from hostRows.test-support.ts).
  - `a save holding the built-in section is refused`: `instructions.save` with `text` = the document +
    `\n\n${PM_SCHEDULE_TEXT}` fails with code `INSTRUCTIONS_BUILT_IN`, and the revision does not move; a save after an
    ordinary read (its `text`) succeeds.
- [ ] **Step 2: Run to verify they fail**
  Run: `cd backend && npx vitest run --config vitest.super-tabs.config.ts integration/superTabInstructions.test.ts`
  Expected: FAIL on `builtIn` undefined.
- [ ] **Step 3: Implement** the three changes.
- [ ] **Step 4: Run to verify they pass**
  Run: `cd backend && npx vitest run --config vitest.super-tabs.config.ts integration/superTabInstructions.test.ts integration/superTabHostGroups.test.ts && npm test -- src/superTabs && npx tsc --noEmit -p .`
  Expected: PASS, tsc clean.
- [ ] **Step 5: Commit** `git commit -am "Swarm: the coordinator reads the built-in PM schedule beside its instructions, and no save stores it"`

### Task 4: The CLI appends the built-in schedule for the coordinator

**Files:**
- Modify: `cli/src/superTabs/host.ts`: `RowInstructions` gains `builtInHash?: string | null`; `instructionsKey` gains the
  agent id when `target.lead === true` (as for a Buddy); `refreshInstructions` rereads when `held.builtInHash !==
  (doc.builtInHash ?? null)` too, keeps `builtIn` (`typeof answer.builtIn === 'string' ? answer.builtIn : null`) in
  `held`, and passes it to `refreshProjectSkills`.
- Modify: `cli/src/lib/swarmInstructionsSkill.ts`: `ProjectDoc` gains `builtIn?: string | null`; `instructionsSkillText`
  appends `\n\n${doc.builtIn}` after the document when `doc.coordinator && doc.builtIn`.
- Modify: `cli/src/superTabs/command.ts` (`action === 'instructions'`, ≈ line 401): print `value.builtIn` after
  `value.text` and before the notes when it is a non-empty string.
- Test: `cli/src/lib/swarmInstructionsSkill.spec.ts`, `cli/src/superTabs/host.spec.ts`, `cli/src/superTabs/routeCommand.spec.ts`

- [ ] **Step 1: Write the failing tests**
  - swarmInstructionsSkill.spec.ts `appends the built-in schedule for the coordinator only`: with `builtIn: '## Built-in
    PM schedule (from the Swarm)\n\nX'`, the coordinator's text ends with it after the document; a worker's text does
    not contain it.
  - swarmInstructionsSkill.spec.ts `a changed built-in schedule owes one notice`: install, record the notice, refresh
    with a different `builtIn` → `owed === true`; refresh again unchanged → `owed === false` after the notice is recorded.
  - swarmInstructionsSkill.spec.ts `a launch that printed it owes nothing extra`: first install after a launch record,
    revision saved before the launch, with `builtIn` → `owed === false`.
  - host.spec.ts `rereads when the built-in hash moves`: roster with `builtInHash: 'a'`, then `'b'` at the same revision
    and hash → two instructions reads.
  - host.spec.ts `caches the coordinator's read apart from a worker's`: a worker and the coordinator of one project on
    one host → two reads, and only the coordinator's skill file contains the heading.
  - routeCommand.spec.ts `prints the built-in schedule after the document`: answer with `builtIn: 'B'` → output has
    `Work by this.` then `B` then the notes.
- [ ] **Step 2: Run to verify they fail**
  Run: `cd cli && npx vitest run src/lib/swarmInstructionsSkill.spec.ts src/superTabs/host.spec.ts src/superTabs/routeCommand.spec.ts`
  Expected: FAIL on the new tests only.
- [ ] **Step 3: Implement** the three changes.
- [ ] **Step 4: Run to verify they pass**
  Run: `cd cli && npx vitest run src/lib/swarmInstructionsSkill.spec.ts src/superTabs/host.spec.ts src/superTabs/routeCommand.spec.ts src/superTabs/serviceReads.spec.ts && npm run typecheck`
  Expected: PASS, typecheck clean. Then `npm run test:harnessd` (a CLI coverage gate PR CI does not run).
- [ ] **Step 5: Commit** `git commit -am "CLI: the coordinator's instructions skill and command append the built-in PM schedule"`

### Task 5: After the release (no code)

- [ ] Ken's go for the backend and CLI release, in the 09:00–16:00 window, in River's batch.
- [ ] On prod read-only: River's Lead conversation has `schedule-request` messages, at most one per slot, merged where
  an update request or digest went in the same poll; idle projects log no `[swarm-deliveries] schedule request` line.
- [ ] With Ken's go, save the six projects' instructions and read each back. In physical-router, lampos, garage-pod,
  computer and spaceship the whole `## PM schedule` section added on 2026-11-04 goes: the built-in section carries all
  of it. In openharness the progress sync goes from the :07/:37 line (the batch pull request stays), the open-task sweep
  and its archive sentence go from the :22/:52 line (the worktree cleanup and the team pull request sweep stay), and the
  "Every hour" line goes.
