# Engine screen interpretation

Claude Code and Codex interpret terminal captures through `Engine.screen` in their
existing engine worker. Core captures the terminal and retains the input lease,
session binding, turn state and question lifecycle. A worker receives text and
returns facts; it has no terminal handle or authority to type, close or restart.

The facet reports the current prompt, draft, modal, question, message/team hold,
activity indicator and stopped-goal evidence. The engine folders own native
composers, takeover screens and activity footers. Shared ANSI and numbered-dialog
mechanics remain in `engines/kit`; other engines retain their existing readers.
Recorded screen fixtures are unchanged.

## Consumers

- Message admission checks the screen before a paste and again before Enter.
  A permission prompt appearing between those operations still withholds Enter.
- Question polling and answers await engine evidence. An unavailable reader is
  not an empty pane: existing questions remain open, and no answer is typed.
- Model control and retargeting use the reported pane for their preflight.
- Close checks and activity sampling consume reported facts. Core decides whether
  evidence establishes inactivity and whether a close is still authorized.

The question watcher keeps one pending capture/interpretation per session. Stop,
rebind and replacement invalidate it. Before a Harness prompt is typed, its
already-read question view becomes the next turn's baseline; a second late read
cannot mistake that turn's own question for a preceding one.

## Private transport and failure

`engine_screen_capabilities` and `engine_screen_read` are private methods on the
existing engine links. They require core's local owner identity with no client
connection. They are absent from the public client router. Version 1 allows:

| Bound | Value |
| --- | --- |
| Capture | 256 KiB of UTF-8 |
| Reply | 1 MiB including the envelope |
| Concurrent reads | 8 per engine, with at most 64 waiting in FIFO order |
| Core deadline | 1 second including queueing, capability negotiation and worker startup |

Core validates reply fields, pane flags, question rows and hold values. Each
result is fenced to the connection generation and the session/process/terminal
identity observed before sending it. No screen is cached across calls. A timeout,
malformed reply or changed identity supplies no evidence. Message and question
writes fail closed; close/activity checks remain unknown. The existing bounded
input queue may retry an unreadable screen, without typing anything first.

One change of identity is not a reason: the check before a message's Enter, and
the session input's checks after it (its screen and submission readings), read
under the record as it then stands when that record is the launch the message was
typed into, bound to its first conversation since (`core/engines/sessionBinding.ts`
`launchBound`). An engine draws its composer before its first hook binds the
conversation, so a message sent while it starts was otherwise left typed and
unsent or, its turn starting after the verify window, reported unconfirmed. A
rebind, a rotation, another pane or another process is read under the record as
typed, and fails closed.

Worker startup and async loading have a deadline and recycle the worker on a
timeout. A synchronous parser stall is contained by core's deadline and the
master's existing heartbeat/restart policy. It can cost that engine's other
facets, never core's event loop or the other engine worker.

The parent-bound `HARNESSD_ENGINE_SCREEN=<master pid>:1` selects supervision.
Explicit inline mode and older masters select compatibility during composition.
A failed worker never selects an inline parser. No worker starts for an empty
core merely to install this facet.

## Remaining engine isolation

This moves the screen reads described above; the full engine boundary remains in progress. Native model
picker drivers in `lib/runtimeControl.ts`, answer key selection and fingerprint
normalization in `lib/questionController.ts`, submission verification, hooks and
installers, launch/discovery/resume and native control connections still need
their own engine facets/process boundaries. Core must retain effect authority
and identity fencing when those drivers move.
