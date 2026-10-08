"""Session exit must release graphical services without ending agent work."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SESSION = ROOT / 'os/root/usr/lib/harness-os/session'


class GraphicalSession(unittest.TestCase):
    def exercise(self, display_status, stop_status=0):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            commands = home / '.local/bin'
            commands.mkdir(parents=True)
            # Harness uses merged-/usr Linux; macOS keeps mkdir in /bin.
            (commands / 'mkdir').symlink_to(shutil.which('mkdir'))
            (home / 'projects').mkdir()
            for name, body in {
                'labwc': 'echo display >> "$EVENTS"; exit "$DISPLAY_STATUS"',
                'systemctl': 'echo "systemctl $*" >> "$EVENTS"; '
                             'if [ "$2" = stop ]; then exit "$STOP_STATUS"; fi',
                'python3': 'exit 0',
                'virtio-2d': 'exit 1',
                'stty': 'exit 1',
                'hn': 'echo terminal >> "$EVENTS"',
                # End only the fixture fallback loop after its first terminal.
                'sleep': 'exit 71',
            }.items():
                path = commands / name
                path.write_text('#!/bin/sh\n' + body + '\n')
                path.chmod(0o755)
            script = SESSION.read_text().replace('/usr/lib/harness-os/', str(commands) + '/')
            script = script.replace('/usr/bin/python3', str(commands / 'python3'))
            script = script.replace('/usr/bin/hn', str(commands / 'hn'))
            script = script.replace('/etc/harness-live', str(home / 'not-live'))
            events = home / 'events'
            result = subprocess.run(['/bin/sh'], input=script, text=True, capture_output=True,
                                    env=dict(os.environ, HOME=str(home), XDG_RUNTIME_DIR=str(home),
                                             EVENTS=str(events), DISPLAY_STATUS=str(display_status),
                                             STOP_STATUS=str(stop_status)), timeout=15)
            self.assertTrue(events.exists(), f'{result.returncode}: {result.stderr}')
            return result, events.read_text().splitlines()

    def test_an_update_reload_cannot_stop_the_running_screen(self):
        # BindsTo stops the screen whenever graphical-session.target is inactive, which a session
        # from before that target (preview 14) is when an update reloads systemd.
        target = (ROOT / 'os/root/usr/lib/systemd/user/harness-os.target').read_text().splitlines()
        self.assertFalse([line for line in target if line.startswith('BindsTo=')])
        for line in ['Requires=graphical-session.target', 'PartOf=graphical-session.target',
                     'PropagatesStopTo=graphical-session.target']:
            self.assertIn(line, target)

    def test_success_stops_graphical_services_without_stopping_agents(self):
        result, events = self.exercise(0)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events, ['display', 'systemctl --user stop harness-os.target'])

    def test_compositor_failure_cleans_up_before_console_fallback(self):
        result, events = self.exercise(139)
        self.assertEqual(result.returncode, 71, result.stderr)
        self.assertEqual(events, ['display', 'systemctl --user stop harness-os.target',
                                  'systemctl --user start harness-daemon.service', 'terminal'])
        self.assertIn('continuing in hn on the console', result.stdout)

    def test_unavailable_user_manager_does_not_prevent_fallback(self):
        result, events = self.exercise(1, stop_status=1)
        self.assertEqual(result.returncode, 71, result.stderr)
        self.assertEqual(events[-1], 'terminal')


if __name__ == '__main__':
    unittest.main()
