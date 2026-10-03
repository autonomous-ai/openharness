#!/usr/bin/env python3
"""Install the real ISO; assess optional CPU inference or NVIDIA packages."""
import argparse
import base64
from functools import partial
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import threading
import time
from vm import VM, check_graphical_keyboard


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', type=Path, required=True)
    parser.add_argument('--probe', choices=['local-ai', 'nvidia'], required=True)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if not os.access('/dev/kvm', os.R_OK | os.W_OK):
        parser.error('Native x86 KVM is required')
    iso = args.iso.resolve()
    manifest = json.loads(iso.with_name('manifest.json').read_text())
    with iso.open('rb') as handle:
        assert hashlib.file_digest(handle, 'sha256').hexdigest() == manifest['iso']['sha256']
    folder = (args.output or Path('os/test-results') / args.probe).resolve()
    folder.mkdir(parents=True, exist_ok=False)
    served = folder / 'served'
    served.mkdir()
    script = Path(__file__).with_name('local_ai_guest.py')
    shutil.copyfile(script, served / script.name)
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory=str(served)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    vm = VM(folder, iso, 'uefi', 4096)
    result = {'status': 'running', 'started_at': time.time(), 'image_source_commit': manifest['source_commit'],
              'test_source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
              'iso_sha256': manifest['iso']['sha256'], 'probe': args.probe, 'memory_mib': 4096,
              'physical_gpu_validation': 'unavailable: no GPU passthrough'}
    config = dict(disk='/dev/vda', expected_serial='HN_OS_TEST', confirm_erase='/dev/vda',
                  username='me', hostname='harness', password='test-password-123', encrypt=True, serial_console=True)
    try:
        vm.start(live=True)
        vm.wait(r'root@[^\r\n]*[#] ', timeout=180)
        vm.shell_ready = True
        vm.command('stty -echo')
        encoded = base64.b64encode(json.dumps(config).encode()).decode()
        vm.command('printf %s ' + encoded + ' | base64 -d > /tmp/install-config.json')
        vm.command('nmcli networking off')
        output, _ = vm.command('harness install --config /tmp/install-config.json --yes-erase-disk', timeout=360)
        (folder / 'install.log').write_text(output)
        vm.command('sync')
        vm.stop()
        vm.start(live=False)
        vm.login_installed(config)
        vm.command('printf %s ' + shlex.quote(config['password'] + '\n') + ' | sudo -S -v')
        vm.command('nm-online -q --timeout=60 && curl --fail --silent --show-error ' +
                   shlex.quote(f'http://10.0.2.2:{server.server_port}/local_ai_guest.py') + ' -o /home/me/local_ai_guest.py')
        output, status = vm.command('sudo -n python3 /home/me/local_ai_guest.py ' + args.probe, timeout=1100, check=False)
        (folder / 'probe.log').write_text(output)
        assert status == 0, 'Optional package/inference probe failed; see probe.log'
        marker = 'HN_LOCAL_AI_PROBE='
        # sudo may prepend a shell-integration OSC sequence on the same line.
        result['guest'] = json.loads(next(line.split(marker, 1)[1] for line in output.splitlines() if marker in line))
        assert result['guest']['status'] == 'passed'
        if args.probe == 'local-ai':
            vm.keys('ctrl', 'b')
            vm.keys('shift', 't')
            vm.type_probe('local-chat')
            vm.keys('ret')
            output, status = vm.command('for n in $(seq 1 120); do '
                'test -f /home/me/local-ai-check/chat-passed && exit 0; sleep 1; done; exit 1', timeout=135, check=False)
            assert status == 0, 'Physical-keyboard local model conversation did not finish'
            output, _ = vm.command('hn capture-pane -p')
            assert 'Local model answered:' in output
            vm.command('test -s /home/me/local-ai-check/chat-passed && test "$(nmcli networking)" = disabled')
            (folder / 'local-model-pane.txt').write_text(output)
            vm.screenshot('offline-local-model')
            result['offline_keyboard_conversation'] = 'passed'
            vm.keys('ctrl', 'd')
        else:
            vm.command('sync')
            vm.stop()
            vm.start(live=False)
            vm.login_installed(config)
            result['post_driver_reboot_keyboard'] = check_graphical_keyboard(vm, 'nvidia-package-reboot')
            vm.keys('meta_l', 'b')
            vm.command('for n in $(seq 1 30); do pgrep -x chromium && exit 0; sleep 1; done; exit 1')
            vm.screenshot('browser-after-driver-packages')
            result['generic_browser_after_driver_reboot'] = 'passed; virtual GPU only'
        result['status'] = 'passed'
    except BaseException as error:
        result.update(status='failed', error=repr(error))
        try:
            vm.screenshot('failure')
        except Exception:
            pass
        raise
    finally:
        if vm.shell_ready:
            for name in ['probe.json', 'commands.log', 'chat.jsonl', 'chat.err', 'offline-api.json', 'supportedchips.html']:
                try:
                    output, _ = vm.command('cat /home/me/local-ai-check/' + name, timeout=15, check=False)
                    (folder / ('guest-' + name)).write_text(output)
                except Exception:
                    pass
        result['finished_at'] = time.time()
        (folder / 'receipt.json').write_text(json.dumps(result, indent=2) + '\n')
        vm.stop()
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
