"""A passing outage of a runner's Ubuntu mirrors costs a wait; a lasting one fails, naming apt (#4186). A retry fetches
from archive.ubuntu.com, as a regional mirror may be up but crawling (run 45331534043)."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/apt-install.sh"

# apt-get as a runner's mirrors answer it: an update whose indexes cannot be fetched still exits 0 ("ignored, or old
# ones used instead", run 43039005877), and the download after it fails. FAIL_UPDATES and FAIL_DOWNLOADS fail the
# first calls of each; an update that fails is one `timeout` stopped (124). Each update keeps a copy of the sources it
# read, so a test sees which mirrors each attempt used.
FAKE_APT = """#!/bin/sh
echo "apt-get $*" >> "$STATE/calls"
case "$*" in
  *" update") kind=updates; fail=${FAIL_UPDATES:-0}; code=124 ;;
  *--download-only*) kind=downloads; fail=${FAIL_DOWNLOADS:-0}; code=100 ;;
  *) exit 0 ;;
esac
n=$(($(cat "$STATE/$kind" 2>/dev/null || echo 0) + 1))
echo "$n" > "$STATE/$kind"
[ "$kind" = updates ] && cp -R "$STATE/apt" "$STATE/apt-at-update-$n"
[ "$n" -le "$fail" ] && exit "$code"
exit 0
"""
# apt-config as apt answers `apt-config shell NAME KEY...`, with apt's source files in the test's own directory.
FAKE_APT_CONFIG = """#!/bin/sh
[ "$1" = shell ] || exit 100
shift
while [ "$#" -ge 2 ]; do
  case "$2" in
    Dir::Etc::sourcelist/f) echo "$1='$STATE/apt/sources.list'" ;;
    Dir::Etc::sourceparts/d) echo "$1='$STATE/apt/sources.list.d/'" ;;
  esac
  shift 2
done
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

# apt's sources as a GitHub ubuntu-24.04 runner has them: a deb822 file reading its mirrors from a mirror list whose
# first mirror is regional, a security stanza, and one-line sources, two of them on regional mirrors. {state} is the
# test's directory.
SOURCES = {
    "sources.list": "deb http://azure.archive.ubuntu.com/ubuntu/ noble-backports main\n",
    "sources.list.d/ubuntu.sources": (
        "Types: deb\nURIs: mirror+file:{state}/apt/apt-mirrors.txt\nSuites: noble noble-updates\nComponents: main\n\n"
        "Types: deb\nURIs: http://security.ubuntu.com/ubuntu/\nSuites: noble-security\nComponents: main\n"
    ),
    "sources.list.d/extra.list": (
        "deb https://eu-west-1.ec2.archive.ubuntu.com/ubuntu noble universe\n"
        "deb https://ppa.launchpadcontent.net/git-core/ppa/ubuntu noble main\n"
    ),
    "apt-mirrors.txt": (
        "http://us-east-2.ec2.archive.ubuntu.com/ubuntu/\tpriority:1\n"
        "https://archive.ubuntu.com/ubuntu/\tpriority:2\n"
        "https://security.ubuntu.com/ubuntu/\tpriority:3\n"
    ),
}
# The same sources with every regional mirror swapped for archive.ubuntu.com.
MAIN_ARCHIVE_SOURCES = {
    "sources.list": "deb http://archive.ubuntu.com/ubuntu/ noble-backports main\n",
    "sources.list.d/ubuntu.sources": SOURCES["sources.list.d/ubuntu.sources"],
    "sources.list.d/extra.list": (
        "deb https://archive.ubuntu.com/ubuntu noble universe\n"
        "deb https://ppa.launchpadcontent.net/git-core/ppa/ubuntu noble main\n"
    ),
    "apt-mirrors.txt": (
        "http://archive.ubuntu.com/ubuntu/\tpriority:1\n"
        "https://archive.ubuntu.com/ubuntu/\tpriority:2\n"
        "https://security.ubuntu.com/ubuntu/\tpriority:3\n"
    ),
}


def read_sources(apt_dir, state):
    """Every file under apt_dir, the test's directory written back as {state}."""
    return {
        str(path.relative_to(apt_dir)): path.read_text().replace(state, "{state}")
        for path in sorted(apt_dir.rglob("*")) if path.is_file()
    }


class AptInstallTests(unittest.TestCase):
    def install(self, *packages, fail_updates=0, fail_downloads=0, sources=SOURCES):
        with tempfile.TemporaryDirectory() as state:
            bin_dir = Path(state) / "bin"
            bin_dir.mkdir()
            fakes = (("apt-get", FAKE_APT), ("apt-config", FAKE_APT_CONFIG), ("timeout", FAKE_TIMEOUT), ("sleep", FAKE_SLEEP))
            for name, body in fakes:
                (bin_dir / name).write_text(body)
                (bin_dir / name).chmod(0o755)
            (Path(state) / "apt" / "sources.list.d").mkdir(parents=True)
            for name, text in sources.items():
                path = Path(state) / "apt" / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text.replace("{state}", state))
            env = {
                **os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "STATE": state,
                "FAIL_UPDATES": str(fail_updates), "FAIL_DOWNLOADS": str(fail_downloads),
            }
            # A step's input may stay open and silent: a command that read it would wait there for good.
            silent_input, held_open = os.pipe()
            try:
                done = subprocess.run(
                    ["bash", str(SCRIPT), *packages], env=env, stdin=silent_input, capture_output=True, text=True,
                    timeout=30,
                )
            finally:
                os.close(silent_input)
                os.close(held_open)
            calls_file = Path(state) / "calls"
            calls = calls_file.read_text().splitlines() if calls_file.exists() else []
            # The sources each update read, in order, then the sources the run left.
            self.sources_seen = [
                read_sources(Path(state) / f"apt-at-update-{n}", state) for n in range(1, calls.count(UPDATE) + 1)
            ]
            self.sources_left = read_sources(Path(state) / "apt", state)
            return done, calls

    def test_a_reachable_mirror_downloads_then_installs_once_with_every_network_call_bounded(self):
        done, calls = self.install("tmux", "zsh")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(calls, ["timeout 180", UPDATE, "timeout 180", DOWNLOAD, INSTALL])

    def test_a_first_attempt_that_downloads_leaves_the_sources_as_they_were(self):
        done, _ = self.install("tmux", "zsh")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(self.sources_seen, [SOURCES])
        self.assertEqual(self.sources_left, SOURCES)

    def test_a_passing_blip_costs_one_wait(self):
        done, calls = self.install("tmux", "zsh", fail_downloads=1)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(calls, [
            "timeout 180", UPDATE, "timeout 180", DOWNLOAD, "sleep 30",
            "timeout 180", UPDATE, "timeout 180", DOWNLOAD, INSTALL,
        ])
        self.assertIn("apt: attempt 1 of 3 could not download; trying again in 30s from archive.ubuntu.com", done.stdout)

    def test_a_retry_fetches_from_archive_ubuntu_com_as_a_regional_mirror_may_be_up_but_crawling(self):
        done, _ = self.install("tmux", "zsh", fail_downloads=2)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(self.sources_seen, [SOURCES, MAIN_ARCHIVE_SOURCES, MAIN_ARCHIVE_SOURCES])
        self.assertEqual(self.sources_left, MAIN_ARCHIVE_SOURCES)
        self.assertIn("apt: attempt 2 of 3 could not download; trying again in 60s from archive.ubuntu.com", done.stdout)

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
            "::error title=apt::apt could not download tmux zsh from the runner's Ubuntu mirrors and archive.ubuntu.com"
            " after 3 attempts",
            done.stdout,
        )

    def test_a_runner_with_no_sources_still_fails_in_bounded_time_naming_apt(self):
        done, calls = self.install("tmux", "zsh", fail_downloads=99, sources={})
        self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
        self.assertEqual(calls.count(DOWNLOAD), 3)
        self.assertIn("::error title=apt::", done.stdout)

    def test_no_package_is_a_usage_error(self):
        done, calls = self.install()
        self.assertEqual(done.returncode, 2)
        self.assertIn("usage: apt-install.sh PACKAGE...", done.stderr)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
