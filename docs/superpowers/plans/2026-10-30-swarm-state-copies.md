# Copy less Swarm state per request (DB roadmap 2.6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A machine report stops reading `SwarmProgress`, `visibleState` copies only what it returns, and the
remaining whole-state copies use a plain-data copy instead of `structuredClone`, with every reply and write unchanged.

**Architecture:** One new leaf module, `backend/src/superTabs/cloneData.ts`, copies plain data and throws on anything
else. `parts/load.ts loadObserved` passes `progress: null` to `assemble`, so a report loads and commits no progress part.
`model.ts visibleState` removes the five pruned fields and dormant conversations before copying, and leaves every
other step in its current order. An old copy of `visibleState` in the test file is the reference: the new output must
match it for every kind of reader.

**Tech Stack:** TypeScript, Prisma on MongoDB, vitest, mongodb-memory-server (integration).

**Spec:** `docs/superpowers/specs/2026-10-30-swarm-state-copies-design.md`. Its decisions are final, including no
copy-on-write.

## Global Constraints

- Branch `perf/swarm-state-copies`, based on `main` 17056adb6. Before Task 1, run `git fetch origin main`. If `main`
  has moved, rebase onto it.
- Fresh worktree: run `npm ci` and `npx prisma generate` once in `backend/` before the first test.
- All commands run from `backend/`.
  - Unit: `npx vitest run <file>`. If a test needs the credential key, use `npm test -- <file>` instead, which sets it.
  - Integration: `npx vitest run --config vitest.super-tabs.config.ts <file>`.
  - Types: `npm run typecheck`.
- Some tests already fail on `main`. Before calling a failure a regression, run the same file on a clean worktree at
  `origin/main` and compare the failing test names.
- Kill only processes you started. Never `pkill` mongod or vitest by pattern: other sessions share this Mac.
- Don't commit or push until Ken asks. Each task ends with a checkpoint (`git status --short`), not a commit.
- Remove dead code, including the deletes in `visibleState` that the pruned copy makes redundant.
- Every reply, every stored write and every message stays byte for byte the same.
- Spec 1 (`perf/swarm-changes-shared-light-read`) is independent and changes other files. Don't touch its files.
- The spec's line numbers are from 2bbcad4c4 and have moved. This plan names methods instead of lines.

## Review Focus

1. **Frozen shared input.** The read cache gives `visibleState` deep-frozen state that other requests share
   (`cache.ts freeze`). The new code must never write to its input, and its copy must be writable. Covered by
   Task 1 (a copy of frozen data can be changed) and Task 3 (`visibleState` on a frozen state matches the reference).
2. **Key order in replies.** Deep equality ignores key order, but JSON bytes, and any ETag computed from them, do
   not. The pruned copy must keep `conversations` in its original key position. Covered by Task 3, which also compares
   `JSON.stringify` output for each reader.
3. **A report that writes while progress is not loaded.** When a report loses a task, it writes group, agent and
   message parts. It must not remove or rewrite the progress part, which it never loaded. Covered by Task 2's second
   report.
4. **Non-plain values at runtime.** If a state ever holds a `Date`, `Buffer` or `Map`, `cloneData` fails the request
   where `structuredClone` would not. Dates are supported. Task 4 runs the full Super Tab integration suite on real
   Mongo data to cover every replaced path.
5. **Shared references.** `structuredClone` keeps two references to one object as one object. `cloneData` makes two
   separate copies. A loaded state shares no objects (`reassemble` builds each record once). Task 1 checks that no
   object is reached twice in the fixture states and in a reassembled state.

---

### Task 1: `cloneData`

**Files:**
- Create: `backend/src/superTabs/cloneData.ts`
- Test: `backend/src/superTabs/cloneData.test.ts`

**Interfaces:**
- Produces: `export function cloneData<T>(value: T): T` in `backend/src/superTabs/cloneData.ts`. The module has no
  imports, so model, commands, native and store can all import it without a cycle.

- [ ] **Step 1: Write the failing tests** in `cloneData.test.ts`:

  Test-only helpers:
  - `reachedOnce(value)`: walks the value and fails if it reaches any object twice.
  - `sharesNothing(source, copy)`: walks both side by side and fails if any object in the copy is `===` to the one at
    the same path in the source.

  States under test, built with `swarm`, `richSwarm` and `NOW` from `read/fixture.test-support.ts`:
  - `richSwarm().state`.
  - A Swarm at the bench's default size: `swarm()`, plus a Lead, 200 groups made with `s.group`, and 20 workers, each
    assigned one group with `work.assign`.
  - `reassemble(split(richSwarm().state, { tabId: 'tab', version: 1, now: NOW }), { share: true })`, which is how a
    loaded state is built.

  Tests:
  - `it('copies every fixture state as structuredClone does, sharing nothing')`: for each state,
    - `reachedOnce(state)`;
    - `expect(cloneData(state)).toStrictEqual(structuredClone(state))`;
    - `sharesNothing(state, cloneData(state))`.
  - `it('keeps undefined values and copies a Date as a new Date')`: the input is
    `{ a: undefined, at: new Date(NOW), list: [1, 'x', null, true] }`.
    - `toStrictEqual` the input;
    - `'a' in copy` is true;
    - `copy.at instanceof Date`, `copy.at !== input.at`, and `copy.at.getTime() === NOW`.
  - `it('returns a writable copy of frozen data')`: call `freeze` (from `cache.js`) on
    `structuredClone(richSwarm().state)`. Then:
    - `Object.isFrozen(copy)` is false, and so is `Object.isFrozen(copy.conversations[0])`;
    - `copy.conversations[0].title = 'changed'` doesn't throw.
  - `it('throws on values it cannot copy, naming where they are')`. Each case uses its own expectation:

    | Input | Expected error |
    |---|---|
    | `{ agents: [{ extra: new Map() }] }` | `toThrow(/cannot copy a Map at agents\.0\.extra/)` |
    | `{ s: new Set() }` | `toThrow(/cannot copy a Set at s/)` |
    | `{ c: new (class Thing {})() }` | `toThrow(/cannot copy a Thing at c/)` |
    | `{ f: () => 1 }` | `toThrow(/cannot copy a function at f/)` |

- [ ] **Step 2: Run the tests and see them fail.** Run `npx vitest run src/superTabs/cloneData.test.ts`. Expected: it
  fails because `./cloneData.js` cannot be resolved.

- [ ] **Step 3: Implement `cloneData<T>(value: T): T`.**
  - Primitives (including `undefined`, `null` and `bigint`) are returned as they are.
  - A `Date` becomes `new Date(value.getTime())`.
  - An array becomes `value.map(cloneData)`.
  - An object whose prototype is `Object.prototype` or `null` becomes an ordinary object. Copy its own enumerable keys
    in order, including keys whose value is `undefined`.
  - Anything else throws `TypeError('cloneData: cannot copy a <kind> at <path>')`. `<kind>` is the constructor's name,
    or `typeof` for functions and symbols. `<path>` is the dot-joined keys and indexes from the root, or `(root)`.
  - Build the path only while the error unwinds. Don't carry it through every call: this function runs on about 650 KB
    of state per command.
  - Add a two-line doc comment: plain data only, and why it throws.

- [ ] **Step 4: Run the tests and see them pass.** Run `npx vitest run src/superTabs/cloneData.test.ts`. Expected: 4
  tests pass.

- [ ] **Step 5: Checkpoint.** `git status --short` lists only the two new files.

### Task 2: Machine reports do not load progress

**Files:**
- Modify: `backend/src/superTabs/parts/load.ts` (`loadObserved`, and its doc comment)
- Create: `backend/integration/profiledReads.test-support.ts`
- Modify: `backend/integration/superTabCache.test.ts` (`partReads` uses the shared helper)
- Test: `backend/integration/superTabLiveness.test.ts`

**Interfaces:**
- Produces: `export async function profiledReads<T>(db: PrismaClient, collections: RegExp, run: () => Promise<T>):
  Promise<{ value: T; reads: number }>`. Move the body of `superTabCache.test.ts partReads` into it unchanged, with
  `collections` in place of the fixed `ns` regex. In `superTabCache.test.ts`, `partReads(run)` becomes
  `profiledReads(db, /\.Swarm(Head|Member|Agent|Group|Machine|Start|Progress)$/, run)`. Keep the `partReads` name
  there as a one-line wrapper so its call sites don't change.

- [ ] **Step 1: Write the failing test** in `superTabLiveness.test.ts`, in a new
  `describe('machine reports and report progress')`. Use the file's `swarm()` helper.
  - `it('reads no report progress and leaves its part as it was, also when the report loses a task')`:
    1. Post a message in the workgroup:
       `f.execute({ type: 'message.send', conversationId: f.group, text: 'Parser done', replyTo: null, recipientIds: [] })`.
    2. Read the stored part: `before = await db.swarmProgress.findFirst({ where: { tabId: f.tab, deleted: false } })`.
       `expect(before).not.toBeNull()`. This guards the precondition: the command must have written a progress part.
    3. Run a quiet report, `f.observe('test-host', [f.harness.worker])`. This is the tab's first report, so it also
       runs the liveness sweep.
    4. Move the clock `f.clock.now += 2 * MINUTE + 5_000` and report `f.observe('lead-host', [f.harness.lead])`. This
       loses the worker's task and writes parts.
    5. Wrap steps 3 and 4, and nothing else, in `profiledReads(db, /\.SwarmProgress$/, …)`. Expect `reads` to be `0`.
    6. Outside the profiled block, because a read loads progress, check that `(await f.assignment()).status` is
       `'lost'`.
    7. Read the part again as `after`. Expect `after!.version`, `after!.data` and `after!.changedAt` to equal
       `before!`'s.

- [ ] **Step 2: Run the test and see it fail.** Run
  `npx vitest run --config vitest.super-tabs.config.ts integration/superTabLiveness.test.ts -t "report progress"`.
  Expected: it fails on `reads` (≥ 1, from `loadObserved`'s `SwarmProgress.findMany`).

- [ ] **Step 3: Implement.** In `loadObserved`, pass `progress: null` to `assemble` instead of `progress: live`. Add
  one sentence to its doc comment: a report never reads project progress (only commands and native events note
  reports), so none is loaded and none is committed.

- [ ] **Step 4: Run the tests and see them pass.** Run
  `npx vitest run --config vitest.super-tabs.config.ts integration/superTabLiveness.test.ts integration/superTabCache.test.ts`.
  Expected: the new test passes. Any other failure also appears on clean `main`.

- [ ] **Step 5: Checkpoint.** `git status --short` adds only this task's four files.

### Task 3: `visibleState` copies a pruned state

**Files:**
- Modify: `backend/src/superTabs/model.ts` (`visibleState`)
- Modify: `backend/src/superTabs/read/fixture.test-support.ts` (new `fullSwarm`)
- Modify: `backend/src/superTabs/cloneData.test.ts` (add `fullSwarm` states)
- Create: `backend/src/superTabs/visibleState.test.ts`

**Interfaces:**
- Consumes: `cloneData` (Task 1).
- Produces: `export function fullSwarm(now = NOW)` in `fixture.test-support.ts`. It returns everything `richSwarm`
  returns, plus `buddy` (the Buddy agent's id) and `buddyChat` (its chat's id). `state` stays a live getter.

- [ ] **Step 1: Add `fullSwarm`.** It is `richSwarm(now)` plus the following. Values that aren't pinned are free.
  - **Private project member:** run `{ type: 'project.sharing', projectId: s.secret, visibility: 'private', memberIds: [peer.userId] }`.
    Now `peer` is a member of Secret and `outsider` is a member outside it.
  - **Machine:** run `s.contribute('host')`. With `s.edit`, give its pool an `observation`:
    - shaped like `teamRouting.test.ts`'s machine builder, with `receivedAt: now`;
    - `runningHarnessIds: ['worker-harness', 'gone-harness']`;
    - `harnessTokens` for both harnesses;
    - `privacy: { mode: 'account', passed: false, item: 'disk-encryption', detail: '/Users/owner/secret', checkedAt: now, seenAt: now }`.
  - **Buddy:** with `s.edit`, add a Buddy agent for `peer` in the Swarm's first project, built the way
    `buddies.test.ts setup()` does it:
    - `buddyOf: { personId: peer.userId, generation: <peer's generation in state.people> }`;
    - `machineOwnerId: \`${owner.userId}-machine\``.

    Also add its `kind: 'buddy'` chat, with `audience` set to peer.
  - **Dormant:** set the `s.done` conversation to `archived: true, dormant: true`.
  - **Progress:** give both projects
    `progress: { since: now, summarizedFloor: 0, summarized: {}, requestedFloor: 0, requested: {} }`.
  - **The five pruned fields:**
    - `sharing: { revision: 1, generation: 'sharing-1', access: { mode: 'invited', role: 'collaborator' } }`
    - `harnessReservations: [{ machineId: 'host', harnessId: 'worker-harness', generation: 'g1', renewed: false }]`
    - `releasedHarnesses: [{ machineId: 'host', harnessId: 'old-harness' }]`
    - `overlapAlerts: ['a:b']`
    - `closingSessions: [{ agentId: 'removed-agent', machineId: 'host', harnessId: 'old-harness', machineOwnerId: \`${owner.userId}-machine\` }]`

- [ ] **Step 2: Write the tests** in `visibleState.test.ts`.
  - **Reference.** Copy today's `visibleState` body verbatim, `structuredClone` included, as
    `visibleStateBefore(state, actor, now)`. Import its helpers from their modules; all of them are exported. Header
    comment: "visibleState before DB roadmap 2.6: the reference for the reader test below. Delete once that PR has
    merged."
  - **Readers.** Use the fixture's `owner`, `peer` and `outsider`. Also:
    - `stranger = { kind: 'person', userId: '100000000000000000000009', email: 'stranger@example.com' }`;
    - the Buddy, worker and Lead as agent actors, each with `machineOwnerId: \`${owner.userId}-machine\``.
  - `it('exercises what it compares')`: guards that the fixture covers each case.
    - Before reading, the input state has all five pruned fields and a dormant conversation.
    - `visibleStateBefore` for `owner` returns a project with `progress`.
    - It returns the Secret project for `peer` but not for `outsider`.
    - For the Buddy, it returns `machines` as `[]`.
  - `it.each(readers)('reads the same as before for %s')`: for each named reader, check both
    - `expect(visibleState(s.state, actor, NOW)).toStrictEqual(visibleStateBefore(s.state, actor, NOW))`;
    - `expect(JSON.stringify(visibleState(…))).toBe(JSON.stringify(visibleStateBefore(…)))`.

    For `stranger`, both functions throw an error with the same `code`.
  - `it('reads a frozen, shared state as before and leaves it untouched')`: deep-copy `fullSwarm().state` with
    `structuredClone`, then `freeze` it from `cache.js`. For `owner` and the worker, the output matches
    `visibleStateBefore` on an unfrozen copy.
  - `it('fails loudly on a value it cannot copy')`:
    `visibleState({ ...s.state, stray: new Map() } as never, owner, NOW)` throws `/cannot copy a Map at stray/`.

- [ ] **Step 3: Run the tests.** Run `npx vitest run src/superTabs/visibleState.test.ts`. Expected: every reader test
  passes, because the old body is still in place. Only `fails loudly…` fails, because `structuredClone` copies a
  `Map`.

- [ ] **Step 4: Implement.** At the top of `visibleState`, right after `author(state, actor)`:
  1. Destructure the five pruned fields out of `state` with `_`-prefixed names, as `parts/shape.ts split` does with
     `progress`.
  2. Set `visible = cloneData({ ...kept, conversations: state.conversations.filter(c => !c.dormant) })`. Because
     `conversations` is already a key of `kept`, it keeps its key position.
  3. Delete the later `visible.conversations = visible.conversations.filter(c => !c.dormant)` line and the five
     `delete visible.<field>` lines. Move their comments, including the `closingSessions` one, onto the prune.

  Leave every other line and its order unchanged, including `projects[].progress`.

- [ ] **Step 5: Add `fullSwarm().state` to `cloneData.test.ts`'s fixture states.** Also add its reassembled form.

- [ ] **Step 6: Run the tests and see them pass.** Run
  `npx vitest run src/superTabs/visibleState.test.ts src/superTabs/cloneData.test.ts src/superTabs/read src/superTabs/buddies.test.ts src/superTabs/profile.test.ts src/superTabs/terminal.test.ts`.
  Expected: all pass. Any other failure also appears on clean `main`.

- [ ] **Step 7: Checkpoint.** `git status --short` adds only this task's files.

### Task 4: `cloneData` for the remaining whole-state copies

**Files:**
- Modify: `backend/src/superTabs/commands.ts` (`applyCommand`)
- Modify: `backend/src/superTabs/native.ts` (`append`)
- Modify: `backend/src/superTabs/store.ts`. The methods are `setWorkspaceVisibility`, `workspaceJoin`, `saveSharing`,
  `join`, `observeMachine`, `fullDeliveries`, `postReflection`, `archiveFinished` and `stopped`. `stopped` has two
  copies: `state`, and `before.conversations`.
- Test: `backend/src/superTabs/commands.test.ts`

**Interfaces:**
- Consumes: `cloneData` (Task 1).

- [ ] **Step 1: Write the failing test** in `commands.test.ts`:
  - `it('fails loudly on a state value it cannot copy')`: `applyCommand({ ...richSwarm().state, stray: new Map() } as never, owner, { type: 'message.send', conversationId: 'lead', text: 'hi', replyTo: null, recipientIds: [] }, { now: NOW, operationId: 'op' })`.
    Use `owner`, `richSwarm` and `NOW` from `read/fixture.test-support.ts`.
  - Expected: throws `/cannot copy a Map at stray/`.

- [ ] **Step 2: Run it and see it fail.** Run `npx vitest run src/superTabs/commands.test.ts -t "cannot copy"`.
  Expected: FAIL, because nothing throws.

- [ ] **Step 3: Implement.** Replace `structuredClone` with `cloneData` in the methods listed above.

  Keep `structuredClone` on single values:
  - `commands.ts`: the command copy, `previousAttempts` and `configuration`;
  - `autoReview.ts`: `configuration`.

  Don't touch `parts/shape.ts` or `migration/`: those are migration and rollback paths, outside the spec.

- [ ] **Step 4: Verify that no whole-state copy is left.** Run
  `grep -n "structuredClone(\(original\|loaded.state\|state.conversations\|state\))" src/superTabs/*.ts`.
  Expected: no output.

- [ ] **Step 5: Run the tests and see them pass.** Run these together:
  - `npm run typecheck`;
  - `npx vitest run src/superTabs`;
  - `npx vitest run --config vitest.super-tabs.config.ts`, the full Super Tab integration suite. The replaced copies
    sit on every write path.

  Expected: typecheck is clean. Each failing test also fails, by the same name, on clean `main`.

- [ ] **Step 6: Checkpoint.** `git status --short` adds only `commands.ts`, `native.ts`, `store.ts` and
  `commands.test.ts`.

### Task 5: Report

- [ ] **Step 1:** Write the report for Ken with:
  - the plan's path;
  - each test command run, with its pass/fail counts, and which failures also fail on clean `main`;
  - `git diff --stat` and a one-line summary per file;
  - the spec corrections below.

  Then wait for Ken before committing or pushing.

## Spec corrections found while planning

- Line numbers have moved since 2bbcad4c4. `noteProjectReports` is now called at `store.ts:1382`, not 1347.
  `observeMachine`'s copy is at `store.ts:2342`. The other store copies are at 886, 902, 949, 983, 2596, 2822, 2883,
  2937 and 2938. This plan names methods instead of lines.
- The spec's "a bench Swarm" for the `cloneData` test can't run in a unit test: the bench starts its own Mongo replica
  set and seeds through the store. Task 1 builds a Swarm of the bench's default size (200 groups, 20 workers) from the
  read fixture instead.
- The spec's per-reader test asks for deep equality. This plan also compares JSON bytes, because deep equality ignores
  key order and replies are serialized (Review Focus 2).
