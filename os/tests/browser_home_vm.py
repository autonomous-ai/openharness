"""Real Chromium start-page/Connections checks on the disposable OS test disk."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
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
        # The page's imports, catalog and bundled assets must match its entry
        # point, including when the reusable ISO contains an older connector.
        shutil.copytree(source / 'os/connectors', root / 'usr/lib/harness-os/connections',
                        ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
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


def connected_page(vm, name):
    # Catalog cards are rendered only after the authenticated API succeeds;
    # the static page title alone would miss a broken capability handoff.
    text = wait_installer_screen(vm, r'Ahrefs', name, timeout=30)
    assert re.search(r'Available', text, re.I), text


def preferences(vm, result):
    """Exercise real browser choices, then observe ordinary visible launches."""
    guest = Path(__file__).with_name('browser_home_preferences_guest.py')
    copy_file(vm, guest.read_bytes(), '/tmp/harness-browser-choices.py')
    result['browser_choice_observer_sha256'] = hashlib.sha256(guest.read_bytes()).hexdigest()
    vm.command('test ! -e /tmp/harness-browser-original && cp -a ~/.config/chromium /tmp/harness-browser-original')

    def choose(action):
        path = '/tmp/browser-choice-' + action + '.json'
        try:
            vm.command('timeout 75 python3 /tmp/harness-browser-choices.py ' + action + ' --output ' + path)
        finally:
            for suffix in ['.json', '.log']:
                try:
                    (vm.folder / ('browser-choice-' + action + suffix)).write_bytes(vm.read_file(path.removesuffix('.json') + suffix))
                except Exception:
                    pass
        return json.loads(vm.read_file(path))

    def ordinary_page(name):
        vm.command('hn-browser')
        text = wait_installer_screen(vm, r'Google', name, timeout=30)
        assert not re.search(r'Harness_', text, re.I), text
        close_browser(vm)

    choose('disabled')
    ordinary_page('browser-home-disabled')
    choose('enabled')
    vm.command('hn-browser')
    wait_installer_screen(vm, r'Harness_', 'browser-home-enabled')
    close_browser(vm)
    # Chromium requires its visible native confirmation when removing another
    # extension, even if management.uninstall requests showConfirmDialog:false.
    # Remove is the dialog's default OK action; send real keyboard confirmation.
    vm.command('hn-browser')
    wait_installer_screen(vm, r'Harness_', 'browser-home-before-removal')
    # Chromium ignores this internal URL as a normal startup argument. Navigate
    # through the visible address bar as a user would.
    vm.keys('ctrl', 'l')
    vm.type_probe('chrome://extensions/')
    vm.keys('ret')
    wait_installer_screen(vm, r'start\s+page', 'browser-home-extension-card')
    vm.click_word('browser-home-remove-action', 'Remove')
    confirmation = wait_installer_screen(vm, r'Cancel', 'browser-home-remove-confirm')
    assert re.search(r'Remove', confirmation, re.I), confirmation
    vm.keys('ret')
    wait_installer_screen(vm, r'(?s)\A(?!.*(?:start\s+page|Cancel)).*Extensions',
                          'browser-home-extension-removed')
    close_browser(vm)
    identity = result['browser_home']['extension_id']
    assert identity not in {item['id'] for item in choose('inspect')['extensions']}
    ordinary_page('browser-home-removed')
    ordinary_page('browser-home-removed-again')
    vm.command('test -f ' + shlex.quote('/home/me/.config/chromium/External Extensions/' + identity + '.json'))
    result['checks'].append('Disabling, re-enabling and removing through Chromium management persist across ordinary browser launches, even with the OS descriptor present')

    # A real, independently installed custom extension—not fabricated preferences.
    vm.command('mv ~/.config/chromium /tmp/harness-browser-removed')
    choose('custom')
    vm.command('hn-browser')
    wait_installer_screen(vm, r'CUSTOM\s+TAB', 'browser-existing-custom-page')
    close_browser(vm)
    vm.command('test ! -e ' + shlex.quote('/home/me/.config/chromium/External Extensions/' + identity + '.json'))
    result['checks'].append('An existing custom New Tab extension survives ordinary hn-browser startup; Harness does not register its override')
    vm.command('mv ~/.config/chromium /tmp/harness-browser-custom && mv /tmp/harness-browser-original ~/.config/chromium')


def exercise(vm, result):
    vm.command('! pgrep -u "$(id -u)" -x chromium')
    vm.command('sudo -n nmcli networking off')
    failed = False
    try:
        vm.command('hn-browser')
        # The small subtitle can be split into separate OCR regions at the VM's
        # resolution. The Harness wordmark is distinct and read consistently; Connections can
        # also appear as a recently visited shortcut on Chromium's default page.
        wait_installer_screen(vm, r'Harness_', 'browser-home-offline', timeout=45)
        vm.command('! pgrep -u "$(id -u)" -f ' + shlex.quote(r'^/usr/lib/chromium/chromium .*--headless'))
        vm.command('test ! -S "/run/user/$(id -u)/harness-browser-start/ready"')
        vm.command('! pgrep -u "$(id -u)" -f ' + shlex.quote(HELPER))
        result['checks'].append('First browser start is the local Harness page offline; temporary preparation and Connections helper are both stopped')
        vm.click_word('browser-home-mouse', 'Connections')
        connected_page(vm, 'browser-home-connections')
        vm.keys('ctrl', 'w')
        wait_installer_screen(vm, r'Harness_', 'browser-home-back')
        helper_stopped(vm)
        # Closing the Connections tab returns to its action. Enter must work too.
        vm.keys('ret')
        connected_page(vm, 'browser-home-keyboard-reopen')
        result['checks'].append('Mouse click and keyboard Enter open authenticated Connections in a new tab; closing it and helper expiry recover without a stale bookmark')
        vm.keys('ctrl', 't')
        wait_installer_screen(vm, r'Harness_', 'browser-home-new-tab')
        close_browser(vm)
        helper_stopped(vm)
        vm.command('hn-browser')
        wait_installer_screen(vm, r'Harness_', 'browser-home-restart')
        close_browser(vm)
        result['checks'].append('New Tab and the next browser launch keep the start page without an install or permission prompt')
        preferences(vm, result)
    except BaseException:
        failed = True
        # Inspect only disposable profile extension state, never saved accounts.
        code = '''import json,pathlib
out={}
root=pathlib.Path.home()/'.config/chromium'
for path in root.glob('*/Preferences'):
 d=json.loads(path.read_text()).get('extensions',{})
 out[str(path.relative_to(root))]={'overrides':d.get('chrome_url_overrides'), 'extensions':{k:{field:v.get(field) for field in ['state','disable_reasons','location','manifest']} for k,v in d.get('settings',{}).items()}}
print(json.dumps(out))'''
        try:
            output, _ = vm.command('python3 -c ' + shlex.quote(code), check=False)
            (vm.folder / 'home-profile-diagnostic.txt').write_text(output)
        except Exception as error:
            result.setdefault('diagnostic_errors', []).append(str(error))
        try:
            # Capture the actual failure without typing into a potentially closed
            # browser or replacing the original error with an OCR timeout.
            vm.screenshot('home-failure')
        except Exception as error:
            result.setdefault('diagnostic_errors', []).append(str(error))
        raise
    finally:
        try:
            vm.command('sudo -n nmcli networking on')
        except Exception as error:
            if not failed:
                raise
            result.setdefault('diagnostic_errors', []).append(str(error))
