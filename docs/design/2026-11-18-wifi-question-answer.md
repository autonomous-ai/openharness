# Wi-Fi answers through the existing local question connection

## Decision

Remove the Wi-Fi-specific question-answer door from core. The component already owns an authenticated
owner-tool connection for the shared `questions_observe` protocol. Extend that connection to send the
existing `question_response` frame and read its existing result. Do not add a core query, provider,
protocol field, permission or generic component broker. Keep `CoreApi.wifi`'s other doors pending their
separate authority decisions.

Approved by the coordinator before runtime edits; implemented as described below.

## Existing authority and caller audit

`backendSocket` dispatches `question_response` unchanged to `questionProvider`. Main binds that provider
with `createQuestionResponse(payload => cloud.answer(payload) ?? asking.answer(payload))`, the same
cloud/native choice as the old Wi-Fi callback. `createQuestionResponse` passes the original payload
object through; its TypeScript annotation does not strip `allowPermissions`.

The component must send `allowPermissions: false`. `AskQuestionController.answer` passes that exact
restriction to `drive`, which rejects permission dialogs before applying a key. It captures the native
control session before reading the pane; `drive` checks the selected session's capture generation before
and after capture and after interpretation, and the existing native question-control port fences each
actual key. The cloud question path is unchanged and does not become a native permission path.

The public frame's `requestId` is the question id and also the reply correlation id. `openDaemon.request`
cannot be used: it replaces that id with a random RPC id. The existing observation socket already has
the correct machine and generation; the component sends the question id directly on it. No separate
connection is opened for an answer.

## Design

- Growth: the existing observer owns a map of pending answers keyed by question id. Reuse a process-owned
  `DeviceWorkBudget` for at most 100 answers and 16 MiB of encoded retained payload across observer
  generations; this is application accounting, not a claim about total JavaScript heap. Every answer
  has a 30-second deadline, matching the former service query. There is no queue or retry. A duplicate
  pending question id is refused; it cannot replace another waiter. No answer is accepted before the
  observation's complete snapshot. No persistent data is added.
- Concurrency: capture the original observer and component core epoch. Check them immediately before
  send and after the correlated result. The observer checks its original physical socket, completed
  observation and generation; a replaced connection never receives an old answer. Question response
  matching requires the exact frame type and question id, not an arbitrary frame with that id.
- Timeout and physical custody: any answer timeout invalidates the whole observer before resolving
  pending answers as unconfirmed and closes its socket. A new observer has no old waiters or responses.
  Thus a late reply cannot satisfy another attempt with the same question id. A confirmed matching
  response releases its charge. An invalidated answer retains charge until the original socket's actual
  close event; logical timeout, error or a call to `close()` is not release proof. The pool lives outside
  component rebuilds, so restart does not erase unsettled capacity. Process exit is the final bound.
- Read cost: no list, archive or additional snapshot is read; the existing observation and existing
  single question response are used. Shared snapshots and pushes retain their existing limits.
- Scale: 10× work is bounded by the same count/byte admission; fixed, content-free
  `QUESTION_ANSWER_BACKPRESSURE` and `QUESTION_ANSWER_TIMEOUT` logs identify the first refusal. No ids,
  paths, answers or question text enter the new logs.
- Compatibility: no backend or public frame change. Last-30-day clients are unaffected. Core and private
  service workers use the existing immutable cohort. Old daemon observation negotiation still refuses
  explicitly, as before; it never falls back to a Wi-Fi-specific query. The receipt continues to become
  `completed` only for a confirmed `ok: true`; every refusal, disconnect and ambiguous send becomes
  `unknown`/`NOT_CONFIRMED` under the existing device journal, with no effect replay.
- Migration and rollback: no on-disk schema or business-data migration. Rollback selects the matching
  earlier immutable worker/core cohort and its former private query. Delete the old query and callback
  in this change; no dual route or timer-based compatibility fallback.
- Audience and identity: the existing private local owner-tool transport authenticates this OS user and
  selects this daemon's machine. The component retains its existing paired-device audience and journal
  checks before answering. It gains no core authority; the same shared provider remains the final writer.
- Failures: a named observation/answer failure returns no success, stops that observation and leaves
  already-issued effects unknown. It does not replay or claim cancellation of an effect already sent.
  Ordinary sessions and the other components remain independent.
- Platforms: shared TypeScript on macOS, Linux and Windows; the existing local socket/authenticated pipe
  connection code is unchanged. macOS tests here; Windows execution is deferred by the user. No mobile
  or Desktop UI change.

## Files and failure-first validation

Extend `agentClient/questions.ts`/tests with the bounded effect and physical-close ownership, and wire
the existing observer in `services/wifi.ts` and its process adapter. Remove `CoreApi.wifi.answer`, its
fallback, `core/wifiAgents` callback, `core/wifiLink` query and main's callback composition. Update only
the affected mocks and type fixtures.

First RED: the actual service caller sends a question id and `allowPermissions: false` on the observed
owner-tool connection and receives confirmation without any `core.wifi.answer` query. Transport tests
cover exact result correlation, simultaneous duplicate ids, normal refusal, send throw, timeout then
late reply, actual-close credit, old-socket replacement, component/core loss before send and during the
reply, oversized/full admission, response before complete snapshot, and no automatic replay. A caller
test through `createQuestionResponse` plus the actual question controller proves permission rejection
and captured-session replacement still write no key. Existing generation/native-control tests remain.

After approval and RED, run affected question-observer, Wi-Fi component/process and core-door tests,
their per-file coverage, architecture and types. Root coordinates the packaged Wi-Fi question flow and
matched runtime-cost acceptance; no benchmark or broad native workload runs independently here.

## Other residual doors

The existing generic `live`/`advertised` rows omit terminal availability, service-published package/name
and the old `turnStartedAt` running fact. Ordinary `agents_list` provides app display and terminal data
only for advertised rows; its activity evidence is not equivalent to that turn-open boolean. Replacing
the old view by those facts alone would change inactive registered rows or running state. A shared
app/session snapshot used by actual Desktop and component callers needs a separate design, not a new
Wi-Fi-only fact query.

The existing `AgentFrame` also normalizes an absent launch record to `ready`; the former Store view
distinguishes an unbound active agent without launch evidence as `starting`. Reusing only that app
field would falsely report readiness. A shared snapshot must retain raw launch evidence and registered
versus advertised membership, and decide how every real caller reads turn-open versus activity proof.

Creation still needs the exact workspace-exclusive admission absent from ordinary `agent_create`;
confirmed cancellation is absent from one-way `cancel`; step/scroll need a real cohost and mixed-host
route; focus/reveal need the existing first-window and revision/connection guards. None is weakened by
this slice. Shared abort-card presentation remains a broader dial/legacy caller change.

## Validation evidence, 2026-11-18

- Actual caller RED: `/tmp/core-wifi-question-answer-red.log`, exit 1. The original service called its
  private core door and sent no `question_response` on the observed owner-tool socket.
- Initial targeted GREEN: 143 cases passed; types passed. The first coverage receipt is retained at
  `.harness/validation/20261118T040506.842659Z-45800/receipt.json`, overall failed: the 168 core cases and
  54 client/controller cases passed, but coverage lacked existing supplemental Wi-Fi/API spec files and
  earlier observer failure cases. Architecture and types passed. No behavioral failure was retried.
- Final fixed-source receipt:
  `.harness/validation/20261118T040937.981894Z-50550/receipt.json`, actual exit 0, unchanged before/after
  source fingerprint, 15.652 seconds total. Its 275 core/service cases cover all six selected runtime
  files at 100% statements, branches, functions and lines; 72 client/controller cases cover the question
  connection at 100% in all four measures. All 35 architecture cases and TypeScript checking passed.
- The real local WebSocket composition test confirms a journalled `question.answer` through the
  ordinary backend provider, with the exact question id and `allowPermissions: false`; the receipt is
  completed and the owner-tool connection does not count as a Desktop window. Separate real-controller
  tests prove permission refusal and replacement during capture/interpretation apply no native key.
- macOS source and private-socket fixtures only. Packaged native question flow, matching-process
  runtime costs, Linux and full integration acceptance remain coordinator-owned. Windows execution is
  deferred by the user. No new runtime dependency, Desktop UI or mobile change.

The evidence paragraph was added after the fixed-source run; no runtime or test changed afterward.
