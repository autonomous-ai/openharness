#!/usr/bin/env python3
"""Observe the shipped daemon-backed pane namespace in one private live VM."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import time
from unittest.mock import patch
from footprint_vm import copy_file
from hardware_install_vm import candidate_record, digest
from vm import VM

TOKEN = 'owned-context-observation'
FORMAT = '#{pane_id}\t#{pane_pid}\t#{pane_tty}\t#{pane_start_command}\t#{socket_path}\t#{@harness-update-context}'
FIELDS = ['pane', 'pid', 'tty', 'start_command', 'socket', 'custom_option']
IMAGE_SOURCE = 'b6cbaf3e3090f43106ad1ee47606349bd1a0ae89'
IMAGE_SHA256 = 'fa4f282644ac81e9e3b7de55276edd7dc08405e50875da544dc7f9fd6d50ba12'
IMAGE_BYTES = 2007023616
RUNTIME_SHA256 = {
    'harness-tui': 'bd221059a24d7f7ca8ce69bb3b6d69c2fb66cb655aae6658627c278a548a8fa8',
    'cli.mjs': '23b46a7c498fd1ef8ff5936aeb431f1de08b959b957141fa732d2cede870d147',
    'notify.mjs': '5690159e964f9ce022bdb2a5e4bc9d853e595e822f254478df241e1386dde68e',
}
PROCESS = '''import json,os,sys,time
from pathlib import Path
def read_process(pid):
    root=Path('/proc')/str(pid)
    fields=(root/'stat').read_text().rsplit(')',1)[1].split()
    env=dict(item.split('=',1) for item in (root/'environ').read_bytes().decode().split('\\0') if '=' in item)
    return dict(pid=int(pid),start=fields[19],state=fields[0],group=fields[2],foreground=fields[5],
        stdin=str((root/'fd/0').readlink()),argv=(root/'cmdline').read_bytes().rstrip(b'\\0').decode().split('\\0'),
        env={k:env.get(k) for k in ['TMUX','TMUX_PANE','HN_SOCKET','HN_SOCKET_NAME','HARNESS_OS',
             'HARNESS_TUI_BIN','MACHINE_ID','HARNESS_AGENT_ID','AGENT_ID','PORT','HARNESS_UPDATE_INSTANCE']})
if len(sys.argv)>1:
    records=[]
    for p in Path('/proc').iterdir():
        if not p.name.isdigit():continue
        try:
            if p.stat().st_uid!=os.getuid():continue
            argv=(p/'cmdline').read_bytes().rstrip(b'\\0').decode().split('\\0')
            if argv==['/usr/bin/python3','/usr/lib/harness-os/live_update.py'] or (
                argv==['python3','/tmp/update-context.py']):records.append(read_process(p.name))
        except (FileNotFoundError,ProcessLookupError):continue
    Path('/tmp/update-context-snapshot.json').write_text(json.dumps(records,indent=2)+'\\n')
else:
    Path('/tmp/update-context-owner.json').write_text(json.dumps(read_process(os.getpid()),indent=2)+'\\n')
    print('Harness updater context observation',flush=True)
    time.sleep(180)
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path('os/test-results/update-context'))
    args = parser.parse_args()
    assert os.access('/dev/kvm', os.R_OK | os.W_OK), 'Native x86 KVM is required'
    iso = args.iso.resolve()
    manifest = json.loads(iso.with_name('manifest.json').read_text())
    assert manifest['source_commit'] == manifest['harness_inputs']['source_commit'] == IMAGE_SOURCE
    assert manifest['iso']['sha256'] == digest(iso) == IMAGE_SHA256
    assert manifest['iso']['bytes'] == iso.stat().st_size == IMAGE_BYTES
    assert {name: info['sha256'] for name, info in manifest['harness_inputs']['files'].items()} == RUNTIME_SHA256
    folder = args.output.resolve()
    folder.mkdir(parents=True, exist_ok=False)
    receipt = dict(status='running', started_at=time.time(), budget_seconds=300,
        image_manifest=manifest, observer=candidate_record(Path(__file__)),
        helpers={name:candidate_record(Path(__file__).with_name(name)) for name in [
            'vm.py', 'footprint_vm.py', 'hardware_install_vm.py']},
        process_observer_sha256=hashlib.sha256(PROCESS.encode()).hexdigest(),
        firmware='bios', cpu='Nehalem', memory_mib=2048, commands=[],
        scope='Live overlay only: stop installer, clear live marker and start packaged daemon/hn. No installation, candidate product overlay, update activation or runtime build.',
        limitations=['Runtime namespace observation, not ownership acceptance or physical hardware validation.'])
    vm = VM(folder, iso, 'bios', 2048, cpu='Nehalem')

    def save():
        (folder / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')

    def user(command):
        # runuser retains the serial root shell's cwd; new panes need me's home.
        return 'runuser -u me -- env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus sh -c ' + shlex.quote('cd /home/me && ' + command)

    def record(name, command, timeout=45, check=True):
        output, status = vm.command(command, timeout=timeout, check=False)
        (folder / (name + '.txt')).write_text(output)
        receipt['commands'].append(dict(name=name, command=command, status=status))
        save()
        assert not check or status == 0, (name, status, output[-2000:])
        return output

    def snapshot(name):
        record(name, user('python3 /tmp/update-context.py snapshot'))
        data = vm.read_file('/tmp/update-context-snapshot.json')
        (folder / (name + '.json')).write_bytes(data)
        return json.loads(data)

    def pane_format(name, pane):
        record(name, user('hn display-message -p -t ' + shlex.quote(pane) + ' ' +
                         shlex.quote(FORMAT) + ' > /tmp/update-context-format'), check=False)
        data = vm.read_file('/tmp/update-context-format')
        (folder / (name + '.tsv')).write_bytes(data)
        values = data.decode().rstrip('\r\n').split('\t')
        result = dict(raw=data.decode(), fields=dict(zip(FIELDS, values)) if len(values) == len(FIELDS) else None)
        receipt[name] = result
        save()
        return result

    def deadline(*_):
        raise TimeoutError('300-second live context observation budget expired')

    real_popen = subprocess.Popen

    def restricted(command, *argv, **kwargs):
        if isinstance(command, list) and command[0] == 'qemu-system-x86_64':
            command = list(command)
            command[command.index('user,id=net')] = 'user,id=net,restrict=on'
            receipt['qemu_command'] = command
        return real_popen(command, *argv, **kwargs)

    try:
        signal.signal(signal.SIGALRM, deadline)
        signal.alarm(300)
        with patch('subprocess.Popen', restricted):
            vm.start(live=True)
        receipt['acceleration'] = vm.acceleration
        assert vm.acceleration == 'kvm'
        vm.wait(r'root@[^\r\n]*[#] ', timeout=110)
        vm.shell_ready = True
        vm.command('stty -echo')
        checksums = ''.join(info['sha256'] + '  /usr/lib/harness/' + name + '\n'
                            for name, info in manifest['harness_inputs']['files'].items())
        record('01-frozen-runtime', 'printf %s ' + shlex.quote(checksums) + ' | sha256sum -c -')
        record('01-host-identity', 'uname -n > /tmp/context-hostname && uname -a > /tmp/context-kernel && ' +
               user('hn -V > /tmp/context-client-version'))
        receipt['guest'] = {key: vm.read_file('/tmp/context-' + key).decode().strip()
                            for key in ['hostname', 'kernel', 'client-version']}
        paths = ['/usr/bin/harness', '/usr/lib/harness-os/live_update.py', '/usr/lib/harness-os/open-updates']
        receipt['packaged_files'] = {path:hashlib.sha256(vm.read_file(path)).hexdigest() for path in paths}
        record('02-live-session-ready', user('timeout 30 sh -c ' + shlex.quote(
            'until systemctl --user is-active --quiet harness-install.service 2>/dev/null && '
            'pgrep -u 1000 -x labwc >/dev/null; do sleep .2; done')), timeout=35)
        record('02-private-session', user('systemctl --user stop harness-install.service harness-update.timer harness-update.service') +
            ' && rm /etc/harness-live && ' + user('mkdir -p ~/.local/state/harness-os ~/projects; touch ~/.local/state/harness-os/onboarded; systemctl --user start harness-daemon.service hn-screen.service'), timeout=100)
        record('03-runtime-ready', user('/usr/lib/harness-os/wait-runtime && hn list-panes -s -F ' + shlex.quote(FORMAT)), timeout=45)
        copy_file(vm, PROCESS.encode(), '/tmp/update-context.py')
        record('04-create-pane', user("hn new-window -P -F '#{pane_id}' -n Observation " +
            shlex.quote('env HARNESS_UPDATE_INSTANCE=' + TOKEN + ' python3 /tmp/update-context.py') + ' > /tmp/update-context-pane'))
        record('05-await-process', "timeout 20 sh -c 'until test -s /tmp/update-context-owner.json; do sleep .1; done'", timeout=25)
        pane = vm.read_file('/tmp/update-context-pane').decode().strip()
        before = json.loads(vm.read_file('/tmp/update-context-owner.json'))
        receipt.update(pane=pane, original_process=before)
        assert pane.startswith('%') and pane[1:].isdigit(), pane
        assert before['env']['HARNESS_UPDATE_INSTANCE'] == TOKEN
        record('06-custom-option', user('hn set-option -p -t ' + shlex.quote(pane) + ' @harness-update-context ' + TOKEN), check=False)
        receipt['custom_option_status'] = receipt['commands'][-1]['status']
        pane_format('07-format-before', pane)
        record('08-manual-view', user("test ! -e ~/.local/state/harness-os/updates/request.json && hn new-window -n Manual '/usr/bin/harness updates'"))
        record('09-manual-started', 'timeout 15 sh -c ' + shlex.quote(
            "until pgrep -u 1000 -f '^/usr/bin/python3.*live_update.py' >/dev/null; do sleep .1; done"), timeout=20)
        snapshot('10-processes-before')
        record('11-no-apply-request', user('test ! -e ~/.local/state/harness-os/updates/request.json'))
        vm.screenshot('before-reconnect')
        record('12-renderer-reconnect', user('systemctl --user restart hn-screen.service && /usr/lib/harness-os/wait-runtime'), timeout=45)
        after = snapshot('13-processes-after')
        same = next(p for p in after if p['pid'] == before['pid'])
        assert all(same[key] == before[key] for key in ['pid', 'start', 'stdin', 'argv'])
        pane_format('14-format-after', pane)
        record('15-no-apply-request', user('test ! -e ~/.local/state/harness-os/updates/request.json'))
        record('16-frozen-runtime', 'printf %s ' + shlex.quote(checksums) + ' | sha256sum -c -')
        vm.screenshot('after-reconnect')
        receipt['status'] = 'passed'
    except BaseException as error:
        receipt.update(status='failed', error=repr(error))
        try:
            vm.screenshot('failure')
        except Exception as capture:
            receipt['capture_error'] = repr(capture)
        raise
    finally:
        signal.alarm(0)
        vm.stop()
        receipt['finished_at'] = time.time()
        save()
        vm.log.close()
        vm.stderr.close()
        vm.control.cleanup()


if __name__ == '__main__':
    main()
