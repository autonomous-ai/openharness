#!/usr/bin/python3
"""Change disposable Chromium choices through Chromium, never preference edits.

Only used in the HN_OS_TEST guest. A private CDP pipe drives Chromium's actual
extension-management API; ordinary visible hn-browser launches verify the result.
No observer or debugging switch is installed in the production OS.
"""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import time


class Browser:
    def __init__(self, child):
        self.child, self.buffer, self.sequence = child, b'', 0

    def call(self, method, params=None, session=None):
        self.sequence += 1
        request = {'id': self.sequence, 'method': method, 'params': params or {}}
        if session:
            request['sessionId'] = session
        self.child.stdin.write(json.dumps(request).encode() + b'\0')
        self.child.stdin.flush()
        deadline = time.monotonic() + 15
        while True:
            if b'\0' not in self.buffer:
                remaining = deadline - time.monotonic()
                assert remaining > 0 and select.select([self.child.stdout], [], [], remaining)[0], method
                chunk = os.read(self.child.stdout.fileno(), 65536)
                assert chunk, 'Browser closed during ' + method
                self.buffer += chunk
                continue
            raw, self.buffer = self.buffer.split(b'\0', 1)
            response = json.loads(raw)
            if response.get('id') == self.sequence:
                assert 'error' not in response, response
                return response.get('result', {})

    def evaluate(self, expression, session):
        result = self.call('Runtime.evaluate', {'expression': expression,
            'awaitPromise': True, 'returnByValue': True, 'userGesture': True}, session)
        assert 'exceptionDetails' not in result, result
        return result.get('result', {}).get('value')


@contextmanager
def browser(root, log):
    with log.open('wb') as error:
        child = subprocess.Popen(['/bin/sh', '-c',
            'exec /usr/bin/chromium --headless --no-first-run --no-default-browser-check '
            '--remote-debugging-pipe '
            '--allow-chrome-scheme-url --user-data-dir="$1" about:blank 3<&0 4>&1',
            'harness-test-browser-choices', str(root)], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=error, start_new_session=True)
        instance = Browser(child)
        try:
            yield instance
        finally:
            try:
                child.stdin.write(b'{"id":99999,"method":"Browser.close"}\0')
                child.stdin.flush()
                child.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=5)
            child.stdin.close()
            child.stdout.close()


def management(chrome, expression, session):
    return chrome.evaluate('new Promise((resolve, reject) => { ' + expression +
        '(value) => chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(value)); })', session)


def custom_page(root):
    """Install a signed test extension through Chromium's supported Linux path.

    CDP loadUnpacked is intentionally transient across browser restarts. A real
    external installation lets the test observe an existing persistent choice.
    The generated key and extension stay only inside this disposable VM.
    """
    fixture = Path('/tmp/harness-custom-newtab')
    fixture.mkdir(mode=0o700)
    (fixture / 'manifest.json').write_text(json.dumps({'manifest_version': 3,
        'name': 'Custom tab fixture', 'version': '1.0',
        'chrome_url_overrides': {'newtab': 'index.html'}}))
    (fixture / 'index.html').write_text('<!doctype html><title>New Tab</title><h1>CUSTOM TAB</h1>')
    subprocess.run(['/usr/bin/chromium', '--headless', '--no-message-box',
        '--user-data-dir=/tmp/harness-custom-pack-profile', '--pack-extension=' + str(fixture)],
        stdin=subprocess.DEVNULL, capture_output=True, check=True, timeout=30)
    key = fixture.with_suffix('.pem')
    key.chmod(0o600)
    public = subprocess.check_output(['/usr/bin/openssl', 'pkey', '-in', str(key),
        '-pubout', '-outform', 'DER'], timeout=10)
    identity = hashlib.sha256(public).hexdigest()[:32].translate(
        str.maketrans('0123456789abcdef', 'abcdefghijklmnop'))
    descriptor = root / 'External Extensions' / (identity + '.json')
    descriptor.parent.mkdir(parents=True)
    descriptor.write_text(json.dumps({'external_crx': str(fixture.with_suffix('.crx')),
                                     'external_version': '1.0'}))
    return identity


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['disabled', 'enabled', 'inspect', 'custom'])
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    assert subprocess.check_output(['lsblk', '-dn', '-o', 'SERIAL', '/dev/vda'], text=True).strip() == 'HN_OS_TEST'
    assert not Path('/etc/harness-live').exists()
    assert subprocess.run(['pgrep', '-u', str(os.getuid()), '-x', 'chromium'], capture_output=True).returncode == 1
    root = Path.home() / '.config/chromium'
    identity = json.loads(Path('/usr/share/harness-os/browser-home/extension.json').read_text())['extension_id']
    result = {'action': args.action, 'identity': identity, 'mechanism': 'Chromium management API, private test-only CDP pipe'}
    if args.action == 'custom':
        result['custom_id'] = custom_page(root)
    with browser(root, args.output.with_suffix('.log')) as chrome:
        target = chrome.call('Target.createTarget', {'url': 'chrome://extensions/'})['targetId']
        session = chrome.call('Target.attachToTarget', {'targetId': target, 'flatten': True})['sessionId']
        deadline = time.monotonic() + 15
        while not chrome.evaluate('typeof chrome !== "undefined" && !!chrome.management', session):
            assert time.monotonic() < deadline, 'Extensions management page did not load'
            time.sleep(.1)
        if args.action == 'custom':
            deadline = time.monotonic() + 15
            while not any(item['id'] == result['custom_id'] and item['enabled']
                          for item in management(chrome, 'chrome.management.getAll(', session)):
                assert time.monotonic() < deadline, 'Custom extension did not install'
                time.sleep(.1)
        elif args.action in ('disabled', 'enabled'):
            management(chrome, 'chrome.management.setEnabled(' + json.dumps(identity) + ', ' +
                       ('true' if args.action == 'enabled' else 'false') + ', ', session)
        result['extensions'] = management(chrome, 'chrome.management.getAll(', session)
        installed = {item['id']: item for item in result['extensions']}
        if args.action == 'custom':
            assert installed[result['custom_id']]['enabled']
        elif args.action in ('disabled', 'enabled'):
            assert installed[identity]['enabled'] == (args.action == 'enabled')
    args.output.write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
