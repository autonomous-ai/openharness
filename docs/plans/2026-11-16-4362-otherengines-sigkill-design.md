# A discovery pass must not take the other engines' reader outage for a broken binding (#4362)

## The failure

`cli/e2e/otherEngines.e2e.ts` > "answers at once while the worker is killed or frozen …" times out waiting for the
live turn `during-SIGKILL` (CI, Linux, shard 5) or `during-SIGSTOP` (reproduced on macOS, 6 of 9 local runs). The
`engine-others` worker comes back in under a second each time. It is a product bug, not a test timing problem: the
turn typed while the worker is down never arrives live. It is folded away as history instead
(`[recap] … caught up a turn that ended unseen`).

## Cause (confirmed with temporary log lines, since removed)

1. The worker goes. `core/engines/otherStreams.ts` `disconnected()` marks each followed handle orphaned and calls
   `held(session, true)`. `main.ts` writes `OTHER_ENGINE_STATES.unavailable` ("Live view is waiting for its engine
   reader …") into the row's **`identityHold`**.
2. A discovery pass runs during the outage. The bystander Claude agent's launch and hooks trigger one, and so does any
   `agentReconciler.trigger()`. `core/agents/bind.ts` `bindObservedAgent` sees `identityHold && sessionId &&
   transcriptPath`. It takes that as a saved binding whose evidence could not be read and calls
   `registry.revalidateBinding`. That **clears the reader's hold**, sets `interpretationHold` and starts
   `followRegistered(…, { recovered: true })`, which is a reset attach.
3. That attach calls `otherStreams.open` while the worker is down. The open fails, so the session lands in `unopened`
   (`retryLater`).
4. The worker comes back. `connected()` resumes the orphaned handle from the byte the core held (`tail @459`, correct).
   It then also reattaches every `unopened` session: a full attach that opens a second stream **from the transcript's
   end** (`tail @756`), replaces the resumed handle, and folds the line typed meanwhile as history. No live
   `turn_started`/`turn_ended` is sent for it.

Whether the test fails depends on whether a discovery pass lands inside the outage. During SIGKILL the window is about
300 ms. During SIGSTOP it is the 4 s heartbeat timeout, so that case fails more often. Real users hit the same bug: a
turn typed in a Pi/OpenCode/… pane while their worker restarts never shows live, and its recap and notification come
as "ended unseen".

## Fix

The reader outage hold belongs to `otherStreams`. Only `otherStreams` sets it and only `otherStreams` clears it, with
its resume from the held byte. A discovery pass leaves a row that carries one of `OTHER_ENGINE_STATES`'s holds as it
is: no `revalidateBinding`, no recovered follow. The rest of the pass still runs. Every later step that meets an
`identityHold` already returns early, as it does today.

- Where: `cli/src/core/agents/bind.ts` `bindObservedAgent`, the `identityHold && sessionId && transcriptPath` branch.
  It skips holds whose text is one of `Object.values(OTHER_ENGINE_STATES)` (`engines/otherEngines.ts`, already loaded
  in the core's process, so `architecture.coreFiles.txt` does not change).
- The same cause elsewhere: every other place that clears an `identityHold` it did not set was checked. The OpenClaw
  screen path (`ours`) already leaves other holds alone. Hermes clears only `HERMES_SANDBOX_HOLD`. The read-hold
  release clears only holds an earlier pass's own read set (`readHolds`). `revalidateBinding` in `bindObservedAgent`
  is the one place that takes any hold. The planner confirms this list against the code.
- Narrowed after the final review (orchestrator, 2026-11-16): the pass leaves a reader hold alone only while the
  live reader still holds a stream for the session, waiting to resume it (`bindObservedAgent` asks through a new
  dependency, `followsLive(sessionId)`, which `main.ts` wires to the reader). A row whose reader gave up (six failed
  opens, no stream ever held) is revalidated as before. Otherwise the fix would take away the only rescue such a row
  has, and it would stay held until the daemon restarts.
- Nothing new is stored, synced or exposed. No new state, setting or log line is needed beyond what the fix requires.

## Tests

- **Unit, red first** (`cli/src/core/agents/bind.spec.ts`): a discovery pass over a bound row whose `identityHold`
  is each `OTHER_ENGINE_STATES` value calls no `revalidateBinding`, makes no attach, and leaves the hold on the row.
  An ordinary identity hold is still revalidated (the existing tests cover it).
- **End to end**: `otherEngines.e2e.ts` must fail on the old code every time, not now and then. Where a client can
  start a discovery pass (for example `theme_set`, which calls `agentReconciler.trigger()`), the test starts one during
  each outage, after the reader outage is visible and before the worker is back. It then expects the typed turn live
  and once, as it does today. If no such trigger can be fenced to the outage, the planner says so, and the unit test
  carries the red.
- `npm run test:core` (100% per file) for the touched core file.

## Verification

- The e2e file, repeated on Linux: a container locally if available. Otherwise the CLI end to end workflow
  (`cli-e2e.yml`) on the branch, which needs a runner turn from the orchestrator. Green on every repeat.
- Platforms: the daemon core on macOS, Linux and Windows. The changed code has no platform branch.

## Follow-ups

Not part of this pull request (orchestrator, 2026-11-16). Each becomes its own item. Three places in
`bindObservedAgent` set their own hold over the reader's: `bind.ts:342` (a failed retry), `:358` (a native read that
failed, or a refused register, in the pass) and `:503` (a Hermes sandbox with no path here). None clears the reader's
hold or attaches. But once their own reason clears, the row carries no hold while the worker is still out, so a reset
attach at that moment would open the second stream again. It takes a second failure inside the outage.

Also left as they are (final review, 2026-11-16): in `otherEngines.e2e.ts` the frozen-worker half's two log checks
(`toContain` of the "gone" and "back" lines) are always true, because the killed-worker half already wrote those lines.
Tightening them needs a polling wait. The refused-hook request in the same file has no timeout of its own (the test's
timeout bounds it).
