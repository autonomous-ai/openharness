#!/usr/bin/env python3
"""VM-only fresh installed boot fixture with interrupted boot/account enrollment."""
import importlib.util
import json
import os
from pathlib import Path
import sys

def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

startup = module('startup', '/var/tmp/startup.py')
fixture = module('fixture', '/var/tmp/harness-target-guest.py')
storage = startup.storage
PASSWORD = 'firstboot-local-42'
RESULT = Path('/var/tmp/harness-startup-result.json')


def main():
    action = sys.argv[1]
    fixture.guard()
    startup.target.platform_esp = lambda: fixture.ESP
    inputs = json.loads(Path('/var/tmp/harness-startup-input.json').read_text())
    assert fixture.run('lsblk', '-ndo', 'SERIAL', '/dev/vdc') == 'HARNESS_PAYLOAD'
    payload = storage.Payload('/dev/vdc', inputs['image_sha256'], inputs['source_commit'])
    fixture.mount()
    try:
        baseline = json.loads(fixture.BASELINE.read_text())
        expected = {k: v for k, v in baseline.items() if k not in ('table', 'started_at')}
        if action == 'prepare':
            startup.target.apply_plan(fixture.PLAN)
            storage.install(fixture.PLAN, payload, PASSWORD)
        saved = storage.read_state(fixture.PLAN.with_name('storage.json'), startup.target.load_plan(fixture.PLAN),
                                   payload.sha256, payload.source_commit)
        # QEMU has serial output and virtio input, unlike the physical Apple
        # firmware console/keyboard. Only these observer hardware additions differ.
        configuration = startup.configuration
        def observer_configuration(*args):
            config = configuration(*args)
            consoles = ' console=ttyAMA0 console=tty0'
            config['etc/kernel/cmdline'] = config['etc/kernel/cmdline'].strip() + consoles + '\n'
            config['etc/default/grub'] = config['etc/default/grub'].replace(
                '=harness-root"', '=harness-root' + consoles + '"')
            config['etc/dracut.conf.d/20-harness-crypt.conf'] += 'force_drivers+=" virtio_input "\n'
            return config
        startup.configuration = observer_configuration
        def interrupted(phase):
            if (action, phase) in (('prepare', 'boot'), ('account', 'account')):
                os._exit(78 if phase == 'boot' else 79)
        if action == 'prepare':
            foreign = fixture.ROOT / 'EFI/BOOT/BOOTAA64.EFI'
            foreign.parent.mkdir(parents=True)
            foreign.write_bytes(b'Keep the existing loader')
            try:
                startup.finish(fixture.PLAN, payload, PASSWORD)
                raise AssertionError('Overwrote a foreign EFI boot loader')
            except startup.Error as error:
                assert 'existing EFI loader' in str(error)
            assert foreign.read_bytes() == b'Keep the existing loader'
            foreign.unlink()
        state = startup.finish(fixture.PLAN, payload, PASSWORD, progress=interrupted)
        assert action == 'finish' and state['phase'] == 'complete'
        assert fixture.protected() == expected
        plan = startup.target.load_plan(fixture.PLAN)
        assert not startup.target.remaining(plan, startup.target.read_table(fixture.DISK))
        # Re-enter the completed installer before first boot. The account's
        # password and home must stay unchanged, and no recopy may run.
        receipt_before = state.copy()
        assert storage.install(fixture.PLAN, payload, PASSWORD)['phase'] == 'copied'
        assert startup.finish(fixture.PLAN, payload, PASSWORD) == receipt_before
        assert fixture.protected() == expected
        loader = fixture.ROOT / 'EFI/BOOT/BOOTAA64.EFI'
        backup = fixture.PLAN.with_name('loader-test-backup')
        loader.rename(backup)
        try:
            try:
                startup.finish(fixture.PLAN, payload, PASSWORD)
                raise AssertionError('Reported a complete install with a missing EFI loader')
            except startup.Error as error:
                assert 'existing EFI loader' in str(error)
            assert not loader.exists()
        finally:
            backup.rename(loader)
        RESULT.write_text(json.dumps({'status': 'passed', 'startup': state, 'storage': saved,
            'protected_data_unchanged': True, 'completed_retry': True, 'missing_loader_refused': True,
            'observer_arguments': 'console=ttyAMA0 console=tty0', 'observer_driver': 'virtio_input'}, indent=2) + '\n')
    finally:
        if fixture.ROOT.is_mount():
            fixture.run('umount', fixture.ROOT)


if __name__ == '__main__':
    main()
