# Windows and Linux end to end on pull requests

Date: 2026-11-21. Branch: `chore/ci-win-linux-e2e`. One pull request.

## Why

Every task must now support macOS, Linux and Windows (Ken, 2026-11-21). PR CI runs no Windows or Linux end-to-end
check: `windows.yml` runs only by hand (or from `release.yml`), `cli-e2e.yml` only nightly or by hand, and the Harness
Device end-to-end scripts nowhere. So each feature built a push-only temporary workflow to get that evidence:
`tmp-device-app-win-linux.yml` (#4516), `tmp-dial-app-sessions-win-linux.yml`, `tmp-discovery-cwd-windows-confirm.yml`
(#4517), `tmp-linux-xdg-paths.yml`, `tmp-harness-paths.yml`, and #4513 ran `windows.yml` by hand on its branch. This
change makes those checks permanent PR CI, selected by the paths a pull request changes.

## Goals

- The checks those temporary workflows ran, on pull requests, each only when the changed paths touch what it tests.
- Every selected check gates the merge through `ci/required`.
- Bounded runner minutes and wall time, with numbers before and after; ARM legs only where they test something x64
  does not.
- Documented in `docs/validation-and-release.md`; the docs stop telling people to write "a workflow of your own".

## Non-goals

- The full CLI end-to-end suite (8 shards, about 185 runner-minutes) on pull requests: it stays nightly and by hand.
- Screenshots (`windows-screens`), diagnostics (`fuse-probe`) and one-off reproductions
  (`tmp-discovery-cwd-windows-confirm.yml`'s scenarios against released builds and real engines): not checks.
- macOS legs: unchanged; no macOS job joins PR CI (the full-disk e2e files stay nightly).
- Changing repository protection rules: `ci/required` stays the one required check.
- The devcrew skill's "temporary workflow" step lives in the skill's own repository: out of this repo's scope, named
  in the final report only.

## Anti-goals

- A second path-selection mechanism beside `scripts/ci-plan.py`.
- An "advisory" job: a red check that is not required still makes GitHub report the PR unstable, which
  `make merge-pr` refuses (docs/validation-and-release.md), so it blocks merges without saying so.
- A typical CLI pull request that touches no Windows-relevant or e2e file paying for any of this.
- Secrets, production backends, real accounts, or anything that publishes. `permissions: contents: read`.

## Decisions (orchestrator, 2026-11-21)

1. **Approach A.** New suites in `scripts/ci-plan.py`, their jobs in `ci.yml`, each in `JOBS` so `ci/required`
   accepts only their success when selected. Same `plan` job, same reuse after Update branch (each suite gets its
   `DEPENDS` reads), same receipts, same per-job concurrency groups.
2. **All three gate merge.** They are hermetic (fake CLI, loopback servers, signed-out daemons, temp roots, no
   secrets) and were green on the temporary runs. A flaky one is a bug to fix, never a reason to make it advisory.
3. **Linux CLI e2e runs only the e2e files the PR adds or changes**, with no skips, plus the dial-hosts job when its
   files or adapters change. The full shards stay nightly. The red nightly (a different test failing each night:
   `machine.e2e.ts` on 11-20, `deviceClaudeOrca`/`deviceNotify`/`scale` on 11-18, `adopt`/`diskfull`/`enginehomes`/
   `engineModelControl` on 11-17) is not small: listed in the PR, not fixed here.
4. **windows-e2e is widened** beyond Windows-only files to cross-platform code with win32 branches that #4513 showed
   break only on Windows: `cli/src/devices/**`, `cli/src/cable/**`, `cli/src/lib/windows/**`, the engines' hook and
   notify scripts (`cli/hook/**`), `plugins/harness-device*/**`. The PR reports the measured PRs per day and runner
   minutes with that widening.
5. **ARM only for Windows-only files.** windows-e2e runs x64 for the whole widened set, and x64 plus arm64 only when
   the Windows-only files change (`pty/`, `term/`, `serial/`, `installer/`, any `install.ps1`, `cli/src/lib/ptyHost*`,
   names containing `windows`/`Windows`, the dial's Windows e2e files, `windows.yml`).
6. **Skips (linux-e2e).** A selected file fails on any failed case, or when it ran no case at all. Cases that skip by
   design (macOS-only, opt-in measurement, `FROM` released-build) pass, and the job summary lists them per file. The
   job sets up the in-memory backend as the nightly shards do. `dialWindows.e2e.ts` (windows-e2e runs it) and
   `diskfull.e2e.ts` (macOS only) are never selected; `updateHostile.e2e.ts`'s Linux cases run, its macOS block skips.
7. **Two public reads stay**: `linux.sh`'s real install lines (on a GitHub-hosted runner, `install.sh` from the CDN)
   and `windows.yml`'s "Flasher: without a board" (the newest published firmware from the public manifest). Read-only,
   no account; what a person's install does. Each download gets a bounded retry (3 tries with backoff), and a failure
   that remains says plainly that the CDN or release download failed, not the pull request's code.
8. **Concurrency**: device-app-e2e's matrices use `max-parallel` so the suite holds at most about 8 runners at once
   (the account runs 20 jobs). No macOS job joins PR CI.
9. **Runner images pinned**: `ubuntu-24.04` / `ubuntu-22.04` (and their `-arm`), never `ubuntu-latest`, which moved to
   26.04 and lost zsh and tcsh. Windows jobs keep the labels the existing workflows use (`windows-latest`,
   `windows-11-arm`).

## Approaches considered

- **A. Suites in `ci-plan.py` + jobs in `ci.yml` (picked).** One selection mechanism, the required gate, reuse and
  receipts already work; #4516 already put device-app's Windows leg there the same way.
- **B. A separate `pr-e2e.yml` with its own path filter.** A second mechanism; its red still blocks `make merge-pr`;
  no reuse or receipt.
- **C. `pull_request` triggers on `windows.yml` / `cli-e2e.yml`.** Workflow-level `paths` cannot select per job, and
  the full e2e is far too heavy for about 24 CLI PRs a day.

## The suites

Each suite is one `ci-plan.py` suite name, one or more jobs in `ci.yml`, listed in `JOBS`, run only on ready PRs (as
every component check) and selectable by hand (`CI → Run workflow`, `scope=<suite>`).

### 1. `windows-e2e`: the Windows CLI specs and the dial end to end

What `windows.yml` runs today without `release`: `windows-pty` (the host's Rust tests, the raise, two versions side
by side, serial, the Windows CLI specs list, the dial end to end on a stand-in dial `vitest.e2e.windows.config.ts`,
the two real builds) and `install`, on `windows-latest` x64 and `windows-11-arm` arm64.

- `ci.yml` calls `windows.yml` through its existing `workflow_call` (no copy of its steps). Its concurrency must not
  let one PR event cancel another's required run (ci.yml's rule: separate groups per event action). The x64-only
  versus x64 + arm64 choice (decision 5) is made by the plan, not by a person: an input of the call or two suites.
- x64 + arm64 selected by the Windows-only files of decision 5. x64 alone selected by those plus: `pty/`, `term/`, `serial/`, `installer/`, any `install.ps1`, `cli/src/lib/ptyHost*`,
  `cli/src/lib/windows/**`, any CLI source or spec whose name contains `windows`/`Windows`, every file in
  `windows.yml`'s spec list, `cli/src/devices/**`, `cli/src/cable/**`, `cli/hook/**`, `plugins/harness-device*/**`,
  `cli/e2e/dialWindows.e2e.ts`, `cli/e2e/harness/windowsDaemon.ts`, `cli/vitest.e2e.windows.config.ts`,
  `.github/workflows/windows.yml` itself, every spec in `windows.yml`'s list and the source module beside each spec
  (`secureState.spec.ts` → `secureState.ts`), and `website/src/app/flash-circle.ps1/` (the flasher step).
- Measured: x64 about 14 + 2 minutes, arm64 about 23 + 4 (run 44767978434), about 43 runner-minutes a run. Merged
  commits touching the x64 paths, 2026-11-14 to 11-21: about 98 of 210 (about 14 a day); the arm64 set is far smaller
  (the plan measures it). The PR gives runner minutes and queue times before and after, x64 and ARM apart.

### 2. `linux-e2e`: the PR's own e2e files on Linux

- `cli/e2e/**/*.e2e.ts` files the PR adds or modifies (not deletes), resolved by `ci-plan.py` from the diff and passed
  to the job as a list. Files that run in the dial-hosts job (`dialHost*.e2e.ts`, `deviceHerdr.e2e.ts`) go to that job;
  `dialWindows.e2e.ts` and `diskfull.e2e.ts` are never selected here. The agent browser's Podman file stays by hand.
- On `ubuntu-24.04`, set up exactly as `cli-e2e.yml`'s shards (tmux, zsh, tcsh, dash, lsof, inotify limits, the
  compaudit fix, `LANG`, `SHELL=/bin/zsh`, `E2E_BUNDLE=1`, `E2E_ARTIFACTS_DIR`, the in-memory backend), one file at
  a time, sharing the shards' setup rather than copying it.
- Pass rule of decision 6, from the JSON reporter's per-file results; the summary lists each file's skipped cases.
- Bounded: at most 4 runners; above one runner's worth the files are spread with `cli/ci-e2e-durations.json` as the
  nightly shards are. A cap on the file count, with a clear failure naming it, rather than an unbounded fan-out.
- Daemon logs of a failing case are uploaded, 7 days, as the nightly does.
- **dial hosts**: `cli-e2e.yml`'s `e2e (dial hosts)` job (herdr, WezTerm, Zellij, kitty, Xvfb, openbox, sway; no
  skips), selected when `cli/e2e/dialHost*.e2e.ts`, `cli/e2e/deviceHerdr.e2e.ts`, `cli/e2e/harness/dialHosts.ts`,
  `cli/vitest.e2e.dialHosts.config.ts` or the dial host adapters' source change. One definition shared by both
  workflows (a reusable workflow or composite action), not a copy.
- Measured: dial hosts about 4 minutes (run 44772444520); one e2e file usually 1 to 5 minutes. `cli/e2e/` changed in
  109 of 210 merged commits in the week.

### 3. `device-app-e2e`: Harness Device end to end on Windows and Linux

What `tmp-device-app-win-linux.yml` ran, minus screenshots and the probe, against the fake CLI and loopback servers
only:

| Job | Runners | Selected by |
| --- | --- | --- |
| Linux app (`scripts/e2e/linux.sh <AppImage>`) | `ubuntu-22.04`, `ubuntu-22.04-arm` | any `device-app/` change but docs and the release scripts' Python tests |
| Windows app (`scripts/e2e/windows.ps1 -Installer <nsis>`) | `windows-latest`, `windows-11-arm` | the same |
| Update (`update-pair.sh` + each driver's `--update`) | `ubuntu-22.04`, `ubuntu-22.04-arm`, `windows-latest` | the updater (`update.rs`), `scripts/e2e/update-pair.sh`, the release build scripts, `tauri.conf*`, `Cargo.toml`/`Cargo.lock` |
| Desktop installs the app (`device_app_install_windows_linux_native_test.dart`) | `windows-latest`, `windows-11-arm`, `ubuntu-22.04`, `ubuntu-22.04-arm` | `desktop/lib/devices/**`, that test, the app's install, packaging and instance code, `tauri.conf*` |
| One-line install (`scripts/e2e/linux-install.sh <AppImage>`, no `libfuse2`) | `ubuntu-22.04`, `ubuntu-24.04`, `ubuntu-26.04` (x64) | `website/scripts/device-install.sh`, `scripts/e2e/linux-install.sh`, `scripts/e2e/https-fake-cdn.py`, `appimage_env.rs`, packaging, `tauri.conf*` |

- Each Linux arch builds its debug AppImage once and each Windows arch its debug NSIS installer once per run; the jobs
  that need it take it as an artifact (7-day retention or less), as `install-sh-e2e` took `fuse-device-build`'s.
  The Tauri CLI is cached, not `cargo install`ed per job.
- `install-sh-e2e` on `ubuntu-26.04` is the one place a 26.04 image is wanted: it is what new Ubuntu desktops ship.
  If 26.04 cannot run it (a package missing), the plan says so and the job pins 22.04/24.04 only.
- Measured on run 44752738085: linux app 10 + 10, windows app 15 + 16, update 15 + 13 + 29, Desktop install
  17 + 19 + 10 + 9, AppImage builds 7 + 8, install about 1 each; about 200 runner-minutes when everything is selected.
  `device-app/` changed in 24 merged commits in the week.

## Bounds

- Every job has a `timeout-minutes` from its measured time plus margin, as the temporary workflows had.
- ARM: Windows arm64 runs the CLI specs only for Windows-only files (decision 5); the device-app legs are as the
  table; the one-line install is x64 only.
- Per-job, per-PR concurrency with cancel-in-progress on PRs, as every `ci.yml` job.
- The PR body carries a before/after table: per-run and per-week runner minutes (x64 and ARM apart) and the longest
  added wall time, from the week's merged commits per suite.

## Docs

- `docs/validation-and-release.md`: the PR CI table gains the three suites and their paths; "What PR CI does not run"
  drops the Windows CLI specs and the Harness Device end-to-end row's "in a workflow of your own" (now PR CI) and
  says the full CLI e2e stays nightly while a PR's own e2e files run on PRs; the Automatic CI paragraph that called
  CLI end to end advisory is updated to match.
- `device-app/AGENTS.md`: the end-to-end bullet names the PR CI jobs.
- `windows.yml` and `cli-e2e.yml` header comments name the PR CI caller.

## Tests

- `scripts/tests/test_ci_plan.py`: red then green for each selection: a Windows-only file, each widened path, a
  cross-platform CLI file outside them (selects none), an added/modified/deleted e2e file (the list), a dial-host file
  (dial hosts, not linux-e2e), each device-app job's subsets, and the `ci/required` acceptance of the new jobs. The
  cross-read scan (`CrossReadTests`) covers the new suites' `DEPENDS`.
- `actionlint` (the plan job) on the changed workflows.
- The download retries of decision 7: a test where the repo has a harness for that script (a fake CDN that fails
  twice then serves), else shown in the verification runs.

## Verification

- This PR's own CI: `plan` shows which suites its paths select.
- Each new suite run once on this branch with `CI → Run workflow` (`scope=windows-e2e`, `linux-e2e` with a named
  file, `device-app-e2e`), one at a time (heavy), to show every job green on the real runners, including 26.04.
- A negative: the plan for a CLI-only change outside the paths selects none of them (unit test plus the plan
  output of this PR's run).

## Left to the builder

- How `ci-plan.py` emits the e2e file list and the device-app sub-selection (new outputs beside the suite flags).
- Whether dial hosts becomes a reusable workflow or a composite action shared with `cli-e2e.yml`.
- Exact timeouts, cache keys and artifact names.

## Plan answers (orchestrator, 2026-11-21)

1. A selected e2e file that collects no test (a load failure) fails. A file whose every case skips by design (the 26
   macOS-only files) passes, is listed in the job summary, and the summary says plainly that macOS-only files are not
   verified by PR CI.
2. The arm64 set's "names containing windows" counts file names under `cli/` only, plus `cli/scripts/windows-ci/**`.
3. `tui/` joins the x64 set (`windows.yml` runs the TUI's Windows tests).
4. A change to `device-app/scripts/e2e/linux.sh` or `windows.ps1` also selects `device-app-update`.
5. `linux.sh` fetches `install.sh` itself first (3 tries, backoff) and reports a CDN failure as such; the install
   part is not rerun.
6. linux-e2e: one runner per 10 hinted minutes, at most 4 runners. A PR that changes more than 40 e2e files runs the
   full sharded suite instead (the nightly's 8 shards), so a big refactor stays mergeable.
7. Verification takes `windows-e2e`, `dial-hosts`, `device-app-e2e` and `device-app-update` from this PR's own ready
   run and dispatches only `linux-e2e`, `device-app-desktop` and `device-app-install`, one heavy run at a time, each
   after the orchestrator's go.

The plan's own calls stand: seven suites (`windows-e2e`, `linux-e2e`, `dial-hosts`, `device-app-e2e`,
`device-app-update`, `device-app-desktop`, `device-app-install`), one shared `device-app-build` job, the call-only
`x64_only` input on `windows.yml`, no `concurrency` block of its own in `windows.yml`, at most 9 device runners.
