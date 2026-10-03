"""Drive an owned PTY; never enumerate or open a real device."""
import hashlib
import json
import os
import pty
import select
import subprocess
import sys
import time

node, worker, mode = sys.argv[1:]
master, slave = pty.openpty()
child = subprocess.Popen(
    [node, worker, os.ttyname(slave), mode],
    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    env={**os.environ, 'UV_THREADPOOL_SIZE': '1'}, start_new_session=True,
)

def phase(expected):
    line = child.stdout.readline()
    assert line, (child.poll(), child.stderr.read())
    value = json.loads(line)
    assert value['phase'] == expected, value
    return value

try:
    phase('ready')
    os.set_blocking(master, False)
    payload = bytes(range(256)) * 256
    offset = 0
    deadline = time.monotonic() + 5
    while offset < len(payload):
        assert time.monotonic() < deadline, 'input stalled'
        if select.select([], [master], [], 0.1)[1]:
            try:
                offset += os.write(master, payload[offset:])
            except BlockingIOError:
                pass
    phase('received')
    phase('blocked')
    if mode == 'duplex':
        expected = bytes(range(256)) * 4096 + bytes(reversed(range(256))) * 4096
        actual = bytearray()
        deadline = time.monotonic() + 5
        while len(actual) < len(expected):
            assert time.monotonic() < deadline, 'backpressured output stalled'
            if select.select([master], [], [], 0.1)[0]:
                actual.extend(os.read(master, 65536))
        assert actual == expected, 'binary bytes changed or frames interleaved'
        assert phase('sent')['sha256'] == hashlib.sha256(expected).hexdigest()
    if mode != 'close':
        os.close(master)
        master = None
    phase('passed')
    out, err = child.communicate(timeout=3)
    assert child.returncode == 0, (child.returncode, out, err)
    print(json.dumps({'mode': mode, 'passed': True, 'sessionLeader': True}))
finally:
    if child.poll() is None:
        child.terminate()
        child.wait(timeout=3)
    if master is not None:
        os.close(master)
    os.close(slave)
