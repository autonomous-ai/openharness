# The PM's digest gathers three more kinds of notice

Status: design, 2026-11-02. Requested by Ken. Extends
[2026-11-02-pm-notice-digest-design.md](2026-11-02-pm-notice-digest-design.md) (shipped in #2560, merged in batch #2575).

## Why

On 2026-11-02 the openharness PM received 993 messages up to 21:45 Vietnam time, and 466 of them came from the server.
The digest's kinds cover 247 of the 466, which become 86 digests. Of the notices still delivered at once, three kinds
nobody waits on from the PM within minutes:

| Kind | That day | What they said |
|---|---|---|
| `blocked` status of a **step** | 47 | mostly a Reviewer waiting on fixes ("changes needed, findings sent to the Builder"); a few needed a person ("needs the owner's account") |
| the PM's own `agent-only` instructions notices | 29 | "The project's instructions changed: …", "Harness now gives you two skills …" |
| `terminal-alert` for a usage limit or a failing model | ~10 of 19 | "hit a usage limit", "can't get answers from its model" |

The first design kept `blocked` and `agent-only` at once on purpose: Stuck is urgent, and an agent-only notice may be a
decision someone answered. This design gathers only the parts of them where the one waiting is someone else, or no one.

## What changes

1. **A step's Stuck: dropped after review.** It stays at once for the coordinator, as today. The project instructions say
   blocked and needs_human are only for something a person must do (workflow step 3; #2638, which would have changed that,
   closed unmerged), so a step's Stuck is always something a person acts on (review of #2797, 2026-11-03).
2. **The PM's instructions and skills notices.** An `agent-only` message a coordinator's own host sends to it about its
   skills (instructions changed, skills replaced or updated) is gathered. The host marks it: `message.send` gains an
   optional `notice: "skills"`, accepted only with `agentOnly: true`, from an agent to itself; the row keeps it as
   `source.notice`. Any other `agent-only` message, a decision answered among them, still goes at once. Unmarked rows
   (older daemons) go at once.
3. **Usage limits and failing models.** A `terminal-alert` with `alert: "limit"` or `alert: "model"` is gathered.
   `alert: "prompt"` (an agent waiting at a prompt) still goes at once. At release, an alert whose agent no longer has
   that alert (`agent.alerting`) is cancelled, not delivered: the limit reset, or the model answers again.

Nothing else changes: the 5-minute interval, the 50-line cap, the 30-minute backstop, the release checks
(`deliveryAllowed`, `senderAllowed`), the merge with a due update request, and every cancel path.

## Where in the code

- `noticeDigest.ts`: `gatheredNotice(source, group)` takes the message's group too: it gathers a `blocked` status row only
  when `group.reviewOf` is set, an `agent-only` row with `notice: "skills"`, and a `terminal-alert` with `limit` or
  `model`. The one call site, `store.ts` `writeMessages`, passes the group it already holds.
- `store.ts` `releasableNotices`: cancels a gathered `terminal-alert` whose agent's `alerting` no longer holds its alert,
  as it cancels any row that no longer has a reason.
- `commands.ts`: `message.send` schema gains `notice: z.literal('skills').optional()`; refused (VALIDATION_ERROR) unless
  `agentOnly` and the sender is the only recipient. It is written into `source` with `agent-only`.
- CLI `host.ts` `tellSkill`: sends `notice: "skills"`; a backend that refuses the key gets the same request without it,
  as `agentOnly` is retried today.

## Tests (each fails on main first)

- A step's `blocked` row: the coordinator's delivery is `gathered`, the task owner's is `queued`; a task's `blocked` row
  and any `needs_human` row are `queued` for the coordinator.
- A coordinator's self-sent `agent-only` with `notice: "skills"` is gathered; one without it, or another agent's
  `agent-only` message, is queued; `notice` from another sender, to another recipient, or without `agentOnly` is refused.
- `terminal-alert` `limit` and `model` are gathered and `prompt` is queued; a gathered `limit` whose agent's alert ended
  before release is cancelled and not in the digest.
- CLI: `tellSkill` sends `notice`, and retries without it on the old backend's refusal.
- Full Super Tab integration suite, as for any delivery change.

## Expected effect

On the 2026-11-02 numbers, about 85 more notices a day reach the PM inside digests instead of one by one, on top of the
161 the first design saves. Most of the PM's remaining load is agents' posts (422 that day), which this does not touch.

## Design

- **Growth:** no new rows; gathered deliveries are the existing rows with the existing statuses, compacted as today.
- **Concurrency:** unchanged; the release runs in the coordinator's poll transaction, guarded by `status: 'gathered'`.
- **Read cost:** the release already reads each gathered row's message; the alert check reads the agent from the state
  it already holds. No new query.
- **Scale:** at 10x, the 50-line cap and the next digest absorb it; the first metric to warn is digests that roll over
  ("And N more").
- **Compatibility:** an old daemon sends no `notice`, so its notices go at once as today. An old backend refuses
  `notice`, and the new CLI resends without it. Desktop and the phone are unchanged.
- **Migration + rollback:** none. Rollback is the first design's: requeue `gathered` rows after the last new pod stops.
- **Audience:** the digest stays the coordinator's alone; `notice` is accepted only on an agent's message to itself.
- **Identity:** no new identity; the host sends as its own agent, as today.
- **Failure:** a gathered row the coordinator never polls for goes back to queued after 30 minutes (existing backstop);
  a refused `notice` falls back to an immediate notice.
- **Platforms:** backend and the CLI host only.
