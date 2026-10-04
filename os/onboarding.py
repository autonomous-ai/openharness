#!/usr/bin/env python3
"""The USB's short network step; the real agent owns the workspace afterwards."""
import curses
import os
from pathlib import Path
import subprocess
import time

WORDMARK = ('█ █ ▄▀█ █▀█ █▄ █ █▀▀ █▀ █▀', '█▀█ █▀█ █▀▄ █ ▀█ ██▄ ▄█ ▄█')


def connected():
    try:
        result = subprocess.run(['nmcli', '-t', '-f', 'STATE', 'general'],
                                capture_output=True, text=True, timeout=3,
                                env=dict(os.environ, LC_ALL='C'))
        return result.returncode == 0 and result.stdout.strip() == 'connected'
    except (OSError, subprocess.TimeoutExpired):
        return False


def network_step(screen, error=None):
    screen.keypad(True)
    screen.timeout(1000)
    try:
        curses.curs_set(0)
    except curses.error:
        pass
    selected, checked = 0, 0.0
    while True:
        if time.monotonic() - checked >= 3:
            if connected():
                return 'ready'
            checked = time.monotonic()
        screen.erase()
        height, width = screen.getmaxyx()
        lines = [*WORDMARK, '', 'Connect to start with an agent.', '',
                 '[ Connect to Wi-Fi ]', '', '[ Install without connecting ]']
        if error:
            lines += ['', error]
        top = max(0, (height - len(lines)) // 2)
        for index, text in enumerate(lines):
            row = top + index
            if row >= height - 1 or width < 2:
                continue
            attr = curses.A_REVERSE if index == (5 if selected == 0 else 7) else curses.A_BOLD if index < 2 else curses.A_NORMAL
            screen.addnstr(row, max(0, (width - len(text)) // 2), text, max(0, width - 1), attr)
        screen.refresh()
        try:
            key = screen.get_wch()
        except curses.error:
            continue
        if key in ('\t', curses.KEY_BTAB, curses.KEY_UP, curses.KEY_DOWN):
            selected = 1 - selected
        elif key in ('\n', '\r', curses.KEY_ENTER):
            return 'wifi' if selected == 0 else 'install'
        elif key in ('i', 'I'):
            return 'install'
        elif key in ('w', 'W'):
            return 'wifi'


def welcome():
    # No model call, download or account is required to reach the install action.
    if not Path('/etc/harness-live').is_file():
        raise SystemExit('The USB welcome is only available when running from the Harness USB.')
    curses.set_escdelay(25)
    error = None
    while not connected():
        action = curses.wrapper(network_step, error) if error else curses.wrapper(network_step)
        error = None
        if action == 'wifi':
            subprocess.run(['/usr/bin/hn-os', 'wifi'], check=False)
        elif action == 'install':
            try:
                subprocess.run(['hn', 'os-action', 'install'], check=True, timeout=15)
            except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
                error = 'Could not open Install. Try again, or press Super+i.'
            # The installer owns another tab. Keep this network step available
            # when the user cancels installation and returns to the trial.
            continue
    pane = os.environ.get('TMUX_PANE', '')
    # The introduction is optional; an IPC hiccup must not prevent the agent
    # from opening. The USB dock and OS shortcuts remain available regardless.
    try:
        subprocess.run(['hn', 'os-action', 'ready', pane], check=False, timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        pass
    os.execv('/usr/bin/hn-os', ['hn-os', 'try'])


if __name__ == '__main__':
    welcome()
