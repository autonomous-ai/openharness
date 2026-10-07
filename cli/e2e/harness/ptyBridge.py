"""A dial's end of a pseudo-terminal, for a daemon under test to open as if a dial were plugged in.

Prints the terminal's path on stderr, then carries bytes both ways: what the daemon writes to the
terminal comes out on stdout, and what arrives on stdin goes to the daemon. Never enumerates or opens a
real device: the only terminal touched is the one this process creates.

The terminal's own end is closed here at once. A daemon looks for a port nobody else holds (`lsof`),
and this process holding it would make the dial look like somebody's work in progress.
"""
import os
import pty
import select
import sys
import time
import tty

master, slave = pty.openpty()
# Raw, so the line discipline neither echoes nor rewrites the binary frames before the daemon opens it.
tty.setraw(slave)
path = os.ttyname(slave)
os.close(slave)
sys.stderr.write(path + '\n')
sys.stderr.flush()

stdin = sys.stdin.fileno()
stdout = sys.stdout.fileno()
os.set_blocking(stdin, False)
os.set_blocking(master, False)
pending = b''
while True:
    # Woken as soon as the terminal can take more, so a test's burst reaches the daemon at the speed a
    # terminal carries it, not one buffer every 50 ms.
    readable, writable, _ = select.select([master, stdin], [master] if pending else [], [], 0.05)
    if stdin in readable:
        try:
            chunk = os.read(stdin, 65536)
        except BlockingIOError:
            chunk = None
        if chunk == b'':
            break  # the test let go of the dial
        if chunk:
            pending += chunk
    if master in readable:
        try:
            data = os.read(master, 65536)
            if data:
                os.write(stdout, data)
        except (BlockingIOError, OSError):
            # Nobody has the terminal open yet, or the daemon closed it for a moment: wait for it.
            time.sleep(0.05)
    if pending:
        try:
            written = os.write(master, pending)
            pending = pending[written:]
        except (BlockingIOError, OSError):
            time.sleep(0.05)
