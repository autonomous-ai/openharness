from pathlib import Path
import re
import stat
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET

OS = Path(__file__).resolve().parents[1]
ROOT = OS / 'root'
RC = ROOT / 'usr/share/harness-os/labwc/rc.xml'
LOCK = ROOT / 'usr/lib/harness-os/lock'
SCREENSHOT = ROOT / 'usr/lib/harness-os/screenshot'


def bindings():
    keyboard = ET.parse(RC).getroot().find('keyboard')
    return {bind.get('key'): [a.get('command') for a in bind.iter('action') if a.get('command')]
            for bind in keyboard.findall('keybind')}


class SessionLock(unittest.TestCase):
    def test_every_lock_goes_through_one_dressed_locker(self):
        self.assertEqual(bindings()['W-l'], ['/usr/lib/harness-os/lock'])
        idle = (ROOT / 'usr/lib/systemd/user/harness-idle.service').read_text()
        self.assertIn('timeout 600 /usr/lib/harness-os/lock before-sleep /usr/lib/harness-os/lock', idle)
        self.assertNotIn('swaylock', RC.read_text() + idle)

    def test_locker_keeps_what_the_session_checks_rely_on(self):
        text = LOCK.read_text()
        # -d returns once the lock is acknowledged (swayidle's before-sleep waits on it); the marker
        # is what tests/session_vm.py waits for, written by the lock command and removed on unlock.
        self.assertRegex(text, r'(?m)^exec gtklock -d ')
        self.assertIn('-s /usr/share/harness-os/lock/style.css', text)
        self.assertIn('-x /usr/share/harness-os/lock/layout.ui', text)
        self.assertIn('-L "touch $marker" -U "rm -f $marker"', text)
        self.assertIn('harness-os-locked', (OS / 'tests/session_vm.py').read_text())
        subprocess.run(['sh', '-n', LOCK], check=True)
        packages = (OS / 'packages.x86_64').read_text().split()
        self.assertIn('gtklock', packages)
        self.assertNotIn('swaylock', packages)

    def test_lock_screen_reads_as_the_disk_unlock_screen(self):
        theme = (ROOT / 'usr/share/plymouth/themes/harness/harness.script').read_text()
        art = re.search(r'logo_text = "(.*)";', theme)[1].encode().decode('unicode_escape')
        objects = {o.get('id'): o for o in ET.parse(ROOT / 'usr/share/harness-os/lock/layout.ui').iter('object')}
        prop = lambda oid, name: next(p.text for p in objects[oid].findall('property') if p.get('name') == name)
        self.assertEqual(prop('wordmark', 'label'), art)
        self.assertEqual(prop('input-label', 'label'), 'Enter your password')
        # One * per key, as the Plymouth entry draws them; never a reveal-the-password button.
        self.assertEqual(prop('input-field', 'invisible-char'), '*')
        self.assertEqual(prop('input-field', 'visibility'), '0')
        self.assertFalse([p for p in objects['input-field'].findall('property') if 'icon' in p.get('name')])
        # Every widget gtklock looks up (src/window.c) must exist, or it cannot lock at all.
        for oid in ['window-box', 'body-revealer', 'body-grid', 'input-label', 'input-field', 'message-revealer',
                    'message-scrolled-window', 'message-box', 'unlock-button', 'error-label', 'warning-label',
                    'info-box', 'time-box', 'clock-label', 'date-label']:
            self.assertIn(oid, objects)
        style = (ROOT / 'usr/share/harness-os/lock/style.css').read_text()
        self.assertRegex(style, r'window \{\s*background-color: #000000;')


class StatusBar(unittest.TestCase):
    def test_only_the_tab_in_front_is_bold(self):
        conf = (ROOT / 'usr/share/harness-os/tmux.conf').read_text().splitlines()
        self.assertIn('set -g window-status-activity-style default', conf)
        self.assertIn('set -g window-status-bell-style default', conf)
        self.assertIn('set -g window-status-current-style bold', conf)


class FileManager(unittest.TestCase):
    def test_super_e_runs_or_raises_its_own_window_like_the_browser(self):
        keyboard = ET.parse(RC).getroot().find('keyboard')
        bind = next(b for b in keyboard.findall('keybind') if b.get('key') == 'W-e')
        condition = bind.find('action')
        self.assertEqual(condition.get('name'), 'If')
        self.assertEqual(condition.find('query').get('identifier'), 'harness-files')
        # Focused: back to hn. Otherwise: raise the window, or start it when there is none.
        self.assertEqual(condition.find('then').find('action/query').get('identifier'), 'hn')
        self.assertEqual([a.get('command') for a in condition.find('else').iter('action') if a.get('command')],
                         ['/usr/lib/harness-os/files'])
        rules = ET.parse(RC).getroot().find('windowRules')
        self.assertTrue([r for r in rules if r.get('identifier') == 'harness-files' and r.get('serverDecoration') == 'no'])

    def test_super_o_asks_for_a_folder_or_file_in_a_new_window(self):
        self.assertEqual(bindings()['W-o'], ['/usr/lib/harness-os/files --open'])
        script = (ROOT / 'usr/lib/harness-os/files').read_text()
        # A small dialog of its own (centred, no server frame) that launches the explorer or editor
        # windows back through this script.
        self.assertIn('--app-id=harness-open', script)
        self.assertIn('-o initial-window-mode=windowed --window-size-chars=130x34', script)
        self.assertIn('HARNESS_FILES_LAUNCH=/usr/lib/harness-os/files', script)
        self.assertIn('"$HARNESS_TUI_BIN" files "$1" "${2:?}"', script)
        rules = ET.parse(RC).getroot().find('windowRules')
        self.assertTrue([r for r in rules if r.get('identifier') == 'harness-open' and r.get('serverDecoration') == 'no'])

    def test_window_runs_hn_files_in_the_screen_look(self):
        script = (ROOT / 'usr/lib/harness-os/files').read_text()
        self.assertIn('--app-id=harness-files', script)
        self.assertIn('config=/usr/share/harness-os/foot.ini', script)
        self.assertIn('--app-id=harness-files --title=Files --config="$config"', script)
        self.assertIn('"$HARNESS_TUI_BIN" files "${1:-$HOME}"', script)
        subprocess.run(['sh', '-n', ROOT / 'usr/lib/harness-os/files'], check=True)


class Screenshots(unittest.TestCase):
    def test_print_and_super_keys_capture_without_raising_hn(self):
        keys = bindings()
        for key, mode in [('Print', 'full'), ('S-Print', 'region'), ('W-p', 'full'), ('W-r', 'region')]:
            self.assertEqual(keys[key], [f'/usr/lib/harness-os/screenshot {mode}'], key)
        keyboard = ET.parse(RC).getroot().find('keyboard')
        for bind in keyboard.findall('keybind'):
            if bind.get('key') in {'Print', 'S-Print', 'W-p', 'W-r'}:
                self.assertFalse([q for q in bind.iter('query') if q.get('identifier') == 'hn'])

    def test_capture_tools_are_installed(self):
        packages = (OS / 'packages.x86_64').read_text().split()
        self.assertIn('grim', packages)
        self.assertIn('slurp', packages)
        self.assertRegex((OS / 'packaging/fedora/harness-os-session.spec').read_text(), r'Requires:.*\bgrim, slurp\b')

    def run_script(self, *args, slurp='0,0 10x10', slurp_status=0, grim_status=0):
        with tempfile.TemporaryDirectory() as tmp:
            home, bin_dir = Path(tmp) / 'home', Path(tmp) / 'bin'
            home.mkdir()
            bin_dir.mkdir()
            log = Path(tmp) / 'calls'
            stubs = {
                'grim': f'echo "grim $*" >>{log}; for a; do last=$a; done; [ {grim_status} = 0 ] && printf PNG >"$last"; exit {grim_status}',
                'slurp': f'echo slurp >>{log}; echo "{slurp}"; exit {slurp_status}',
                'wl-copy': f'echo "wl-copy $*" >>{log}; cat >/dev/null',
                'hn': f'echo "hn $*" >>{log}',
            }
            for name, body in stubs.items():
                path = bin_dir / name
                path.write_text('#!/bin/sh\n' + body + '\n')
                path.chmod(path.stat().st_mode | stat.S_IEXEC)
            env = {'PATH': f'{bin_dir}:/usr/bin:/bin', 'HOME': str(home)}
            result = subprocess.run(['sh', SCREENSHOT, *args], env=env, capture_output=True, text=True)
            calls = log.read_text() if log.exists() else ''
            shots = sorted((home / 'Pictures/Screenshots').glob('*.png')) if (home / 'Pictures').exists() else []
            return result.returncode, calls, [p.name for p in shots]

    def test_full_screen_is_saved_copied_and_announced(self):
        code, calls, shots = self.run_script('full')
        self.assertEqual(code, 0)
        self.assertEqual(len(shots), 1)
        self.assertRegex(shots[0], r'^Screenshot-\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d\.png$')
        self.assertIn('wl-copy --type image/png', calls)
        self.assertRegex(calls, r'hn display-message Screenshot saved to ~/Pictures/Screenshots/\S+ and copied')
        self.assertNotIn('slurp', calls)

    def test_region_passes_the_selection_to_grim(self):
        code, calls, shots = self.run_script('region', slurp='5,6 70x80')
        self.assertEqual(code, 0)
        self.assertIn('grim -g 5,6 70x80 ', calls)
        self.assertEqual(len(shots), 1)

    def test_cancelled_selection_saves_and_says_nothing(self):
        code, calls, shots = self.run_script('region', slurp='', slurp_status=1)
        self.assertEqual(code, 0)
        self.assertEqual(shots, [])
        self.assertNotIn('grim', calls)
        self.assertNotIn('display-message', calls)

    def test_failed_capture_is_reported(self):
        code, calls, _ = self.run_script('full', grim_status=1)
        self.assertEqual(code, 1)
        self.assertIn('hn display-message Screenshot failed', calls)
        self.assertNotIn('wl-copy', calls)


if __name__ == '__main__':
    unittest.main()
