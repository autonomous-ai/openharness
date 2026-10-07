"""Native VM regression: graphical services follow the screen, agents do not."""
import json


def processes(machine):
    text, _ = machine.user("""python3 - <<'PY'
import json, subprocess
from pathlib import Path
agent = subprocess.check_output(['pgrep', '-u', '1000', '-x', 'opencode'], text=True).split()
daemon = subprocess.check_output(['systemctl', '--user', 'show', 'harness-daemon.service',
                                  '--property=MainPID', '--value'], text=True).strip()
assert agent and int(daemon) > 0
print(json.dumps({pid: (Path('/proc') / pid / 'stat').read_text().rsplit(')', 1)[1].split()[19]
                  for pid in [*agent, daemon]}, sort_keys=True))
PY""", timeout=15)
    return json.loads(next(line for line in text.splitlines() if line.startswith('{')))


def portal(machine):
    machine.user('systemctl --user is-active --quiet harness-os.target graphical-session.target', timeout=15)
    text, _ = machine.user('busctl --user --no-pager --timeout=10 get-property '
                          'org.freedesktop.portal.Desktop /org/freedesktop/portal/desktop '
                          'org.freedesktop.portal.ScreenCast version', timeout=15)
    assert any(line.startswith('u ') and int(line.split()[1]) > 0 for line in text.splitlines()), text
    return text


def exercise(machine):
    before = processes(machine)
    portal(machine)
    machine.user('systemctl --user stop harness-os.target', timeout=30)
    units = ['harness-os.target', 'graphical-session.target', 'xdg-desktop-portal.service',
             'xdg-desktop-portal-wlr.service']
    machine.wait_user(' && '.join('test "$(systemctl --user is-active ' + unit + ')" = inactive'
                                 for unit in units), 20)
    screen, _ = machine.user('systemctl --user --no-pager show hn-screen.service '
                             '-p ActiveState -p MainPID -p Result', timeout=15)
    assert 'MainPID=0' in screen, 'The old screen is still running'
    assert processes(machine) == before, 'Stopping graphical services interrupted agent work'
    machine.user('systemctl --user start harness-os.target', timeout=45)
    portal(machine)
    assert processes(machine) == before, 'Reconnecting the screen replaced agent work'
    return {'status': 'passed', 'process_start_ticks': before, 'screen_stop': screen,
            'checks': ['Actual portal DBus activation', 'Screen and portals stop together',
                       'Screen and portal reconnect with the same agent and daemon processes']}
