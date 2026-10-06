#!/usr/bin/env python3
"""Exercise real runtime updates in the private ARM graphical fixture.

This is not an ARM installer or a Fedora system updater. Only the per-user
Harness runtime and its screen reconnect are exercised, using unpublished
native binaries. The fixture's boot kernel and board support are unchanged.
"""
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
import tempfile
import threading
import time
import xml.etree.ElementTree as ET

from arm_boot import digest
from arm_session import ROOT, SessionVM, failure_evidence, fixture_identity
from fast_update_vm import exercise
from session_vm import put


def update_identity(folder, source):
    record = folder / 'fixture.json'
    if record.is_symlink() or not record.is_file():
        raise ValueError('Use a regular unpublished update fixture.')
    info = json.loads(record.read_text())
    if (not isinstance(info, dict) or info.get('published') is not False or info.get('status') != 'prepared' or
            info.get('source_commit') != source or info.get('architecture') != 'aarch64' or
            info.get('target') != 'aarch64-unknown-linux-musl' or info.get('version') != '999.0.1'):
        raise ValueError('Use the exact-source prepared native ARM update fixture.')
    required = {'harness-tui', 'cli.mjs', 'notify.mjs', 'cli-current.mjs', 'hn.json',
                'cli.json', 'cli-current.json', 'cli-ancestor.json',
                'feeds-ancestor.json', 'feeds-hn.json', 'feeds-both.json'}
    if not isinstance(info.get('files'), dict) or set(info['files']) != required:
        raise ValueError('The private update fixture is incomplete.')
    if {path.name for path in folder.iterdir()} != required | {'fixture.json'}:
        raise ValueError('The private update fixture contains unverified entries.')
    for name, checksum in info['files'].items():
        path = folder / name
        if (not re.fullmatch(r'[a-f0-9]{64}', str(checksum)) or path.is_symlink() or
                not path.is_file() or digest(path) != checksum):
            raise ValueError('Update fixture checksum mismatch: ' + name)
    with (folder / 'harness-tui').open('rb') as handle:
        header = handle.read(64)
    if header[:7] != b'\x7fELF\x02\x01\x01' or int.from_bytes(header[18:20], 'little') != 183:
        raise ValueError('The update terminal must be native ARM64 ELF.')
    release = json.loads((folder / 'hn.json').read_text())
    if set(release.get('builds', {})) != {'linux-arm64'}:
        raise ValueError('The update must exercise the linux-arm64 release entry.')
    # The private HTTP server and guest must consume the files whose hashes
    # were checked above, not a different URL or another checksummed artifact.
    # In particular, a valid CLI version probe does not execute notify.mjs.
    try:
        current_cli = info['runtime']['versions']['cli']
        ancestor_cli = info['runtime']['release_baselines']['cli']['version']
    except (KeyError, TypeError) as error:
        raise ValueError('Missing original CLI versions in the update fixture.') from error
    if any(not isinstance(value, str) or not re.fullmatch(r'\d+\.\d+\.\d+', value)
           for value in [current_cli, ancestor_cli]):
        raise ValueError('Invalid original CLI versions in the update fixture.')
    base_url = 'http://127.0.0.1:19447/'

    def ref(name):
        return {'url': base_url + name, 'sha256': info['files'][name], 'size': (folder / name).stat().st_size}

    expected = {
        'hn.json': {'version': info['version'], 'builds': {'linux-arm64': ref('harness-tui')}},
        'cli.json': {'cli': {'version': info['version'], 'cli': ref('cli.mjs'), 'notify': ref('notify.mjs')}},
        'cli-current.json': {'cli': {'version': current_cli, 'cli': ref('cli-current.mjs'), 'notify': ref('notify.mjs')}},
        'cli-ancestor.json': {'cli': {'version': ancestor_cli, 'cli': ref('cli.mjs'), 'notify': ref('notify.mjs')}},
        'feeds-ancestor.json': {'cli': base_url + 'cli-ancestor.json'},
        'feeds-hn.json': {'hn': base_url + 'hn.json', 'cli': base_url + 'cli-current.json'},
        'feeds-both.json': {'hn': base_url + 'hn.json', 'cli': base_url + 'cli.json'},
    }
    for name, document in expected.items():
        if json.loads((folder / name).read_text()) != document:
            raise ValueError('Private update manifest does not match its verified local assets: ' + name)
    return info


class UserSession:
    """The shared PC acceptance uses a user console; ARM has a root test console."""
    def __init__(self, machine):
        self.machine = machine
        self.folder = machine.folder

    def command(self, command, **kwargs):
        return self.machine.user(command, **kwargs)

    def __getattr__(self, name):
        return getattr(self.machine, name)


def prepare_updates(machine):
    # Install only the user updater into this private disk. PC installation,
    # pacman, system-release feeds and their privileged helpers stay absent.
    files = {
        'os/live_update.py': '/usr/lib/harness-os/live_update.py',
        'os/root/usr/lib/harness-os/open-updates': '/usr/lib/harness-os/open-updates',
        'os/root/usr/lib/harness-os/screen-action': '/usr/lib/harness-os/screen-action',
        'os/root/usr/lib/systemd/user/harness-update.service': '/usr/lib/systemd/user/harness-update.service',
        'os/root/usr/lib/systemd/user/harness-update.timer': '/usr/lib/systemd/user/harness-update.timer',
    }
    receipt = {}
    for source, destination in files.items():
        content = (ROOT / source).read_text()
        put(machine, destination, content)
        machine.command('chmod ' + ('644' if '/systemd/' in destination else '755') + ' ' + shlex.quote(destination))
        actual = hashlib.sha256(machine.read_file(destination)).hexdigest()
        if actual != digest(ROOT / source):
            raise ValueError('Updater transfer changed: ' + source)
        receipt[source] = actual
    # The shared acceptance performs fault injection via sudo inside its guest.
    # This passwordless test account already has a private root serial console;
    # this additional permission must never enter any published image.
    put(machine, '/etc/sudoers.d/99-harness-update-test', 'me ALL=(ALL) NOPASSWD: ALL\n')
    machine.command('chmod 440 /etc/sudoers.d/99-harness-update-test; visudo -cf /etc/sudoers.d/99-harness-update-test')
    config_path = '/usr/share/harness-os/labwc/rc.xml'
    config = ET.fromstring(machine.read_file(config_path))
    keyboard = config.find('keyboard')
    if keyboard is None:
        raise ValueError('ARM fixture lacks its graphical keyboard configuration.')
    for binding in list(keyboard.findall('keybind')):
        if binding.get('key') == 'W-u':
            keyboard.remove(binding)
    original = ET.parse(ROOT / 'os/root/usr/share/harness-os/labwc/rc.xml')
    binding = original.find('.//keybind[@key="W-u"]')
    if binding is None:
        raise ValueError('No production update shortcut to exercise.')
    keyboard.append(binding)
    put(machine, config_path, ET.tostring(config, encoding='unicode'))
    receipt['effective_labwc_sha256'] = hashlib.sha256(machine.read_file(config_path)).hexdigest()
    machine.user('systemctl --user daemon-reload')
    machine.command('pkill -HUP -u 1000 -x labwc')
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture', type=Path, required=True)
    parser.add_argument('--fixture-source', required=True, help='Actual producer SHA of the immutable ARM boot fixture')
    parser.add_argument('--updates', type=Path, required=True)
    parser.add_argument('--updates-source', help='Explicit producer SHA when the update fixture precedes this test driver')
    parser.add_argument('--output', type=Path, default=Path('os/test-results/arm-updates'))
    args = parser.parse_args()
    source = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip()
    if subprocess.check_output(['git', '-C', str(ROOT), 'status', '--porcelain', '--untracked-files=no'], text=True).strip():
        parser.error('Commit the exact test source before acceptance.')
    fixture, updates = args.fixture.resolve(), args.updates.resolve()
    image = fixture_identity(fixture, args.fixture_source)
    release = update_identity(updates, args.updates_source or source)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    receipt = {'status': 'running', 'test_source_commit': source,
               'image_source_commit': args.fixture_source, 'image_manifest_sha256': digest(fixture / 'manifest.json'),
               'update_fixture': release, 'update_manifest_sha256': digest(updates / 'fixture.json'),
               'started_at': time.time(), 'checks': [],
               'scope': 'Native ARM per-user runtime activation/rollback on private Fedora/Asahi VM',
               'limitations': ['No ARM product image, firmware provisioning or physical hardware test',
                               'No Fedora package update or boot recovery coverage',
                               'Private passwordless test account and local root console; never publish this disk']}
    machine = server = None
    with tempfile.TemporaryDirectory(prefix='harness-arm-updates-') as temporary:
        work = Path(temporary)
        try:
            disk = work / 'guest.raw'
            subprocess.run(['zstd', '-d', '--sparse', str(fixture / 'guest.raw.zst'), '-o', str(disk)],
                           check=True, timeout=180)
            if disk.stat().st_size != image['raw_disk']['bytes'] or digest(disk) != image['raw_disk']['sha256']:
                raise ValueError('Decompressed boot fixture changed.')
            served = work / 'served'
            served.mkdir()
            # Only this fixture's files are exposed on the local test server.
            shutil.copytree(updates, served / 'fast')
            server = ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory=str(served)))
            threading.Thread(target=server.serve_forever, daemon=True).start()
            machine = SessionVM(output / 'first-boot', disk, fixture / 'Image')
            machine.start()
            machine.wait_user('test -f ~/.local/state/harness-os/onboarded && pgrep -u 1000 -x opencode >/dev/null', 150)
            machine.frame('01-workspace', ['OpenCode', 'Ask anything'], 90)
            receipt['accelerator'] = machine.accelerator
            receipt['candidate_files'] = prepare_updates(machine)
            receipt['fast_updates'] = exercise(UserSession(machine), updates, f'http://10.0.2.2:{server.server_port}')
            # Capture identity independently of the staged manifest and probe
            # actual keyboard input before the private disk is discarded.
            state, _ = machine.user('harness updates status')
            (output / 'native-runtime-status.txt').write_text(state)
            machine.keyboard('after-updates')
            receipt['checks'].append('Shared activation, rollback, mouse, Super+u and surviving-work acceptance passed with real ARM binaries')
            receipt['shutdown'] = machine.poweroff()
            receipt['status'] = 'passed'
            print('Native ARM runtime update and surviving-work acceptance passed', flush=True)
        except BaseException as error:
            receipt.update(status='failed', error=str(error))
            failure_evidence(machine)
            raise
        finally:
            try:
                if machine:
                    machine.close()
                if server:
                    server.shutdown()
                    server.server_close()
            except (OSError, RuntimeError) as error:
                receipt.update(status='failed', cleanup_error=str(error))
                raise
            finally:
                receipt['finished_at'] = time.time()
                (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')


if __name__ == '__main__':
    main()
