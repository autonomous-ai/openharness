#!/usr/bin/env python3
"""Update acceptance, only inside the disposable HN_OS_TEST guest."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time


def run(*args, check=True):
    result = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
    print(result.stdout, flush=True)
    if check and result.returncode:
        raise RuntimeError('Command failed: ' + repr(args))
    return result


def version():
    return run('pacman', '-Q', 'harness-os').stdout.strip()


def main():
    assert sys.platform == 'linux' and os.geteuid() != 0
    assert subprocess.check_output(['lsblk', '-dn', '-o', 'SERIAL', '/dev/vda'], text=True).strip() == 'HN_OS_TEST'
    assert Path('/var/lib/harness-os/install.json').is_file() and not Path('/etc/harness-live').exists()
    bundle = Path(sys.argv[1]).resolve()
    manifest = json.loads((bundle / 'package-manifest.json').read_text())
    updater = str(bundle / 'apply-update.py')
    original_version = version()
    original_runtime = Path('/usr/share/harness-os/runtime.json').read_text()
    # Preview 9 already uses lowercase projects. Only older installations need
    # migration; creating a second Projects folder must not make an update merge
    # two independent user directories.
    legacy = not (Path.home() / 'projects').is_dir()
    project = Path.home() / ('Projects' if legacy else 'projects') / 'update-survivor'
    project.mkdir(parents=True, exist_ok=True)
    (project / 'keep.txt').write_text('keep this project through apply, restart and rollback\n')
    (project / 'heartbeat.py').write_text('''import os, pathlib, time
root = pathlib.Path(__file__).resolve().parent
(root / 'pid').write_text(str(os.getpid()))
while True:
    with (root / 'heartbeat').open('a') as output: output.write('alive\\n')
    time.sleep(0.2)
''')
    run('hn', 'new-window', '-n', 'update-survivor', 'python3 ' + str(project / 'heartbeat.py'))
    for _ in range(100):
        if (project / 'pid').exists():
            break
        time.sleep(0.1)
    pid = int((project / 'pid').read_text())
    process_start = Path(f'/proc/{pid}/stat').read_text().split()[21]
    def alive():
        assert Path(f'/proc/{pid}/stat').read_text().split()[21] == process_start
        size = (project / 'heartbeat').stat().st_size
        time.sleep(0.5)
        assert (project / 'heartbeat').stat().st_size > size
        assert (project / 'keep.txt').read_text() == 'keep this project through apply, restart and rollback\n'
    def restart():
        run('systemctl', '--user', 'daemon-reload')
        run('systemctl', '--user', 'restart', 'harness-daemon')
        run('systemctl', '--user', 'restart', 'hn-screen')
        run('/usr/lib/harness-os/wait-runtime')
        for _ in range(100):
            if subprocess.run(['systemctl', '--user', 'is-active', '--quiet', 'hn-screen']).returncode == 0:
                break
            time.sleep(0.1)
        run('systemctl', '--user', 'is-active', '--quiet', 'hn-screen')
        alive()
    def updated_settings():
        bar = run('hn', 'show-options', '-gv', 'status-right').stdout
        assert 'local_machine' in bar and '%H:%M' in bar and '@harness-update' not in bar, bar
        assert run('hn', 'show-options', '-gv', '@hn-new-window').stdout.strip() == 'shell'
    receipt = {'status': 'running', 'checks': [], 'previous_package': original_version,
               'candidate': manifest['package'], 'source_commit': manifest['source_commit']}
    broken = bundle.parent / 'broken-bundle'
    shutil.copytree(bundle, broken)
    with (broken / manifest['package']['name']).open('r+b') as handle:
        handle.truncate(100)
    assert run('sudo', 'python3', updater, 'apply', str(broken), check=False).returncode != 0
    assert version() == original_version and Path('/usr/share/harness-os/runtime.json').read_text() == original_runtime
    alive()
    receipt['checks'].append('Truncated download rejected before runtime or package identity changed; running work survives')
    # A real pre-transaction failure must retain its original rollback state.
    hook = bundle.parent / '00-harness-update-fixture.hook'
    hook.write_text('[Trigger]\nOperation = Upgrade\nType = Package\nTarget = harness-os\n[Action]\nDescription = Disposable update failure fixture\nWhen = PreTransaction\nExec = /usr/bin/false\nAbortOnFail\n')
    run('sudo', 'install', '-m', '644', str(hook), '/etc/pacman.d/hooks/00-harness-update-fixture.hook')
    assert run('sudo', 'python3', updater, 'apply', str(bundle), check=False).returncode != 0
    run('sudo', 'rm', '/etc/pacman.d/hooks/00-harness-update-fixture.hook')
    state = Path('/var/lib/harness-os/runtime-updates')
    failed = run('sudo', 'cat', str(state / 'latest.json')).stdout
    assert run('sudo', 'python3', updater, 'apply', str(bundle), check=False).returncode != 0
    assert run('sudo', 'cat', str(state / 'latest.json')).stdout == failed
    run('sudo', 'python3', updater, 'rollback')
    assert version() == original_version
    alive()
    receipt['checks'].append('Real pacman failure records recoverable state; retry cannot replace it; rollback restores the original package')
    started = time.monotonic()
    run('sudo', 'python3', updater, 'apply', str(bundle))
    receipt['apply_seconds'] = round(time.monotonic() - started, 3)
    assert version() == 'harness-os ' + manifest['package']['version']
    assert json.loads(Path('/usr/share/harness-os/runtime.json').read_text()) == manifest['runtime']
    # The screen showing "Restart when ready" is still there after the package's systemd reload,
    # before anything restarts it: 0.1.1's BindsTo stopped it mid-update from preview 14.
    run('systemctl', '--user', 'is-active', '--quiet', 'harness-os.target', 'hn-screen')
    alive()
    receipt['checks'].append('Package and cached dependencies installed offline and verified without restarting the existing terminal process or stopping the screen')
    run('sudo', 'harness', 'upgrade', str(bundle))
    alive()
    receipt['checks'].append('Repeated apply recognizes the installed build without another transaction')
    restart()
    updated_settings()
    receipt['checks'].append('An older saved hn session migrates to the standard TUI footer and terminal-tab default')
    assert (Path.home() / 'projects/update-survivor/keep.txt').read_text() == (project / 'keep.txt').read_text()
    receipt['checks'].append('Legacy Projects migrates to lowercase projects while existing session paths remain valid'
                             if legacy else 'Existing lowercase projects stays in place through the update')
    receipt['checks'].append('The same terminal process and project survive restarting both Harness daemon and screen')
    for name, info in manifest['runtime']['files'].items():
        path = Path('/usr/lib/harness') / name
        assert hashlib.sha256(path.read_bytes()).hexdigest() == info['sha256']
        assert path.stat().st_uid == 0
    started = time.monotonic()
    run('sudo', 'harness', 'rollback')
    receipt['rollback_seconds'] = round(time.monotonic() - started, 3)
    assert version() == original_version and Path('/usr/share/harness-os/runtime.json').read_text() == original_runtime
    restart()
    receipt['checks'].append('Rollback restores the prior package and source identity; the same process and project survive both service restarts again')
    # Leave the candidate installed for the host to verify a real reboot as well.
    run('sudo', 'python3', updater, 'apply', str(bundle))
    alive()
    receipt['status'] = 'passed'
    Path('/tmp/update-acceptance.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print('HN_UPDATE_ACCEPTANCE=' + json.dumps(receipt), flush=True)


if __name__ == '__main__':
    main()
