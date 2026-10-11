# Upstream integration receipt: 2026-10-12

## Scope and immutable inputs

Source-only candidate. No merge of a pull request, installation, release, daemon restart, host linking, or live qualification is included.

- Fork parent: `5a2468088ae954e5b9398b5c6990bf9c9b3e7e37` (PR #47, sync through cb242cf4c).
- Upstream parent: `ecf8097ac995a9145ee1c1c6244974c9f961ae40` (autonomous-ai/openharness).
- Previous upstream integration / common ancestor: `cb242cf4c7d21b7b7cd95ac727fedb30317e9878`.
- Branch: `claude/sync-upstream-2026-10-12`, isolated worktree `.worktrees/sync-2026-10-12`.
- Merge commit: `89700605f`. Post-merge fix: `78f042ae7`.

The integration retains both parents with a merge commit. Do not squash away upstream ancestry when eventually merging this sync.

## Upstream gap: 37 commits

Clusters: harness-mcp / agent verbs / no-signin harness new (11 commits), desktop UX: sign-in in tab row, Agent Messages replacing Swarm remnants, Boss Mode dropped, native hook durability (10), Store Essentials + Jev for non-OpenRouter users + Harness Pro firmware (9), plus daemon/launch robustness work.

## Integration choices

- Adopt upstream's coherent engine contract, readers, live transport, runtime-profile, model-control, and screen refactor rather than selectively cherry-picking coupled pieces.
- Preserve the fork's Windows/WSL path and argv boundaries, local-mode recovery and revision-scoped supervision.
- Preserve local Grid profile identity, stale-target rejection without cloud namesake fallback, local-target cloud-readiness bypass, and unsupported-engine refusal.
- Combine start-tick process identity with boundary-faithful argv evidence. Add a clock-step / reused-PID regression.
- Combine DSH killed-job output filtering with stream-aware shell noise filtering, cancellation barriers and the stop trap. Add a mocked-child regression. Retain tmux security specs; explicitly guard POSIX-only fixtures on Windows.
- Combine upstream decision-model filtering with local-profile capabilities and empty states. Add desktop regressions for decision-only profiles and namesake rejection.
- Adopt upstream's creation-picker labels (`Your models`, `Shared with you`). This is a source-level UX adoption, not a new installed UI.

## Conflict resolutions (8 paths)

| Path | Resolution |
|---|---|
| `.github/workflows/website-checks.yml` | Kept fork's `OS_RELEASE_LOOKUP_TOKEN` env; adopted upstream's step name and agents-site checks |
| `cli/src/backendSocket.models.spec.ts` | Restored fork's local grid target tests (same-name targets, protocol mismatch rejection); adopted upstream's held-request behavior |
| `cli/src/lib/engineLaunch.ts` | Adopted upstream's `buildEngineInstallationArgv`, native executable command, and simplified `availabilityScript`; preserved fork's `cline --tui` fix |
| `cli/src/lib/sessionRepair.spec.ts` | Kept fork's 3 seam tests (process ownership, exact hinted transcript, two-candidate refusal); added upstream's fork-parent exclusion test |
| `cli/src/teams/service.spec.ts` | Deleted with upstream's Swarm removal (entire teams/ directory gone) |
| `desktop/design/workspace-status-bar.md` | Kept fork's Windows close-control reservation; adopted upstream's Agent Messages hover behavior |
| `desktop/lib/widgets/desktop_workspace_tab.dart` | Adopted upstream's GestureDetector+Stack+AgentMessages structure; preserved fork's `pinClose` for Windows close button visibility and title layout |
| `desktop/lib/widgets/task_palette.dart` | Kept fork's `routeNeedsConfirmation` (Jev router always needs explicit confirmation) |

## Post-merge fixes

- `78f042ae7`: Added `flutter/foundation.dart` import to `desktop_workspace_tab.dart` for `kIsWeb` and `defaultTargetPlatform` (used by the fork's `pinClose` logic).
- `cli/src/core/agents/retarget.spec.ts` and `cli/src/lib/initialLaunch.golden.spec.ts`: Added `argsBoundaryFaithful: false` to `DiscoveredTerminalAgent` test fixtures (upstream added this required field).

## Executed validation

Host: native Windows. Node via repo toolchain. Flutter 3.47.2 / Dart 3.13.2, `C:\Flutter\flutter`.

### CLI

```text
npm run typecheck    # tsc --noEmit, exit 0
npm run bundle       # dist/cli.js + dist/notify.mjs, exit 0
```

Focused seam tests (backendSocket.models, engineLaunch, sessionRepair):

| Source | Exit | Passed | Failed | Skipped |
|---|---|---|---|---|
| Baseline (main) | 1 | 205 | 68 | 7 |
| Merged | 1 | 206 | 68 | 11 |

Same failure set. The 68 failures are inherited Windows-host issues (missing `/bin/sh`, `CREATION_STORAGE_FAILED`, native file-mode assumptions). No new regressions. One additional pass and four additional Windows skips from upstream's new tests.

### Desktop

```text
flutter analyze --no-pub --no-fatal-infos    # 0 errors, 5 warnings (unused imports in test files), 50 infos
```

The 5 warnings are unused imports in test files that upstream's changes orphaned. They are informational and do not block compilation.

Focused tests (6 files):

```text
flutter test --no-pub test/new_harness_models_test.dart test/windows_runtime_test.dart test/wsl_preferences_test.dart test/companion_agents_test.dart test/harness_cli_runner_test.dart test/desktop_workspace_tab_test.dart
```

Exit 0: **118 passed, 2 skipped, 0 failed**. This includes the merge-resolved `desktop_workspace_tab_test.dart` (8 tests) which exercises the fork's `pinClose` behavior within upstream's new Agent Messages structure.

## Broader native CLI sample: not passing

The same five-file sample was run against candidate and baseline using temporary profile/state roots. Parent snapshots reused the candidate dependency installation, so this compares source under one toolchain, not each parent's independent lockfile installation.

Programmatic comparison found no candidate failing test name absent from the baseline's failure set. This is failure-name attribution, not proof of identical causes or a passing integration. Failures include missing `/bin/sh`, native Windows file-mode/security assumptions and architecture assertions. These checks remain red and require POSIX validation and any necessary separate baseline repairs before readiness or merge.

## Independent review and remaining gates

Claude Fable review not yet run. The following are still open:

- POSIX backendSocket specs, DSH/tmux and restart/retarget/swap execution. WSL has tmux but Linux Node was unavailable on PATH; no runtime installation was performed.
- Full CLI and desktop suites, CLI coverage gates, backend/mobile/TUI/website/firmware/OS validation and platform-native checks for imported upstream changes.
- Upstream CI toolchain confirmation, hosted component CI, Windows packaging, isolated packaged smoke, real-account compatibility and rollback qualification.
- Existing `cline` gaps in Grid/subscription maps are not repaired in this integration.

Keep this PR draft. Scoped review approval and focused checks justify publishing a source candidate, not merge readiness or an installed-version claim. Review stops for this pass at the scoped integration verdict; readiness requires the open validation gates above.
