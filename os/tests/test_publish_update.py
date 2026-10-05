import copy
import importlib.util
import json
from pathlib import Path
import unittest
import test_runtime_update

spec = importlib.util.spec_from_file_location('publish_update', Path(__file__).parents[1] / 'tools/publish-update.py')
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)


class PublicationGuards(unittest.TestCase):
    def setUp(self):
        self.fixture = test_runtime_update.BundleGuards()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.runtime['versions'] = {'hn': '0.1.12', 'cli': '0.3.57'}
        self.fixture.make_package()
        self.bundle = self.fixture.root
        (self.bundle / 'apply-update.py').write_text('# fixture bootstrap\n')
        (self.bundle / 'SHA256SUMS').write_text(''.join(publish.digest(path) + '  ' + path.name + '\n' for path in
            [self.fixture.package, self.bundle / 'package-manifest.json', self.bundle / 'apply-update.py']))
        self.run = dict(status='completed', conclusion='success', path='.github/workflows/os.yml', head_sha='a' * 40)
        self.receipt = dict(status='passed', update=dict(status='passed', source_commit='a' * 40, candidate=self.fixture.manifest['package']),
            fast_updates=dict(status='passed'), system_channel=dict(status='passed', package=self.fixture.manifest['package'],
                                                                   reboot_keyboard={'confirmed_seconds_since_boot': 12}))

    def test_exact_package_and_complete_receipt_can_be_prepared(self):
        self.assertEqual(publish.validate(self.bundle, self.receipt, self.run)['source_commit'], 'a' * 40)

    def test_failed_stale_or_missing_native_scopes_cannot_advance_the_feed(self):
        for field in ['update', 'fast_updates', 'system_channel']:
            bad = copy.deepcopy(self.receipt)
            bad[field]['status'] = 'failed'
            with self.subTest(field=field), self.assertRaises(ValueError):
                publish.validate(self.bundle, bad, self.run)
        bad = copy.deepcopy(self.receipt)
        del bad['system_channel']['reboot_keyboard']
        with self.assertRaisesRegex(ValueError, 'encrypted reboot'):
            publish.validate(self.bundle, bad, self.run)
        for change in [{'conclusion': 'failure'}, {'status': 'in_progress'}, {'head_sha': 'b' * 40}, {'path': '.github/workflows/ci.yml'}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                publish.validate(self.bundle, self.receipt, dict(self.run, **change))

    def test_private_runtime_fixture_and_changed_bootstrap_are_never_published(self):
        (self.bundle / 'apply-update.py').write_text('# changed after packaging\n')
        with self.assertRaisesRegex(ValueError, 'bootstrap bundle'):
            publish.validate(self.bundle, self.receipt, self.run)
        self.fixture.runtime['versions']['hn'] = '999.0.1'
        self.fixture.make_package()
        with self.assertRaisesRegex(ValueError, 'private fixtures'):
            publish.validate(self.bundle, self.receipt, self.run)


if __name__ == '__main__':
    unittest.main()
