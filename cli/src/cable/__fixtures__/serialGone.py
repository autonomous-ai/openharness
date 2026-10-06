"""Drive an owned PTY whose far end goes away; never enumerate or open a real device.

`gone`: the slave is held open here (as a daemon still holding its port would), the master closed, and then
the worker opens the slave: it must refuse at once, not wait in open() for a master that is not coming.
`early`: the master writes before the worker opens the slave, and then more: the worker gets both, in order.
"""
import os
import pty
import subprocess
import sys
import time

node, worker, mode = sys.argv[1:]
master, slave = pty.openpty()
path = os.ttyname(slave)
if mode == 'gone':
    os.close(master)
else:
    os.write(master, b'before ')
child = subprocess.Popen([node, worker, path, mode], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
if mode == 'early':
    time.sleep(0.15)
    os.write(master, b'after')
out, err = child.communicate(timeout=10)
sys.stdout.write(out)
sys.stderr.write(err)
