#!/usr/bin/python3
"""VM-only observer for the real private installer. Never run on host disks."""
import importlib.util
import json
from pathlib import Path
import sys


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


ui = module('install', '/var/tmp/install.py')
fixture = module('fixture', '/var/tmp/harness-target-guest.py')
fixture.guard()
ui.target.platform_esp = lambda: fixture.ESP
assert fixture.run('lsblk', '-ndo', 'SERIAL', '/dev/vdc') == 'HARNESS_PAYLOAD'


def inspect():
    # The live form already has a read-only view. Observe with the same flags;
    # asking for a writable FAT superblock here would conflict with that view.
    fixture.run('mount', '-t', 'vfat', '-o', 'ro,noatime,uid=0,gid=0,fmask=0177,dmask=0077',
                fixture.DISK + '2', fixture.ROOT)
    try:
        baseline = json.loads(fixture.BASELINE.read_text())
        protected = fixture.protected()
        assert protected == {k: v for k, v in baseline.items() if k not in ('table', 'started_at')}
        result = {'protected': protected, 'metadata': fixture.metadata(),
                  'esp_sha256': fixture.digest(fixture.DISK + '2')}
        if fixture.PLAN.exists():
            plan = ui.target.load_plan(fixture.PLAN)
            result['plan'] = plan
            result['remaining'] = ui.target.remaining(plan, ui.target.read_table(fixture.DISK))
            for name in ('storage', 'startup'):
                result[name] = json.loads(fixture.PLAN.with_name(name + '.json').read_text())
        Path('/var/tmp/harness-install-inspection.json').write_text(json.dumps(result, indent=2) + '\n')
    finally:
        fixture.run('umount', fixture.ROOT)


if sys.argv[1] == 'reset-plan':
    # initialize() owns this blank fixture and creates its first plan. Remove
    # only that never-applied plan so the real UI must discover and save its own.
    fixture.mount()
    try:
        plan = ui.target.load_plan(fixture.PLAN)
        assert ui.target.remaining(plan, ui.target.read_table(fixture.DISK)) == plan['additions']
        fixture.PLAN.unlink()
        fixture.PLAN.with_name('target.json.lock').unlink()
        fixture.PLAN.parent.rmdir()
    finally:
        fixture.run('umount', fixture.ROOT)
    inspect()
elif sys.argv[1] == 'inspect':
    inspect()
elif sys.argv[1] == 'reject-mounted':
    occupied = Path('/mnt/harness-occupied-test')
    occupied.mkdir()
    fixture.run('mount', '-o', 'ro,noload', '/dev/vdb5', occupied)
    try:
        try:
            with ui.destination():
                raise AssertionError('An in-use target was offered for installation')
        except ui.target.TargetError as error:
            assert 'in use' in str(error)
    finally:
        fixture.run('umount', occupied)
        occupied.rmdir()
else:
    assert sys.argv[1] == 'screen'
    # QEMU has no Apple firmware handoff. It also needs only these two display
    # observer additions for the installed boot; all target guards still run.
    configuration = ui.startup.configuration
    def observed(*args):
        config = configuration(*args)
        consoles = ' console=ttyAMA0 console=tty0'
        config['etc/kernel/cmdline'] = config['etc/kernel/cmdline'].strip() + consoles + '\n'
        config['etc/default/grub'] = config['etc/default/grub'].replace(
            '=harness-root"', '=harness-root' + consoles + '"')
        config['etc/dracut.conf.d/20-harness-crypt.conf'] += 'force_drivers+=" virtio_input "\n'
        return config
    ui.startup.configuration = observed
    sys.argv = [sys.argv[0], *sys.argv[2:]]
    ui.main()
