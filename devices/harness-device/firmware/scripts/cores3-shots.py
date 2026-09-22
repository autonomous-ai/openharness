#!/usr/bin/env python3
"""Capture every CoreS3 screen as PNGs, with a pretend daemon session so there is something on them.

    scripts/cores3-shots.py /dev/cu.usbmodem* out_dir [state ...]

Plays the daemon's side of a session over the cable (welcome, a machine, two tabs, three agents — one
working, one with a recap), then for each state asks the firmware to show it (`debug.show`,
ui_screens.c ui_debug_show) and captures the glass (`debug.snap`). Nothing else may hold the port.
States: overview agent agent2 agent3 settings drawer tabs brightness language wifi lock voice sending
cancel reset reader question.
"""
import importlib.util
import json
import os
import struct
import sys
import time

import serial

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("snap", os.path.join(HERE, "cores3-snap.py"))
snap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snap)

ALL = ["overview", "agent", "agent2", "agent3", "reader", "settings", "drawer", "tabs", "brightness",
       "language", "wifi", "lock", "voice", "sending", "cancel", "reset", "question"]

AGENTS = [
    {"id": "a1", "name": "Fix login screen", "engine": "claude", "machineId": "m1", "machine": "Mac mini"},
    {"id": "a2", "name": "Firmware voice", "engine": "codex", "machineId": "m1", "machine": "Mac mini"},
    {"id": "a3", "name": "Build logs", "engine": "terminal", "machineId": "m1", "machine": "Mac mini"},
]


def session(tz_min: int):
    now = int(time.time() * 1000)
    msgs = [{"t": "welcome", "proto": 3, "app": "harness", "machine": {"id": "m1", "name": "Mac mini"},
             "selected": "m1", "voiceLang": "en", "now": now, "tzOffsetMin": tz_min},
            {"t": "machines.begin"},
            {"t": "machine", "id": "m1", "name": "Mac mini", "state": "ready", "local": True},
            {"t": "machines.end", "selected": "m1", "source": "backend"},
            {"t": "swarms", "selected": "t1", "items": [{"id": "t1", "name": "Harness watch", "agents": 3, "panes": 3},
                                                       {"id": "t2", "name": "Firmware", "agents": 1, "panes": 2}]},
            {"t": "agents.begin"}]
    msgs += [{"t": "agent", **a} for a in AGENTS]
    msgs += [{"t": "agents.end", "total": 7, "tab": "t1"},
             {"t": "turn.started", "agentId": "a2", "text": "Working"},
             {"t": "summary", "agentId": "a1", "name": "Fix login screen", "engine": "claude", "machine": "",
              "recap": "Login screen fixed, 42 tests pass",
              "text": "Fixed the login screen: the token store now refreshes before expiry, the race in "
                      "session cleanup is gone, and all 42 tests pass."}]
    return msgs


class Link:
    def __init__(self, port):
        self.s = serial.Serial()
        self.s.port, self.s.baudrate, self.s.timeout = port, 115200, 0.1
        self.s.dtr = self.s.rts = False
        self.s.open()
        seen, t0 = bytearray(), time.time()
        while time.time() - t0 < 8:
            seen += self.s.read(65536)
            if b"cable client started" in seen:
                time.sleep(1.5)
                break
            if time.time() - t0 > 1.2 and b"ESP-ROM" not in seen and b"I (" not in seen:
                break
        self.buf = bytearray()

    def send(self, msg):
        self.s.write(snap.frame(snap.T_JSON, json.dumps(msg).encode()))

    def pump(self, secs):
        """Read for `secs`, answering nothing but keeping the buffer drained."""
        t0 = time.time()
        while time.time() - t0 < secs:
            self.buf += self.s.read(65536)
            list(snap.frames(self.buf))

    def shot(self, path, timeout=10):
        self.s.reset_input_buffer()
        self.buf.clear()
        self.send({"t": "debug.snap"})
        img, got, t0 = bytearray(snap.W * snap.H * 2), 0, time.time()
        while time.time() - t0 < timeout and got < len(img):
            self.buf += self.s.read(65536)
            for ftype, payload in snap.frames(self.buf):
                if ftype == snap.T_SNAP and len(payload) > 4:
                    off = struct.unpack("<I", payload[:4])[0]
                    img[off:off + len(payload) - 4] = payload[4:]
                    got += len(payload) - 4
        if got >= len(img) * 0.9:
            snap.png(path, bytes(img))
            return True
        return False


def main():
    port, out = sys.argv[1], sys.argv[2]
    states = sys.argv[3:] or ALL
    os.makedirs(out, exist_ok=True)
    link = Link(port)
    tz = time.localtime().tm_gmtoff // 60
    for m in session(tz):
        link.send(m)
    link.pump(1.5)
    for st in states:
        link.send({"t": "ping"})
        link.send({"t": "debug.show", "what": "clear"})
        if st == "question":
            link.send({"t": "question", "agentId": "a1", "id": "q1", "name": "Fix login screen", "engine": "claude",
                       "machine": "", "questions": [{"key": "db", "q": "Which database should I use for the session store?",
                                                     "multi": False, "options": ["Postgres", "SQLite", "Keep Redis"]}]})
        elif st.startswith("agent"):
            n = {"agent": 0, "agent2": 1, "agent3": 2}[st]
            link.send({"t": "focus", "agentId": AGENTS[n]["id"]})
            # The daemon repeats turn.started while a turn runs; one sent before the list landed is lost.
            link.send({"t": "turn.started", "agentId": "a2", "text": "Working"})
        elif st == "reader":
            link.send({"t": "focus", "agentId": "a1"})    # the agent with something to read
            link.pump(0.6)
            link.send({"t": "debug.show", "what": "reader"})
        else:
            link.send({"t": "debug.show", "what": st})
        link.pump(0.8)
        path = os.path.join(out, f"{st}.png")
        print(path if link.shot(path) else f"{st}: no image")
        if st == "question":
            link.send({"t": "question.close", "agentId": "a1", "id": "q1"})
    link.send({"t": "debug.show", "what": "clear"})


if __name__ == "__main__":
    main()
