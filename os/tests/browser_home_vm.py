"""Real Chromium start-page/Connections checks on the disposable OS test disk."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shlex
import shutil
import tarfile
import tempfile

from footprint_vm import copy_file
from install_first import wait_installer_screen

HELPER = r'^/usr/bin/python3 /usr/lib/harness-os/connections/connections[.]py serve --background$'


def overlay(vm, source, result):
    assert source.is_dir()
    vm.command('test "$(lsblk -dn -o SERIAL /dev/vda)" = HN_OS_TEST && test ! -f /etc/harness-live')
    spec = importlib.util.spec_from_file_location('home_payload', source / 'os/tools/browser_home_payload.py')
    payload = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(payload)
    with tempfile.TemporaryDirectory(prefix='home-candidate-') as temporary:
        base = Path(temporary)
        root = base / 'root'
        result['browser_home'] = payload.stage(source, root)
        connections = root / 'usr/lib/harness-os/connections/connections.py'
        connections.parent.mkdir(parents=True)
        shutil.copyfile(source / 'os/connectors/connections.py', connections)
        archive = base / 'home.tar'
        with tarfile.open(archive, 'w') as tar:
            for path in sorted(root.rglob('*')):
                if path.is_file():
                    target = '/' + str(path.relative_to(root))
                    result['candidates'][target] = {'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
                    info = tar.gettarinfo(str(path), target.lstrip('/'))
                    info.uid = info.gid = 0
                    info.uname = info.gname = 'root'
                    with path.open('rb') as handle:
                        tar.addfile(info, handle)
        copy_file(vm, archive.read_bytes(), '/tmp/home-candidate.tar')
        vm.command('sudo -n tar -xf /tmp/home-candidate.tar -C /')


def helper_stopped(vm):
    vm.command('pkill -INT -u "$(id -u)" -f ' + shlex.quote(HELPER) + ' || true')
    vm.command('timeout 10 sh -c ' + shlex.quote(
        'while pgrep -u "$(id -u)" -f ' + shlex.quote(HELPER) + ' >/dev/null; do sleep .1; done'))


def close_browser(vm):
    vm.keys('ctrl', 'shift', 'w')
    vm.command('timeout 10 sh -c \'while pgrep -u "$(id -u)" -x chromium >/dev/null; do sleep .1; done\'')


def exercise(vm, result):
    vm.command('! pgrep -u "$(id -u)" -x chromium')
    vm.command('sudo -n nmcli networking off')
    try:
        vm.command('hn-browser')
        wait_installer_screen(vm, r'Connect accounts', 'browser-home-offline', timeout=45)
        vm.command('! pgrep -u "$(id -u)" -f ' + shlex.quote(HELPER))
        result['checks'].append('Default browser start is the local Harness page offline, with no Connections helper running')
        vm.click_word('browser-home-mouse', 'Connections')
        wait_installer_screen(vm, r'Connect once', 'browser-home-connections', timeout=30)
        vm.keys('alt', 'left')
        wait_installer_screen(vm, r'Connect accounts', 'browser-home-back')
        helper_stopped(vm)
        # Browser Back restores the focused button. Enter must work as well as a click.
        vm.keys('ret')
        wait_installer_screen(vm, r'Connect once', 'browser-home-keyboard-reopen', timeout=30)
        result['checks'].append('Mouse click and keyboard Enter open authenticated Connections; Back and helper expiry recover without a stale bookmark')
        vm.keys('ctrl', 't')
        wait_installer_screen(vm, r'Connect accounts', 'browser-home-new-tab')
        close_browser(vm)
        helper_stopped(vm)
        vm.command('hn-browser')
        wait_installer_screen(vm, r'Connect accounts', 'browser-home-restart')
        close_browser(vm)
        result['checks'].append('New Tab and the next browser launch keep the start page without an install or permission prompt')
    except BaseException:
        # Inspect only disposable profile extension state, never saved accounts.
        code = '''import json,pathlib
out={}
root=pathlib.Path.home()/'.config/chromium'
for path in root.glob('*/Preferences'):
 d=json.loads(path.read_text()).get('extensions',{})
 out[str(path.relative_to(root))]={'overrides':d.get('chrome_url_overrides'), 'extensions':{k:{field:v.get(field) for field in ['state','disable_reasons','location','manifest']} for k,v in d.get('settings',{}).items()}}
print(json.dumps(out))'''
        output, _ = vm.command('python3 -c ' + shlex.quote(code), check=False)
        (vm.folder / 'home-profile-diagnostic.txt').write_text(output)
        vm.keys('ctrl', 'l')
        vm.type_probe('chrome://extensions')
        vm.keys('ret')
        wait_installer_screen(vm, r'Extensions', 'home-extensions-diagnostic')
        vm.keys('ctrl', 't')
        vm.screenshot('home-second-tab-diagnostic')
        raise
    finally:
        vm.command('sudo -n nmcli networking on')
