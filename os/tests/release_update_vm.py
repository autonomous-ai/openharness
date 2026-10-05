"""Exercise the actual OS release transport on a disposable installed VM."""
import json
import shlex
import time
from session_vm import put, PROBE


def exercise(vm, manifest, config):
    # Retain the new bootstrap outside pacman-owned paths before restoring the
    # public preview. It has no updater; this is its one-time migration path.
    vm.command('mkdir -p /tmp/system-channel; cp /usr/lib/harness-os/release_update.py '
               '/usr/lib/harness-os/runtime_update.py /usr/lib/harness-os/live_update.py '
               '/usr/lib/harness-os/open-updates /tmp/system-channel/; '
               'sudo cat /etc/sudoers.d/30-harness-updates > /tmp/system-channel/30-harness-updates')
    vm.command('cp /home/me/update-bundle/package-manifest.json /tmp/fast-updates/; '
               'cp /home/me/update-bundle/' + shlex.quote(manifest['package']['name']) + ' /tmp/fast-updates/')
    builder = '''import hashlib, json, pathlib
root = pathlib.Path('/tmp/fast-updates')
manifest = json.loads((root/'package-manifest.json').read_text())
def asset(name):
    data = (root/name).read_bytes()
    return dict(url='http://127.0.0.1:19447/'+name, bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
metadata = dict(schema=1, channel='preview', architecture='x86_64',
                manifest=asset('package-manifest.json'), package=asset(manifest['package']['name']))
(root/'os-metadata.json').write_text(json.dumps(metadata))
'''
    put(vm, '/tmp/system-channel/make-feed.py', builder)
    vm.command('python3 /tmp/system-channel/make-feed.py')
    vm.command('systemctl --user stop harness-update.timer harness-update.service; '
               'mkdir -p ~/update-test; cp -R /tmp/system-channel ~/update-test/; '
               'cp -R /tmp/fast-updates ~/update-test/')
    vm.command('sudo harness rollback', timeout=180)
    # A rollback requires a real reboot just like an upgrade. Keep this guard
    # intact, then start fresh running-work probes on the restored OS.
    vm.command('sync')
    vm.stop()
    vm.start(live=False)
    vm.login_installed(config)
    vm.command('printf %s ' + shlex.quote(config['password'] + '\n') + ' | sudo -S -v')
    vm.command('systemctl --user stop harness-update.timer harness-update.service; '
               'cp -R ~/update-test/system-channel ~/update-test/fast-updates /tmp/; '
               'test ! -e /run/harness-os-restart-required')
    # The preceding independent rollback test deliberately rejects its 999.x
    # runtime. Reset only that private fixture hold for this combined-update
    # case; production checks must continue to honor a user's rejected version.
    vm.command('rm -f ~/.local/state/harness-os/updates/ignored.json')
    vm.command('systemd-run --user --collect --unit=harness-test-feed python3 -m http.server 19447 '
               '--bind 127.0.0.1 --directory /tmp/fast-updates')
    vm.command('for n in $(seq 1 30); do curl -fsS http://127.0.0.1:19447/fixture.json && exit 0; sleep .2; done; exit 1')
    put(vm, '/tmp/update-session-probe.py', PROBE)
    vm.command('rm -f ~/projects/session-probe/pid; '
               'hn new-window -n channel-probe ' + shlex.quote('python3 /tmp/update-session-probe.py'))
    vm.command('for n in $(seq 1 40); do test -s ~/projects/session-probe/pid && exit 0; sleep .25; done; exit 1;')
    vm.command('cp ~/projects/session-probe/pid /tmp/fast-original-pid; '
               'cat /proc/sys/kernel/random/boot_id > /tmp/fast-original-boot; '
               'hn new-window -n channel-agent opencode')
    vm.command('for n in $(seq 1 80); do pgrep -u 1000 -x opencode > /tmp/fast-original-agent && exit 0; sleep .25; done; exit 1')
    feed = ' --feed http://127.0.0.1:19447/os-metadata.json'
    updater = 'python3 /tmp/system-channel/release_update.py '
    def available(expected):
        vm.command(updater + 'check' + feed + ' > /tmp/system-channel/discovery.json')
        vm.command('python3 -c ' + shlex.quote("import json; assert json.load(open('/tmp/system-channel/discovery.json'))['available'] is " + str(expected)))
    available(True)
    checks = ['Restored public preview reboots and discovers the newer real OS package through the verified release manifest']
    package = '/tmp/fast-updates/' + manifest['package']['name']
    vm.command('cp ' + shlex.quote(package) + ' /tmp/good-os-package; printf broken > ' + shlex.quote(package))
    _, status = vm.command('sudo ' + updater + 'apply' + feed, timeout=180, check=False)
    assert status != 0, 'A corrupt channel package was accepted'
    checks.append('A corrupt download is rejected before the package transaction')
    vm.command('cp /tmp/good-os-package ' + shlex.quote(package))
    # Restore the candidate UI on the old package solely to exercise its new
    # combined action. Only the root helper's parser default uses the private
    # loopback feed; the shipped helper never accepts a user-owned feed cache.
    vm.command('sudo install -m 644 /tmp/system-channel/live_update.py /usr/lib/harness-os/live_update.py; '
               'sudo install -m 755 /tmp/system-channel/open-updates /usr/lib/harness-os/open-updates; '
               # The old package does not own the new policy path. Use a
               # fixture-only name so pacman can install its actual owned file
               # without an unrelated "exists in filesystem" collision.
               'sudo install -m 440 /tmp/system-channel/30-harness-updates /etc/sudoers.d/99-harness-test-updates')
    helper = vm.read_file('/tmp/system-channel/release_update.py').decode().replace(
        "parser.add_argument('--feed', default=FEED,", "parser.add_argument('--feed', default='http://127.0.0.1:19447/os-metadata.json',")
    put(vm, '/tmp/system-channel/test-release-helper.py', helper)
    vm.command('sudo install -m 644 /tmp/system-channel/test-release-helper.py /usr/lib/harness-os/release_update.py; '
               'sudo visudo -c -f /etc/sudoers')
    vm.command('mkdir -p ~/.local/state/harness-os/updates; printf %s ' + shlex.quote(json.dumps(
        {'available': True, 'checked_at': time.time(), 'version': manifest['package']['version']})) +
        ' > ~/.local/state/harness-os/updates/system.json')
    # A live Updates window may still be executing the pre-rollback module.
    # Close only that fixture's UI pane before opening the candidate with Super+u.
    vm.command('hn kill-window -t Updates 2>/dev/null || true')
    vm.command('sudo -K')
    for denied in ['/usr/bin/true', '/usr/bin/harness upgrade /tmp/untrusted-update']:
        output, status = vm.command('sudo -n ' + denied, check=False)
        assert status != 0 and 'password' in output.lower(), output
    vm.keys('meta_l', 'u')
    vm.command('for n in $(seq 1 360); do test -s ~/.local/state/harness-os/updates/approved.json && '
               'grep -q after-reboot ~/.local/state/harness-os/updates/approved.json && exit 0; sleep .5; done; exit 1', timeout=190)
    vm.screenshot('system-channel-single-action-no-password')
    vm.command('test "$(pacman -Q harness-os)" = ' + shlex.quote('harness-os ' + manifest['package']['version']))
    # The new package now owns its real policy. Remove the bootstrap fixture
    # only after passwordless activation has been independently established.
    vm.command('printf %s ' + shlex.quote(config['password'] + '\n') + ' | sudo -S -v; '
               'sudo rm /etc/sudoers.d/99-harness-test-updates; sudo -K')
    vm.command('while read -r pid; do kill -0 "$pid" || exit 1; done < /tmp/fast-original-agent; '
               'kill -0 "$(cat /tmp/fast-original-pid)"; cmp /tmp/fast-original-boot /proc/sys/kernel/random/boot_id')
    vm.command('python3 -c ' + shlex.quote("import json; assert json.load(open('/run/harness-os-restart-required'))['status'] == 'ready'"))
    available(False)
    checks.append('Super+u alone applies the verified OS package with no sudo credential, confirmation or password; unrelated root commands and local bundles remain denied')
    checks.append('Private root download rebuilds initramfs and preserves live processes; no duplicate update is offered')
    _, status = vm.command('harness updates apply', check=False)
    assert status != 0, 'Fast runtime changed before the OS restart'
    checks.append('Fast activation stays paused until the OS reboot')
    # Keep the private release server outside volatile /tmp for the one approved
    # post-reboot runtime step. This is test-only, never part of the OS image.
    vm.command('mkdir -p ~/update-test; cp -R /tmp/fast-updates/. ~/update-test/; '
               'printf %s ' + shlex.quote('[Service]\nExecStart=\nExecStart=/usr/bin/python3 /usr/lib/harness-os/live_update.py check --feeds /home/me/update-test/feeds-both.json\n') +
               ' > ~/.config/systemd/user/harness-update.service.d/fixture.conf; systemctl --user daemon-reload')
    receipt = {'status': 'passed', 'source_commit': manifest['source_commit'],
               'package': manifest['package'], 'checks': checks}
    (vm.folder / 'system-channel-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt


def finish_after_reboot(vm):
    vm.command('systemd-run --user --collect --unit=harness-test-feed python3 -m http.server 19447 '
               '--bind 127.0.0.1 --directory /home/me/update-test')
    vm.command('for n in $(seq 1 30); do curl -fsS http://127.0.0.1:19447/fixture.json && exit 0; sleep .2; done; exit 1')
    # The original approval authorizes this once. No second shortcut is sent.
    vm.command('systemctl --user start harness-update.service', timeout=240)
    vm.command('test ! -e ~/.local/state/harness-os/updates/approved.json; '
               'hn --version | grep -F 999.0.1; test "$(harness version)" = 999.0.1')
    vm.screenshot('system-channel-approved-runtime-finished')
    return 'The same update request finishes hn/CLI against the new OS base after encrypted reboot, without another confirmation or shortcut'
