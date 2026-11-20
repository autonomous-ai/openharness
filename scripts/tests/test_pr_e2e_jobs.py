"""PR CI's end-to-end jobs in ci.yml: what each runs, where, and that ci/required waits for it."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
CI = ROOT / ".github/workflows/ci.yml"
DEVICE_SETUP = ROOT / ".github/actions/device-app-setup/action.yml"
LOCK = ("ci-${{ github.event_name }}-${{ github.event.action || 'run' }}-"
        "${{ github.event.pull_request.number || github.run_id }}-")


def ci_jobs():
    """ci.yml's text, its jobs by id (test_ci_plan.py's split), and the jobs ci/required needs."""
    text = CI.read_text()
    jobs = dict(re.findall(r"(?m)^  ([\w-]+):\n((?:(?:    .*)?\n)+)", text))
    needs = set(re.findall(r"[\w-]+", re.search(r"(?m)^    needs: \[((?:.|\n)+?)\]", jobs["required"]).group(1)))
    return text, jobs, needs


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
                     "retention-days: 1\n"):
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
        for name in ("windows-e2e", "device-app-build", *DEVICE_JOBS):
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


if __name__ == "__main__":
    unittest.main()
