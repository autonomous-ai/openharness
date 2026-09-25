# Autonomous Device grouped results — turn.correlation.v2

Status: OpenHarness producer implemented behind opt-in, 2026-09-25. PR #294 introduced
input delivery and this contract; its follow-up adds engine evidence and durable results.
**Disabled by default; the deployed OS does not support v2.** OS receive/storage/TTS work
and joint validation are still required. Existing single-input fields keep their meaning.

Machine-readable [result schema](contracts/turn-correlation-v2/result.schema.json),
[group event fixture](contracts/turn-correlation-v2/group-result.json),
[single result](contracts/turn-correlation-v2/input-result.json),
[OS replay expectations](contracts/turn-correlation-v2/os-replay-cases.json),
[Claude native queue capture](contracts/turn-correlation-v2/claude-native-queue.json), and
[Codex steering capture](contracts/turn-correlation-v2/codex-steering.json) are the handoff.
The JSON schema is generated from the producer's runtime validator and checked in tests.
Membership delivery IDs and request keys must each be unique (an additional semantic check).

## Decision

One engine result may cover several inputs. Publish one result with explicit membership,
not one copy per input. Never select an arbitrary request key for a merged summary.
Input acceptance, result membership, and task completion are separate facts.

Negotiate `turn.correlation.v2` as a capability on both peers. Send a new
`turn.result` event only to an opted-in peer. Do not overload `turn.summary`, `turnId`,
`runId`, or receipt states. Older peers continue to receive existing session events;
uncorrelated overlapping results cannot complete or speak a pending run.

```json
{
  "type": "event",
  "kind": "turn.result",
  "agentId": "agent-123",
  "payload": {
    "serverInstanceId": "instance-123",
    "resultId": "result-456",
    "correlation": {
      "scope": "group",
      "inputs": [
        { "deliveryId": "delivery-A", "idempotencyKey": "original-key-A" },
        { "deliveryId": "delivery-B", "idempotencyKey": "original-key-B" }
      ],
      "engineTurnId": "optional-engine-native-id"
    },
    "outcome": "completed",
    "fullText": "Created the house with a garden and a red roof."
  }
}
```

Required: agentId, serverInstanceId, resultId, correlation.scope, correlation.inputs,
outcome, fullText. Scope is `input` (exactly one member) or `group` (two or more).
Each member contains both original idempotencyKey and deliveryId, with no duplicates.
Outcome is `completed`, `failed`, or `cancelled`. fullText is the complete immutable result
for this membership, never a pointer to latest recap. engineTurnId is optional evidence,
not the DEVICE run ID. Do not put a singular runId/idempotencyKey on a group event.
The existing transport sequence/replay envelope still applies.

## Harness responsibilities

1. Preserve each request reservation and receipt independently. Include only inputs whose
   consumption and association with this result are established by engine evidence.
   A clear composer, native queue insertion, proximity in time, or a session end alone
   cannot establish result membership. Queued but unconsumed inputs stay pending.
2. Build the immutable result at an actual engine completion boundary. Generate resultId
   once; replay and reconnect reuse the same ID, text and membership. Never emit a result
   when only input acceptance is known. Missing evidence retains `unknown` receipts and
   session-scoped information; it does not produce a guessed group.
3. Only proven members may transition to completed (for outcome completed). Failed or
   cancelled work must not be labelled completed; existing receipt states remain unchanged
   until a separately negotiated receipt outcome extension exists. Do not close other runs.
4. Partition delivery to the authenticated originating device. Do not disclose another
   device's request keys or private result through a shared agent subscription. Grouping
   across owners requires separate authorization and is outside this contract.
5. Retain result records alongside receipt/replay retention and publish retention limits.
   Instance change is reconciliation, never permission to resubmit automatically.

This requires Device-specific engine evidence extraction; synthetic group IDs do not
solve missing evidence. Shared chat/orchestrator normalizers need not change for this PR.

## OS responsibilities

1. Register original request key, deliveryId, serverInstanceId, agentId and local DEVICE
   run ID before routing a result. Resolve every member to the same authenticated device,
   instance and agent. Any explicit mismatch or unresolved member prevents application
   of the whole event; reconcile receipts, without agent/latest-run fallback.
2. Atomically store result and membership, then resolve exactly the listed runs with the
   stated outcome. Pending runs not listed remain pending. Store a reference to the one
   shared result rather than copying it into independent per-input responses.
3. Deduplicate by (device identity, serverInstanceId, resultId). An identical replay is a
   no-op. Same ID with different content/membership is a protocol error, never a new result.
4. Enqueue a single Lamp utterance per result, using fullText from this event. Do not speak
   once per member or again on turn.done/summary/receipt.updated. Suppress results belonging
   to expired voice targets or incompatible reply routes; retain the result for retrieval.
   A group spanning distinct reply destinations must not choose the latest destination.
5. Persist the TTS outbox and its dedupe identity before playback. If playback acknowledgment
   is lost, retain an uncertain playback state and avoid automatic replay: exactly-once
   audible playback cannot be guaranteed by network dedupe alone.
6. Reconnect replays results and reconciles original receipts/keys; it never resends input
   with a new key. Consume receipt.input separately for steering/native/daemon queue UI.

## Current OS compatibility

The OS patch supplied on base `30e034f84` supports one event → one input/run, using
agentId + original idempotencyKey (top-level, payload, or payload.receipt), or DEVICE
runId/run_id. If both exist they must match the same route. Explicit mismatch does not
fall back; overlapping runs do not use agent-only/latest recap inference. fullText in the
event is preferred. This is compatible with proven single-input summaries, **not groups**.

OS does not yet consume this capability, group membership, result dedupe, or receipt.input.
Do not send the example above to today's OS or duplicate a merged summary under every key.
No Autonomous OS source is changed by this PR.

## Joint acceptance tests before enablement

- A then steering B: one proven merged result resolves A/B and speaks once.
- Claude queues B but result covers only A: B remains pending until consumed and completed.
- A/B/C with B included and C not consumed: only A/B resolve.
- Unknown membership: no fabricated key, completion or voice response.
- Duplicate/reordered events, lost acknowledgment, reconnect, and restart: no duplicate input
  or TTS enqueue; changed instance is reconciled explicitly.
- Wrong key, deliveryId, agent, owner, or instance: no partial application or fallback.
- Mixed voice destinations, cancelled runs, expired routes and failed results: no wrong Lamp
  response; outcomes remain distinct from input acceptance.

Rollout order: implement OS parser/storage/outbox; run the shared fixtures and physical
Lamp test with the opt-in Harness producer; then enable mutually. No Lamp deployment or
live paid task is performed by this change. The full Lamp flow is not yet certified.


## Producer implementation and evidence (2026-09-25)

The Device-only observer reads raw transcript records alongside existing normalizers.
It does not change shared chat/orchestrator scheduling or infer completion from their
session-wide events. A Device reservation is durably saved before engine dispatch;
the observer matches only exact normalized prompt hashes marked for dispatch, and
record timestamps at or after dispatch, in the same bound engine session. It requires one unambiguous candidate. Matching
identical unresolved prompts is unsupported rather than guessed FIFO. Slash commands
use the exact adapted engine input hash. Neither a replayed historical prompt nor an
input still waiting for the writer can acquire membership.

**Claude:** the Lamp failure was reproduced in existing Claude Code 2.1.263 JSONL.
At 09:22:26 B entered `queue-operation/enqueue`. At the next tool boundary the engine
recorded `remove` with `absorbed_mid_turn`, then an `attachment` with type
`queued_command`, human origin and `commandMode: prompt`. That attachment is on the
`parentUuid` chain of the final assistant message at 09:23:26 with `stop_reason: end_turn`.
PR #294 observed ordinary user starts and missed this attachment. The new observer walks
that final answer's parent chain to its human input root and includes only consumed
Device inputs on that branch. Queue enqueue/remove alone is never consumption evidence.
A sibling-branch attachment is not included. The final assistant message supplies fullText;
no recap or commentary summary is consulted. Claude engineTurnId is omitted because the
observer does not assert a native turn ID for this lineage.

**Codex:** the existing 0.156.1 smoke transcript contains `response_item/message` records
with `internal_chat_message_metadata_passthrough.turn_id` and `content_item_kinds`.
Only `user.text` blocks establish input membership; AGENTS/environment context does not.
The matching `event_msg/task_complete.turn_id` and its `last_agent_message` provide the
completion boundary and complete text. Multiple input records with the same explicit
engine turn ID produce one group; different IDs produce separate results. A currently
open task, a synthetic normalized end, or a record lacking that mapping is insufficient.

This proves the inputs were included in the engine context that produced the final
answer; it is not a semantic claim that every requested edit was performed correctly.
A real final result on a supported evidence path closes only its proven receipts. Bare
turn.done cannot close native Device inputs anymore. Consumed inputs with insufficient
lineage/completion evidence become `unknown / RESULT_EVIDENCE_MISSING`; unconsumed queued
inputs remain pending. The deployed legacy OS still cannot route a group result.

## Enablement and negotiation

Both gates are required:

1. Operator opts in locally with `HARNESS_DEVICE_RESULTS_V2=1` when starting the CLI.
   Without it, hello does not advertise v2 and no v2 event is delivered to peers.
2. The authenticated Device sends the existing application hello with an optional
   `capabilities: ["turn.correlation.v2"]` array and checks that hello_result also lists it.
   An omitted array means legacy; every new hello replaces the connection's capability
   selection, including on reconnect/downgrade. No new RPC or protocol version is added.

```json
{"type":"hello","requestId":"<uuid-v4>","proto":1,"capabilities":["turn.correlation.v2"],"resume":{"serverInstanceId":"<transport-instance>","cursor":42}}
```

The same gate and originating identity checks protect live delivery and replay over
both direct LAN and relay (they share the application relay handler). Mixed-owner groups
are withheld wholesale, never split into copied summaries. Revocation removes receipts
and retained results. OS must dedupe v2 results and must not produce another TTS from
legacy summary/done/receipt events for those same runs.

## Persistence, restart and bounds

`device-results.json` in the private CLI data directory atomically stores request
reservations and immutable results, with file and directory fsync. A failed reservation
write prevents dispatch. Result payload and receipt completion are committed together
before emission; a failed commit never publishes completed receipts. Corrupt state fails
closed instead of discarding idempotency reservations. No prompt body or transcript is
stored in the journal: it contains prompt hashes, receipt metadata and final result text.

- At most 512 receipts and 512 results. Results expire after 30 minutes; completed/rejected
  receipts retain the existing 30-minute TTL and capacity eviction policy. Unresolved
  receipts are retained and apply backpressure, including across restart.
- The existing ordinary event replay ring holds 500 events. A valid cursor replays the
  retained envelopes. A missing/expired/old-instance cursor receives `resync`, followed by
  retained results with fresh increasing transport event IDs. OS must process this
  reconciliation stream and dedupe by result identity, not equate a new envelope to a new
  task. No new event name or payload field is introduced for this recovery.
- After daemon restart, top-level serverInstanceId is the **new transport instance**;
  payload.serverInstanceId stays the **originating result/receipt instance**, as in the
  shared fixture. resultId, fullText, outcome and membership stay byte-for-byte equivalent.
  OS matches payload.serverInstanceId to its stored original routes. This distinction and
  resync result replay must be implemented by OS before enabling v2; never relax mismatch
  checks to agent-only fallback.
- In-flight receipts restored after restart are `unknown / DAEMON_RESTART`. The daemon
  does not replay their input or reconstruct uncertain consumption. Repeating the same
  key returns the original reservation. A result already committed remains retrievable
  through hello replay even after its acknowledgment was lost.
- A result has at most 64 members and a serialized payload at most 32 KiB, leaving room
  for the encrypted envelope. Oversized results are withheld with unknown receipts, never
  silently truncated or incorrectly completed. Snapshot size is bounded at 32 MiB.

## Verification and remaining limits

Component tests cover captured Claude/Codex forms, separate/group/subset completion,
queued but unconsumed input, sibling branches, missing ancestry, duplicate prompt ambiguity,
mixed owners, wrong/absent capability, live/replay authorization, acknowledgment loss,
restart, disk-write failure and retention. Existing shared normalizer, controller,
orchestrator and backend transport suites remain regression coverage.

Read-only replay of the original unredacted Lamp transcript produced one group [A,B],
completed both receipts, and retained its 332-character final answer. Read-only replay
of the existing Codex smoke transcript produced [A,B] with `GARDEN_RED`. These are real
engine **transcript replays**, not fresh live engine or physical Lamp tests. Shared fixtures
redact IDs/tool payloads and content while preserving the observed record structure.

Not supported in this producer: engines other than Claude/Codex; Codex formats without
explicit per-user-input turn metadata; missing/truncated/compacted Claude ancestry;
ambiguous identical prompts; grouping across owners or untracked human inputs; automatic
in-flight recovery after process restart. The evidence graph is bounded (8,192 Claude
nodes, 256 active Codex turns); missing evidence after eviction fails closed. Failed or
aborted task records currently retain unknown receipts rather than fabricating a completed
result; failed/cancelled remain valid schema outcomes for future proven producers.
OS group routing, durable TTS dedupe/outbox and the separate HAL spoken-history bug are
not implemented here. Neither OS nor Lamp is deployed by this PR.
