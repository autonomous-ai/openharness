# Engine question control

Claude Code and Codex navigate question dialogs through `Engine.questionControl` in their
supervised engine workers. Core still owns question identity, remembered requests, the user's
answers, permission policy, reviewed labels, stale-question checks and the input lease.

## One approved step

`lib/questionController.ts` matches a captured question against the request and the answer the
person supplied. It snapshots the answer map and reviewed metadata before awaiting a screen read.
It passes one approved `QuestionStep` to a control port bound before that first read:

- Select one row, retaining the observed submit behavior.
- Toggle the rows needed for a multiple-choice answer, then advance.
- Open the observed text row and enter the approved text.
- Submit a review reached by this answer, after checking completeness.

The native facets own key selection, text entry and repaint timing. The worker receives neither
the pending answer map nor a terminal locator. Codex's digit-then-Enter question behavior and
digit-only approval behavior remain distinct, as recorded in the existing fixtures. Other engines
keep their legacy navigation until their own migration batches.

## Revocable effects

Core grants each step a random token tied to the original agent, conversation, terminal binding
and worker connection. `core/engines/controlTransport.ts` shares the previously tested model-control
binding, deadline, capacity and reconnect rules. It does not contain native navigation.

Question grants allow only finite key operations and the exact text approved for that step.
No capture, registry or general core-query capability is granted. Requests and replies have strict
private v1 envelopes and a 1 MiB ceiling; text is limited to 32 KiB and excludes terminal control
characters other than newline. Existing reviewed voice answers retain their stricter 1,200-byte rule.
Each engine admits sixteen concurrent steps (one per agent's dialog), each with a 30-second deadline, at most 128 writes and
one outstanding host request. A host query has a five-second deadline. Worker deadlines recycle
that worker, never core.

Disconnect, replacement, completion, timeout, rebinding, overlapping host calls or a failed terminal
write revokes the grant. Terminal writes use the existing guard after lease validation and in the
tmux queue/buffer/Enter path. Failure does not resume navigation through a replacement worker or
fall back inline. A command already dispatched to the OS can have an uncertain effect and is not
automatically retried; a new user answer is a new intent.

The parent-bound `HARNESSD_ENGINE_QUESTION_CONTROL=<master-pid>:1` capability selects the isolated
path. Explicit inline mode and older masters use the same core broker with inline native facets.
The compatibility wrapper `lib/askQuestion.ts` retains direct-fixture APIs outside normal core's
import closure.

## Validation and continuation

Existing recorded-question/controller fixtures cover matching, permission policy, exact reviewed
sets, free text, review screens and refusal behavior. New broker and worker tests exercise malformed
messages, wrong service/token, exact-text enforcement, limits, aborts, timeouts, worker replacement,
late writes and immutable reviewed answers. Model-control tests exercise the extracted shared
transport without changing its contract.

`cli/e2e/engineQuestionControl.e2e.ts` runs the routed path on a real private daemon. The fake engine
signals the worker the moment a chosen keystroke of one step reaches it, so each stop lands inside the
step: Claude Code's worker killed or frozen between two toggles of a multi-select, and Codex's between
the digit and its Enter. The answer fails as ANSWER_FAILED, as does one sent while no worker runs
(nothing is typed inline instead), no later key of the step reaches the pane after the worker is gone
or replaced, the other engine's agent finishes a turn and core answers requests during the outage, core
never restarts, and a different new answer then succeeds. A worker frozen past the step's deadline is
woken with its next key due, and core refuses that key. Explicit inline mode answers end to end, and a
window's `engine_question_control_*` or `engine.questionControl` request is refused even while a worker
holds a live grant.

The handoff checkpoint must retain actual receipts and distinguish passing checks from missing
evidence. Before merge, finish a paired question-workload CPU/RSS/latency comparison, review the final
source, and complete automatic CLI CI. Question E2E uses private homes, tmux and deterministic CLI
fixtures, not real model accounts.

The full extraction remains incomplete: submission verification, hooks and their installers/admission,
launch/discovery/resume, and native control connections still need migration and a final import/runtime
audit. This question-control batch does not claim to complete that objective.
