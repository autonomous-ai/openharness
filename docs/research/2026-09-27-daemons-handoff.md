# Daemons: handoff (2026-09-27)

Where the daemons work stands, what was decided, and how to continue. The feature itself is described
in `daemons/README.md` (the contract), `daemons/BRAIN.md` and `daemons/LEARNING.md`; the build spec for
the work in progress is `docs/research/2026-09-27-daemons-eggs-individuals-spec.md`; the release plan
is `docs/research/2026-09-27-daemons-rollout.md`. The review pages the owner approved (eggs, traits,
the lookbook as reviewed, the overnight report) are in `daemons/review/`: open them from disk in a
browser, and keep new review pages there too, never as hosted artifacts.

## Desktop release continuation (2026-09-28)

The owner subsequently authorised merging and releasing the desktop app with
the creature behind **Settings → Experimental → Focus-bar creature**. This
supersedes the earlier draft-only instructions for that work. PR #370 is
merged into `daemons`; this branch includes the desktop client and is integrated
with `main` through `0e4724cd`. The tab-close and launch-progress prerequisite
from #366 is included here; #367 is already on main.

The release uses the normal desktop tag workflow. The server, harness CLI,
phone and hn release steps, and the server allowlist, remain separate work.
The Experimental preview needs none of them: it uses a window-only test
collection, defaults off, and sends no creature or brain frames.

The first desktop release, `1.2.16`, shipped the preview with a pre-hatched tim.
The egg-first correction removes that seed: a new preview now starts with an
unhatched egg, follows the existing habit rules, and reveals a creature only
when the user opens the earned egg. The on/off setting still persists and the
collection still lives only for the window. Validation: 203 focused creature,
workspace and settings tests, six real-font render checks, and targeted Dart
analysis pass. The workspace regression exercises the whole egg → habits →
explicit hatch → reveal → name flow with synthetic activity.

Integration preserves current main's Share action, API models, account and
terminal fixes, strict question matching, trust groups and E2EE core. The
disabled-creature layout reference was measured independently on main
`0e4724cd`, including Share. Both native and Flutter bars place the creature
beside Share.

Current desktop validation: the full suite passed 4,164 tests and skipped 12;
its only two failures were the obsolete pre-Share layout reference. After
replacing that reference and incorporating the latest API-model changes,
all 453 affected desktop tests passed, with clean `dart analyze lib test`.
The native keyboard bridge passed 161 checks, viewer dispatch 9, and AppKit
1,100. Eight rendered workspace captures passed and the on/off layout was
inspected. Backend: 1,001 passed, 11 skipped, typecheck clean. Phone: 1,780
passed, 28 skipped. Generated contracts and all 13 card tests pass. All use
synthetic state; no live app or real tmux server was launched.

CLI typecheck is clean. The full run passed 7,045 cases and skipped 39; its
17 failures were an obsolete prefix-matching assertion and process-inspection
fixtures blocked by an additional macOS sandbox. The assertion now enforces
main's exact-question rule. All affected suites pass on recheck: 103 process
tests and 654 question, local-socket, encrypted-routing and API-model tests.
Vitest's temporary data/auth/runtime directories and the tmux stub stay in
place for the process checks.

## Decisions (all made by the product owner)

- **Drop 1 is `init`** (init(8), PID 1, the parent of every daemon): ten animals hiding in Unix names,
  drawn as FILLED plates in colour (line-printer density shading from shape models), animated:
  tim (the octopus: tmux improved), gnu, lynx, mutt (common); yak, gopher, bug (rare); tux, auk
  (legendary); beastie (secret). The old drops `unix` and `tty` are kept in the roster with
  `hold: true` and no dates: never drawn or shown. Decide on them later, as a step up.
- **tim is a species; every hatch is its own individual** with a server-rolled seed, traits and a
  serial, and a name the user gives it at the hatch. Traits read as flags
  (`tim -c coral --spots --glasses --fidgety`); each species has 6 colour families, its own
  markings, shape proportions and 3 rare extras; a card shows how rare the combination is
  (`1 in 2,130`). **Duplicates of a species are allowed** (identical individuals are practically
  impossible). The first 4 hatches are always a new species; after 8 hatches with no new species the
  next is new. No `diff` egg.
- **The status line** keeps one-line sprites (8 cells); an individual with a rare extra uses that
  extra's one-liner; a fidgety one animates twice as fast; colour and markings do not show there.
- **Eggs** are filled plates that crack as you EARN them (whole, a crack, across with a chip, split
  with light, ready with eyes peeking) and crack open when you OPEN them (rock, burst in the rarity's
  light, the top breaks in two and tumbles, the hatchling rises out). Each stage has a one-liner.
- **Server** work stays inside the zoo module (its own files, its own collections), all behind
  `HARNESS_DAEMONS` (off by default: routes not registered).
- **Naming**: user-facing text calls the harness CLI's background process `harnessd` so "daemon"
  stays the creature. Nothing is renamed; it is only a word in docs and a few UI strings.
- The original review kept PRs as `WIP:` drafts. The desktop release approval
  above supersedes that instruction for the desktop release stack.

## Continuation completed (2026-09-27)

Step 2 is implemented and validated. The server, CLI and phone WIP branches have been integrated
into `daemons`; the completed base has been integrated into desktop and hn. Keep all three PRs as
**WIP drafts**. Deployment and enabling the feature are still separate work under the rollout plan.

| branch | PR | state |
|---|---|---|
| `daemons` | #369 (base main) | Server, CLI and phone complete. Backend and CLI suites, phone suite, type checks, CLI builds and generated-contract check pass. |
| `daemons-desktop` | #370 (base daemons) | Complete. All 236 daemon tests and targeted analysis pass. The full suite has the same 32 unrelated failures documented below. |
| `hn-daemons` | #375 (base ship-hn) | Complete. 138 Rust tests, build, CLI type check, generated-contract check and isolated mock end-to-end suite pass. |
| `daemons-server`, `daemons-cli`, `daemons-phone` | none | Original WIP source branches; their work is integrated into `daemons`. Continue from the three PR branches above. |
| `fix/pane-close-launch-feedback` | #366 | Separate fix, draft. |
| `fix/stale-question-answer` | #367 | Separate question-answer safety fix, draft; land before #369. |

The main continuation commits are `d7bd9c2e` (base/phone/CLI), `e73b0c68` (desktop), and
`a48cb30e` (hn). The original WIP commits are preserved in their ancestry. Existing sibling
worktrees were left intact; continuation work used isolated branches and worktrees.

## What is complete

- **Server:** individuals with crypto seeds and species serials, UID-based pairing/naming, legacy
  seed-0 reads, the 256-individual limit, first-four-new and ninth-new draw rules. Repeated species
  hatch into new individuals without merging XP. Schema and race tests use the new contract.
- **Harness background process:** art is drawn by a worker in development and bundled builds,
  cached under the adapter data directory by source/species/seed, and pre-rendered for new hatches.
  Local requests require the Unix socket; phone requests and replies use sealed application frames.
  Disabling daemons drops pending work and stale results. The pair brain selects individuals by UID.
- **Phone:** earning eggs, opening animation, optional hatch names, individuals grouped by species,
  trait logs/flags/rarity, UID pairing and individual art with a recoloured species fallback. Late
  responses from a former account are discarded; malformed art is rejected. Art requests allow time
  for a first render and can try another connected machine.
- **Desktop:** completed the same egg/individual flows; corrected naming and pairing to send only
  the strict UID-based payloads, validated individual art responses, and fixed hatch notifications
  during widget construction. Regression tests name/pair two tims independently and compare all
  shared egg, trait, sprite and colour fixtures.
- **hn:** individual status sprites and fidgety timing, opening eggs, optional names, grouped
  collection/trait logs, selection and pairing by UID, individual art on the private socket, and
  named individual cards. Name prompts remain visible on small terminals; cards and collections
  scroll. Mock integration tests hatch/name two tims, switch their pairing, verify trusted art
  requests, exercise reduced motion and a 30-by-8 hatch, and check off/signed-out behavior.

Every client matches the shared `frames.json` references. The pinned E2EE `core.ts` is unchanged.
Desktop and phone screens were also rendered and inspected using mocked widget tests, including
the desktop two-tim collection and the phone at 320 points with large text. No real desktop app was
launched.

## Validation and how to repeat it

| area | latest result | command |
|---|---|---|
| Contract | current | `node daemons/tools/generate.mjs --check` |
| Cards | 13 passed | `node --test daemons/tools/card.test.mjs` |
| Backend | 993 passed, 11 skipped | `cd backend && npm test` |
| Backend types | clean after local Prisma generation | `npx prisma generate` then `npx tsc --noEmit` in backend/ |
| CLI | 6312 passed, 63 skipped | `npx vitest run --maxWorkers=1` in cli/, with the isolation below |
| CLI types/builds | clean | `npx tsc --noEmit`, `node build.mjs`, `node build-bundle.mjs` in cli/ |
| Phone | 623 passed, 24 skipped | Flutter 3.47.2, `flutter test` in mobile/ |
| Phone feature/E2EE recheck | 139 passed; targeted analysis clean | daemon tests plus encrypted-down-type tests; analyze daemon/phone/state files |
| Desktop full suite | 3988 passed, 12 skipped, 32 known baseline failures | Flutter 3.47.2, `flutter test` in desktop/ |
| Desktop final daemon suite | 236 passed; targeted analysis clean | `flutter test test/daemons test/daemon_workspace_test.dart test/daemon_review_render_test.dart test/daemon_off_test.dart` |
| hn | 138 passed; build succeeded | `env -u TMUX -u TMUX_PANE cargo test --offline`, `cargo build --offline` in tui/ |
| hn integration | all checks passed | `tests/e2e.sh` in tui/ against its mock, with fresh `HN_TMPDIR` and `HARNESS_TUI_BIN` pointing at the built binary |

The desktop full run preceded the final additional two-tim render/interaction test; that test and
the complete daemon suite passed afterward. The 32 full-suite failures match the previously
recorded main baseline: workspace_account_lifecycle x8, terminal_panel_presentation x4,
workspace_expiry_screen x4, signout_recovery x2, boot_flow_widget x4, machines_manager x4, and one
each in orchestrator, local_cli_discovery, environment_setup_screen, open_picker_rendering,
first_workspace and environment_recheck_timer. These are not new daemon failures.

Use a stub `tmux` first on PATH for unit/widget suites and unset `TMUX`, `TMUX_PANE`,
`RUN_REAL_TMUX_DISCOVERY` and `RUN_REAL_TMUX_STREAM`. CLI Vitest isolates adapter/runtime state in
its setup. The complete CLI suite passed with one worker; the parallel run hit timing-sensitive
failures, so use `--maxWorkers=1` for this validation. No production daemon is needed.

For hn's integration test, use the real tmux executable only through the script's private
`tmux -L harness-tui-e2e-<pid>` server, with `TMUX`/`TMUX_PANE` unset and `HN_TMPDIR` set to a fresh
temporary directory. The script supplies temporary HOME/adapter data, starts only its mock, and
cleans up its own server/processes. `E2E_SNAPSHOTS` keeps the screens and card. Widget screenshots
use `HARNESS_DAEMON_CAPTURE_DIR`.

## Experimental desktop test preview (2026-09-28)

On the desktop branch, open **Settings → Experimental → Focus-bar creature**.
This replaces the hidden activation shortcut; that binding and command are
removed. Experimental is the shared home for future feature toggles. The
switch saves its choice on this computer and applies it before the first frame.
It works signed in or out with no server rollout. It starts with an unhatched
egg, earned through the normal first-egg habits (a finished turn and any two
others), then opened explicitly. No creature is preselected. The panel
supports hatching, naming, pairing and temporary
motion/quiet settings. Only the on/off preference persists: the test collection
clears on window close, is never uploaded, and sends no creature/brain frames.
Individual artwork uses the bundled fallback. The old Account preview switch
remains removed. See `desktop/design/daemons.md` for behavior and validation.

Validation: 316 distinct Flutter tests passed across the focused settings,
startup, creature and keyboard suites. Targeted Dart analysis is clean. The
native keyboard bridge passed 161 checks and the AppKit titlebar passed 1,091.
Real-font settings renders cover light/dark at the minimum window size and
1.8× text; creature panel renders cover 640 and 1,280 points. Tests use synthetic
state and stubbed tmux. No live desktop app was launched.

The initial preview was distributed with the normal Desktop internal build
workflow, with self-update disabled. The later desktop merge/release approval
is recorded above. It does not permit launching a worktree app against real
state.

## What is left

Publish the approved Experimental desktop preview through the normal desktop
release workflow after landing the tested integration. The wider account-based
feature still follows `2026-09-27-daemons-rollout.md`: server dark, CLI, phone and
hn, then enable for the founder via `HARNESS_DAEMONS_USERS`. Those deployments
and the allowlist change are separate from this desktop release. Never launch
a worktree app against real state.

## Local review polish · 28 September

Start at [`daemons/review/index.html`](../../daemons/review/index.html); the
[review README](../../daemons/review/README.md) documents source templates, rebuilds, and
repeatable DOM checks. Eggs and individuals now use current art and rules, the old duplicate
simulator is retired, and historical material is labeled. The separate early companion reviews
on `pull-and-rebuild` also have a local index and native controls. No production code or runtime
state was changed for this review pass. DOM behavior was checked; browser visual inspection
remains unverified because the browser tool rejected local-file URLs.

## Safety rules for whoever continues

- Tests must never reach a real tmux server: unset `TMUX` and `TMUX_PANE`, use a private
  `tmux -L <name>` socket (setting `TMUX_TMPDIR` alone once killed a real server), or the stub tmux.
- Never launch the desktop app from a worktree: a debug build shares the real `~/.harness` state.
- Never touch the real Harness daemon, `~/.harness`, `~/.claude` or `~/.codex`; never type synthetic
  input into a client that can reach real harnesses.
- The repo is public: no personal paths, usernames or emails in commits.
- `core.ts` (the E2EE keystone) is hash-pinned: new sealed frames go in `applicationFrames.ts`.
- Follow the current release scope above; the earlier draft-only rule was
  superseded by the owner's desktop merge/release approval.
