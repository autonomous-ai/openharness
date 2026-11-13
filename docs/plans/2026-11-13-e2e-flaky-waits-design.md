# Three flaky CLI end-to-end tests: harnessWatch, the full-disk fill and the browser's pane

The nightly CLI end to end workflow (`.github/workflows/cli-e2e.yml`) has failed on main since 2026-11-12
(run 43247147594). Three of its causes are flaky tests whose wait or setup is wrong, not the product.
A flaky test is a bug: each is fixed where the wrong behavior lives, with a test that fails first, and neither is
skipped or loosened.

## F. `cli/e2e/harnessWatch.e2e.ts` misses the idle event

**Seen.** Job `e2e (8)`: `timed out after 45000ms waiting for harness_event idle; last frames: [connected,
harness_watch_result, harness_event x4]`. Four events arrived (working and idle twice), so the second round's idle
came and was not seen.

**Cause.** `LocalClient.waitFor(test, ms, what, since)` (`cli/e2e/harness/client.ts`) takes `since` as an index into
`client.frames`: it first looks for a match in `frames.slice(since)`, then waits for new frames. The test passes
`since = Date.now()` (about 1.7e12), so the slice is always empty and only frames that arrive after the call count.
`told('idle')` is called only after `await told('working')` resumes, a microtask later. The `ws` receiver delivers
every frame of one socket read in one synchronous loop, so when working and idle arrive in one read, idle is pushed
before its waiter exists and is never seen.

**Change.**
1. The test marks positions as indexes: `tool.frames.length` before it sends the message, and the idle wait starts
   at the working event's own index, so idle is found whether it came before or after its waiter and an idle from an
   earlier turn cannot count. Same for the second round.
2. `waitFor` and `waitForBinary` refuse a `since` that is not an index of their list (an integer from 0 to the
   list's length) with an error that names it, so a timestamp fails at once by name instead of flaking.

**Red test.** A unit spec of `LocalClient` in `cli/src/testing/` (where specs of e2e harness helpers already live, e.g.
`corePerf.spec.ts`), run by the default suite, against a stub WebSocket server: `since = Date.now()` is refused. Fails today: the check does not
exist. Every other caller already passes an index (checked with grep).

## G. `cli/e2e/updateHostile.e2e.ts:514` throws ENOSPC out of `fill()`

**Seen.** Job `e2e (macOS, full disk)`: `ENOSPC: no space left on device, open '.../v/filler-tail'` at
`updateHostile.e2e.ts:514`, called from `:590` ("the disk fills between the canary and the swap").

**Cause.** `fill()` writes `filler` until ENOSPC, then opens a second file, `filler-tail`, to take the last blocks.
That `openSync` creates a file on a volume that is already full, which itself can fail with ENOSPC, and it sits
outside the `try`, so the error escapes and fails the scenario. `cli/e2e/diskfull.e2e.ts` has its own copy of
`fill()` that guards the tail's open but not the filler's: two copies of one helper that drifted.

**Change.** One helper in `cli/e2e/harness/`, used by both files, replaces both copies: it fills a volume by
appending to `filler` and then `filler-tail`; each open and each write is inside the `try`; only ENOSPC means full,
and any other error is thrown (today the tail's bare `catch` swallows everything). Appending keeps the repeated
`fill()` in updateHostile's third scenario topping the volume up.

**Red test.** A unit spec in `cli/src/testing/` with `node:fs` stubbed: creating the tail fails with ENOSPC and the
helper returns; a non-ENOSPC error is thrown. Fails today: the helper does not exist (and the copy it replaces
throws).

## H. `cli/e2e/agentBrowser.e2e.ts` 'the browser moves with its pane' waits for the wrong turn

**Seen.** Runs 43400659690 (PR #4266) and 43254356483 (branch `0xken15/sandbox-hooks`): `timed out ... waiting for
agent_deleted (the engine)`. The engine was handed one 29-byte prompt, `One turn before the exit!exit`, and never
exited.

**Cause.** Once the browser is ready, the daemon types its ready line (`READY_LINE`,
`cli/src/services/agentBrowser/notices.ts`) into the agent as a turn of its own. The test then sends its message and
waits for the first `turn_ended` of the agent, which can be the ready line's turn. The test's message is still being
typed into the engine's input when the test types `!exit` there, so Enter sends both as one prompt: no exit, no
`agent_deleted`. The same wait, the first `turn_ended` after the browser is ready, is in two more scenarios of
`agentBrowser.e2e.ts` (the purge and 'a browser left on follows its agent') and in `agentBrowserPodman.e2e.ts`; there
the next step (purge, restart, stop) can run while the test's own turn is still under way.

**Change.** `LocalClient` gets one way to take a turn and wait for it: send the message, then wait for the
`turn_started` whose `userMessage` is that message, then for the `turn_ended` after it. All four call sites use it,
so `!exit` is typed only after the test's message was sent and its turn ended.

**Red test.** The same unit spec as F's, against a stub socket that plays a `turn_started`/`turn_ended` of another
message first: the call returns only the `turn_ended` of its own message. Fails today: the method does not exist.

## Approaches

- **Fix only the failing call sites** (an index instead of `Date.now()`, the tail's open inside the `try`, a
  `userMessage` check in 'the browser moves with its pane'): smallest, but the same mistakes stay easy to repeat,
  diskfull's copy keeps its unguarded open, and the other three browser waits keep the same race.
- **Fix the call sites and the helpers they use (chosen):** the `since` check makes the misuse fail at once, one fill
  helper replaces the two copies, and one turn helper fixes all four browser waits. A few lines more; it covers every
  case of the same cause.

## Non-goals

No product code changes. No retries, longer timeouts or skips. The nightly's other causes belong to other sessions.

## Verification

On this Mac, isolated throwaway daemons and the e2e fake backend, no production:
- `harnessWatch.e2e.ts` alone, run 10 times in a row, all green.
- `agentBrowser.e2e.ts` (fake Podman) alone, 10 times, all green. `agentBrowserPodman.e2e.ts` needs real Podman and
  runs only in the workflow's `agent_browser_podman` job: run once from the branch with the orchestrator's go.
- `DISKFULL=1`, `diskfull.e2e.ts` and `updateHostile.e2e.ts` filtered to `a full disk|an update on a disk that
  fills`, as the workflow's macOS job runs them (hdiutil volumes), green.

A run of the CLI end to end workflow from the branch only with the orchestrator's go (shared runners).
