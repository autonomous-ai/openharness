#!/usr/bin/env python3
"""The real Claude Code for integration_test/claude_scroll_test.dart.

The phone's benchmark app listens; this script connects OUT to it (over the USB
tunnel or the LAN), starts `claude --resume SESSION` in CWD in a pseudo
terminal at the grid the phone sends first ("<cols> <rows> <delay ms>\\n"), and
carries the bytes both ways — each held DELAY ms on the way, to stand in for
the relay. The connection closing ends Claude Code.

Nothing on this Mac listens, and only scrolling reaches Claude Code: of what the
phone sends, wheel reports (SGR mouse, buttons 64/65) and Page Up/Down pass;
every other byte — a character, Enter, any other key — is dropped. No prompt
can be typed into it from the phone.

    python3 claude_bridge.py --phone HOST:PORT --cwd DIR --session ID

Run Claude Code once in DIR by hand first, so its folder-trust question is
answered; resume a copy of a session rather than one an agent is still writing.
"""

import argparse
import asyncio
import fcntl
import os
import pty
import re
import signal
import struct
import termios
import time

# What may reach Claude Code: a wheel report or Page Up/Down, nothing else.
SCROLL = re.compile(rb"\x1b\[<6[45];\d+;\d+[Mm]|\x1b\[[56]~")


class ScrollOnly:
    """Keeps the scroll sequences of what the phone sends, across chunks."""

    def __init__(self):
        self.pending = b""
        self.dropped = 0

    def feed(self, data):
        self.pending += data
        kept = []
        while self.pending:
            match = SCROLL.match(self.pending)
            if match:
                kept.append(match.group(0))
                self.pending = self.pending[match.end():]
                continue
            # The start of a sequence still arriving waits for the rest.
            if self.pending.startswith(b"\x1b") and len(self.pending) < 16 \
                    and b"M" not in self.pending and b"m" not in self.pending \
                    and b"~" not in self.pending:
                break
            self.pending = self.pending[1:]
            self.dropped += 1
        return b"".join(kept)


class DelayLine:
    """Hands each chunk on `delay` seconds after it came, in order."""

    def __init__(self, delay, sink):
        self.delay = delay
        self.sink = sink
        self.queue = asyncio.Queue()
        self.task = asyncio.ensure_future(self._run())

    def put(self, data):
        self.queue.put_nowait((time.monotonic() + self.delay, data))

    async def _run(self):
        while True:
            due, data = await self.queue.get()
            wait = due - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            self.sink(data)

    def close(self):
        self.task.cancel()


async def connect(host, port, seconds):
    for _ in range(seconds):
        try:
            return await asyncio.open_connection(host, port)
        except OSError:
            await asyncio.sleep(1)
    raise SystemExit(f"[bridge] the phone at {host}:{port} never answered")


async def run(args):
    host, port = args.phone.rsplit(":", 1)
    host = host.strip("[]")
    reader, writer = await connect(host, int(port), args.wait)
    header = (await reader.readline()).decode().split()
    cols, rows = int(header[0]), int(header[1])
    delay = (int(header[2]) if len(header) > 2 else 0) / 1000
    print(f"[bridge] phone grid {cols}x{rows}, {delay * 1000:.0f} ms each way",
          flush=True)
    pid, fd = pty.fork()
    if pid == 0:
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        os.chdir(args.cwd)
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLORTERM"] = "truecolor"
        os.execvp("claude", ["claude", "--resume", args.session])
    loop = asyncio.get_running_loop()
    to_phone = DelayLine(delay, writer.write)
    to_claude = DelayLine(delay, lambda data: os.write(fd, data))
    scroll_only = ScrollOnly()
    done = asyncio.Event()

    def readable():
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b""
        if not data:
            loop.remove_reader(fd)
            done.set()
            return
        to_phone.put(data)

    loop.add_reader(fd, readable)

    async def from_phone():
        while True:
            data = await reader.read(4096)
            if not data:
                break
            kept = scroll_only.feed(data)
            if kept:
                to_claude.put(kept)
        done.set()

    pump = asyncio.ensure_future(from_phone())
    await done.wait()
    pump.cancel()
    to_phone.close()
    to_claude.close()
    try:
        loop.remove_reader(fd)
    except Exception:
        pass
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.kill(pid, sig)
            await asyncio.sleep(0.3)
        except ProcessLookupError:
            break
    writer.close()
    print(f"[bridge] closed; {scroll_only.dropped} non-scroll bytes dropped",
          flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--phone", required=True, help="HOST:PORT the phone listens on")
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--session", required=True)
    parser.add_argument("--wait", type=int, default=180,
                        help="seconds to keep trying to reach the phone")
    asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    main()
