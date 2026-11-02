# The PM hears routine notices in one message every 5 minutes

Status: design, 2026-11-02. Requested by Ken.

## Why

Every message delivered to a project's coordinator (the PM) starts a new turn for it: an Opus session with a very long
context, interrupted each time. In 20 minutes on 2026-11-02 the openharness PM received 23 messages, and 10 of them were
notices the server writes on its own. Most of those need no answer within minutes: a task quiet for 30 minutes, an agent
idle for 15, an Engineer's Done. Ken: gather the server's own routine notices to the PM and deliver them as one message
at most every 5 minutes; deliver at once what someone is waiting on.

## What Ken decided

- **Scope:** only messages the server itself sends the PM. Posts by agents and people are unchanged.
- **Gathered:** routine notices, delivered as one message.
- **Delivered at once:** anything a person or an agent is waiting on.
- **Interval:** 5 minutes, measured from the first notice gathered, never on a fixed clock. Nothing is sent when nothing
  was gathered. On the 2026-11-02 sample, 11 deliveries in 20 minutes become 5.
- **Where it runs:** on the server, not in the PM's daemon. The daemon's exactly-once delivery (claim, lease, receipt,
  journal) stays one message per delivery. The PM polling on a timer was rejected: it would wake the PM every 5 minutes
  with nothing to read, and it depends on the PM remembering to poll.

## Goals

- Fewer turns for the PM, with nothing lost: every gathered notice is named in the digest by its task and message id.
- A notice anyone waits on still arrives as fast as today.
- Old daemons, old Desktop and phone builds keep working unchanged.

## Non-goals

- Gathering agents' or people's posts.
- Changing what the notices say, or which ones are written.
- Gathering for agents other than a project's coordinator.

## Anti-goals

- A notice silently never delivered: held forever, or dropped by a rollback.
- An urgent notice (Stuck, Needs a human) delayed by the digest.

## Which notices

Gathered (`DIGEST_KINDS`, by the message's `source.kind`, plus Done status rows):

| Source | What |
|---|---|
| `work-stalled`, `work-lost`, `work-resumed` | a task quiet 30 minutes, lost or resumed (liveness.ts) |
| `idle` | an agent with no open task for 15 minutes (tidy.ts) |
| `review-failed`, `review-capacity`, `overlap`, `note-removed` | the coordinator's information notices |
| a `work.status` row with status `done` | an Engineer's (or a step's) Done |

Delivered at once, as today:
- `work.status` rows `needs_human` and `blocked`;
- `pair-loop` (two agents looping);
- `terminal-alert`, `buddy-proposal`;
- `update-request` and `digest-request` (already throttled, and they carry their own instructions);
- `agent-only` notices: decisions answered and instructions changed, written by daemons with no kind of their own;
- every post by an agent or a person.

To tell Done apart, `work.status` system rows gain `source.status` (the status set). Rows written before have none and are
delivered at once.

## How

### Gathering

In `store.ts` `writeMessages`, a delivery whose recipient is its project's coordinator (`ledProject(state, recipient)`)
and whose message is gathered (above) is created with `status: 'gathered'` instead of the default `queued`. The message
itself is written as today, in its conversation, so people and other readers see it at once.

A gathered delivery is never listed to a host: hosts list only open statuses (`OPEN_DELIVERY`: queued, claimed, uncertain),
so old daemons ignore it too. It does not count as work waiting for the agent: `idleNotices`'s `busy` reads open
statuses only.

### Releasing

On the coordinator's own poll (`store.ts` `fullDeliveries`, which already writes the Lead's time checks, idle notices
and update requests in one transaction), the server reads the agent's gathered deliveries, oldest first:
`{ tabId, agentId, status: 'gathered' }` by the existing index `[tabId, agentId, status, createdAt]`, at most 50.

When the oldest is at least `NOTICE_DIGEST_MS` (5 minutes) old:
1. It reads each gathered delivery's message by its id, one `findUnique` each (no `in` filter on a hot collection,
   `hotFilters.test.ts`). It reads the task's number and title from the loaded state.
2. It writes one digest message in the project's Lead conversation:
   - author: the coordinator, as `update-request` is;
   - `source: { kind: 'notice-digest', count }`, recipients `[coordinator]`;
   - `NOTICE_READERS['notice-digest'] = 'recipients'`.
3. It marks those gathered deliveries `status: 'digested'`, a settled status, in the same transaction.

Digest text, one line per notice, oldest first, each line at most 200 characters:

```
Notices since 06:30 UTC (4). Read one in full: harness super-tab message GROUP MESSAGE_ID.
- #1959 "Web app: an account menu…": Done — PR 2515 at 30a9942… (message 1a2b… in 6f3c…)
- #1991 "Review: Buddy copies…" (step Review of #1978): Jasper 2 lost its task: no progress for 30 minutes (message …)
- Tester has had no open task for 15 minutes (message …)
```

More than 50 gathered: the digest names the first 50 and says how many more; the rest go in the next digest.

Word chosen (design call): the status is `gathered`, not `held`. "Held" already means a claimed delivery a host cannot
type yet (`holdReason`, `holdSince`, the host's `hold`, store.ts ~3021 and ~3277).

### Same rules as a delivery

At digest time each gathered row passes the checks a listed delivery passes today: `deliveryAllowed` and `senderAllowed`
(store.ts ~2982-3009, ~3148-3154). A row that fails is set `cancelled`, as a refused delivery is, and is left out of the
digest.

`gathered` joins every place that cancels open deliveries, so no gathered row outlives its reason:
- archive and an agent leaving (store.ts ~1505);
- removed groups (~1513);
- agent removal (~1702);
- task end (~2266, ~3485);
- ~3419;
- native revoke (native.ts ~279).

`digested` joins `FINAL_DELIVERY`, so compaction (deliveryCompaction.ts) and the settle pass treat it as finished.
`deliver()` (the claim, store.ts ~3237) refuses a `gathered` or `digested` row as it refuses a resolved one, so a host
claiming one by id never types it.

### With the update request

When an update request (projectUpdates.ts) is due in the same poll as a digest, the two go as one message: the update
request's text, then "Notices since …" and the lines. The PM gets one turn, not two. A Done is often in both (the update
request asks to read that task's new messages); the digest line stays, as it is what the merge waits on.

### Who counts as coordinator

The project's Lead conversation's `leadId` (`ledProject`). When the lead changes (commands.ts conversation.agent with
`lead`), the old lead's gathered rows go back to `queued` in that command's write: they are delivered to it one by one,
as before this design. It stays in the chat and running (commands.ts ~2421), and they were written for it.

### Stuck gathered deliveries

If the coordinator stops polling (its machine off, the agent stopped), gathered rows must not wait forever. The delivery
settle pass, which runs every 5 minutes (deliverySettle.ts), sets every row `gathered` for more than 30 minutes back to
`queued`. Each is then delivered on its own, as before this design, once a host lists it. The hourly Swarm sweep would
have let one wait about 90 minutes.

## Design

- **Growth:** a gathered row is the delivery row that would have existed anyway. A digest (normally within 5 minutes),
  the 30-minute backstop, or any cancel settles it. `digested` rows are compacted like other finished ones. One digest
  message per release.
- **Concurrency:** holding happens inside the existing message write. Releasing happens inside the coordinator's poll
  transaction, which already writes; the `gathered → digested` update is guarded by `status: 'gathered'`, so two polls racing
  digest each row once. The digest message id is `stableId('notice-digest', agentId, oldest gathered delivery id)`, so a
  retried poll writes it once.
- **Read cost:** one indexed read of at most 50 rows per coordinator poll. When a digest is due, one message read per
  gathered row (at most 50). Nothing for any other agent.
- **Scale (10x):** 10x notices means up to about 100 gathered per 5 minutes, so digests cap at 50 lines and roll over. The
  metric that warns first: the size of digest messages and how often one rolls over (logged).
- **Compatibility:**
  - Old daemons never see `gathered` rows and get the digest as an ordinary message.
  - Clients never classify kinds: the server hides rows (`readsRow`, store.ts ~427). The digest also carries the
    `forRecipients` marker (model.ts ~541), so a backend that knows the marker hides it from people whatever the kind.
    On an older backend without it, an unknown kind reads as people's.
- **Migration and rollback:** no migration. An older backend neither lists, settles nor releases `gathered`. A rollback
  therefore runs `db.SuperTabDelivery.updateMany({status:'gathered'},{$set:{status:'queued'}})` after the last new pod
  and the worker have stopped. Run any earlier and rows written in between are lost. The rollback note goes in the
  release PR.
- **Audience:** the digest is the coordinator's alone (`recipients`). Each line names only messages the coordinator was
  already a recipient of.
- **Identity:** the digest is authored as the coordinator, as the existing update request is; no person's identity is
  used.
- **Failure:**
  - A digest that cannot be written (the transaction fails) leaves the rows gathered; the next poll tries again.
  - A message that cannot be read is named by its id alone.
  - The 30-minute sweep is the backstop.
  - Each digest is logged with its count.
- **Platforms:** server only.

## Tests

- `writeMessages`:
  - a gathered notice to the coordinator is gathered;
  - the same notice to another agent is queued;
  - `needs_human` and `blocked` rows to the coordinator are queued;
  - `pair-loop`, `terminal-alert`, `update-request`, an `agent-only` message and an agent's post are queued;
  - a `done` status row is gathered.
- Coordinator poll:
  - nothing is released before 5 minutes;
  - at 5 minutes, one digest names every gathered notice with its task and message id, and the gathered rows become `digested`;
  - a second poll writes no second digest;
  - 60 gathered rows give a digest of 50 that says 10 more, and the next poll's digest has the rest.
- Gathered deliveries:
  - they are never listed to a host;
  - they do not make an agent busy for `idleNotices`.
- Settle pass: a delivery gathered over 30 minutes becomes `queued`.
- Cancels: archiving the conversation, a task ending, the agent leaving or being removed cancels its gathered rows.
- Checks: a gathered row whose conversation became unreadable is cancelled at digest time and left out.
- Claim: `deliver()` refuses `gathered` and `digested` rows.
- Lead change: the old lead's gathered rows become `queued`.
- An update request and a digest due in the same poll go as one message.

## Left to the builder

- The digest's exact wording within the shape above.
- Where `DIGEST_KINDS` and `NOTICE_DIGEST_MS` live (`notices.ts` or a new `noticeDigest.ts`).
