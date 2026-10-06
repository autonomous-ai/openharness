"""Real dependency migration and session tools on the disposable update VM."""
import hashlib
import io
import json
from pathlib import Path
import re
import shlex
import struct
import tarfile
import time

from session_vm import installed_session


def required(bundle):
    manifest = json.loads((bundle / 'package-manifest.json').read_text())
    with tarfile.open(bundle / manifest['package']['name']) as archive:
        return any(re.fullmatch(r'depend = gtklock(?:[<>=].+)?', row)
                   for row in archive.extractfile('.PKGINFO').read().decode().splitlines())


def prepare(vm, manifest):
    """Prove failed downloads are harmless; then cache without installing tools."""
    bundle = '/home/me/update-bundle'
    package = bundle + '/' + manifest['package']['name']
    def state():
        vm.command('(pacman -Q harness-os && sha256sum /usr/share/harness-os/runtime.json '
                   '/usr/lib/harness/harness-tui /usr/share/harness-os/labwc/rc.xml) > /tmp/session-dependency-state')
        return vm.read_file('/tmp/session-dependency-state')

    def checkpoints():
        vm.command('sudo -n find /.snapshots -mindepth 1 -maxdepth 1 -type d | sort > /tmp/session-dependency-checkpoints')
        return vm.read_file('/tmp/session-dependency-checkpoints')

    before = state()
    _, installed = vm.command('pacman -Q gtklock', check=False)
    evidence = {'checks': [], 'missing_locker_exercised': installed != 0,
                'observer_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    if installed != 0:
        # This is a fresh published image. Neither an earlier package transaction
        # nor a prefilled download cache may conceal the regression.
        vm.command('test -z "$(find /var/cache/pacman/pkg -name \'gtklock-*.pkg.tar.*\' -print -quit)"')
        original_checkpoints = checkpoints()
        vm.command('sudo -n nmcli networking off')
        output, status = vm.command('sudo -n python3 ' + bundle + '/apply-update.py apply ' + bundle,
                                   timeout=120, check=False)
        (vm.folder / 'session-missing-dependency.log').write_text(output)
        assert status != 0, 'Uncached gtklock unexpectedly installed without networking'
        assert before == state(), 'Download failure changed the installed package'
        assert original_checkpoints == checkpoints(), 'Download failure created a recovery checkpoint'
        vm.command('sudo -n test ! -e /var/lib/harness-os/runtime-updates/latest.json && '
                   'test ! -e /run/harness-os-restart-required')
        evidence['checks'].append('Missing uncached gtklock refuses offline before package files, checkpoint, update receipt or restart state change')
        vm.command('sudo -n nmcli networking on && nm-online --quiet --timeout=30', timeout=40)
    output, _ = vm.command('sudo -n pacman --noconfirm -U --downloadonly ' + shlex.quote(package), timeout=180)
    (vm.folder / 'session-dependency-download.log').write_text(output)
    assert before == state(), 'Download-only preparation installed a package'
    if installed != 0:
        _, status = vm.command('pacman -Q gtklock', check=False)
        assert status != 0, 'Preparation installed gtklock instead of caching it'
    evidence['checks'].append('Pacman downloads and verifies declared dependencies online without installing them; following update/rollback runs offline using that cache')
    return evidence


def screenshots(vm, result):
    from PIL import Image

    def files():
        vm.command('find ~/Pictures/Screenshots -type f -name "*.png" '
                   '> /tmp/session-screenshots 2>/dev/null || true')
        return set(vm.read_file('/tmp/session-screenshots').decode().splitlines())

    def saved(before, name):
        deadline = time.monotonic() + 10
        raw = b''
        while True:
            added = files() - before
            assert len(added) <= 1, added
            if added:
                path = next(iter(added))
                raw = vm.read_file(path)
                # grim creates the file before rendering/encoding it. Existence
                # alone can return zero bytes or a partially written PNG.
                if raw.endswith(b'\x00\x00\x00\x00IEND\xaeB`\x82'):
                    break
            if time.monotonic() >= deadline:
                raise TimeoutError(f'Screenshot did not finish: {name}; files={added}; bytes={len(raw)}')
            time.sleep(.2)
        assert raw[:8] == b'\x89PNG\r\n\x1a\n'
        with Image.open(io.BytesIO(raw)) as capture:
            capture.verify()
        (vm.folder / (name + '.png')).write_bytes(raw)
        # Read the real Wayland clipboard from a real pane, whose environment
        # was inherited from the session; no fabricated DISPLAY value.
        target = '/tmp/' + name + '-clipboard.png'
        # Clipboard ownership is established after encoding; await that too,
        # without re-triggering capture or accepting the previous selection.
        command = ('for n in $(seq 1 50); do wl-paste --type image/png > ' + target + ' 2>/dev/null && '
                   'cmp -s ' + shlex.quote(path) + ' ' + target + ' && touch ' + target + '.done && exit 0; '
                   'sleep .1; done; exit 1')
        vm.command('hn new-window -n clipboard-check ' + shlex.quote(command))
        vm.command('for n in $(seq 1 60); do test -e ' + target + '.done && exit 0; sleep .1; done; exit 1')
        assert vm.read_file(target) == raw, 'Clipboard differs from the saved PNG'
        return struct.unpack('>II', raw[16:24])

    before = files()
    vm.screenshot('screenshot-full-before')
    with Image.open(vm.folder / 'screenshot-full-before.png') as frame:
        size = frame.size
    vm.keys('meta_l', 'p')
    assert saved(before, 'session-full-capture') == size
    result['checks'].append('Super+p captures the complete real display and copies the exact saved PNG to the Wayland clipboard')
    before = files()
    vm.keys('meta_l', 'r')
    vm.command('for n in $(seq 1 40); do pgrep -u 1000 -x slurp && exit 0; sleep .1; done; exit 1')
    vm.screenshot('screenshot-region-selection')
    with Image.open(vm.folder / 'screenshot-region-selection.png') as frame:
        width, height = frame.size

    def pointer(x, y):
        vm.monitor('input-send-event', events=[
            {'type': 'abs', 'data': {'axis': 'x', 'value': round(x / width * 32767)}},
            {'type': 'abs', 'data': {'axis': 'y', 'value': round(y / height * 32767)}},
        ])
        time.sleep(.2)

    pointer(width // 4, height // 4)
    vm.monitor('input-send-event', events=[{'type': 'btn', 'data': {'button': 'left', 'down': True}}])
    time.sleep(.2)
    pointer(width // 2, height // 2)
    vm.monitor('input-send-event', events=[{'type': 'btn', 'data': {'button': 'left', 'down': False}}])
    region = saved(before, 'session-region-capture')
    assert abs(region[0] - width // 4) <= 2 and abs(region[1] - height // 4) <= 2, region
    result['checks'].append('Super+r uses the real slurp selector; pointer drag saves only the selected region and copies identical PNG bytes')


def exercise(vm, config, result):
    output, _ = vm.command('pacman -Q gtklock grim slurp && pacman -Dk')
    (vm.folder / 'session-installed-dependencies.log').write_text(output)
    result['checks'].append('Upgraded package has gtklock/grim/slurp installed and pacman verifies dependency consistency')
    # Existing observer proves wrong-password refusal, isolation of lock input,
    # manual/idle lock and actual suspend/wake with the same terminal alive.
    installed_session(vm, config, result)
    screenshots(vm, result)
