# Phone app, overnight 2026-09-27 → 28

The goal set at bedtime was to make the Harness phone app world class. That meant:
- test coverage and edge cases;
- fixing the bugs found;
- improving the UI/UX;
- a panel of AI users playing the target audience, whose feedback drives the fine-tuning.

That audience is people with strong consumer-app taste who now run Claude Code and Codex and want to manage them from a phone.

This work is tracked in [PR #398](https://github.com/autonomous-ai/openharness/pull/398), from branch `phone-overnight-polish`. The user has authorized merging it to `main` and installing a local iPhone build for manual review; the PR records the merge status. No store release is included. **The last section is the handoff for the mobile team.**

## In one screen

- **Tests:** 486 → 1,555 overnight → **1,614** after continuation and main integration (plus 25 render tests skipped in the ordinary suite; all 25 pass when rendering is enabled). The whole suite passes. `flutter analyze` is clean outside `third_party/`.
- **Coverage:** 50.4% → 87.0% overnight → **88.7%** (18,450/20,790 lines; 88.8% before integrating main's branch/PR-history feature), not counting `third_party/`.

  | Area | Coverage |
  |---|---|
  | e2ee, api, auth, notify, theme | 100% |
  | viewer | 99.2% |
  | p2p | 98.5% |
  | core | 96.3% |
  | usage | 95.0% |
  | ws | 94.8% |
  | analytics | 92.1% |
  | widgets | 89.8% |
  | phone | 89.0% |
  | shared | 81.2% |
  | state | 83.0% |
  | demo | 79.9% |
  | terminal | 84.4% |
  | logging | 87.6% |
  | settings | 100.0% |
  | clipboard | 88.9% |

- **Dead code:**
  - 52 files and about 17,100 lines the phone never runs were deleted. Each deletion was proved with tree-shaken AOT builds for iOS and Android.
  - The desktop's half of `AppNotifier` was cut: 7,100 more lines, 13 files. `viewer` is now non-nullable.
  - The continuation removes the remaining handoff list: unused dial routing and grid navigation, local plaintext transport, the unauthenticated local API mode, local-file opening and the CLI log channel. The cleanup was prepared and tested in a disposable copy before application.
- **Bugs:** 41 real bugs fixed, each with a regression test (listed below). The continuation fixes queued log notifications after disposal and misleading local-daemon explanations for phone backend failures. Main integration also fixes encryption of branch/PR-history requests.
- **Test safety:** every test now runs in a throwaway home (`test/flutter_test_config.dart`), so no test can read or write a developer's `~/.harness`. `test/test_home_guard_test.dart` pins this.
- **Offline verification:** HTTP clients are blocked by default in tests. API and WebSocket tests now use in-memory transports, including handshakes, token refreshes and reconnects. The simulator tour launches `SampleApp` directly without reading a saved account.
- **Review panel:** the four requested personas completed rounds 3 and 4. All now score the app **8+/10**; the round-4 mean is **8.05/10**. [Round-3/4 report](2026-09-28-phone-panel-rounds-3-4.md).

## The review panel

Five personas each reviewed renders of every phone screen. In round 2 they also saw an 18-screen walk-through of the real app, recorded on the iOS simulator in sample mode.

| Persona | Lens | Round 1 | Round 2 | Round 3 | Round 4 |
|---|---|---|---|---|---|
| Maya | design lead on two iconic consumer apps | 6 | 7 | 7 | 8 |
| Theo | founder of a Things/Superhuman/Linear-style productivity app | 6 | – | – | – |
| Priya | runs 6–10 Claude Code and Codex harnesses across three machines | 6 | 7 | 7.5 | 8.2 |
| Sam | first-time user with consumer taste; Claude Code on the Mac, no Harness | 6 | 7 | 7 | 8 |
| Jordan | former Apple Design Award juror (HIG, accessibility) | 6 | 7 | 7 | 8 |

### Round 1 findings that all five agreed on, and what happened

| Finding | Outcome |
|---|---|
| The terminal is clipped at the right edge (a blocker, 5/5) | **A fixture bug, not the app.** The render test seeded a 46-column screen into a 42-column view. Fixed the fixture; the simulator walk-through confirms the live app fits. |
| The mic covers the agent's input line | **Kept.** Your decision: "the current mic location is perfect". |
| Voice sends words you never saw | **Kept.** Your decision: auto-send. |
| "Harness" confuses as a noun | **Kept.** A harness is a session: one agent, many harnesses. It is now taught where it is first met: New ("A harness is one session of an agent"), How Harness works, and the "N harnesses" count. |
| Every other computer needs its own password | **Fixed.** A locked computer unlocks by scanning its Add Phone QR; the password stays as the fallback for servers. |
| Two different set-up screens | **Fixed.** There is one set-up page (the website's download menu). Signed in, it also watches for the computer and pairs by scan. |
| Settings duplicates and unclear labels | **Fixed:** "Phone name", "App colors", the lone "usage" header removed, readable heading contrast. |
| VoiceOver can't read the terminal or reach Find or New | **Fixed.** |
| The scroll-position tag "[22/39]" is jargon | **Removed.** Your call: "we don't need the scrolling indicator". |

### Round 2 fixes

- **The sample.** Its agents stopped parroting your words back ("On it — run the tests…"). This matters because the "how it works" video is recorded from the sample. It also announces permissions the way the daemon does ("Approve Bash command: psql …") rather than "Do you want to proceed?", and names its computer "studio" rather than the fixture id "sample-studio".
- **The line above the mic** hides while you read history; it used to print over the rows being read.
- **The key strip** opens on its own keys. It used to scroll to the agent's `shift+tab` hint on every open, which pushed **esc** off the edge while the agent said "esc to interrupt".
- **VoiceOver:** it can cancel a voice take, hears "Asking: …" when a question opens, and reads the line above the mic as a live region.
- **Copy:** "5 harnesses", "Leave the sample" (both places), "Choose an agent and a project".
- **The scan page** says the link is end-to-end encrypted, which was the first-time user's trust gap.
- **New:** the panel-driven pass exposed branch, approvals and profile. **The user rejected this in the build-46 review:** restore collapsed `Options [+]`, matching desktop. This is a user decision, not an open design proposal.
- **Settings:** Usage, Computers and Phone name join the account group. There is no lone Usage card, and Phone name is no longer filed under *terminal*.
- **"Stop this harness…"** stays small at the foot of the menu but is now red; faint grey read as disabled.
- **Form rows** put the label on the value's first line; "approvals" used to sit beside its note.

### Rounds 3 and 4

- The attention line has a fixed yellow dot, solid backing and readable text aligned to the terminal gutter.
- Chooser sheets fit their content, align headings with rows and support native drag dismissal.
- Field placeholders have stronger contrast, verified numerically in a regression test.
- Unlock uses the desktop's verified `Machines ▸ computer ▸ Set password` route and identifies the password as the Harness phone password.
- The sample is prominent on Welcome and setup, and labels pickup, Focus, Find and New. Its terminal input hint fits beside the mic.
- The Settings avatar is neutral. Incomplete sign-in codes visibly disable Sign in. New's compact keyboard summary puts the project first.
- All 25 screens were rendered again. The sample simulator walkthrough was recorded again and now captures 19 states, including the written help page.

These are AI persona reviews of offline artifacts. They establish the visual score; live VoiceOver, real-device speech and production connection behavior require separate verification.

## Bugs fixed (each with a regression test)

**Sign-in and pairing**
- A scanned pairing code no longer outlives its session.
- A refresh in flight cannot bring back a signed-out session.
- A rate-limited refresh no longer signs the phone out.
- No sign-out from a closed socket, and no hot loop on a refused token.
- Linking never throws, so Unlock and Pairing cannot hang for good.
- Pairing times out on a dial that never opens, and keeps a lockout's retry time.
- A scanned code whose account cannot be read no longer hangs on "Pairing…".
- Pairing by password names this phone to the computer (it was "harness link").

**Connection**
- A replaced relay connection can no longer speak for its machine.
- A replayed welcome or rekey cannot roll the group key back.
- A data channel closing under an open link no longer throws uncaught.
- A second `terminal_ready` for one open no longer leaks a heartbeat.
- A locked state file no longer stops a machine reconnecting for good.
- Phone backend failures no longer tell the user that a local daemon is down or restarting.
- Branch/PR-history requests are encrypted and held until the handshake completes; the machine no longer rejects them with `E2EE_REQUIRED`.
- A terminal switched off by an unanswered negotiation is asked about again.

**Terminal and Focus**
- The terminal follows a keyframe that swaps its screen, not only a rebuild from above.
- A pager guess reopened after its stream died no longer takes the terminal.
- A tap reopens a dead stream.
- The kept screen of an agent read a moment ago is shown, not a blank page.
- A conversation open in a terminal is refused in words, not as a lost reply.
- A question's refusal of a voice answer says why, not "terminal not taking input".
- A resume the machine never received is sent again, not checked forever.
- A stopped harness stays on the phone; the minute's sync sees every field it draws.

**Layout**
- An emoji where a name is cut no longer crashes Focus or Settings.
- The Focus title and the sample's end card no longer overflow at large text.
- The welcome screen and pairing scroll instead of overflowing.
- New's dock scrolls instead of overflowing on a small phone.
- The attaching skeleton shows with Reduce Motion on.

**Dialogs**
- A field inside an app dialog gets the focus it asks for, and the keyboard.
- A rename answer landing as the dialog closes no longer pops the page under it.

**Usage and notifications**
- A reset time past what a DateTime holds no longer drops a machine's usage.
- A partial or failed usage cycle keeps the figures it could not renew.
- One failed start of the notification plugin no longer silences the launch.
- A notification body is never cut through the middle of an emoji.

**Privacy and logs**
- The debug log keeps the length of a harness's first task and a Find search, never the words.
- Log redaction blanks plain-base64 bearer tokens, Basic auth and sign-in codes in URLs.
- An analytics event trimmed while on the wire no longer takes the next one with it.
- A busy analytics visit keeps `analytics.json` within a minute of the clock.
- A queued log update no longer notifies a disposed stream.

## Decisions already made by the user (do not re-propose)

- Voice keeps auto-send.
- The mic stays where it is; the terminal is full screen under it.
- Keep the word "harness" (harness = session; one agent, many harnesses). Teaching it is fine; renaming it is not.
- No scroll-position indicator. The "api-fix asking" label stays.
- New Harness keeps Model, Approvals, Profile, Branch and Worktree under collapsed `Options [+]`. Default creation must not ask users to revisit these settings.
- Branch and Worktree are **separate rows**, matching desktop Cmd-N. Branch picks the branch; Worktree toggles a separate working folder without changing that choice. Model offers the subscription and available models on own/shared machines; Profile applies to Codex on its subscription.
- The Agent chooser shows the full scrollable list, with recently used engine choices first; no `more` gate.
- Opening the Project chooser focuses its always-visible search field; opening Find focuses its search field too.
- PRs only. The user merges and releases; nothing is merged or released without their explicit word.

## Handoff for the mobile team

### State

- **TestFlight 1.0.0 (49)** was uploaded on 2026-09-28 using the existing Xcode account after the user authorized TestFlight release. Apple accepted the upload and began processing it. The latest merged mobile source passes **1,643 offline tests**; production archive/IPA builds pass, and analysis is clean outside the same 12 third-party infos. [Release PR #409](https://github.com/autonomous-ai/openharness/pull/409) records the release and prepares build 50. See the [release notes](../../mobile/RELEASE.md) for the non-blocking WebRTC symbol warning.
- [PR #402](https://github.com/autonomous-ai/openharness/pull/402) implements the user's desktop-parity request: separate Branch/Worktree controls and a Model chooser, all under collapsed Options. **1,636 tests** pass (28 conditional render skips), **28 screen renders** pass, and refreshed coverage is **88.9%** (18,622/20,957 lines, excluding `third_party/`). Analysis has only the same 12 third-party informational findings. Signed build **48** is installed and its version verified on the review iPhone. [Brief team handoff](2026-09-28-mobile-team-handoff.md).
- The user's build-46 review and a [twelve-hour change audit](2026-09-28-mobile-ui-change-audit.md) record the four corrections above, merged in [PR #401](https://github.com/autonomous-ai/openharness/pull/401) for local iPhone build **47**. They supersede conflicting panel recommendations. Follow-up validation: **1,621 tests** and **25 renders** pass; analyzer clean outside the same 12 third-party informational findings. The original overnight coverage figures were measured on build 46. The user requested an iPhone install only, not TestFlight.
- [PR #398](https://github.com/autonomous-ai/openharness/pull/398) merged the overnight polish, cleanup and main integration. The user explicitly authorized the merges and local iPhone installs for manual review; no store release was requested.
- Merged into it and finished: `coverage-rest` (coverage engineer), `desktop-cut` (the desktop's half of the notifier), and the phone-screens and state-core engineers' passes. No engineer is still running.
- Never commit `mobile/ios/Runner.xcodeproj/project.pbxproj`. It carries the local signing team and stays modified in the worktree.

### Code map for the mobile team

The runtime is a standalone Flutter package in `mobile/`; agents run on linked computers, never on the phone. Shared code was copied from desktop and now differs substantially: port fixes deliberately rather than replacing directories.

| Location under `mobile/` | Responsibility |
|---|---|
| `lib/main.dart`, `lib/app_shell.dart` | Startup, authentication and root shell |
| `lib/phone/` | Focus terminal, Find, New, voice, approvals, pairing and settings pages; `PhoneShell` owns one navigation stack |
| `lib/state/` | `AppNotifier`, machine/agent lifecycle, terminal panes and desk synchronization |
| `lib/terminal/`, `third_party/xterm/` | Terminal sessions/rendering, input, links and media; xterm is a patched vendor copy |
| `lib/{auth,api,viewer,e2ee,ws,p2p}/` | Sign-in/linking, backend API, encrypted relay and WebRTC transport |
| `lib/{core,settings,shared,theme}/` | Models, preferences and shared UI foundations |
| `lib/demo/` | Offline sample runtime, including its own entry point |
| `test/`, `test/render/`, `integration_test/` | Regression tests, 28 screen renders and the sample simulator tour |

The full tests run from `mobile/` in the monorepo: protocol checks read CLI source, and a branch-history UI test imports a desktop font fixture. Desktop-only routing, local CLI transport and grid controls have been removed. The new `session_work_page.dart` preserves main's current branch and PR-history UI.

### How to run

From `mobile/`, with Flutter 3.47.2:

- **Everything:** `flutter test`, about two minutes. For coverage, `flutter test --coverage`, then read `coverage/lcov.info`.
- **Screen renders:** `PHONE_RENDER_DIR=<dir> flutter test test/render/phone_screens_render_test.dart`. It writes 28 PNGs, including expanded Options and Model selection. The fixture terminal is 42 columns, so canned lines must fit in 42.
- **Walk-through on the iOS simulator, sample mode only:** `HARNESS_JOURNEY_OUT=<dir> flutter drive --driver=test_driver/journey_driver.dart --target=integration_test/tour_test.dart`.

### Rules

- **No real account, device or daemon from any automated or AI-driven input.** Personas and engineers drive only sample mode, renders and the simulator in sample mode.
  - No test may use the network.
  - Engineers do not push; the lead merges their branches.
- Unset `TMUX` in tests.
- Every git and gh action is done as `deehw`.
- No private data in the repo (no home paths, real usernames or emails).

### Continuation completed

1. Opened PR #398 with this report as its starting summary.
2. Ran the four-person panel twice more. Round 4: Maya 8, Priya 8.2, Sam 8, Jordan 8; all would use it daily.
3. Completed the round-2 attention-line, sheet, placeholder, Unlock-copy, sample-discovery and avatar work.
4. Removed every item in the remaining dead-code list: `SpokenTaskRequest` and its unused routing stream/handler; `selectAutonomousEnv`; `hasNavigationRail` and unused pin/grid-keyboard methods; `paneFocusRequest`, `seedSwarm`, `openAgentFromDial`; `DialState.restore`; local plaintext WebSockets; ApiClient's no-auth local mode; the local-machine terminal-file branch; and `cliLog`. Caller searches and the CLI's local-only event routing established that these paths cannot serve the phone. The explicitly approved patch was tested before and after application.
5. Added coverage in the requested order: settings persistence/reset; clipboard failures; logging lifecycle; terminal preferences, downloads and link opening; sample requests/lifecycle; and layout restoration/write coalescing. Every new real bug has a regression test.
6. Final validation: **1,614 tests pass**, 25 conditional render skips; **88.7% line coverage** excluding `third_party/`; analyzer clean outside `third_party/`. The separate 25-render run and 19-state sample simulator tour pass.

7. Integrated current `main`, retaining branch/PR history while keeping the phone cleanup. The protocol parity test caught an unsealed `git_pull_request`; a codec regression now verifies handshake gating and encryption. The numeric scroll-position tag remains removed, with its existing scrolling test passing.

### Remaining observations

- The [round-4 report](2026-09-28-phone-panel-rounds-3-4.md) records optional finishing details: retain computer/project identity in asking Find rows, improve long-value spacing and compact agent labels, and simplify recovery/glossary copy. None blocks the panel's 8/10 threshold.
- Future coverage work can concentrate on the remaining state and sample branches. The desktop-only paths removed in this continuation should not be restored merely to exercise them in tests.
- The proposals below remain exactly as left by the user. No proposal has been implemented or reclassified as approved.

### Proposals that need the user's decision (do not build without it)

- **Push notifications** that say what a harness wants, with Yes/No as notification actions. Priya and Sam both named this as the thing that makes the app daily.
- **A one-line Focus header** (`fix-login · studio:web`), pinned while reading history. The branch line would move to the title sheet.
- **Dynamic Type.** `lib/app_shell.dart` pins text scaling to the in-app "Text size", so iOS Larger Text is ignored. Jordan rated this a blocker.
- **Settings duplicates:** "Text size" beside the terminal's "Size", and "App colors" beside "Colors". All four personas asked for one of each. They mirror separate desktop settings, which is why they were kept.
- **Streaming the words into the `>` line while recording.** This is display only; auto-send is unchanged. First check whether the speech engine gives partial results.
- **The pick-up screen.** Two personas called it Find with a headline; they suggest launching into the last harness, or Find.
- **Unseen finished harnesses under "needs you"**, with their last line.
- **Discoverability:** a visible `⌄` on the Focus title, and a visible route to Find and New for Voice Control and Switch Control users.
- **Sentence case** ("New harness", "Open folder"). This touches desktop naming, which uses "New Harness".

### Outside this branch

- **Desktop [PR #393](https://github.com/autonomous-ai/openharness/pull/393)** is merged: Add Phone lists/removes paired devices; password pairing retains the authenticated device name. Validated on current main with 18 desktop tests, 23 CLI pairing tests and clean analysis of the changed desktop files.
- **Mobile PR #321** (clipboard image paste) remains open. The user limited merges to their own PRs; this PR belongs to another author and was not changed.
- **Website [PR #4](https://github.com/autonomous-ai/autonomous-code/pull/4)** is merged: the `/pair` landing page and phone setup redirects. Its page test, redirect assertions and production build pass; changed files have no lint errors. Deployment still needs a `_web` release tag; no website release was made.
- **TestFlight:** the user subsequently authorized release, and build **49** was uploaded through Xcode. The API-key environment used by `release-ios.sh` is still unconfigured on this Mac; the existing Xcode account supplied signing and upload authentication. No App Store review submission was made.
