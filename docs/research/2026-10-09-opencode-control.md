# OpenCode launch control and the remaining safety boundaries

The daemon separation audit found launch decisions still behind `loadEngine('opencode')`: create, fork, relaunch, retarget, external preflight, request validation and `lib/launchOverrides.ts`. The composition root also asks the loaded engine for its version. Native launch control must be eager; history and interpretation remain optional.

The next extraction records the former code first. `opencodeLaunch.golden.spec.ts` exercises the actual create, fork, relaunch and retarget paths with v1, v2, unknown and missing binaries, named agents and remembered models. It records pane argv and scripts, environments, native SQLite/API commands, and their order relative to process replacement and publication. Linux, UTC and time are pinned; homes and binaries are disposable fixtures, Node and tmux paths are placeholders, and no real pane or process is changed. The existing launch-shapes and launch-argv goldens cover grid/saved-API construction and the other engines. Hook installation and failure isolation need their own acceptance before the control work is complete.

Independent read-only review identified the following existing problems. Extracting their functions does not fix them, and a passing compatibility golden is not evidence that these failures are safe.

## Native preparation

- The version probe synchronously blocks core for up to five seconds and caches unknown results by executable identity. A transient failure can last until the binary changes. A launch also asks the version independently for flags, named agents and plugins. Use an asynchronous eager probe and one executable/version snapshot per launch; imports themselves must never probe or write.
- Plugin installation logs and swallows write/removal failures while preflight reports success. An incompatible v1 plugin can survive a v2 preparation. Verify the result, preserve unrelated plugin files, and hold the launch with the reason when preparation is unavailable.
- Create and external admission prepare OpenCode hooks, but fork, restart, retarget and owned restore do not. All dispatch paths need the same preparation and version snapshot, including upgrades after daemon startup.
- Startup awaits the shared optional hooks module with no deadline. Readiness must not depend on that module. Required native hook installation belongs in eager declarations/mechanics; optional interpretation can recover separately.

## Mutation ownership

- Retarget retains a mutable row over awaited preparation and native model writes. A pane control pin is not proof that the process and conversation still match. Copy the target identity and fence every mutation, retry, signal and publication against current ownership and cancellation.
- An unreadable v2 model catalogue currently allows a write. A failed readback can repeat `session.switchModel` after the first write may already have succeeded. Preserve an unconfirmed result and reconcile with reads; do not blindly replay an ambiguous mutation.
- Verify the v1 two-row transaction and rollback behavior, including missing rows and no-user-message sessions. A native model change followed by failed respawn must not be described as if nothing changed.

## Durable holds and staged preparation

Boot restore retains the service-unavailable marker, but create, fork, restart and retarget can discard it. Creation receipts can persist an unavailable service as a failed request. Instruction writes and a live config directory can also precede a later models/Store refusal. This requires a separate shared launch follow-up: retain the intent and reason, stage writes until dependencies are ready, and resume only under current authority. A live process left running and an inert held launch need distinct outcomes.

The final audit must include missing/stalled OpenCode and hooks chunks in the real bundle, readiness and unrelated Stop while preparation is pending, unreadable/unwritable plugin paths, catalogue outage, lost replies, mismatched readback, and Stop/rebind at each awaited boundary. Deliberate mutations must break both caller wiring and the declared facts and fail assertions.
