#!/usr/bin/env python3
"""Install untouched preview 14, press Super+u once, preserve work and cold boot."""
import argparse
from functools import partial
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tarfile
import threading
import time

import package_image_binding as binding
import public_update_transport as transport
from footprint_vm import copy_file
from hardware_update_vm import graceful_stop
from session_vm import PROBE, screen_text
from vm import VM, check_graphical_keyboard

BASE = 'b6cbaf3e3090f43106ad1ee47606349bd1a0ae89'
BASE_ISO = 'fa4f282644ac81e9e3b7de55276edd7dc08405e50875da544dc7f9fd6d50ba12'
STATE = '/home/me/.local/state/harness-os/updates'
GUEST = '/home/me/public-update-observer.py'
FIXTURE = '/var/lib/harness-public-update-test'


def verify_binding(bundle, image_manifest, receipt_path):
    manifest = json.loads((bundle / 'package-manifest.json').read_text())
    image = json.loads(image_manifest.read_text())
    receipt = json.loads(receipt_path.read_text())
    package = bundle / manifest['package']['name']
    if receipt.get('status') != 'passed' or receipt.get('overrides') != []:
        raise ValueError('Require a complete package-to-ISO comparison without overrides')
    expected = {'source_commit': manifest['source_commit'], 'runtime': manifest['runtime'],
                'package_version': manifest['package']['version'],
                'package': {'name': package.name, **binding.identity(package)},
                'package_manifest': binding.identity(bundle / 'package-manifest.json'),
                'image_manifest': binding.identity(image_manifest),
                'image': {key: image['iso'][key] for key in ('bytes', 'sha256')}}
    if any(receipt.get(key) != value for key, value in expected.items()):
        raise ValueError('Binding receipt does not identify the supplied artifacts')
    if image['source_commit'] != manifest['source_commit'] or image['harness_inputs'] != manifest['runtime']:
        raise ValueError('Candidate image and runtime producers differ')
    rows = binding.archive_inventory(package, manifest['package']['version'])
    if [row['archive'] for row in receipt['members']] != rows or not all(row['equal'] is True for row in receipt['members']):
        raise ValueError('Binding receipt omits or changes an archive member')
    return manifest, image, receipt


def same_work(before, after):
    for key in ('agents', 'daemon', 'terminal', 'project', 'boot_id'):
        if before[key] != after[key]:
            raise ValueError('Running work changed during update: ' + key)
    if after['heartbeat'] <= before['heartbeat']:
        raise ValueError('Terminal stopped making progress during update')


def installed_matches(record, receipt):
    if record['runtime'] != receipt['runtime'] or record['package_version'] != receipt['package_version']:
        raise ValueError('Installed candidate identity differs')
    rows = {row['archive']['name']: row['archive'] for row in receipt['members']}
    if set(record['owned_files']) != set(rows):
        raise ValueError('Installed ownership list differs from the candidate package')
    for name, expected in rows.items():
        actual = record['owned_files'][name]
        if any(actual.get(key) != value for key, value in expected.items() if key != 'name'):
            raise ValueError('Installed file differs from the ISO-bound package: ' + name)


def display_matches(record, expected, *, restored=False):
    executable = expected['executable'] if restored else '/usr/lib/harness-os/labwc'
    owner = expected['owner'] if restored else 'harness-os'
    checksum = expected['sha256'] if restored else expected['binary']['sha256']
    if any(record[key] != value for key, value in
           [('executable', executable), ('owner', owner), ('sha256', checksum)]):
        raise ValueError('Running compositor differs from the expected package')


def shutdown(vm, record, name, root=False):
    # Drain the diagnostic serial socket while waiting for the fresh QMP
    # shutdown event. An unread console can stall QEMU during guest poweroff.
    event = graceful_stop(vm, privileged=not root)
    record.setdefault('shutdowns', []).append({'name': name, **event})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', type=Path, required=True)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--candidate-image-manifest', type=Path, required=True)
    parser.add_argument('--candidate-image-binding', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    iso, bundle, folder = args.iso.absolute(), args.bundle.absolute(), args.output.absolute()
    folder.mkdir(parents=True, exist_ok=False)
    base = json.loads(iso.with_name('manifest.json').read_text())
    if base['source_commit'] != BASE or base['version'] != '0.1.0-preview.14' or base['iso']['sha256'] != BASE_ISO:
        raise ValueError('Use the original preview 14 image')
    if iso.name != base['iso']['name'] or binding.identity(iso) != {key: base['iso'][key] for key in ('bytes', 'sha256')}:
        raise ValueError('Baseline ISO bytes differ')
    candidate, image, bound = verify_binding(bundle, args.candidate_image_manifest, args.candidate_image_binding)
    source = Path(__file__).resolve().parents[2]
    head = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    if subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain'], text=True).strip():
        raise ValueError('Commit the observer before native acceptance')
    if bound['observer']['source_commit'] != head:
        raise ValueError('Run artifact binding with this reviewed observer source')
    record = {'status': 'running', 'started_at': time.time(), 'observer_source': head,
              'baseline': base, 'candidate': candidate, 'candidate_image': image,
              'binding_receipt': binding.identity(args.candidate_image_binding), 'checks': [],
              'test_inputs': {name: binding.identity(Path(__file__).with_name(name)) for name in
                             ['public_update_vm.py', 'public_update_guest.py', 'public_update_transport.py',
                              'package_image_binding.py', 'vm.py', 'session_vm.py', 'footprint_vm.py',
                              'hardware_update_vm.py', 'hardware_update_guest.py', 'hardware_install_vm.py']},
              'limits': ['Private official-path HTTPS fixture; not GitHub/CDN publication.',
                         'Same Arch snapshot; no kernel migration or physical hardware claim.']}
    for name, path in [('baseline-manifest.json', iso.with_name('manifest.json')),
                       ('candidate-manifest.json', args.candidate_image_manifest),
                       ('package-manifest.json', bundle / 'package-manifest.json'),
                       ('package-image-binding.json', args.candidate_image_binding)]:
        shutil.copyfile(path, folder / name)
    fixture = folder / 'https'
    transport.prepare(bundle, fixture, base['harness_inputs']['release_baselines'])
    record['certificates'] = transport.certificates(fixture)
    shutil.copyfile(Path(__file__).with_name('public_update_transport.py'), fixture / 'server.py')
    transfer = folder / 'transfer'
    transfer.mkdir()
    archive = transfer / 'fixture.tar.gz'
    with tarfile.open(archive, 'w:gz') as target:
        for path in sorted(fixture.iterdir()):
            if path.name not in {'ca.key', 'ca.srl', 'leaf.csr', 'leaf.ext'}:
                target.add(path, arcname=path.name, recursive=False)
    vm = VM(folder, iso, 'uefi', 2048, cpu='Nehalem')
    http = ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory=str(transfer)))
    thread = threading.Thread(target=http.serve_forever, daemon=True)
    thread.start()
    config = dict(disk='/dev/vda', expected_serial='HN_OS_TEST', confirm_erase='/dev/vda',
                  username='me', hostname='harness', password='test-password-123', encrypt=True, serial_console=True)

    def authenticate():
        vm.command('printf %s ' + shlex.quote(config['password'] + '\n') + ' | sudo -S -v')

    def observe(name, action, privileged=False):
        target = '/tmp/public-update-' + name + '.json'
        vm.command(('sudo -n ' if privileged else '') + 'python3 ' + GUEST + ' ' + action + ' ' + target)
        data = vm.read_file(target)
        (folder / (name + '.json')).write_bytes(data)
        return json.loads(data)

    def keyboard(label):
        vm.command('hn select-window -t ' + shlex.quote(terminal) + ' && hn select-pane -t ' + shlex.quote(terminal))
        vm.keys('meta_l', 'ret')
        vm.type_probe(label)
        vm.keys('ret')
        vm.command('timeout 10 sh -c ' + shlex.quote('until grep -qx ' + shlex.quote(label) + ' ~/projects/session-probe/input; do sleep .1; done'))
        vm.screenshot(label)

    try:
        vm.start(live=True)
        record.update(firmware='uefi', memory_mib=2048, cpu='Nehalem', acceleration=vm.acceleration)
        vm.monitor('set_link', name='hnnet', up=False)
        vm.wait(r'root@[^\r\n]*[#] ')
        vm.shell_ready = True
        vm.command('stty -echo; nmcli networking off')
        copy_file(vm, json.dumps(config).encode(), '/tmp/install-config.json')
        output, _ = vm.command('harness install --config /tmp/install-config.json --yes-erase-disk', timeout=360)
        (folder / 'install.log').write_text(output)
        shutdown(vm, record, 'baseline-install', root=True)
        vm.start(live=False)
        vm.monitor('set_link', name='hnnet', up=False)
        vm.login_installed(config)
        authenticate()
        vm.command('systemctl --user stop harness-update.timer harness-update.service')
        vm.command('test ! -e ' + STATE + '/current && test ! -e ' + STATE + '/ready.json && test ! -e ' + STATE + '/approved.json')
        copy_file(vm, Path(__file__).with_name('public_update_guest.py').read_bytes(), GUEST)
        original = observe('01-original-system', 'system', True)
        original_display = observe('01-original-display', 'display', True)
        (folder / 'hosts-before.txt').write_bytes(vm.read_file('/etc/hosts'))
        if original['runtime'] != base['harness_inputs'] or original['package_version'] != base['package_version']:
            raise ValueError('Baseline installed runtime differs from the original ISO')
        # Only network/trust fixture files are added. Update timers are paused
        # during fixture setup so no real public channel is contacted in between.
        vm.monitor('set_link', name='hnnet', up=True)
        vm.command('sudo -n nmcli networking on && nm-online -q --timeout=30', timeout=35)
        address = 'http://10.0.2.2:' + str(http.server_port) + '/fixture.tar.gz'
        vm.command('curl --fail --silent --show-error ' + shlex.quote(address) + ' -o /tmp/public-update-fixture.tar.gz', timeout=90)
        expected = binding.identity(archive)['sha256']
        vm.command('printf %s ' + shlex.quote(expected + '  /tmp/public-update-fixture.tar.gz\n') + ' | sha256sum -c -')
        vm.command('sudo -n mkdir -m 700 ' + FIXTURE + ' && sudo -n tar -xzf /tmp/public-update-fixture.tar.gz -C ' + FIXTURE)
        service = ('[Unit]\nDescription=Private Harness update transport fixture\nAfter=local-fs.target\n'
                   '[Service]\nExecStart=/usr/bin/python3 ' + FIXTURE + '/server.py ' + FIXTURE + '\n'
                   '[Install]\nWantedBy=multi-user.target\n')
        copy_file(vm, service.encode(), '/tmp/harness-public-update-test.service')
        vm.command('sudo -n install -m 644 /tmp/harness-public-update-test.service /etc/systemd/system/harness-public-update-test.service && '
                   'sudo -n systemctl daemon-reload && sudo -n systemctl enable --now harness-public-update-test.service')
        vm.command('printf %s ' + shlex.quote('\n127.0.0.1 github.com storage.googleapis.com\n') + ' | sudo -n tee -a /etc/hosts >/dev/null')
        (folder / 'hosts-fixture.txt').write_bytes(vm.read_file('/etc/hosts'))
        # Arch's resolve NSS module precedes files; the observed baseline still
        # resolved public addresses after flush-caches. This is an explicit
        # guest-only transport fixture, so put its hosts entries first. Do not
        # change the updater, its URLs, signature/hash checks or privilege policy.
        nss = vm.read_file('/etc/nsswitch.conf').decode()
        (folder / 'nsswitch-before.txt').write_text(nss)
        lines = nss.splitlines(keepends=True)
        rows = [i for i, line in enumerate(lines) if line.startswith('hosts:')]
        if len(rows) != 1:
            raise ValueError('Expected one hosts NSS entry for the private transport')
        lines[rows[0]] = 'hosts: files mymachines resolve [!UNAVAIL=return] myhostname dns\n'
        copy_file(vm, ''.join(lines).encode(), '/tmp/harness-test-nsswitch.conf')
        vm.command('sudo -n install -m 644 /tmp/harness-test-nsswitch.conf /etc/nsswitch.conf')
        vm.command('timeout 10 sh -c ' + shlex.quote("until ss -ltnH | grep -q '127.0.0.1:443 '; do sleep .1; done"))
        # The original session has already queried the public hosts. Flush its
        # resolver cache after adding the private hosts file; prove this request
        # reaches loopback before interpreting an HTTPS result as fixture trust.
        vm.command('sudo -n resolvectl flush-caches')
        diagnostic = ('import json, socket, urllib.request; '
                      'print(json.dumps({"addresses": {host: sorted({item[4][0] for item in '
                      'socket.getaddrinfo(host,443,type=socket.SOCK_STREAM)}) for host in '
                      '["github.com","storage.googleapis.com"]}, '
                      '"proxy_keys": sorted(urllib.request.getproxies())}))')
        output, _ = vm.command('python3 -c ' + shlex.quote(diagnostic), timeout=15)
        (folder / '02-private-resolution.log').write_text(output)
        (folder / '02-nsswitch.txt').write_bytes(vm.read_file('/etc/nsswitch.conf'))
        vm.command('python3 -c ' + shlex.quote('import socket; '
                   'assert all({i[4][0] for i in socket.getaddrinfo(host,443,type=socket.SOCK_STREAM)} == {"127.0.0.1"} '
                   'for host in ["github.com","storage.googleapis.com"]), "Private transport must resolve only to loopback"'))
        check = 'import urllib.request; print(urllib.request.urlopen(' + repr('https://github.com' + transport.FEED) + ', timeout=10).status)'
        output, status = vm.command('python3 -c ' + shlex.quote(check), timeout=15, check=False)
        (folder / '02-untrusted-tls.log').write_text(output)
        if status == 0 or 'CERTIFICATE_VERIFY_FAILED' not in output:
            raise ValueError('Guest HTTPS did not enforce trust before installing the fixture CA')
        vm.command('sudo -n install -m 644 ' + FIXTURE + '/ca.crt /etc/ca-certificates/trust-source/anchors/harness-public-update-test.crt && sudo -n update-ca-trust')
        output, _ = vm.command('python3 -c ' + shlex.quote(check), timeout=15)
        (folder / '03-trusted-tls.log').write_text(output)
        anchor = vm.read_file('/etc/ca-certificates/trust-source/anchors/harness-public-update-test.crt')
        if hashlib.sha256(anchor).hexdigest() != record['certificates']['ca.crt']['sha256']:
            raise ValueError('Guest trust anchor differs from the disposable fixture CA')
        record['guest_trust_anchor'] = {'path': '/etc/ca-certificates/trust-source/anchors/harness-public-update-test.crt',
                                      'sha256': hashlib.sha256(anchor).hexdigest()}
        prepared = observe('04-prepared-system', 'system', True)
        if prepared != original:
            raise ValueError('Fixture preparation changed installed Harness or privilege policy')
        vm.command('systemctl --user start harness-update.timer harness-update.service', timeout=120)
        vm.command('python3 -c ' + shlex.quote("import json; assert json.load(open('" + STATE + "/system.json'))['available'] is True"))
        vm.command('for n in $(seq 1 90); do pgrep -u 1000 -x opencode >/dev/null && exit 0; sleep .5; done; exit 1', timeout=50)
        copy_file(vm, PROBE.encode(), '/home/me/public-update-terminal.py')
        vm.command('mkdir -p ~/projects/public-update-proof && printf work-survives > ~/projects/public-update-proof/notes.txt && '
                   "hn new-window -P -F '#{pane_id}' -n update-proof 'python3 /home/me/public-update-terminal.py' > /tmp/public-update-terminal-id")
        vm.command('for n in $(seq 1 60); do test -s ~/projects/session-probe/pid && exit 0; sleep .1; done; exit 1')
        terminal = vm.read_file('/tmp/public-update-terminal-id').decode().strip()
        if not re.fullmatch(r'%\d+', terminal):
            raise ValueError('Invalid probe pane identity')
        keyboard('before-public-update')
        before = observe('05-running-work', 'work')
        vm.command('sudo -K')
        for command in ['/usr/bin/true', '/usr/bin/harness upgrade /tmp/untrusted-bundle']:
            output, status = vm.command('sudo -n ' + command, check=False)
            if status == 0 or 'password' not in output.lower():
                raise ValueError('Unexpected no-password privilege: ' + command)
        record['public_action'] = {'keys': ['meta_l', 'u'], 'count': 1, 'at': time.time()}
        vm.keys('meta_l', 'u')
        vm.command('for n in $(seq 1 720); do test -f /run/harness-os-restart-required && '
                   'grep -q ready /run/harness-os-restart-required && exit 0; sleep .5; done; exit 1', timeout=365)
        deadline = time.monotonic() + 15
        while 'updated. restart when ready.' not in screen_text(vm, '06-updated-screen'):
            if time.monotonic() >= deadline:
                raise TimeoutError('Updated screen was not visibly rendered')
            time.sleep(.25)
        after = observe('07-preserved-work', 'work')
        same_work(before, after)
        keyboard('after-public-update')
        # Only after success and preserved work are observed may the diagnostic
        # serial shell authenticate again to read the private root receipt.
        authenticate()
        installed = observe('08-installed-candidate', 'system', True)
        installed_matches(installed, bound)
        if observe('08-running-display', 'display', True) != original_display:
            raise ValueError('Updating the package restarted or replaced the running compositor')
        saved = observe('09-checkpoint', 'checkpoint', True)
        if (saved['receipt']['status'] != 'applied' or saved['receipt']['candidate'] != candidate
                or saved['previous_files'] != original['owned_files']
                or saved['receipt']['previous_runtime'] != base['harness_inputs']):
            raise ValueError('Root update receipt/checkpoint did not preserve the original package')
        vm.command('printf new-work-after-checkpoint > ~/projects/public-update-proof/after.txt')
        project = observe('10-project-before-reboot', 'project')
        vm.command('journalctl --user -b --no-pager > /tmp/public-update-user-journal.log && '
                   'sudo -n journalctl -b --no-pager > /tmp/public-update-system-journal.log')
        for kind in ('user', 'system'):
            (folder / (kind + '-journal-before-reboot.log')).write_bytes(vm.read_file('/tmp/public-update-' + kind + '-journal.log'))
        record['checks'].append('One public Super+u with empty sudo credentials applies the ISO-bound package; original code/policy were untouched and live work/keyboard survived.')
        shutdown(vm, record, 'updated-system')
        vm.start(live=False)
        vm.login_installed(config)
        authenticate()
        rebooted = observe('11-cold-boot-system', 'system', True)
        installed_matches(rebooted, bound)
        if candidate.get('compositor'):
            display_matches(observe('11-candidate-display', 'display', True), candidate['compositor'])
        if rebooted['boot_id'] == before['boot_id']:
            raise ValueError('No real cold boot occurred')
        if observe('12-project-after-reboot', 'project') != project:
            raise ValueError('Home/project files changed across update reboot')
        if observe('13-checkpoint-after-reboot', 'checkpoint', True) != saved:
            raise ValueError('Checkpoint changed across candidate reboot')
        check_graphical_keyboard(vm, '14-candidate-keyboard', allow_welcome=True)
        # The unchanged client may show its welcome or saved shells after boot;
        # it does not resume their previous foreground commands. Live agent
        # preservation was proved before shutdown above;
        # now prove the bundled agent can start normally on the updated OS.
        vm.command('hn new-window -n agent-after-update ' + shlex.quote(
                   'cd "$HOME/projects/public-update-proof" && exec /usr/bin/opencode'))
        vm.command('for n in $(seq 1 90); do pgrep -u 1000 -x opencode >/dev/null && exit 0; sleep .5; done; exit 1', timeout=50)
        vm.command('test ! -e ' + STATE + '/current && test ! -e ' + STATE + '/ready.json')
        # The unchanged user timer finishes the one approved request after boot.
        # Do not manually activate the worker or issue a second update action.
        # Its two-minute startup delay also has up to 30 seconds of random delay
        # and systemd's default one-minute timer accuracy window. Retain the
        # actual scheduling evidence; a three-minute wait can expire too early.
        output, _ = vm.command('systemctl --user --no-pager show harness-update.timer harness-update.service', check=False)
        (folder / '15-update-units-before-wait.log').write_text(output)
        output, status = vm.command('for n in $(seq 1 600); do test ! -e ' + STATE +
                                   '/approved.json && exit 0; sleep .5; done; exit 1', timeout=305, check=False)
        (folder / '16-update-completion-wait.log').write_text(output)
        diagnostic = ('import json; from pathlib import Path; p=Path(' + repr(STATE) + '); '
                      'print(json.dumps({n:json.loads((p/n).read_text()) if (p/n).is_file() else None '
                      'for n in ["approved.json","check.json","system.json"]},indent=2))')
        output, _ = vm.command('python3 -c ' + shlex.quote(diagnostic))
        (folder / '17-update-completion-state.log').write_text(output)
        output, _ = vm.command('systemctl --user --no-pager show harness-update.timer harness-update.service', check=False)
        (folder / '18-update-units-after-wait.log').write_text(output)
        if status:
            authenticate()
            vm.command('sudo -n journalctl -b --no-pager > /tmp/public-update-completion-failed.log')
            (folder / 'completion-failed-journal.log').write_bytes(vm.read_file('/tmp/public-update-completion-failed.log'))
            raise TimeoutError('The ordinary update timer did not finish the approved request; see retained unit, state and journal evidence.')
        vm.command('test ! -e ' + STATE + '/current && test ! -e ' + STATE + '/ready.json')
        vm.command('sudo -n cat ' + FIXTURE + '/requests.jsonl > /tmp/public-update-requests.jsonl')
        requests = vm.read_file('/tmp/public-update-requests.jsonl')
        (folder / 'requests.jsonl').write_bytes(requests)
        logs = [json.loads(line) for line in requests.splitlines()]
        if not all(row['status'] == 200 and row['complete'] for row in logs):
            raise ValueError('Unexpected route, truncated response or attempted fast-runtime download')
        for suffix in ['metadata.json', 'package-manifest.json', candidate['package']['name']]:
            if not any(row['host'] == 'github.com' and row['path'].endswith('/' + suffix) for row in logs):
                raise ValueError('Missing actual release-channel request: ' + suffix)
        vm.command('sudo -n journalctl -b --no-pager > /tmp/public-update-final-journal.log')
        (folder / 'final-journal.log').write_bytes(vm.read_file('/tmp/public-update-final-journal.log'))
        record['checks'].append('Encrypted candidate cold boot accepts real keyboard input and an explicitly launched bundled agent, and preserves project bytes/ownership/times and the verified original checkpoint. Foreground command auto-resume is not claimed.')
        if candidate.get('compositor'):
            # Use the real retained package and current rollback implementation,
            # with the network disabled. No staged source or replacement binary.
            vm.command('systemctl --user stop harness-update.timer harness-update.service')
            vm.command('rm -f ~/projects/session-probe/pid ~/projects/session-probe/heartbeat && '
                       "hn new-window -P -F '#{pane_id}' -n rollback-proof 'python3 /home/me/public-update-terminal.py' > /tmp/public-update-terminal-id")
            vm.command('for n in $(seq 1 60); do test -s ~/projects/session-probe/pid && exit 0; sleep .1; done; exit 1')
            terminal = vm.read_file('/tmp/public-update-terminal-id').decode().strip()
            if not re.fullmatch(r'%\d+', terminal):
                raise ValueError('Invalid rollback probe pane identity')
            keyboard('before-offline-rollback')
            before_rollback = observe('19-before-rollback-work', 'work')
            authenticate()
            vm.command('sudo -n nmcli networking off')
            vm.monitor('set_link', name='hnnet', up=False)
            output, _ = vm.command('sudo -n python3 /usr/lib/harness-os/runtime_update.py rollback', timeout=240)
            (folder / '20-offline-rollback.log').write_text(output)
            same_work(before_rollback, observe('21-after-rollback-work', 'work'))
            keyboard('after-offline-rollback')
            restored = observe('22-restored-system', 'system', True)
            for key in ('package_version', 'owned_files', 'runtime', 'lock', 'sudo_policy'):
                if restored[key] != original[key]:
                    raise ValueError('Offline rollback did not restore the original system: ' + key)
            vm.command('test ! -e /usr/lib/harness-os/labwc && test ! -e /usr/share/harness-os/compositor.json')
            if observe('23-project-after-rollback', 'project') != project:
                raise ValueError('Offline rollback changed newer project files')
            shutdown(vm, record, 'offline-rollback')
            vm.start(live=False)
            vm.monitor('set_link', name='hnnet', up=False)
            vm.login_installed(config)
            authenticate()
            display_matches(observe('24-restored-display', 'display', True), original_display, restored=True)
            check_graphical_keyboard(vm, '25-restored-keyboard', allow_welcome=True)
            if observe('26-project-after-rollback-boot', 'project') != project:
                raise ValueError('Rollback reboot changed newer project files')
            record['checks'].append('The packaged compositor activates after cold boot. Offline rollback preserves running work, restores every original package file and privilege rule, removes the private compositor, then boots the original compositor with working keyboard and newer projects intact.')
        shutdown(vm, record, 'acceptance-complete')
        record['status'] = 'passed'
    except Exception as error:
        record.update(status='failed', error=f'{type(error).__name__}: {error}')
        try:
            if vm.process and vm.process.poll() is None:
                vm.screenshot('failure')
        except Exception as diagnostic:
            record['screenshot_error'] = str(diagnostic)
        raise
    finally:
        vm.stop()
        http.shutdown()
        http.server_close()
        thread.join(timeout=5)
        record['finished_at'] = time.time()
        record['duration_seconds'] = round(record['finished_at'] - record['started_at'], 3)
        record['private_transfer_stopped'] = not thread.is_alive()
        record['qemu_exit_code'] = vm.process.poll() if vm.process else None
        vm.control.cleanup()
        record['control_directory_removed'] = not vm.control_path.exists()
        for path in (fixture / 'ca.key', fixture / 'leaf.key', archive):
            path.unlink(missing_ok=True)
        (folder / 'receipt.json').write_text(json.dumps(record, indent=2) + '\n')
        print(json.dumps({'status': record['status'], 'receipt': str(folder / 'receipt.json')}))


if __name__ == '__main__':
    main()
