"""Dry-run the uploader's real staple function; never invoke Apple or signing tools."""
from pathlib import Path
import subprocess
import tempfile
import unittest

UPLOADER = Path(__file__).with_name('upload-desktop.sh')


class StapleTests(unittest.TestCase):
    def run_staple(self, failure, failures):
        source = UPLOADER.read_text()
        function = source[source.index('staple() {'):source.index('\nif [ "$DO_NOTARIZE"', source.index('staple() {'))]
        fixture = r'''
xcrun() {
  [ "$1 $2" = 'stapler staple' ] || return 99
  [ "$3" = 'fixture with spaces.app' ] || return 98
  attempts=$(($(wc -l < "$calls") + 1))
  echo call >> "$calls"
  if [ "$attempts" -le "$failures" ]; then
    echo "$failure"
    return 68
  fi
  echo 'The staple and validate action worked!'
}
sleep() { echo "backoff $1"; }
'''
        # A file holds counts because production captures tool output in a subshell.
        with tempfile.TemporaryDirectory() as folder:
            calls = Path(folder) / 'calls'
            calls.touch()
            result = subprocess.run(
                ['bash', '-c', 'set -euo pipefail\ncalls=$1; failure=$2; failures=$3\n' + fixture + function +
                 '\nstaple "fixture with spaces.app"', 'fixture', str(calls), failure, str(failures)],
                text=True, capture_output=True, timeout=5)
            return result, len(calls.read_text().splitlines())

    def test_network_loss_then_success(self):
        result, calls = self.run_staple('NSURLErrorDomain Code=-1005 "The network connection was lost."', 1)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, 2)
        self.assertIn('backoff 15', result.stdout)

    def test_longer_network_outage_recovers_on_sixth_attempt(self):
        result, calls = self.run_staple('NSURLErrorDomain Code=-1005 "The network connection was lost."', 5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, 6)
        self.assertIn('backoff 240', result.stdout)

    def test_persistent_network_failure_is_bounded(self):
        result, calls = self.run_staple('NSURLErrorDomain Code=-1001 "The request timed out."', 99)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, 6)
        self.assertIn('after 6 attempts', result.stderr)

    def test_ticket_not_yet_published_then_success(self):
        result, calls = self.run_staple('The staple and validate action failed! Error 65.', 1)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, 2)
        self.assertIn('backoff 15', result.stdout)

    def test_real_stapling_error_still_fails_after_five_attempts(self):
        result, calls = self.run_staple('The staple and validate action failed! Error 65.', 99)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, 5)
        self.assertIn('backoff 60', result.stdout)
        self.assertIn('after 5 attempts', result.stderr)


if __name__ == '__main__':
    unittest.main()
