#!/usr/bin/env python3
"""Reconnect inactive Ethernet through the real network page in a disposable VM."""
import argparse
from functools import partial
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shlex
import subprocess
import threading
import time

from session_vm import put
from update_vm import network_state
from vm import VM


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', type=Path, required=True)
    parser.add_argument('--network-script', type=Path, required=True)
    parser.add_argument('--profile', choices=('automatic', 'saved'), required=True)
    args = parser.parse_args()
    if not os.access('/dev/kvm', os.R_OK | os.W_OK):
        parser.error('Use native x86 KVM for this acceptance check.')
    iso = args.iso.resolve()
    manifest = json.loads(iso.with_name('manifest.json').read_text())
    with iso.open('rb') as handle:
        assert hashlib.file_digest(handle, 'sha256').hexdigest() == manifest['iso']['sha256']
    candidate = args.network_script.read_bytes()
    checksum = hashlib.sha256(candidate).hexdigest()
    folder = Path('os/test-results/network-recovery').resolve()
    folder.mkdir(parents=True, exist_ok=False)
    served = folder / 'served'
    served.mkdir()
    proof = 'harness-network-recovery\n'
    (served / 'proof.txt').write_text(proof)
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory=str(served)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    vm = VM(folder, iso, 'uefi', 2048, video='VGA')
    result = dict(status='running', started_at=time.time(), checks=[],
                  image_source=manifest['source_commit'], iso_sha256=manifest['iso']['sha256'],
                  candidate_network_sha256=checksum,
                  profile_mode=args.profile,
                  test_source=subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
                  limits=['Virtual Ethernet and ACPI only; no physical Wi-Fi acceptance.',
                          'Only the candidate network.py replaces a product file in the verified image.'])
    config = dict(disk='/dev/vda', expected_serial='HN_OS_TEST', confirm_erase='/dev/vda',
                  username='me', hostname='harness', password='test-password-123', encrypt=True, serial_console=True)

    def login():
        vm.login_installed(config)
        vm.command('export PAGER= LC_ALL=C')
        vm.command('printf %s ' + shlex.quote(config['password'] + '\n') + ' | sudo -S -v')

    def http():
        vm.command('curl --noproxy "*" --fail --silent --show-error --max-time 10 '
                   f'http://10.0.2.2:{server.server_port}/proof.txt -o /tmp/network-proof', timeout=15)
        assert vm.read_file('/tmp/network-proof').decode() == proof

    def profile():
        vm.command('nmcli -g GENERAL.CON-UUID device show ens5 > /tmp/network-profile')
        return vm.read_file('/tmp/network-profile').decode().strip()

    def settings(identity):
        vm.command('nmcli -g connection.id,connection.uuid,connection.interface-name,ipv4.method,ipv4.route-metric '
                   'connection show uuid ' + shlex.quote(identity) + ' > /tmp/network-settings')
        return vm.read_file('/tmp/network-settings')

    try:
        vm.start(live=True)
        vm.wait(r'root@[^\r\n]*[#] ', timeout=180)
        vm.shell_ready = True
        vm.command('stty -echo')
        put(vm, '/tmp/network-install.json', json.dumps(config))
        vm.command('nmcli networking off')
        output, _ = vm.command('harness install --config /tmp/network-install.json --yes-erase-disk', timeout=360)
        (folder / 'install.log').write_text(output)
        vm.command('sync')
        vm.stop()
        vm.start(live=False)
        login()
        vm.command('nm-online -q --timeout=30', timeout=35)
        http()
        original_profile = profile()
        assert original_profile and original_profile != '--'
        result['original_profile'] = original_profile
        # NetworkManager's first automatic Ethernet connection is generated in
        # memory, not a saved user configuration. Exercise that case separately
        # from a genuinely persisted profile with a nondefault route metric.
        vm.command('sudo -n find /etc/NetworkManager/system-connections -maxdepth 1 -type f '
                   '> /tmp/saved-network-files')
        assert not vm.read_file('/tmp/saved-network-files').strip(), 'Baseline unexpectedly has saved network profiles'
        if args.profile == 'saved':
            vm.command('sudo -n nmcli connection modify uuid ' + shlex.quote(original_profile)
                       + ' connection.id "Harness recovery fixture" ipv4.route-metric 321')
            vm.command('sudo -n grep -rlFx ' + shlex.quote('uuid=' + original_profile)
                       + ' /etc/NetworkManager/system-connections > /tmp/saved-network-files')
            assert vm.read_file('/tmp/saved-network-files').strip(), 'Fixture did not persist its connection'
            original_settings = settings(original_profile)
            result['saved_settings_sha256'] = hashlib.sha256(original_settings).hexdigest()
        result['original_network_sha256'] = hashlib.sha256(vm.read_file('/usr/lib/harness-os/network.py')).hexdigest()
        put(vm, '/tmp/network-candidate.py', candidate.decode())
        vm.command('sudo -n install -o root -g root -m 755 /tmp/network-candidate.py /usr/lib/harness-os/network.py')
        assert hashlib.sha256(vm.read_file('/usr/lib/harness-os/network.py')).hexdigest() == checksum
        vm.command('mkdir -p ~/projects/network-recovery; printf keep > ~/projects/network-recovery/proof')
        vm.command('sudo -n nmcli networking off; sync')
        vm.stop()
        vm.start(live=False)
        login()
        vm.command('test "$(nmcli networking)" = disabled')
        if args.profile == 'saved':
            assert settings(original_profile) == original_settings, 'Saved configuration did not survive reboot'
        network_state(vm, 'disabled-boot')
        vm.command('sudo -n systemctl suspend --no-block')
        deadline = time.monotonic() + 30
        while vm.monitor('query-status')['status'] != 'suspended':
            assert time.monotonic() < deadline, 'Guest did not reach ACPI suspend'
            time.sleep(.2)
        vm.monitor('system_wakeup')
        deadline = time.monotonic() + 30
        while True:
            vm.send('\n')
            try:
                vm.wait(r'\[me@harness [^\r\n]*\]\$ ', timeout=2)
                break
            except TimeoutError:
                assert time.monotonic() < deadline, 'Serial did not resume'
        vm.command('pgrep -u 1000 -x "swaylock|gtklock"')
        vm.screenshot('resume-locked')
        vm.type_probe(config['password'])
        vm.keys('ret')
        vm.command('for n in $(seq 1 60); do ! pgrep -u 1000 -x "swaylock|gtklock" && exit 0; sleep .25; done; exit 1', timeout=20)
        vm.command('sudo -n nmcli networking on')
        _, status = vm.command('nm-online -q --timeout=10', timeout=15, check=False)
        assert status != 0, 'Selected image did not reproduce the disabled-boot/sleep regression'
        vm.command('test "$(nmcli -g GENERAL.STATE device show ens5)" = "20 (unavailable)"')
        network_state(vm, 'before-ui-recovery')
        result['checks'].append('Encrypted cold boot with networking disabled, real suspend, authenticated unlock and re-enable reproduce unavailable Ethernet')
        vm.keys('meta_l', 'w')
        deadline = time.monotonic() + 25
        while True:
            vm.command('hn capture-pane -p > /tmp/network-page')
            content = vm.read_file('/tmp/network-page').decode()
            if all(word in content for word in ('Connect to Wi-Fi', 'Rescan', 'Ethernet  ens5')):
                break
            assert time.monotonic() < deadline, 'Super+w did not expose the recoverable Ethernet interface: ' + content
            time.sleep(.25)
        (folder / 'network-page.txt').write_text(content)
        vm.screenshot('ethernet-available-for-selection')
        # This VM has no wireless radio: Rescan is followed by its Ethernet row.
        vm.keys('down')
        vm.screenshot('ethernet-selected')
        vm.keys('ret')
        vm.command('nm-online -q --timeout=35', timeout=40)
        http()
        connected_profile = profile()
        assert connected_profile and connected_profile != '--'
        result['connected_profile'] = connected_profile
        if args.profile == 'saved':
            assert connected_profile == original_profile, 'Recovery did not use the saved connection'
            assert settings(original_profile) == original_settings, 'Recovery changed the saved configuration'
            vm.command('ip -j -4 route show dev ens5 > /tmp/recovered-routes')
            routes = json.loads(vm.read_file('/tmp/recovered-routes'))
            result['recovered_routes'] = routes
            # NM applies the saved metric to the prefix route unchanged. Its
            # internet connectivity check can add 20000 to the default route
            # until the external check completes; that is not lost settings.
            # https://networkmanager.dev/docs/api/latest/NetworkManager.conf.html#config-connectivity
            assert any(route.get('dst') == '10.0.2.0/24' and route.get('metric') == 321
                       for route in routes), 'Saved prefix route metric was not applied'
            assert any(route.get('dst') == 'default' and route.get('metric') in (321, 20321)
                       for route in routes), 'Saved default route metric was not applied'
            result['active_route_metric'] = 321
            result['checks'].append('Recovery uses the persisted connection UUID and retains its nondefault route metric')
        vm.command('test "$(cat ~/projects/network-recovery/proof)" = keep')
        network_state(vm, 'after-ui-recovery')
        vm.screenshot('ethernet-connected')
        result['checks'].append('Super+w shows unavailable Ethernet; keyboard selection reconnects it and transfers exact HTTP bytes')
        result['checks'].append('The project survives the encrypted reboot and recovery; no NetworkManager restart or shell activation command is used for recovery')
        result['status'] = 'passed'
    except BaseException as error:
        result.update(status='failed', error=str(error))
        try:
            vm.screenshot('failure')
            network_state(vm, 'failure')
        except Exception:
            pass
        raise
    finally:
        result['finished_at'] = time.time()
        (folder / 'receipt.json').write_text(json.dumps(result, indent=2) + '\n')
        vm.stop()
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
