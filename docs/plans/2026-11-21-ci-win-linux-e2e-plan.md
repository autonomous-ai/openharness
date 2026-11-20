# Windows and Linux end to end on pull requests: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** PR CI runs the Windows CLI specs and dial end to end, a PR's own Linux CLI e2e files, the dial hosts and Harness
Device end to end on Windows and Linux, each only when the PR's paths touch what it tests, each gating `ci/required`.

**Architecture:** Approach A of the spec. `scripts/ci-plan.py` gains end-to-end suites, selected by their own path lists
(never by what their files read), each with its jobs in `JOBS`, its `DEPENDS` for reuse after Update branch, and the
extra plan outputs its jobs read (the arm64 flag, the e2e file list and shard count, the Device builds). `ci.yml` gets
the jobs: `windows-e2e` calls `windows.yml` (`workflow_call`), `dial-hosts` calls a reusable workflow `cli-e2e.yml` calls
too, `linux-e2e` and every CLI e2e job set up through one composite action, and the Device jobs share one composite
setup and one build job whose artifacts the test jobs download.

**Tech stack:** GitHub Actions YAML, Python 3 (`scripts/`, `device-app/scripts/`), Bash and PowerShell, Vitest (one CLI
spec that reads `windows.yml`).

**Spec:** [2026-11-21-ci-win-linux-e2e-design.md](2026-11-21-ci-win-linux-e2e-design.md)

## Decisions this plan makes (the spec left them to the builder)

- **Seven suites, not three.** `ci/required` (`verify`) requires every job in `JOBS[suite]`, and `make merge-pr`'s
  `read_gate` requires them too: a job skipped inside a selected suite fails the gate. The spec's table selects each
  Device job by its own paths, and dial hosts by its own, so each distinct selection is a suite: `windows-e2e`,
  `linux-e2e`, `dial-hosts`, `device-app-e2e` (the app on Linux and Windows), `device-app-update`,
  `device-app-desktop`, `device-app-install`. Each is its own `CI → Run workflow` scope. No change to `verify`,
  receipts or the merge helper's checks.
- **The Device builds are one job outside `JOBS`** (`device-app-build`), in `ci/required`'s `needs`: a build that fails
  fails the gate; its matrix is the builds the running (not reused) Device suites need, so a reused suite never forces a
  "reused job ran again".
- **x64 alone through a `windows.yml` input** `x64_only` (call only, not a dispatch switch). A matrix cannot be filtered
  by `exclude` (an `include` row comes back as a new combination), so a small `legs` job holds the two rows once and
  hands `windows-pty` and `install` the rows to run.
- **`windows.yml` loses its workflow-level `concurrency`.** Called from `ci.yml`, its group (`windows-CI-<ref>`) is the
  same for a PR's `synchronize` and `ready_for_review` runs, so one would cancel the other's required run. Callers own
  the lock: `ci.yml`'s per-event-action group, `release.yml`'s `cli-release`. Two by-hand Windows runs on one branch no
  longer cancel each other (explicit runs keep their identity, as `ci.yml` already does).
- **The Tauri CLI is restored from a cache keyed on `release-setup.sh`**, which then skips `cargo install` when the
  pinned `tauri-cli 2.12.4` is already there. A PR's cache is that PR's (GitHub scopes it): the first run of a PR
  compiles it once per OS and architecture.
- **The dial-hosts job selects on its own definition** (`.github/workflows/cli-e2e-dial-hosts.yml`,
  `.github/actions/cli-e2e-setup/`), as the spec has `windows.yml` select `windows-e2e`.
- **"Names containing `windows`/`Windows`" (arm64 set) is the file names under `cli/` only, plus
  `cli/scripts/windows-ci/**`** (answer 2), whose `check-install.ps1` `windows.yml`'s install job runs.
- **`tui/` joins the x64 set** (answer 3): `windows.yml` runs the TUI's Windows tests.
- **A change to `device-app/scripts/e2e/linux.sh` or `windows.ps1` also selects `device-app-update`** (answer 4): the
  update job runs their `--update` / `-Update` paths.
- **A selected e2e file that collects no test fails; a file whose every case skips passes, listed** (answer 1). The job
  summary lists those files and says plainly that macOS-only files are not verified by PR CI.
- **Bounds:** `linux-e2e` takes one runner per 10 hinted minutes (`cli/ci-e2e-durations.json`, 60 s default), at most
  4. Above 40 changed e2e files it runs the full sharded suite instead (answer 6): the nightly's 8 shards,
  `vitest.e2e.ci.config.ts --shard=N/8`, spread by the same hints, under the nightly's rule (every discovered file
  exactly once, every shard passing); a nightly red (decision 3) then reds that PR too. The Device family holds at most
  9 runners at once (spec: about 8): builds 4 plus update 2 first, then app 2 + 2, desktop 2, install 1, update 2.
- **One job shape for both `linux-e2e` modes, so `ci/required` stays consistent.** `verify` requires
  `needs.<job>.result == 'success'` for every job of `JOBS[suite]`, and a matrix job has one result whatever its rows.
  Both modes run the same two jobs, `linux-e2e` (a matrix) and `linux-e2e-summary`; `JOBS["linux-e2e"]` never changes.
  The plan sets the rows (`[1..N]`, N at most 4, or `[1..8]`), the file list (empty in full mode, so Vitest runs every
  file the CI config includes, as the nightly) and `linux-e2e-full`; only the summary's `--selected` depends on the
  mode. No second job or suite exists that one mode would leave skipped and the gate would then refuse.

Measured for this plan, merged commits on `main` 2026-11-14 to 11-21 (211):

| Selection | Commits | Note |
| --- | --- | --- |
| `windows-e2e` x64 (the widened set) | 100 | the spec's 98; `tui/` (answer 3) adds at most 3 |
| `windows-e2e` arm64 (Windows-only, CLI file names, `cli/scripts/windows-ci/**`) | 23 | the `windows-ci` folder adds none |
| at least one `cli/e2e/*.e2e.ts` added or modified, outside dial hosts and the never-run files | 105 | 68 with 1 file, max 16: none reaches full mode (above 40) |
| e2e files that ran no case on Linux in nightly run 44764451448 | 26 of 186 | every case skipped: pass, listed (answer 1) |

## Global Constraints

- Runner images pinned: `ubuntu-24.04` / `ubuntu-22.04` (and their `-arm`), never `ubuntu-latest`; `ubuntu-26.04` only
  for the one-line install leg; Windows jobs keep `windows-latest` and `windows-11-arm`. No macOS job joins PR CI.
- Every selected check gates the merge through `ci/required` (each suite's jobs in `JOBS`). No "advisory" job.
- `permissions: contents: read`. No secrets, production backends, real accounts, or anything that publishes.
- One path-selection mechanism: `scripts/ci-plan.py`. The full CLI e2e suite stays nightly and by hand.
- Per-job, per-PR concurrency with `cancel-in-progress` on PRs; separate groups per event action
  (`ci-${{ github.event_name }}-${{ github.event.action || 'run' }}-${{ github.event.pull_request.number || github.run_id }}-<job>[-${{ strategy.job-index }}]`).
  Summary jobs and the gate have no lock.
- Every job has `timeout-minutes`. Artifacts keep 7 days or less; failing daemon logs 7 days.
- The two public reads stay: `linux.sh`'s real install lines and `windows.yml`'s "Flasher: without a board". Each gets a
  bounded retry (3 tries with backoff), and a failure that remains says plainly that the CDN or release download failed,
  not the pull request's code.
- No fixed sleeps (a growing wait between bounded retries is the retry). No copied step blocks: shared setup is a
  composite action or a reusable workflow.
- `device-app/`: no other component's path in a string (`ci-plan.py` reads a quoted path as a read).
- `scripts/ci-plan.py` is the planner: two independent security reviews before merge (docs/validation-and-release.md).
- Docs and comments in English, short; comments say why. Every commit ends with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Nothing is committed but by the implementer's task steps.

## Review Focus

1. **A PR-named e2e file with a space, `$(...)`, `;`, a quote or `..`** reaching a `run:` step: the plan fails naming
   it, and the list reaches jobs only through `env` (tests in Tasks 7 and 10).
2. **A selected file whose path is part of another file's** (Vitest's positional filters match substrings): the summary
   fails when the inventory holds a file the plan did not select (Task 3).
3. **A selected file that fails to load, collects no test, or that the config leaves out**: it fails, named; a file
   whose every case skips passes and is listed, never silently (Task 3).
4. **After Update branch, one Device suite reused while another runs**: the builds follow the running suites and the
   reused suite's jobs skip (Task 9).
5. **`release.yml`'s call and a by-hand Windows run** still build both architectures from `github.sha`, and no CI run
   cancels them (Task 1).

---

### Task 1: `windows.yml` runs x64 alone when its caller asks, tests the PR head, and retries the firmware read

Effort: high. Depends on: nothing.

**Files:**
- Modify: `.github/workflows/windows.yml`
- Test: `cli/src/scripts/windowsWorkflows.spec.ts`

**Interfaces:**
- Produces: `workflow_call` input `x64_only` (`type: boolean`, `required: false`, `default: false`), absent from
  `workflow_dispatch`. Job `legs` (`runs-on: ubuntu-24.04`, `timeout-minutes: 2`) with output `include`: a JSON list of
  the rows `{"runner","target","arch","artifact","timeout"}`; x64 is `windows-latest`, `x86_64-pc-windows-msvc`,
  `harness-pty-windows-x64`, 40; arm64 is `windows-11-arm`, `aarch64-pc-windows-msvc`, `harness-pty-windows-arm64`,
  60. `windows-pty` and `install` take `needs: legs` and `matrix: include: ${{ fromJSON(needs.legs.outputs.include) }}`;
  job names, `matrix.*` names and artifact names stay as they are.

- [ ] **Step 1: Write the failing tests** in `windowsWorkflows.spec.ts`. Helpers in the file: `job(text, id)` returns a
  job's block as the existing time-limit test does; `stepNamed(text, name)` a step's block; `legsFor(value)` takes the
  `legs` step's `run:` script, runs it with `bash` (`X64_ONLY=value`, `GITHUB_OUTPUT` a temp file) and parses `include`:

```ts
it('runs arm64 unless its caller asks for x64 alone; by hand and for the release, both', () => {
  const pty = read('windows.yml')
  expect(pty).toMatch(/workflow_call:\n\s+inputs:[\s\S]*?\n\s+x64_only:\n[\s\S]*?type: boolean[\s\S]*?default: false/)
  expect(pty.match(/workflow_dispatch:\n([\s\S]*?)\n  workflow_call:/)?.[1]).not.toContain('x64_only')
  for (const id of ['windows-pty', 'install']) expect(job(pty, id)).toContain('include: ${{ fromJSON(needs.legs.outputs.include) }}')
})
it("hands the matrices x64 alone when x64_only is 'true', else both rows", () => {
  // Runs the legs step's script with bash, X64_ONLY=true, then false, then '' (a by-hand run), GITHUB_OUTPUT a temp file.
  expect(legsFor('true').map((r) => r.arch)).toEqual(['x64'])
  expect(legsFor('false').map((r) => r.arch)).toEqual(['x64', 'arm64'])
  expect(legsFor('').map((r) => r.arch)).toEqual(['x64', 'arm64'])
})
it("checks out the head CI tested: the pull request's, else the run's commit", () => {
  expect(read('windows.yml').match(/- uses: actions\/checkout@v7\n\s+with:\n\s+ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/g)).toHaveLength(2)
})
it("leaves the lock to its caller, so one pull request event never cancels another's run", () => {
  expect(read('windows.yml')).not.toMatch(/^concurrency:/m)
})
it('tries the public firmware download three times and blames the download, not the change', () => {
  const step = stepNamed(read('windows.yml'), "'Flasher: without a board'")
  for (const text of ['cannot read the release manifest', 'download failed', '3', "the CDN or the release download failed, not this pull request's code"]) expect(step).toContain(text)
})
```

  Change `gives each architecture of the Windows PTY job its own time limit` to read the limits from the `legs` rows
  (`[['x64', '40'], ['arm64', '60']]`); its `timeout-minutes` and `name` expectations stay.

- [ ] **Step 2: Run them to see them fail.** `cd cli && npx vitest run src/scripts/windowsWorkflows.spec.ts`. Expected:
  the five new cases and the changed time-limit case FAIL; the rest PASS.
- [ ] **Step 3: Commit the red tests** (`CI: the Windows workflow's call, checkout and firmware read, red`).
- [ ] **Step 4: Change `windows.yml`.** The input; the `legs` job (`env: X64_ONLY: ${{ inputs.x64_only }}`, the two rows
  written once, x64 alone only when `X64_ONLY` is `true`); both matrices from it; `ref:` on both checkouts; drop the
  workflow-level `concurrency` and its comment. Flasher: the `--no-flash` call in a loop of at most 3 tries that retries
  only when its error output holds `cannot read the release manifest` or `download failed`, waiting 15 s then 45 s;
  after the third, `throw` "The firmware download from the public release failed 3 times: the CDN or the release
  download failed, not this pull request's code (<last error line>)"; any other failure throws at once as today. Header:
  `ci.yml`'s `windows-e2e` calls it for a PR whose paths select it, x64 alone unless a Windows-only file changed
  (`scripts/ci-plan.py`).
- [ ] **Step 5: Run the spec.** Same command. Expected: PASS, every case.
- [ ] **Step 6: Commit** (`CI: windows.yml runs x64 alone when its caller asks, on the PR head`).

### Task 2: One setup for the CLI's Linux e2e jobs, and dial hosts as one reusable workflow

Effort: high. Depends on: nothing.

**Files:**
- Create: `.github/actions/cli-e2e-setup/action.yml`, `.github/workflows/cli-e2e-dial-hosts.yml`
- Modify: `.github/workflows/cli-e2e.yml`
- Test: `scripts/tests/test_cli_e2e_workflow.py` (new)

**Interfaces:**
- Produces: composite action `./.github/actions/cli-e2e-setup` with inputs `node-version` (required), `packages`
  (extra apt packages, default `''`), `real-backend` (default `'false'`). It runs `actions/setup-node` (npm cache on
  `cli/package-lock.json`); `scripts/apt-install.sh tmux zsh lsof <packages>`; the inotify limits; the compaudit fix;
  `npm ci --no-audit --no-fund` in `cli/`; with `real-backend: 'true'`, `cli-e2e.yml`'s real-backend step as it is
  (exports `HARNESS_E2E_SERVICES_DIR`, `HARNESS_E2E_REDIS_SERVER`). Every `run` step has `shell: bash`.
- Produces: reusable workflow `./.github/workflows/cli-e2e-dial-hosts.yml`, `on: workflow_call` only, no inputs,
  `permissions: contents: read`, one job `dial-hosts` named `e2e (dial hosts)`: `cli-e2e.yml`'s job moved whole (env
  pins and sha256s, `timeout-minutes: 30`, `ubuntu-24.04`, artifact names), checkout
  `ref: ${{ github.event.pull_request.head.sha || github.sha }}`, its downloads then the action with the hosts'
  packages (`${{ runner.temp }}/dial-hosts/wezterm.deb` among them). Its own `CLI_NODE_VERSION: 24.22.2` (a called
  workflow cannot read the caller's `env`), commented to keep in sync.

- [ ] **Step 1: Write the failing tests** (`ROOT`, a `jobs(text)` helper with `test_ci_plan.py`'s job regex):
  - `test_every_linux_e2e_job_sets_up_through_the_one_action`: `cli-e2e.yml`'s `e2e` and `agent-browser-podman` and the
    reusable workflow's `dial-hosts` contain `uses: ./.github/actions/cli-e2e-setup`; `compaudit` and `fs.inotify`
    appear in none of `cli-e2e.yml`, `cli-e2e-dial-hosts.yml`, `ci.yml`, and in the action once each.
  - `test_the_shards_set_up_their_shells_and_the_real_backend`: the `e2e` job passes `packages: tcsh dash` and
    `real-backend: 'true'`; the action holds `using: composite`, `redis-server`,
    `mongodb-memory-server@10 redis-memory-server@0.12`, `HARNESS_E2E_SERVICES_DIR`, `if: inputs.real-backend == 'true'`,
    and `shell: bash` on every `run` step.
  - `test_the_dial_hosts_job_is_one_reusable_workflow`: `cli-e2e.yml`'s `dial-hosts` job is
    `uses: ./.github/workflows/cli-e2e-dial-hosts.yml` with `if: ${{ !inputs.agent_browser_podman }}` and no `steps:`;
    the reusable workflow's trigger block is exactly `workflow_call:`; it holds `contents: read`, `runs-on: ubuntu-24.04`,
    `timeout-minutes: 30`, the PR-head `ref:`, `E2E_DIAL_HOSTS: '1'`, `HERDR_VERSION: 0.9.5`, `ZELLIJ_VERSION: 0.44.3`,
    `WEZTERM_VERSION: 20240203-110809-5046fc22` with their three sha256 lines, and the step
    `Require every case to pass without skipping`.
- [ ] **Step 2: Run them to see them fail.**
  `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false python3 -m unittest discover -s scripts/tests -p 'test_cli_e2e_workflow.py' -v`.
  Expected: FAIL (no action, no reusable workflow).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Write the action and the reusable workflow; point `cli-e2e.yml`'s three Linux jobs at them**, removing
  their copies. `agent-browser-podman` keeps its own `command -v podman || apt-install podman` and `podman info` step
  after the action. Header of `cli-e2e.yml`: the full suite runs nightly and by hand; PR CI runs a PR's own e2e files
  (`ci.yml` `linux-e2e`, through the same action) and the dial hosts (`ci.yml` `dial-hosts`, the same workflow); the
  "ADVISORY ... does not run on pull requests" paragraph says that of the full suite only.
- [ ] **Step 5: Run the tests**, same command: PASS. If Go is installed, actionlint on the two workflows:
  `GOTOOLCHAIN=go1.26.8 go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 .github/workflows/cli-e2e.yml .github/workflows/cli-e2e-dial-hosts.yml`
  (else the plan job runs it on push, Task 7 adds the file to its list).
- [ ] **Step 6: Commit** (`CI: one setup for the CLI's Linux e2e jobs; dial hosts as a reusable workflow`).

### Task 3: The shard verifier holds a PR's selected e2e files to the per-file rule

Effort: high. Depends on: nothing.

**Files:**
- Modify: `scripts/verify-cli-test-shards.py`
- Test: `scripts/tests/test_cli_test_shards.py`

**Interfaces:**
- Produces: `verify(directory, root, shards, tests_result, contracts_result, suite="unit", selected=None)`. `selected`
  is a list of `cli/`-relative paths (`e2e/x.e2e.ts`), end-to-end suite only. With it: every shard's inventory must
  equal the selected set (`ValueError` naming the missing and the unexpected files); each selected file must collect
  at least one case (passed, skipped or todo), else `ValueError` naming every file that "collected no test" (answer 1).
  A file whose every case skipped passes. Without `selected` (the full suite, `linux-e2e`'s full mode and the
  nightly) the rule is today's. Both ways the summary gains `"skipped_by_file": {path: [fullName, ...]}` and
  `"all_skipped": [path, ...]` (sorted). CLI: `--selected "<space-separated paths>"`, `--step-summary <file>`
  (end-to-end suite, with or without `--selected`; appends Markdown: a `File | Passed | Skipped` table of the files
  with a skipped case, then each file's skipped case names, then, when `all_skipped` is not empty, the heading
  `Every case skipped`, those files, and the line `These files ran no case on Linux. macOS-only files are not verified
  by PR CI.`). `--selected` or `--step-summary` with `--suite unit` is a usage error.

- [ ] **Step 1: Write the failing tests**, class `SelectedFilesTests` (e2e fixtures as the existing e2e class builds
  them, cases with `fullName`):
  - `test_selected_files_pass_with_each_files_skipped_cases_listed`: two files, one with a skipped case →
    `summary["skipped_by_file"] == {"e2e/b.e2e.ts": ["b skips on macOS"]}`, `summary["all_skipped"] == []`,
    `status == "passed"`.
  - `test_a_selected_file_whose_every_case_skipped_passes_listed`: all of `e2e/b.e2e.ts`'s cases skipped →
    `status == "passed"`, `summary["all_skipped"] == ["e2e/b.e2e.ts"]`.
  - `test_a_selected_file_that_collected_no_test_fails_naming_it`: `e2e/b.e2e.ts` with status `passed` and
    `assertionResults: []` → `assertRaisesRegex(ValueError, r"collected no test: e2e/b\.e2e\.ts")`.
  - `test_a_file_the_plan_did_not_select_fails`: inventory and results hold `e2e/sub/a.e2e.ts` beside the selected
    `e2e/a.e2e.ts` → `ValueError` naming `e2e/sub/a.e2e.ts` as unexpected.
  - `test_a_selected_file_missing_from_the_run_fails`: selected `e2e/c.e2e.ts` in no inventory → `ValueError` naming
    it missing.
  - `test_a_selected_file_that_failed_to_load_fails`: status `failed`, a message, no `assertionResults` → `ValueError`.
  - `test_selected_is_for_the_end_to_end_suite_only`: the command with `--suite unit --selected e2e/a.e2e.ts`, and
    with `--suite unit --step-summary <file>`, exits non-zero with a usage message.
  - `test_the_step_summary_lists_the_skipped_cases_per_file`: the command with `--step-summary` writes a file holding
    `| e2e/b.e2e.ts | 1 | 1 |` and `b skips on macOS`, and no `Every case skipped`.
  - `test_the_step_summary_says_macos_only_files_are_not_verified`: `e2e/c.e2e.ts` with every case skipped → the file
    holds `Every case skipped`, `e2e/c.e2e.ts` and `macOS-only files are not verified by PR CI.`; the same without
    `--selected` (the full suite's summary).
- [ ] **Step 2: Run them to see them fail.**
  `python3 -m unittest discover -s scripts/tests -p 'test_cli_test_shards.py' -v`. Expected: the new class FAILs.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement** in `verify` and `main`; the module docstring names the third use (`ci.yml`'s
  `linux-e2e-summary`).
- [ ] **Step 5: Run the tests**, same command: PASS, old and new.
- [ ] **Step 6: Commit** (`CI: verify a PR's selected e2e files, each with a case collected`).

### Task 4: `release-setup.sh` keeps a pinned Tauri CLI that is already there

Effort: medium. Depends on: nothing.

**Files:**
- Modify: `device-app/scripts/release-setup.sh`
- Test: `device-app/scripts/test_release_build.py`

**Interfaces:**
- Produces: in the no-mode and `tauri-cli` modes, `cargo install tauri-cli --version 2.12.4 --locked` runs only when
  `cargo tauri --version` does not print exactly `tauri-cli 2.12.4`. The pin stays in one place (`tauri_cli=(...)`).

- [ ] **Step 1: Write the failing tests.** The fake cargo answers `cargo tauri --version` with `$FAKE_TAURI_CLI` (fails
  when unset, as with no CLI installed).
  - `test_setup_keeps_the_pinned_tauri_cli_already_there`: `FAKE_TAURI_CLI="tauri-cli 2.12.4"`, no mode and
    `tauri-cli` mode → no `install` among `cargo_calls()`; rustup and npm calls as today.
  - `test_setup_installs_the_pin_over_another_version`: `"tauri-cli 2.12.3"` → the install call as today.
- [ ] **Step 2: Run them to see them fail.**
  `python3 -m unittest discover -s device-app/scripts -p 'test_release_build.py' -k tauri -v`. Expected: the "keeps"
  test FAILs.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement the check** before both `cargo install` calls, with a comment: CI restores the binary from a
  cache.
- [ ] **Step 5: Run** `python3 -m unittest discover -s device-app/scripts -p 'test_*.py' -v`: PASS.
- [ ] **Step 6: Commit** (`Device: release-setup.sh keeps the pinned Tauri CLI already installed`).

### Task 5: `linux.sh` tells a CDN outage from the change

Effort: medium. Depends on: nothing. Red test: none. `linux.sh`'s GitHub-hosted install part has no harness (the spec's
Tests: "else shown in the verification runs"); shown in Verification 4c. One commit. Mechanism per answer 5: fetch
install.sh first with 3 tries, report a CDN failure as one, never rerun the install part.

**Files:**
- Modify: `device-app/scripts/e2e/linux.sh`

**Interfaces:**
- Produces: in the `github-hosted` branch, before the app's launch, `curl -fsS --retry 2 --retry-all-errors --max-time 60
  -o /dev/null https://cdn.autonomous.ai/harness/cli/install.sh` (3 tries, curl's growing waits): the URL `install.rs`'s
  fixed lines fetch. On failure: `FAILED: the CDN's install.sh did not download in 3 tries: the CDN failed, not this
  change`. The install part's `fail` calls go through `install_fail <check>`, which first looks in the app's log for
  `install: last: curl: (` or `install: last: ` followed by `Could not download` / `Could not fetch` (install.sh's own
  download lines) and, when one is there, fails with: `the CDN or a release download failed during the app's install lines (<that line>), not this change`.
  The app's own run is not retried: it is what a person's install does, and install.sh already retries its downloads.

- [ ] **Step 1: Make the change**, and in the header's "a last part runs the app's own install lines" sentence add that
  a CDN failure is reported as one.
- [ ] **Step 2: Check the script** with `bash -n device-app/scripts/e2e/linux.sh` (and `shellcheck` if installed).
- [ ] **Step 3: Commit** (`Device: linux.sh says when the CDN, not the change, failed its install lines`).

### Task 6: `ci.yml` calls `windows.yml` as `windows-e2e`

Effort: high. Depends on: Task 1.

**Files:**
- Modify: `.github/workflows/ci.yml`
- Test: `scripts/tests/test_pr_e2e_jobs.py` (the first of Tasks 6, 7 and 8 to run creates it with a `ci_jobs()` helper:
  the text, the jobs by id with `test_ci_plan.py`'s regex, and `required`'s `needs` set; the others add a class)

**Interfaces:**
- Consumes: `windows.yml`'s `x64_only` (Task 1).
- Produces: plan job outputs `windows-e2e: ${{ steps.select.outputs.windows-e2e }}` and
  `windows-e2e-arm64: ${{ steps.select.outputs.windows-e2e-arm64 }}` (Task 9 writes them: `true`/`false`); job
  `windows-e2e`, in `required`'s `needs`.

- [ ] **Step 1: Write the failing test** `test_windows_e2e_calls_windows_yml_x64_alone_unless_the_plan_says_arm64`: the
  job holds `uses: ./.github/workflows/windows.yml`,
  `x64_only: ${{ needs.plan.outputs.windows-e2e-arm64 != 'true' }}`,
  `if: needs.plan.outputs.ready == 'true' && needs.plan.outputs.windows-e2e == 'true'`, the group
  `ci-${{ github.event_name }}-${{ github.event.action || 'run' }}-${{ github.event.pull_request.number || github.run_id }}-windows-e2e`
  and `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`; the plan job has both outputs; `windows-e2e` is
  in `required`'s `needs`.
- [ ] **Step 2: Run it to see it fail.**
  `python3 -m unittest discover -s scripts/tests -p 'test_pr_e2e_jobs.py' -v`. Expected: FAIL (no job).
- [ ] **Step 3: Commit the red test.**
- [ ] **Step 4: Add the outputs, the job** (a comment: what `windows.yml` runs, and why x64 alone for a cross-platform
  change, decisions 4 and 5) and the `needs` entry.
- [ ] **Step 5: Run the test**, same command: PASS. `test_ci_plan.py` stays green (the suite is not in `SUITES` yet).
- [ ] **Step 6: Commit** (`CI: windows-e2e calls the Windows workflow`).

### Task 7: `ci.yml` runs a PR's own e2e files on Linux, and the dial hosts

Effort: high. Depends on: Task 2, Task 3.

**Files:**
- Modify: `.github/workflows/ci.yml`
- Test: `scripts/tests/test_pr_e2e_jobs.py`

**Interfaces:**
- Consumes: `./.github/actions/cli-e2e-setup` and `./.github/workflows/cli-e2e-dial-hosts.yml` (Task 2); the verifier's
  `--selected` and `--step-summary` (Task 3).
- Produces: plan outputs `linux-e2e`, `linux-e2e-files` (space-separated `cli/`-relative paths; empty in full mode),
  `linux-e2e-shards` (JSON list `[1, ..., N]`: N at most 4, or `[1, ..., 8]` in full mode), `linux-e2e-full`
  (`true`/`false`), `dial-hosts` (Task 10 writes them). One job shape for both modes (the plan's Decisions): the same
  steps run a PR's files or, with the list empty, every file the CI config includes, as a nightly shard. Jobs:
  - `linux-e2e`: `name: linux-e2e (${{ matrix.shard }})`, `strategy.matrix.shard: ${{ fromJSON(needs.plan.outputs.linux-e2e-shards) }}`,
    `fail-fast: false`, `runs-on: ubuntu-24.04`, `timeout-minutes: 45`, `working-directory: cli`, job `env`: `LANG:
    C.UTF-8`, `SHELL: /bin/zsh`, `E2E_FILES: ${{ needs.plan.outputs.linux-e2e-files }}`,
    `E2E_FULL: ${{ needs.plan.outputs.linux-e2e-full }}`. Steps: checkout
    (`ref: ${{ env.CI_SOURCE_SHA }}`); the action (`packages: tcsh dash`, `real-backend: 'true'`); a guard that fails
    with `linux-e2e: the plan gave no file and no full run` when `E2E_FILES` is empty and `E2E_FULL` is not `true`
    (an empty list must never widen to the full suite by accident); the inventory
    (`read -ra files <<<"$E2E_FILES"`, `npx vitest list --config vitest.e2e.ci.config.ts --filesOnly --json="$RUNNER_TEMP/inventory-$SHARD.json" "${files[@]}"`);
    the run (`E2E_BUNDLE: '1'`, `E2E_ARTIFACTS_DIR: ${{ runner.temp }}/e2e-daemon-logs`, `npx vitest run --config
    vitest.e2e.ci.config.ts --shard="$SHARD/$SHARDS" --reporter=default --reporter=json --outputFile.json=... "${files[@]}"`,
    with `SHARDS: ${{ strategy.job-total }}`); artifact `linux-e2e-shard-${{ matrix.shard }}` (7 days, `!cancelled()`);
    daemon logs `linux-e2e-daemon-logs-${{ matrix.shard }}` (7 days, `failure()`).
  - `linux-e2e-summary`: `needs: [plan, linux-e2e]`,
    `if: ${{ !cancelled() && needs.plan.outputs.ready == 'true' && needs.plan.outputs.linux-e2e == 'true' }}`,
    `ubuntu-24.04`, `timeout-minutes: 3`, no lock; sparse checkout of `scripts/verify-cli-test-shards.py`; downloads
    `linux-e2e-shard-*`; runs the verifier with `--suite e2e --root "$GITHUB_WORKSPACE/cli" --shards "$(jq length
    <<<"$SHARDS")"` (`SHARDS: ${{ needs.plan.outputs.linux-e2e-shards }}`) `--tests-result "${{ needs.linux-e2e.result }}"
    --step-summary "$GITHUB_STEP_SUMMARY"`, plus `--selected "$E2E_FILES"` only when `E2E_FULL` is not `true` (a bash
    array, `E2E_FILES` and `E2E_FULL` from the plan outputs through `env`); uploads `linux-e2e-summary` (7 days).
  - `dial-hosts`: `uses: ./.github/workflows/cli-e2e-dial-hosts.yml`, its group per event action.
  - All three in `required`'s `needs`; `.github/workflows/cli-e2e-dial-hosts.yml` added to the plan job's actionlint
    list.

- [ ] **Step 1: Write the failing tests:**
  - `test_linux_e2e_runs_the_plans_files_on_the_plans_shards`: the matrix, runner, timeout, action inputs, both Vitest
    commands with `--config vitest.e2e.ci.config.ts`, `--shard=`, `E2E_BUNDLE: '1'`, `E2E_ARTIFACTS_DIR`, `LANG`,
    `SHELL`, the two uploads with `retention-days: 7`.
  - `test_the_file_list_reaches_the_runs_only_through_the_environment`: `E2E_FILES:
    ${{ needs.plan.outputs.linux-e2e-files }}` is in the job's `env`, and no `run:` block in `ci.yml` contains
    `needs.plan.outputs.linux-e2e-files` (Review Focus 1).
  - `test_the_summary_holds_each_selected_file_to_the_per_file_rule`: the summary job's `needs`, `if`, runner and the
    verifier's flags above; `--selected` sits behind the `E2E_FULL` check, `--step-summary` does not.
  - `test_both_linux_e2e_modes_are_the_same_two_jobs`: no job id in `ci.yml` but `linux-e2e` and `linux-e2e-summary`
    starts with `linux-e2e`; neither job's `if:` reads `linux-e2e-full`; the run step's guard names
    `the plan gave no file and no full run`; `E2E_FULL: ${{ needs.plan.outputs.linux-e2e-full }}` is in the job's
    `env` and the plan job has the output.
  - `test_dial_hosts_is_the_workflow_cli_e2e_runs`: the `uses:` line, the group, the `needs` entry, the actionlint list.
- [ ] **Step 2: Run them to see them fail** (same command as Task 6). Expected: the new tests FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Add the outputs, jobs, `needs` entries and the actionlint path.**
- [ ] **Step 5: Run the tests**: PASS; `test_ci_plan.py` stays green.
- [ ] **Step 6: Commit** (`CI: a PR's own e2e files on Linux, and the dial hosts`).

### Task 8: `ci.yml` runs Harness Device end to end on Windows and Linux

Effort: high. Depends on: Task 4.

**Files:**
- Create: `.github/actions/device-app-setup/action.yml`
- Modify: `.github/workflows/ci.yml`
- Test: `scripts/tests/test_pr_e2e_jobs.py`

**Interfaces:**
- Consumes: `release-setup.sh`'s skip (Task 4).
- Produces: composite action `./.github/actions/device-app-setup` (input `node-version`): `actions/setup-node` (npm
  cache on `device-app/ui/package-lock.json`); `actions/cache` of `~/.cargo/bin/cargo-tauri` and
  `~/.cargo/bin/cargo-tauri.exe`, key `tauri-cli-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('device-app/scripts/release-setup.sh') }}`;
  `bash device-app/scripts/release-setup.sh`.
- Produces: plan outputs `device-app-e2e`, `device-app-update`, `device-app-desktop`, `device-app-install`,
  `device-app-builds` (JSON list of `{"bundle": "appimage"|"nsis", "arch": "x64"|"arm64"}`; Task 9 writes them). Jobs,
  each with its per-row group, `fail-fast: false`, in `required`'s `needs`; steps taken from
  `final-device-app.yml`'s jobs, minus their build steps:

| Job | Rows (runner) | `needs` | `max-parallel` | `timeout-minutes` | What it runs |
| --- | --- | --- | --- | --- | --- |
| `device-app-build` (not in `JOBS`) | `include: ${{ fromJSON(needs.plan.outputs.device-app-builds) }}`; `runs-on` from an inline `fromJSON` map keyed `<bundle>-<arch>`: appimage x64 `ubuntu-22.04`, arm64 `ubuntu-22.04-arm`, nsis x64 `windows-latest`, arm64 `windows-11-arm` | `plan` | (at most 4 rows) | 40 | `if: needs.plan.outputs.ready == 'true' && needs.plan.outputs.device-app-builds != '[]'`; the setup action; `cargo tauri build --ci --debug --bundles <bundle> -- --locked` in `device-app/src-tauri`; artifact `device-app-<bundle>-<arch>`, 1 day |
| `device-app-linux` | x64 `ubuntu-22.04`, arm64 `ubuntu-22.04-arm` | `plan`, `device-app-build` | 2 | 45 | the temporary `linux-e2e` job's apt line (the AppImage then runs where it was proven); downloads `device-app-appimage-<arch>`; `bash device-app/scripts/e2e/linux.sh <AppImage>` |
| `device-app-windows` | x64 `windows-latest`, arm64 `windows-11-arm` | `plan`, `device-app-build` | 2 | 30 | downloads `device-app-nsis-<arch>`; `windows.ps1 -Installer <setup.exe> -Out "$env:RUNNER_TEMP\device-app-e2e"`; that folder on failure, 3 days |
| `device-app-update` | `windows-latest`, `ubuntu-22.04`, `ubuntu-22.04-arm`, in this order | `plan` | 2 | 60 | Linux apt line of the temporary job; the setup action; `update-pair.sh` (`DEVICE_TARGET` x86_64-pc-windows-msvc on Windows); `linux.sh --update` / `windows.ps1 -Update`; logs on failure, 3 days |
| `device-app-desktop` | `windows-latest`, `windows-11-arm`, `ubuntu-22.04`, `ubuntu-22.04-arm` | `plan`, `device-app-build` | 2 | 45 | downloads `device-app-appimage-<arch>` on Linux, `device-app-nsis-<arch>` on Windows; the temporary job's apt line, Flutter read from `release-desktop.yml` as `desktop-tests` reads it (`desktop-flutter` / `desktop-flutter-arm64` on Linux, the tag's clone on Windows), the two End to end steps; the Device log on failure, 3 days |
| `device-app-install` | `ubuntu-22.04`, `ubuntu-24.04`, `ubuntu-26.04` (x64) | `plan`, `device-app-build` | 1 | 15 | the temporary `install-sh-e2e` apt line; downloads `device-app-appimage-x64`; `bash device-app/scripts/e2e/linux-install.sh <AppImage>` |

  Left out of the temporary workflow: `windows-unit` and `linux-unit` (`device-app-checks` runs them), `windows-screens`,
  `fuse-device-build`/`fuse-probe`, and the arm64 installer and pair uploads for the VM.

- [ ] **Step 1: Write the failing tests:**
  - `test_each_device_app_job_runs_on_its_pinned_runners_within_its_limits`: per the table, each job's runner labels,
    `needs`, `max-parallel` and `timeout-minutes`; each `if:` names `needs.plan.outputs.ready == 'true'` and its own
    suite output (`device-app-linux` and `device-app-windows`: `device-app-e2e`).
  - `test_the_builds_are_made_once_and_handed_on`: the build job's `include`, `if`, setup action, `--bundles` and
    `retention-days: 1`; each consuming job downloads `device-app-<bundle>-<arch>`; no other job holds
    `cargo tauri build`; `cargo install tauri-cli` appears nowhere in `ci.yml`.
  - `test_the_tauri_cli_is_restored_not_compiled_each_time`: the action's cache key above and the `release-setup.sh`
    step.
  - `test_at_most_nine_device_app_runners_at_once`: sum over the five test jobs of `min(max-parallel, rows)` is 9;
    builds at most 4.
  - `test_no_new_job_runs_on_ubuntu_latest_or_macos`: none of the jobs of Tasks 6 to 8 names `ubuntu-latest` or
    `macos`; `ubuntu-26.04` appears only in `device-app-install`.
  - `test_screens_and_probes_stay_out`: `ci.yml` holds no `-Screens`, `fuse-probe`, `appimage-starts.sh`,
    `device-app-windows-arm64`.
  - every job above is in `required`'s `needs`.
- [ ] **Step 2: Run them to see them fail** (same command as Task 6).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Write the action and the jobs**, each with a one-line comment: what it runs and why it is selected.
- [ ] **Step 5: Run the tests**: PASS; `test_ci_plan.py` stays green.
- [ ] **Step 6: Commit** (`CI: Harness Device end to end on Windows and Linux`).

### Task 9: The planner selects Windows end to end and the Device suites

Effort: xhigh. Depends on: Task 6, Task 8.

**Files:**
- Modify: `scripts/ci-plan.py`, `.github/workflows/ci.yml` (the dispatch `scope` options only)
- Test: `scripts/tests/test_ci_plan.py`

**Interfaces:**
- Consumes: the job ids and output names of Tasks 6 and 8.
- Produces, in `ci-plan.py`:
  - `E2E = {"windows-e2e", "device-app-e2e", "device-app-update", "device-app-desktop", "device-app-install"}`;
    `SUITES = CORE | EXTRA | {"pro"} | E2E`; `JOBS` gains `"windows-e2e": {"windows-e2e"}`,
    `"device-app-e2e": {"device-app-linux", "device-app-windows"}` and one job each for the other three;
    `MANUAL["all"] = SUITES - E2E` (every component; a scope per e2e suite comes from the existing loop).
  - `WINDOWS_SPECS`: `windows.yml`'s two `$paths` lists, repository-relative, folders ending in `/`.
  - `windows_only(path) -> bool`: `pty/`, `term/`, `serial/`, `installer/`, any `install.ps1`, `cli/src/lib/ptyHost*`,
    a file under `cli/` whose name (not a folder's) matches `[wW]indows`, `cli/scripts/windows-ci/`,
    `.github/workflows/windows.yml` (answer 2).
  - `windows_e2e(path) -> bool`: `windows_only`, or `cli/src/lib/windows/`, `cli/src/devices/`, `cli/src/cable/`,
    `cli/hook/`, `tui/` (answer 3), `website/src/app/flash-circle.ps1/`, `plugins/harness-device*/` (`re.match(r"plugins/harness-device[^/]*/")`),
    a `WINDOWS_SPECS` file or folder, or the module beside a spec there (its name up to the first dot, plus `.ts`).
  - `DEVICE_APP_PATHS`: per Device suite, the spec table's paths. `device-app-e2e`: `device-app/` but `*.md` and
    `device-app/scripts/test_*.py`. `device-app-update`: `src-tauri/src/update.rs`, `scripts/e2e/update-pair.sh`,
    `scripts/e2e/linux.sh`, `scripts/e2e/windows.ps1` (answer 4: the job runs their update paths),
    `scripts/release-build.sh`, `release-check.sh`, `release-setup.sh`, `src-tauri/tauri.conf*`, `src-tauri/Cargo.toml`,
    `src-tauri/Cargo.lock`. `device-app-desktop`: `desktop/lib/devices/`,
    `desktop/integration_test/device_app_install_windows_linux_native_test.dart`, `src-tauri/src/install.rs`,
    `packaging.rs`, `instance.rs`, `tauri.conf*`. `device-app-install`: `website/scripts/device-install.sh`,
    `scripts/e2e/linux-install.sh`, `scripts/e2e/https-fake-cdn.py`, `src-tauri/src/appimage_env.rs`, `packaging.rs`,
    `tauri.conf*` (paths under `device-app/` unless named).
  - `DEVICE_APP_BUILDS`: `device-app-e2e` and `device-app-desktop` need appimage and nsis, x64 and arm64;
    `device-app-install` appimage x64.
  - `e2e_owners(path) -> set[str]`: the e2e suites whose own paths include it. `owners()` and `shared_input()` do not
    change. `select()` adds `e2e_owners(path)` to each path's scopes; `reads()` counts `e2e_owners` as own;
    `undeclared_reads()` scans a source when `suite in owners(source) | e2e_owners(source)`.
  - `DEPENDS`: `windows-e2e` = `DEPENDS["cli"]`, `["pty"]` and `["tui"]` plus `cli/`, `tests/`, `plugins/`, `pty/`,
    `serial/`, `term/`, `tui/`, `installer/`, `website/`; `device-app-e2e` and `device-app-update` =
    `DEPENDS["device-app"]` plus `device-app/`; `device-app-desktop` = `DEPENDS["device-app"]` and `["desktop"]` plus
    `device-app/`, `desktop/`; `device-app-install` = `DEPENDS["device-app"]` plus `device-app/`,
    `website/scripts/device-install.sh`; plus whatever the cross-read scan finds. No `PR_READS` for e2e suites.
  - `e2e_plan(paths, running) -> {"windows_arm64": bool, "device_app_builds": [{"bundle", "arch"}]}`: arm64 when
    `windows-e2e` runs and a path is `windows_only`, or on a manual run (no paths); builds of the running suites, in the
    order appimage x64, appimage arm64, nsis x64, nsis arm64. `make_plan` records it as `plan["e2e"]`, from
    `running = suites - set(reused)`.
  - `outputs(record) -> dict[str, str]`: the plan job's outputs (`plan`, `ready`, each suite's `true`/`false`,
    `windows-e2e-arm64`, `device-app-builds` as compact JSON); `main()` writes it. The step summary adds one line for
    Windows (x64 alone, or with arm64 and the first Windows-only path) and one for the Device builds.

- [ ] **Step 1: Write the failing tests** (new, in their classes):
  - `test_a_windows_only_file_runs_windows_end_to_end_on_both_architectures`: for `pty/src/stream.rs`,
    `term/src/capture.rs`, `serial/src/main.rs`, `installer/src/model.rs`, `cli/scripts/install.ps1`,
    `cli/src/lib/ptyHostBackend.ts`, `cli/src/lib/ptyHost/stream.ts`, `cli/src/engines/kit/windowsHooks.ts`,
    `cli/e2e/dialWindows.e2e.ts`, `cli/e2e/harness/windowsDaemon.ts`, `cli/vitest.e2e.windows.config.ts`,
    `cli/scripts/windows-ci/check-install.ps1`, `cli/scripts/windows-ci/opencode.mjs`,
    `.github/workflows/windows.yml`: `"windows-e2e" in select([p])[0]`, `windows_only(p)`,
    `e2e_plan([p], {"windows-e2e"})["windows_arm64"]`.
  - `test_windows_in_a_name_outside_the_cli_runs_no_arm64`: `desktop/windows/runner/main.cpp`,
    `device-app/src-tauri/src/front_windows.rs`, `.github/workflows/windows-desktop.yml` → not `windows_only`;
    `cli/src/lib/windows/program.ts` (a folder's name, not the file's) → not `windows_only`.
  - `test_the_widened_paths_run_windows_end_to_end_on_x64_alone`: `cli/src/devices/listenerPipe.ts`,
    `cli/src/cable/hosts/kitty.ts`, `cli/src/lib/windows/program.ts`, `cli/hook/notify.mjs`,
    `plugins/harness-device/hooks/hooks.json`, `plugins/harness-device-orca/src/dial.ts`,
    `plugins/harness-device-vscode/src/loop.ts`, `cli/src/lib/secureState.spec.ts`, `cli/src/lib/secureState.ts`,
    `cli/src/lib/uninstall/steps.ts`, `cli/src/superTabs/start.ts`, `website/src/app/flash-circle.ps1/flash-circle.ps1`,
    `tui/src/main.rs`, `tui/Cargo.toml`: selected, not `windows_only`, arm64 false.
  - `test_a_cross_platform_file_outside_the_lists_runs_no_end_to_end_suite` (the spec's negative):
    `cli/src/lib/tmuxBackend.ts`, `cli/src/core/agents.ts`, `cli/src/lib/engineLaunch.ts`,
    `desktop/windows/runner/main.cpp`: `not select([p])[0] & planner.E2E`.
  - `test_the_windows_spec_list_is_windows_ymls`: `set(WINDOWS_SPECS)` equals the parsed `$paths` entries of
    `windows.yml` (`cli/` prefixed, `../` resolved, a name without `.ts` a folder).
  - `test_each_device_app_job_runs_on_its_own_paths`: `select([p])[0]` for `device-app/src-tauri/src/keepalive.rs` →
    `{"device-app", "device-app-e2e"}`; `update.rs`, `update-pair.sh`, `scripts/e2e/linux.sh`,
    `scripts/e2e/windows.ps1`, the three release scripts, `Cargo.toml`, `Cargo.lock` → plus `device-app-update`;
    `scripts/e2e/macos.sh` → `{"device-app", "device-app-e2e"}` only; each `tauri*.conf.json` → `device-app`, `-e2e`, `-update`, `-desktop`,
    `-install`; `install.rs`, `instance.rs` → `device-app`, `-e2e`, `-desktop`; `packaging.rs` → `device-app`, `-e2e`,
    `-desktop`, `-install`; `appimage_env.rs`, `linux-install.sh`, `https-fake-cdn.py` → `device-app`, `-e2e`,
    `-install`; `desktop/lib/devices/device_app_installer.dart` and the integration test → `{"desktop",
    "device-app-desktop"}`; `website/scripts/device-install.sh` → `{"website", "device-app-install"}`;
    `device-app/AGENTS.md`, `device-app/RELEASE.md`, `device-app/scripts/test_release_build.py` → `{"device-app"}`.
  - `test_builds_follow_only_the_suites_that_run`: install alone → `[{"bundle": "appimage", "arch": "x64"}]`;
    `device-app-e2e` or `-desktop` → the four; update alone or none → `[]`.
  - `test_the_plan_job_outputs_carry_what_the_jobs_read`: `outputs()` of a record with `windows-e2e` and
    `device-app-install` → `"windows-e2e": "true"`, `"windows-e2e-arm64": "false"`,
    `"device-app-builds": '[{"bundle":"appimage","arch":"x64"}]'`, `"device-app-e2e": "false"`; and an output per suite.
  - GateTests `test_ci_required_holds_each_end_to_end_suite_to_its_jobs`: suites `["windows-e2e",
    "device-app-install"]` pass with every job a success and `device-app-build` a success; a skipped
    `device-app-install` or a failed `device-app-build` raises.
  - ReuseTests `test_an_end_to_end_suite_reruns_when_main_changes_what_it_reads`: PR `cli/src/devices/x.ts`, main
    `cli/src/a.ts` → `windows-e2e` not reused; main `docs/guide.md` → reused.
  - ReuseTests `test_a_reused_device_app_suite_skips_while_another_rebuilds` (Review Focus 4): PR
    `device-app/src-tauri/tauri.conf.json`, main `desktop/lib/devices/x.dart` → `device-app-desktop` runs,
    `device-app-e2e`, `-update`, `-install` reused; `plan["e2e"]["device_app_builds"]` is the four; `required_jobs` has
    `device-app-desktop`, not `device-app-linux`.
  - CrossReadTests `test_an_end_to_end_suites_own_files_are_scanned`: a temp tree with
    `cli/src/devices/x.ts` reading `'../../../backend/src/app.ts'` → `undeclared_reads(root, "windows-e2e") ==
    [("cli/src/devices/x.ts", "backend/src/app.ts")]`.
  - GitPlanTests: a manual `windows-e2e` plan has `e2e.windows_arm64` true; a manual `device-app-desktop` plan has the
    four builds.
  Then change the existing tests this breaks: `test_the_vscode_extension_belongs_to_the_cli_suite` and
  `test_the_orca_plugin_belongs_to_the_cli_suite` (`{"cli", "windows-e2e"}`; the look-alikes `{"windows-e2e"}`, never
  `cli`); `test_the_windows_installer_selects_the_pty_suite` and `test_the_shared_terminal_crate_selects_both...` (plus
  `windows-e2e`); `test_the_device_app_runs_its_own_suite_and_no_other` (renamed `..._and_its_end_to_end_suites`, sets
  as above); `test_manual_scopes_remain_explicit_and_invalid_scopes_fail` (`all` is `SUITES - E2E`);
  `test_every_cross_read_in_this_repository_is_declared` (e2e suites against `DEPENDS` only:
  `if suite not in planner.E2E` around the `PR_READS` scan, with the comment that their lists select them on purpose);
  `test_the_workflow_carries_every_suite` (also `windows-e2e-arm64` and `device-app-builds` in the plan job's outputs).
- [ ] **Step 2: Run them to see them fail.**
  `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false python3 -m unittest discover -s scripts/tests -p 'test_ci_plan.py' -v`.
  Expected: the new and changed tests FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement**, with the comments the file's style asks (why the lists select narrowly, why no
  `PR_READS`, why builds sit outside `JOBS`); the module docstring names the e2e suites; add the five scopes to
  `ci.yml`'s `options`. Run `test_every_cross_read_in_this_repository_is_declared` on the full checkout and declare
  in `DEPENDS` (or `NOT_READS`, with a reason) every read it reports.
- [ ] **Step 5: Run every process test**: `... python3 -m unittest discover -s scripts/tests -p 'test_*.py' -v`
  (prefix as Step 2). Expected: PASS.
- [ ] **Step 6: Commit** (`CI: the planner selects Windows end to end and the Device suites`).

### Task 10: The planner selects a PR's own e2e files and the dial hosts

Effort: xhigh. Depends on: Task 7, Task 9.

**Files:**
- Modify: `scripts/ci-plan.py`, `.github/workflows/ci.yml` (dispatch input, the select step, `options`, the header
  comment)
- Test: `scripts/tests/test_ci_plan.py`

**Interfaces:**
- Consumes: Task 9's `E2E`, `e2e_owners`, `e2e_plan`, `outputs`; Task 7's job ids and outputs.
- Produces:
  - `E2E` adds `linux-e2e` and `dial-hosts`; `JOBS["linux-e2e"] = {"linux-e2e", "linux-e2e-summary"}`,
    `JOBS["dial-hosts"] = {"dial-hosts"}`; `DEPENDS["linux-e2e"]` = `DEPENDS["cli"]` plus `cli/`, `tests/`,
    `plugins/harness-device-orca/`, `plugins/harness-device-vscode/`, `backend/`; `DEPENDS["dial-hosts"]` the same
    without `backend/`.
  - `LINUX_E2E_NEVER = {"cli/e2e/dialWindows.e2e.ts", "cli/e2e/diskfull.e2e.ts", "cli/e2e/agentBrowserPodman.e2e.ts"}`;
    `DIAL_HOST_FILES = ("cli/e2e/dialHost*.e2e.ts", "cli/e2e/deviceHerdr.e2e.ts")` (fnmatch);
    `DIAL_HOST_PATHS`: `cli/e2e/harness/dialHosts.ts`, `cli/vitest.e2e.dialHosts.config.ts`, the adapters
    `cli/src/cable/hosts/{herdr,herdrClient,herdrOuter,herdrSource,kitty,linuxDesktop,linuxRaise,linuxRaiseSway,linuxRaiseX11,wezterm,zellij}.ts`,
    `cli/src/cable/portAccess.ts`, their e2e helpers `cli/e2e/harness/{herdrServer,kittyWindow,swayDesk,weztermMux,x11Desk,zellijSession}.ts`,
    `.github/workflows/cli-e2e-dial-hosts.yml`, `.github/actions/cli-e2e-setup/`.
  - `linux_e2e_file(path) -> bool`: under `cli/e2e/`, ends `.e2e.ts`, not in `LINUX_E2E_NEVER`, not a dial-host file.
    `dial_hosts_path(path) -> bool`. `e2e_owners` adds both.
  - `select(paths, present=None)`: `present` is the set of paths the diff adds or modifies (`None`: all of them);
    `linux-e2e` joins a path's scopes only when the path is present. `changed_paths(root, old, new, present_only=False)`
    adds `--diff-filter=d` when asked; `make_plan` passes a pull request's present paths to `select` and `e2e_plan`.
  - `E2E_FILE = re.compile(r"cli/e2e/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.e2e\.ts")` (fullmatch);
    `LINUX_E2E_RUNNERS = 4`, `LINUX_E2E_FILES_MAX = 40`, `LINUX_E2E_RUNNER_MS = 600_000`, `LINUX_E2E_FULL_SHARDS = 8`
    (cli-e2e.yml's `shard: [1..8]`, the count `vitest.e2e.ci.config.ts --shard=N/8` and its duration sequencer split).
  - `e2e_plan(paths, running, root=None, head=None, present=None, files=None)` (Task 9's calls keep working; `make_plan`
    passes all) adds `"linux_files"` (`cli/`-relative, sorted), `"linux_shards"` (int, 0 when not running) and
    `"linux_full"` (bool): files from `files` (a dispatch) or the present `linux_e2e_file` paths; each must fullmatch
    `E2E_FILE`, else `ValueError` naming it (in both modes). More than `LINUX_E2E_FILES_MAX` (answer 6) → full mode:
    `linux_full` true, `linux_files` `[]`, `linux_shards` `LINUX_E2E_FULL_SHARDS`, no hints read. Else hints from
    `git show <head>:cli/ci-e2e-durations.json` (`defaultDurationMs`, `durationMs` keyed `e2e/...`, missing file →
    `ValueError`); shards `min(LINUX_E2E_RUNNERS, len(files), max(1, ceil(total_ms / LINUX_E2E_RUNNER_MS)))`.
  - `make_plan(root, event_name, event, scope="full", source=None, evidence=None, e2e_files="")`: on
    `workflow_dispatch`, `e2e_files` (space-separated repository paths) is required for scope `linux-e2e` and refused
    for any other; each must be a `linux_e2e_file` that `git ls-tree <head> -- <path>` finds.
  - `outputs()` adds `linux-e2e-files` (the list joined by spaces), `linux-e2e-shards` (`[1, ..., N]`, `[]` when
    none) and `linux-e2e-full` (`true`/`false`). CLI flag `--e2e-files`. The step summary adds "Linux end to end: N
    files on M runners" with the files, or in full mode "Linux end to end: N e2e files changed, more than 40: the full
    suite on 8 shards".
  - `ci.yml`: dispatch input `e2e_files` (`type: string`, default `''`, description "With scope linux-e2e: the cli/e2e
    files to run, separated by spaces"); the select step's `env` `CI_E2E_FILES: ${{ inputs.e2e_files }}` and
    `--e2e-files "$CI_E2E_FILES"`; `linux-e2e` and `dial-hosts` in `options`; the header says which end-to-end checks PR
    CI runs and that the full CLI suite, macOS and the browser checks stay out.

- [ ] **Step 1: Write the failing tests:**
  - GitPlanTests `test_the_prs_added_and_modified_e2e_files_run_on_linux`: base holds `cli/e2e/b.e2e.ts`,
    `cli/e2e/c.e2e.ts` and a hints file; the PR adds `a`, modifies `b`, deletes `c` → `linux-e2e` in suites,
    `plan["e2e"]["linux_files"] == ["e2e/a.e2e.ts", "e2e/b.e2e.ts"]`, `linux_shards == 1`.
  - `test_a_pr_that_only_deletes_an_e2e_file_runs_no_linux_e2e`.
  - `test_dial_host_files_and_adapters_run_the_dial_hosts_job_not_linux_e2e`: `dialHostKitty.e2e.ts` and
    `deviceHerdr.e2e.ts` → `dial-hosts`, not `linux-e2e`; each `DIAL_HOST_PATHS` entry → `dial-hosts`.
  - `test_some_files_never_run_on_linux`: each of `LINUX_E2E_NEVER` → not `linux_e2e_file`, no `linux-e2e`.
  - `test_the_dial_host_files_are_the_ones_cli_e2e_leaves_out`: `DIAL_HOST_FILES` equals `cli/` plus the entries of
    `export const DIAL_HOST_FILES = [...]` in `cli/e2e/harness/dialHosts.ts` (skips in a sparse checkout, as
    `test_every_declared_input_exists` does), and every `DIAL_HOST_PATHS` entry exists.
  - `test_files_spread_over_runners_by_their_hints`: three files hinted 10 minutes each → 3; twelve at the 60 s default
    → 2; thirty at 10 minutes → 4.
  - `test_more_than_40_files_run_the_full_suite_on_the_nightlys_shards`: 41 files (no hints file in the tree) →
    `linux_full` true, `linux_files == []`, `linux_shards == 8`, `outputs()` gives `"linux-e2e-full": "true"`,
    `"linux-e2e-files": ""`, `"linux-e2e-shards": "[1,2,3,4,5,6,7,8]"`; 40 files → `linux_full` false, the files
    listed, at most 4 shards; 41 files with one named `cli/e2e/a b.e2e.ts` → `ValueError` naming it.
  - GateTests `test_ci_required_takes_the_same_linux_e2e_jobs_in_both_modes`: a plan with `linux-e2e` has
    `required_jobs` holding `linux-e2e` and `linux-e2e-summary` whether `linux_full` is true or false; `verify` passes
    with both a success and raises when `linux-e2e-summary` is skipped.
  - `test_an_e2e_file_name_outside_the_safe_set_fails_the_plan` (Review Focus 1): `cli/e2e/a b.e2e.ts`,
    `cli/e2e/$(x).e2e.ts`, `cli/e2e/a;b.e2e.ts`, `cli/e2e/'a.e2e.ts` → `ValueError` naming the file.
  - `test_a_dispatch_runs_the_e2e_files_it_names`: scope `linux-e2e` with `cli/e2e/a.e2e.ts` → suites `["linux-e2e"]`,
    files `["e2e/a.e2e.ts"]`; no files → `ValueError`; files with scope `cli` → `ValueError`; a file not in the tree, or
    `cli/e2e/diskfull.e2e.ts` → `ValueError` naming it.
  - ReuseTests: PR `cli/e2e/a.e2e.ts`, main `cli/src/a.ts` → `linux-e2e` not reused.
  - `test_the_plan_job_outputs_carry_what_the_jobs_read` gains `linux-e2e-files`, `linux-e2e-shards` and
    `linux-e2e-full`;
    `test_the_workflow_carries_every_suite` gains those outputs, the `e2e_files` input and the select step's flag.
- [ ] **Step 2: Run them to see them fail** (Task 9's Step 2 command).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement**, and declare what the cross-read scan reports for the two new suites.
- [ ] **Step 5: Run every process test** (Task 9's Step 5): PASS.
- [ ] **Step 6: Commit** (`CI: the planner runs a PR's own e2e files on Linux, and the dial hosts`).

### Task 11: The docs say what PR CI now runs

Effort: medium. Depends on: Task 10. Red test: none (docs). One commit.

**Files:**
- Modify: `docs/validation-and-release.md`, `device-app/AGENTS.md`

- [ ] **Step 1: `docs/validation-and-release.md`.** PR CI table: a row per suite with the paths that select it and its
  typical time (windows-e2e x64 about 16 min, with arm64 about 27 more; linux-e2e 1 to 4 runners, or above 40
  changed e2e files the full suite on the nightly's 8 shards; dial hosts about 4; the Device suites by job). The
  linux-e2e row says a file whose every case skips on Linux passes and is listed, a file that collects no test fails,
  and macOS-only files are not verified by PR CI. "What PR CI does not run": the CLI end-to-end row says the full suite stays nightly and by
  hand while a PR's own e2e files and the dial hosts run on PRs; the Harness Device end-to-end row keeps `macos.sh` and
  `appimage-starts.sh` (by hand) and drops the Linux/Windows drivers, the one-line install and "in a workflow of your
  own" (now PR CI); no row tells anyone to write a workflow of their own. Suite details: the CLI e2e paragraph no longer
  calls the PR path advisory; the manual scopes list the seven e2e scopes and `e2e_files`. Reuse after Update branch:
  `cli/e2e/` is skipped by the CLI's suite only; `linux-e2e` and `dial-hosts` read it. Automatic CI and rollout: the
  e2e suites select across components by their path lists; `all` selects every component suite; the "remains
  advisory" sentence is about the full nightly suite.
- [ ] **Step 2: `device-app/AGENTS.md`.** The end-to-end bullet and the closing PR CI line name `device-app-e2e`,
  `device-app-update`, `device-app-desktop` and `device-app-install` and what selects each; `macos.sh` stays by hand.
- [ ] **Step 3: Commit** (`Docs: Windows and Linux end to end on pull requests`).

## Verification

All checks run on GitHub-hosted runners of this repository or on the Mac that builds the branch. Nothing reaches a
backend or account: fake CLI, loopback servers and stand-in CDN, signed-out daemons, temp homes, the in-memory backend
(`linux-e2e`); the only public reads are the two of decision 7. No check needs the user's own login, a device or their
eye. No temporary workflow: every new job is dispatchable from the branch with **CI → Run workflow**. One heavy run at a
time: start the next after `gh run watch <id>` returns and the orchestrator gives its go.

1. **Local, at the end** (Mac): `python3 -m unittest discover -s scripts/tests -p 'test_*.py'` (with the `GIT_CONFIG_*`
   prefix), `python3 -m unittest discover -s device-app/scripts -p 'test_*.py'`,
   `cd cli && npx vitest run src/scripts/windowsWorkflows.spec.ts`, and, with Go, actionlint on `ci.yml`,
   `cli-e2e.yml`, `cli-e2e-dial-hosts.yml` and `windows.yml` (the plan job's command). All pass.
2. **This PR's own plan** (open it as a draft): `plan` passes actionlint; its summary and `ci-plan` artifact select
   `cli`, `companions`, `pty`, `windows-e2e` (x64 and arm64: `windows.yml`, `windowsWorkflows.spec.ts`), `dial-hosts`
   (its workflow and action), `device-app`, `device-app-e2e` (`linux.sh`) and `device-app-update` (`release-setup.sh`);
   not `linux-e2e`, `device-app-desktop`, `device-app-install`.
3. **The spec's negative:** the unit test of Task 9, and the new planner's `select()` run (a scratch script in the
   session scratchpad, not committed) over last week's merged commits: a CLI-only commit outside the lists (for example
   one touching only `cli/src/core/`) selects no e2e suite.
4. **Dispatch runs on `chore/ci-win-linux-e2e`, one heavy run at a time, each only after the orchestrator's go**
   (answer 7: only `linux-e2e`, `device-app-desktop` and `device-app-install`, the suites the ready run will not
   select; `windows-e2e`, `dial-hosts`, `device-app-e2e` and `device-app-update` come from the ready run, 5):
   a. `scope=linux-e2e`, `e2e_files="cli/e2e/startup.e2e.ts cli/e2e/updateHostile.e2e.ts cli/e2e/races.e2e.ts"` (hints
      677 s: 2 runners): `linux-e2e (1)`, `linux-e2e (2)` and `linux-e2e-summary` green; the summary's table lists
      `updateHostile.e2e.ts`'s skipped macOS block; `ci/required` green.
   b. Every case skipped (answer 1): `scope=linux-e2e`, `e2e_files=cli/e2e/perf.e2e.ts` (opt-in only, no case runs on
      Linux): `linux-e2e-summary` green, its summary lists `e2e/perf.e2e.ts` under `Every case skipped` with the line
      `macOS-only files are not verified by PR CI.`; `ci/required` green. A file that collects no test failing is
      pinned by Task 3's tests. Plan-only negative: `e2e_files=cli/e2e/diskfull.e2e.ts` fails `plan` naming the file
      (one small job). The full mode (above 40 files) is pinned by Task 10's tests; its rows run the steps of a. on the
      nightly's 8 shards, so no dispatch shows it.
   c. With the ready run below: `device-app-e2e` shows `device-app-linux` green on 22.04 and 22.04-arm with every `ok:`
      and `0 FAILED`, including the two real install lines (`install.sh --host ... reads 0`, `--desktop exits 0`);
      `device-app-windows` green on x64 and arm64.
   d. `scope=device-app-desktop`: four builds, then the four Desktop legs green.
   e. `scope=device-app-install`: the x64 AppImage build, then 22.04, 24.04 and 26.04 each with eight `ok:` and
      `0 FAILED`. If 26.04 stops on a missing package, drop `ubuntu-26.04` from the matrix (the spec's fallback), say so
      in the PR, and rerun once.
5. **The ready run:** mark the PR ready. Every selected suite runs and passes: `windows-e2e` (both architectures; the
   flasher step prints its firmware line after its first try), `dial-hosts`, `device-app-e2e`, `device-app-update` (the
   three legs, Windows first), the CLI, companions, pty and device-app checks; `ci/required` green, its receipt listing
   them. The x64-alone call is pinned by Task 1's script test; the first PR with widened-only paths shows it on GitHub.
6. **Numbers for the PR body** (x64 and ARM apart): for each run of 4 and 5,
   `gh api --paginate repos/{owner}/{repo}/actions/runs/<id>/jobs` gives each job's `labels`, `created_at`,
   `started_at`, `completed_at`: runner minutes = completed minus started, queue = started minus created, ARM = a label
   with `-arm` or `windows-11-arm`. Per week: the scratch script counts last week's merged commits (2026-11-14 to 11-21)
   that select each suite (and arm64, and the files and runners of `linux-e2e`), times the measured minutes per run.
   Before is 0 for every suite (none ran in PR CI); after is that product. The longest added wall time is the longest
   new suite's created-to-last-completed time. The body also lists the red nightly (`machine.e2e.ts` on 11-20;
   `deviceClaudeOrca`, `deviceNotify`, `scale` on 11-18; `adopt`, `diskfull`, `enginehomes`, `engineModelControl` on
   11-17) as listed, not fixed, and names the devcrew skill's temporary-workflow step as out of scope.
7. **After the merge** (not blocking; answer 7 dispatches nothing more before it): the next nightly **CLI end to end**
   run's shards get past setup through the new action, and its `dial-hosts / e2e (dial hosts)` job (the caller in
   `cli-e2e.yml`) is green. The agent browser's Podman job (by hand only, about 50 minutes) shows the action there on
   its next run by hand.
