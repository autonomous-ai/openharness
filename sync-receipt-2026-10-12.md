# Upstream integration receipt: 2026-10-12

## Scope and immutable inputs

Source-only candidate. No merge of a pull request, installation, release, daemon restart, host linking, or live qualification is included.

- Fork parent: `5a2468088ae954e5b9398b5c6990bf9c9b3e7e37` (PR #47, sync through cb242cf4c).
- Upstream parent: `ecf8097ac995a9145ee1c1c6244974c9f961ae40` (autonomous-ai/openharness).
- Previous upstream integration / common ancestor: `cb242cf4c7d21b7b7cd95ac727fedb30317e9878`.
- Branch: `claude/sync-upstream-2026-10-12`, isolated worktree `.worktrees/sync-2026-10-12`.
- Sync commit: `89700605f`. Post-merge fix: `78f042ae7`.

Correction (2026-10-13 review): `89700605f` has a single parent, `5a2468088`; upstream `ecf8097ac` is not an ancestor of this branch (`git cat-file -p 89700605f` shows one parent; `git merge-base --is-ancestor ecf8097ac HEAD` exits 1). The previous sync (PR #47) was a true merge and `cb242cf4c` is an ancestor of main. This sync therefore does not retain upstream ancestry on its own. A tree-preserving parent-only merge (`git merge -s ours --no-ff ecf8097ac`) would restore it without changing a byte; whether to add that before merging, or to accept content-based reconciliation at the next sync, is an operator decision recorded in the PR.

## Upstream gap: 37 commits

Clusters: harness-mcp / agent verbs / no-signin harness new (11 commits), desktop UX: sign-in in tab row, Agent Messages replacing Swarm remnants, Boss Mode dropped, native hook durability (10), Store Essentials + Jev for non-OpenRouter users + Harness Pro firmware (9), plus daemon/launch robustness work.

## Integration choices

- Adopt upstream's coherent engine contract, readers, live transport, runtime-profile, model-control, and screen refactor rather than selectively cherry-picking coupled pieces.
- Preserve the fork's Windows/WSL path and argv boundaries, local-mode recovery and revision-scoped supervision.
- Preserve local Grid profile identity, stale-target rejection without cloud namesake fallback, local-target cloud-readiness bypass, and unsupported-engine refusal.
- Combine start-tick process identity with boundary-faithful argv evidence. Retain the clock-step / reused-PID regression already on main.
- Combine DSH killed-job output filtering with stream-aware shell noise filtering, cancellation barriers and the stop trap. Retain the mocked-child regression already on main. Retain tmux security specs; explicitly guard POSIX-only fixtures on Windows.
- Combine upstream decision-model filtering with local-profile capabilities and empty states. Retain the desktop regressions for decision-only profiles and namesake rejection already on main.
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

Exit 0: **118 passed, 2 skipped, 0 failed**. This includes the merge-resolved `desktop_workspace_tab_test.dart` (8 tests), which compiles the fork's `pinClose` code inside upstream's new Agent Messages structure. Correction (2026-10-13 review): those tests do not exercise the Windows branch of `pinClose`. Flutter's test runner sets `FLUTTER_TEST`, under which `defaultTargetPlatform` resolves to Android, and neither the test nor its support files override the platform, so `pinClose` evaluates false and the tests expect the close control hidden at rest. The Windows close-pin behavior is unverified by these tests.

## Broader native CLI sample: not passing

The same five-file sample was run against candidate and baseline using temporary profile/state roots. Parent snapshots reused the candidate dependency installation, so this compares source under one toolchain, not each parent's independent lockfile installation.

Programmatic comparison found no candidate failing test name absent from the baseline's failure set. This is failure-name attribution, not proof of identical causes or a passing integration. Failures include missing `/bin/sh`, native Windows file-mode/security assumptions and architecture assertions. These checks remain red and require POSIX validation and any necessary separate baseline repairs before readiness or merge.

## CI repairs after the sync (2026-10-13)

Hosted Linux CI on `0d284b491` failed three jobs; all three were merge-resolution mistakes, none a flake.

- `cli-tests (1)`: `engineLaunch.spec.ts` probed the same resolved command twice because the restored health probe omitted main's duplicate check. Fixed in `8cf45d5bc`; `availabilityScript` now matches main's function exactly.
- `desktop-tests (ubuntu-22.04, 1)`: the fork's 48 px projects toggle overflowed the tab row by 25 px beside upstream's new sign-in control at the 340 px test width. Fixed in `71fefd593` with compact density and a shared button-width constant.
- `desktop-tests (ubuntu-22.04, 2)`: a fork-only boot-flow test expected no "Sign in" text, which upstream now renders in the tab row. The assertion now rules out the browser sign-in wall and requires the tab-row button. Fixed in `71fefd593`.
- `4b85d0265` merges `origin/main` (PR #49, test-home isolation) with no conflicts.

CI run 38433831314 on `4b85d0265` passed every job including `ci/required`.

## Independent review and remaining gates

Review round 2 (Codex gpt-6.1-sol, read-only, 2026-10-13, head `4b85d0265`): all eight conflict paths compared against upstream `ecf8097ac` and main `5a2468088`; the named fork seams and upstream changes are present. The three repair commits are scoped correctly and the revised boot-flow assertion still excludes the browser provider wall. PR #49's isolation protections survive the merge. Privacy scan of 78,673 added lines and all commit messages found no owner-specific disclosure. Two claim-integrity blockers were raised against this receipt (the ancestry sentence and the `pinClose` test claim) and are corrected above. The following validation gates remain open:

- POSIX backendSocket specs, DSH/tmux and restart/retarget/swap execution. WSL has tmux but Linux Node was unavailable on PATH; no runtime installation was performed.
- Full CLI and desktop suites, CLI coverage gates, backend/mobile/TUI/website/firmware/OS validation and platform-native checks for imported upstream changes.
- Upstream CI toolchain confirmation, hosted component CI, Windows packaging, isolated packaged smoke, real-account compatibility and rollback qualification.
- Existing `cline` gaps in Grid/subscription maps are not repaired in this integration.

Scoped review approval, hosted CI on the final head and the focused checks justify merging the source sync; they are not an installed-version claim. The open validation gates above remain for the next installed-version qualification.
