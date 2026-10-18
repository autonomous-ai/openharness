#!/usr/bin/env python3
"""Connect before launching hn; start the first workspace after hn's sign-in."""
import os
from pathlib import Path
import subprocess
import sys
import time

# Written by setup.py when a phone signed this computer in (os/setup.py FROM_PHONE).
FROM_PHONE = Path('/var/lib/harness-os/set-up-from-phone')
# How long the welcome keeps asking hn to lay out the first workspace.
READY_FOR = 10


def prepare():
    if Path('/etc/harness-live').is_file() or (Path.home() / '.local/state/harness-os/onboarded').is_file():
        return
    # The OS owns initial connectivity. hn is launched only after this form
    # succeeds; Ethernet advances immediately and Wi-Fi waits for a connection.
    result = subprocess.run(['sudo', '/usr/bin/python3', '/usr/lib/harness-os/network.py', '--first-use'])
    if result.returncode != 0:
        raise SystemExit('Could not open Wi-Fi. Restart Harness to try again.')


def welcome():
    live = Path('/etc/harness-live').is_file()
    if live:
        os.execv('/usr/lib/harness-os/open-install', ['open-install'])
        return
    # Initial networking finished before hn launched. This pane is created only
    # after hn's shared account gate has opened.
    pane = os.environ.get('TMUX_PANE', '')
    # Set up from a phone (setup.py): OpenCode alone, without the two starter terminals; nobody
    # was at this screen to start with three panes.
    bare = ['bare'] if FROM_PHONE.is_file() else []
    # Asked again for a while: this pane can start before hn knows it by its tmux id ("That pane is
    # not the welcome on this computer"), and one early refusal lost the two starter terminals.
    deadline = time.monotonic() + READY_FOR
    while True:
        try:
            result = subprocess.run(['hn', 'os-action', 'ready', pane, *bare], check=False, timeout=15)
        except (OSError, subprocess.TimeoutExpired):
            break
        if result.returncode == 0:
            state = Path.home() / '.local/state/harness-os'
            state.mkdir(parents=True, exist_ok=True)
            (state / 'onboarded').touch()
            break
        if time.monotonic() >= deadline:
            break
        time.sleep(.5)
    os.execv('/usr/bin/hn-os', ['hn-os', 'try'])


if __name__ == '__main__':
    if sys.argv[1:] == ['--prepare']:
        prepare()
    else:
        welcome()
