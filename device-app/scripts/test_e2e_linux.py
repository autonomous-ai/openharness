"""e2e/linux.sh's rules that run without a display: its CDN classifier, fed sample log lines through bash. Nothing is
downloaded and no app runs."""
from pathlib import Path
import re
import subprocess
import unittest

LINUX_SH = Path(__file__).resolve().parent / "e2e" / "linux.sh"


def function(name):
    """The shell function `name` from linux.sh's text: the script itself starts a D-Bus session and an app."""
    found = re.search(rf"(?ms)^{name}\(\) {{\n.*?^}}\n", LINUX_SH.read_text())
    if found is None:
        raise AssertionError(f"linux.sh has no {name} function")
    return found.group(0)


def cdn_failure(flag, *lines):
    result = subprocess.run(["bash", "-c", f'set -euo pipefail\n{function("cdn_failure")}cdn_failure "$1"', "-", flag],
                            input="".join(line + "\n" for line in lines), capture_output=True, text=True, timeout=10)
    if result.returncode != 0:
        raise AssertionError(result.stderr)
    return result.stdout.strip()


class CdnFailureTests(unittest.TestCase):
    def test_a_network_failure_of_the_failed_run_is_the_cdns(self):
        for line in ("install: last: curl: (6) Could not resolve host: cdn.autonomous.ai",
                     "install: last: curl: (28) Connection timed out after 20002 milliseconds",
                     "install: last: curl: (56) Recv failure: Connection reset by peer",
                     "install: last: curl: (22) The requested URL returned error: 503"):
            with self.subTest(line=line):
                self.assertEqual(cdn_failure("--desktop", "install: --host exit 0", "install: --desktop exit 1", line,
                                             "install: last: ✗ Could not download https://cdn.autonomous.ai/x"), line)

    def test_a_refusal_a_local_error_or_another_line_is_the_changes(self):
        for line in ("install: last: curl: (22) The requested URL returned error: 404",
                     "install: last: curl: (23) Failure writing output to destination",
                     "install: last: curl: (2) option --bogus: is unknown",
                     "install: last: ✗ Could not download https://cdn.autonomous.ai/x",
                     "install: last: ✗ Could not fetch the Node runtime manifest: https://cdn.autonomous.ai/x",
                     "install: last: sh: 1: harness: not found"):
            with self.subTest(line=line):
                self.assertEqual(cdn_failure("--desktop", "install: --desktop exit 1", line), "")

    def test_only_the_named_runs_last_lines_count(self):
        curl = "install: last: curl: (6) Could not resolve host: cdn.autonomous.ai"
        # Before its result, or another run's.
        self.assertEqual(cdn_failure("--desktop", curl, "install: --desktop exit 1"), "")
        self.assertEqual(cdn_failure("--desktop", "install: --host exit 1", curl), "")
        self.assertEqual(cdn_failure("--host", "install: --host exit 0", "install: --desktop exit 1", curl), "")
        # No result yet: the run has not failed.
        self.assertEqual(cdn_failure("--host", curl), "")


if __name__ == "__main__":
    unittest.main()
