# Input while an agent is working

`turn.send` uses the same session for follow-up requests. A `deliveryId` no longer makes
Claude/Codex wait for the previous task to finish. The Device-only input adapter owns a short write lock
(runtime validation, paste, Enter, and acceptance verification), not a lock over model
reasoning or tool execution. Device messages preserve FIFO order. Existing local/orchestrator scheduling stays unchanged;
CLI wiring excludes simultaneous terminal writes only while Device owns the same pane.
The shared SessionInputController and Claude/Codex normalizers are unchanged.

## Engine behavior

| Adapter | While busy | What Harness reports |
| --- | --- | --- |
| Codex >= 0.106 | Native Enter; steering is always enabled in these versions | `steering` |
| Claude Code | Native Enter; message appears in Claude's editable queue | `native_queue` |
| Older/unknown-version Codex | Existing native Enter path; precise semantics are not certified by the adapter | `native_input` (never claim confirmed steering) |
| Other current adapters | No verified non-interrupting busy-input implementation in Harness | `daemon_queue`, released at turn end |

Codex's visible pending steer may wait for the next tool boundary. Claude may consume a
queued message after tool calls within the same turn or at a later turn. Neither path sends
Escape, Ctrl+C, stop/restart, or Claude's interrupt-and-send shortcut. Native acceptance
does not establish that the model has processed the message or finished its task.

Upstream references: [Codex 0.106 release](https://github.com/openai/codex/releases/tag/rust-v0.106.0)
removed the steer feature flag; [Claude interactive input](https://code.claude.com/docs/en/interactive-mode#queue-messages-while-claude-works)
describes its queue and tool-boundary consumption. The version threshold deliberately does
not infer runtime feature configuration on older Codex builds.

## State and evidence

- Each native input retains its own fingerprint/delivery ID until a matching user-message
  event arrives. An unrelated start does not erase later inputs. Identical texts match FIFO.
- One paste/Enter transaction holds the writer lock. Subsequent input is released after a
  matching transcript event or a visible composer no longer containing that draft. A missing
  capture or a dialog-only screen is not evidence of acceptance.
- An exact visible draft can authorize a bounded Enter retry only after the previous terminal
  operation returned confirmed execution. An ambiguous acknowledgment disables key retries.
  The prompt body is never repasted. If evidence remains insufficient, mark `unknown` and
  retain the composer barrier so the next message cannot concatenate with the draft.
- Question/permission dialogs hold prompts in the daemon. Explicit answers can acquire control
  while prompts are queued; the control lock still excludes other writers. Native preflight
  inspects dialogs again, and polls for their disappearance before releasing queued prompts.
- The existing eight-item/24-KiB waiting queue and five-minute expiration remain. An active
  input returned to the front after detecting a dialog retains its separate reserved slot.
  At most 64 unresolved native inputs can be dispatched per session; further requests are
  rejected with `queue_full`, and already-waiting input waits for capacity.
- Session removal rejects unsent work and marks dispatched/running work unknown. A vanished
  session cannot allow an old async completion to start another write.

The Device event observer ignores an end immediately followed by a new input in the same
Claude/Codex batch: that inferred boundary is insufficient completion evidence. Shared
normalizers and other event consumers retain their existing behavior.

The receipt service keeps every request reservation independently. Only an unambiguous
observed start followed by its session end can complete a receipt. If starts overlap before
an end (including an untracked local task), there is no engine-native turn ID in today's
adapter event. The affected tracked receipts become `unknown / OVERLAPPING_INPUTS` instead
of replacing each other. A `turn.done` never completes every outstanding delivery. A summary
never updates receipt completion. This conservative result is intentional: native acceptance
is proven, per-message task completion is not.

## Backward-compatible input status extension

The CLI advertises **`input.status.v1`** in hello capabilities. This is a feature marker,
not an RPC. Existing request fields, protocol version, states, `turnId`, errors, and
idempotency semantics retain their meanings. Clients that understand the marker may read
optional `receipt.input` from the original response, `receipt.get`, or `receipt.updated`:

```json
{
  "state": "delivered",
  "input": { "mode": "native_queue", "phase": "accepted" }
}
```

`mode` is `direct`, `steering`, `native_queue`, `native_input`, or `daemon_queue`.
`phase` is `waiting_for_writer`, `waiting_for_user`, `waiting_for_turn`, `submitted`,
`accepted`, or `unconfirmed`. `submitted` means the terminal write completed, not that
Enter was consumed. `accepted` means the native input left the composer or was observed
in the transcript, **not task completion**. The dispatch mode remains attached to the
input even if the previous task ends while acceptance is being observed. Before dispatch,
mode is the intended route and phase explains the current wait.

Clients must tolerate an absent `input`, unknown future fields, and `unknown` completion
while `input.phase` remains `accepted`. Only `receipt.state:completed` is receipt completion.
Do not interpret an optional field or an extra `receipt.updated` as a new task.

Dedupe remains `(device identity, idempotencyKey)`, reserved before dispatch. A lost reply,
socket reconnect, receipt poll, or same-key retry cannot create a second submission in
the same server instance. `unknown` reservations are retained. Cache retention and daemon
restart limitations in [the existing contract](autonomous-device-integration.md) still apply:
a changed `serverInstanceId` is reconciliation, never permission to replay automatically.

## OS coordination (no Autonomous OS changes in this PR)

Both callers use this Device route: harness-use retains its taskKey; Harness-only voice
uses its original voice request key and focus revision. The supplied OS patch on base
`30e034f84` adds single-input correlation and avoids agent/latest recap fallback after
overlap. It does not support merged results or consume receipt.input yet.

The concrete handoff is [Grouped result contract: turn.correlation.v2](autonomous-device-result-correlation.md).
It defines the event schema, evidence requirements, run closure, result/TTS dedupe,
compatibility and joint rollout tests. This is the Harness-side contract decision, not an
implemented or advertised capability. No OS repository changes are included. PR #294 fixes
input delivery; the complete overlapping-result → Lamp flow remains follow-up work.

## Validation (2026-09-24)

Mock/component coverage: both caller request shapes (with/without focus revision), A then B
before A ends, rapid Device A/B/C, exact-draft retry, lost key/write acknowledgments,
same-key retry, reconnect replay, separate receipts, native queue, daemon queue, writer/control
locks, dialog detection/release, session disappearance, and overlapping done/summary events.
The scoped CLI regression run passed 474 tests across 18 files (including Autonomous Device
transport/receipts, Claude/Codex normalizers, dialogs, orchestrator, and voice router); TypeScript typecheck passed.
The Python harness-use helper passed 28 tests, and `go test ./harness -run Voice -count=1` passed. OS helper/voice tests ran read-only; no OS source files were changed.

Earlier real engine smoke tests (before isolating the Device adapter) used isolated tmux panes and a temporary directory, the modified
`SessionInputController`, and production `sendToTmux`. No Harness daemon installation or
restart and no existing agent interruption were performed:

| Engine | Observed while A was still working | Final response |
| --- | --- | --- |
| Codex 0.156.1 | B appeared in “Messages to be submitted after next tool call”; empty composer available | `GARDEN_RED` after `sleep 20` |
| Claude Code 2.1.280 | B appeared above “Press up to edit queued messages” while `Bash(sleep 20)` was running | Response included `GARDEN_RED` and respected the no-file-modification instruction |

These earlier live smoke tests verify native engine behavior, but do not validate the final
Device-only adapter wiring. The final adapter is covered by mocks/component tests.
The live smoke tests verified terminal delivery and native behavior, not the full daemon
transcript watcher, Device transport, microphone/STT, or OS TTS. Start observation was supplied
by the test driver after seeing the busy terminal. Receipt correlation/reconnect/error paths
were tested with deterministic mocks. Other engine versions, engines, and Herdr were not
live-tested. A first diagnostic Codex run left an unsent draft; acceptance verification exposed
it, and the final run used a fresh pane to avoid that draft contaminating its input.
