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

## Eager extraction acceptance

Former-code commit `9393bd13951f391bc8f31c9abc56a18e40ee3efe` records 28 launch observations before any production move. Its JSON fixture remains byte-for-byte unchanged. Native version and model control now live in eager `engines/launchControl.ts`, generic `engines/kit` mechanics, and OpenCode's declared version/SQL/API facts. Compatibility re-exports retain existing imports. Create, fork, relaunch, retarget, external admission, request validation and the composition root no longer load or consult the optional OpenCode module for those operations. The import test verifies that importing native control does not resolve a binary or load interpretation.

Validation on Node 22.23.2, macOS, UTC, private homes/daemon/tmux:

- TypeScript and architecture pass. Core/services: 1,896 tests, every per-file coverage metric 100%; harnessd: 265 passed and one intentional skip, every per-file metric 100%.
- 396 affected tests pass, including the unchanged OpenCode, launch-shapes and DSH launch-shapes goldens and existing native version/SQLite/API specs. Fault assertions cover an unavailable or stalled reader; the architecture check prevents reintroducing a lazy launch import.
- Four real-bundle cases remove or stall the OpenCode chunk on v1 and v2. Create, fork, restart, retarget, Stop/resume and continued sibling operation pass. The v1 cases replace the executable with v2 while the daemon is running: relaunch drops the saved v1 named-agent flag even though interpretation never loads. The unwritten native-store fixture holds Close with its checkpoint reason and keeps the agent active; this is not evidence of v2 checkpoint support.
- Thirteen mutations fail assertions: version threshold/probe/parser, SQL field/transaction, API provider field/variant, actual create/fork version wiring, actual retarget model dispatch, lazy relaunch/retarget dependencies, and the composition root consulting optional code. A wrong mutation source marker was corrected before the remaining cases were exercised; setup failures were not counted.
- Initial e2e fixture failures were corrected: the fake help now declares its supported permission flag, own-login retarget uses the wire's `clearGrid`, and a fake conversation with no stored rows is expected to hold Close. No production guard was weakened to make them pass.

[Runtime measurements](2026-10-09-opencode-launch-cost.json) compare frozen main and candidate bundles in baseline/candidate/candidate/baseline order with two OpenCode launches in each cold daemon. Core ready latency was 1,109–1,140 ms on main and 1,213–1,215 ms after extraction; core CPU at ready 300 versus 320 ms; RSS 76.8–77.0 versus 77.8–78.8 MiB. Cold request latency was 541–952 versus 522–540 ms and warm requests 93–94 versus 89–92 ms. Two samples and the 10 ms `ps` CPU resolution support only a reference comparison, not a speed claim or a new threshold. Reproduce with `OPENCODE_COST_ROOT` naming a folder containing `baseline/cli.js` and `candidate/cli.js`, and run `e2e/opencodeLaunchCost.e2e.ts` alone under the same Node/tmux, UTC and private tmux environment.

The native-preparation, mutation-ownership and durable-hold work above remains separate and required. Also audit Close's OpenCode checkpoint: it currently selects the v1 `session`/`message`/`part` tables, while v2 stores new conversations separately. An unavailable or unsupported checkpoint must keep holding the live agent with its reason.

All 44 broader core, fork, machine and race end-to-end cases also pass. Independent read-only review found no blocking regression in the extraction; its requested architecture assertion now detects the former two-argument `engineNow` call and is exercised by a composition mutation. Main advanced only in OS and website files during validation; those changes were integrated without changing CLI inputs.
