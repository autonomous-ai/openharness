#!/usr/bin/env python3
"""T2 update acceptance, only on the disposable encrypted HN_OS_TEST disk."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def run(*args, check=True):
    result = subprocess.run(list(map(str, args)), text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, timeout=180)
    print(result.stdout, flush=True)
    if check and result.returncode:
        raise RuntimeError('Command failed: ' + repr(args))
    return result


def main():
    assert os.geteuid() == 0 and sys.platform == 'linux'
    assert subprocess.check_output(['lsblk', '-dn', '-o', 'SERIAL', '/dev/vda'], text=True).strip() == 'HN_OS_TEST'
    assert Path('/var/lib/harness-os/install.json').is_file() and not Path('/etc/harness-live').exists()
    action, folder = sys.argv[1], Path(sys.argv[2]).resolve()
    before, after = [json.loads((folder / (x + '.json')).read_text()) for x in ['before', 'after']]
    manifest = json.loads((folder / 'package-manifest.json').read_text())
    t2 = load('t2_update_fixture', folder / 't2_update.py')
    preservation = load('t2_preservation_fixture', folder / 't2_install_guest.py')
    updater = load('t2_runtime_fixture', folder / 'apply-update.py')
    system = updater.system_module()
    project = Path('/home/me/projects/t2-update-survivor')
    if action == 'baseline':
        for pin in [before, after]:
            name = pin['package']['filename']
            t2.KERNEL.inspect(folder / name, pin)
            shutil.copyfile(folder / name, Path('/var/cache/pacman/pkg') / name)
        baseline = folder / 'harness-os-0.1.0pre15.r1-1-x86_64.pkg.tar.gz'
        run('pacman', '--noconfirm', '-U', folder / before['package']['filename'], baseline)
        run('mkinitcpio', '-P')
        run('grub-mkconfig', '-o', '/boot/grub/grub.cfg')
        t2.verify(before, t2.KERNEL.inspect(folder / before['package']['filename'], before))
        return dict(status='passed', **preservation.verify())

    if action == 'verify-recovered':
        assert (project / 'work.txt').read_text() == 'newer work survives kernel recovery\n'
        assert run('pacman', '-Q', 'linux-t2').stdout.strip() == 'linux-t2 ' + before['package']['version']
        t2.verify(before, t2.KERNEL.inspect(folder / before['package']['filename'], before))
        return dict(status='passed', **preservation.verify())

    if action == 'rollback':
        latest = updater.latest()
        assert latest['status'] == 'applied' and latest['kernel_update']['candidate'] == after
        # No upstream cache or bundle kernel can rescue this rollback. It must
        # use the independently retained original package with the recorded hash.
        for pin in [before, after]:
            (Path('/var/cache/pacman/pkg') / pin['package']['filename']).unlink(missing_ok=True)
        run('python3', '/usr/lib/harness-os/runtime_update.py', 'rollback')
        assert updater.latest()['status'] == 'rolled-back'
        t2.verify(before, t2.KERNEL.inspect(folder / before['package']['filename'], before))
        return dict(status='passed', **preservation.verify())

    # A real user terminal keeps writing while root updates the kernel.
    run('runuser', '-u', 'me', '--', 'mkdir', '-p', project)
    script = project / 'heartbeat.py'
    script.write_text("import os,pathlib,time\np=pathlib.Path(__file__).parent\n(p/'pid').write_text(str(os.getpid()))\nwhile True:\n with (p/'heartbeat').open('a') as f:f.write('alive\\n')\n time.sleep(.2)\n")
    os.chown(script, 1000, 1000)
    (project / 'pid').unlink(missing_ok=True)
    run('runuser', '-u', 'me', '--', 'env', 'XDG_RUNTIME_DIR=/run/user/1000', 'hn',
        'new-window', '-n', 'kernel-survivor', 'python3 ' + str(script))
    for _ in range(100):
        if (project / 'pid').exists():
            break
        time.sleep(.1)
    pid = int((project / 'pid').read_text())
    process_start = Path(f'/proc/{pid}/stat').read_text().split()[21]
    hn_pid = subprocess.check_output(['pgrep', '-u', '1000', '-xo', 'hn|harness-tui'], text=True).strip()
    def alive():
        assert Path(f'/proc/{pid}/stat').read_text().split()[21] == process_start
        size = (project / 'heartbeat').stat().st_size
        time.sleep(.5)
        assert (project / 'heartbeat').stat().st_size > size
        assert subprocess.check_output(['pgrep', '-u', '1000', '-xo', 'hn|harness-tui'], text=True).strip() == hn_pid
    before_boot = system.boot_hashes(Path('/boot'))
    original = preservation.verify()

    if action == 'exercise':
        broken = folder / 'broken'
        broken.mkdir()
        for name in ['package-manifest.json', manifest['package']['name'], before['package']['filename']]:
            shutil.copyfile(folder / name, broken / name)
        (broken / after['package']['filename']).write_bytes(b'corrupt kernel fixture')
        prior = updater.latest()
        result = run('python3', folder / 'apply-update.py', 'apply', broken, check=False)
        assert result.returncode and 'pinned artifact' in result.stdout
        assert updater.latest() == prior and system.boot_hashes(Path('/boot')) == before_boot
        alive()
        hook = Path('/etc/pacman.d/hooks/00-t2-update-failure.hook')
        hook.write_text('[Trigger]\nOperation = Upgrade\nType = Package\nTarget = harness-os\n[Action]\nDescription = Disposable failure fixture\nWhen = PreTransaction\nExec = /usr/bin/false\nAbortOnFail\n')
        try:
            assert run('python3', folder / 'apply-update.py', 'apply', folder, check=False).returncode
        finally:
            hook.unlink()
        failed = updater.latest()
        assert failed['status'] == 'failed' and failed['kernel_update']['previous'] == before
        assert run('python3', folder / 'apply-update.py', 'apply', folder, check=False).returncode
        assert updater.latest() == failed
        run('python3', folder / 'apply-update.py', 'rollback')
        alive()

    # The installed public-channel implementation is unmodified. Only its
    # documented development feed points to this guest's private HTTP fixture.
    for pin in [before, after]:
        shutil.copyfile(folder / pin['package']['filename'], Path('/var/cache/pacman/pkg') / pin['package']['filename'])
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory=str(folder)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{server.server_port}/'
    def asset(name):
        path = folder / name
        return dict(url=url + name, **t2.KERNEL.identity(path))
    metadata = dict(schema=1, channel='preview', architecture='x86_64',
                    manifest=asset('package-manifest.json'), package=asset(manifest['package']['name']))
    (folder / 'metadata.json').write_text(json.dumps(metadata))
    try:
        started = time.monotonic()
        run('python3', '/usr/lib/harness-os/release_update.py', 'apply', '--feed', url + 'metadata.json')
        seconds = time.monotonic() - started
    finally:
        server.shutdown()
        server.server_close()
    alive()
    latest = updater.latest()
    assert latest['status'] == 'applied' and latest['kernel_update']['candidate'] == after
    assert run('pacman', '-Q', 'harness-os').stdout.strip() == 'harness-os ' + manifest['package']['version']
    assert json.loads(Path('/usr/share/harness-os/runtime.json').read_text()) == manifest['runtime']
    t2.verify(after, t2.KERNEL.inspect(folder / after['package']['filename'], after))
    assert preservation.verify()['firmware_sha256'] == original['firmware_sha256']
    (project / 'work.txt').write_text('newer work survives kernel recovery\n')
    return dict(status='passed', checkpoint=latest['checkpoint'], before_boot_sha256=before_boot,
                firmware_sha256=original['firmware_sha256'], apply_seconds=round(seconds, 3),
                survivor_pid=pid, survivor_start=process_start, harness_pid=hn_pid,
                kernel_update=latest['kernel_update'])


if __name__ == '__main__':
    print('T2_RESULT=' + json.dumps(main()), flush=True)
