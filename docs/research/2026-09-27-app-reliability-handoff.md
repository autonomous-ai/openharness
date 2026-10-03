# App reliability — historical pause checkpoint

The user resumed this work on September 28. This file records the earlier pause;
its outstanding-work and validation notes describe that checkpoint, not the
current branch. See [the completed reliability pass](2026-09-28-app-reliability.md)
for the reconciled implementation, regression evidence, and remaining limits.

At the pause, the reliability changes were uncommitted. They were preserved as
`e3744d14` on `codex/app-reliability-checkpoint` before reconciling current main.

## Workspace and prior release

- Worktree: `/Users/ab/harnesses/worktrees/autonomous-harness/brave-ibis`.
- Branch: `codex/app-reliability`, based on `origin/main` at `56651674170a3011ef6809bb17b3a56016e97ee9`.
- The previous external-engine task is complete: CLI 0.3.15 and Desktop 1.2.9
  were released from that commit. See `2026-09-27-external-engines-completion.md`.
- All modifications and new tests listed below are intentionally uncommitted.
- Existing personal daemon, tmux, accounts, and engine installations were not
  modified. Tests use isolated fixtures. No persistent test service is running.

## Changes in progress

### CLI launch modes (#371 / PR #383)

Copied the reviewed `newCommand.ts` and its tests from `origin/pr-383`
(`0551e7c6bdca431b039a2cd96748d84ad042a75f`). Default permission modes are only
sent to engines that implement them. Explicit user choices still reach daemon
validation. Store harnesses use their underlying engine's capabilities.

The upstream regressions failed before the source change; afterward
`newCommand.spec.ts` and `engineLaunch.spec.ts` passed all 94 tests.
The imported source comment incorrectly says "eleven" unsupported engines;
the list has ten. Tidy that comment before committing and credit PR #383.

### Desktop account transitions (PR #325 and additional confirmed failures)

Applied only PR #325's production patch to `desktop/lib/state/app_state.dart`,
then extended it. Its old test changes overlap the previous release's fixture
updates, so they were not copied. The original PR's commits are in
`origin/pr-325` (`47a8976d`, `d5b3cc32`, `1b454db8`, `999cd17d`).

New `desktop_account_transition_test.dart` exercises native desktop transitions
with both local and remote panes. Its first six tests all failed on the original
source. The implementation now:

- preserves the expiry flag by reusing the existing auth revision;
- clears old account content immediately, including when the guest daemon is unavailable;
- restores local panes from the saved desk without writing an empty grid over it;
- captures the old local identity before teardown and falls back to the saved identity;
- tracks the entire layout rekey/write/teardown operation so a new sign-in waits;
- keeps failed/cancelled guest sign-in on the usable guest desktop;
- resumes a pending guest restore after cancellation or Retry;
- prevents local-manual fixture logout **and expiry** from starting the real daemon;
- avoids account profile/desk requests when a guest retries machine discovery.

`support/guest_app.dart` counts daemon gates. `signout_recovery_test.dart`
asserts the fixture isolation behavior rather than the previous guest expectation.

Validation: 38 account/expiry/sign-out/guest tests passed after the initial fix.
Then all eight new native transition tests passed, including a delayed disk write
racing sign-in and guest recovery after missing inventory. Full suite, analysis,
formatting, and broader lifecycle review remain to do. Review comments around
`_guestDeskRestorePending`; its field currently interrupts the method docblock.

### Daemon lock generation (#59)

`processLiveness.ts` and the standalone `hook/notify.mjs` now read `ps` under
`psEnv()` and write `ps-c:` generation markers. Legacy `ps:` and unknown formats
are conservatively treated as live while their PID exists; comparable `ps-c:`
and Linux tick markers still reject PID reuse. Updated existing reuse fixtures
to use a mismatched marker in the actual current format.

New `processLiveness.spec.ts` exercises both daemon code and the real standalone
hook functions, with controlled process-query dependencies, for locale changes,
legacy migration, PID reuse, Linux ticks, and unavailable timestamps.

All 104 lock/registry tests passed with process/socket access. The first run was
sandbox-blocked (`uv_uptime` and tsx IPC EPERM), not a product failure. Remember
to consider coexistence with older writers when reviewing migration behavior.

### File/image drop routing (#73)

`pane_grid.dart` passes visibility to `_FileDropZone`, disables hidden/read-only
drop targets, and checks pane/session/stream identity after asynchronous file
reads and clipboard writes. A drop cannot send input into another tab or a
replacement stream. Existing local clipboard paste semantics are retained.

New `pane_file_drop_test.dart`: four tests passed for tab/stream/read-only changes
during a read and zoom visibility. The cross-tab test failed because its first
tab had never been mounted, so there was only one cached target. **The fixture
was just corrected to mount the first tab before switching; rerun it first.**
Do not claim all drop tests pass yet. A baseline comparison of the drop tests
against the old implementation is also useful.

### Stale question answers (PR #367)

Applied the reviewed full patch from `origin/pr-367` (commits `55ecf474`,
`fc4aabba`, `a7447eb8`, `e8f71075`). It checks an answer's request ID against the
live dialog, stops positional answers from reaching later unrelated questions,
selects the latest dialog rather than scrollback across engine readers, and
returns encrypted answer results only to the originating client.

The imported patch passed 520 tests across 14 dialog/backend/engine files.
Immediately before pausing, added two further protections in `askQuestion.ts`
and two tests: a remembered question cannot be redirected to another agent with
the same dialog, and concurrent answers using agent ID versus session ID share
one canonical agent lock. **These last changes have not been tested yet.**

## Outstanding investigation

1. Finish the tests and review above, then run CLI typecheck/build/full suite,
   Flutter formatting/analysis/full suite, and relevant isolated end-to-end
   recovery checks. Read `desktop/AGENTS.md`, `desktop/CLAUDE.md`, and the terminal
   workspace/dialog design docs before further UI changes (already read here).
2. Fix Hermes Linux discovery (#372): current `processEntrypoint` in both
   `cli/src/lib/tmux.ts` and `cli/hook/notify.mjs` intentionally rejects all
   Python `-c` invocations. Official new Hermes uses managed Python `-I -c`
   with a bootstrap, so it is missed. **No code change made yet.** Verify a
   narrowly anchored launcher signature; do not match arbitrary prompt text or
   any Python process mentioning Hermes. Add positive and negative discovery
   and offline-hook tests. Installed local Hermes is an older venv launcher,
   so its successful discovery does not prove the Linux case.
3. Source research found the authoritative command in
   `NousResearch/hermes-agent/hermes_cli/_launchers.py`, `runtime_command`:
   `python -I -c` then `import os, sys, runpy;` environment cleanup,
   `sys.path.insert(0, <repo root>);` a HERMES_HOME assignment,
   `import hermes_bootstrap; runpy.run_module('hermes_cli.main',
   run_name='__main__', alter_sys=True)`. Issue #372 reports an older
   `-I -I -c import sys, runpy; sys.path.insert(...)` form. Reject unrelated
   inline code, prompts, shell/Node interpreters, and other Hermes modules.
4. Continue reliability triage rather than assuming old reports are resolved:
   #105 pane freeze/reconnect, #49 GUI tmux lookup, #50 daemon port ownership,
   #45 cross-tab pane deletion, #41 restore scroll, #67 installation diagnostics.
   #58 is unused runtime-validation code. PR #366 has pane/tab close behavior
   and launch progress; fetched for review but not applied. Do not merge feature
   PRs (#394/#395 web sharing or mobile work) as part of this reliability task.
5. #284 describes a native Flutter raster crash on macOS 27 with mirrored mixed
   DPI displays. It has no full crash report in the issue; do not claim a fix
   without reproducing or finding evidence. #107/#108/#110 are WSL-specific;
   some may need the actual environment/upstream runtime investigation.
6. Keep a clear final triage record of fixed, already-covered, unconfirmed,
   and environment-dependent reports. Do not claim every possible app bug is gone.
7. Commit in reviewable groups, credit the existing PRs, reconcile main, and
   continue the user's authorized merge/release workflow only after resumption
   and successful checks. No new reliability PR exists yet.

## Local tools and receipts

- Node: `/Users/ab/.local/bin/node` (22.23.1); run npm/npx in `cli/`.
- Flutter: `/Users/ab/development/flutter-3.47.2/bin/flutter`; use `--no-pub`.
- Git and gh use the shared git directory/network, so require escalation here.
  Flutter needs access to its SDK cache. CLI process/socket suites also need
  escalation; otherwise sandbox errors can look like regressions.
- Full open-issue inventory: `/private/tmp/harness-reliability-issues.json`.
- Test logs: `/private/tmp/harness-desktop-reliability-baseline.log`,
  `harness-desktop-reliability-focused.log`, `harness-reliability-regressions.log`,
  `harness-lock-tests.log`, `harness-question-tests.log`, `harness-drop-tests.log`.
- Imported patches: `/private/tmp/harness-pr325-production.patch`,
  `/private/tmp/harness-pr367.patch` and `harness-pr367-question.patch`.
- Official source copies: `/private/tmp/hermes-official-launchers.py`,
  `hermes-official-install.sh`, `hermes-official-launcher`, `hermes-official-launch.py`.
- Remote refs `origin/pr-325`, `origin/pr-383`, `origin/pr-367`, `origin/pr-366`
  are fetched. Original external-engines worktree/branch remains untouched.
