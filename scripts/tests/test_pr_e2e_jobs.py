"""PR CI's end-to-end jobs in ci.yml: what each runs, where, and that ci/required waits for it."""
from pathlib import Path
import re
import unittest

from test_cli_e2e_workflow import jobs

ROOT = Path(__file__).resolve().parents[2]
CI = ROOT / ".github/workflows/ci.yml"
DEVICE_SETUP = ROOT / ".github/actions/device-app-setup/action.yml"
LOCK = ("ci-${{ github.event_name }}-${{ github.event.action || 'run' }}-"
        "${{ github.event.pull_request.number || github.run_id }}-")


def ci_jobs():
    """ci.yml's text, its jobs by id, and the jobs ci/required needs."""
    text = CI.read_text()
    by_id = jobs(text)
    needs = set(re.findall(r"[\w-]+", re.search(r"(?m)^    needs: \[((?:.|\n)+?)\]", by_id["required"]).group(1)))
    return text, by_id, needs


class WindowsE2ETests(unittest.TestCase):
    def test_windows_e2e_calls_windows_yml_x64_alone_unless_the_plan_says_arm64(self):
        _, jobs, needs = ci_jobs()
        job = jobs.get("windows-e2e")
        self.assertIsNotNone(job, "ci.yml has no windows-e2e job")
        for text in ("uses: ./.github/workflows/windows.yml",
                     "x64_only: ${{ needs.plan.outputs.windows-e2e-arm64 != 'true' }}",
                     "if: needs.plan.outputs.ready == 'true' && needs.plan.outputs.windows-e2e == 'true'",
                     f"group: {LOCK}windows-e2e\n",
                     "cancel-in-progress: ${{ github.event_name == 'pull_request' }}"):
            self.assertIn(text, job)
        for output in ("windows-e2e", "windows-e2e-arm64"):
            self.assertIn(f"      {output}: ${{{{ steps.select.outputs.{output} }}}}\n", jobs["plan"])
        self.assertIn("windows-e2e", needs)


# Each Device test job: its rows' runners in order, its needs, max-parallel, timeout-minutes and the suite output that
# selects it (the plan's Task 8 table).
DEVICE_JOBS = {
    "device-app-linux": (["ubuntu-22.04", "ubuntu-22.04-arm"], "[plan, device-app-build]", 2, 45, "device-app-e2e"),
    "device-app-windows": (["windows-latest", "windows-11-arm"], "[plan, device-app-build]", 2, 30, "device-app-e2e"),
    "device-app-update": (["windows-latest", "ubuntu-22.04", "ubuntu-22.04-arm"], "plan", 2, 60, "device-app-update"),
    "device-app-desktop": (["windows-latest", "windows-11-arm", "ubuntu-22.04", "ubuntu-22.04-arm"],
                           "[plan, device-app-build]", 2, 45, "device-app-desktop"),
    "device-app-install": (["ubuntu-22.04", "ubuntu-24.04", "ubuntu-26.04"], "[plan, device-app-build]", 1, 15,
                           "device-app-install"),
}
BUILD_RUNNERS = ("runs-on: ${{ fromJSON('{\"appimage-x64\":\"ubuntu-22.04\",\"appimage-arm64\":\"ubuntu-22.04-arm\","
                 "\"nsis-x64\":\"windows-latest\",\"nsis-arm64\":\"windows-11-arm\"}')"
                 "[format('{0}-{1}', matrix.bundle, matrix.arch)] }}\n")


def rows(job):
    """The runners of a job's matrix rows, in order."""
    return re.findall(r"(?m)^          - \{ runner: ([\w.-]+)", job)


def parallel(job):
    return int(re.search(r"(?m)^      max-parallel: (\d+)$", job).group(1))


class DeviceAppE2ETests(unittest.TestCase):
    def setUp(self):
        self.text, self.jobs, self.needs = ci_jobs()
        for job in ("device-app-build", *DEVICE_JOBS):
            self.assertTrue(job in self.jobs, f"ci.yml has no {job} job")

    def test_each_device_app_job_runs_on_its_pinned_runners_within_its_limits(self):
        for name, (runners, needs, most, minutes, suite) in DEVICE_JOBS.items():
            job = self.jobs[name]
            with self.subTest(job=name):
                self.assertEqual(rows(job), runners)
                self.assertIn("    runs-on: ${{ matrix.runner }}\n", job)
                self.assertIn(f"    needs: {needs}\n", job)
                self.assertEqual(parallel(job), most)
                self.assertIn(f"    timeout-minutes: {minutes}\n", job)
                self.assertIn("      fail-fast: false\n", job)
                self.assertIn(f"    if: needs.plan.outputs.ready == 'true' && needs.plan.outputs.{suite} == 'true'\n", job)
                self.assertIn(f"group: {LOCK}{name}-${{{{ strategy.job-index }}}}\n", job)
                self.assertIn("cancel-in-progress: ${{ github.event_name == 'pull_request' }}", job)
        build = self.jobs["device-app-build"]
        self.assertIn(BUILD_RUNNERS, build)
        self.assertIn("    needs: plan\n", build)
        self.assertIn("    timeout-minutes: 40\n", build)
        self.assertIn("      fail-fast: false\n", build)
        self.assertIn(f"group: {LOCK}device-app-build-${{{{ strategy.job-index }}}}\n", build)
        for output in ("device-app-e2e", "device-app-update", "device-app-desktop", "device-app-install",
                       "device-app-builds"):
            self.assertIn(f"      {output}: ${{{{ steps.select.outputs.{output} }}}}\n", self.jobs["plan"])

    def test_the_builds_are_made_once_and_handed_on(self):
        build = self.jobs["device-app-build"]
        for text in ("        include: ${{ fromJSON(needs.plan.outputs.device-app-builds) }}\n",
                     "    if: needs.plan.outputs.ready == 'true' && needs.plan.outputs.device-app-builds != '[]'\n",
                     "uses: ./.github/actions/device-app-setup\n",
                     "cargo tauri build --ci --debug --bundles \"$BUNDLE\" -- --locked\n",
                     "name: device-app-${{ matrix.bundle }}-${{ matrix.arch }}\n",
                     "retention-days: 3\n"):
            self.assertIn(text, build)
        downloads = {
            "device-app-linux": "device-app-appimage-${{ matrix.arch }}",
            "device-app-windows": "device-app-nsis-${{ matrix.arch }}",
            "device-app-desktop": "device-app-${{ matrix.bundle }}-${{ matrix.arch }}",
            "device-app-install": "device-app-appimage-x64",
        }
        for name, artifact in downloads.items():
            with self.subTest(job=name):
                self.assertRegex(self.jobs[name], r"uses: actions/download-artifact@v4\n\s+with:\n\s+name: "
                                 + re.escape(artifact) + "\n")
        self.assertEqual(self.text.count("cargo tauri build"), 1)
        self.assertNotIn("cargo install tauri-cli", self.text)

    def test_the_tauri_cli_is_restored_not_compiled_each_time(self):
        self.assertTrue(DEVICE_SETUP.exists(), "no .github/actions/device-app-setup/action.yml")
        action = DEVICE_SETUP.read_text()
        for text in ("using: composite",
                     "cache-dependency-path: device-app/ui/package-lock.json",
                     "uses: actions/cache@v4",
                     "~/.cargo/bin/cargo-tauri\n",
                     "~/.cargo/bin/cargo-tauri.exe\n",
                     "key: tauri-cli-${{ runner.os }}-${{ runner.arch }}-"
                     "${{ hashFiles('device-app/scripts/release-setup.sh') }}\n",
                     "run: bash device-app/scripts/release-setup.sh\n"):
            self.assertIn(text, action)
        self.assertLess(action.index("uses: actions/cache@v4"), action.index("release-setup.sh\n"))
        for step in re.split(r"(?m)^    - ", action)[1:]:
            if "run:" in step:
                self.assertIn("shell: bash", step)

    def test_at_most_nine_device_app_runners_at_once(self):
        self.assertEqual(sum(min(parallel(self.jobs[name]), len(rows(self.jobs[name]))) for name in DEVICE_JOBS), 9)
        # The builds' rows: appimage and nsis, x64 and arm64, at most.
        self.assertEqual(len(re.findall(r'"(?:appimage|nsis)-(?:x64|arm64)"', BUILD_RUNNERS)), 4)

    def test_no_new_job_runs_on_ubuntu_latest_or_macos(self):
        for name in ("windows-e2e", "linux-e2e", "linux-e2e-summary", "dial-hosts", "device-app-build", *DEVICE_JOBS):
            with self.subTest(job=name):
                self.assertNotIn("ubuntu-latest", self.jobs[name])
                self.assertNotIn("macos", self.jobs[name].lower())
        self.assertEqual(self.text.count("ubuntu-26.04"), self.jobs["device-app-install"].count("ubuntu-26.04"))

    def test_screens_and_probes_stay_out(self):
        for text in ("-Screens", "fuse-probe", "appimage-starts.sh", "device-app-windows-arm64"):
            self.assertNotIn(text, self.text)

    def test_ci_required_waits_for_every_device_app_job(self):
        for name in ("device-app-build", *DEVICE_JOBS):
            self.assertIn(name, self.needs)


def run_blocks(text):
    """Every `run:` script in a workflow: the key's line and the lines indented under it."""
    blocks, lines = [], text.splitlines()
    for index, line in enumerate(lines):
        found = re.match(r"( *)(?:- )?run:", line)
        if not found:
            continue
        indent, block = len(found.group(1)), [line]
        for more in lines[index + 1:]:
            if more.strip() and len(more) - len(more.lstrip()) <= indent:
                break
            block.append(more)
        blocks.append("\n".join(block))
    return blocks


def step(job, name):
    """The block of a job's step with this name, or None."""
    found = re.search(rf"(?m)^      - name: {re.escape(name)}\n((?:        .*\n|\n)+)", job)
    return found.group(1) if found else None


class LinuxE2ETests(unittest.TestCase):
    def setUp(self):
        self.text, self.jobs, self.needs = ci_jobs()
        for job in ("linux-e2e", "linux-e2e-summary", "dial-hosts"):
            self.assertTrue(job in self.jobs, f"ci.yml has no {job} job")

    def test_linux_e2e_runs_the_plans_files_on_the_plans_shards(self):
        job = self.jobs["linux-e2e"]
        for text in ("    name: linux-e2e (${{ matrix.shard }})\n",
                     "    needs: plan\n",
                     "    if: needs.plan.outputs.ready == 'true' && needs.plan.outputs.linux-e2e == 'true'\n",
                     f"group: {LOCK}linux-e2e-${{{{ strategy.job-index }}}}\n",
                     "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
                     "      fail-fast: false\n",
                     "        shard: ${{ fromJSON(needs.plan.outputs.linux-e2e-shards) }}\n",
                     "    runs-on: ubuntu-24.04\n",
                     "    timeout-minutes: 45\n",
                     "        working-directory: cli\n",
                     "      LANG: C.UTF-8\n",
                     "      SHELL: /bin/zsh\n",
                     "          ref: ${{ env.CI_SOURCE_SHA }}\n",
                     "uses: ./.github/actions/cli-e2e-setup\n",
                     "          packages: tcsh dash\n",
                     "          real-backend: 'true'\n",
                     'read -ra files <<<"$E2E_FILES"',
                     'npx vitest list --config vitest.e2e.ci.config.ts --filesOnly '
                     '--json="$RUNNER_TEMP/inventory-$SHARD.json" "${files[@]}"',
                     'npx vitest run --config vitest.e2e.ci.config.ts --shard="$SHARD/$SHARDS"',
                     '--reporter=default --reporter=json --outputFile.json="$RUNNER_TEMP/result-$SHARD.json" '
                     '"${files[@]}"',
                     "SHARDS: ${{ strategy.job-total }}\n",
                     "E2E_BUNDLE: '1'\n",
                     "E2E_ARTIFACTS_DIR: ${{ runner.temp }}/e2e-daemon-logs\n"):
            self.assertIn(text, job)
        results = step(job, "Preserve inventory and test results")
        logs = step(job, "Preserve the failing tests' daemon logs")
        self.assertIsNotNone(results, "linux-e2e uploads no results")
        self.assertIsNotNone(logs, "linux-e2e uploads no daemon logs")
        for block, condition, name in ((results, "${{ !cancelled() }}", "linux-e2e-shard-${{ matrix.shard }}"),
                                       (logs, "${{ failure() }}", "linux-e2e-daemon-logs-${{ matrix.shard }}")):
            for text in (f"        if: {condition}\n", "uses: actions/upload-artifact@v4\n", f"name: {name}\n",
                         "retention-days: 7\n"):
                self.assertIn(text, block)

    def test_the_file_list_reaches_the_runs_only_through_the_environment(self):
        self.assertIn("      E2E_FILES: ${{ needs.plan.outputs.linux-e2e-files }}\n", self.jobs["linux-e2e"])
        blocks = run_blocks(self.text)
        self.assertTrue(any("$E2E_FILES" in block for block in blocks))
        for block in blocks:
            self.assertNotIn("needs.plan.outputs.linux-e2e-files", block)

    def test_the_summary_holds_each_selected_file_to_the_per_file_rule(self):
        job = self.jobs["linux-e2e-summary"]
        for text in ("    needs: [plan, linux-e2e]\n",
                     "    if: ${{ !cancelled() && needs.plan.outputs.ready == 'true' && "
                     "needs.plan.outputs.linux-e2e == 'true' }}\n",
                     "    runs-on: ubuntu-24.04\n",
                     "    timeout-minutes: 3\n",
                     "          sparse-checkout: scripts/verify-cli-test-shards.py\n",
                     "          pattern: linux-e2e-shard-*\n",
                     "          merge-multiple: true\n",
                     "SHARDS: ${{ needs.plan.outputs.linux-e2e-shards }}\n",
                     "E2E_FILES: ${{ needs.plan.outputs.linux-e2e-files }}\n",
                     "E2E_FULL: ${{ needs.plan.outputs.linux-e2e-full }}\n",
                     "E2E_TEST_RESULT: ${{ needs.linux-e2e.result }}\n",
                     "python3 scripts/verify-cli-test-shards.py",
                     "--suite e2e",
                     '--root "$GITHUB_WORKSPACE/cli"',
                     '--shards "$(jq length <<<"$SHARDS")"',
                     '--tests-result "$E2E_TEST_RESULT"',
                     '--step-summary "$GITHUB_STEP_SUMMARY"',
                     "name: linux-e2e-summary\n",
                     "retention-days: 7\n"):
            self.assertIn(text, job)
        self.assertNotIn("concurrency:", job)
        # --selected only for a PR's own files; in the full mode every discovered file once, as the nightly.
        self.assertIn('if [[ "$E2E_FULL" != true ]]; then args+=(--selected "$E2E_FILES"); fi', job)
        self.assertEqual(job.count("--selected"), 1)
        # The canary the plan names must pass a case, never skip: a skip there means the real backend's setup broke.
        self.assertIn("E2E_MUST_PASS: ${{ needs.plan.outputs.linux-e2e-must-pass }}\n", job)
        self.assertIn('if [[ -n "$E2E_MUST_PASS" ]]; then args+=(--must-pass "$E2E_MUST_PASS"); fi', job)
        self.assertEqual(job.count("--must-pass"), 1)
        self.assertNotRegex(job, r"if \[\[[^\n]*--step-summary")

    def test_both_linux_e2e_modes_are_the_same_two_jobs(self):
        self.assertEqual(sorted(name for name in self.jobs if name.startswith("linux-e2e")),
                         ["linux-e2e", "linux-e2e-summary"])
        for name in ("linux-e2e", "linux-e2e-summary"):
            self.assertNotRegex(self.jobs[name], r"(?m)^    if: .*linux-e2e-full")
        job = self.jobs["linux-e2e"]
        guard = step(job, "The plan gave files or a full run")
        self.assertIsNotNone(guard, "linux-e2e has no guard step")
        self.assertIn("linux-e2e: the plan gave no file and no full run", guard)
        # An empty list must never widen to the full suite by accident: the guard runs before any Vitest command.
        self.assertLess(job.index("the plan gave no file and no full run"), job.index("npx vitest"))
        self.assertIn("      E2E_FULL: ${{ needs.plan.outputs.linux-e2e-full }}\n", job)
        for output in ("linux-e2e", "linux-e2e-files", "linux-e2e-shards", "linux-e2e-full", "linux-e2e-must-pass",
                       "dial-hosts"):
            self.assertIn(f"      {output}: ${{{{ steps.select.outputs.{output} }}}}\n", self.jobs["plan"])

    def test_dial_hosts_is_the_workflow_cli_e2e_runs(self):
        job = self.jobs["dial-hosts"]
        for text in ("    uses: ./.github/workflows/cli-e2e-dial-hosts.yml\n",
                     "    needs: plan\n",
                     "    if: needs.plan.outputs.ready == 'true' && needs.plan.outputs.dial-hosts == 'true'\n",
                     f"group: {LOCK}dial-hosts\n",
                     "cancel-in-progress: ${{ github.event_name == 'pull_request' }}"):
            self.assertIn(text, job)
        self.assertNotIn("steps:", job)
        lint = step(self.jobs["plan"], "Validate the integration workflows")
        self.assertIn(".github/workflows/cli-e2e-dial-hosts.yml", lint)

    def test_ci_required_waits_for_every_linux_e2e_job(self):
        for name in ("linux-e2e", "linux-e2e-summary", "dial-hosts"):
            self.assertIn(name, self.needs)


# The planner tests that need every file of the repository, so only the scan's full checkout runs them.
FULL_CHECKOUT_TESTS = ("test_every_cross_read_in_this_repository_is_declared",
                       "test_the_dial_host_files_are_the_ones_cli_e2e_leaves_out",
                       "test_every_declared_input_exists",
                       "test_every_desktop_file_the_phone_tests_read_selects_mobile")


class CrossReadScanTests(unittest.TestCase):
    def test_the_scan_runs_on_a_full_checkout_and_gates_the_merge(self):
        _, jobs, needs = ci_jobs()
        job = jobs.get("cross-read-scan")
        self.assertIsNotNone(job, "ci.yml has no cross-read-scan job")
        for text in ("    needs: plan\n",
                     "    if: needs.plan.outputs.ready == 'true' && needs.plan.outputs.cross-read-scan == 'true'\n",
                     f"group: {LOCK}cross-read-scan\n",
                     "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
                     "    runs-on: ubuntu-24.04\n",
                     "    timeout-minutes: 10\n",
                     "          ref: ${{ env.CI_SOURCE_SHA }}\n",
                     "python3 -m unittest discover -s scripts/tests -p test_ci_plan.py"):
            self.assertIn(text, job)
        # The scan needs every file: a sparse or blob-less checkout would fail it.
        for text in ("sparse-checkout", "filter:"):
            self.assertNotIn(text, job)
        self.assertIn("      cross-read-scan: ${{ steps.select.outputs.cross-read-scan }}\n", jobs["plan"])
        self.assertIn("cross-read-scan", needs)

    def test_the_scan_runs_every_full_checkout_test_and_none_may_skip(self):
        job = ci_jobs()[1].get("cross-read-scan", "")
        # The tests read this to fail, not skip, on a checkout missing files: a skip would pass the job.
        self.assertIn("CROSS_READ_SCAN_REQUIRED: '1'\n", job)
        for name in FULL_CHECKOUT_TESTS:
            self.assertIn(f"-k {name}", job)
        # A renamed test matches no -k and would pass unseen: the job holds unittest to the count it names.
        self.assertIn(f"^Ran {len(FULL_CHECKOUT_TESTS)} tests in ", job)
        # An explicit bash runs with pipefail, so a failing test still fails the step through its log's pipe.
        self.assertIn("        shell: bash\n", job)


if __name__ == "__main__":
    unittest.main()
