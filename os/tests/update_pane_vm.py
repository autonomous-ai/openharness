#!/usr/bin/env python3
"""Observe update shortcut ownership on a frozen, privately installed OS image."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import time
from footprint_vm import copy_file
from hardware_install_vm import candidate_record, digest
from session_vm import PROBE, screen_text
from vm import VM

UPDATER = '/usr/lib/harness-os/live_update.py'
OPENER = '/usr/lib/harness-os/open-updates'
WRAPPER = '/usr/bin/harness'
GUEST = '/home/me/update-pane-observer.py'
STATE = '/home/me/.local/state/harness-os/updates'


def renderer_replaced(before, after, expected_sha256):
    assert before['pid'] != after['pid'] and before['start'] != after['start'], (before, after)
    for key in ['executable', 'session']:
        assert before[key] == after[key], (key, before, after)
    assert before['executable_sha256'] == after['executable_sha256'] == expected_sha256, (before, after)
    return dict(before=before, after=after)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path('os/test-results/update-pane'))
    args = parser.parse_args()
    assert os.access('/dev/kvm', os.R_OK | os.W_OK), 'Native x86 KVM is required'
    iso = args.iso.resolve()
    manifest = json.loads(iso.with_name('manifest.json').read_text())
    assert digest(iso) == manifest['iso']['sha256'] and iso.stat().st_size == manifest['iso']['bytes']
    assert set(manifest['harness_inputs']['files']) == {'harness-tui', 'cli.mjs', 'notify.mjs'}
    folder = args.output.resolve()
    folder.mkdir(parents=True, exist_ok=False)
    (folder / 'image-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    root = Path(__file__).resolve().parents[1]
    candidates = {UPDATER: root / 'live_update.py', OPENER: root / 'root/usr/lib/harness-os/open-updates',
                  WRAPPER: root / 'root/usr/bin/harness'}
    receipt = dict(status='running', started_at=time.time(), image_source=manifest['source_commit'],
                   iso_sha256=manifest['iso']['sha256'], firmware='bios', memory_mib=2048, cpu='Nehalem',
                   candidates={target: candidate_record(path) for target, path in candidates.items()},
                   test_inputs={name: candidate_record(Path(__file__).with_name(name)) for name in [
                       'update_pane_vm.py', 'update_pane_guest.py', 'vm.py', 'session_vm.py',
                       'footprint_vm.py', 'hardware_install_vm.py']}, checks=[],
                   limitations=['Updater-pane delivery and lifetime only; no new runtime or OS package activation.',
                                'Private loopback metadata offers no update; shared runtime bytes stay frozen.',
                                'No physical keyboard, Intel Mac, radio or GPU claim.'])
    vm = VM(folder, iso, 'bios', 2048, cpu='Nehalem')
    config = dict(disk='/dev/vda', expected_serial='HN_OS_TEST', confirm_erase='/dev/vda',
                  username='me', hostname='harness', password='test-password-123', encrypt=False, serial_console=True)

    def observe(name, action='snapshot'):
        vm.command('python3 ' + GUEST + ' ' + action + ' /tmp/update-pane-observation.json')
        data = vm.read_file('/tmp/update-pane-observation.json')
        (folder / (name + '.json')).write_bytes(data)
        return json.loads(data)

    def active(snapshot):
        return [p for p in snapshot['screens'] if p['registration'] is not None
                and p['pane'] is not None and p['state'] not in ['Z', 'X']]

    def wait_active(name, expected=None):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            record = observe(name)
            owners = active(record)
            if len(owners) == 1 and not record['request_pending']:
                owner = owners[0]
                pane = next(p for p in record['panes'] if p['pane'] == owner['pane'])
                if not (pane['dead'] == '0' and pane['pane_active'] == '1' and pane['window_active'] == '1'):
                    time.sleep(.1)
                    continue
                if expected:
                    for key in ['pid', 'start', 'pane', 'token', 'registration', 'stdin', 'argv']:
                        assert owner[key] == expected[key], (key, record)
                assert owner['stdin'].startswith('/dev/pts/') and owner['group'] == owner['foreground'], owner
                assert pane['token'] == owner['token']
                assert pane['start_command'] == ('"exec env HARNESS_UPDATE_INSTANCE=' + owner['token'] +
                                                  ' /usr/bin/python3 ' + UPDATER + ' screen"'), pane
                assert owner['registration'] == dict(pid=owner['pid'], start=owner['start'],
                    token=owner['token'], boot_id=record['boot_id']), owner
                assert record['renderer']['executable_sha256'] == manifest['harness_inputs']['files']['harness-tui']['sha256']
                return record, owner
            time.sleep(.1)
        raise TimeoutError('One active updater did not consume the shortcut: ' + name)

    def wait_gone(previous):
        script = '''import time
from pathlib import Path
path=Path('/proc/%d/stat')
deadline=time.monotonic()+5
while time.monotonic()<deadline:
    try:
        start=path.read_text().rsplit(')',1)[1].split()[19]
    except FileNotFoundError:
        break
    if start != %r:
        break
    time.sleep(.05)
else: raise TimeoutError('Previous updater process did not exit')
''' % (previous['pid'], previous['start'])
        vm.command('python3 -c ' + shlex.quote(script), timeout=10)

    def wait_ui(name):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if 'up to date' in screen_text(vm, name):
                return
            time.sleep(.1)
        raise TimeoutError('Actual Updates screen did not render: ' + name)

    def work_survives(name, original):
        now = observe(name, 'work')
        for key in ['agents', 'daemon', 'terminal']:
            before = original[key] if key == 'agents' else [original[key]]
            after = now[key] if key == 'agents' else [now[key]]
            assert {(p['pid'], p['start']) for p in before} == {(p['pid'], p['start']) for p in after}, key
            assert all(p['state'] not in ['Z', 'X'] for p in after), key
        assert now['boot_id'] == original['boot_id'] and now['runtime'] == original['runtime']
        assert now['heartbeat'] > original['heartbeat']

    try:
        vm.start(live=True)
        receipt['acceleration'] = vm.acceleration
        vm.wait(r'root@[^\r\n]*[#] ')
        vm.shell_ready = True
        vm.command('stty -echo; nmcli networking off')
        copy_file(vm, json.dumps(config).encode(), '/tmp/install-config.json')
        output, _ = vm.command('harness install --config /tmp/install-config.json --yes-erase-disk', timeout=360)
        (folder / 'install.log').write_text(output)
        vm.command('sync')
        vm.stop()
        vm.start(live=False)
        vm.login_installed(config)
        vm.command('test "$HOME" = /home/me && test -d "$HOME/projects"')
        vm.command('printf %s ' + shlex.quote(config['password'] + '\n') + ' | sudo -S -v')
        vm.command('systemctl --user stop harness-update.timer harness-update.service')
        vm.command('test ! -e ' + STATE + '/ready.json && test ! -e ' + STATE + '/current && test ! -e ' + STATE + '/approved.json')
        vm.command('for n in $(seq 1 90); do pgrep -u 1000 -x opencode >/dev/null && exit 0; sleep .5; done; exit 1', timeout=50)
        copy_file(vm, Path(__file__).with_name('update_pane_guest.py').read_bytes(), GUEST)
        copy_file(vm, PROBE.encode(), '/home/me/update-pane-terminal.py')
        output, _ = vm.command("hn new-window -P -F '#{pane_id}' -n Updates 'python3 /home/me/update-pane-terminal.py' > /tmp/update-pane-terminal-id")
        vm.command('for n in $(seq 1 60); do test -s ~/projects/session-probe/pid && exit 0; sleep .1; done; exit 1')
        terminal = vm.read_file('/tmp/update-pane-terminal-id').decode().strip()
        before = observe('01-original-work', 'work')
        for path, expected in manifest['harness_inputs']['files'].items():
            assert before['runtime']['/usr/lib/harness/' + path] == expected['sha256']
        receipt['original_files'] = {path: hashlib.sha256(vm.read_file(path)).hexdigest() for path in candidates}
        original_opener = vm.read_file(OPENER)
        assert b'select-window -t Updates' in original_opener, 'This baseline fixture requires the legacy name-only adapter'
        (folder / 'original-open-updates').write_bytes(original_opener)
        vm.keys('meta_l', 'u')
        vm.command('timeout 5 sh -c \'until test -s ' + STATE + '/request.json; do sleep .05; done\'')
        baseline = observe('02-baseline-name-collision')
        assert not baseline['screens'] and baseline['request_pending'], baseline
        terminal_pane = next(p for p in baseline['panes'] if p['pane'] == terminal)
        assert terminal_pane['pane_active'] == '1' and terminal_pane['window_active'] == '1'

        def focus_terminal():
            vm.command('hn select-window -t ' + shlex.quote(terminal_pane['window']) +
                       ' && hn select-pane -t ' + shlex.quote(terminal))

        vm.screenshot('02-baseline-name-collision')
        receipt['checks'].append('Original image adapter loses Super+u to the unrelated Updates terminal; no updater process exists and request remains pending.')

        # Real UI with deterministic, private release input: version 0.0.0
        # cannot activate anything. A missing OS channel is a normal 404.
        vm.command('mkdir -p /home/me/update-pane-feed')
        ref = dict(url='http://127.0.0.1:19447/unused', sha256='0' * 64, size=1)
        feeds = {'hn': {'version': '0.0.0', 'builds': {'linux-x64': ref}},
                 'cli': {'cli': {'version': '0.0.0', 'cli': ref, 'notify': ref}}}
        for name, value in feeds.items():
            copy_file(vm, json.dumps(value).encode(), '/home/me/update-pane-feed/' + name + '.json')
        vm.command('systemd-run --user --collect --unit=harness-test-feed python3 -m http.server 19447 --bind 127.0.0.1 --directory /home/me/update-pane-feed')
        vm.command('for n in $(seq 1 30); do curl -fsS http://127.0.0.1:19447/hn.json && exit 0; sleep .1; done; exit 1')
        candidate = candidates[UPDATER].read_text()
        fixture = candidate
        for component, filename in [('tui', 'hn'), ('cli', 'cli')]:
            address = "'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/" + component + "/metadata.json'"
            assert fixture.count(address) == 1
            fixture = fixture.replace(address, "'http://127.0.0.1:19447/" + filename + ".json'")
        marker = 'release = module.discover()'
        assert fixture.count(marker) == 1
        fixture = fixture.replace(marker, "release = module.discover('http://127.0.0.1:19447/no-os-channel.json')")
        # Hold the *same* process alive after the real close decision released
        # open.lock and removed its registration. No close result is forged.
        trace = '''
_observed_consume_request = consume_request
_observed_read = read
_observed_consuming = None
def read(path, *args, **kwargs):
    value = _observed_read(path, *args, **kwargs)
    if _observed_consuming is not None and path == STATE / 'request.json':
        _observed_consuming.append(value)
    return value

def consume_request():
    global _observed_consuming
    gate = Path('/tmp/update-pane-route-gate')
    target = gate.read_text().strip() if gate.exists() else None
    token = os.environ.get('HARNESS_UPDATE_INSTANCE')
    before = read(STATE / 'request.json', {})
    if target and token == target:
        armed = Path('/tmp/update-pane-route-armed.json')
        if not armed.exists():
            write(armed, dict(pid=os.getpid(), token=token, at=time.monotonic(),
                start=(PROC / str(os.getpid()) / 'stat').read_text().rsplit(')', 1)[1].split()[19]))
        deadline = time.monotonic() + 10
        while not Path('/tmp/update-pane-route-rejected.json').exists():
            if time.monotonic() >= deadline:
                write(Path('/tmp/update-pane-route-error.json'), dict(pid=os.getpid(), token=token,
                    target=target, before=before, reason='Direct inspection did not reject targeted request'))
                raise TimeoutError('Direct inspection did not reject targeted request')
            time.sleep(.05)
    locked_reads = []
    _observed_consuming = locked_reads
    try:
        claimed = _observed_consume_request()
    finally:
        _observed_consuming = None
    after = read(STATE / 'request.json', {})
    if target and (token == target or any(isinstance(value, dict) and value.get('target') == target for value in locked_reads)):
        kind = 'claimed' if token == target else 'rejected'
        path = Path('/tmp/update-pane-route-' + kind + '.json')
        if not path.exists():
            write(path, dict(pid=os.getpid(), token=token, before=before, after=after,
                locked_reads=locked_reads, claimed=claimed, at=time.monotonic()))
    return claimed

_observed_close_screen = close_screen
def close_screen():
    closed = _observed_close_screen()
    hold = Path('/tmp/update-pane-hold-close')
    if closed and hold.exists() and hold.read_text().strip() == str(os.getpid()):
        Path('/tmp/update-pane-close-committed').write_text(str(os.getpid()))
        deadline = time.monotonic() + 30
        while not Path('/tmp/update-pane-release-close').exists() and time.monotonic() < deadline:
            time.sleep(.05)
    return closed

'''
        assert fixture.count("if __name__ == '__main__':") == 1
        fixture = fixture.replace("if __name__ == '__main__':", trace + "if __name__ == '__main__':")
        compile(fixture, 'observed-live-update.py', 'exec')
        (folder / 'observed-live-update.py').write_text(fixture)
        receipt['private_observer'] = dict(sha256=hashlib.sha256(fixture.encode()).hexdigest(),
            differences=['hn and CLI feed URLs use loopback version 0.0.0 metadata.',
                         'OS discovery receives its supported explicit loopback feed argument; endpoint returns 404.',
                         'Before one shortcut, owned consume acknowledges the target gate independently of request presence, then waits up to the same 10 seconds for actual direct rejection. Both real helper outcomes and their in-lock request reads are retained.',
                         'After real close_screen returns True, one selected test process waits for release, at most 30 seconds.'])
        copy_file(vm, fixture.encode(), '/tmp/update-pane-ui.py')
        copy_file(vm, candidates[OPENER].read_bytes(), '/tmp/update-pane-opener')
        copy_file(vm, candidates[WRAPPER].read_bytes(), '/tmp/update-pane-wrapper')
        vm.command('sudo install -m 644 /tmp/update-pane-ui.py ' + UPDATER +
                   ' && sudo install -m 755 /tmp/update-pane-opener ' + OPENER +
                   ' && sudo install -m 755 /tmp/update-pane-wrapper ' + WRAPPER + ' && sudo nmcli networking off')
        assert hashlib.sha256(vm.read_file(OPENER)).hexdigest() == receipt['candidates'][OPENER]['sha256']
        assert hashlib.sha256(vm.read_file(WRAPPER)).hexdigest() == receipt['candidates'][WRAPPER]['sha256']
        assert hashlib.sha256(vm.read_file(UPDATER)).hexdigest() == receipt['private_observer']['sha256']
        vm.keys('meta_l', 'u')
        first, owner = wait_active('03-owned-updater')
        wait_ui('03-owned-updater')
        assert owner['pane'] != terminal
        receipt['checks'].append('Super+u opens a real registered Updates UI beside the unrelated named terminal, and it consumes the request.')
        for index in range(3):
            focus_terminal()
            vm.keys('meta_l', 'u')
            wait_active('04-repeated-shortcut-' + str(index), owner)
        pane = next(p for p in first['panes'] if p['pane'] == owner['pane'])
        vm.command('hn rename-window -t ' + shlex.quote(pane['window']) + ' Versions')
        focus_terminal()
        vm.keys('meta_l', 'u')
        before_restart, _ = wait_active('05-renamed-updater', owner)
        receipt['checks'].append('Repeated Super+u and a renamed updater reuse its same PID/start time and pane rather than creating duplicate tabs.')

        vm.command('systemctl --user restart hn-screen.service; /usr/lib/harness-os/wait-runtime', timeout=90)
        focus_terminal()
        vm.keys('meta_l', 'u')
        resumed, _ = wait_active('06-renderer-reconnected', owner)
        previous_pane = next(p for p in before_restart['panes'] if p['pane'] == owner['pane'])
        resumed_pane = next(p for p in resumed['panes'] if p['pane'] == owner['pane'])
        old_renderer, new_renderer = before_restart['renderer'], resumed['renderer']
        receipt['renderer_restart'] = renderer_replaced(old_renderer, new_renderer,
            manifest['harness_inputs']['files']['harness-tui']['sha256'])
        for key in ['pane', 'window', 'start_command', 'token']:
            assert previous_pane[key] == resumed_pane[key], (key, previous_pane, resumed_pane)
        receipt['renderer_restart'].update(launch_before=previous_pane['start_command'],
                                           launch_after=resumed_pane['start_command'], owner=owner)
        receipt['socket_handover'] = dict(process_environment=owner['primary_socket'],
                                         before=pane['socket'], after=resumed_pane['socket'])
        wait_ui('06-renderer-reconnected')
        work_survives('06-work-preserved', before)
        receipt['checks'].append('A new renderer PID/start with the exact frozen executable restores the same quoted launch, pane and active updater lease; work survives without requiring HN_SOCKET or a particular socket alias name.')

        vm.command('kill -TERM ' + str(owner['pid']))
        wait_gone(owner)
        vm.command('test ! -e ' + STATE + '/request.json')
        vm.command("hn new-window -P -F '#{pane_id}' -n Manual '/usr/bin/harness updates; sleep 120' > /tmp/update-pane-manual-caller")
        manual, owner = wait_active('07-manual-view')
        caller = vm.read_file('/tmp/update-pane-manual-caller').decode().strip()
        assert owner['pane'] != caller and any(p['pane'] == caller for p in manual['panes']), manual
        vm.command('test ! -e ' + STATE + '/request.json')
        focus_terminal()
        vm.keys('meta_l', 'u')
        wait_active('07-manual-view-reused', owner)
        wait_ui('07-manual-view-reused')
        receipt['checks'].append('Manual harness updates opens an owned inspection pane without an apply request, preserves its caller terminal, and the next Super+u reuses that same actual UI process.')

        # A valid headless endpoint is not a visible client. Manual inspection
        # must remain on its caller's real terminal and never consume another
        # screen's targeted shortcut. Use a separate private hn namespace.
        vm.command("hn -L update-pane-headless new-session -d -s inspection 'sleep 120' && "
                   "hn -L update-pane-headless display-message -p '#{socket_path}' > /tmp/update-pane-headless-socket")
        headless = vm.read_file('/tmp/update-pane-headless-socket').decode().strip()
        assert headless.startswith('/') and '\n' not in headless, headless
        headless_command = 'hn -S ' + shlex.quote(headless)
        vm.command(headless_command + " hn-list-clients -F '#{client_tty}' > /tmp/update-pane-headless-clients && " +
                   headless_command + " list-panes -s -F '#{pane_id}' > /tmp/update-pane-headless-before")
        assert not vm.read_file('/tmp/update-pane-headless-clients').strip()
        default_socket = next(p for p in manual['panes'] if p['pane'] == owner['pane'])['socket']
        vm.command('hn -S ' + shlex.quote(default_socket) + " new-window -P -F '#{pane_id}' -n Inspection " +
                   shlex.quote('env HN_SOCKET=' + headless + ' /usr/bin/harness updates; sleep 120') +
                   ' > /tmp/update-pane-inspection-caller')
        inspection_pane = vm.read_file('/tmp/update-pane-inspection-caller').decode().strip()
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            inspected = observe('07-direct-inspection')
            direct = [p for p in inspected['screens'] if p['registration'] is None and p['token'] is None]
            if len(direct) == 1:
                inspection = direct[0]
                assert inspection['primary_socket'] == headless
                assert inspection['group'] == inspection['foreground'] and inspection['stdin'].startswith('/dev/pts/')
                visible = next(p for p in inspected['panes'] if p['pane'] == inspection_pane)
                assert visible['pane_active'] == '1' and visible['window_active'] == '1'
                break
            time.sleep(.1)
        else:
            raise TimeoutError('Manual inspection did not stay in its caller terminal')
        wait_ui('07-direct-inspection')
        vm.command(headless_command + " list-panes -s -F '#{pane_id}' > /tmp/update-pane-headless-after")
        assert vm.read_file('/tmp/update-pane-headless-before') == vm.read_file('/tmp/update-pane-headless-after')
        assert not inspected['request_pending']
        vm.command('printf %s ' + owner['token'] + ' > /tmp/update-pane-route-gate')
        vm.command("timeout 5 sh -c 'until test -s /tmp/update-pane-route-armed.json; do sleep .05; done'")
        armed = json.loads(vm.read_file('/tmp/update-pane-route-armed.json'))
        assert (armed['pid'], armed['start'], armed['token']) == (owner['pid'], owner['start'], owner['token']), armed
        vm.command('test ! -e ' + STATE + '/request.json')
        (folder / '07-target-gate-armed.json').write_text(json.dumps(armed, indent=2) + '\n')
        focus_terminal()
        vm.keys('meta_l', 'u')
        delivered, _ = wait_active('07-targeted-delivery', owner)
        vm.command("timeout 5 sh -c 'until test -s /tmp/update-pane-route-rejected.json && "
                   "test -s /tmp/update-pane-route-claimed.json; do sleep .05; done'")
        evidence = {kind: json.loads(vm.read_file('/tmp/update-pane-route-' + kind + '.json'))
                    for kind in ['rejected', 'claimed']}
        rejected, claimed = evidence['rejected'], evidence['claimed']
        assert rejected['pid'] == inspection['pid'] and rejected['token'] is None and rejected['claimed'] is False
        assert claimed['pid'] == owner['pid'] and claimed['token'] == owner['token'] and claimed['claimed'] is True
        assert len(rejected['locked_reads']) == len(claimed['locked_reads']) == 1
        assert rejected['locked_reads'] == claimed['locked_reads'] and claimed['locked_reads'][0]['target'] == owner['token']
        assert armed['at'] <= rejected['at'] <= claimed['at'] and claimed['after'] == {}
        assert not delivered['request_pending']
        assert any(p['pid'] == inspection['pid'] and p['start'] == inspection['start'] and p['registration'] is None
                   for p in delivered['screens'])
        (folder / '07-targeted-delivery-outcomes.json').write_text(json.dumps(evidence, indent=2) + '\n')
        receipt['headless_inspection'] = dict(socket=headless, caller_pane=inspection_pane, process=inspection,
                                             pane_ids=vm.read_file('/tmp/update-pane-headless-after').decode())
        vm.command('rm /tmp/update-pane-route-gate')
        vm.command('kill -TERM ' + str(inspection['pid']))
        wait_gone(inspection)
        receipt['checks'].append('A manual view with a valid headless socket stays in its current PTY without creating a hidden pane or an apply request. While it remains alive, its real consume rejects the targeted shortcut before the selected owner claims that exact request.')

        vm.command('printf %s ' + str(owner['pid']) + ' > /tmp/update-pane-hold-close')
        vm.keys('esc')
        vm.command('timeout 5 sh -c \'until test -s /tmp/update-pane-close-committed; do sleep .05; done\'')
        closing = observe('08-close-committed-process-alive')
        old = next(p for p in closing['screens'] if p['pid'] == owner['pid'])
        assert old['registration'] is None and old['start'] == owner['start'] and old['state'] not in ['Z', 'X'], closing
        vm.keys('meta_l', 'u')
        replacement, replacement_owner = wait_active('09-closing-screen-replaced')
        old = next(p for p in replacement['screens'] if p['pid'] == owner['pid'])
        assert old['registration'] is None and old['start'] == owner['start'] and old['state'] not in ['Z', 'X'], replacement
        assert replacement_owner['pid'] != owner['pid'] and replacement_owner['pane'] != owner['pane']
        vm.screenshot('09-closing-screen-replaced')
        vm.command('touch /tmp/update-pane-release-close')
        receipt['checks'].append('A real Escape commits closing and unregisters; while the same Python PID remains alive, Super+u opens one replacement that consumes its request.')

        focus_terminal()
        vm.type_probe('ownership-input-survives')
        vm.keys('ret')
        vm.command("timeout 5 sh -c 'until grep -Fx ownership-input-survives ~/projects/session-probe/input; do sleep .1; done'")
        vm.screenshot('10-original-terminal-input')
        work_survives('10-final-work-preserved', before)
        receipt['checks'].append('Original named terminal accepts actual QMP keyboard input; its heartbeat, OpenCode, daemon and boot identities survive, and frozen runtime hashes are unchanged.')
        receipt['status'] = 'passed'
    except BaseException as error:
        receipt.update(status='failed', error=repr(error))
        if vm.process and vm.process.poll() is None:
            receipt['partial_route_evidence'] = {}
            for name in ['gate', 'armed.json', 'rejected.json', 'claimed.json', 'error.json']:
                path = '/tmp/update-pane-route-' + name
                try:
                    _, status = vm.command('test -f ' + shlex.quote(path), timeout=5, check=False)
                    record = {'present': status == 0}
                    if status == 0:
                        content = vm.read_file(path)
                        (folder / ('failure-route-' + name)).write_bytes(content)
                        record.update(bytes=len(content), sha256=hashlib.sha256(content).hexdigest())
                    receipt['partial_route_evidence'][path] = record
                except Exception as collection_error:
                    receipt['partial_route_evidence'][path] = {'collection_error': repr(collection_error)}
            try:
                vm.screenshot('failure')
                output, _ = vm.command('journalctl --user -n 150 --no-pager; hn list-panes -a -F "#{pane_id} #{pane_pid} #{pane_dead} #{window_name} #{socket_path}"', timeout=15, check=False)
                (folder / 'failure.log').write_text(output)
            except Exception:
                pass
        raise
    finally:
        receipt['finished_at'] = time.time()
        (folder / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        vm.stop()
        vm.log.close()
        vm.stderr.close()
        vm.control.cleanup()


if __name__ == '__main__':
    main()
