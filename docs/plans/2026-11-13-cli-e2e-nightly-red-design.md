# CLI end to end: test builds carry their notify.mjs (design)

## Intent

The nightly **CLI end to end** workflow (`.github/workflows/cli-e2e.yml`) has been red on main since the 2026-11-12
run. Six of its failures share one cause; this change fixes that cause. The other causes found in the same runs get
their own pull requests (see Non-goals).

Failing tests (runs 43247147594 on main and 43400659690 on a branch, same errors in both):

| File | Tests | Error |
|---|---|---|
| `cli/e2e/eagerIdentity.e2e.ts` | Copilot resume with missing / stalled optional modules | `NATIVE_LAUNCH_HELD`: Harness's hook script is missing (`…/notify.mjs`) |
| `cli/e2e/hermesAdmission.e2e.ts` | Hermes admission with missing / stalled optional code | same |
| `cli/e2e/eagerHooks.e2e.ts` | missing shared hooks (claude) / stalled shared hooks (codex) | timed out waiting for all selected native hooks to finish |

## Cause

Since #3954 and #3994 (2026-11-11), the daemon refuses to install an engine's hooks when the `notify.mjs` they would
run is not there (`cli/src/engines/kit/notifyHooks.ts`, `requireHookScript`). It looks for it beside the running
`cli.js` (`hookScriptCandidates`). That product behavior is right: a hook line naming a missing file fails the
engine's own hook.

These three tests write a changed `cli.js` (a lean bundle with one chunk removed or stalled) into a new folder and
start the daemon from it, but leave `notify.mjs` behind in the build folder. Their daemon then refuses every hook
install. `cli/e2e/harness/release.ts` already has `buildWithLean`, which writes the `cli.js` and copies `notify.mjs`
beside it (added for the same failure in `eagerOpenCode.e2e.ts`); these three tests do not use it.

## Goals

- The six tests pass again, with no change to what they assert.
- A test that starts a daemon from its own `cli.js` with no `notify.mjs` beside it fails at once with a message that
  names the cause, rather than a hook timeout or `NATIVE_LAUNCH_HELD` minutes later. This covers every later case of
  the same cause (AGENTS.md: a fix covers every case of the same cause).

## Non-goals

- No product change: the refusal in `notifyHooks.ts` stays as it is.
- The other causes from the same runs, each its own pull request: Codex resume reported as confirmed after the engine
  refused it (`updates.e2e.ts`), Codex Ctrl+Z under bash (#1612, `suspend.e2e.ts`), `swarmV4Journey.e2e.ts` expecting
  remove to stop the session, `superTabChannel.e2e.ts` expecting the agent's name in its post, `harnessWatch.e2e.ts`
  passing a time as a frame index, `updateHostile.e2e.ts` opening its filler outside its try. The agent browser
  `TMPDIR` failure is already fixed on main (#4267).

## Anti-goals

- Copying `notify.mjs` inside `IsolatedDaemon` on the test's behalf: it would hide a test layout no build produces.
- Skipping or loosening any assertion.

## Approaches

1. **Use `buildWithLean` in the three tests, and add a guard in `IsolatedDaemon`** (chosen). Each test builds its
   folder with the existing helper. `IsolatedDaemon` checks, at each start with a `scriptPath`, that a `notify.mjs` sits
   beside it, and throws naming the path when it does not, next to the `assertHooksContained` check it already makes.
   Fixes the six and stops the next one.
2. **Only switch the three tests to `buildWithLean`.** Smallest, but the next test that lays out its own `cli.js` hits
   the same 10-second timeout with no hint; the seventh case of this cause.
3. **Have `IsolatedDaemon` copy `notify.mjs` beside any `scriptPath`.** Hides the layout mistake and writes into
   folders tests own (an update test's install folder holds a release's own `notify.mjs`). Rejected.

## Design

- `eagerIdentity.e2e.ts`, `hermesAdmission.e2e.ts`, `eagerHooks.e2e.ts`: replace the `mkdirSync` + `writeFileSync(…,
  withLean(…))` lines with `buildWithLean(dir, bundle, files)`; drop imports left unused.
- `cli/e2e/harness/daemon.ts`: before spawning with `options.scriptPath`, require `notify.mjs` in its folder; else throw
  `Error("<scriptPath> has no notify.mjs beside it: its daemon refuses every hook install (lay it out with buildWithLean)")`.
  Most tests that pass a `scriptPath` already have `notify.mjs` beside it: the run's bundle (`E2E_BUNDLE_PATH`), a
  release folder (`*_FROM`), or a copy (update, reexec, compat, masterIpcExit, messagesSkew, releaseRehearsal,
  updateHostile, eagerOpenCode, lean). Two lay out `cli.js` alone and change too, so the guard passes for them:
  `eagerRepair.e2e.ts` (same pattern as the three, switched to `buildWithLean`) and `nodeReferences.e2e.ts` (copies the
  built `cli.js` into its install folder; it copies `notify.mjs` too, as an install has it). `opencodeLaunchCost.e2e.ts`
  is opt-in and takes built folders from outside, which carry `notify.mjs`. The builder re-checks every caller of
  `IsolatedDaemon.create` with a `scriptPath` (`cli/e2e`, `harness/fleet.ts`) before adding the guard.
- Red then green: the six tests are the failing tests; they fail locally on this Mac before the change and pass after.
  The guard gets its own red tests (a unit test of the check, and one e2e test of its place in `start`), added after
  the layouts are fixed so the green files stay green.

## Verification

- Locally on this Mac: the three files with `npm run test:e2e -- <files>` against the run's bundle, red before and green after.
- On GitHub: one **CLI end to end** run on the branch (asked of the orchestrator first, shared runners); the six tests
  pass. Other shards may still fail on the causes listed in Non-goals.

## Left to the builder

- The exact wording of the guard's message and where in `start` it sits, as long as it throws before the spawn.
