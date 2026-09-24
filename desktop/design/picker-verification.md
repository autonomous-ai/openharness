# Picker verification — 2026-09-23

Scope: Cmd-N New Harness and Cmd-O Open Harness redesign, plus Cmd-P command
execution, editing and focus regressions.
This is a scenario audit, not a claim that every possible runtime state has
been tested. Line coverage is measured separately from native UI testing.

## Automated checks

- Final full desktop suite: **3,116 passed, 12 skipped, 17 failed**. The failures
  match the pre-existing CLI/auth/setup baseline; no new picker failure.
- Cmd-P-focused shuffled run (seed 926): **51 passed**, including eight added
  tests for pointer/keyboard handoff, unmatched queries, and native composition.
- Final integrated affected run (seed 928): **295 passed**, including machine
  entry into New Harness. Seed 927 passed 284. Earlier repeat
  runs (seeds 924 and 925) each passed **260**.
  Covers
  creation, draft ownership, Git/worktrees, accessibility, keyboard routing,
  mouse selection, both picker layouts, typography, previews and activity order.
- Native macOS integration fixtures: **9 passed**. First workspace, Cmd-T/Cmd-O
  creation, Store Open/Try, Models cancelling pending creation without a launch,
  edited defaults and destination, and
  immediate terminal input after creation, search/shared-view ownership, and
  Machines pending edits. Fake transport and in-memory state;
  these tests do not launch real agents or establish physical AppKit/IME input.
- Full analysis matches current main exactly: **15 existing findings**, with no
  new errors or warnings. Final changed integration/rendering fixtures report
  no issues; all 53 changed Dart files passed the format check.
- Normal macOS review build 9 succeeded after integration. The running review
  app was left open because approval review blocked quitting an unconfirmed
  conversation. Native tests ran in a separate test-only bundle, which exited.
- The opt-in screenshot walkthrough passed and rendered **133 fixture images**.
  It now uses the current fields, opens the advanced form for task editing,
  follows immediate choice acceptance, and uses main's current Models and
  Machines surfaces, including the Connection settings submenu.
  PR images are synthetic: [New Harness](../../.github/assets/pickers/new-harness.png)
  and [Open Harness](../../.github/assets/pickers/open-harness.png).
- The branch-width follow-up passes **39 affected rendering/customization
  checks**. Its new regression failed before the fix and verifies that long
  branch text is actually painted in full across prompt styles and text scales.

Coverage from the full suite (`flutter test --coverage`):

| File | Covered lines | Coverage |
| --- | ---: | ---: |
| terminal/terminal_text.dart | 15 / 15 | 100.0% |
| widgets/new_harness_form.dart | 526 / 539 | 97.6% |
| state/new_harness.dart | 1,347 / 1,438 | 93.7% |
| state/swarm_navigation.dart | 715 / 755 | 94.7% |
| state/swarm_search.dart | 391 / 406 | 96.3% |
| widgets/swarm_search_input.dart | 79 / 80 | 98.8% |
| widgets/swarm_switcher.dart | 573 / 663 | 86.4% |
| widgets/swarm_search_preview.dart | 284 / 303 | 93.7% |
| widgets/prompt_context.dart | 170 / 172 | 98.8% |

The form now uses a real Flutter text field, including its selection, composing
region and block cursor. Native computer use checks the rendered input in
addition to widget tests. This is not 100% line coverage or proof of every
possible runtime state; manual unfocused-editing fallbacks and legacy paths
remain uncovered. Clipboard error, empty, delayed, selection-change and
dismissal cases are covered. Native IME behavior and physical keyboard paste are not
established by injected Flutter key tests.

## Repeat audit

The additional 29 regressions found and verified fixes for:

- **Input-method composition:** Cmd-N previously accepted an agent on Return,
  erased the candidate on Escape, or moved the list on Tab/arrows while the
  input method was still composing. Candidate keys now remain with the input
  method. Tests cover Return, numpad Return, Escape, Tab, arrows and page keys,
  followed by an actual commit and acceptance.
- **Native command dispatch:** native workspace/menu and legacy search commands
  could bypass the composition check. Both picker regions now protect the
  active candidate before dispatch. This is tested through the native method
  channel, separately from normal Flutter keyboard routing.
- **Folder-browser exceptions:** a failed chooser callback escaped as an
  unhandled asynchronous error. The prompt now displays a retryable error and
  retains input focus. Late failure after dismissal has no stale effect.

The repeat also covers the first printable key, clicking the query editor,
delayed paste after a selection change, chooser cancellation/retry, Git
discovery failure/retry, remote-branch refusal with Worktree off, disposal
during Git discovery or installation, missing Store-harness installation,
installation failure/retry, unavailable catalogs, duplicate starts and
oversized carried tasks. Installation and creation tests use fake transports;
they do not install products on the user's machines.

The two pre-integration shuffled runs pass the same 260 tests, and the final
integrated run passes 295. The final full run has exactly the
same 17 failed test names as `harness-audit-final-tests-v3.jsonl`, with no added
or resolved failures. Native creation fixtures also passed again. This is
measured regression evidence, not a zero-bug or 100%-coverage claim.

## Scenario coverage

| Area | Scenarios |
| --- | --- |
| Project | History, full-path search despite single-line names, project action icons, new name with spaces, invalid/empty name, existing path with spaces, clone URL paste, validation, machine-specific history, browser callbacks, acceptance returns to fields |
| Machine | Local-only note, remote names, offline/unlinked refusal, machine switch, stale replies, project isolation |
| Agent | Every engine's controller options, saved draft, Store product entry, profile visibility changes, agent preview does not mutate launch defaults |
| Approvals | Every Codex, Claude, Cursor and OpenCode value, launch payload contract with CLI, unsupported agents, no implicit launch |
| Branch/worktree | Git/non-Git/pending/error states, existing/new/remote branches, worktree on/off, linked worktree, branch sanitization, no destructive switching, retries |
| Profile | Default/named selection, link/refresh callbacks, machine ownership, unsupported agents, hidden row navigation |
| Input | Arrows, Return/numpad Return, Tab/Shift-Tab, Page Up/Down, Escape levels, key repeats, Unicode backspace, Cmd-V/Ctrl-V, empty/error/delayed clipboard, focus retention |
| Layout | Wide/narrow, enlarged text, selected item visibility, active/inactive columns, terminal font metrics, muted metadata, no result count or key legend |
| Start | Explicit action only, failure/retry, lost-reply receipt, pending/busy state, exact destination, no duplicate agent, immediate terminal focus |
| Commands | Pointer/Return execution, no-match navigation and recovery, availability rechecked before execution, Cmd-N handoff, terminal focus restored on cancellation, native command composition guards |
| Open Harness | Activity order, unknown/tied timestamps, filtered and live results, preserved selection, preview, small windows, keyboard and pointer opening |

## Baseline failures

All 17 failures reproduce on current main (`306cbfdd`) in a detached checkout.
The six affected files produce **48 passed and the same 17 failures**; no
credentials or production connections are used. Artifact:
`harness-picker-main-final-baseline.jsonl`. The failures are:

- `workspace_account_lifecycle_test.dart`: 8 (sign-out, expiry, stale layout
  replies and sign-in during cleanup).
- `signout_recovery_test.dart`: 2.
- `workspace_expiry_screen_test.dart`: 4 (both themes and text scales).
- `local_cli_discovery_test.dart`: 1 (signed-out daemon supervision).
- `environment_setup_screen_test.dart`: 1 (install/retry to sign-in).
- `environment_recheck_timer_test.dart`: 1.

They concern the local daemon/auth setup path, not picker selection or creation.
The whole suite therefore remains red; this audit does not hide or relabel them.

The on-demand Linux CLI CI is also red on main. The branch run
[35938893689](https://github.com/autonomous-ai/openharness/actions/runs/35938893689)
had five failures, all reproduced by the independent current-main run
[35939411173](https://github.com/autonomous-ai/openharness/actions/runs/35939411173),
which had seven failures (4,245 passed, 63 skipped). They concern shell job-control
output, a file-watcher event, Grid process timeout, and Grid CLI discovery.
The picker branch changes no CLI or workflow files relative to this main commit.

## Reproduction

From `desktop`, using Flutter 3.47.2:

```sh
flutter test --no-pub --coverage
FLUTTER_TEST=1 flutter test -d macos --no-pub \
  integration_test/native_workspace_e2e_test.dart \
  --name 'native (first workspace|created|Store|Models|creation)'
flutter build macos --debug --no-pub --target lib/main.dart
```

Detailed run artifacts are under `/private/tmp/harness-audit-*` on the review
machine. Always rebuild `main.dart` after the native fixture replaces the app.

Final integrated artifacts (main `306cbfdd`):

- `harness-picker-final-full-fixed.jsonl`: 3,116 passed, 12 skipped, 17 failures;
  no loader errors. Failure names match the main checkout exactly.
- `harness-picker-final-shuffled.jsonl`: 295 passing affected tests, seed 928.
- `harness-picker-cmdp-final.jsonl`: 51 passing command/focus checks, seed 926.
- `harness-picker-main-final-baseline.jsonl`: 48 passed and the same 17 failures
  on main in a detached worktree.
- `harness-picker-native-final.jsonl`: nine native checks in the copied
  Harness Picker Verification app with a unique bundle ID and fake transports.
- `harness-picker-final-analysis.txt` and
  `harness-picker-main-final-analysis.txt`: the same 15 findings on both trees.
- `harness-picker-final-fixture-analysis.txt`: no issues in the last two edits.
- `harness-picker-pr-render-final-4.jsonl`: passing optional render walkthrough;
  133 images in `/private/tmp/harness-picker-pr-images-final-4`.
- `harness-picker-review-build-9.log`: successful normal macOS build.

Earlier repeat artifacts:

- `harness-picker-full-repeat.jsonl`: latest full suite and coverage.
- `harness-picker-repeat-seed924.jsonl` and
  `harness-picker-repeat-seed925.jsonl`: 260 passing checks per shuffle.
- `harness-picker-native-repeat.jsonl`: seven passing native creation fixtures.
- `harness-picker-repeat-analysis.txt`: no analyzer findings in the six latest
  changed source/test files.
- `harness-picker-edge-before.jsonl` and
  `harness-picker-edge-before-browser.jsonl`: failing regressions before the
  composition and browser-recovery fixes; `harness-picker-edge-fixed.jsonl`
  records the 44 passing form scenarios afterward.
- `harness-picker-review-build-7.log`: latest normal macOS build, restarted
  for hands-on review. The project draft was restored after testing.
- `harness-audit-final-tests-v3.jsonl`: final whole suite and coverage, including
  the branch-width follow-up, before the repeat audit.
- `harness-audit-final-random-tests.jsonl`: the randomized affected repeat.
- `harness-audit-native-final-tests.jsonl`: seven native creation fixtures.
- `harness-audit-analysis-final.txt`: no analysis issues in the changed input,
  controller, scenario tests and rendering tests.
- `harness-audit-review-build-5.log`: normal review app, including both prompt
  alignments and the final native-test findings.
- `harness-branch-space-tests-3.jsonl`: 39 passing branch-width, picker, header
  and customization checks; `harness-branch-space-analysis.txt`: no issues.
- `harness-audit-review-build-6.log`: normal app with the branch-width fix.
  Native review confirms full visible branch names, including
  `feat/centered-new-harness-palette`, in the available row space.

## Computer-use review

Used the actual macOS app through computer use, including pointer/accessible
clicks, typing, scrolling, native menus and the native folder chooser.

| Area | Observed result |
| --- | --- |
| Project actions | Clone, Open Folder and New Project have distinct icons. Typed paths, a public Git URL and a name with spaces return to the left fields after acceptance. No real repository was cloned. |
| Clipboard | Native context-menu Copy/Paste round-tripped a public Git URL, and Return accepted it. Computer-use Cmd-V/Cmd-A attempts timed out or did not deliver the expected shortcut; physical keyboard paste remains unverified. |
| Folder browser | Cancel returns to a usable path prompt; Open accepts the chosen existing folder and returns to the form. |
| Project scrolling | Scrolled beyond the previous nine-option limit into later history entries. |
| Machines | Clicked all seven available machine choices. Linked machines select; unlinked machines explain why. Only the local machine says This machine. After the final fix, selecting M2 clears the prior unlinked-machine warning. |
| Agents | Clicked all 14 core coding-agent choices, plus Terminal. Confirmed conditional approvals/profile rows. Store products are covered as option types, not a claim that every product was installed or launched. |
| Approvals | Clicked all five Claude, four Codex, two Cursor and two OpenCode draft choices. Retested that switching agents, or merely previewing another agent, does not expose another agent's approval values. Restored ordinary defaults; no agent was launched with altered permissions. |
| Branch/worktree | Searched and selected an existing worktree branch as a draft. Checked Worktree in both directions with pointer, Return and, after the fix, accessible clicks. No checkout was performed. |
| Store | Browse more harnesses opens the Store. Closed only the temporary Store test tab afterward. Store Open/Try and creation payloads also pass the isolated native fixtures. |
| Open Harness | Searched existing sessions, inspected previews and the activity order, and opened New Harness through the plus action. Prompt, plus and engine marks share a column. |
| Alignment | Both prompt layouts were inspected in the native review app. Widget tests measure Cmd-N text baselines and action-icon centers at normal and enlarged text, and Cmd-O prompt/leading-icon centers. |
| Branch width | The rebuilt Cmd-O shows the complete branch names in the user's reported rows. All prompt styles and normal/enlarged text also pass measured overflow assertions. |
| Real creation | With explicit permission, started a plain Terminal on M2 in `/private/tmp`, ran `pwd` and observed `/private/tmp`, then ran `exit`. No AI agent was started. The temporary test tab is gone. |

The build-7 repeat confirmed typed `/private/tmp`, `hello moon`, and a public
Git URL are accepted and leave the right-hand editor. Codex/Claude switching
again exposed the correct four/five approval choices and conditional Profile;
Worktree toggled both ways, M2 alone carried This machine, and Cmd-O filtering,
keyboard selection, activity ordering and full branch names remained correct.
The original project, Codex agent and Worktree setting were restored. No new
agent or project directory was created in this repeat.

Computer-use `paste` still timed out, and injected Cmd-A/Cmd-V did not reliably
produce the intended selection/paste. Native editing-menu attempts did not
resolve that ambiguity. Physical shortcuts therefore remain unverified; the
earlier successful context-menu round trip is not evidence that those shortcuts
work. The normal review app remains available for that check.

Cmd-P computer-use review also confirmed filtering to Keyboard shortcuts,
Return execution, Escape cancellation, recent-command ordering, and clicking
New Harness to hand focus into the setup form. Cancelling that form left the
existing workspace intact. The focused automated suite additionally verifies
no stray terminal input, no implicit launch, and native composition guards.

Findings fixed during the audit:

- Hand-drawn input was replaced with a real text field so native text editing
  and clipboard actions can work through the platform input connection.
- Accepted project prompts now close the right-hand editor instead of leaving
  the user stuck there; cancellation restores input focus.
- The choices list can scroll beyond its first nine entries.
- Agent preview state no longer supplies approval options for a different
  selected agent.
- A valid machine selection clears a prior unavailable-machine error.
- Accessible field activation now has the same behavior as a pointer click,
  including toggling Worktree.
- Cmd-N search text shares the prompt baseline; both pickers align the prompt
  with the action and session icons beneath it.
- Metadata uses measured content widths instead of equal shares. A long branch
  can use the room left by a short machine or repository name. Measurement also
  includes inherited text styling; genuinely crowded lines still shorten the
  repository before the branch. Tests inspect painted text overflow, not merely
  whether the full string exists in a Text widget.

Limitations and cleanup:

- The latest review app restart was blocked by automatic approval review
  because an active conversation had unconfirmed saved state. The app remains
  open; build 9 is ready for the next restart. The separately identified native
  fixture app exited after its successful tests.
- Live profile selection/refresh/link actions were blocked by automatic
  approval review because they may access credential files. Isolated profile
  tests cover the callbacks, selection and machine ownership. No claim of a
  completed live profile-link test is made.
- An existing iMac–Office Untitled Tab with a Grid icon also disappeared during
  test cleanup. The user authorized restoration. Automatic approval review
  initially blocked it; the subsequent app restart cleared the in-memory
  closed-tab history. The matching Office Grid session remains in Open Harness,
  but review rejected opening it because it could not establish that it was the
  same tab. Restoration remains incomplete; no existing session was deliberately
  stopped or deleted. The temporary picker QA app was successfully quit after
  explicit permission, and the final branch build is running.
