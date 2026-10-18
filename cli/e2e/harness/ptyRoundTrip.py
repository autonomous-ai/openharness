"""Raw pty round trip: the floor for a typing measurement.

Runs argv[2:] on a fresh pty, writes one key at a time to its master and times the first byte back.
Prints the round trips in ms as a JSON list. No tmux, no daemon, no socket.
"""
import json, os, pty, select, sys, time

count = int(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])

def drain(seconds):
    end = time.monotonic() + seconds
    while True:
        ready, _, _ = select.select([fd], [], [], max(0, end - time.monotonic()))
        if not ready:
            return
        os.read(fd, 65536)

drain(1.5)
out = []
for i in range(count):
    started = time.perf_counter()
    os.write(fd, b'x' if i % 2 == 0 else b'\x7f')
    ready, _, _ = select.select([fd], [], [], 5)
    out.append(round((time.perf_counter() - started) * 1000, 3))
    if ready:
        os.read(fd, 65536)
    drain(0.015 + (i % 3) * 0.005)
os.write(fd, b'\x03')
print(json.dumps(out))
