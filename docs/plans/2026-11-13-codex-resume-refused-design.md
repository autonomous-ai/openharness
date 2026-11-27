# A refused resume is not a confirmed one

## Problem

The nightly CLI end-to-end run (`.github/workflows/cli-e2e.yml`, run 43247147594) fails
`e2e/updates.e2e.ts:201`, "codex: an update drops resume … a resume says why it cannot". After an update
drops `codex resume`, `agent_resume` answers `ok: true, resumed: true` instead of `RESUME_FAILED`.

The cause is in `waitForResumedAgent` (`cli/src/lib/resumeStoppedAgent.ts`). It counts a resume as
confirmed the first time it finds the engine process in the row's pane. An engine that refuses its
argv (Codex's clap exits 2 on an unknown subcommand, Claude Code's Commander exits 1 on an unknown
option) still runs for an instant before it exits. When the first probe lands in that instant, the
resume is reported as reopening the same conversation, the row is marked ready, and the person is
told their harness is back while its pane is already a dead engine.

The restart path had the same cause and was fixed for it: `paneSwapDeps.waitForProcess`
(`cli/src/core/agents/swap.ts`) counts an engine as up only when the same process is still there
`SWAP_SETTLE_MS` (500 ms) later, and a host move (`lib/hostMove/moveAgent.ts`) wants two probes in a
row on the same process. The resume path never got the rule.

## Decision

`waitForResumedAgent` confirms a resume only when the same engine process (`sameProcessIdentity`)
is seen in the row's live pane on probes at least the settle time apart. Every check that runs on
each probe today (the row still current, its conversation and engine unchanged, a launch failure, a
gone or dead pane, an engine exit) keeps running between the first sighting and the confirmation,
so a refused resume that exits inside the settle time ends as `RESUME_FAILED`, "exited before
confirming the saved conversation", as the test expects. A different process on a later probe
starts the settle time again.

One rule, one constant: the settle time moves from `core/agents/swap.ts` into `lib/` (beside
`resolvePaneEngineProcess` in `lib/paneEngineProcess.ts`, which both callers already import) and
both the restart and the resume use it. Its value stays 500 ms. `lib/hostMove/moveAgent.ts` keeps its
own probe interval: its two-probes rule is the same idea at a 500 ms probe period already.

Nothing else changes: the budget (`RESUME_READINESS_BUDGET_MS`), the error codes and their copy,
the `resumed` flag, and the restart's fallback.

## Cost

A resume that does come back is confirmed about 500 ms later than today, as a restart already is.
No new polling: the existing 250 ms probe loop runs one or two more turns.

## Tests

- Red then green, unit (`cli/src/lib/resumeStoppedAgent.spec.ts`): a process seen on the first probe
  whose pane is dead on the next ends `RESUME_FAILED`, not confirmed. Today it is confirmed on the
  first probe.
- Unit: a process that changes between probes is not confirmed until the new one has settled.
- Existing unit tests that assume a confirmation on the first probe are updated to the settled rule.
- End to end: `e2e/updates.e2e.ts` "codex: an update drops resume …" on the CLI end-to-end workflow,
  which is where the failure was seen.

## Platforms

macOS, Linux and Windows: the resume path is shared. The e2e workflow runs on Linux and macOS.
