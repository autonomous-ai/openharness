#!/usr/bin/env python3
"""Open network setup directly, then give the workspace to the real agent."""
import os
from pathlib import Path
import subprocess


def welcome():
    live = Path('/etc/harness-live').is_file()
    if live:
        os.execv('/usr/lib/harness-os/open-install', ['open-install'])
        return
    while True:
        # The installed first-use page advances as soon as connected.
        result = subprocess.run(['sudo', '/usr/bin/python3', '/usr/lib/harness-os/network.py', '--first-use'])
        if result.returncode == 0:
            break
        if result.returncode == 11:
            break
        raise SystemExit('Could not open Wi-Fi. Press Super+w to try again, or Super+t for a terminal.')
    pane = os.environ.get('TMUX_PANE', '')
    try:
        result = subprocess.run(['hn', 'os-action', 'ready', pane], check=False, timeout=15)
        if result.returncode == 0:
            state = Path.home() / '.local/state/harness-os'
            state.mkdir(parents=True, exist_ok=True)
            (state / 'onboarded').touch()
    except (OSError, subprocess.TimeoutExpired):
        pass
    os.execv('/usr/bin/hn-os', ['hn-os', 'try'])


if __name__ == '__main__':
    welcome()
