#!/usr/bin/env python3
"""Check the packaged Fedora session on the private 16 KiB ARM VM.

An immutable disposable boot fixture supplies its kernel, firmware and test
login. This checks the session RPM and user runtime, not an Apple installer.
"""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import threading
import time

from arm_boot import digest
from arm_session import ROOT, SessionVM, failure_evidence, fixture_identity
from arm_update_vm import UserSession, update_identity
from fast_update_vm import exercise
from graphical_session_vm import exercise as exercise_graphical_services
from fedora_package_lifecycle import identity
from session_vm import put


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture', type=Path, required=True)
    parser.add_argument('--fixture-source', required=True)
    parser.add_argument('--packages', type=Path, required=True, help='Verified first/ and upgrade/ package folders')
    parser.add_argument('--package-source', required=True)
    parser.add_argument('--updates', type=Path, required=True)
    parser.add_argument('--updates-source', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    source = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip()
    if subprocess.check_output(['git', '-C', str(ROOT), 'status', '--porcelain'], text=True).strip():
        parser.error('Commit the exact test source before native acceptance.')
    fixture, updates = args.fixture.resolve(), args.updates.resolve()
    image = fixture_identity(fixture, args.fixture_source)
    update = update_identity(updates, args.updates_source)
    first, initial = identity(args.packages / 'first', args.package_source, args.updates_source, update['runtime'])
    upgrade, final = identity(args.packages / 'upgrade', args.package_source, args.updates_source, update['runtime'])
    assert initial['package']['version'] == final['package']['version']
    assert str(initial['package']['release']) == '1' and str(final['package']['release']) == '2'
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    result = {'status': 'running', 'started_at': time.time(), 'test_source_commit': source,
              'image_source_commit': args.fixture_source, 'image_manifest_sha256': digest(fixture / 'manifest.json'),
              'packages': {'first': initial, 'upgrade': final}, 'update_fixture': update,
              'scope': 'RPM install/upgrade, native 16 KiB session and per-user runtime updates',
              'checks': [], 'limitations': ['Private VM test login; never publish this disk',
                  'No Apple firmware, hardware installer, Fedora base update or boot recovery proof',
                  'Saved terminals return after cold boot; automatic agent/conversation restoration is not tested']}
    machine = server = None
    with tempfile.TemporaryDirectory(prefix='harness-fedora-package-') as temporary:
        work = Path(temporary)
        try:
            disk = work / 'guest.raw'
            subprocess.run(['zstd', '-d', '--sparse', str(fixture / 'guest.raw.zst'), '-o', str(disk)],
                           check=True, timeout=180)
            assert disk.stat().st_size == image['raw_disk']['bytes'] and digest(disk) == image['raw_disk']['sha256']
            served = work / 'served'
            served.mkdir()
            shutil.copytree(updates, served / 'fast')
            for package in (first, upgrade):
                shutil.copy2(package, served / package.name)
            server = ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory=str(served)))
            threading.Thread(target=server.serve_forever, daemon=True).start()
            endpoint = f'http://10.0.2.2:{server.server_port}'
            machine = SessionVM(output / 'package-install', disk, fixture / 'Image')
            machine.start(offline=True)
            # Isolate the private update fixture before enabling networking.
            # A slow package transaction otherwise lets the normal timer stage
            # public releases before exercise() supplies its exact test feed.
            machine.wait_user('systemctl --user show-environment >/dev/null', 60)
            machine.user('systemctl --user mask --now harness-update.timer harness-update.service')
            machine.user('test ! -e ~/.local/state/harness-os/updates/ready.json && '
                         'test ! -e ~/.local/state/harness-os/updates/current')
            machine.monitor('set_link', name='hnnet', up=True)
            machine.wait_user('test -f ~/.local/state/harness-os/onboarded && pgrep -u 1000 -x opencode >/dev/null', 150)
            machine.user('mkdir -p ~/projects/package-preservation; printf %s keep-my-project '
                         '> ~/projects/package-preservation/proof.txt')
            process_probe = '''from pathlib import Path
import json, subprocess
def identity(pid):
    root=Path('/proc')/str(pid)
    return {'pid':pid, 'start_ticks':(root/'stat').read_text().rsplit(')',1)[1].split()[19]}
pids={'agent':int(subprocess.check_output(['pgrep','-o','-u','1000','-x','opencode'],text=True)),
      'daemon':int(subprocess.check_output(['systemctl','--user','show','harness-daemon','-p','MainPID','--value'],text=True))}
print(json.dumps({key:identity(value) for key,value in pids.items()},sort_keys=True))
'''
            put(machine, '/tmp/harness-package-processes.py', process_probe)
            before, _ = machine.user('python3 /tmp/harness-package-processes.py')
            # The serial transport surrounds command output with markers; save
            # the actual JSON line instead of comparing transport prompt bytes.
            process_line = next(line.strip() for line in before.splitlines() if line.strip().startswith('{'))
            for name, package, metadata in [('install', first, initial), ('upgrade', upgrade, final)]:
                destination = '/tmp/' + package.name
                machine.command('curl -fS --max-time 120 ' + shlex.quote(endpoint + '/' + package.name) +
                                ' -o ' + shlex.quote(destination), timeout=130)
                machine.command('printf %s ' + shlex.quote(metadata['package']['sha256'] + '  ' + destination + '\n') +
                                ' | sha256sum -c -')
                # The prepared image already has the signed Fedora dependencies;
                # the container lifecycle check covers repository provisioning.
                # This local transaction still checks dependencies, without an
                # unrelated mirror refresh delaying the live-process assertions.
                text, _ = machine.command('if command -v dnf5 >/dev/null; then '
                                          'manager=dnf5; repo_option="--disable-repo=*"; else '
                                          'manager=microdnf; repo_option="--disablerepo=*"; fi; '
                                          '"$manager" -y "$repo_option" '
                                          '--setopt=install_weak_deps=False --setopt=gpgcheck=True '
                                          '--setopt=localpkg_gpgcheck=False --nodocs install ' + shlex.quote(destination),
                                          timeout=180)
                (output / (name + '.log')).write_text(text)
                expected = '\t'.join(['harness-os-session', metadata['package']['version'],
                                      str(metadata['package']['release']), 'aarch64'])
                machine.command('test "$(rpm -q --qf ' + shlex.quote('%{NAME}\t%{VERSION}\t%{RELEASE}\t%{ARCH}') +
                                ' harness-os-session)" = ' + shlex.quote(expected))
                machine.command('rpm -V harness-os-session')
                after, _ = machine.user('python3 /tmp/harness-package-processes.py')
                assert process_line in [line.strip() for line in after.splitlines()], 'RPM restarted running work'
                machine.user('test "$(cat ~/projects/package-preservation/proof.txt)" = keep-my-project')
            result['checks'].append('Native RPM install and upgrade preserve the running agent/daemon process identities and project')
            result['first_shutdown'] = machine.poweroff()
            machine.close()
            machine = SessionVM(output / 'packaged-session', disk, fixture / 'Image')
            machine.start()
            machine.wait_user('systemctl --user is-active --quiet hn-screen harness-daemon', 150)
            machine.user('test "$(cat ~/projects/package-preservation/proof.txt)" = keep-my-project')
            machine.frame('01-packaged-workspace', 'me@harness', 60)
            machine.keyboard('packaged-fedora')
            # Saved terminal panes return after cold boot. The existing fixture
            # does not promise automatic agent/conversation restoration. Start
            # the agent through actual keyboard input and require its UI.
            machine.type_probe('cd /home/me/projects/package-preservation')
            machine.keys('ret')
            machine.type_probe('pwd')
            machine.keys('ret')
            machine.wait_user('hn capture-pane -p | grep -Fx /home/me/projects/package-preservation', 30)
            machine.type_probe('opencode')
            machine.keys('ret')
            machine.wait_user('pgrep -u 1000 -x opencode >/dev/null', 60)
            machine.frame('02-packaged-agent', ['OpenCode', 'Ask anything'], 90)
            result['graphical_services'] = exercise_graphical_services(machine)
            machine.command('rpm -V harness-os-session')
            runtime = json.loads(machine.read_file('/usr/share/harness-os/runtime.json'))
            assert runtime == final['runtime'], 'Boot did not use the RPM runtime identity'
            status, exit_status = machine.user('hn-os status', check=False)
            (output / 'system-status.txt').write_text(status)
            assert exit_status == 0 and 'fedora' in status.casefold() and 'Traceback' not in status
            for command in ['hn-os install', 'hn-os update', 'hn-os checkpoint', 'hn-os recover',
                            'harness install', 'harness upgrade', 'harness rollback']:
                text, exit_status = machine.user(command, check=False)
                assert exit_status != 0 and 'fedora' in text.casefold() and 'Traceback' not in text, \
                    'Unavailable platform action did not fail clearly: ' + command
                (output / (command.replace(' ', '-') + '.txt')).write_text(text)
            result['checks'].append('After a real reboot the packaged session renders, accepts QMP virtual keyboard input, explicitly starts OpenCode and reports Fedora without invoking absent PC helpers')
            # Only the test may grant unrestricted sudo for fault injection.
            # The RPM lifecycle separately requires all package files under /usr.
            put(machine, '/etc/sudoers.d/99-harness-update-test', 'me ALL=(ALL) NOPASSWD: ALL\n')
            machine.command('chmod 440 /etc/sudoers.d/99-harness-update-test; '
                            'visudo -cf /etc/sudoers.d/99-harness-update-test')
            machine.user('systemctl --user stop harness-update.timer harness-update.service; '
                         'systemctl --user unmask harness-update.timer harness-update.service; '
                         'systemctl --user daemon-reload')
            result['fast_updates'] = exercise(UserSession(machine), updates, endpoint)
            machine.keyboard('after-fedora-updates')
            result['checks'].append('The packaged user updater activates and rolls back real ARM binaries, preserving work and keyboard input')
            result['accelerator'] = machine.accelerator
            result['shutdown'] = machine.poweroff()
            result['status'] = 'passed'
        except BaseException as error:
            result.update(status='failed', error=str(error))
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
                result.update(status='failed', cleanup_error=str(error))
                raise
            finally:
                result['finished_at'] = time.time()
                (output / 'receipt.json').write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
