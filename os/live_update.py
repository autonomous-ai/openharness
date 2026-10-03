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
RESTART_REQUIRED = Path('/run/harness-os-restart-required')
SYSTEM_LOCK = Path('/run/lock/hn-os.lock')


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
def locked():
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (STATE / 'lock').open('a') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError('An update is already in progress.') from error
        # OS package replacement and fast activation cannot run concurrently.
        # The root-owned file is created by tmpfiles before the user session.
        system_lock = SYSTEM_LOCK.open('r') if SYSTEM_LOCK.exists() else None
        try:
            if system_lock:
                try:
                    fcntl.flock(system_lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
                except BlockingIOError as error:
                    raise ValueError('A system update is in progress. Try again when it finishes.') from error
            yield
        finally:
            if system_lock:
                system_lock.close()


def check_system(force=False):
    cached = read(STATE / 'system.json', {})
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


def fetch(url, limit):
    request = Request(allowed_url(url), headers={'User-Agent': 'Harness-Updates/1'})
    with urlopen(request, timeout=20) as response:
        allowed_url(response.url)
        size = response.headers.get('Content-Length')
        if size and (not size.isdigit() or int(size) > limit):
            raise ValueError('Update exceeds its download size limit.')
        data = response.read(limit + 1)
        if len(data) > limit:
            raise ValueError('Update exceeds its download size limit.')
        return data


def release(feed, component):
    meta = json.loads(fetch(feed, 65536))
    if not isinstance(meta, dict):
        raise ValueError('Invalid release manifest.')
    if component == 'hn':
        builds = meta.get('builds')
        if not isinstance(builds, dict):
            raise ValueError('Invalid hn release manifest.')
        value, refs = meta.get('version'), {'harness-tui': builds.get('linux-x64')}
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
    # Only OS configuration renders this option. No shared hn welcome/UI change.
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
            notice(('Restart ready' if read(RESTART_REQUIRED, {}).get('status') == 'ready' else 'System update needs attention') + ' · Super+U')
            return False
        recover_interrupted()
        current = selected()
        running = versions(current)
        ready = prepared()
        base = ready if ready and ready.exists() else current
        base_versions = verify(base)['versions'] if base != BUNDLED else running
        changes, target_versions, errors = {}, dict(base_versions), []
        ignored = read(STATE / 'ignored.json', {})
        for component, url in (feeds or FEEDS).items():
            try:
                candidate, refs = release(url, component)
                if ignored.get(component) == candidate:
                    continue
                if version(candidate) > version(base_versions[component]):
                    progress('Downloading hn…' if component == 'hn' else 'Downloading Harness…')
                    component_files = {}
                    for name, ref in refs.items():
                        data = fetch(ref['url'], ref.get('size', LIMIT))
                        if hashlib.sha256(data).hexdigest() != ref['sha256'].lower() or (
                            ref.get('size') is not None and len(data) != ref['size']
                        ):
                            raise ValueError('Download checksum or size does not match the release.')
                        component_files[name] = data
                    changes.update(component_files)
                    target_versions[component] = candidate
            except (ValueError, OSError, KeyError, TypeError) as error:
                errors.append(f'{component}: {error}')
        # Each component is complete before staging; an unavailable CLI release
        # must not hold up an independent hn fix (or leave only half a CLI pair).
        if changes:
            builds = STATE / 'builds'
            builds.mkdir(exist_ok=True)
            with tempfile.TemporaryDirectory(prefix='.download-', dir=builds) as temp:
                folder = Path(temp)
                for name in FILES:
                    if name in changes:
                        (folder / name).write_bytes(changes[name])
                    else:
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
                if not ready.exists():
                    # TemporaryDirectory can safely clean its now-missing old name.
                    folder.rename(ready)
                    sync_directory(builds)
                write(STATE / 'ready.json', {'id': identity})
        write(STATE / 'check.json', {'checked_at': time.time(), 'errors': errors})
        available = ready is not None and ready != current
        system = check_system(force_system) if feeds is None else {}
        notice('Update ready · Super+U' if available or system.get('available') else '')
        prune()
        if errors and not available:
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
        write(STATE / 'transaction.json', {'previous': str(previous), 'target': str(target), 'status': 'applying'})
        select(target)
        try:
            restart(candidate['cli'] != old['cli'])
            screen_ready(target)
        except BaseException:
            select(previous)
            write(STATE / 'transaction.json', {'status': 'failed', 'previous': str(previous)})
            restart(candidate['cli'] != old['cli'])
            notice('Update failed · Super+U')
            raise
        write(STATE / 'applied.json', {'previous': str(previous), 'current': str(target), 'at': time.time()})
        if rollback:
            write(STATE / 'ignored.json', old)
        write(STATE / 'transaction.json', {'status': 'applied'})
        (STATE / 'ready.json').unlink(missing_ok=True)
        notice('')
        prune()


def screen(window):
    curses.curs_set(0)
    window.keypad(True)
    message = ''
    def draw(status=''):
        window.erase()
        height, width = window.getmaxyx()
        ready = prepared()
        available = ready is not None and ready != selected()
        checked = read(STATE / 'check.json', {})
        system = read(STATE / 'system.json', {})
        failed = read(STATE / 'transaction.json', {}).get('status') == 'failed'
        system_state = read(RESTART_REQUIRED, {}).get('status')
        reboot = system_state == 'ready'
        recovery = system_state == 'failed'
        if system_state:
            available = False
        summary = 'Could not check for updates.' if checked.get('errors') else (
            'Harness is up to date.' if checked.get('checked_at') else 'Updates are checked automatically.')
        lines = ['harness', '', status or message or (
                 'Restore the previous system to recover.' if recovery else
                 'Restart to finish the system update.' if reboot else
                 'The system is updating…' if system_state else
                 'Update failed. Previous version restored.' if failed else 'An update is ready.' if available else summary), '',
                 'Enter   Restart now' if reboot else 'Enter   Try update again' if available and failed else
                 'Enter   Update now' if available else 'C       Check for updates',
                 'R       Restore previous system' if recovery else
                 'R       Restore previous version' if not system_state and read(STATE / 'applied.json') else '',
                 'S       System update ready' if system.get('available') else 'S       System updates', '', 'Esc     Back']
        top, left = max(0, (height - len(lines)) // 2), max(0, (width - 46) // 2)
        for index, line in enumerate(lines):
            if top + index < height - 1:
                window.addnstr(top + index, left, line, max(0, width - left - 1), curses.A_BOLD if index == 0 else 0)
        window.refresh()
        return available
    while True:
        available = draw()
        key = window.getch()
        if key in (27, ord('q')):
            return
        try:
            if key in (10, 13) and read(RESTART_REQUIRED, {}).get('status') == 'ready':
                return 'reboot'
            if key in (ord('r'), ord('R')) and read(RESTART_REQUIRED, {}).get('status') == 'failed':
                return 'restore-system'
            if key in (ord('c'), ord('C')) or key in (10, 13) and not available:
                draw('Checking for updates…')
                check(progress=draw, force_system=True)
                message = ''
            elif key in (10, 13) and available or key in (ord('r'), ord('R')):
                action = 'rollback' if key in (ord('r'), ord('R')) else 'apply'
                draw('Updating… Your agents keep running.')
                # A transient unit survives the screen it restarts; no extra daemon.
                run('systemd-run', '--user', '--collect', '--unit=harness-apply-update',
                    '/usr/bin/python3', '/usr/lib/harness-os/live_update.py', action)
                return
            elif key in (ord('s'), ord('S')):
                return 'system'
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            message = str(error)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['check', 'screen', 'apply', 'rollback', 'status'], nargs='?', default='screen')
    parser.add_argument('--feeds', type=Path, help='Explicit developer feed map; never used by the installed timer')
    args = parser.parse_args(argv)
    if os.geteuid() == 0 or Path('/etc/harness-live').exists():
        parser.error('Open Updates as your normal user on an installed Harness system.')
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.action == 'check':
        check(read(args.feeds) if args.feeds else None)
    elif args.action == 'screen':
        while True:
            action = curses.wrapper(screen)
            if action == 'reboot':
                subprocess.run(['systemctl', 'reboot'], check=True)
                break
            if action not in ('system', 'restore-system'):
                break
            subprocess.run(['sudo', '/usr/bin/harness', 'rollback' if action == 'restore-system' else 'upgrade'], check=False)
            (STATE / 'system.json').unlink(missing_ok=True)
            input('Press Enter to return to Updates.')
    elif args.action in ('apply', 'rollback'):
        apply(rollback=args.action == 'rollback')
    else:
        print(json.dumps({'runtime': str(selected()), 'versions': versions(selected()),
                          'ready': str(prepared()) if prepared() else None,
                          'restart_required': RESTART_REQUIRED.exists(),
                          'system': read(STATE / 'system.json'), 'check': read(STATE / 'check.json')}, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        raise SystemExit('Harness update: ' + str(error))
