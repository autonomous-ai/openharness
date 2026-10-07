#!/usr/bin/env python3
"""Bounded observations and real lock/HTTP barriers inside one private guest."""
import argparse
import fcntl
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time

FIXTURE = Path.home() / '.local/state/harness-os/intent-fixture'
STATE = Path.home() / '.local/state/harness-os/updates'
UPDATER = Path('/usr/lib/harness-os/live_update.py')
BUSY = '{"harness_update_worker":1,"status":"busy"}\n'
WORKER = ['systemd-run', '--user', '--quiet', '--pipe', '--wait', '--collect',
          '--unit=harness-apply-update', '/usr/bin/python3', str(UPDATER), 'apply', '--worker']


def launch_token(launch):
    match = re.fullmatch(r'"exec env HARNESS_UPDATE_INSTANCE=([0-9a-f]{32}) '
                         r'/usr/bin/python3 /usr/lib/harness-os/live_update\.py screen"', launch)
    return match[1] if match else None


def write(name, data):
    with tempfile.NamedTemporaryFile(mode='w', dir=FIXTURE, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            json.dump(data, stream, indent=2)
            stream.write('\n')
            stream.flush()
            temporary.replace(FIXTURE / name)
        finally:
            temporary.unlink(missing_ok=True)


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def process(pid):
    path = Path('/proc') / str(pid)
    fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
    executable = path / 'exe'
    info = executable.stat()
    assert fields[0] not in ['Z', 'X'] and path.stat().st_uid == os.getuid(), str(path)
    return dict(pid=int(pid), start=fields[19], executable=str(executable.resolve(strict=True)),
                executable_device=info.st_dev, executable_inode=info.st_ino,
                group=fields[2], foreground=fields[5],
                argv=[part.decode() for part in (path / 'cmdline').read_bytes().split(b'\0') if part],
                cgroup=(path / 'cgroup').read_text(), stdin=str((path / 'fd/0').readlink()))


def events():
    # Writers append one complete record at a time. An overlapping reader may
    # observe an unfinished last write; consume only newline-terminated records.
    records = [json.loads(line) for path in FIXTURE.glob('events-*.jsonl')
               for line in path.read_text().split('\n')[:-1]]
    return sorted(records, key=lambda item: (item['at'], item['pid'], item['start']))


def lock_probe():
    owners = []
    path = STATE / 'lock'
    if not path.exists():
        return dict(blocked=False, owners=[])
    info = path.stat()
    for line in Path('/proc/locks').read_text().splitlines():
        fields = line.split()
        if len(fields) < 8 or fields[1:4] != ['FLOCK', 'ADVISORY', 'WRITE']:
            continue
        major, minor, inode = fields[5].split(':')
        if (int(major, 16), int(minor, 16), int(inode)) == (os.major(info.st_dev), os.minor(info.st_dev), info.st_ino):
            owners.append(dict(raw=line, process=process(fields[4])))
    with path.open('a') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            blocked = True
        else:
            blocked = False
            fcntl.flock(handle, fcntl.LOCK_UN)
    return dict(blocked=blocked, owners=owners)


def snapshot():
    ids = subprocess.check_output(['pgrep', '-u', str(os.getuid()), '-x', 'opencode'], text=True).split()
    daemon = subprocess.check_output(['systemctl', '--user', 'show', 'harness-daemon.service', '-p', 'MainPID', '--value'], text=True).strip()
    project = Path.home() / 'projects/session-probe'
    proof = project / 'proof.txt'
    stat = proof.stat()
    current = STATE / 'current'
    selected = current.resolve(strict=True) if current.is_symlink() or current.exists() else Path('/usr/lib/harness')
    files = ['harness-tui', 'cli.mjs', 'notify.mjs']
    socket = subprocess.check_output(['hn', 'display-message', '-p', '#{socket_path}'], text=True).strip()
    assert socket.startswith('/'), socket
    def hn(*args):
        return subprocess.check_output(['hn', '-S', socket, *args], text=True)
    pane_rows = hn('list-panes', '-s', '-F', '#{pane_id}\t#{pane_dead}\t#{window_id}\t#{pane_start_command}')
    panes = []
    for line in pane_rows.splitlines():
        pane, dead, window, launch = line.split('\t')
        panes.append(dict(pane=pane, dead=dead, window=window, launch=launch, token=launch_token(launch)))
    records = events()
    uis = []
    seen = set()
    for event in records:
        identity = (event['pid'], event['start'])
        if event['event'] != 'screen-enter' or identity in seen:
            continue
        seen.add(identity)
        try:
            ui = process(event['pid'])
            if ui['start'] != event['start']:
                continue
            environment = (Path('/proc') / str(event['pid']) / 'environ').read_bytes().split(b'\0')
            values = [item.split(b'=', 1)[1].decode() for item in environment if item.startswith(b'HARNESS_UPDATE_INSTANCE=')]
            ui['token'] = values[0] if len(values) == 1 else None
            uis.append(ui)
        except (FileNotFoundError, ProcessLookupError):
            continue
    registrations = []
    for path in (STATE / 'screens').glob('*'):
        if path.name.isdecimal():
            try:
                registrations.append(json.loads(path.read_text()))
            except FileNotFoundError:
                pass
    clients = []
    lines = hn('hn-list-clients', '-F', '#{client_pid}\t#{session_id}')
    for line in lines.splitlines():
        pid, session = line.split('\t')
        client = process(pid)
        assert Path('/proc/' + pid + '/exe').samefile(selected / 'harness-tui'), client
        assert '/hn-screen.service' in client['cgroup'] and client['stdin'].startswith('/dev/pts/'), client
        clients.append(dict(session=session, process=client))
    assert clients and ids, 'No attached client or real agent'
    return dict(at=time.monotonic(), agents=[process(pid) for pid in ids], daemon=process(daemon),
                terminal=process((project / 'pid').read_text().strip()),
                heartbeat=(project / 'heartbeat').read_text(), input=(project / 'input').read_text(),
                project=dict(sha256=sha(proof), uid=stat.st_uid, gid=stat.st_gid, mode=stat.st_mode, mtime_ns=stat.st_mtime_ns),
                boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip(), clients=clients,
                bundled={name:sha(Path('/usr/lib/harness') / name) for name in files},
                runtime_identity_sha256=sha(Path('/usr/share/harness-os/runtime.json')),
                selected=str(selected), selected_files={name:sha(selected / name) for name in files},
                request=(STATE / 'request.json').exists(),
                ready=json.loads((STATE / 'ready.json').read_text()) if (STATE / 'ready.json').exists() else None,
                transaction=json.loads((STATE / 'transaction.json').read_text()) if (STATE / 'transaction.json').exists() else None,
                lock=lock_probe(), events=records, uis=uis,
                ownership=dict(socket=socket, active=hn('display-message', '-p', '#{pane_id}').strip(),
                               panes=panes, raw_panes=pane_rows, registrations=registrations))


class BarrierHTTP(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        with (FIXTURE / 'http.jsonl').open('a') as stream:
            stream.write(json.dumps(dict(at=time.monotonic(), path=self.path, message=format % args)) + '\n')

    def do_GET(self):
        gate = json.loads((FIXTURE / 'gate.json').read_text())
        hit = FIXTURE / (gate['token'] + '-http-entered.json')
        with self.server.gate_lock:
            waiting = self.path == gate.get('path') and not hit.exists()
            if waiting:
                write(hit.name, dict(at=time.monotonic(), path=self.path, gate=gate))
        if waiting:
            # This response is delayed only once; returned asset bytes and
            # headers remain the standard file server's. Stay below the real
            # updater's 20-second network timeout, not a relaxed product timeout.
            deadline = time.monotonic() + 15
            while not (FIXTURE / (gate['token'] + '-http-release')).exists():
                if time.monotonic() >= deadline:
                    write(gate['token'] + '-http-expired.json', dict(at=time.monotonic(), kind='observer-barrier-expired'))
                    self.send_error(503, 'Private download barrier expired')
                    return
                time.sleep(.025)
            write(gate['token'] + '-http-released.json', dict(at=time.monotonic()))
        super().do_GET()


def hold(name):
    STATE.mkdir(parents=True, exist_ok=True)
    with (STATE / 'lock').open('a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        write(name + '-lock-held.json', dict(at=time.monotonic(), process=process(os.getpid())))
        deadline = time.monotonic() + 30
        while not (FIXTURE / (name + '-lock-release')).exists():
            if time.monotonic() >= deadline:
                write(name + '-lock-expired.json', dict(at=time.monotonic(), kind='observer-barrier-expired'))
                raise TimeoutError('Private lock holder expired')
            time.sleep(.025)
    write(name + '-lock-done.json', dict(at=time.monotonic()))


def transport():
    results = {'toolchain': dict(systemd=subprocess.check_output(['systemd-run', '--version'], text=True),
                                python=sys.version, kernel=list(os.uname()),
                                updater_sha256=sha(UPDATER))}
    def run(name, argv):
        started = time.monotonic()
        process = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=20)
        results[name] = dict(argv=argv, status=process.returncode, stdout=process.stdout, stderr=process.stderr,
                             seconds=round(time.monotonic() - started, 3))
        write('transport.json', results)  # Preserve reached outcomes before assertions.
        return process
    STATE.mkdir(parents=True, exist_ok=True)
    assert not any((STATE / name).exists() for name in ['ready.json', 'current', 'approved.json', 'transaction.json', 'request.json'])
    with (STATE / 'lock').open('a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        busy = run('real-worker-busy', WORKER)
        assert (busy.returncode, busy.stdout) == (75, BUSY), results
    failure = run('real-worker-no-update', WORKER)
    assert failure.returncode == 1 and not failure.stdout and 'up to date' in failure.stderr, results
    prefix = WORKER[:WORKER.index('/usr/bin/python3')]
    arbitrary = run('exit75-without-marker', prefix + ['/usr/bin/python3', '-c', 'raise SystemExit(75)'])
    assert arbitrary.returncode == 75 and not arbitrary.stdout, results
    marker = run('marker-with-exit1', prefix + ['/usr/bin/python3', '-c', 'print(' + repr(BUSY.strip()) + '); raise SystemExit(1)'])
    assert marker.returncode == 1 and marker.stdout == BUSY, results
    startup = run('unit-start-failure', prefix + ['/no-such-harness-intent-executable'])
    assert startup.returncode != 0 and startup.stdout != BUSY, results


def checker_complete(name):
    # A running Type=oneshot service is activating, for which is-active is
    # already nonzero. Observe an actual successful exit, not that negation.
    raw = subprocess.check_output(['systemctl', '--user', 'show', 'harness-update.service',
        '--property=ActiveState,SubState,Result,ExecMainStatus,MainPID,ExecMainCode'], text=True)
    state = dict(line.split('=', 1) for line in raw.splitlines())
    write(name + '-checker.json', dict(at=time.monotonic(), state=state, raw=raw))
    expected = dict(ActiveState='inactive', SubState='dead', Result='success', ExecMainStatus='0', MainPID='0')
    return all(state.get(key) == value for key, value in expected.items())


def format_probe():
    socket = subprocess.check_output(['hn', 'display-message', '-p', '#{socket_path}'], text=True).strip()
    assert socket.startswith('/'), socket
    argv = ['hn', '-S', socket, 'list-panes', '-s', '-F', '#{pane_id}\t#{window_id}']
    # Direct argv bypasses the interactive serial shell's Tab handling.
    write('format-probe.json', dict(socket=socket, argv=argv,
                                    raw=subprocess.check_output(argv, text=True)))


def archive(destination):
    # The immutable Fedora fixture has Python but no external tar command.
    # Keep exact evidence bytes and symlinks, without copying the release assets.
    with tarfile.open(destination, 'w', dereference=False) as saved:
        for path in sorted(FIXTURE.iterdir()):
            if path.name != 'assets':
                saved.add(path, arcname=path.name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['serve', 'hold', 'snapshot', 'transport', 'event', 'reset-staged', 'barrier-failures', 'checker-complete', 'format-probe', 'archive'])
    parser.add_argument('name', nargs='?')
    parser.add_argument('kind', nargs='?')
    parser.add_argument('--pending', choices=['true', 'false'])
    args = parser.parse_args()
    if args.action == 'serve':
        server = ThreadingHTTPServer(('127.0.0.1', 19447), partial(BarrierHTTP, directory=str(FIXTURE / 'assets')))
        server.gate_lock = threading.Lock()
        server.serve_forever()
    elif args.action == 'hold':
        hold(args.name)
    elif args.action == 'transport':
        transport()
    elif args.action == 'format-probe':
        format_probe()
    elif args.action == 'archive':
        archive(args.name)
    elif args.action == 'checker-complete':
        raise SystemExit(0 if checker_complete(args.name) else 1)
    elif args.action == 'snapshot':
        write(args.name + '.json', snapshot())
    elif args.action == 'barrier-failures':
        write('barrier-failures.json', dict(
            expired={path.name:json.loads(path.read_text()) for path in FIXTURE.glob('*-expired.json')},
            events=[event for event in events() if event['event'] == 'observer-error']))
    elif args.action == 'event':
        pending = None if args.pending is None else args.pending == 'true'
        matches = [item for item in events() if item['phase'] == args.name and item['event'] == args.kind
                   and (args.pending is None or item['pending'] is pending)]
        raise SystemExit(0 if matches else 1)
    elif args.action == 'reset-staged':
        spec = importlib.util.spec_from_file_location('updater', UPDATER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with module.locked():
            assert not any((STATE / name).exists() for name in ['current', 'transaction.json', 'approved.json', 'request.json'])
            (STATE / 'ready.json').unlink(missing_ok=True)
            if (STATE / 'builds').exists():
                shutil.rmtree(STATE / 'builds')


if __name__ == '__main__':
    main()
