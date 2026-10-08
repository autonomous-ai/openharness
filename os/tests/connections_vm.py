"""Exercise the installed Connections command and browser inside a disposable VM."""
import base64
import shlex

from install_first import wait_installer_screen


def exercise(vm):
    # Fixture credentials stay inside the disposable guest and never reach a provider.
    script = r'''
import json, os, pathlib, subprocess, sys, tempfile, time, urllib.error, urllib.request
assert sys.platform == 'linux' and os.geteuid() != 0
assert subprocess.check_output(['lsblk', '-dn', '-o', 'SERIAL', '/dev/vda'], text=True).strip() == 'HN_OS_TEST'
sys.path.insert(0, '/usr/lib/harness-os/connections')
import connection_store
with tempfile.TemporaryDirectory(prefix='connections-native-') as temporary:
    root = pathlib.Path(temporary) / 'accounts'
    env = dict(os.environ, CONNECTOR_CONFIGS_DIR=str(root))
    def cli(*args):
        return subprocess.check_output(['harness', 'connections', *args], env=env, text=True, timeout=10)
    assert json.loads(cli('list', '--json')) == []
    vault = connection_store.Store(root)
    vault.save('github', {'access_token': 'native-fixture-not-a-real-token', 'source': 'gateway',
                          'account_name': 'fixture@example.invalid'})
    for _ in range(3):
        # Separate command processes use the same credentials, independent of an engine.
        info = json.loads(cli('info', 'github'))
        assert info['account'] == 'fixture@example.invalid', info
        assert 'native-fixture-not-a-real-token' not in json.dumps(info)
    # The bridge's socket is waiting for agents; nothing runs until one calls it.
    subprocess.run(['systemctl', '--user', 'is-active', '--quiet', 'harness-connections.socket'], check=True)
    process = subprocess.Popen(['harness', 'connections', 'serve', '--background'], env=env,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 5
        while not (root / 'page.json').exists() and time.monotonic() < deadline:
            assert process.poll() is None
            time.sleep(.05)
        page = connection_store.read_private(root / 'page.json')
        origin = 'http://127.0.0.1:' + str(page['port'])
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            opener.open(origin + '/api/connections', timeout=3)
            raise AssertionError('Unauthenticated request was accepted')
        except urllib.error.HTTPError as error:
            assert error.code == 403
            error.close()
        request = urllib.request.Request(origin + '/api/disconnect',
            data=b'{"connector":"github"}', headers={'X-Harness-Connections': page['key'],
            'Origin': origin, 'Content-Type': 'application/json'})
        with opener.open(request, timeout=3) as response:
            assert json.load(response)['state'] == 'not_connected'
        assert json.loads(cli('list', '--json')) == []
    finally:
        process.terminate()
        process.wait(timeout=5)
print('Installed Connections CLI, shared local credentials and authenticated disconnect passed')
'''
    encoded = base64.b64encode(script.encode()).decode()
    vm.command('printf %s ' + shlex.quote(encoded) + ' | base64 -d | python3', timeout=30)
    vm.command('harness connections', timeout=15)
    try:
        wait_installer_screen(vm, r'Connectors', 'connections-page', timeout=30)
        # Search, Refresh, then Add custom: the dialog for a remote MCP server.
        for _ in range(3):
            vm.keys('tab')
        vm.keys('ret')
        wait_installer_screen(vm, r'Remote MCP server URL', 'connections-add-custom', timeout=15)
        vm.keys('esc')
    finally:
        # Use Chromium's own close-window shortcut. Harness deliberately does
        # not bind Alt+F4; sending it can leave the browser alive or change VT.
        vm.keys('ctrl', 'shift', 'w')
        vm.command('for n in $(seq 1 50); do ! pgrep -u "$(id -u)" -x chromium '
                   '>/dev/null && exit 0; sleep .1; done; exit 1', timeout=10)
        # The helper is on demand, but waits 15 minutes for inactivity. Stop
        # this fixture's helper before the image test records idle RAM.
        pattern = r'^/usr/bin/python3 /usr/lib/harness-os/connections/connections[.]py serve --background$'
        vm.command('pkill -INT -u "$(id -u)" -f ' + shlex.quote(pattern) + '; '
                   'for n in $(seq 1 30); do ! pgrep -u "$(id -u)" -f ' + shlex.quote(pattern) +
                   ' >/dev/null && exit 0; sleep .1; done; exit 1', timeout=10)
    return {'status': 'passed', 'scope': 'Installed CLI, shared fixture credentials, bridge socket, local API boundary, browser page and Add custom dialog; no provider authentication'}
