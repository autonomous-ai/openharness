import copy
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

import package_image_binding as binding
import public_update_vm as observer
from vm import workspace_text_visible


class PublicUpdateObserverTests(unittest.TestCase):
    def test_recorded_welcome_is_ready_only_for_explicit_upgrade_checks(self):
        # The actual rendered frame in run37459029285; the shared client can
        # return to this welcome after reboot. Real key/output checks follow.
        welcome = ('HARHESS\nEnter\nStart OpenCode\nt\nNew terminal\nw\nConnect to Wi-Fi\n'
                   'Super+t terminal\nSuper+w\nWi-Fi\nSuper+b\nbrowser')
        self.assertTrue(workspace_text_visible(welcome, allow_welcome=True))
        self.assertFalse(workspace_text_visible(welcome))
        self.assertTrue(workspace_text_visible('[me@harness ~]$'))
        for partial in ['', 'harness login:', 'HARNESS', 'New terminal',
                        'Start OpenCode\nNew terminal', 'Connect to Wi-Fi']:
            self.assertFalse(workspace_text_visible(partial, allow_welcome=True))

    def test_running_compositor_must_be_the_expected_package_binary(self):
        expected = {'binary': {'sha256': 'a' * 64}}
        good = dict(executable='/usr/lib/harness-os/labwc', owner='harness-os', sha256='a' * 64)
        observer.display_matches(good, expected)
        for key in good:
            with self.subTest(key=key), self.assertRaises(ValueError):
                observer.display_matches(dict(good, **{key: 'wrong'}), expected)
        original = dict(executable='/usr/bin/labwc', owner='labwc', sha256='b' * 64)
        observer.display_matches(original, original, restored=True)
        with self.assertRaises(ValueError):
            observer.display_matches(good, original, restored=True)

    def test_one_replaced_process_or_project_change_cannot_pass(self):
        before = {'agents': [{'pid': 42, 'start': 100}], 'daemon': {'pid': 12, 'start': 1},
                  'terminal': {'pid': 50, 'start': 101}, 'project': {'notes': 'digest'},
                  'boot_id': 'original-boot', 'heartbeat': 100}
        after = dict(before, heartbeat=200)
        observer.same_work(before, after)
        for key in ('agents', 'daemon', 'terminal', 'project', 'boot_id', 'heartbeat'):
            bad = copy.deepcopy(after)
            bad[key] = 100 if key == 'heartbeat' else 'changed'
            with self.subTest(key=key), self.assertRaises(ValueError):
                observer.same_work(before, bad)

    def test_installed_bytes_permissions_links_and_ownership_are_checked(self):
        files = [dict(name='usr/lib/harness/hn', type='symlink', target='harness-tui', mode=0o777, uid=0, gid=0),
                 dict(name='usr/lib/harness/harness-tui', type='file', bytes=10, sha256='a'*64, mode=0o755, uid=0, gid=0)]
        receipt = dict(runtime={'source_commit': 'a'*40}, package_version='1-1',
                       members=[dict(archive=row) for row in files])
        installed = dict(runtime=receipt['runtime'], package_version='1-1', owned_files={
            row['name']: {k: v for k, v in row.items() if k != 'name'} for row in files})
        observer.installed_matches(installed, receipt)
        for key in ('mode', 'uid', 'gid', 'bytes', 'sha256', 'type'):
            bad = copy.deepcopy(installed)
            bad['owned_files'][files[1]['name']][key] = 'wrong'
            with self.subTest(key=key), self.assertRaises(ValueError):
                observer.installed_matches(bad, receipt)
        for change in ('missing', 'extra', 'link'):
            bad = copy.deepcopy(installed)
            if change == 'missing': bad['owned_files'].pop(files[0]['name'])
            elif change == 'extra': bad['owned_files']['usr/undeclared'] = files[1]
            else: bad['owned_files'][files[0]['name']]['target'] = 'another-binary'
            with self.subTest(change=change), self.assertRaises(ValueError):
                observer.installed_matches(bad, receipt)

    def test_binding_must_cover_exact_artifacts_and_every_member(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            version = '0.1.0pre15-1'
            package = root / ('harness-os-' + version + '-x86_64.pkg.tar.gz')
            with tarfile.open(package, 'w:gz') as archive:
                for name, data in {'.PKGINFO': ('pkgname = harness-os\npkgver = '+version+'\narch = x86_64\n').encode(),
                                   'usr/test': b'actual candidate bytes'}.items():
                    info = tarfile.TarInfo(name)
                    info.mode, info.size = 0o644, len(data)
                    archive.addfile(info, io.BytesIO(data))
            runtime = {'source_commit': 'a'*40}
            manifest = dict(source_commit='a'*40, runtime=runtime,
                            package=dict(name=package.name, version=version, **binding.identity(package)))
            image = dict(source_commit='a'*40, harness_inputs=runtime,
                         iso={'name': 'candidate.iso', 'bytes': 42, 'sha256': 'b'*64})
            manifest_path, image_path, receipt_path = (root / name for name in ('package-manifest.json', 'manifest.json', 'binding.json'))
            manifest_path.write_text(json.dumps(manifest))
            image_path.write_text(json.dumps(image))
            receipt = dict(status='passed', overrides=[], source_commit='a'*40, runtime=runtime,
                           package_version=version, package=dict(name=package.name, **binding.identity(package)),
                           package_manifest=binding.identity(manifest_path), image_manifest=binding.identity(image_path),
                           image={k: image['iso'][k] for k in ('bytes', 'sha256')},
                           members=[dict(archive=row, equal=True) for row in binding.archive_inventory(package, version)])
            receipt_path.write_text(json.dumps(receipt))
            observer.verify_binding(root, image_path, receipt_path)
            for change in ('source', 'failed', 'override', 'omitted', 'unequal', 'changed-archive', 'wrong-image'):
                bad = copy.deepcopy(receipt)
                if change == 'source': bad['source_commit'] = 'c'*40
                elif change == 'failed': bad['status'] = 'failed'
                elif change == 'override': bad['overrides'] = ['ignore changed bytes']
                elif change == 'omitted': bad['members'] = []
                elif change == 'unequal': bad['members'][0]['equal'] = False
                elif change == 'changed-archive': bad['members'][0]['archive']['mode'] = 0o777
                else: bad['image']['sha256'] = '0'*64
                receipt_path.write_text(json.dumps(bad))
                with self.subTest(change=change), self.assertRaises(ValueError):
                    observer.verify_binding(root, image_path, receipt_path)


if __name__ == '__main__':
    unittest.main()
