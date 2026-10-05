#!/usr/bin/env python3
"""Independent observation of updater processes and pane identity in a private VM."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

UPDATER = '/usr/lib/harness-os/live_update.py'
STATE = Path.home() / '.local/state/harness-os/updates'
LAUNCH = re.compile(r'"exec env HARNESS_UPDATE_INSTANCE=([0-9a-f]{32}) /usr/bin/python3 '
                    + re.escape(UPDATER) + r' screen"')


def launch_token(launch):
    match = LAUNCH.fullmatch(launch)
    return match[1] if match else None


def process(pid):
    root = Path('/proc') / str(pid)
    fields = (root / 'stat').read_text().rsplit(')', 1)[1].split()
    return dict(pid=int(pid), start=fields[19], state=fields[0], group=fields[2],
                foreground=fields[5], argv=(root / 'cmdline').read_bytes().rstrip(b'\0').decode().split('\0'))


def snapshot():
    socket = subprocess.check_output(['hn', 'display-message', '-p', '#{socket_path}'],
                                     text=True, timeout=5).strip()
    assert socket.startswith('/') and '\n' not in socket, socket
    template = '\t'.join('#{' + key + '}' for key in [
        'pane_id', 'pane_pid', 'pane_dead', 'window_id', 'window_name',
        'pane_active', 'window_active', 'socket_path', 'pane_start_command'])
    output = subprocess.check_output(['hn', '-S', socket, 'list-panes', '-s', '-F', template],
                                     text=True, timeout=5)
    panes = []
    for line in output.splitlines():
        values = line.split('\t')
        assert len(values) == 9, repr(line)
        pane = dict(zip(['pane', 'pid', 'dead', 'window', 'name', 'pane_active', 'window_active',
                         'socket', 'start_command'], values))
        # Read exactly the fixed launch emitted by the opener. Quoting and all
        # arguments are identity evidence; never parse or execute shell text.
        pane['token'] = launch_token(pane['start_command'])
        panes.append(pane)
    clients = subprocess.check_output(['hn', '-S', socket, 'hn-list-clients', '-F',
                                       '#{client_pid}\t#{session_id}'], text=True, timeout=5)
    rows = [line.split('\t') for line in clients.splitlines()]
    assert len(rows) == 1 and len(rows[0]) == 2 and rows[0][0].isdecimal(), repr(clients)
    renderer = process(rows[0][0])
    renderer_path = Path('/proc') / str(renderer['pid'])
    executable = renderer_path / 'exe'
    assert renderer['state'] not in ['Z', 'X'] and renderer_path.stat().st_uid == os.getuid(), renderer
    assert executable.samefile('/usr/lib/harness/harness-tui'), str(executable.resolve())
    renderer.update(executable=str(executable.resolve(strict=True)),
                    executable_sha256=hashlib.sha256(executable.read_bytes()).hexdigest(),
                    cgroup=(renderer_path / 'cgroup').read_text(),
                    stdin=str((renderer_path / 'fd/0').readlink()), session=rows[0][1])
    assert '/hn-screen.service' in renderer['cgroup'] and renderer['stdin'].startswith('/dev/pts/'), renderer
    screens = []
    for path in Path('/proc').iterdir():
        if not path.name.isdigit():
            continue
        try:
            if path.stat().st_uid != os.getuid():
                continue
            record = process(path.name)
            if record['argv'] not in (['/usr/bin/python3', UPDATER], ['/usr/bin/python3', UPDATER, 'screen']):
                continue
            environment = dict(value.split('=', 1) for value in (path / 'environ').read_bytes().decode().split('\0') if '=' in value)
            record['backend_pane'] = environment.get('TMUX_PANE')
            record['primary_socket'] = environment.get('HN_SOCKET')
            record['token'] = environment.get('HARNESS_UPDATE_INSTANCE')
            matches = [p['pane'] for p in panes if record['token'] and p['token'] == record['token']
                       and p['dead'] == '0']
            record['pane'] = matches[0] if len(matches) == 1 else None
            record['stdin'] = str((path / 'fd/0').readlink())
            registration = STATE / 'screens' / path.name
            record['registration'] = json.loads(registration.read_text()) if registration.exists() else None
            screens.append(record)
        except (FileNotFoundError, ProcessLookupError):
            continue
    return dict(panes=panes, raw_panes=output, socket=socket, renderer=renderer, raw_clients=clients,
                screens=screens, request_pending=(STATE / 'request.json').exists(),
                boot_id=Path('/proc/sys/kernel/random/boot_id').read_text().strip())


def work_identity():
    agent_ids = subprocess.check_output(['pgrep', '-u', str(os.getuid()), '-x', 'opencode'], text=True).split()
    daemon = subprocess.check_output(['systemctl', '--user', 'show', 'harness-daemon.service', '-p', 'MainPID', '--value'], text=True).strip()
    terminal = (Path.home() / 'projects/session-probe/pid').read_text().strip()
    return dict(agents=[process(pid) for pid in agent_ids], daemon=process(daemon), terminal=process(terminal),
                boot_id=Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                heartbeat=(Path.home() / 'projects/session-probe/heartbeat').stat().st_mtime_ns,
                runtime={str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in [
                    Path('/usr/lib/harness/harness-tui'), Path('/usr/lib/harness/cli.mjs'), Path('/usr/lib/harness/notify.mjs')]})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['snapshot', 'work'])
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    result = snapshot() if args.action == 'snapshot' else work_identity()
    args.output.write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
