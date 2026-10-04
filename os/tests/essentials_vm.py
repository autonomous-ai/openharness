#!/usr/bin/env python3
"""Exercise real network/audio plumbing in a disposable Harness VM.

The radio and audio codec are simulated hardware, not substitutes for physical
Wi-Fi reception, laptop backlight, speakers or microphone acceptance. Test-only
access point tools never enter the image or its installed payload.
"""
import argparse
import array
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import time
import wave
from session_vm import put, screen_text
from vm import VM

SSID = 'harness-test'
PASSWORD = 'wifi-test-123'
USER_ENV = 'runuser -u me -- env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus '


AP_SETUP = '''#!/bin/bash
set -euo pipefail
modprobe mac80211_hwsim radios=2
udevadm settle
mapfile -t phys < <(find /sys/class/ieee80211 -mindepth 1 -maxdepth 1 -printf '%f\\n' | sort)
test "${#phys[@]}" = 2
ip netns add harness-ap
iw phy "${phys[0]}" set netns name harness-ap
ap=$(ip netns exec harness-ap iw dev | awk '/Interface/{print $2; exit}')
station=$(iw dev | awk '/Interface/{print $2; exit}')
ip netns exec harness-ap ip link set lo up
ip netns exec harness-ap ip addr add 10.77.0.1/24 dev "$ap"
cat > /run/harness-ap.conf <<EOF
interface=$ap
driver=nl80211
ssid=harness-test
hw_mode=g
channel=1
wpa=2
wpa_key_mgmt=WPA-PSK
rsn_pairwise=CCMP
wpa_passphrase=wifi-test-123
EOF
chmod 600 /run/harness-ap.conf
ip netns exec harness-ap hostapd -B -P /run/harness-ap.pid -f /run/harness-ap.log /run/harness-ap.conf
ip netns exec harness-ap dnsmasq --interface="$ap" --bind-interfaces --except-interface=lo \\
  --dhcp-range=10.77.0.20,10.77.0.30,255.255.255.0,1h --dhcp-option=3,10.77.0.1 \\
  --dhcp-option=6,10.77.0.1 --address=/harness.test/10.77.0.1 --no-resolv \\
  --pid-file=/run/harness-dnsmasq.pid --log-facility=/run/harness-dnsmasq.log
mkdir -p /run/harness-network-test
printf '%s\\n' 'harness-wifi-success' > /run/harness-network-test/index.html
ip netns exec harness-ap python3 -m http.server 8080 --bind 10.77.0.1 \\
  --directory /run/harness-network-test > /run/harness-http.log 2>&1 &
nmcli radio wifi on
nmcli device set "$station" managed yes
printf '%s' "$station" > /run/harness-station
for n in $(seq 1 30); do
  if nmcli -t -f SSID device wifi list ifname "$station" | grep -Fx harness-test; then exit 0; fi
  sleep 1
done
exit 1
'''


def wait_screen(vm, words, name, timeout=20):
    deadline = time.monotonic() + timeout
    while True:
        # OCR drops dark text inside the selected network's light highlight.
        # Read the real focused terminal for input readiness, and retain its
        # actual framebuffer separately for visual inspection.
        vm.command(USER_ENV + 'hn capture-pane -p > /tmp/harness-wifi-screen.txt')
        content = vm.read_file('/tmp/harness-wifi-screen.txt')
        (vm.folder / (name + '.txt')).write_bytes(content)
        text = ' '.join(content.decode().lower().split())
        if all(word.lower() in text for word in words):
            vm.screenshot(name)
            return text
        if time.monotonic() >= deadline:
            vm.screenshot(name)
            raise AssertionError('Expected screen text not rendered: ' + repr(words) + '; saw: ' + text)
        time.sleep(.25)


def wireless(vm, result):
    print('Preparing simulated WPA2 access point inside the disposable guest', flush=True)
    vm.command('systemctl start harness-keyring', timeout=240)
    output, _ = vm.command('pacman -S --needed --noconfirm hostapd dnsmasq iw', timeout=180)
    (vm.folder / 'test-only-packages.log').write_text(output)
    put(vm, '/tmp/harness-test-access-point', AP_SETUP)
    vm.command('bash /tmp/harness-test-access-point', timeout=60)
    # Make the actual wireless route necessary; serial control is independent.
    vm.command("nmcli -t -f DEVICE,TYPE device | awk -F: '$2 == \"ethernet\" {print $1}' > /run/harness-ethernet; "
               'while read -r dev; do nmcli device disconnect "$dev"; nmcli device set "$dev" managed no; done < /run/harness-ethernet')
    vm.command('! ip route show default | grep -v "dev $(cat /run/harness-station)"')
    form = 'sudo python3 /usr/lib/harness-os/network.py --first-use; result=$?; printf %s "$result" > /tmp/wifi-form-result; exec bash -l'
    vm.command(USER_ENV + 'hn new-window -n Wi-Fi ' + shlex.quote(form))
    wait_screen(vm, ['harness-test', 'install without connecting'], 'wifi-01-networks')
    vm.keys('esc')
    wait_screen(vm, ['harness-test'], 'wifi-01-escape-keeps-welcome')
    # Wi-Fi is the first selection. A bad password stays recoverable in-page.
    vm.keys('ret')
    wait_screen(vm, ['password'], 'wifi-02-password')
    vm.type_probe('wrong-wifi-password')
    vm.keys('ret')
    wait_screen(vm, ['check the password'], 'wifi-02-password-retry', timeout=50)
    vm.keys('esc')
    vm.keys('r')
    wait_screen(vm, ['harness-test'], 'wifi-02-rescan')
    vm.keys('ret')
    wait_screen(vm, ['password'], 'wifi-02-password-again')
    vm.type_probe(PASSWORD)
    text = screen_text(vm, 'wifi-03-password-masked')
    assert PASSWORD not in text, 'Wi-Fi password was visible in the form'
    vm.keys('ret')
    vm.command('for n in $(seq 1 80); do test -s /tmp/wifi-form-result && '
               'test "$(cat /tmp/wifi-form-result)" = 0 && exit 0; sleep .5; done; exit 1', timeout=45)
    # A real HTTP response and DNS lookup through the radio, not a mocked state.
    output, _ = vm.command('ip route; resolvectl query harness.test; '
                           'test "$(curl --noproxy "*" -fsS --max-time 10 http://harness.test:8080)" = harness-wifi-success')
    (vm.folder / 'wifi-route-and-dns.txt').write_text(output)
    vm.screenshot('wifi-04-connected')
    vm.command(USER_ENV + 'hn list-panes -a -F "#{pane_current_command}"')
    result['checks'].append('Fullscreen Wi-Fi welcome puts Wi-Fi first, retries a wrong masked password, rescans, and advances automatically after DHCP and resolves/fetches HTTP over wireless with Ethernet disconnected')
    # Restart NetworkManager too: a radio toggle alone could reuse an in-memory
    # secret instead of proving the entered password was saved to disk.
    vm.monitor('set_link', name='hnnet', up=False)
    vm.command('systemctl restart NetworkManager; nm-online -q --timeout=40', timeout=45)
    # Connection must survive a radio toggle, without another password prompt.
    vm.command('nmcli radio wifi off; sleep 1; nmcli radio wifi on; '
               'for n in $(seq 1 45); do if curl --noproxy "*" -fsS --max-time 2 http://harness.test:8080 | '
               'grep -Fx harness-wifi-success; then exit 0; fi; sleep 1; done; exit 1', timeout=100)
    vm.command('find /etc/NetworkManager/system-connections -name "*.nmconnection" -exec stat -c "%a %U %n" {} \\;')
    result['checks'].append('Wireless reconnects after a radio off/on cycle using its stored profile')
    # The full-page offline action returns an explicit install result; Esc does
    # not strand a first-time user in an empty shell.
    vm.command('nmcli device disconnect "$(cat /run/harness-station)"')
    vm.command(USER_ENV + 'hn new-window -n Offline ' + shlex.quote(form.replace('/tmp/wifi-form-result', '/tmp/wifi-offline-result')))
    wait_screen(vm, ['install without connecting'], 'wifi-05-offline-install')
    vm.keys('i')
    vm.command('for n in $(seq 1 40); do test "$(cat /tmp/wifi-offline-result 2>/dev/null)" = 10 && exit 0; sleep .25; done; exit 1')
    result['checks'].append('First-use Wi-Fi always offers offline installation, and selecting it exits with the native install action')
    vm.command('nmcli connection up ' + SSID, timeout=60)
    vm.monitor('set_link', name='hnnet', up=True)
    vm.command('while read -r dev; do nmcli device set "$dev" managed yes; nmcli device connect "$dev"; done < /run/harness-ethernet')


def sound(vm, result):
    print('Checking PipeWire, media keys and audible samples from the virtual codec', flush=True)
    # wpctl get-volume can return zero while printing an unresolved default ID.
    # Wait for an actual output value as WirePlumber finishes codec discovery.
    vm.command(USER_ENV + 'sh -c ' + shlex.quote('for n in $(seq 1 30); do wpctl get-volume @DEFAULT_AUDIO_SINK@ 2>/dev/null | grep -q "^Volume:" && exit 0; sleep 1; done; exit 1'))
    def volume():
        output, _ = vm.command(USER_ENV + 'wpctl get-volume @DEFAULT_AUDIO_SINK@')
        match = re.search(r'Volume: ([0-9.]+)([^\r\n]*)', output)
        assert match, 'No default audio output'
        return float(match.group(1)), '[MUTED]' in match.group(2)
    def press_volume(key, expected):
        # labwc starts wpctl asynchronously. Observe completion instead of
        # assuming it finished within 400 ms during first-agent startup.
        started = time.monotonic()
        vm.keys(key)
        while True:
            actual = volume()
            if actual == expected:
                result.setdefault('audio_key_seconds', {})[key + ('-unmute' if key == 'audiomute' and not expected[1] else '')] = round(time.monotonic() - started, 3)
                return
            assert time.monotonic() - started < 5, (key + ' did not reach PipeWire', actual, expected)
            time.sleep(.1)
    vm.command(USER_ENV + 'wpctl set-volume @DEFAULT_AUDIO_SINK@ 0.5')
    vm.command(USER_ENV + 'wpctl set-mute @DEFAULT_AUDIO_SINK@ 0')
    press_volume('volumeup', (.55, False))
    press_volume('volumedown', (.5, False))
    press_volume('audiomute', (.5, True))
    press_volume('audiomute', (.5, False))
    tone = '''import array, math, wave
with wave.open('/tmp/harness-tone.wav', 'wb') as output:
    output.setnchannels(2); output.setsampwidth(2); output.setframerate(48000)
    samples = array.array('h', (int(12000 * math.sin(2*math.pi*440*n/48000)) for n in range(96000) for channel in range(2)))
    output.writeframes(samples.tobytes())
'''
    put(vm, '/tmp/harness-tone.py', tone)
    vm.command('python3 /tmp/harness-tone.py')
    vm.command(USER_ENV + 'pw-play /tmp/harness-tone.wav')
    output, _ = vm.command(USER_ENV + 'wpctl status')
    (vm.folder / 'audio-routing.txt').write_text(output)
    result['checks'].append('Volume up/down and mute/unmute key events change the real PipeWire default output, and pw-play completes on the virtual HDA codec')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path('os/test-results/essentials'))
    args = parser.parse_args()
    if not os.access('/dev/kvm', os.R_OK | os.W_OK):
        parser.error('Use native x86 KVM for these hardware-plumbing checks.')
    iso = args.iso.resolve()
    manifest = json.loads(iso.with_name('manifest.json').read_text())
    with iso.open('rb') as handle:
        assert hashlib.file_digest(handle, 'sha256').hexdigest() == manifest['iso']['sha256']
    folder = args.output.resolve()
    folder.mkdir(parents=True, exist_ok=False)
    vm = VM(folder, iso, 'bios', 2048, audio=True)
    result = {'status': 'running', 'scope': 'simulated wireless and audio, not physical hardware',
              'image_source_commit': manifest['source_commit'], 'iso_sha256': manifest['iso']['sha256'],
              'test_source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
              'started_at_unix': time.time(), 'checks': []}
    try:
        vm.start(live=True)
        vm.wait(r'root@[^\r\n]*[#] ')
        vm.shell_ready = True
        vm.command('stty -echo')
        vm.command(USER_ENV + '/usr/lib/harness-os/wait-runtime')
        vm.command(USER_ENV + 'sh -c ' + shlex.quote('for n in $(seq 1 60); do systemctl --user is-active --quiet hn-screen && pgrep -u 1000 -x foot >/dev/null && exit 0; sleep .25; done; exit 1'))
        wireless(vm, result)
        sound(vm, result)
        vm.stop()
        with wave.open(str(folder / 'audio-1.wav'), 'rb') as recording:
            samples = array.array('h', recording.readframes(recording.getnframes()))
            assert samples and max(abs(v) for v in samples) > 100, 'The virtual audio backend received silence'
            result['captured_audio'] = {'sample_rate': recording.getframerate(), 'frames': recording.getnframes(),
                                        'peak': max(abs(v) for v in samples)}
        result['checks'].append('QEMU captures non-silent PCM samples produced through the guest audio stack')
        result['status'] = 'passed'
    except BaseException as error:
        result['status'], result['error'] = 'failed', str(error)
        if vm.process and vm.process.poll() is None:
            try:
                vm.screenshot('failure')
                output, _ = vm.command('journalctl -b -u NetworkManager --no-pager; '
                    'cat /run/harness-ap.log /run/harness-dnsmasq.log /run/harness-http.log; '
                    'ip address; ip route; nmcli device; ' + USER_ENV + 'wpctl status', check=False, timeout=20)
                (folder / 'diagnostics.log').write_text(output)
            except Exception:
                pass
        raise
    finally:
        result['finished_at_unix'] = time.time()
        (folder / 'receipt.json').write_text(json.dumps(result, indent=2) + '\n')
        vm.stop()
        vm.log.close()
        vm.stderr.close()
        vm.control.cleanup()


if __name__ == '__main__':
    main()
