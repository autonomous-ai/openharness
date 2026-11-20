#!/usr/bin/env python3
"""A scripted Hyprland for linux.sh: its two sockets in FOLDER ($XDG_RUNTIME_DIR/hypr/<signature>/).

    hypr-fake.py FOLDER

Prints `ready` once both sockets listen. Each line on stdin is a pid: that process's window becomes the active one,
and every client of the event socket (.socket2.sock) is sent a v1 `activewindow>>` line, whose title the app must never
use, then `activewindowv2>>ADDRESS`. The request socket (.socket.sock) answers `j/activewindow` with the active
window's pid, or `{}` before the first line, one request per connection as Hyprland does. Ends when stdin closes.
"""

import json
import os
import socket
import sys
import threading

lock = threading.Lock()
active = None
listeners = []


def listen(path):
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(path)
    server.listen()
    return server


def serve_events(server):
    while True:
        client, _ = server.accept()
        with lock:
            listeners.append(client)


def serve_requests(server):
    while True:
        client, _ = server.accept()
        with client:
            client.settimeout(5)
            request = b""
            try:
                while not request.startswith(b"j/activewindow"):
                    chunk = client.recv(64)
                    if not chunk:
                        break
                    request += chunk
            except OSError:
                continue
            if request != b"j/activewindow":
                continue
            with lock:
                pid = active
            answer = {} if pid is None else {"address": hex(pid), "pid": pid, "class": "e2e", "title": "a title"}
            client.sendall(json.dumps(answer).encode())


def tell(pid):
    global active
    with lock:
        active = pid
        lines = f"activewindow>>e2e,a title\nactivewindowv2>>{hex(pid)[2:]}\n".encode()
        for client in list(listeners):
            try:
                client.sendall(lines)
            except OSError:
                listeners.remove(client)


def main():
    folder = sys.argv[1]
    os.makedirs(folder, mode=0o700, exist_ok=True)
    events = listen(os.path.join(folder, ".socket2.sock"))
    requests = listen(os.path.join(folder, ".socket.sock"))
    for target, server in ((serve_events, events), (serve_requests, requests)):
        threading.Thread(target=target, args=(server,), daemon=True).start()
    print("ready", flush=True)
    for line in iter(sys.stdin.readline, ""):
        tell(int(line))


if __name__ == "__main__":
    main()
