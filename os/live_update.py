#!/usr/bin/env python3
"""Stage ordinary hn/CLI releases for Harness OS without replacing OS-owned files.

The short-lived user timer downloads verified releases. Only an explicit action
switches the runtime and reconnects the screen; terminal owners remain alive.
The packaged runtime is always available as the offline fallback.
"""
from __future__ import annotations
import argparse
from contextlib import contextmanager
import curses
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlparse
from urllib.request import Request, urlopen

STATE = Path.home() / '.local/state/harness-os/updates'
BUNDLED = Path('/usr/lib/harness')
BASE_ID = Path('/usr/share/harness-os/runtime.json')
FEEDS = {
    'hn': 'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/tui/metadata.json',
    'cli': 'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/cli/metadata.json',
}
FILES = ('harness-tui', 'cli.mjs', 'notify.mjs')
LIMIT = 64 * 1024 * 1024
DOWNLOAD_CHUNK = 1024 * 1024
RESTART_REQUIRED = Path('/run/harness-os-restart-required')
KEEP_ON = 'Keep the computer on and plugged in until the system update finishes.'
SYSTEM_LOCK = Path('/run/lock/hn-os.lock')
BOOT_ID = Path('/proc/sys/kernel/random/boot_id')
PROC = Path('/proc')
WORKER_BUSY = '{"harness_update_worker":1,"status":"busy"}'
BUSY_EXIT = 75
WORDMARK = ('█ █ ▄▀█ █▀█ █▄ █ █▀▀ █▀ █▀', '█▀█ █▀█ █▀▄ █ ▀█ ██▄ ▄█ ▄█')


class UpdateBusy(ValueError):
    """Another operation owns a lock; no part of this attempt has started."""


class UpdateIntent:
    """One active screen's request; ordinary timer checks never consult it."""
    def __init__(self):
        self.pending = False
        self.retry_at = 0

    def clear(self):
        self.pending = False
        self.retry_at = 0


def version(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{1,8}\.\d{1,8}\.\d{1,8}', value):
        raise ValueError('Invalid release version.')
    return tuple(map(int, value.split('.')))


def digest(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def read(path, default=None):
    return json.loads(path.read_text()) if path.exists() else default


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write(path, data):
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as handle:
        temporary = Path(handle.name)
        try:
            json.dump(data, handle)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
            temporary.replace(path)
            sync_directory(path.parent)
        finally:
            temporary.unlink(missing_ok=True)


@contextmanager
def screen_registration():
    """Publish only an active Updates UI, not the rest of its process lifetime."""
    token = os.environ.get('HARNESS_UPDATE_INSTANCE', '')
    if re.fullmatch(r'[0-9a-f]{32}', token):
        (STATE / 'screens').mkdir(parents=True, exist_ok=True, mode=0o700)
        start = (PROC / str(os.getpid()) / 'stat').read_text().rsplit(')', 1)[1].split()[19]
        # Do not acquire open.lock here: the opener can be waiting for this
        # registration while serializing another simultaneous shortcut.
        write(STATE / 'screens' / str(os.getpid()), dict(
            pid=os.getpid(), start=start, token=token, boot_id=BOOT_ID.read_text().strip()))
    try:
        yield
    finally:
        unregister_screen()


def unregister_screen():
    (STATE / 'screens' / str(os.getpid())).unlink(missing_ok=True)


def request_for_screen():
    request = read(STATE / 'request.json', {})
    if not isinstance(request, dict) or 'requested_at' not in request:
        return False
    target = request.get('target')
    return target is None or (isinstance(target, str) and re.fullmatch(r'[0-9a-f]{32}', target) is not None
                              and target == os.environ.get('HARNESS_UPDATE_INSTANCE'))


def consume_request():
    # Match and claim together: another client must not replace the request
    # between our read and unlink. The opener uses this same handoff lock.
    with (STATE / 'open.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not request_for_screen():
            return False
        (STATE / 'request.json').unlink()
        return True


def close_screen():
    # Serialize the final close decision with Super+u's request and selection.
    # A request arriving after the last UI poll must be handled, not abandoned
    # while this Python process is still alive in curses cleanup.
    with (STATE / 'open.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if request_for_screen():
            return False
        unregister_screen()
        return True


@contextmanager
def locked():
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (STATE / 'lock').open('a') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise UpdateBusy('An update is already in progress.') from error
        # OS package replacement and fast activation cannot run concurrently.
        # The root-owned file is created by tmpfiles before the user session.
        system_lock = SYSTEM_LOCK.open('r') if SYSTEM_LOCK.exists() else None
        try:
            if system_lock:
                try:
                    fcntl.flock(system_lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
                except BlockingIOError as error:
                    raise UpdateBusy('A system update is in progress. Try again when it finishes.') from error
            yield
        finally:
            if system_lock:
                system_lock.close()


def system_channel():
    # Fedora supplies its own base-system lifecycle. A stale user cache must not
    # offer the PC updater, and an absent PC helper is not a failed runtime check.
    if read(BASE_ID, {}).get('system_profile', 'arch') != 'arch':
        return {'supported': False, 'available': False}
    return read(STATE / 'system.json', {})


def check_system(force=False):
    cached = system_channel()
    if cached.get('supported') is False:
        write(STATE / 'system.json', dict(cached, checked_at=time.time()))
        return cached
    if not force and time.time() - cached.get('checked_at', 0) < 86400:
        return cached
    try:
        spec = importlib.util.spec_from_file_location('harness_os_release_update', Path(__file__).with_name('release_update.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        release = module.discover()
        cached = {'checked_at': time.time(), 'available': bool(release and release['available']),
                  'version': release['version'] if release else None}
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError) as error:
        # An unavailable system channel must not hold up an independent hn fix.
        cached = {'checked_at': time.time(), 'available': False, 'error': str(error)}
    write(STATE / 'system.json', cached)
    return cached


def allowed_url(value):
    if not isinstance(value, str):
        raise ValueError('Invalid download address.')
    parsed = urlparse(value)
    # Loopback is useful for developer fixtures; production feeds are HTTPS.
    if parsed.username or parsed.password or not parsed.hostname or not (
        parsed.scheme == 'https' or
        parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1', '::1')
    ):
        raise ValueError('Updates require HTTPS.')
    return value


@contextmanager
def download_response(url, limit):
    request = Request(allowed_url(url), headers={'User-Agent': 'Harness-Updates/1'})
    with urlopen(request, timeout=20) as response:
        allowed_url(response.url)
        size = response.headers.get('Content-Length')
        if size and (not size.isdigit() or int(size) > limit):
            raise ValueError('Update exceeds its download size limit.')
        yield response


def fetch(url, limit):
    with download_response(url, limit) as response:
        data = response.read(limit + 1)
        if len(data) > limit:
            raise ValueError('Update exceeds its download size limit.')
        return data


def download(ref, destination):
    """Keep release bytes on disk while the installed workspace remains active."""
    limit = ref.get('size') or LIMIT
    size, checksum = 0, hashlib.sha256()
    created = False
    try:
        with download_response(ref['url'], limit) as response, destination.open('xb') as handle:
            created = True
            while chunk := response.read(min(DOWNLOAD_CHUNK, limit + 1 - size)):
                size += len(chunk)
                if size > limit:
                    raise ValueError('Update exceeds its download size limit.')
                checksum.update(chunk)
                handle.write(chunk)
        if checksum.hexdigest() != ref['sha256'].lower() or (
            ref.get('size') is not None and size != ref['size']
        ):
            raise ValueError('Download checksum or size does not match the release.')
    except BaseException:
        if created:
            destination.unlink(missing_ok=True)
        raise


def runtime_platform():
    """Match the public hn release keys to the native Linux executable format."""
    machine = platform.machine()
    targets = {'x86_64': ('linux-x64', 62), 'aarch64': ('linux-arm64', 183)}
    if platform.system() != 'Linux' or machine not in targets:
        raise ValueError('Harness runtime updates require x86-64 or ARM64 Linux.')
    return targets[machine]


def verify_hn(data):
    target, machine = runtime_platform()
    # Check before executing even a version probe: binfmt/emulation can make a
    # binary for the wrong CPU appear usable. Releases use 64-bit little-endian
    # ELF executables (ET_EXEC or ET_DYN), never scripts or native Mac binaries.
    if (len(data) < 64 or data[:7] != b'\x7fELF\x02\x01\x01' or
            int.from_bytes(data[16:18], 'little') not in (2, 3) or
            int.from_bytes(data[18:20], 'little') != machine or
            int.from_bytes(data[20:24], 'little') != 1):
        raise ValueError(f'The hn build does not match this computer ({target}).')


def release(feed, component):
    meta = json.loads(fetch(feed, 65536))
    if not isinstance(meta, dict):
        raise ValueError('Invalid release manifest.')
    if component == 'hn':
        builds = meta.get('builds')
        if not isinstance(builds, dict):
            raise ValueError('Invalid hn release manifest.')
        target, _ = runtime_platform()
        if target not in builds:
            raise ValueError(f'No hn build is available for {target}.')
        value, refs = meta.get('version'), {'harness-tui': builds[target]}
    else:
        entry = meta.get('cli', {})
        if not isinstance(entry, dict):
            raise ValueError('Invalid Harness release manifest.')
        value, refs = entry.get('version'), {'cli.mjs': entry.get('cli'), 'notify.mjs': entry.get('notify')}
    version(value)
    for ref in refs.values():
        if not isinstance(ref, dict) or not re.fullmatch(r'[a-fA-F0-9]{64}', str(ref.get('sha256', ''))):
            raise ValueError('Release is missing its checksum.')
        allowed_url(ref.get('url'))
        size = ref.get('size')
        if size is not None and (type(size) is not int or not 0 < size <= LIMIT):
            raise ValueError('Invalid release size.')
    return value, refs


def run(*args, timeout=45, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, text=True,
                          capture_output=True, timeout=timeout, **kwargs).stdout.strip()


def versions(folder):
    # Version probes do not open a terminal, start a daemon or require a network.
    with (folder / 'harness-tui').open('rb') as handle:
        verify_hn(handle.read(64))
    hn = run(folder / 'harness-tui', '--version', env=dict(os.environ, HN_AS_TMUX='0'))
    match = re.fullmatch(r'hn (\d+\.\d+\.\d+)(?: \(tmux [^\r\n]+\))?', hn)
    if not match:
        raise ValueError('The hn build did not pass its version check.')
    cli = run('/usr/bin/node', folder / 'cli.mjs', 'version')
    version(cli)
    return {'hn': match[1], 'cli': cli}


def selected():
    pointer = STATE / 'current'
    if not pointer.exists():
        return BUNDLED
    path = pointer.resolve()
    if path.parent != (STATE / 'builds').resolve():
        raise ValueError('Invalid selected runtime; use the packaged runtime to recover.')
    if not (path / 'base.json').is_file() or (path / 'base.json').read_bytes() != BASE_ID.read_bytes():
        return BUNDLED
    return path


def verify(folder):
    record = read(folder / 'release.json')
    if not record or set(record.get('files', {})) != set(FILES):
        raise ValueError('The prepared update is incomplete.')
    for name, info in record['files'].items():
        path = folder / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size != info['bytes'] or digest(path) != info['sha256']:
            raise ValueError('The prepared update failed verification. Check for updates again.')
    if versions(folder) != record['versions']:
        raise ValueError('The prepared update version changed.')
    return record


def prepared():
    record = read(STATE / 'ready.json')
    if not record:
        return None
    identity = record.get('id', '')
    if not re.fullmatch(r'[a-f0-9]{64}', identity):
        raise ValueError('Invalid prepared update.')
    folder = STATE / 'builds' / identity
    if not (folder / 'base.json').is_file() or (folder / 'base.json').read_bytes() != BASE_ID.read_bytes():
        return None
    return folder


def notice(message):
    # Retained for an explicitly customized footer; the OS uses hn's standard bar.
    try:
        run('/usr/bin/hn', 'set-option', '-g', '@harness-update', message)
    except (OSError, subprocess.SubprocessError):
        pass  # A stopped screen will receive the notice on the next check.


def prune():
    # Retain only the active, previous and ready builds. Check/apply own the lock,
    # so a half-download here can only be left by an interrupted earlier check.
    keep = {path.resolve() for path in (selected(), prepared()) if path is not None}
    pointer = STATE / 'current'
    if pointer.is_symlink():
        # A newly installed OS package changes base.json before the old session
        # exits. Keep its files until its raw selection is actually replaced.
        keep.add(pointer.resolve())
    receipt = read(STATE / 'applied.json', {})
    if receipt.get('previous'):
        keep.add(Path(receipt['previous']).resolve())
    transaction = read(STATE / 'transaction.json', {})
    if transaction.get('status') == 'applying' and transaction.get('previous'):
        keep.add(Path(transaction['previous']).resolve())
    folder = STATE / 'builds'
    if folder.exists():
        for path in folder.iterdir():
            if path.resolve() not in keep and not path.is_symlink() and path.is_dir() and (
                re.fullmatch(r'[a-f0-9]{64}', path.name) or path.name.startswith('.download-')
            ):
                shutil.rmtree(path)


def check(feeds=None, progress=lambda _: None, force_system=False):
    with locked():
        if RESTART_REQUIRED.exists():
            notice(('Restart ready' if read(RESTART_REQUIRED, {}).get('status') == 'ready' else 'System update needs attention') + ' · Super+u')
            return False
        recover_interrupted()
        current = selected()
        running = versions(current)
        ready = prepared()
        if ready and ready != current:
            try:
                verify(ready)
            except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError):
                # An interrupted or damaged staged build must be downloadable
                # again. Keep the active runtime untouched while checking feeds.
                (STATE / 'ready.json').unlink(missing_ok=True)
                ready = None
        base = ready if ready and ready.exists() else current
        base_versions = verify(base)['versions'] if base != BUNDLED else running
        # The OS is built from source, where the CLI can still call itself 0.0.1.
        # Releases whose tagged commits are already ancestors of that source are
        # older, even if their public version number is numerically higher.
        baselines = read(BASE_ID, {}).get('release_baselines', {})
        target_versions, errors = dict(base_versions), []
        ignored = read(STATE / 'ignored.json', {})
        builds = STATE / 'builds'
        builds.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='.download-', dir=builds) as temp:
            folder, changes = Path(temp), set()
            for component, url in (feeds or FEEDS).items():
                try:
                    candidate, refs = release(url, component)
                    if ignored.get(component) == candidate:
                        continue
                    baseline = baselines.get(component, {}).get('version', '0.0.0')
                    if version(candidate) > max(version(base_versions[component]), version(baseline)):
                        progress('Downloading hn…' if component == 'hn' else 'Downloading Harness…')
                        component_files = set()
                        for name, ref in refs.items():
                            download(ref, folder / name)
                            if name == 'harness-tui':
                                with (folder / name).open('rb') as handle:
                                    verify_hn(handle.read(64))
                            component_files.add(name)
                        changes.update(component_files)
                        target_versions[component] = candidate
                except (ValueError, OSError, KeyError, TypeError) as error:
                    errors.append(f'{component}: {error}')
            # Publish only complete components. A failed CLI pair is overwritten
            # from the base before an independent hn update can become ready.
            if changes:
                for name in FILES:
                    if name not in changes:
                        shutil.copyfile(base / name, folder / name)
                    (folder / name).chmod(0o755 if name == 'harness-tui' else 0o644)
                    with (folder / name).open('rb') as handle:
                        os.fsync(handle.fileno())
                (folder / 'hn').symlink_to('harness-tui')
                shutil.copyfile(BASE_ID, folder / 'base.json')
                with (folder / 'base.json').open('rb') as handle:
                    os.fsync(handle.fileno())
                record = {'versions': target_versions, 'files': {name: {
                    'sha256': digest(folder / name), 'bytes': (folder / name).stat().st_size
                } for name in FILES}}
                write(folder / 'release.json', record)
                verify(folder)
                identity = hashlib.sha256(json.dumps(record, sort_keys=True).encode() + BASE_ID.read_bytes()).hexdigest()
                ready = builds / identity
                if ready.exists() and ready != current:
                    try:
                        verify(ready)
                    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError):
                        # This owned, inactive build failed verification. Replace
                        # it with the complete, independently verified download.
                        shutil.rmtree(ready)
                if not ready.exists():
                    # TemporaryDirectory can safely clean its now-missing old name.
                    folder.rename(ready)
                    sync_directory(builds)
                write(STATE / 'ready.json', {'id': identity})
        write(STATE / 'check.json', {'checked_at': time.time(), 'errors': errors})
        available = ready is not None and ready != current
        system = check_system(force_system) if feeds is None else {}
        notice('Update ready · Super+u' if available or system.get('available') else '')
        prune()
        if errors and not available and not system.get('available'):
            raise ValueError('Could not check for updates. Connect to the internet and try again.')
        return available


def select(folder):
    pointer = STATE / 'current'
    if folder == BUNDLED:
        pointer.unlink(missing_ok=True)
        sync_directory(STATE)
        return
    temporary = STATE / '.current-next'
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(folder.relative_to(STATE))
    temporary.replace(pointer)
    sync_directory(STATE)


def restart(cli_changed):
    if cli_changed:
        run('systemctl', '--user', 'restart', 'harness-daemon.service', timeout=180)
        run('/usr/lib/harness-os/wait-runtime')
    # The terminal surface is separate from the processes that own agent PTYs.
    run('systemctl', '--user', 'restart', 'hn-screen.service')
    run('systemctl', '--user', 'is-active', '--quiet', 'hn-screen.service')


def capture_view():
    """Remember the OS screen, without selecting an unrelated SSH client."""
    try:
        rows = run('/usr/bin/hn', 'list-clients', '-F',
                   '#{client_pid}\t#{session_id}\t#{window_id}\t#{pane_id}\t#{client_tty}', timeout=3)
        for row in rows.splitlines():
            parts = row.split('\t')
            if len(parts) != 5 or not parts[0].isdigit():
                continue
            groups = Path('/proc') / parts[0] / 'cgroup'
            try:
                belongs = any(line.split(':', 2)[-1].endswith('/hn-screen.service')
                              for line in groups.read_text().splitlines())
            except OSError:
                continue
            if not belongs:
                continue
            if all(re.fullmatch(pattern, value) for pattern, value in
                   zip([r'\$\d+', r'@\d+', r'%\d+', r'/dev/pts/\d+'], parts[1:])):
                return dict(zip(['session', 'window', 'pane', 'tty'], parts[1:]))
    except (OSError, subprocess.SubprocessError):
        pass
    return None


def restore_view(view):
    if view is None:
        return
    for name, pattern in [('session', r'\$\d+'), ('window', r'@\d+'), ('pane', r'%\d+')]:
        if not isinstance(view, dict) or not isinstance(view.get(name), str) or not re.fullmatch(pattern, view[name]):
            raise ValueError('Invalid saved Harness screen selection.')
    # A task may finish while the screen reconnects. Restore only objects that
    # still exist, without resurrecting a closed terminal or creating a session.
    sessions = run('/usr/bin/hn', 'list-sessions', '-F', '#{session_id}').splitlines()
    if view['session'] not in sessions:
        return
    current = capture_view()
    if current is None:
        return
    run('/usr/bin/hn', 'switch-client', '-c', current['tty'], '-t', view['session'])
    windows = run('/usr/bin/hn', 'list-windows', '-t', view['session'], '-F', '#{window_id}').splitlines()
    if view['window'] in windows:
        run('/usr/bin/hn', 'select-window', '-t', view['window'])
        panes = run('/usr/bin/hn', 'list-panes', '-t', view['window'], '-F', '#{pane_id}').splitlines()
        if view['pane'] in panes:
            run('/usr/bin/hn', 'select-pane', '-t', view['pane'])


def screen_ready(target):
    """Wait for an attached client executing the selected binary, not just foot."""
    deadline = time.monotonic() + 30
    observed = {}
    while time.monotonic() < deadline:
        try:
            # list-clients deliberately includes the backing tmux connections.
            # hn-list-clients identifies hn's own rendering clients instead.
            clients = run('/usr/bin/hn', 'hn-list-clients', '-F', '#{client_pid}', timeout=3)
            for pid in clients.splitlines():
                if pid.isdigit():
                    executable = Path('/proc') / pid / 'exe'
                    observed[pid] = str(executable.resolve())
                    if executable.samefile(target / 'harness-tui'):
                        write(STATE / 'screen.json', {'pid': int(pid), 'executable': observed[pid], 'target': str(target)})
                        return
        except (OSError, subprocess.SubprocessError):
            pass
        time.sleep(.25)
    write(STATE / 'screen.json', {'target': str(target), 'observed': observed, 'status': 'failed'})
    raise ValueError('The new hn screen did not become ready. Restoring the previous build.')


def recovery_target(value):
    target = Path(value)
    if target == BUNDLED:
        return target
    if target.parent.resolve() != (STATE / 'builds').resolve() or not re.fullmatch(r'[a-f0-9]{64}', target.name):
        raise ValueError('Invalid runtime recovery path.')
    if (target / 'base.json').read_bytes() != BASE_ID.read_bytes():
        return BUNDLED
    verify(target)
    return target


def recover_interrupted():
    transaction = read(STATE / 'transaction.json', {})
    if transaction.get('status') != 'applying':
        return
    previous = recovery_target(transaction['previous'])
    select(previous)
    # Holding the update lock proves the previous activation is no longer alive.
    # Restore its known runtime even if a power cut lost its final receipt.
    restart(True)
    screen_ready(previous)
    restore_view(transaction.get('view'))
    write(STATE / 'transaction.json', {'status': 'interrupted', 'previous': str(previous)})


def apply(rollback=False):
    with locked():
        if RESTART_REQUIRED.exists():
            raise ValueError('Restart to finish the system update before changing hn.')
        recover_interrupted()
        previous = selected()
        receipt = read(STATE / 'applied.json', {})
        target = (Path(receipt['previous']) if rollback and receipt.get('previous') else None) if rollback else prepared()
        if target is None or target == previous:
            raise ValueError('No update to roll back.' if rollback else 'Harness is up to date.')
        if target != BUNDLED:
            if target.parent.resolve() != (STATE / 'builds').resolve() or not re.fullmatch(r'[a-f0-9]{64}', target.name):
                raise ValueError('Invalid runtime recovery path.')
            if (target / 'base.json').read_bytes() != BASE_ID.read_bytes():
                raise ValueError('That runtime belongs to an earlier OS package.')
            candidate = verify(target)['versions']
        else:
            candidate = versions(BUNDLED)
        old = versions(previous)
        view = capture_view()
        write(STATE / 'transaction.json', {'previous': str(previous), 'target': str(target), 'status': 'applying', 'view': view})
        select(target)
        try:
            restart(candidate['cli'] != old['cli'])
            screen_ready(target)
            restore_view(view)
        except BaseException:
            select(previous)
            write(STATE / 'transaction.json', {'status': 'failed', 'previous': str(previous)})
            restart(candidate['cli'] != old['cli'])
            screen_ready(previous)
            restore_view(view)
            notice('Update failed · Super+u')
            raise
        write(STATE / 'applied.json', {'previous': str(previous), 'current': str(target), 'at': time.time()})
        if rollback:
            write(STATE / 'ignored.json', old)
        write(STATE / 'transaction.json', {'status': 'applied'})
        (STATE / 'ready.json').unlink(missing_ok=True)
        notice('')
        prune()


def finish_approved_update():
    """Finish one explicitly approved update after its OS package reboot.

    A new OS base must prepare its own compatible runtime before activation.
    Ordinary timer checks still only download; this receipt is written solely
    after an update request and a successful privileged update, and is consumed once.
    """
    approval = read(STATE / 'approved.json', {})
    if approval.get('status') != 'after-reboot' or RESTART_REQUIRED.exists():
        return
    if approval.get('boot_id') == BOOT_ID.read_text().strip():
        return
    try:
        if approval.get('base_sha256') != digest(BASE_ID):
            raise ValueError('The system changed since this update. Open Updates to check again.')
        ready = prepared()
        if ready and ready != selected():
            apply()
        if read(STATE / 'check.json', {}).get('errors') or read(STATE / 'system.json', {}).get('error'):
            raise ValueError('Some updates could not be checked. Open Updates to try again.')
        (STATE / 'approved.json').unlink(missing_ok=True)
    except UpdateBusy:
        # This approval already survived a real reboot and its base check. A
        # competing check has not attempted activation or invalidated it.
        return
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        write(STATE / 'approved.json', dict(approval, status='failed', error=str(error)))
        notice('Update needs attention · Super+u')
        raise


def update_all():
    """One user decision; root still verifies its own official release assets."""
    if RESTART_REQUIRED.exists():
        raise ValueError('Restart when ready to finish the update.')
    if system_channel().get('available'):
        # Do not reconnect an old session using a new OS package. Its included
        # runtime takes effect on reboot; finish any independent public release
        # against that new base afterward, under this same explicit approval.
        # The one stretch where turning the computer off leaves it to recovery: say so first.
        print(KEEP_ON, flush=True)
        subprocess.run(['sudo', '-n', '/usr/bin/harness', 'upgrade'], check=True)
        (STATE / 'system.json').unlink(missing_ok=True)
        if read(RESTART_REQUIRED, {}).get('status') == 'ready':
            write(STATE / 'approved.json', dict(status='after-reboot',
                boot_id=BOOT_ID.read_text().strip(), base_sha256=digest(BASE_ID)))
            return
    ready = prepared()
    if ready and ready != selected():
        # The unit survives reconnecting the screen. The Updates terminal
        # process waits for its real result and survives with the other panes.
        try:
            run('systemd-run', '--user', '--quiet', '--pipe', '--wait', '--collect', '--unit=harness-apply-update',
                '/usr/bin/python3', '/usr/lib/harness-os/live_update.py', 'apply', '--worker',
                stdin=subprocess.DEVNULL, timeout=240)
        except subprocess.CalledProcessError as error:
            # --wait propagates the worker's status; --pipe carries its exact
            # result. A unit startup failure or an arbitrary exit 75 is not Busy.
            if error.returncode == BUSY_EXIT and error.stdout == WORKER_BUSY + '\n':
                raise UpdateBusy('An update is already in progress.') from error
            raise
    (STATE / 'approved.json').unlink(missing_ok=True)


def screen(window, message='', refresh=False, intent=None):
    intent = intent if intent is not None else UpdateIntent()
    curses.curs_set(0)
    window.keypad(True)
    window.timeout(500)
    curses.mousemask(curses.ALL_MOUSE_EVENTS)
    curses.mouseinterval(150)
    choice = 0
    targets = []
    accent = curses.A_BOLD
    try:
        if curses.has_colors():
            curses.start_color()
            curses.use_default_colors()
            curses.init_pair(1, curses.COLOR_YELLOW, -1)
            accent |= curses.color_pair(1)
    except curses.error:
        pass

    def draw(status=''):
        window.erase()
        height, width = window.getmaxyx()
        ready = prepared()
        available = (ready is not None and ready != selected()) or system_channel().get('available')
        checked = read(STATE / 'check.json', {})
        system_state = read(RESTART_REQUIRED, {}).get('status')
        errors = checked.get('errors') or system_channel().get('error') or read(STATE / 'approved.json', {}).get('status') == 'failed'
        if system_state == 'failed':
            title, choices = 'The update needs recovery.', [('Restore', 'restore-system'), ('Back', None)]
        elif system_state == 'ready':
            title, choices = 'Updated. Restart when ready.', [('Done', None), ('Restart', 'reboot')]
        elif system_state:
            title, choices = 'The system is updating…', [('Back', None)]
        elif intent.retry_at:
            title, choices = 'Waiting for the current update…', [('Back', None)]
        elif available:
            title, choices = 'Update available.', [('Update', 'update')]
        elif errors or message:
            title, choices = 'Could not finish checking for updates.', [('Retry', 'check'), ('Back', None)]
        else:
            title, choices = 'Harness is up to date.', [('Done', None)]
        lines = [*WORDMARK, '', '', status or title]
        if system_state == 'applying' and not status:
            lines += ['', KEEP_ON]
        if message and not status:
            lines += ['', message]
        top = max(0, (height - len(lines) - 4) // 2)
        for index, line in enumerate(lines):
            if top + index < height - 1:
                left = max(0, (width - len(line)) // 2)
                window.addnstr(top + index, left, line, max(0, width - left - 1), accent if index < 2 else 0)
        labels = ['[ ' + label + ' ]' for label, _ in choices]
        left = max(0, (width - sum(map(len, labels)) - 4 * (len(labels) - 1)) // 2)
        row = top + len(lines) + 2
        targets.clear()
        if row < height - 1 and not status:
            for index, label in enumerate(labels):
                window.addnstr(row, left, label, max(0, width - left - 1),
                               curses.A_REVERSE if index == choice % len(choices) else 0)
                targets.append((row, left, min(width - 1, left + len(label)), choices[index][1]))
                left += len(label) + 4
        window.refresh()
        return choices

    def refresh_releases():
        check(progress=draw, force_system=True)
        # An explicit retry supersedes a failed post-reboot request. Otherwise
        # even a successful recheck with nothing left to apply stays on Retry.
        if read(STATE / 'approved.json', {}).get('status') == 'failed':
            (STATE / 'approved.json').unlink(missing_ok=True)

    while True:
        if consume_request():
            # Acknowledge handoff to this screen, not completion of the update.
            # Keep the intent through both check and transient-worker contention.
            intent.pending = True
        if RESTART_REQUIRED.exists():
            intent.clear()
            refresh = False
        elif (refresh or intent.pending) and time.monotonic() >= intent.retry_at:
            try:
                ready = prepared()
                available = (ready and ready != selected()) or system_channel().get('available')
                if not (intent.pending and available):
                    draw('Checking for updates…')
                    refresh_releases()
                    ready = prepared()
                    available = (ready and ready != selected()) or system_channel().get('available')
                message, refresh = '', False
                intent.retry_at = 0
                if intent.pending and available:
                    # Stay cancellable here instead of launching a failed unit
                    # every poll during a long download. The worker still owns
                    # acquisition and reports a race after this advisory probe.
                    with locked():
                        pass
                    return 'update'
                intent.clear()
            except UpdateBusy:
                intent.retry_at = time.monotonic() + .5
            except (ValueError, OSError, subprocess.SubprocessError) as error:
                message, refresh = str(error), False
                intent.clear()
        choices = draw()
        key = window.getch()
        if key in (27, ord('q')):
            if close_screen():
                intent.clear()
                return
        if key in (9, curses.KEY_BTAB, curses.KEY_LEFT, curses.KEY_RIGHT):
            choice = (choice + 1) % len(choices)
        elif key in (10, 13, curses.KEY_ENTER):
            action = choices[choice % len(choices)][1]
            if action is not None or close_screen():
                if action is None:
                    intent.clear()
                return action
        elif key == curses.KEY_MOUSE:
            try:
                _, x, y, _, buttons = curses.getmouse()
                if buttons & (curses.BUTTON1_CLICKED | curses.BUTTON1_RELEASED):
                    for row, left, right, action in targets:
                        if y == row and left <= x < right:
                            if action is not None or close_screen():
                                if action is None:
                                    intent.clear()
                                return action
            except curses.error:
                pass


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['check', 'screen', 'request', 'apply', 'rollback', 'status'], nargs='?', default='screen')
    parser.add_argument('--feeds', type=Path, help='Explicit developer feed map; never used by the installed timer')
    parser.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.worker and args.action != 'apply':
        parser.error('--worker is only valid for apply')
    if os.geteuid() == 0 or Path('/etc/harness-live').exists():
        parser.error('Open Updates as your normal user on an installed Harness system.')
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.action == 'request':
        target = os.environ.get('HARNESS_UPDATE_TARGET')
        request = {'requested_at': time.time()}
        if target is not None:
            if not re.fullmatch(r'[0-9a-f]{32}', target):
                raise ValueError('Invalid Updates screen target.')
            # Private opener handoff already holds open.lock while waiting for
            # this child. Taking it again here would deadlock startup.
            write(STATE / 'request.json', dict(request, target=target))
        else:
            with (STATE / 'open.lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                write(STATE / 'request.json', request)
    elif args.action == 'check':
        check(read(args.feeds) if args.feeds else None)
        finish_approved_update()
    elif args.action == 'screen':
        with screen_registration():
            run_screen()
    elif args.action in ('apply', 'rollback'):
        try:
            apply(rollback=args.action == 'rollback')
        except UpdateBusy:
            if not args.worker:
                raise
            print(WORKER_BUSY, flush=True)
            return BUSY_EXIT
    else:
        print(json.dumps({'runtime': str(selected()), 'versions': versions(selected()),
                          'ready': str(prepared()) if prepared() else None,
                          'restart_required': RESTART_REQUIRED.exists(),
                          'system': system_channel(), 'check': read(STATE / 'check.json')}, indent=2))


def run_screen():
    message = ''
    intent = UpdateIntent()
    # A prepared release can be applied immediately. Otherwise check now
    # instead of exposing another command or making the user wait for a timer.
    refresh = not (prepared() or system_channel().get('available'))
    while True:
        action = curses.wrapper(screen, message, refresh, intent)
        if action is None:
            break
        message, refresh = '', action == 'check'
        try:
            if action == 'check':
                # Retry means finish updating, without another confirmation
                # after the connection or release has recovered.
                intent.pending = True
            if action == 'reboot':
                subprocess.run(['systemctl', 'reboot'], check=True)
                break
            if action == 'update':
                intent.pending = True
                print('Updating Harness… Your agents keep running.', flush=True)
                update_all()
                intent.clear()
            elif action == 'restore-system':
                subprocess.run(['sudo', '-n', '/usr/bin/harness', 'rollback'], check=True)
                (STATE / 'system.json').unlink(missing_ok=True)
                (STATE / 'approved.json').unlink(missing_ok=True)
        except UpdateBusy:
            intent.retry_at = time.monotonic() + .5
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            intent.clear()
            write(STATE / 'error.json', {'at': time.time(), 'error': str(error)})
            message = 'The update did not finish. Try again.'


def entrypoint(argv=None):
    try:
        return main(argv)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        raise SystemExit('Harness update: ' + str(error))


if __name__ == '__main__':
    raise SystemExit(entrypoint())
