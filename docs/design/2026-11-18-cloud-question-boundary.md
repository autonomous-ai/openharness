# Cloud question presentation boundary

## Design

Cloud prepares its question and close frames in its component, including its wording, choices, notification and dial preference. Core admits a bounded frame pair for one accepted owner through the existing Cloud door, with the existing current-service authority checked at the physical dispatch. It forwards those frames without clipping or constructing Cloud presentation. The private worker cohort rolls back as a whole; this does not change public frames or saved provider questions.

The existing request-to-owner `asked` map becomes a request-to-accepted-question record containing the owner, prepared close and accepted dial destination. It replaces the existing separate `onDial` set. The shared `openQuestions` map still contains exactly the accepted open frame for reconnecting local clients. There is no second owner map or question history. A question can only be local, or local and dial; a component may suppress dial delivery but cannot send a free-text-only question there. The close uses the destination accepted with the open; a close cannot change it.

| Event | Accepted question lifecycle |
| --- | --- |
| First ask | Validate exact agent/session/request correspondence, shape and byte limit, then retain one question for that owner. |
| Same request again | Reconnect can resend its unchanged frame; conflicting content or expanded destination under the same key is refused. |
| Replacement | Close the old question through its accepted frame/destination, retire its request, then accept the new one. The normal publisher already emits close before open. |
| Close | Only the current exact owner/request/frame closes. A syntactically valid request with no accepted record is an idempotent no-op, including after owner withdrawal; it cannot remove the new open frame. An effect still requires the exact current owner. No history is kept to distinguish retired keys from other inactive keys. |
| Answer | Only a currently registered request with a currently accepted owner routes to Cloud. Cloud consumes it before waiting for the provider; a duplicate is stale. A late result cannot remove or restore another question. |
| Owner deletion | Retire and close its current question before dropping ownership. Recreating the same owner does not revive the old request. |
| Component disconnect/restart | Keep the accepted frame for clients. A physical reconnect reannounces the current in-memory question through the ordered publication queue. A restarted component retains the prior behavior: it loads no active question and reconstructs one on its next provider look, which may mint a new request id. Old service connections cannot ask or close. |
| Daemon restart | Reconstruct from intact saved provider state; no extra question state file is introduced. |

A prepared pair contains one question, at most six options, each text at most 500 characters, request identifiers at most 80 characters and at most 22 KiB encoded bytes. The close is at most 1 KiB. Only the named protocol fields are accepted. Core checks before mutation. Its retained question count is bounded by its accepted owner count; at ten times the owner count it remains linear, with constant-time request routing and owner replacement lookup through `openQuestions`. Component output remains bounded by the existing 64-action/6-MiB queue and reservations; it measures prepared action bytes at enqueue, before provider effects. The existing six-action reservation becomes 512 KiB to cover two 192-KiB rows and three 22-KiB prepared pairs plus envelopes. Its maximum concurrent reservation count remains ten, limited by the 64-action queue.

The synchronous core door serializes mutation; component publication ACK order keeps row/card/close/open order. A replacement looks up the old request through the current open frame, without another map. Exact request and owner checks precede deletion so old close frames and late answers cannot disturb new requests. Invalid private frames return `CLOUD_QUESTION_INVALID` before any client effect; the existing Cloud unavailable status and log make failed admission visible. No content is logged.

Readers remain the existing local question reconnect path, commander dial delivery and question-response router. Local and dial frames are unchanged byte for byte for valid normal flows, including no dial notification for free text. Terminal questions and their controller are untouched. Saved `{requestId,text,choices}` provider schema stays unchanged; physical reconnect uses the current in-memory question, while component restart reconstructs it on the next provider look; no migration or production data rewrite is required. A released older/newer worker is never mixed with this unreleased private cohort. Whole-artifact rollback restores the previous code with compatible provider state.

The authenticated local Cloud service acts as this computer's owner. It gains no target other than an already admitted Cloud owner and cannot target another session or broaden the accepted close destination. Shared/remote service callers still fail the current-service boundary. There are no external requests or new credentials. macOS source validation is required here; the platform-neutral TypeScript runs on Linux and Windows too, with Windows execution deferred by the user. Mobile is outside this task.

## Validation plan

First reproduce current stale-close/replacement and retired-answer bugs through real `createCloudAgents`. Then cover prepared-frame structural/byte/owner refusal, destination narrowing, idempotence, owner removal, same-request reconnect and final service fencing. Component tests check legacy normalization, unchanged saved state and queued row/card/close/open ordering, duplicate answers and late provider refusal. Run affected source/type/100% per-file gates; packaged proof waits for the parent's combined artifact. This work does not mutate the frozen publication cost pair or claim its pending measurements validate question cost.

## Source evidence

- RED before runtime edits: `20261118T074500.527937Z-20691/receipt.json`, both real-core regressions failed: old close erased the replacement, and the retired request still routed an answer.
- Prepared-frame implementation: `20261118T075524.236629Z-42112/receipt.json`, types and 257 cases across 17 files passed, selected seven files at 100% statements/branches/functions/lines. Earlier gate receipts remain intact (test adaptation errors, then one annotation and a redundant post-branch guard).
- Subsequent source review removed the unnecessary second retained open-frame reference from `asked`; the shared `openQuestions` frame alone supplies comparison and reconnect. Sparse inline option arrays are rejected and literal public frame/close bytes are asserted.
- Parent review found that a valid late close after owner withdrawal entered a hold. RED `20261118T080638.908594Z-53593/receipt.json` proved it through the real ordered publisher and core. Inactive requests now acknowledge an idempotent no-op after syntax validation; only a matching current owner can cause a close effect.
- Final affected slice `20261118T080829.461227Z-55453/receipt.json`: types and 56 cases across five files passed; core admission and component question preparation are 100% statements/branches/functions/lines (182/202/55/137). The previous 257/17 gate supplies unchanged publication/service/process evidence. All wrappers completed owned-process cleanup. These receipts do not claim native or performance acceptance.

Receipt paths are relative to this isolated tree's `.harness/validation/`. The matched publication cost fixture uses its separately frozen pre-question pair and is unaffected by this work.
