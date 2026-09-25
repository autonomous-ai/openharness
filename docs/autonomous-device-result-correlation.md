# Correlation on existing Autonomous Device summaries

Agreed with OS on 2026-09-25. This fixes the existing Device return path. It is enabled
by default and uses the existing `turn.summary` event and ordinary application hello.
There is no separate result event, version, feature flag, or capability negotiation.
Both sides must update before grouped results can be routed to Lamp correctly.

## Wire contract

`turn.summary` is the final user-facing result. Keep its existing `fullText` (complete
answer), `text` (compact preview), and optional `kind`/`recap` meanings. Add result identity,
originating instance, explicit input membership, and outcome inside `payload`:

```json
{
  "type": "event",
  "kind": "turn.summary",
  "agentId": "agent-123",
  "machineId": "machine-123",
  "serverInstanceId": "current-transport-instance",
  "eventId": 42,
  "payload": {
    "serverInstanceId": "originating-receipt-instance",
    "resultId": "stable-result-id",
    "correlation": {
      "scope": "group",
      "inputs": [
        {"deliveryId": "delivery-A", "idempotencyKey": "original-key-A"},
        {"deliveryId": "delivery-B", "idempotencyKey": "original-key-B"}
      ]
    },
    "outcome": "completed",
    "kind": "summary",
    "text": "Finished: two red planes and two blue planes.",
    "fullText": "Finished: two red planes and two blue planes."
  }
}
```

Scope is `input` for exactly one member, `group` for two or more. Inputs contain the
original deliveryId and idempotencyKey, unique by both fields. Optional engineTurnId
belongs inside correlation and is an engine-native ID, never an OS DEVICE run ID.
Outcome is `completed`, `failed`, or `cancelled`; this producer currently proves successful
completion only. It leaves interrupted/failed work unknown instead of inventing a result.

A proven single-input summary also retains singular payload.idempotencyKey and turnId
for existing clients. They identify that same member and retain their existing meaning.
**Group summaries never contain a singular key/runId/turnId selected from the members.**
One shared result is not copied into several independent replies. A queued but unconsumed
input is not included. Receipt input acceptance is not task completion.

The exact [runtime-generated schema](contracts/autonomous-device-summary-correlation/result.schema.json),
[single summary](contracts/autonomous-device-summary-correlation/input-result.json),
[group summary](contracts/autonomous-device-summary-correlation/group-result.json), and
[OS replay expectations](contracts/autonomous-device-summary-correlation/os-replay-cases.json) are the
shared fixtures. The schema describes enriched summaries; older legacy summaries remain
valid on the existing protocol. Ownership, uniqueness by each member field, and matching
singular fields require semantic checks in addition to JSON schema validation.

## OS application rules

1. Register each outgoing request's device identity, agentId, receipt instance, deliveryId,
   original key, local run and reply destination. Match **every** member of an enriched
   summary to that registry. Explicit owner/agent/instance/key/delivery mismatch or unknown
   membership prevents application of the entire result; reconcile, never guess by latest
   run, recap, agent alone or nearby timestamps.
2. Store the immutable result and membership atomically. Close exactly the listed runs for
   the stated outcome. C remains pending when only A/B are listed. Retain one shared result
   reference rather than manufacture a separate answer for A and B.
3. Dedupe by `(device identity, payload.serverInstanceId, payload.resultId)` across live,
   replay, reconnect, process restart and reordered envelopes. Same identity with different
   content/membership is a protocol error. A new transport eventId does not make a new result.
4. TTS uses fullText from this summary **once per result**. Enqueue the durable TTS outbox
   entry with the result dedupe identity. Do not speak again on turn.done or receipt.updated:
   these are lifecycle updates, not another final reply. Do not query latest recap to fill
   in a missing correlated result. Unknown or invalid results must be visibly unresolved.
5. Do not select the latest voice destination for a group spanning incompatible destinations.
   Retain it for retrieval instead. Lost playback acknowledgment remains uncertain; network
   dedupe cannot guarantee exactly-once audible playback. Do not automatically replay it.
6. Preserve a task's result route across a structured question. question.open and successful
   question.answer acknowledgment are not completion of that task. An answer operation's
   receipt describes delivery of the answer; it is not a new text input in the final result
   membership. Bind the answer UI/voice route back to the original task. The unchanged
   questionRequestId and answer shape remain authoritative for submitting answers.

## Engine consumption evidence

The Device observer reads raw transcript records alongside existing normalizers. It does
not change shared chat/orchestrator scheduling. A reservation is durably saved before
engine dispatch. Matching requires one exact normalized input hash, a dispatch marker,
a record timestamp at or after dispatch, and the same bound engine session. Duplicate
unresolved identical text is ambiguous and is not guessed FIFO. Slash commands use the
adapted text actually sent to the engine. Historical and still-unwritten inputs cannot
acquire membership.

**Claude:** in the original Lamp failure (Code 2.1.263), B was enqueued at 09:22:26.
The next tool boundary wrote remove/absorbed_mid_turn and a human `queued_command`
attachment with commandMode prompt. That attachment lies on the parentUuid branch of the
final assistant message at 09:23:26 with stop_reason end_turn. The previous observer only
saw ordinary user starts and missed B. The fix walks that final answer's exact parent
branch to its human root and includes consumed Device inputs on that branch. Enqueue or
remove alone is not consumption; a sibling-branch attachment is excluded. fullText comes
from the final assistant message, not a recap. No synthetic engineTurnId is claimed.

**Codex:** existing 0.156.1 transcript records contain per-message
internal_chat_message_metadata_passthrough.turn_id and content_item_kinds. Only user.text
blocks establish membership; project/environment instructions do not. The matching
explicit task_complete.turn_id and last_agent_message supply the result. Same engine turn
can cover A/B; distinct turn IDs yield separate summaries. Merely being in the same session
or following task_started is insufficient.

Evidence establishes that inputs were in the engine context producing that final answer;
it does not independently verify the requested edits. Missing lineage/completion produces
`unknown / RESULT_EVIDENCE_MISSING` for consumed inputs. Unconsumed queued inputs remain
pending. A session-wide turn end alone cannot complete native Device inputs.

Redacted structural captures:
[Claude](contracts/autonomous-device-summary-correlation/claude-native-queue.json),
[Codex](contracts/autonomous-device-summary-correlation/codex-steering.json).

## One return path and compatibility

- Native Device results are emitted once through turn.summary. Device forwarding suppresses
  mirror-generated asynchronous summaries for agents with retained native Device reservations
  or results. A late or restarted recap cannot create a second final answer. App, USB dial
  and orchestrator mirror behavior is unchanged; suppression is only in the Device facade.
- Task A alone receives the same final event, fullText/preview and its original singular key.
  It additionally gets stable result metadata. Existing clients can ignore additive fields.
- Unsupported **engines** retain their original lifecycle, question, done and summary paths.
  They do not acquire fabricated membership or result identity. Their pre-existing limitations
  are not presented as durable correlated-result guarantees.
- Unsupported **native transcript formats** (for example Codex without explicit input/turn
  mapping), truncated/compacted Claude ancestry, ambiguous identical prompts, mixed owners,
  or untracked inputs fail closed with unknown receipts. No latest-recap fallback silently
  attributes their text to a Device task. Consumers must display the unresolved receipt/error.
- Structured question and answer RPCs are unchanged. A question with one known originating
  input carries its existing key/turnId. Multi-input questions have no arbitrary singular
  key; exact grouped question-to-voice routing is not added by this change. Status/answer by
  questionRequestId remains available and group question routing needs separate coordination.
- Older OS versions that route only one key per event **cannot correctly resolve a group**.
  They still receive the one summary with complete text; versions that reject uncorrelated
  overlap will leave those routes unresolved and may not speak. This is an explicit upgrade
  requirement, not a claimed compatibility success: update OS to this contract before testing
  grouped TTS. There is no hidden switch or second disabled return path to enable afterward.
- Old-client restart/TTS dedupe is not guaranteed. Updated OS must store result identities
  and process the recovery behavior below; ordinary single-task wire compatibility cannot
  substitute for implementing group or durable replay semantics.

## Persistence, restart and replay

`device-results.json` in the private CLI data directory atomically stores reservations,
receipts and immutable result payloads, with file and directory fsync. It stores prompt
hashes rather than prompt bodies, plus final answer text. A failed reservation write prevents
dispatch. Receipt completion and its result are committed together before publication;
failed commits do not publish completion. Corrupt state fails closed, never drops dedupe.

A result retains resultId, content, outcome, membership and payload.serverInstanceId across
replay/restart. Top-level serverInstanceId identifies the **current transport**, while
payload.serverInstanceId identifies the **original receipt/result instance**. OS matches the
payload instance to original pending runs. engineTurnId and Device run IDs never replace it.

- Ordinary event replay retains 500 events. A valid cursor replays their stored envelopes.
  Missing/expired/old-instance cursor gets resync followed by retained final summaries with
  fresh increasing transport event IDs. OS must consume these reconciliation summaries and
  dedupe by result identity. It must not discard them merely because the transport restarted.
- Restored in-flight receipts become `unknown / DAEMON_RESTART`. The daemon does not resend
  their input or guess unfinished consumption. Same-key retries return the original record.
  A previously committed result is replayable even if its send or acknowledgment was lost.
- At most 512 receipts and 512 results. Results expire after 30 minutes; completed/rejected
  receipts keep the existing 30-minute TTL and capacity eviction policy. Unresolved receipts
  remain reserved across restart and apply backpressure. No automatic replay after expiry.
- At most 64 members and 32 KiB serialized payload per result, fitting the encrypted transport
  budget. Oversized results remain unknown rather than being truncated and marked complete.
  The snapshot is bounded at 32 MiB. Evidence is bounded to 8,192 Claude nodes and 256 active
  Codex turns; evicted/missing evidence fails closed.
- Live and replay delivery both verify the authenticated originating Device against immutable
  stored membership. Same-owner groups only. Revocation removes its receipts and results.
  A result with changed owner/agent/key/delivery/content cannot pass this check.

## Validation and remaining work

Mock/component coverage includes A, A/B grouped with C pending, A/B separate, native queue
versus consumption, sibling branches, missing evidence, session rebinding, duplicate/mismatched
results, reconnect, daemon restart, lost acknowledgments, journal failure, legacy engines,
structured question/answer, and unchanged shared controller/normalizer/orchestrator behavior.
Schema and fixtures are checked against the runtime validator.

Read-only replay of the original unredacted Claude Lamp transcript produces one A/B summary,
completes both receipts and preserves the exact 332-character final answer. Existing Codex
smoke transcript replay produces one A/B summary with GARDEN_RED. These are **transcript
replays**, not new engine tasks or end-to-end Lamp verification. No task with a fee, deployment
or CLI restart is performed by this change.

Still unsupported: automatic recovery of in-flight consumption after daemon restart, failed/
cancelled result production, missing native evidence formats, mixed-owner/untracked groups,
and grouped question-to-voice routing. OS must implement result routing, persistent dedupe,
TTS outbox and question-route retention. The HAL spoken-history issue is separate. Do not
claim app → OS → TTS fixed until both implementations pass a real end-to-end test.
