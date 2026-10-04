#!/usr/bin/env python3
"""Migrate earlier OS defaults through hn's API after its saved session attaches."""
from pathlib import Path
import subprocess
import time


def hn(*args):
    return subprocess.run(['/usr/bin/hn', *args], check=True, text=True,
                          capture_output=True, timeout=3).stdout.strip()


def migrate():
    # hn deliberately restores server options across screen restarts and boots.
    # Remove only our old footer, retaining any footer the user chose themselves.
    if hn('show-options', '-gv', 'status-right') == '#{@harness-update}':
        if hn('show-options', '-gv', 'status-right-length') == '60':
            hn('set-option', '-gu', 'status-right-length')
        hn('set-option', '-gu', 'status-right')
    # The current config already sets this on a new server. An older saved
    # server can lack it; -o preserves an explicit user choice and -q is quiet.
    hn('set-option', '-goq', '@hn-new-window', 'shell')


def main():
    if Path('/etc/harness-live').exists():
        return
    deadline = time.monotonic() + 15
    while True:
        try:
            migrate()
            return
        except (OSError, subprocess.SubprocessError):
            if time.monotonic() >= deadline:
                raise
            time.sleep(.2)


if __name__ == '__main__':
    main()
