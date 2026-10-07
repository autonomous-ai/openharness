"""Cold recovery safety boundaries; real Btrfs/SELinux/boot need native acceptance."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

spec = importlib.util.spec_from_file_location('fedora_recovery', Path(__file__).resolve().parents[1] /
                                               'platforms/apple-silicon/recovery.py')
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


def copy_files(source, destination, *, exclude=(), metadata=True):
    """Host fixture backend only; preserve real file metadata and hardlinks."""
    links = {}

    def remove(path):
        if path.is_symlink() or not path.is_dir():
            path.unlink()
        else:
            shutil.rmtree(path)

    def walk(src, dst, prefix=''):
        dst.mkdir(parents=True, exist_ok=True)
        for old in dst.iterdir():
            name = prefix + old.name
            if not recovery.under(name, exclude) and not os.path.lexists(src / old.name):
                remove(old)
        for path in src.iterdir():
            name = prefix + path.name
            if recovery.under(name, exclude):
                continue
            new = dst / path.name
            if path.is_dir() and not path.is_symlink():
                if os.path.lexists(new) and (new.is_symlink() or not new.is_dir()):
                    remove(new)
                walk(path, new, name + '/')
            else:
                if os.path.lexists(new):
                    remove(new)
                key = (path.lstat().st_dev, path.lstat().st_ino)
                if path.is_symlink():
                    new.symlink_to(os.readlink(path))
                    shutil.copystat(path, new, follow_symlinks=False)
                elif key in links:
                    os.link(links[key], new)
                else:
                    shutil.copy2(path, new)
                    links[key] = new
        if metadata:
            shutil.copystat(src, dst)
    walk(source, destination)


class Interruption(Exception):
    pass


class Recovery(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.area = Path(temporary.name)
        self.top, self.boot, self.esp = (self.area / n for n in ('top', 'boot', 'esp'))
        self.root = self.top / 'root'
        for path in (self.root, self.top / 'home', self.boot, self.esp):
            path.mkdir(parents=True)
        for name in recovery.SEPARATE:
            (self.root / name).mkdir()
        for name in ('usr/lib/sysimage/rpm', 'var/lib/selinux', 'var/lib/alternatives', recovery.DNF_STATE, recovery.DNF_DATA):
            (self.root / name).mkdir(parents=True, exist_ok=True)
        self.write(self.root, 'usr/lib/os-release', 'ID=fedora\n')
        self.write(self.root, 'usr/share/harness-os/runtime.json', '{"system_profile":"fedora"}')
        self.write(self.root, 'etc/selinux/semanage.conf', 'module-store = direct\n')
        (self.root / 'var/lib/rpm').symlink_to('../../usr/lib/sysimage/rpm')
        for name in ('usr/lib/sysimage/rpm/rpmdb.sqlite', 'usr/lib/modules/old-kernel/module', 'etc/alternatives/editor',
                     'var/lib/selinux/policy', 'var/lib/alternatives/editor', 'var/lib/harness-os/session-setup.json'):
            self.write(self.root, name, 'before')
        self.write(self.root, recovery.DNF_STATE + '/state', 'owned pending DNF')
        self.write(self.root, recovery.DNF_DATA + '/package.rpm', 'owned pending RPM')
        (self.root / 'system-update').symlink_to('/' + recovery.DNF_STATE)
        self.write(self.root, 'var/lib/containers/data', 'old container')
        self.write(self.root, 'var/lib/libvirt/images/vm', 'old VM')
        self.write(self.root, 'var/lib/database/db', 'old database')
        os.link(self.root / 'var/lib/containers/data', self.root / 'var/lib/containers/link')
        self.write(self.top / 'home', 'person/project', 'old project')
        self.write(self.boot, 'vmlinuz-old', 'old kernel')
        self.write(self.boot, 'efi/mountpoint-sentinel', 'separate mountpoint')
        self.write(self.esp, 'EFI/BOOT/BOOTAA64.EFI', 'old shim')
        self.write(self.esp, 'EFI/fedora/grub.cfg', 'old grub')
        self.write(self.esp, 'm1n1/boot.bin', 'old m1n1')
        self.write(self.esp, 'm1n1/config', 'protected m1n1 configuration')
        self.write(self.esp, 'vendor/keep.bin', 'protected vendor bytes')
        self.engine = recovery.Engine(self.top, self.boot, self.esp, {'installation': 'fixture'})
        self.name = 'a' * 32
        self.volumes = {}
        self.register(self.root)
        self.register(self.top / 'home')
        self.writes = []
        if not hasattr(os, 'listxattr'):
            # macOS Python lacks the Linux xattr API. Native acceptance checks
            # real SELinux labels/ACLs; the portable lifecycle tests do not.
            patcher = patch.object(recovery, 'attributes', return_value={})
            patcher.start()
            self.addCleanup(patcher.stop)
        for name, replacement in (('run', self.command), ('copy_tree', copy_files),
                                  ('snapshot', self.snapshot), ('subvolume', self.subvolume)):
            patcher = patch.object(recovery, name, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

    def write(self, root, name, value):
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)
        return path

    def register(self, path, parent='-', readonly=False):
        self.volumes[path.stat().st_ino] = {'UUID': str(uuid.uuid4()), 'Parent UUID': parent, 'ro': readonly}

    def subvolume(self, path, *, readonly=None):
        value = self.volumes[path.stat().st_ino]
        if readonly is not None and value['ro'] != readonly:
            raise recovery.Error('Snapshot protection changed')
        return value

    def snapshot(self, source, destination, *, readonly):
        if not destination.exists():
            copy_files(source, destination)
            self.register(destination, self.subvolume(source)['UUID'], readonly)
        value = self.subvolume(destination, readonly=readonly)
        if value['Parent UUID'] != self.subvolume(source)['UUID']:
            raise recovery.Error('Snapshot source changed')
        return value['UUID']

    def command(self, command, *args, **kwargs):
        if command == 'mount':
            self.writes.append(str(args[-1]))
        elif command == 'rsync':
            shutil.copy2(args[-2], args[-1])
        elif command != 'sync':
            raise AssertionError((command, args))
        return ''

    def checkpoint_then_change(self):
        self.engine.checkpoint(self.name)
        for name in ('usr/lib/sysimage/rpm/rpmdb.sqlite', 'etc/alternatives/editor', 'var/lib/selinux/policy',
                     'var/lib/alternatives/editor', 'var/lib/harness-os/session-setup.json'):
            self.write(self.root, name, 'failed update')
        self.write(self.root, 'usr/lib/modules/new-kernel/module', 'failed module')
        self.write(self.root, 'var/lib/containers/data', 'latest container')
        self.write(self.root, 'var/lib/libvirt/images/vm', 'latest VM')
        self.write(self.root, 'var/lib/database/db', 'latest database')
        self.write(self.top / 'home', 'person/project', 'latest project')
        self.write(self.boot, 'vmlinuz-old', 'damaged kernel')
        self.write(self.boot, 'vmlinuz-new', 'failed kernel')
        self.write(self.esp, 'EFI/fedora/grub.cfg', 'failed grub')
        self.write(self.esp, 'm1n1/boot.bin', 'failed m1n1')
        self.before = recovery.system_digest(self.engine.folder(self.name) / 'root')
        self.failed = recovery.inventory(self.root)
        self.work = recovery.work_digest(self.root)
        self.home = recovery.inventory(self.top / 'home')
        self.protected = recovery.inventory(self.esp, include=recovery.efi_protected, metadata=False)
        self.writes.clear()

    def assert_recovered(self):
        folder = self.engine.folder(self.name)
        self.assertEqual(recovery.system_digest(self.root), self.before)
        self.assertEqual(recovery.work_digest(self.root), self.work)
        self.assertEqual(recovery.inventory(self.top / 'home'), self.home)
        self.assertEqual(recovery.inventory(folder / 'failed-root'), self.failed)
        self.assertEqual(recovery.inventory(folder / 'replaced-root'), self.failed)
        self.assertTrue(self.subvolume(folder / 'failed-root')['ro'])
        self.assertEqual(recovery.inventory(self.esp, include=recovery.efi_protected, metadata=False), self.protected)
        self.assertEqual((self.boot / 'vmlinuz-old').read_text(), 'old kernel')
        self.assertFalse((self.boot / 'vmlinuz-new').exists())
        self.assertEqual((self.boot / 'efi/mountpoint-sentinel').read_text(), 'separate mountpoint')
        self.assertEqual((self.esp / 'm1n1/boot.bin').read_text(), 'old m1n1')
        for name in (recovery.DNF_STATE, recovery.DNF_DATA, 'system-update'):
            self.assertFalse(os.path.lexists(self.root / name), name)
        self.assertEqual((self.root / 'var/lib/containers/data').stat().st_ino,
                         (self.root / 'var/lib/containers/link').stat().st_ino)

    def test_paired_system_restore_preserves_current_work_and_failed_evidence(self):
        self.checkpoint_then_change()
        state = self.engine.recover(self.name)
        self.assertEqual(state['phase'], 'complete')
        self.assert_recovered()
        before = recovery.inventory(self.top)
        self.engine.recover(self.name)
        self.assertEqual(recovery.inventory(self.top), before)

    def test_all_durable_phase_interruptions_resume_without_losing_current_work(self):
        self.checkpoint_then_change()
        original = self.engine.advance
        for stop in recovery.PHASES[1:]:
            def interrupt(folder, state, phase):
                original(folder, state, phase)
                if phase == stop:
                    raise Interruption(phase)
            with self.subTest(phase=stop), patch.object(self.engine, 'advance', interrupt), self.assertRaises(Interruption):
                self.engine.recover(self.name)
        self.engine.recover(self.name)
        self.assert_recovered()

    def test_both_root_renames_resume_if_the_following_journal_write_is_interrupted(self):
        self.checkpoint_then_change()
        original = self.engine.advance
        for stop in ('root-moved', 'complete'):
            def interrupt(folder, state, phase):
                if phase == stop:
                    raise Interruption(phase)
                original(folder, state, phase)
            with self.subTest(phase=stop), patch.object(self.engine, 'advance', interrupt), self.assertRaises(Interruption):
                self.engine.recover(self.name)
        self.engine.recover(self.name)
        self.assert_recovered()

    def test_interrupted_boot_copy_resumes_from_intact_failed_evidence(self):
        self.checkpoint_then_change()
        def interrupt(source, destination, **kwargs):
            if destination == self.boot:
                (self.boot / 'vmlinuz-old').write_text('partial copy')
                raise Interruption()
            copy_files(source, destination, **kwargs)
        with patch.object(recovery, 'copy_tree', interrupt), self.assertRaises(Interruption):
            self.engine.recover(self.name)
        self.assertEqual((self.engine.folder(self.name) / 'failed-boot/vmlinuz-old').read_text(), 'damaged kernel')
        self.engine.recover(self.name)
        self.assert_recovered()

    def pause_at_candidate(self):
        original = self.engine.advance
        def interrupt(folder, state, phase):
            original(folder, state, phase)
            if phase == 'candidate':
                raise Interruption()
        with patch.object(self.engine, 'advance', interrupt), self.assertRaises(Interruption):
            self.engine.recover(self.name)
        self.writes.clear()

    def test_changed_candidate_rejects_before_any_boot_write(self):
        self.checkpoint_then_change()
        self.pause_at_candidate()
        self.write(self.engine.folder(self.name) / 'candidate', 'usr/lib/sysimage/rpm/rpmdb.sqlite', 'tampered')
        boot = recovery.inventory(self.boot)
        with self.assertRaisesRegex(recovery.Error, 'candidate changed'):
            self.engine.recover(self.name)
        self.assertEqual(recovery.inventory(self.boot), boot)
        self.assertFalse(self.writes)

    def test_new_work_after_interruption_rejects_without_overwriting_it(self):
        self.checkpoint_then_change()
        self.pause_at_candidate()
        self.write(self.root, 'var/lib/database/db', 'new work after failed recovery')
        before = recovery.inventory(self.root)
        with self.assertRaisesRegex(recovery.Error, 'failed root changed'):
            self.engine.recover(self.name)
        self.assertEqual(recovery.inventory(self.root), before)
        self.assertFalse(self.writes)

    def test_foreign_trigger_is_rejected_before_checkpoint_or_restore_writes(self):
        self.checkpoint_then_change()
        (self.root / 'system-update').unlink()
        (self.root / 'system-update').symlink_to('/another-updater')
        for operation in (lambda: self.engine.checkpoint('b' * 32), lambda: self.engine.recover(self.name)):
            with self.assertRaisesRegex(recovery.Error, 'different offline updater'):
                operation()
            self.assertFalse(self.writes)

    def test_linked_or_writable_dnf_state_is_not_deleted(self):
        for name in (recovery.DNF_STATE, recovery.DNF_DATA):
            directory = self.root / name
            child = directory / 'redirect'
            child.symlink_to(self.top / 'home')
            with self.subTest(name=name), self.assertRaises(recovery.Error):
                self.engine.clean_offline(self.root)
            self.assertTrue(child.is_symlink())
            self.assertTrue((self.root / 'system-update').is_symlink())
            child.unlink()
            directory.chmod(0o777)
            with self.assertRaises(recovery.Error):
                self.engine.clean_offline(self.root)
            directory.chmod(0o755)

    def test_cross_boundary_hardlink_is_refused_before_mutation(self):
        os.link(self.root / 'usr/lib/sysimage/rpm/rpmdb.sqlite', self.root / 'var/lib/database/cross-link')
        with self.assertRaisesRegex(recovery.Error, 'hardlink crosses'):
            self.engine.checkpoint(self.name)
        self.assertFalse(self.writes)

    def test_checkpoint_identity_and_archive_content_are_verified_before_mutation(self):
        self.checkpoint_then_change()
        identity = copy.deepcopy(self.engine.identity)
        self.engine.identity['installation'] = 'another installation'
        with self.assertRaisesRegex(recovery.Error, 'another installation'):
            self.engine.recover(self.name)
        self.engine.identity = identity
        self.write(self.engine.folder(self.name) / 'boot', 'vmlinuz-old', 'corrupted archive')
        with self.assertRaisesRegex(recovery.Error, 'contents do not verify'):
            self.engine.recover(self.name)
        self.assertFalse(self.writes)

    def test_nested_subvolume_inventory_and_unowned_top_level_paths_are_refused(self):
        with patch.object(recovery, 'run', return_value='ID 256 gen 1 top level 5 path root\nID 257 gen 1 top level 5 path home\nID 258 gen 1 top level 256 path root/var/lib/machines'):
            with self.assertRaisesRegex(recovery.Error, 'nested Btrfs subvolume'):
                recovery.validate_layout(self.top)
        (self.top / 'unhandled').mkdir()
        with self.assertRaisesRegex(recovery.Error, 'top-level Btrfs layout'):
            recovery.validate_layout(self.top)

    def test_private_archive_path_does_not_follow_a_symlink_or_expose_snapshots(self):
        store = self.top / recovery.STORE
        store.symlink_to(self.top / 'home')
        with self.assertRaises(recovery.Error):
            self.engine.checkpoint(self.name)
        store.unlink()
        store.mkdir(mode=0o755)
        with self.assertRaises(recovery.Error):
            self.engine.checkpoint(self.name)
        self.assertFalse(self.writes)

    def test_custom_package_state_layout_is_not_partially_restored(self):
        (self.root / 'etc/alternatives.admindir').write_text('/var/other')
        with self.assertRaisesRegex(recovery.Error, 'Custom RPM or alternatives'):
            self.engine.checkpoint(self.name)
        self.assertFalse(self.writes)

    def test_empty_directory_left_before_first_record_can_resume_checkpoint(self):
        folder = self.engine.folder(self.name)
        folder.parent.mkdir(mode=0o700)
        folder.mkdir(mode=0o700)
        self.engine.checkpoint(self.name)
        self.assertEqual(recovery.read_json(folder / 'checkpoint.json')['phase'], 'complete')

    def test_work_digest_includes_raw_labels_and_acl_bytes(self):
        with patch.object(recovery, 'attributes', return_value={'security.selinux': 'original', 'system.posix_acl_access': 'acl'}):
            before = recovery.work_digest(self.root)
        with patch.object(recovery, 'attributes', return_value={'security.selinux': 'changed', 'system.posix_acl_access': 'acl'}):
            self.assertNotEqual(recovery.work_digest(self.root), before)
        with patch.object(recovery, 'attributes', return_value={'security.selinux': 'original', 'system.posix_acl_access': 'changed'}):
            self.assertNotEqual(recovery.work_digest(self.root), before)


class MountBoundary(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.area = Path(temporary.name)
        proc = self.area / 'proc'
        (proc / '1/ns').mkdir(parents=True)
        (proc / '1/ns/mnt').symlink_to('mnt:[1]')
        self.info = proc / '1/mountinfo'
        self.info.write_text('1 0 8:2 / /owned-esp rw - vfat /dev/esp rw\n')
        sysfs = self.area / 'sysfs'
        sysfs.mkdir()
        def path(value):
            return {'/proc': proc, '/sys/fs/btrfs': sysfs}.get(value, Path(value))
        original_stat = os.stat
        def device(value, *args, **kwargs):
            if str(value) in ('/dev/root-target', '/dev/esp'):
                return SimpleNamespace(st_rdev=os.makedev(8, 33 if str(value) == '/dev/root-target' else 2))
            return original_stat(value, *args, **kwargs)
        for name, replacement in (('Path', path),):
            patcher = patch.object(recovery, name, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch.object(recovery.os, 'stat', device)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_an_unresolvable_device_alias_cannot_hide_a_mounted_partition(self):
        self.info.write_text('1 0 8:33 / /busy rw - ext4 /dev/missing-alias rw\n')
        with self.assertRaisesRegex(recovery.Error, 'target is mounted'):
            recovery.unmounted(('/dev/root-target',), '/dev/esp', Path('/owned-esp'), 'fixture')

    def test_mounted_btrfs_is_detected_without_its_source_alias(self):
        (self.area / 'sysfs/fixture/features').mkdir(parents=True)
        with self.assertRaisesRegex(recovery.Error, 'Btrfs filesystem is mounted'):
            recovery.unmounted(('/dev/root-target',), '/dev/esp', Path('/owned-esp'), 'fixture')

    def test_nested_esp_mount_is_refused(self):
        self.info.write_text('1 0 0:1 / /owned-esp/m1n1 rw - tmpfs tmpfs rw\n')
        with self.assertRaisesRegex(recovery.Error, 'below the owned ESP'):
            recovery.unmounted(('/dev/root-target',), '/dev/esp', Path('/owned-esp'), 'fixture')


class TrustedCommands(unittest.TestCase):
    def test_run_uses_fixed_paths_and_environment(self):
        # Reach the real helper; Recovery's fixture replacement is scoped to it.
        result = unittest.mock.Mock(returncode=0, stdout='ok\n')
        with patch.object(recovery.subprocess, 'run', return_value=result) as run:
            self.assertEqual(recovery.run('btrfs', 'subvolume', 'show', '/private-target'), 'ok')
        self.assertEqual(run.call_args.args[0], ['/usr/bin/btrfs', 'subvolume', 'show', '/private-target'])
        self.assertEqual(run.call_args.kwargs['env'], {'PATH': '/usr/sbin:/usr/bin', 'LC_ALL': 'C'})
        with self.assertRaises(KeyError):
            recovery.run('/tmp/writable-helper')


if __name__ == '__main__':
    unittest.main()
