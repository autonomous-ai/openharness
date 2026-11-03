# A Swarm message that cannot be delivered says so: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Swarm delivery keeps failing to be claimed, three things change:

- the sender sees **Not delivered yet**;
- prod watch gets a `claims failing` alarm line;
- the host's log names the claim.

**Architecture:** The backend records each `SWARM_BUSY` claim failure on its `SuperTabDelivery` row, with standalone
writes outside the failed transaction. A successful claim clears the record. The delivery settle pass logs an alarm
for Swarms whose queued deliveries keep failing, and cancels none of them. Page reads carry `claimFailingSince` and
`claimFailures`. The Flutter receipt (Desktop and web) turns those fields, or a queued message's age, into an amber line.
The CLI host replaces its bare busy line with a named, rate-limited one.

**Tech Stack:**
- Backend: TypeScript, Fastify, Prisma on MongoDB, vitest with mongodb-memory-server.
- Desktop: Flutter/Dart, flutter_test, package:clock.
- CLI: TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-10-30-swarm-stuck-delivery-visible-design.md`

## Global Constraints

- Work only in the worktree `.claude/worktrees/stuckdelivery` (branch `feat/stuck-delivery-visible`). Never touch the
  main checkout.
- Commit only when Diego asks. The commit steps below are prepared commands: run them only once asked. Stage only this
  plan's files.
- The fresh worktree has no `node_modules`. Run `npm ci` once in `backend/` and in `cli/` before the first test.
  Run `npx prisma generate` in `backend/` after the schema change.
- Backend integration test command prefix (`B`):
  `cd backend && NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= npx vitest run --config vitest.super-tabs.config.ts integration/superTabTidy.test.ts`
- No message text, agent names or person ids in any new log line.
- The client's answer to a failed claim does not change: still 503 `SWARM_BUSY`.
- Thresholds, copied from the spec:
  - Desktop: claim failing for **60 s** (`superTabClaimFailingNotice`); queued for **2 min** (`superTabQueuedNotice`).
  - Backend alarm: `CLAIM_FAILING_ALARM_MS` = **5 min**.
  - CLI: logs at most once every **5 min** per delivery (`CLAIM_FAILURE_LOG_MS`).
- Copy, exact text:
  - title `Not delivered yet`;
  - note `$host is online but couldn't take this message yet. Harness keeps trying, and it goes in as soon as it can.`;
  - note `$host is online but hasn't picked this message up yet. Harness keeps trying, and it goes in as soon as it can.`
- Comments say why, naming the incident ("prod 10-30, v1.3.71"), in the surrounding files' density.

## Review Focus

1. A claim failing on a delivery that is no longer `queued` (revoked or cancelled while in flight) must write nothing.
   The record's filter includes `status: 'queued'`. Test in Task 1.
2. A failing `ack` or `hold` records nothing. Only claims do. Test in Task 1.
3. A delivery that left `queued` but still carries leftover fields shows no line in the receipt. Test in Task 3.
4. The alarm pass must keep settling the other Swarms when one Swarm's alarm count throws, and must cancel no failing
   row. Test in Task 2.
5. The receipt's own clock makes the line appear without a new snapshot, using `clock.now` so tests can drive it.
   Test in Task 3.

---

### Task 1: Backend records a failed claim on its delivery, and page reads carry it

**Files:**
- Modify: `backend/prisma/schema.prisma` (model `SuperTabDelivery`, ~line 1249)
- Modify: `backend/src/superTabs/store.ts` (`delivery()`, ~line 2606)
- Modify: `backend/src/superTabs/pageReads.ts` (`PageDelivery`, `pageDeliveries`, ~lines 21-34)
- Test: `backend/integration/superTabTidy.test.ts`. Add a `describe('a claim that keeps failing', …)` nested inside
  `describe('a delivery that cannot move', …)`, so it reuses `toLead`, `status` and `HOUR`.

**Interfaces:**
- Produces these fields on `SuperTabDelivery`, all optional: `claimFailingSince DateTime?`, `claimFailedAt DateTime?`,
  `claimFailures Int?`, `claimFailure String?`.
- Produces `PageDelivery` with `claimFailingSince: Date | null` and `claimFailures: number | null`.
- Produces `private async recordFailedClaim(tabId: string, agentId: string, deliveryId: string, code: string): Promise<void>`
  on `SuperTabStore`.

- [ ] **Step 1: Write the failing tests**

All of them use one helper inside the new describe. `failingStore(f)` returns
`new SuperTabStore(proxy, () => f.clock.now)`, where `proxy` is a `Proxy` over `db`:

- its `$transaction` throws `new SuperTabError('SWARM_BUSY', 'This Swarm is busy. Try again in a moment.', 503)` while
  `busy.on` is true;
- every other property passes through to `db`.

Import `SuperTabError` from `../src/superTabs/model.js`.

```ts
it('records a busy claim on its delivery, keeps when it began and counts each one', async () => {
  const f = await swarm(); const id = await toLead(f, 'Hi')
  const flaky = failingStore(f)
  await expect(flaky.delivery(host, f.tab, f.lead, id, { type: 'claim', claimId: 'c' })).rejects.toMatchObject({ code: 'SWARM_BUSY' })
  const first = f.clock.now
  f.clock.now += 30_000
  await expect(flaky.delivery(host, f.tab, f.lead, id, { type: 'claim', claimId: 'c' })).rejects.toMatchObject({ code: 'SWARM_BUSY' })
  expect(await db.superTabDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'queued',
    claimFailingSince: new Date(first), claimFailedAt: new Date(first + 30_000), claimFailures: 2, claimFailure: 'SWARM_BUSY' })
})
it('clears the record once a claim gets in', async () => { /* fail once with flaky, then f.timed.delivery(... claim 'c') succeeds;
  the row has status 'claimed' and claimFailingSince, claimFailedAt, claimFailures, claimFailure all undefined (unset, not null) */ })
it('records nothing for a delivery that is no longer queued, or for an ack', async () => { /* (a) cancel the row with
  db.superTabDelivery.update({ status: 'cancelled' }), flaky claim rejects, no claim* fields; (b) a real claim, then a flaky ack
  rejects SWARM_BUSY, no claim* fields */ })
it('still throws the busy answer when the record itself cannot be written, and says so', async () => { /* proxy also makes
  superTabDelivery.updateMany throw new Error('down'); delivery() rejects with code SWARM_BUSY;
  vi.spyOn(logger, 'warn') was called with '[swarm-deliveries] could not record a failed claim', expect.objectContaining({ tabId: f.tab, deliveryId: id }) */ })
it('hands claimFailingSince and claimFailures to page readers', async () => { /* after one flaky failure, f.timed.read(owner, f.tab) page
  of 'lead' has the message's delivery with claimFailingSince equal to that time and claimFailures 1 (as the page serialises dates) */ })
```

For the last test, find how this file's other tests read a page's deliveries. If none does, use `pageDeliveries(tx, …)`
inside `db.$transaction`, imported from `../src/superTabs/pageReads.js`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `B -t "a claim that keeps failing"`
Expected: FAIL. TypeScript or Prisma reject the unknown `claimFailingSince` fields, or the assertions find them
undefined.

- [ ] **Step 3: Add the four optional fields to `SuperTabDelivery` in `schema.prisma`, then run `npx prisma generate`**

Put a one-line comment above them naming prod 10-30 and the settle pass alarm. Add no index.

- [ ] **Step 4: Implement recording and clearing in `store.ts`**

In `delivery()`:

1. Wrap the `return transaction(...)` in a `try`/`catch`. When `action.type === 'claim'` and the error is a
   `SuperTabError` with code `SWARM_BUSY`, `await this.recordFailedClaim(...)`. Then rethrow the original error.
2. In the successful claim's existing `tx.superTabDelivery.update`, add `{ unset: true }` for all four fields, only when
   `action.type === 'claim'`.

`recordFailedClaim` makes two writes. Both match `{ id: deliveryId, tabId, agentId, status: 'queued' }`:

1. `this.db.superTabDelivery.updateMany`, with `OR: [{ claimFailingSince: null }, { claimFailingSince: { isSet: false } }]`
   added to the filter, setting `claimFailingSince: new Date(this.now())`.
2. `this.db.superTabDelivery.updateMany` setting `claimFailedAt: new Date(this.now())` and `claimFailure: code`, with
   `claimFailures: { increment: 1 }`.

Catch any error from either write and log
`logger.warn('[swarm-deliveries] could not record a failed claim', { tabId, deliveryId, error })`. Never let it
replace the thrown error.

- [ ] **Step 5: Project the two fields in `pageReads.ts`**

Add `claimFailingSince` and `claimFailures` to the `PageDelivery` pick and to the `$project`. Map them as
`date(row.claimFailingSince)` and `(row.claimFailures ?? null) as number | null`.

Then find every place a page delivery is turned into JSON for clients, by grepping `pageDeliveries(` and `holdSince` in
`backend/src/superTabs`. Make sure the two fields reach the response the same way `holdSince` does. If a serialiser
lists fields explicitly, add them there.

- [ ] **Step 6: Run the tests and the typecheck**

Run: `B -t "a claim that keeps failing"`, then `cd backend && npm run typecheck`
Expected: 5 passed; tsc exits 0.

Then run the whole file, `B`. Expected: every test passes. The existing settle tests must be unchanged.

- [ ] **Step 7: Commit (only once Diego asks)**

```bash
git add backend/prisma/schema.prisma backend/src/superTabs/store.ts backend/src/superTabs/pageReads.ts backend/integration/superTabTidy.test.ts
git commit -m "fix(swarm): a claim that keeps failing is recorded on its delivery"
```

---

### Task 2: The settle pass logs `claims failing`

**Files:**
- Modify: `backend/src/superTabs/deliverySettle.ts`
- Test: `backend/integration/superTabTidy.test.ts`, in the same `describe('a claim that keeps failing', …)`

**Interfaces:**
- Consumes the Task 1 fields on the rows `openDeliveries` returns.
- Produces `export const CLAIM_FAILING_ALARM_MS = 5 * 60_000`.
- Produces `export function claimsFailing(delivery: Pick<SuperTabDelivery, 'status' | 'claimFailingSince' | 'claimFailedAt'>, now: number): boolean`.
  It is true when all of these hold: `status === 'queued'`, `now - claimFailingSince >= CLAIM_FAILING_ALARM_MS`, and
  `now - claimFailedAt <= CLAIM_FAILING_ALARM_MS`.

- [ ] **Step 1: Write the failing tests**

```ts
it('raises claims failing for a delivery whose claims have failed 5 minutes and still fail, and cancels nothing', async () => {
  const f = await swarm(); const id = await toLead(f, 'Hi'); const flaky = failingStore(f)
  const began = f.clock.now
  await expect(flaky.delivery(host, f.tab, f.lead, id, { type: 'claim', claimId: 'c' })).rejects.toThrow()
  f.clock.now = began + 5 * MINUTE
  await expect(flaky.delivery(host, f.tab, f.lead, id, { type: 'claim', claimId: 'c' })).rejects.toThrow()
  const warn = vi.spyOn(logger, 'warn')
  await settleStuckDeliveries(db, f.timed, began + 5 * MINUTE + 1_000)
  expect(warn).toHaveBeenCalledWith('[swarm-deliveries] claims failing',
    { tabId: f.tab, deliveries: 1, oldestFailingSince: new Date(began).toISOString(), codes: ['SWARM_BUSY'] })
  expect(await status(id)).toBe('queued')
  warn.mockRestore()
})
it('says nothing for a claim failing under 5 minutes, or one whose last failure is over 5 minutes old', async () => { /* two
  deliveries: one failing 4 min; one whose claimFailedAt is 6 min before the pass (set the fields directly with db.update).
  No 'claims failing' warn; both stay queued */ })
```

The pure `claimsFailing` boundaries also get a unit test, in a new `backend/src/superTabs/deliverySettle.test.ts`:

- true at exactly 5 min since and 5 min since the last failure;
- false at 4:59 since;
- false at a last failure 5:01 old;
- false for `claimed`;
- false with null fields.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `B -t "claims failing|says nothing for a claim"`, then
`cd backend && NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= npx vitest run src/superTabs/deliverySettle.test.ts`
Expected: FAIL. `claimsFailing` is not exported, and no warn is logged.

- [ ] **Step 3: Implement it in `deliverySettle.ts`**

1. Map `claimFailingSince` and `claimFailedAt` to Dates in `openDeliveries`, as `holdSince` is.
2. In `settleStuckDeliveries`, per Swarm, **after** its `store.settleDeliveries` try/catch, count
   `tabRows.filter(row => claimsFailing(row, now))`.
3. When the count is non-zero, log `logger.warn('[swarm-deliveries] claims failing', { tabId, deliveries,
   oldestFailingSince, codes })`. Here `oldestFailingSince` is the earliest `claimFailingSince` as ISO text, and `codes`
   is the sorted distinct `claimFailure` values.
4. The count and the log sit inside their own try/catch, which logs `[swarm-deliveries] could not count failing claims`,
   so one Swarm never stops the pass.

`stuck()` is unchanged.

A Swarm whose rows span two 500-row pages logs one line per page. Accept that, and say so in a comment. It is rare, and
prod watch counts lines per tab.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the two commands from Step 2, then `B`
Expected: all pass.

- [ ] **Step 5: Commit (only once Diego asks)**

```bash
git add backend/src/superTabs/deliverySettle.ts backend/src/superTabs/deliverySettle.test.ts backend/integration/superTabTidy.test.ts
git commit -m "feat(swarm): the delivery pass raises claims failing for prod watch"
```

---

### Task 3: Desktop and web show Not delivered yet

**Files:**
- Modify: `desktop/lib/super_tabs/model.dart` (`SuperTabDelivery`, ~line 851)
- Modify: `desktop/lib/super_tabs/message_receipt.dart` (`build`, `_clock`, the `now` default)
- Test: `desktop/test/super_tab_receipt_test.dart`

**Interfaces:**
- Consumes `claimFailingSince` (ISO string) and `claimFailures` (int) on a page delivery, from Task 1.
- Produces `SuperTabDelivery.claimFailingSince` (`DateTime?`) and `SuperTabDelivery.claimFailures` (`int?`).
- Produces `const superTabClaimFailingNotice = Duration(seconds: 60)` and `const superTabQueuedNotice = Duration(minutes: 2)`
  in `message_receipt.dart`.

- [ ] **Step 1: Write the failing tests**

Use `ReceiptFixture` as it is.

- Its default `createdAt` is 2 min old and its default status is `claimed`.
- For `queued`, pass `ReceiptFixture(tester, status: 'queued')`.
- To make the recipient stopped, set `downSince` on the fixture's agent in `prepare`.

Each new test ends with `await f.close()`.

```dart
testWidgets('receipt: a queued message whose claims fail for a minute reads Not delivered yet', (tester) async {
  final f = ReceiptFixture(tester, status: 'queued');
  await f.show(prepare: () => f.delivery['claimFailingSince'] = f.now.subtract(const Duration(seconds: 61)).toIso8601String());
  expect(find.text('Not delivered yet'), findsOneWidget);
  expect(find.text("Team Mac is online but couldn't take this message yet. Harness keeps trying, and it goes in as soon as it can."), findsOneWidget);
  expect(find.text('Send again'), findsNothing);
  await f.close();
});
```

Then these tests, each with its own assertions:

- **`receipt: a queued message no computer picked up for 2 minutes reads Not delivered yet`**
  - No claim fields. `createdAt` is 2 min 1 s old.
  - Expect the title and the "hasn't picked this message up yet" note.
- **`receipt: offline still wins over Not delivered yet`**
  - Claim failing, and the machine's `receivedAt` is 3 min old.
  - Expect `"Lead's computer is offline"`, and no `Not delivered yet`.
- **`receipt: a stopped recipient shows neither case`**
  - The agent has `downSince` set, the delivery has no claim fields, and the message is 3 min old.
  - Expect `find.text('Not delivered yet')` to find nothing.
- **`receipt: a claimed message with leftover claim fields stays quiet`**
  - Status `claimed`, with `claimFailingSince` 5 min old.
  - Expect `f.expectQuiet()`.
- **`receipt: below both thresholds nothing shows, and the line comes by the receipt's own clock`**
  - Status `queued`, `createdAt` = `clock.now()` minus 1 min 58 s, no claim fields.
  - Expect nothing.
  - Then `await tester.pump(const Duration(seconds: 3))`, with no refresh.
  - Expect `Not delivered yet`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd desktop && flutter test test/super_tab_receipt_test.dart`
Expected: the six new tests FAIL, because no `Not delivered yet` is found. Every existing test passes.

- [ ] **Step 3: Read the fields in `model.dart`**

`claimFailingSince = _date(row['claimFailingSince'])` and `claimFailures = (row['claimFailures'] as num?)?.toInt()`.
Keep the class comment true: these are optional, and an older backend has neither.

- [ ] **Step 4: Add the branch, the clock and the constants in `message_receipt.dart`**

- **Default clock.** Change the widget's default `now` from `DateTime.now` to `clock.now` (`package:clock/clock.dart`, as
  `controller.dart` uses). flutter_test fakes that clock, so a pump moves it.
- **Branch placement.** Place the new branch after the `pending == true && offline` branch and before `fresh`.
- **Condition.** It holds when all of these are true:
  - `delivery?.status == 'queued'`
  - `!offline`
  - `!c.backendUnreachable`
  - either `claimFailingSince` is at least `superTabClaimFailingNotice` before `now` (the "couldn't take" note), or
    `claimFailingSince == null`, `message.createdAt` is at least `superTabQueuedNotice` before `now`, and
    `agent?.downSince == null` (the "hasn't picked" note)
- **Look.** `color = grid.AppPalette.warn`, `icon = AppIcons.clock`, `title = 'Not delivered yet'`, `note` = the copy,
  with `$host` worked out as in the offline branch. No actions.
- **Timer.** `_clock(needed)` must also be true while the delivery is `queued`, the recipient is online, and either
  threshold can still be crossed (not yet crossed, and its condition could hold).
  - The timer fires at `min(500 ms, time to the nearest threshold)`.
  - Once neither threshold can still be crossed, no timer runs.

- [ ] **Step 5: Run the tests and analyze**

Run: `cd desktop && flutter test test/super_tab_receipt_test.dart && flutter analyze lib/super_tabs test/super_tab_receipt_test.dart`
Expected: all tests pass; analyze reports "No issues found!".

Moving `now` to `clock.now` can make an existing test fail. If one does, find out why first. A fixture time read from
`DateTime.now()` against the fake clock is the likely cause. Ledger the ruling, and fix the fixture rather than the
widget.

- [ ] **Step 6: Commit (only once Diego asks)**

```bash
git add desktop/lib/super_tabs/model.dart desktop/lib/super_tabs/message_receipt.dart desktop/test/super_tab_receipt_test.dart
git commit -m "feat(desktop): a queued message that is not getting in reads Not delivered yet"
```

---

### Task 4: The CLI host names a failing claim

**Files:**
- Modify: `cli/src/superTabs/host.ts`: the `deliveryRetries` type (~line 271), the claim catch and the `listRead` log
  (~lines 760-790), and the constants near `DELIVERY_RETRY_MS` (~line 170).
- Test: `cli/src/superTabs/host.spec.ts`, in `describe('a delivery poll or claim that keeps failing', …)`

**Interfaces:**
- Consumes the existing `retryLater(key, list?)`, which returns `{ failures, retryAt, since, list? }`.
- Produces `const CLAIM_FAILURE_LOG_MS = 5 * 60_000`.
- Produces an optional `saidAt?: number` on the `deliveryRetries` entry type.

- [ ] **Step 1: Write the failing tests**

They use that describe's `failing(t, refuse)` helper and `t.wait(ms)`. The setup's ids are: delivery `delivery`, agent
`agent`, session `harness`, Swarm `tab`. Its clock starts at 0.

```ts
it('says whose claim keeps failing, once, then at most every 5 minutes', async () => {
  const t = setup(), host = t.open()
  failing(t, (method, path) => method === 'POST' && path.endsWith('/deliveries/delivery'))
  await host.tick()
  const said = () => t.log.mock.calls.map(c => c[0] as string).filter(l => l.includes('delivery delivery') || l.includes('This Swarm is busy'))
  expect(said()).toEqual(['Could not claim delivery delivery for agent agent (session harness) in Swarm tab: This Swarm is busy. Try again in a moment. (SWARM_BUSY). '
    + 'Failing since 1970-01-01T00:00:00.000Z, 1 try; next try in 1 s.'])
  for (let i = 0; i < 9; i++) { t.wait(30_000); await host.tick() }   // 4.5 min of failing claims
  expect(said()).toHaveLength(1)
  t.wait(30_000); await host.tick()                                     // 5 min since the last line
  expect(said()).toHaveLength(2)
  expect(said()[1]).toMatch(/^Could not claim delivery delivery .*Failing since 1970-01-01T00:00:00.000Z, \d+ tries; next try in 30 s\.$/)
})
it('says once when a claim that had failed gets in', async () => { /* refuse = true for 2 claims, then false; after the
  successful tick the log has 'Delivery delivery claimed after 3 tries, 0 min.' exactly once, and no further line on later ticks */ })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd cli && npx vitest run src/superTabs/host.spec.ts -t "claim keeps failing|claim that had failed"`
Expected: FAIL. The log holds the bare `This Swarm is busy. Try again in a moment.` line.

- [ ] **Step 3: Implement it in `host.ts`**

**The failure line.** In the claim's catch, where `retryLater(claimKey, listKey)` is already called, keep its returned
entry. Log the named line when either holds:

- it is the entry's first failure;
- `now - saidAt >= CLAIM_FAILURE_LOG_MS`.

Then set `saidAt = now`. The line has the same shape as the existing "Could not read the deliveries…" line:

```
Could not claim delivery <id> for agent <agentId> (session <harnessId.slice(0, 8)>) in Swarm <tabId>: <message><code>.
Failing since <ISO>, <n> try|tries; next try in <s> s.
```

`<code>` is ` (CODE)` for a `SuperTabHostError` and empty otherwise.

**No bare line.** The outer `if (listRead) this.log(message)` must not log again for a claim the inner catch already
spoke for, whether or not the inner catch logged on this pass. Mark such errors, for example in a `WeakSet<object>` of
claim errors, and skip them there. Other errors after a read list keep the bare line, as today.

**The success line.** Where a claim succeeds (`this.deliveryRetries.delete(claimKey)` after `accept`), look first for an
entry with `failures > 0`. If there is one, log
`Delivery <id> claimed after <failures + 1> tries, <Math.round((now - since) / 60_000)> min.`

Add a comment naming prod 10-30: 223 bare lines in 2 hours.

- [ ] **Step 4: Run the tests and the typecheck**

Run: `cd cli && npx vitest run src/superTabs/host.spec.ts && npm run typecheck`
Expected: the whole file passes, including the existing backoff tests; tsc exits 0.

- [ ] **Step 5: Commit (only once Diego asks)**

```bash
git add cli/src/superTabs/host.ts cli/src/superTabs/host.spec.ts
git commit -m "fix(cli): a Swarm claim that keeps failing is named in the log"
```

---

### Task 5: Docs, and the final checks

**Files:**
- Modify: `docs/swarms.md`. Add a short paragraph after **Lead updates**, or wherever delivery receipts are described.
  Grep "Not sent" first. It says, plainly:
  - a message that its recipient's online computer cannot take within a minute, or has not picked up in two, reads
    **Not delivered yet**;
  - Harness keeps trying;
  - prod watch alarms on `claims failing`.

  Name the incident date.

- [ ] **Step 1: Write the paragraph.**

- [ ] **Step 2: Run every affected check together, and record each result**

Run:

- `B` (the whole integration file)
- the `deliverySettle.test.ts` unit run
- `cd backend && npm run typecheck`
- `cd desktop && flutter test test/super_tab_receipt_test.dart && flutter analyze lib/super_tabs`
- `cd cli && npx vitest run src/superTabs/host.spec.ts && npm run typecheck`

Expected: all pass. `host.ts` is not under `src/core`, `src/services` or `src/harnessd`, so no 100% coverage gate
applies.

- [ ] **Step 3: Commit (only once Diego asks)**

```bash
git add docs/swarms.md docs/superpowers/specs/2026-10-30-swarm-stuck-delivery-visible-design.md docs/superpowers/plans/2026-10-30-swarm-stuck-delivery-visible.md
git commit -m "docs(swarm): Not delivered yet and the claims failing alarm"
```
