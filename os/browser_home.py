#!/usr/bin/python3
"""One-shot native message bridge for the bundled browser start page.

No HTTP endpoint, background service, arbitrary commands or credential API.
Chromium starts this only for the bundled extension's native message.
"""
import json
from pathlib import Path
import struct
import subprocess
import sys

MAX_MESSAGE = 1024
HOST_MANIFEST = Path('/etc/chromium/native-messaging-hosts/ai.autonomous.harness_home.json')


def open_connections():
    sys.path.insert(0, '/usr/lib/harness-os/connections')
    import connections
    # Keep the capability inside the native path. Browser-initiated navigation
    # is cross-site; the existing OS launcher opens a trusted local tab without
    # weakening the Connections server's fetch/origin restrictions.
    subprocess.run(['/usr/bin/hn-browser', connections.page_url()], check=True,
                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, timeout=30)


def read_message(stream):
    header = stream.read(4)
    if len(header) != 4:
        raise ValueError('Missing message')
    length = struct.unpack('=I', header)[0]
    if not 0 < length <= MAX_MESSAGE:
        raise ValueError('Invalid message length')
    raw = stream.read(length)
    if len(raw) != length:
        raise ValueError('Incomplete message')
    message = json.loads(raw)
    if message not in [{'action': 'connections'}, {'action': 'installed'}]:
        raise ValueError('Unknown action')
    return message


def reply(stream, data):
    raw = json.dumps(data, separators=(',', ':')).encode()
    stream.write(struct.pack('=I', len(raw)) + raw)
    stream.flush()


def main(argv, source, destination, *, manifest=HOST_MANIFEST, launch=None, ready=None):
    try:
        allowed = json.loads(manifest.read_text())['allowed_origins']
        if len(argv) != 1 or argv[0] not in allowed:
            return 1
        message = read_message(source)
        if message == {'action': 'installed'}:
            if ready is None:
                import browser_profile
                ready = browser_profile.installed
            ready()
            reply(destination, {'ok': True})
            return 0
        if launch is None:
            launch = open_connections
        launch()
        reply(destination, {'ok': True})
        return 0
    except Exception:
        # Never relay exception text, account names or local paths to the browser.
        reply(destination, {'error': 'Could not open Connections.'})
        return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:], sys.stdin.buffer, sys.stdout.buffer))
