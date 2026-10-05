"""Competing real processes on an owned PTY, including abrupt owner death."""
import os
import pty
import subprocess
import sys

node, worker = sys.argv[1:]
master, slave = pty.openpty()
children = []

def start():
    child = subprocess.Popen([node, worker, os.ttyname(slave)], stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                             start_new_session=True)
    children.append(child)
    return child

def line(child, expected):
    actual = child.stdout.readline().strip()
    assert actual == expected, (actual, child.poll())

try:
    owner = start()
    line(owner, 'claimed')
    contender = start()
    line(contender, 'busy')
    assert contender.wait(timeout=3) == 0
    owner.stdin.write('close\n')
    owner.stdin.flush()
    line(owner, 'released')
    assert owner.wait(timeout=3) == 0
    replacement = start()
    line(replacement, 'claimed')
    replacement.kill()
    replacement.wait(timeout=3)
    recovered = start()
    line(recovered, 'claimed')
    recovered.stdin.write('close\n')
    recovered.stdin.flush()
    line(recovered, 'released')
    assert recovered.wait(timeout=3) == 0
    print('exclusive claim, orderly handoff and crash recovery passed')
finally:
    for child in children:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=3)
    os.close(slave)
    os.close(master)
