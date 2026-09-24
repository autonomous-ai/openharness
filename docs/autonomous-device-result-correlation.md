# Autonomous Device grouped results — turn.correlation.v2

Status: Harness-side contract decision for OS coordination, 2026-09-24.
**Not implemented or advertised by PR #294.** Both sides must implement and test this
contract before enabling it. PR #294 delivers follow-up input; it does not complete the
merged-result → Lamp flow. Existing single-input fields keep their meaning.

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

Rollout order: OS parser/storage/outbox and Harness evidence/result producer behind the
capability; shared fixtures for the cases above; real engine + physical Lamp test; then
mutual enablement. Until then PR #294 is an input-delivery fix only.
