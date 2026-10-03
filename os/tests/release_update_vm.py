"""Exercise the actual OS release transport on a disposable installed VM."""
import json
import shlex
from session_vm import put


def exercise(vm, manifest):
    # Retain the new bootstrap outside pacman-owned paths before restoring the
    # public preview. It has no updater; this is its one-time migration path.
    vm.command('mkdir -p /tmp/system-channel; cp /usr/lib/harness-os/release_update.py '
               '/usr/lib/harness-os/runtime_update.py /tmp/system-channel/')
    vm.command('cp /tmp/update-bundle/package-manifest.json /tmp/fast-updates/; '
               'cp /tmp/update-bundle/' + shlex.quote(manifest['package']['name']) + ' /tmp/fast-updates/')
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
    vm.command('sudo harness rollback', timeout=180)
    feed = ' --feed http://127.0.0.1:19447/os-metadata.json'
    updater = 'python3 /tmp/system-channel/release_update.py '
    def available(expected):
        vm.command(updater + 'check' + feed + ' > /tmp/system-channel/discovery.json')
        vm.command('python3 -c ' + shlex.quote("import json; assert json.load(open('/tmp/system-channel/discovery.json'))['available'] is " + str(expected)))
    available(True)
    checks = ['Restored public preview discovers the newer real OS package through the verified release manifest']
    package = '/tmp/fast-updates/' + manifest['package']['name']
    vm.command('cp ' + shlex.quote(package) + ' /tmp/good-os-package; printf broken > ' + shlex.quote(package))
    _, status = vm.command('sudo ' + updater + 'apply' + feed, timeout=180, check=False)
    assert status != 0, 'A corrupt channel package was accepted'
    checks.append('A corrupt download is rejected before the package transaction')
    vm.command('cp /tmp/good-os-package ' + shlex.quote(package))
    output, _ = vm.command('sudo ' + updater + 'apply' + feed, timeout=180)
    (vm.folder / 'system-channel-apply.log').write_text(output)
    vm.command('test "$(pacman -Q harness-os)" = ' + shlex.quote('harness-os ' + manifest['package']['version']))
    vm.command('while read -r pid; do kill -0 "$pid" || exit 1; done < /tmp/fast-original-agent; '
               'kill -0 "$(cat /tmp/fast-original-pid)"; cmp /tmp/fast-original-boot /proc/sys/kernel/random/boot_id')
    vm.command('python3 -c ' + shlex.quote("import json; assert json.load(open('/run/harness-os-restart-required'))['status'] == 'ready'"))
    available(False)
    checks.append('Private root download applies offline from loopback, rebuilds initramfs, preserves live processes and offers no duplicate update')
    _, status = vm.command('harness updates apply', check=False)
    assert status != 0, 'Fast runtime changed before the OS restart'
    checks.append('Fast activation stays paused until the OS reboot')
    receipt = {'status': 'passed', 'source_commit': manifest['source_commit'],
               'package': manifest['package'], 'checks': checks}
    (vm.folder / 'system-channel-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt
