# Engine submission verification

Claude Code and Codex read whether a prompt core typed was taken through `Engine.submission`, in
their existing engine worker. Core keeps the writer, the lease, every Enter, the delivery receipts and
every verdict. A worker gets text and answers facts. It has no terminal handle and cannot type.

## What moved

| Reading | Was in | Now |
| --- | --- | --- |
| Is the prompt still in the composer, and is a composer drawn (session input's retry check) | `lib/sessionInput.ts` | `engines/kit/nativeSubmission.ts`, called by `engines/{claude,codex}/submission.ts` |
| The Device route's stricter reading (`❯` or `›` only, none drawn is unreadable) | `core/deviceInput.ts` | the same reader, field `nativeDraft` |
| A turn's prompt as recorded, unwrapped (Claude Code 2.1.283's `<pasted_content>` envelope) | `lib/sessionInput.ts` | `engines/claude/submission.ts` `echo`. Codex answers the whole text |
| Types while busy, the verify window, the Device's busy mode (Codex steering from 0.106) | constants in `sessionInput.ts`, `deviceInput.ts` | declared data, `engines/{claude,codex}/submissionPolicy.ts` |

The readings moved verbatim, so each route decides as it did before. Other engines keep the core's
reading (`engines/kit/submission.ts` holds the shared composer mechanics) until their own batches.

## Policy is data

Core reads the policy in line, as a message arrives. It needs it before typing (queue, or type at once)
and to arm the check's timer. A worker round trip there would sit in front of every message, and would
need a fallback for a missing worker. So, like the launch contract, the policy is declared data. Core
gets it injected (`SubmissionReader.policy`). The input modules do not import it, and
`architecture.spec.ts` keeps their closure free of Claude Code and Codex files.

## Private transport

`engine_submission_capabilities`, `engine_submission_read` (capture and prompt) and
`engine_submission_echo` (recorded prompt) are private methods on the engine links. They are absent
from the client router and require core's local owner identity. Core and the worker share the screen
reader's transport (`core/engines/snapshotTransport.ts`, `engines/worker/snapshotRequests.ts`). Each
result is fenced to the connection generation and to the session binding observed before the call.

| Bound | Value |
| --- | --- |
| Capture | 256 KiB of UTF-8 (the screen's) |
| Prompt or recorded text | 1 MiB of UTF-8 |
| Reply | 4 KiB |
| Concurrent readings | 8 per engine, at most 64 waiting in FIFO order |
| Deadline | 1 second, including queueing, capability negotiation and worker start |

A reply must be exactly three facts, or an in-range span of the text sent. Anything else is no reading.

## No reading is no evidence

- **Composer reading.** A missing, late or malformed reading is never an Enter and never a claim. The
  session input reports the message unconfirmed, as it already did for an unreadable screen. The
  Device route treats the pane as unreadable and keeps looking until its bound.
- **Readings that land late.** If the turn started, or the agent was rebound, while a reading was in
  flight, that reading decides nothing. A first bind is not a rebind: a message typed while its engine
  started is read under the record as it now stands, that launch bound since (`launchBound`).
- **Echoes.** An exact echo matches with no reading. A different record is the engine's to unwrap. Its
  delivery leaves the pane's state at once, so later writes never wait on the reading. Only the receipt
  waits: `started`, or `unknown`/`prompt_mismatch` when the reading says otherwise or there is none.

The parent-bound `HARNESSD_ENGINE_SUBMISSION=<master-pid>:1` capability selects the workers. Explicit
inline mode and older masters compose the inline readers. A failed worker never selects inline reading.

## Validation

- **Unit tests.** They cover the broker, both transports and the worker requests: bounds, wrong asker,
  malformed and oversized replies, deadlines, recycling, stale generations and in-place rebinding.
  Session-input and Device cases cover a missing reading, a throwing reader, a late reading and the
  echo's release.
- **`e2e/engineSubmission.e2e.ts`.** The fake CLIs take a `!latestart` prompt off the composer and hold
  its turn. The test then stops (Claude Code) or kills (Codex) the worker after its first reading, or
  fails the reading itself (Codex). Each time there is exactly one Enter, the turn starts once when
  released, core and the CLI process stay up, and the next prompt works. A third case runs the inline
  reader.
- **Unchanged suites.** The existing composer, input-safety, turns, Device and teams suites run
  unchanged.
