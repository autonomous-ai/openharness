# A Swarm message that cannot be delivered says so

Status: design · 2026-10-30 · owner Diego · approved in chat 2026-10-30

## Why

On 2026-10-30 no message a person sent their own Buddy reached it from 09:06 to about 11:01 (VN). Backend 1.3.71
(#2178) made a Buddy delivery's claim touch the same part twice with one version. The second write always conflicted,
`retryTransient` gave up after 8 attempts, and the claim answered `SWARM_BUSY`. Hotfix #2295 fixed the cause.

The delivery itself was never lost. `SuperTabDelivery` is a durable queue (`queued → claimed → delivered`): the row
stayed `queued` and went in once claims worked again. What failed was that **nobody could tell**:

- **The sender** saw nothing. `desktop/lib/super_tabs/message_receipt.dart` shows a line only while a message sends
  (under 3 s), when it was not sent or could not be confirmed, or when the recipient's computer is offline. A `queued`
  message to an online computer has no line, which reads as delivered.
- **The backend** answered every claim with the same busy it gives during a deploy. `stuck()` in
  `backend/src/superTabs/deliverySettle.ts` returns false for every reachable `queued` delivery, so the settle pass
  never looked at it. Nothing raised an alarm.
- **The host** logged 223 bare `[super-tabs] This Swarm is busy. Try again in a moment.` lines (`host.ts` logs a failed
  claim's message alone when its list was read). None of them names the delivery, the agent or how long it has failed.

The trigger was Diego asking whether his Buddy had died. This design makes the same failure visible to the sender
within about a minute, and to prod watch within five.

The herdr-core idea of a seq/missed event stream was considered and dropped: deliveries are already durable rows, so
nothing is missed. The problem was a stuck delivery that nobody noticed.

## Scope

In:

1. Backend records each failed claim on its delivery row and clears the record when a claim succeeds.
2. The delivery settle pass logs an alarm line for a Swarm whose queued deliveries keep failing to be claimed.
3. Desktop and the web app (one Flutter receipt) show **Not delivered yet** for a queued message that is not getting in.
4. The CLI host's log names the failing delivery and is rate limited.

Out:

- The phone app (`mobile/` is its own package). It gets the same rule in a follow-up, from the same fields.
- The round dial and the Harness Pro.
- A Buddy that is down. Its chat already offers **Start**, and a delivery to a stopped agent is not this failure.
- Failed acknowledgements (`ack`). See Open risks.
- Changing what `retryTransient` or the error handler answer. A claim that keeps conflicting still answers
  `SWARM_BUSY`, and the host still retries it.

## Design

### 1. Backend: a failed claim is written on its delivery

**Fields.** `SuperTabDelivery` (`backend/prisma/schema.prisma`) gains four optional fields. Mongo needs no migration,
and older rows read them as null.

| Field | Type | Meaning |
| --- | --- | --- |
| `claimFailingSince` | `DateTime?` | The first failed claim since the last successful one |
| `claimFailedAt` | `DateTime?` | The latest failed claim |
| `claimFailures` | `Int?` | Failed claims since `claimFailingSince` |
| `claimFailure` | `String?` | The latest failure's code (today always `SWARM_BUSY`) |

**Recording.** `SuperTabStore.delivery` (`backend/src/superTabs/store.ts`) runs its `transaction(...)` inside a catch,
for `action.type === 'claim'` only, and only for a request that got past the claim's authorization and status checks on
some attempt. `deliver()` sets a flag right after those checks, so a busy answer that came before them (the first read,
under load) writes nothing on a delivery the caller may not touch. The catch records when the thrown error is:

- a `SuperTabError` with code `SWARM_BUSY`. `retryTransient` (`retry.ts`) ends both kinds of retryable failure that way:
  a write conflict after 8 attempts, and an expired transaction (`P2028`) after 2. So the claim never sees a raw
  `P2028`, and nothing else needs matching.

It records with two standalone single-document writes, **outside** the failed transaction. Both match
`{ id: deliveryId, tabId, agentId, status: 'queued' }`.

1. An `updateMany` that also matches a missing or null `claimFailingSince` and sets it to `now`. With Prisma on Mongo,
   a field an older row never had needs `isSet: false` beside `null`. This keeps the first failure's time from ever
   moving later.
2. An `updateMany` that sets `claimFailedAt = now` and `claimFailure = code`, and increments `claimFailures`. A missing
   count counts from 0.

Those writes touch no Swarm part and no other row, so they cannot meet the conflict that failed the claim. They are
capped at 2 s (`RECORD_FAILED_CLAIM_MS`), so a struggling database never holds the busy answer back. They are best
effort: if it fails, that is logged as `warn [swarm-deliveries] could not record a failed claim` `{tabId, deliveryId,
error}` and the original error is still thrown unchanged. The client's answer (503 `SWARM_BUSY` with Retry-After) does
not change.

Other refusals (`DELIVERY_REVOKED`, `DELIVERY_RESOLVED`, `CLAIM_CONFLICT` and so on) are answers, not failures, and
record nothing.

**Clearing.** Only a successful claim clears the record: its `tx.superTabDelivery.update` in `delivery()` unsets all four fields
(`{ unset: true }`). It must not write `null`, because Mongo's `$inc` refuses a null count, so the next failure's
increment would throw.

Every other write that moves a delivery out of `queued` leaves the fields as they are. That covers an ack, a cancel, the
settle pass and archiving. Every reader below ignores the fields unless the status is `queued`, so the leftovers are
harmless.

**Reading.** `pageDeliveries` (`backend/src/superTabs/pageReads.ts`) projects `claimFailingSince` and
`claimFailures` beside the fields it reads today, and `PageDelivery` gains them. Every reader of a page already reads
its deliveries this way, so the Desktop and web receipts get the fields with no new request. `claimFailure` and
`claimFailedAt` stay server-side: they are for the alarm and for diagnosis, and the person has nothing to do with a
code.

**Cost.** One extra single-document write per failed claim. A host retries a failing claim at most every 30 s
(`DELIVERY_RETRY_MAX_MS`). In the 10-30 incident that would have been about 240 writes across 2 hours for one
person's Buddy, against a delivery index that already exists. No new index is needed: the alarm reads rows the settle
pass already reads.

### 2. Backend: the settle pass raises the alarm

`settleStuckDeliveries` already reads every open delivery every 5 minutes, page by page, grouped by Swarm. After it
settles a Swarm's rows, it also counts that Swarm's **failing** rows from the same page. A row is failing when:

- `status === 'queued'`,
- `claimFailingSince` is at least `CLAIM_FAILING_ALARM_MS` (5 minutes) before `now`, and
- `claimFailedAt` is within `CLAIM_FAILING_ALARM_MS` of `now`, so claims are still failing rather than abandoned.

For each Swarm with at least one failing row, the pass logs one line:

```
warn [swarm-deliveries] claims failing  { tabId, deliveries, oldestFailingSince, codes }
```

- `deliveries` is the count.
- `oldestFailingSince` is the earliest `claimFailingSince` as ISO text.
- `codes` is the distinct `claimFailure` values.

The line carries no message text, no agent names and no person ids. The tab id is already in every Swarm log.

This is the line prod watch alarms on. On 10-30 it would first have been logged at the first pass after 09:11 (5 minutes
of failing). The pass **does not cancel** these deliveries:

- A cancelled delivery reads **Not sent** and its text is gone from the recipient.
- Once the cause is fixed, a still-queued one goes in, late but whole.
- `stuck()` is unchanged.

`openDeliveries` must also return the two new date fields as Dates, as it already does for `holdSince`.

### 3. Desktop and web: Not delivered yet

`SuperTabDelivery` (`desktop/lib/super_tabs/model.dart`) reads `claimFailingSince` (a date) and `claimFailures` (an
int). Both are null from an older backend.

`SuperTabMessageReceipt.build` gains one branch. It goes after **offline** and before **Sending…**, so an offline
computer still says it is offline. It applies when the receipt delivery's `status == 'queued'`, the recipient's
computer is not offline, the Swarm is readable (`!c.backendUnreachable`), the recipient is in the Swarm and running
(`downSince == null`), and either of these holds:

| Case | Condition | Note text |
| --- | --- | --- |
| Claims failing | `claimFailingSince` is at least 60 s ago (`superTabClaimFailingNotice`) | "$host is online but couldn't take this message yet. Harness keeps trying, and it goes in as soon as it can." |
| Not picked up | the message's `createdAt` is at least 2 min ago (`superTabQueuedNotice`); the note follows whether `claimFailingSince` is set, so the line never drops out when a first claim failure arrives | "$host is online but hasn't picked this message up yet. Harness keeps trying, and it goes in as soon as it can." |

- **Title:** "Not delivered yet". It uses the warn colour (`grid.AppPalette.warn`) and the clock icon the app already
  uses for waiting. If there is none, the plan picks the nearest existing `AppIcons` mark. No new icon.
- **No actions.** The sender has nothing to do. **Send again** would make a second delivery behind the same failure.
- **`$host`** is the machine name, as the offline note already names it
  (`machine?['name'] ?? widget.machineName(agent.machineId)`).
- **The line disappears by itself** once the delivery leaves `queued`, at the next page read. That is one poll, or a
  push.
- **Clock.** The widget's `_clock(needed)` 500 ms timer runs today only while fresh or offline. It must also run while a
  queued delivery is below either threshold, so the line appears without another rebuild. When neither threshold can
  still be crossed (not queued, or already shown), no timer runs.

The web app gets the same line, because it renders the same widget.

The Leads conversation and a Buddy chat follow the same rule. Their receipts read the same delivery.

### 4. CLI host: the log names the delivery

In `cli/src/superTabs/host.ts`, the branch that logs `message` alone when the list was read but a claim failed
(`if (listRead) this.log(message)`) logs this instead:

```
Could not hand delivery <deliveryId> to agent <agentId> (session <harnessId 8>) in Swarm <tabId>: <message> (<code>).
Failing since <ISO>, <n> tries; next try in <s> s.
```

It uses the `deliveryRetries` entry `retryLater(claimKey, listKey)` already keeps (`since`, `failures`, `retryAt`).
That is the same shape as the existing "Could not read the deliveries…" line.

**Rate.**

- The line names the delivery, not the claim: `accept()` also acknowledges and downloads files, and an ack that keeps
  failing is the open risk below.
- It logs on a delivery's first failure, at once when the error's text or code differs from the last line, and
  otherwise at most once every 5 minutes per delivery while it keeps failing.
- When a delivery that had failed goes through, the host logs `Delivery <id> went through after <n> tries, <m> min.`
  once.
- A failure that is not a `SuperTabHostError` (a network error) is logged the same way, with no code.

At the 10-30 rate this is about 25 named lines instead of 223 bare ones.

The message text is never logged, as today.

## Compatibility

- **Additive fields.** An older Desktop, web build or CLI ignores them. An older backend sends none, and the receipt
  then uses only the 2-minute rule.
- **No change to any request or answer shape** beyond the two added fields on page deliveries.
- **Rollback** leaves the fields unread on existing rows. They are harmless and clear on the next successful claim.

## Testing

**Backend** (`backend/src/superTabs/*.test.ts`, vitest):

- A claim whose transaction throws `SWARM_BUSY` records the four fields with `claimFailures = 1`. A second failure keeps
  `claimFailingSince` and increments the count.
- A `DELIVERY_REVOKED` records nothing.
- A successful claim after failures clears all four fields.
- When the recording write fails, the original error is still thrown and a warn is logged.
- The settle pass logs `claims failing` for a queued row failing 5 min or more and still failing. It logs nothing for one
  failing under 5 min, or one whose last failure is older than 5 min. It cancels none of them.
- `pageDeliveries` returns `claimFailingSince` and `claimFailures`.

**Backend integration** (`backend/integration/`): a claim forced to answer `SWARM_BUSY`, as
`harnessSharesList.test.ts` forces `readParts`. The page read then carries `claimFailingSince`, and a later real claim
clears it.

**Desktop** (`desktop/test/super_tab_receipt_test.dart`):

- Each case shows "Not delivered yet" with its own note at and after its threshold, and nothing before it.
- Offline wins over it.
- A delivered message shows nothing.
- An older backend's delivery (no fields) uses the 2-minute rule.
- A stopped agent (`downSince` set) shows neither case.
- The line appears by the widget's own clock, without a new snapshot.

**CLI** (`cli/src/superTabs/host.spec.ts`):

- A claim failing with `SWARM_BUSY` logs the named line once.
- Further failures inside 5 minutes log nothing; the next one after 5 minutes logs again.
- A different error inside the 5 minutes logs at once.
- Success after failures logs the "went through after" line.

## Open risks

- **Failed acks.** An ack that keeps failing leaves a delivery `claimed`, although the agent has the text. After
  `CLAIM_QUIET_MS` (10 min) the settle pass cancels it, and the sender reads **Not sent** for a message that arrived. This
  design does not change that. It is a separate fix, worth raising after this ships.
- **The 2-minute rule's false positives.** These are agents that are running but legitimately not reading: a host that
  updates for longer than 2 minutes, or `UPDATE_REQUIRED` backoff. In each of these the message truly is not delivered
  yet, so the line is honest. The note says Harness keeps trying, which is true.
