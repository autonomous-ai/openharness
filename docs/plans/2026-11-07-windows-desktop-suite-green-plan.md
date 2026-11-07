# Windows Desktop suite green on main Implementation Plan

> Written by the writing-plans skill as this project's Engineer role adapts it: the Engineer implements it task by
> task, test first; groups that share no files run in parallel by subagents; the pull request's review is the one review.

**Goal:** The hand-run Windows Desktop workflow passes on main, x64 and arm64: every test that fails there and is not in
`desktop/test/windows_known_failures.txt` is fixed for Windows, or skipped on Windows with its reason when it tests
macOS-only behaviour (task #4618).

**Architecture:** The last run whose tests passed was 2026-10-20 (`feat/windows-desktop` aca60708e); the list was written
on 10-21 and main has moved since, while every later run either skipped the tests or ran on a branch. Run 42364609130
(f5c81bb, #3524) lists 69 unlisted failures in 25 files. Each is traced to the change since 10-21 that broke it; the
fix goes where the behaviour lives: a Windows bug in `desktop/lib` is fixed there (the macOS path is the reference), a
test that assumed POSIX is made platform-neutral, and only a test of macOS-only behaviour is skipped on Windows, with
the reason in its `skip:`.

**Tech Stack:** Flutter (Dart) widget and unit tests; the `windows-desktop.yml` workflow (x64, arm64) as the only Windows
runner; `tool/windows_test_baseline.py check` to read a run's results.

**Spec:** Task #4618; run https://github.com/autonomous-ai/openharness/actions/runs/42364609130 (results artifact
`windows-desktop-tests-{x64,arm64}`); `docs/windows-rules.md`.

## Global Constraints

- Desktop only. `desktop/test/` is the task's area; a Windows bug in `desktop/lib` is fixed there and named in the PR.
- No window may open: processes in tests and code go through `startHidden`/`runHidden` (docs/windows-rules.md §1).
- Nothing is added to `windows_known_failures.txt` without a reason and a task.
- One hand-run Windows workflow at a time.
- macOS behaviour is unchanged: each touched test file still passes on macOS.

## Review Focus

- A fix that only hides the failure (a looser expectation) where the product is wrong on Windows.
- Paths: an 8.3 short name and the long name of one folder (`RUNNER~1` and `runneradmin`), `\` and `/`, drive letters.
- Line endings: Git on Windows checks out and writes `\r\n`.
- Text metrics: the Windows fonts the tests load (Arial, Courier New, Segoe UI) against the macOS ones.
- A skip that drops Windows coverage of behaviour Windows has.

---

### Task 1: Preview fonts find the pub cache on Windows

**Files:** `desktop/test/box_render_preview_test.dart` (`loadPreviewFonts`); fixes `preview_fonts_test`,
`super_tab_scorecard_test`, `super_tab_task_line_test`.

- [ ] Find the Lucide font through `.dart_tool/package_config.json`, not `$HOME/.pub-cache` (Windows keeps the cache under
  `%LOCALAPPDATA%\Pub\Cache`, and `HOME` is unset).
- [ ] The three files pass on macOS; Windows proves them.

### Task 2: Layout and text-metric tests

**Files:** `entry_surfaces_render_test`, `export_logs_dialog_test`, `api_connections_test`,
`new_agent_choices_layout_test`, `pane_phone_header_test`, `swarm_resize_test`, `status_line_test`,
`terminal_panel_header_test`, `shared_harness_panel_test`, `icon_catalog_render_test`, and what they share.

- [ ] For each, the failing measurement and why Windows differs; fix the cause (a font the test loads, a layout that
  overflows at text scale 2.0 on Windows widths) or, only for macOS-only chrome, skip with the reason.

### Task 3: Dropped folders and attached files on Windows

**Files:** `super_tab_folder_drop_test`, `super_tab_attachments_test`, `super_tab_thread_composer_test`,
`super_tab_attachment_fetch_test`, and the code they test.

- [ ] A Windows path is not shell-quoted for its backslashes (a dropped folder reads as on macOS).
- [ ] An attachment is named by its file name, not by a prefix cut that an 8.3 folder name throws off.
- [ ] An aborted read past the limit (WSAECONNABORTED) is the expected hang-up on Windows too.
- [ ] Each Windows bug gets a test that fails without the fix on every OS where possible.

### Task 4: Finder, Git and worktrees

**Files:** `finder/finder_controller_test`, `finder/finder_pane_panel_test`, `finder/local_finder_test`,
`git_worktree_test`, `cancel_discards_worktree_test`, and the code they test.

- [ ] Paths the tests write as `/r/...` compared as Windows paths; Git's `\r\n` checkouts; worktree removal on Windows.

### Task 5: Platform one-offs

**Files:** `harness_cli_runner_windows_test`, `local_daemon_transport_test`, `native_webview_runtime_test`.

- [ ] Each test's Windows expectation against the code it tests; a test of the real CLI under flutter test gives the
  runner its own process functions.

### Task 6: One Windows run

- [ ] Run `windows-desktop.yml` once on the branch; `tool/windows_test_baseline.py check` on both artifacts finds no new
  failure. Fix what remains and run again only for that.
