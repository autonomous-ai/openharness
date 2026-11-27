# A Hermes in the default home closes again (#4361)

## The failure

`cli/e2e/hermesTerminalRecord.e2e.ts` > "follows a resumed Hermes through /new without failing it" fails on `main`:
`agent_delete` answers `STOP_UNCONFIRMED` a few hundred milliseconds after
`[delete] hermes did not exit on request — SIGTERM`.

## What was measured

- Deterministic on Linux: the file run alone in a Docker container (Debian bookworm, Node 24.22.2, tmux, zsh,
  `E2E_BUNDLE=1`, fake engines only) fails this case 5 of 5 times at `71a2a71e5c`. On this Mac it passes; the CI
  shards, which are Linux, fail it.
- Bisect, same container, this case alone: `b5ae71d412` (the last green scheduled run) passes 2/2, `d5202f76b9`
  (#4339) passes 2/2, `c3f590a247` (#4342 "Move other-engine live parsing into its worker") fails, and every commit
  after it that was run fails (`8fcfa7de5c`, `71a2a71e5c`). #4348, #4350 and #4352, named in the issue, are not the
  cause; the issue's last green branch runs were on an older base.
- Instrumented run (debug lines added in the container only): the stop's last identity check refuses because the
  row's `runtimeIdentity` changed while the stop ran, from `hermesHome: null` to `hermesHome: <the default home>`.
  Process, routes and binding are unchanged. The write is `registry.setHermesHome`, called from the core's
  `storeOf` (`cli/src/core/main.ts`, inside `createStoreOf`) on the attach that follows the bind.

## The cause

Before #4342, the core found a Hermes session's store with `lib/hermesHome.ts`, which writes a home onto the row only
when it is not the default one: `hermesHome: null` means "the default home", the convention every Hermes path keeps
(`core/agents/hermesTerminal.ts` returns a home only when it is not `defaultHome`; a relaunch exports
`HERMES_HOME` only for a row that has one, `engines/nativeLaunch.ts`).

#4342 moved that lookup into the other engines' worker (`engine_stream_store`, `cli/src/engines/others/streamRequests.ts`).
The worker answers `home` always: the row's own home, the one it found, or the default. The core's `storeOf` then
calls `registry.setHermesHome` with it, which fills an empty home. So every Hermes in the default home now gains
`hermesHome: <default>` on its first attach.

That write is harmless on its own, but the attach runs on demand, once the worker has started, which in this test is
while `agent_delete`'s stop is running. `stopAgentService.ts` compares `runtimeIdentity` (which includes
`hermesHome`) before and after the engine exits, so it reads the filled home as "the harness changed while pausing"
and refuses the Close. A person sees a Close of a Hermes agent fail ("Try stopping again") when they close it soon
after it starts.

## The change

The worker answers `home` only for a home it **found** by looking the session up, and only when that home is not the
default one (`sameHermesHome`, so a symlinked or trailing-slash spelling of the default counts as the default). It
gives no `home` when the row already named one (the core already has it) or when it fell back to the default. The
`store` it answers is unchanged in every case.

This restores the pre-#4342 contract in the one place that broke it. No change to the core: `main.ts` stays wiring,
and `storeOf` keeps writing whatever home the worker reports, which now is only a profile home the row did not know.

Rejected:
- Skipping the default home in `main.ts`'s `storeOf`: logic in `runForeground`, which the CLI rules forbid, and the
  core would need the worker's notion of the default home.
- Letting the stop's identity check accept a home filled in while it runs: it touches the Close fence for every
  engine, and the saved record of the stop would then lack the home a resume needs. Not needed for this failure (see
  Out of scope).

## Tests

- Red first, at the layer where the behavior lives: a unit spec of the worker's `engine_stream_store` handler, in
  `cli/src/engines/others/streams.spec.ts`, which already builds `otherStreamRequests` and asks as the core does.
  Each case sets `env.HERMES_HOME` to a folder of its own (`mkdtemp`), restores it and deletes the folder after: on
  Windows `env.HERMES_HOME` is the person's real `%LOCALAPPDATA%\hermes`, which `vitest.setup.ts`'s throwaway `HOME`
  does not move. A profile is `<default>/profiles/<name>`. Each `state.db` is written as
  `cli/src/engines/hermes/home.spec.ts` writes it, and `forgetHermesHomes()` runs between cases because the home
  listing is cached:
  - the session in the default home: the answer is its store and has no `home` (fails today: it has one);
  - the session in a profile home only: the answer names that home;
  - a row that passes its own home: its store, no `home`;
  - an unknown session: the default store, no `home`.
- End to end: the failing case in `hermesTerminalRecord.e2e.ts` is the red check; it passes after the change, with
  the rest of the file. No new end-to-end test.

## Verification

- `hermesTerminalRecord.e2e.ts` on Linux: on GitHub with `cli-e2e.yml` (Run workflow, the branch; a runner turn from
  the orchestrator), or the same file alone in the Linux container used above. With this change in the container, the file's
  seven cases outside "in a sandbox" all passed. A filtered trial ran six of them 3 of 3 times, and a whole-file run
  passed all seven. The three sandbox cases cannot run in an unprivileged container; they run on GitHub.
- The unit spec above, and `npm run typecheck`.

## Out of scope

A profile (non-default) home learned while a stop runs can still change the stop's identity in the same way. That
race predates #4342 (the core's own lookup wrote profile homes too), is rarer (a profile agent's home is usually known
from its terminal record or its process at bind), and a fix touches the Close fence. It goes to the maintainers as a
proposal, not into this pull request.

The process repair at bind (`cli/src/lib/sessionRepair.ts`, used from `core/agents/bind.ts`) can also name the
default home. That predates #4342 and runs when a session is first bound, not on an attach in the middle of a stop,
so it is not this race. It is left as it is.

The only consumer of the answer's `home` is `core/main.ts`'s `storeOf`. The older-master path (`services/inline.ts`)
runs the same `otherStreamRequests`, so this one change covers it too.

## Follow-ups

- A proposal to the maintainers: a profile (non-default) Hermes home learned while a stop runs still refuses that
  Close (see Out of scope). The fix belongs to the Close fence and the stop's saved record, not to this change.

## Platforms

The worker runs on every platform; the failure was seen on Linux. Tests: macOS (unit, typecheck) and Linux (the
end-to-end file).
