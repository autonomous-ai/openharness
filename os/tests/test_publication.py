import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('hn_publish', Path(__file__).parents[1] / 'tools/publish.py')
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)


class PublicationGuards(unittest.TestCase):
    def test_only_complete_matching_machine_evidence_can_publish(self):
        manifest = {'source_commit': 'source-one', 'iso': {'sha256': 'image-one'}}
        receipts = [dict(firmware=fw, encrypted=encrypted, status='passed', iso_sha256='image-one',
                         image_source_commit='source-one', checks=publish.REQUIRED_CHECKS +
                         ['Real Claude Code, Codex, OpenCode and pi install and start',
                          'On-demand gcc/make installation and local preview passed'])
                    for fw, encrypted in [('bios', False), ('uefi', True)]]
        publish.validate_receipts(manifest, receipts)
        for change in [dict(status='failed'), dict(scope='live session only'), dict(iso_sha256='another-image'),
                       dict(image_source_commit='another-source'), dict(checks=['Live hn ready;']), dict(encrypted=False)]:
            bad = copy.deepcopy(receipts)
            bad[1].update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                publish.validate_receipts(manifest, bad)
        with self.assertRaises(ValueError):
            publish.validate_receipts(manifest, receipts[:1])
        incomplete = copy.deepcopy(receipts)
        incomplete[0]['checks'] = [row for row in incomplete[0]['checks'] if not row.startswith('On-demand')]
        with self.assertRaises(ValueError):
            publish.validate_receipts(manifest, incomplete)


if __name__ == '__main__':
    unittest.main()
