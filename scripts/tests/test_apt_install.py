"""A passing outage of a runner's Ubuntu mirrors costs a wait; a lasting one fails, naming apt (#4186)."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/apt-install.sh"

# apt-get as a runner's mirrors answer it: an update whose indexes cannot be fetched still exits 0 ("ignored, or old
# ones used instead", run 43039005877), and the download after it fails. FAIL_UPDATES and FAIL_DOWNLOADS fail the
# first calls of each; an update that fails is one `timeout` stopped (124).
FAKE_APT = """#!/bin/sh
echo "apt-get $*" >> "$STATE/calls"
case "$*" in
  *" update") kind=updates; fail=${FAIL_UPDATES:-0}; code=124 ;;
  *--download-only*) kind=downloads; fail=${FAIL_DOWNLOADS:-0}; code=100 ;;
  *) exit 0 ;;
esac
n=$(($(cat "$STATE/$kind" 2>/dev/null || echo 0) + 1))
echo "$n" > "$STATE/$kind"
[ "$n" -le "$fail" ] && exit "$code"
exit 0
"""
FAKE_TIMEOUT = """#!/bin/sh
echo "timeout $1" >> "$STATE/calls"
shift
exec "$@"
"""
# Never a real wait: the test reads how long the script would have waited.
FAKE_SLEEP = """#!/bin/sh
echo "sleep $1" >> "$STATE/calls"
"""

APT = "apt-get -q -o Acquire::Retries=3"
UPDATE = f"{APT} update"
DOWNLOAD = f"{APT} install -y --no-install-recommends --download-only tmux zsh"
INSTALL = f"{APT} install -y --no-install-recommends tmux zsh"


class AptInstallTests(unittest.TestCase):
    def install(self, *packages, fail_updates=0, fail_downloads=0):
        with tempfile.TemporaryDirectory() as state:
            bin_dir = Path(state) / "bin"
            bin_dir.mkdir()
            for name, body in (("apt-get", FAKE_APT), ("timeout", FAKE_TIMEOUT), ("sleep", FAKE_SLEEP)):
                (bin_dir / name).write_text(body)
                (bin_dir / name).chmod(0o755)
            env = {
                **os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "STATE": state,
                "FAIL_UPDATES": str(fail_updates), "FAIL_DOWNLOADS": str(fail_downloads),
            }
            done = subprocess.run(["bash", str(SCRIPT), *packages], env=env, capture_output=True, text=True, timeout=30)
            calls_file = Path(state) / "calls"
            calls = calls_file.read_text().splitlines() if calls_file.exists() else []
            return done, calls

    def test_a_reachable_mirror_downloads_then_installs_once_with_every_network_call_bounded(self):
        done, calls = self.install("tmux", "zsh")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(calls, ["timeout 180", UPDATE, "timeout 180", DOWNLOAD, INSTALL])

    def test_a_passing_blip_costs_one_wait(self):
        done, calls = self.install("tmux", "zsh", fail_downloads=1)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(calls, [
            "timeout 180", UPDATE, "timeout 180", DOWNLOAD, "sleep 30",
            "timeout 180", UPDATE, "timeout 180", DOWNLOAD, INSTALL,
        ])
        self.assertIn("apt: attempt 1 of 3 could not download; trying again in 30s", done.stdout)

    def test_an_update_that_fails_or_runs_out_of_time_is_tried_again_before_any_download(self):
        done, calls = self.install("tmux", "zsh", fail_updates=2)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(calls, [
            "timeout 180", UPDATE, "sleep 30", "timeout 180", UPDATE, "sleep 60",
            "timeout 180", UPDATE, "timeout 180", DOWNLOAD, INSTALL,
        ])

    def test_a_lasting_outage_fails_after_three_attempts_naming_apt_and_installs_nothing(self):
        done, calls = self.install("tmux", "zsh", fail_downloads=99)
        self.assertEqual(done.returncode, 1)
        self.assertEqual([call for call in calls if call.startswith("sleep")], ["sleep 30", "sleep 60"])
        self.assertEqual(calls.count(DOWNLOAD), 3)
        self.assertNotIn(INSTALL, calls)
        self.assertIn(
            "::error title=apt::apt could not download tmux zsh from the runner's Ubuntu mirrors after 3 attempts",
            done.stdout,
        )

    def test_no_package_is_a_usage_error(self):
        done, calls = self.install()
        self.assertEqual(done.returncode, 2)
        self.assertIn("usage: apt-install.sh PACKAGE...", done.stderr)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
