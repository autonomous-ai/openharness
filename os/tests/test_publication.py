import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('hn_publish', Path(__file__).parents[1] / 'tools/publish.py')
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)


class PublicationGuards(unittest.TestCase):
    def test_failed_or_incomplete_project_work_cannot_be_published_as_passed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            report = root / 'bios/workloads/reports'
            report.mkdir(parents=True)
            for name in ['terminal-tool', 'website', 'game', 'fullstack']:
                for stage in ['agent', 'checks']:
                    (report / f'{name}-{stage}.status').write_text('0\n')
            rows = [{'name': name, 'status': 'passed'} for name in [
                'website keyboard filtering and help', 'game movement pause restart and state restoration',
                'fullstack browser CRUD validation and persistence']]
            browser = report / 'browser-receipt.json'
            browser.write_text(json.dumps({'results': rows}))
            publish.validate_examples(root, 'workloads')
            (report / 'game-agent.status').write_text('124\n')
            with self.assertRaises(ValueError):
                publish.validate_examples(root, 'workloads')
            (report / 'game-agent.status').write_text('0\n')
            browser.write_text(json.dumps({'results': [rows[0]] * 3}))
            with self.assertRaises(ValueError):
                publish.validate_examples(root, 'workloads')
            browser.write_text(json.dumps({'results': rows[:2]}))
            with self.assertRaises(ValueError):
                publish.validate_examples(root, 'workloads')

    def test_all_three_dsh_results_are_required(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            report = root / 'bios/dsh/reports'
            report.mkdir(parents=True)
            rows = [{'name': name, 'status': 'passed'} for name in ['hello', 'logs', 'game']]
            results = report / 'results.json'
            results.write_text(json.dumps(rows))
            publish.validate_examples(root, 'dsh')
            rows[-1]['status'] = 'failed'
            results.write_text(json.dumps(rows))
            with self.assertRaises(ValueError):
                publish.validate_examples(root, 'dsh')
            results.write_text(json.dumps(rows[:2]))
            with self.assertRaises(ValueError):
                publish.validate_examples(root, 'dsh')

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
