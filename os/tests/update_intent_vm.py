#!/usr/bin/env python3
"""Private ARM acceptance for one active UI intent across real update contention.

Consumes existing immutable images/releases. It does not build shared clients,
exercise a privileged base upgrade, or establish physical hardware support.
"""
import argparse
from functools import partial
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import platform
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time

from arm_boot import digest
from arm_session import ROOT, SessionVM, failure_evidence, fixture_identity
from arm_update_vm import prepare_updates, update_identity
from session_vm import PROBE, put

IMAGE_SOURCE = '68c3bdf577c78766c961e245bac275cd070db016'
IMAGE_MANIFEST = '4f23d5f32b24fd92e84b1db80ac84ac9d77dfe76a5a6df2ce99e36bc580a881b'
UPDATE_SOURCE = 'b09174a2433d58ceb5c1871ccdf2c87b3902117a'
UPDATE_MANIFEST = '1a017fef6a2171ad11d87239dee0d060cedfa20a0b1a437d38b7c9ad4bed2f4e'
FOLDER = '/home/me/.local/state/harness-os/intent-fixture'
STATE = '/home/me/.local/state/harness-os/updates'
GUEST = FOLDER + '/guest.py'
UPDATER = '/usr/lib/harness-os/live_update.py'
BUSY = '{"harness_update_worker":1,"status":"busy"}\n'
OWNERSHIP_SOURCE = '0de712afa23cb10bf9ab096dec933a9828767fe3'
INPUTS = [
    'os/live_update.py', 'os/root/usr/bin/harness', 'os/root/usr/lib/harness-os/open-updates',
    'os/root/usr/lib/harness-os/screen-action',
    'os/root/usr/lib/systemd/user/harness-update.service',
    'os/root/usr/lib/systemd/user/harness-update.timer', 'os/root/usr/share/harness-os/labwc/rc.xml',
    'os/tests/update_intent_vm.py', 'os/tests/update_intent_guest.py', 'os/tests/update_intent_observer.py',
    'os/tests/arm_update_vm.py', 'os/tests/arm_session.py', 'os/tests/arm_boot.py',
    'os/tests/fast_update_vm.py', 'os/tests/session_vm.py', 'os/tests/vm.py', 'os/tools/fedora_payload.py',
]


class ObserverBarrierError(RuntimeError):
    """A scheduling precondition was not established; no contention claim."""


def observed_source(candidate):
    marker = "if __name__ == '__main__':"
    if candidate.count(marker) != 1:
        raise ValueError('The updater entrypoint changed; review the private observer insertion')
    # Only feed selection is changed here. The scheduling hook is a separate,
    # independently hashed file, never part of the product payload.
    insertion = ("FEEDS = read(Path(" + repr(FOLDER + '/ui-feeds.json') + "))\n"
                 "import runpy\nrunpy.run_path(" + repr(FOLDER + '/observer.py') +
                 ")['install'](globals(), " + repr(FOLDER) + ")\n\n")
    return candidate.replace(marker, insertion + marker)


def assert_work(before, after, expected_input):
    for key in ['agents', 'daemon', 'terminal', 'project', 'boot', 'bundled', 'runtime_identity_sha256']:
        if before[key] != after[key]:
            raise AssertionError('Live work or bundled runtime changed: ' + key)
    assert after['heartbeat'] != before['heartbeat'], 'Terminal heartbeat stopped'
    assert after['input'] == expected_input, after['input']
    assert {item['session'] for item in before['clients']} == {item['session'] for item in after['clients']}


def ui_owner(state, event):
    """Join the actual launch token to its active lease and pinned hn pane."""
    token = event['token']
    assert isinstance(token, str) and re.fullmatch(r'[0-9a-f]{32}', token), event
    identity = (event['pid'], event['start'])
    uis = [ui for ui in state['uis'] if (ui['pid'], ui['start']) == identity]
    assert len(uis) == 1, uis
    ui = uis[0]
    assert ui['token'] == token and ui['group'] == ui['foreground'] and ui['stdin'].startswith('/dev/pts/'), ui
    assert ui['argv'] == ['/usr/bin/python3', UPDATER, 'screen'], ui
    ownership = state['ownership']
    registrations = [record for record in ownership['registrations'] if record.get('token') == token]
    assert registrations == [dict(pid=event['pid'], start=event['start'], token=token, boot_id=state['boot'])], registrations
    panes = [pane for pane in ownership['panes'] if pane['token'] == token]
    assert len(panes) == 1, panes
    pane = panes[0]
    assert pane['launch'] == ('"exec env HARNESS_UPDATE_INSTANCE=' + token +
                              ' /usr/bin/python3 ' + UPDATER + ' screen"'), pane
    assert re.fullmatch(r'%\d+', pane['pane']) and re.fullmatch(r'@\d+', pane['window']) and pane['dead'] == '0', pane
    assert ownership['socket'].startswith('/') and ownership['active'] == pane['pane'], ownership
    return dict(event, socket=ownership['socket'], pane=pane['pane'], window=pane['window'],
                launch=pane['launch'], process=ui)


def renderer_replaced(before, after):
    assert len(before['clients']) == len(after['clients']) == 1, (before['clients'], after['clients'])
    old, new = before['clients'][0], after['clients'][0]
    assert old['session'] == new['session'], (old, new)
    old, new = old['process'], new['process']
    assert (old['pid'], old['start']) != (new['pid'], new['start']), (old, new)
    assert old['executable'] == before['selected'] + '/harness-tui', old
    assert new['executable'] == after['selected'] + '/harness-tui', new
    assert old['executable'] != new['executable'], (old, new)
    return dict(before=old, after=new)


def pane_windows(raw, separator):
    rows = [line.split(separator) for line in raw.splitlines()]
    assert rows and all(len(row) == 2 and re.fullmatch(r'%\d+', row[0]) and
                        re.fullmatch(r'@\d+', row[1]) for row in rows), rows
    assert len({row[0] for row in rows}) == len(rows), rows
    return dict(rows)


def captured_text(path, timeout):
    from PIL import Image, ImageOps
    readable = path.with_name(path.stem + '-ocr.png')
    with Image.open(path) as original:
        image = ImageOps.invert(original.convert('L')).resize((original.width * 2, original.height * 2))
        ImageOps.expand(image, border=24, fill=255).save(readable)
    result = subprocess.check_output(['tesseract', str(readable), 'stdout', '--psm', '11'],
                                     text=True, stderr=subprocess.DEVNULL, timeout=timeout)
    path.with_suffix('.txt').write_text(result)
    return ' '.join(result.casefold().split())


def exercise(machine, image, release, receipt, output, updates_url):
    # Stop only the disposable fixture's checker before its two-minute startup.
    machine.wait_user('test -S /run/user/1000/bus', 30)
    machine.user('systemctl --user stop harness-update.timer harness-update.service')
    machine.wait_user('test -f ~/.local/state/harness-os/onboarded && pgrep -u 1000 -x opencode >/dev/null', 150)
    machine.frame('01-original-agent', ['OpenCode', 'Ask anything'], 90)
    machine.user('test "$HOME" = /home/me && test -d ~/projects && test ! -e ' + FOLDER +
                 ' && mkdir -m 700 ' + FOLDER + ' && mkdir ' + FOLDER + '/assets')
    put(machine, GUEST, (ROOT / 'os/tests/update_intent_guest.py').read_text())
    put(machine, FOLDER + '/observer.py', (ROOT / 'os/tests/update_intent_observer.py').read_text())
    put(machine, FOLDER + '/probe.py', PROBE)
    receipt['transferred_payloads'] = {}
    for name, checksum in release['files'].items():
        destination = FOLDER + '/assets/' + name
        machine.user('curl --fail --silent --show-error --max-time 30 ' +
                     shlex.quote(updates_url + '/' + name) + ' -o ' + shlex.quote(destination), timeout=35)
        machine.user('sha256sum ' + shlex.quote(destination) + ' > ' + FOLDER + '/transferred-sha256')
        actual = machine.read_file(FOLDER + '/transferred-sha256').decode().split()[0]
        receipt['transferred_payloads'][name] = actual
        if actual != checksum:
            raise ValueError('Private release transfer changed: ' + name)
    machine.user('cp ' + FOLDER + '/assets/feeds-hn.json ' + FOLDER + '/ui-feeds.next && mv ' +
                 FOLDER + '/ui-feeds.next ' + FOLDER + '/ui-feeds.json')

    def control(name, value):
        # Live observer/HTTP readers must see the old or new complete document.
        put(machine, FOLDER + '/' + name + '.next', json.dumps(value))
        machine.command('mv -f -- ' + shlex.quote(FOLDER + '/' + name + '.next') + ' ' + shlex.quote(FOLDER + '/' + name))

    control('gate.json', dict(token='transport', path=None))
    machine.user('hn new-window -P -F ' + shlex.quote('#{pane_id}') +
                 ' -n intent-work ' + shlex.quote('python3 ' + FOLDER + '/probe.py') +
                 ' > ' + FOLDER + '/terminal-pane')
    pane = machine.read_file(FOLDER + '/terminal-pane').decode().strip()
    machine.user('python3 ' + GUEST + ' format-probe')
    probe_bytes = machine.read_file(FOLDER + '/format-probe.json')
    (output / 'pre-overlay-direct-format.json').write_bytes(probe_bytes)
    probe = json.loads(probe_bytes)
    # A literal Tab sent through the interactive serial shell can be consumed
    # by readline before hn sees argv. These numeric IDs cannot contain '|'.
    serial_format = '#{pane_id}|#{window_id}'
    machine.user('hn -S ' + shlex.quote(probe['socket']) + ' list-panes -s -F ' +
                 shlex.quote(serial_format) + ' > ' + FOLDER + '/terminal-rows')
    serial_bytes = machine.read_file(FOLDER + '/terminal-rows')
    (output / 'pre-overlay-serial-format.txt').write_bytes(serial_bytes)
    receipt['pre_overlay_formats'] = dict(direct=probe, serial_format=serial_format,
                                         serial_raw=serial_bytes.decode())
    windows = pane_windows(serial_bytes.decode(), '|')
    assert windows == pane_windows(probe['raw'], '\t'), receipt['pre_overlay_formats']
    window = windows[pane]
    assert re.fullmatch(r'%\d+', pane) and re.fullmatch(r'@\d+', window), (pane, window)
    machine.wait_user('test -s ~/projects/session-probe/pid && test -s ~/projects/session-probe/heartbeat')
    machine.user('printf %s intent-project-preserved > ~/projects/session-probe/proof.txt')
    receipt['terminal'] = dict(pane=pane, window=window)
    inputs = []

    def guest(action, *args, **kwargs):
        return machine.user('python3 ' + GUEST + ' ' + ' '.join(shlex.quote(value) for value in (action, *args)), **kwargs)

    def snapshot(name):
        guest('snapshot', name)
        data = machine.read_file(FOLDER + '/' + name + '.json')
        (output / (name + '.json')).write_bytes(data)
        return json.loads(data)

    def wait_file(name, seconds=10):
        try:
            machine.wait_user('test -s ' + shlex.quote(FOLDER + '/' + name), seconds)
        except (RuntimeError, TimeoutError) as error:
            raise ObserverBarrierError('Private scheduling barrier was not reached: ' + name) from error

    def wait_event(phase, kind, pending=None):
        command = 'python3 ' + GUEST + ' event ' + shlex.quote(phase) + ' ' + shlex.quote(kind)
        if pending is not None:
            command += ' --pending ' + ('true' if pending else 'false')
        machine.wait_user(command, 8)

    def wait_checker(phase, seconds=45):
        machine.wait_user('test -s ' + STATE + '/ready.json && python3 ' + GUEST +
                         ' checker-complete ' + shlex.quote(phase), seconds)
        data = machine.read_file(FOLDER + '/' + phase + '-checker.json')
        (output / (phase + '-checker.json')).write_bytes(data)
        receipt.setdefault('checker_results', {})[phase] = json.loads(data)

    def type_work(name):
        machine.user('hn select-window -t ' + shlex.quote(window) + ' && hn select-pane -t ' + shlex.quote(pane))
        machine.frame(name + '-before-input', 'VISIBLE LOCK PROBE', 15)
        machine.type_probe(name)
        machine.keys('ret')
        inputs.append(name + '\n')
        machine.wait_user('grep -Fx ' + shlex.quote(name) + ' ~/projects/session-probe/input', 10)
        machine.screenshot(name + '-accepted-input')

    type_work('before-contention')
    before = snapshot('02-original-work')
    assert before['selected'] == '/usr/lib/harness' and not before['ready'] and not before['transaction']
    assert before['bundled'] == {name: item['sha256'] for name, item in image['package']['runtime']['files'].items()}
    assert before['runtime_identity_sha256'] == image['payload']['files']['usr/share/harness-os/runtime.json']
    receipt['candidate_files'] = prepare_updates(machine)
    # Manual inspection exercises this public entrypoint too. It must come
    # from the reconciled candidate, not silently remain the image's version.
    command_source = 'os/root/usr/bin/harness'
    put(machine, '/usr/bin/harness', (ROOT / command_source).read_text())
    machine.command('chmod 755 /usr/bin/harness')
    actual = hashlib.sha256(machine.read_file('/usr/bin/harness')).hexdigest()
    assert actual == digest(ROOT / command_source), command_source
    receipt['candidate_files'][command_source] = actual
    candidate = (ROOT / 'os/live_update.py').read_text()
    observed = observed_source(candidate)
    (output / 'candidate-live_update.py').write_text(candidate)
    (output / 'observed-live_update.py').write_text(observed)
    shutil.copyfile(ROOT / 'os/tests/update_intent_observer.py', output / 'scheduling-observer.py')
    put(machine, UPDATER, observed)
    observed_hash = hashlib.sha256(observed.encode()).hexdigest()
    assert hashlib.sha256(machine.read_file(UPDATER)).hexdigest() == observed_hash
    receipt['private_observer'] = dict(candidate_sha256=digest(ROOT / 'os/live_update.py'),
        observed_sha256=observed_hash, scheduling_sha256=digest(ROOT / 'os/tests/update_intent_observer.py'),
        differences=['FEEDS reads the verified local fixture map at process startup.',
                     'Read-only request/lock/UI/worker event logging; real request and worker results remain unchanged.',
                     'Pause one targeted claim until a direct inspection actually polls it, then pause one real worker invocation for the separate lock race.'])
    machine.command('nmcli networking off')
    guest('transport', timeout=110)
    (output / 'transport.json').write_bytes(machine.read_file(FOLDER + '/transport.json'))
    receipt['checks'].append('Real systemd-run propagates worker Busy marker+75; real validation failure, arbitrary75, marker+1 and failed command launch remain distinct.')
    machine.user('systemd-run --user --collect --unit=harness-intent-feed python3 ' + GUEST + ' serve')
    machine.wait_user('curl -fsS http://127.0.0.1:19447/feeds-hn.json >/dev/null', 10)
    service = '/home/me/.config/systemd/user/harness-update.service.d'
    timer = '/home/me/.config/systemd/user/harness-update.timer.d'
    machine.user('mkdir -p ' + service + ' ' + timer)
    put(machine, service + '/intent-fixture.conf', '[Service]\nExecStart=\nExecStart=/usr/bin/python3 ' +
        UPDATER + ' check --feeds ' + FOLDER + '/feeds.json\n')
    put(machine, timer + '/intent-fixture.conf', '[Timer]\nOnStartupSec=\nOnUnitInactiveSec=\nOnActiveSec=\n'
        'OnActiveSec=1s\nRandomizedDelaySec=0\nAccuracySec=100ms\n')
    machine.user('systemctl --user daemon-reload')

    def waiting_frame(name):
        # A lock event precedes the curses redraw. Require a real framebuffer
        # containing the waiting state while the real lock remains held.
        deadline = time.monotonic() + 5
        sample = 0
        while time.monotonic() < deadline:
            sample += 1
            captured = name + '-' + str(sample)
            machine.screenshot(captured)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ObserverBarrierError('Private waiting-frame capture budget expired: ' + name)
            try:
                visible = captured_text(machine.folder / (captured + '.png'), remaining)
            except subprocess.TimeoutExpired as error:
                raise ObserverBarrierError('Private waiting-frame OCR budget expired: ' + name) from error
            if 'waiting for the current update' in visible:
                receipt.setdefault('waiting_frames', []).append(captured + '.png')
                return
        raise AssertionError('No visible waiting frame while the update lock was held: ' + name)

    def begin(phase, asset, feeds):
        machine.user('systemctl --user stop harness-update.timer harness-update.service')
        machine.user('cp ' + FOLDER + '/assets/' + feeds + ' ' + FOLDER + '/feeds.next && mv ' +
                     FOLDER + '/feeds.next ' + FOLDER + '/feeds.json && cp ' +
                     FOLDER + '/feeds.json ' + FOLDER + '/ui-feeds.next && mv ' +
                     FOLDER + '/ui-feeds.next ' + FOLDER + '/ui-feeds.json')
        control('gate.json', dict(token=phase, path='/' + asset))
        machine.user('systemctl --user restart harness-update.timer')
        wait_file(phase + '-http-entered.json')
        held = snapshot(phase + '-timer-held')
        assert held['lock']['blocked'] and len(held['lock']['owners']) == 1, held['lock']
        owner = held['lock']['owners'][0]['process']
        assert '/harness-update.service' in owner['cgroup'] and 'check' in owner['argv'], owner
        return held

    def release_http(phase):
        machine.user('touch ' + FOLDER + '/' + phase + '-http-release')
        wait_file(phase + '-http-released.json')

    def ui_waiting(phase, pending, transaction=None):
        wait_event(phase, 'lock-busy', pending)
        waiting_frame(phase + '-waiting')
        state = snapshot(phase + '-ui-waiting')
        owners = [event for event in state['events'] if event['phase'] == phase and
                  event['event'] == 'lock-busy' and event['pending'] is pending]
        owner = ui_owner(state, owners[-1])
        assert not state['request'] and state['lock']['blocked'] and state['transaction'] == transaction
        return owner

    def close_ui(phase, owner):
        machine.keys('esc')
        wait_event(phase, 'screen-exit', False)
        machine.wait_user('test ! -d /proc/' + str(owner['pid']), 8)

    begin('inspection', 'harness-tui', 'feeds-hn.json')
    machine.user("hn new-window -n intent-inspection 'exec /usr/bin/harness updates'")
    inspecting = ui_waiting('inspection', False)
    release_http('inspection')
    wait_checker('inspection')
    machine.frame('03-inspection-only', 'Update available', 15)
    inspected = snapshot('03-inspection-only')
    assert inspected['selected'] == before['selected'] and not inspected['transaction'] and not inspected['request']
    assert_work(before, inspected, ''.join(inputs))
    close_ui('inspection', inspecting)
    # A real current-terminal inspection remains alive to compete for polls.
    # It has no launch token and must reject a request addressed to another UI.
    machine.user('hn new-window -P -F ' + shlex.quote('#{pane_id}') + ' -n intent-direct ' +
                 shlex.quote('exec env -u HARNESS_UPDATE_INSTANCE /usr/bin/python3 ' + UPDATER + ' screen') +
                 ' > ' + FOLDER + '/direct-pane')
    direct_pane = machine.read_file(FOLDER + '/direct-pane').decode().strip()
    assert re.fullmatch(r'%\d+', direct_pane), direct_pane
    machine.frame('03-direct-inspection', 'Update available', 15)
    direct_state = snapshot('03-direct-inspection')
    direct_screens = [event for event in direct_state['events'] if event['event'] == 'screen-enter' and event['token'] is None]
    assert len(direct_screens) == 1 and direct_screens[0]['pending'] is False, direct_screens
    direct = direct_screens[0]
    direct_processes = [ui for ui in direct_state['uis'] if (ui['pid'], ui['start']) == (direct['pid'], direct['start'])]
    assert len(direct_processes) == 1 and direct_processes[0]['token'] is None
    assert direct_state['ownership']['active'] == direct_pane
    direct_rows = [row for row in direct_state['ownership']['panes'] if row['pane'] == direct_pane]
    assert len(direct_rows) == 1, direct_rows
    direct_window = direct_rows[0]['window']
    assert not any(record['pid'] == direct['pid'] for record in direct_state['ownership']['registrations'])
    receipt['direct_inspection'] = dict(event=direct, process=direct_processes[0], pane=direct_pane, window=direct_window)
    guest('reset-staged')
    receipt['checks'].append('Real timer holds the updater flock during an HTTP payload barrier; plain Updates inspection stays non-activating after staging.')

    begin('shortcut', 'harness-tui', 'feeds-hn.json')
    machine.user('touch ' + FOLDER + '/worker-arm ' + FOLDER + '/claim-arm')
    machine.keys('meta_l', 'u')
    wait_file('direct-poll.json', 7)
    direct_poll = json.loads(machine.read_file(FOLDER + '/direct-poll.json'))
    receipt['direct_poll'] = direct_poll
    assert direct_poll['pid'] == direct['pid'] and direct_poll['token'] is None and direct_poll['result'] is False, direct_poll
    assert direct_poll['before'] == direct_poll['after'], direct_poll
    assert direct_poll['locked_reads'] == [direct_poll['before']], direct_poll
    updating = ui_waiting('shortcut', True)
    assert direct_poll['before']['target'] == updating['token']
    release_http('shortcut')
    wait_event('shortcut', 'worker-gate', True)
    wait_checker('shortcut', 8)
    machine.user('systemd-run --user --collect --unit=harness-intent-lock python3 ' + GUEST + ' hold apply-gap')
    wait_file('apply-gap-lock-held.json')
    machine.user('touch ' + FOLDER + '/worker-go')
    wait_event('shortcut', 'worker-result', True)
    wait_event('shortcut', 'screen-enter', True)
    gap = snapshot('04-worker-contention')
    results = [event for event in gap['events'] if event['phase'] == 'shortcut' and event['event'] == 'worker-result']
    assert len(results) == 1 and (results[0]['status'], results[0]['stdout']) == (75, BUSY), results
    assert results[0]['pid'] == updating['pid'] and results[0]['start'] == updating['start']
    assert gap['lock']['blocked'] and not gap['transaction'] and not gap['request']
    publications = [event for event in gap['events'] if event['phase'] == 'shortcut' and event['event'] == 'request-published']
    claims = [event for event in gap['events'] if event['phase'] == 'shortcut' and event['event'] == 'request-claimed']
    assert len(publications) == len(claims) == 1, (publications, claims)
    assert publications[0]['request'] == direct_poll['before'] and publications[0]['request']['target'] == updating['token']
    claim = claims[0]
    assert (claim['pid'], claim['start'], claim['token']) == (updating['pid'], updating['start'], updating['token'])
    assert claim['result'] is True and claim['locked_reads'] == [direct_poll['before']] and claim['after'] is None
    assert publications[0]['at'] <= direct_poll['at'] <= claim['at']
    receipt['request_handoff'] = dict(publication=publications[0], rejected=direct_poll, claimed=claim)
    assert any(event['event'] == 'screen-enter' and event['pid'] == updating['pid'] and event['pending'] is True
               and event['retry_at'] > 0 for event in gap['events'])
    waiting_frame('04-worker-waiting')
    machine.user('touch ' + FOLDER + '/apply-gap-lock-release')
    wait_file('apply-gap-lock-done.json')
    machine.wait_user('test -s ' + STATE + '/applied.json && test ! -e ' + STATE +
                     '/ready.json && systemctl --user is-active --quiet hn-screen', 60)
    machine.frame('05-one-shortcut-completed', 'up to date', 15)
    completed = snapshot('05-one-shortcut-completed')
    results = [event for event in completed['events'] if event['phase'] == 'shortcut' and event['event'] == 'worker-result']
    assert [event['status'] for event in results] == [75, 0], results
    assert completed['transaction'] == {'status': 'applied'} and not completed['ready']
    expected = dict(before['bundled'], **{'harness-tui': release['files']['harness-tui']})
    assert completed['selected_files'] == expected and completed['selected'] != before['selected']
    assert_work(before, completed, ''.join(inputs))
    resumed = ui_owner(completed, updating)
    assert all(resumed[key] == updating[key] for key in ['pid', 'start', 'token', 'socket', 'pane', 'window', 'launch', 'process'])
    receipt['renderer_replacement'] = renderer_replaced(before, completed)
    receipt['launch_persistence'] = dict(before=updating, after=resumed)
    assert [ui for ui in completed['uis'] if (ui['pid'], ui['start']) == (direct['pid'], direct['start'])] == direct_processes
    assert not any(event['pid'] == direct['pid'] and event['event'] in ['request-claimed', 'worker-start'] for event in completed['events'])
    # A second shortcut is a separate post-activation reuse check, not help for
    # the original intent. No additional key was needed through either race.
    control('gate.json', dict(token='reuse', path=None))
    machine.user('hn select-window -t ' + shlex.quote(window) + ' && hn select-pane -t ' + shlex.quote(pane))
    machine.keys('meta_l', 'u')
    wait_event('reuse', 'request-claimed')
    machine.frame('05-post-activation-reuse', 'up to date', 15)
    reused = snapshot('05-post-activation-reuse')
    owner = ui_owner(reused, updating)
    assert all(owner[key] == resumed[key] for key in ['pid', 'start', 'token', 'socket', 'pane', 'window', 'launch', 'process'])
    publications = [event for event in reused['events'] if event['phase'] == 'reuse' and event['event'] == 'request-published']
    claims = [event for event in reused['events'] if event['phase'] == 'reuse' and event['event'] == 'request-claimed']
    assert len(publications) == len(claims) == 1 and publications[0]['request']['target'] == updating['token'], (publications, claims)
    assert (claims[0]['pid'], claims[0]['start'], claims[0]['token']) == (updating['pid'], updating['start'], updating['token'])
    assert claims[0]['result'] is True and claims[0]['locked_reads'] == [publications[0]['request']] and claims[0]['after'] is None
    assert not any(event['event'] == 'worker-start' and event['phase'] == 'reuse' for event in reused['events'])
    assert len(reused['ownership']['panes']) == len(completed['ownership']['panes'])
    assert reused['selected_files'] == expected and reused['transaction'] == completed['transaction'] and not reused['request']
    assert_work(before, reused, ''.join(inputs))
    receipt['post_activation_reuse'] = dict(owner=owner, publication=publications[0], claim=claims[0])
    close_ui('reuse', updating)
    machine.user('hn select-window -t ' + shlex.quote(direct_window) + ' && hn select-pane -t ' + shlex.quote(direct_pane))
    machine.frame('05-direct-stayed-view-only', 'up to date', 15)
    close_ui('reuse', direct)
    type_work('after-contention')
    receipt['checks'].append('One QMP Super+u is rejected by the live unregistered inspection and claimed only by its targeted UI; it survives timer staging and a real worker lock race, activates hn once, and preserves the same work and daemon.')
    receipt['checks'].append('Actual selected-binary renderer replacement changes renderer identity while retaining the exact quoted launch and owner; a later QMP Super+u targets that same owner without another pane or activation.')

    begin('cancel', 'cli.mjs', 'feeds-both.json')
    machine.keys('meta_l', 'u')
    cancelling = ui_waiting('cancel', True, completed['transaction'])
    close_ui('cancel', cancelling)
    release_http('cancel')
    wait_checker('cancel')
    cancelled = snapshot('06-cancelled')
    assert cancelled['selected_files'] == expected and not cancelled['request']
    assert cancelled['transaction'] == completed['transaction']
    assert not any(event['event'] == 'worker-start' and event['phase'] == 'cancel' for event in cancelled['events'])
    assert_work(before, cancelled, ''.join(inputs))
    machine.user("hn new-window -n intent-inspection 'exec /usr/bin/harness updates'")
    machine.frame('07-cancelled-inspection', 'Update available', 15)
    viewed = snapshot('07-cancelled-inspection')
    assert viewed['selected_files'] == expected and not viewed['request']
    assert not any(event['event'] == 'worker-start' and event['phase'] == 'cancel' for event in viewed['events'])
    screens = [event for event in viewed['events'] if event['event'] == 'screen-enter' and event['phase'] == 'cancel']
    inspecting = ui_owner(viewed, screens[-1])
    assert inspecting['pending'] is False and (inspecting['pid'], inspecting['start']) != (cancelling['pid'], cancelling['start'])
    close_ui('cancel', inspecting)
    type_work('after-cancel')
    final = snapshot('08-final-work')
    assert_work(before, final, ''.join(inputs))
    assert final['selected_files'] == expected and final['ready'] and not final['request']
    assert not any(event['event'] == 'worker-start' and event['phase'] == 'reuse' for event in final['events'])
    receipt['checks'].append('Escape cancels the owned waiting intent; later timer staging and inspection never activate the CLI. Original processes, project, input history, boot and bundled bytes remain intact.')
    machine.user('systemctl --user stop harness-update.timer harness-update.service harness-intent-feed.service')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture', type=Path, required=True)
    parser.add_argument('--updates', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path('os/test-results/update-intent'))
    args = parser.parse_args()
    if subprocess.check_output(['git', '-C', str(ROOT), 'status', '--porcelain'], text=True).strip():
        parser.error('Commit and review the exact reconciled source before native acceptance')
    fixture, updates = args.fixture.resolve(), args.updates.resolve()
    if digest(fixture / 'manifest.json') != IMAGE_MANIFEST or digest(updates / 'fixture.json') != UPDATE_MANIFEST:
        parser.error('Use the declared immutable image37295239018 and update37282748232 inputs')
    image, release = fixture_identity(fixture, IMAGE_SOURCE), update_identity(updates, UPDATE_SOURCE)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    receipt = dict(status='running', source_commit=subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip(),
        source_files={path:digest(ROOT / path) for path in INPUTS}, image_source=IMAGE_SOURCE, image_manifest=IMAGE_MANIFEST,
        update_source=UPDATE_SOURCE, update_manifest=UPDATE_MANIFEST, image_runtime=image['package']['runtime'],
        update_fixture=release, ownership_source=OWNERSHIP_SOURCE, started_at=time.time(), checks=[],
        scope='Private native ARM user update contention only; no base upgrade, image build or physical support claim')
    machine = server = server_thread = None
    with tempfile.TemporaryDirectory(prefix='harness-update-intent-') as temporary:
        work = Path(temporary)
        try:
            import PIL
            receipt['host_toolchain'] = dict(python=sys.version, python_executable=sys.executable,
                python_sha256=digest(Path(sys.executable)), pillow=PIL.__version__,
                platform=platform.platform(), machine=platform.machine(), commands={})
            for command in ['qemu-system-aarch64', 'zstd', 'tesseract', 'git']:
                binary = shutil.which(command)
                if binary is None:
                    raise ValueError('Missing native acceptance tool: ' + command)
                receipt['host_toolchain']['commands'][command] = dict(path=binary, sha256=digest(Path(binary)),
                    version=subprocess.check_output([binary, '--version'], text=True, stderr=subprocess.STDOUT, timeout=10))
            disk = work / 'guest.raw'
            subprocess.run(['zstd', '-d', '--sparse', str(fixture / 'guest.raw.zst'), '-o', str(disk)], check=True, timeout=180)
            assert disk.stat().st_size == image['raw_disk']['bytes'] and digest(disk) == image['raw_disk']['sha256']
            served = work / 'served'
            shutil.copytree(updates, served)
            server = ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory=str(served)))
            server.daemon_threads = True
            server_thread = threading.Thread(target=server.serve_forever, daemon=True)
            server_thread.start()
            machine = SessionVM(output / 'guest', disk, fixture / 'Image')
            machine.start()
            receipt['accelerator'] = machine.accelerator
            if machine.accelerator not in ['hvf', 'kvm']:
                raise ValueError('This proposed native acceptance requires HVF or KVM')
            exercise(machine, image, release, receipt, output, f'http://10.0.2.2:{server.server_port}')
            machine.user('python3 ' + GUEST + ' archive /tmp/update-intent-evidence.tar')
            (output / 'guest-evidence.tar').write_bytes(machine.read_file('/tmp/update-intent-evidence.tar'))
            receipt['shutdown'] = machine.poweroff()
            receipt['status'] = 'passed'
        except BaseException as error:
            receipt.update(status='failed', error=str(error),
                           failure_kind='observer-barrier' if isinstance(error, ObserverBarrierError) else 'acceptance')
            if machine and machine.shell_ready:
                try:
                    machine.user('python3 ' + GUEST + ' barrier-failures', timeout=10)
                    failures = json.loads(machine.read_file(FOLDER + '/barrier-failures.json', timeout=10))
                    receipt['barrier_failures'] = failures
                    if failures['expired'] or failures['events']:
                        receipt['failure_kind'] = 'observer-barrier'
                    machine.user('python3 ' + GUEST + ' archive /tmp/update-intent-failure.tar', timeout=15)
                    (output / 'guest-failure.tar').write_bytes(machine.read_file('/tmp/update-intent-failure.tar', timeout=15))
                except (OSError, RuntimeError, TimeoutError, ValueError) as collection_error:
                    receipt['collection_error'] = str(collection_error)
            failure_evidence(machine)
            raise
        finally:
            errors = []
            for close in ([machine.close] if machine else []) + ([server.shutdown, server.server_close] if server else []):
                try:
                    close()
                except (OSError, RuntimeError) as error:
                    errors.append(str(error))
            if server_thread:
                server_thread.join(timeout=5)
                if server_thread.is_alive():
                    errors.append('Owned transfer HTTP thread did not stop')
            receipt.update(finished_at=time.time(), cleanup_errors=errors)
            if errors:
                receipt['status'] = 'failed'
            (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
            if errors:
                raise RuntimeError('Owned fixture cleanup failed: ' + '; '.join(errors))


if __name__ == '__main__':
    main()
