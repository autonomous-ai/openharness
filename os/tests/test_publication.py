import copy
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('hn_publish', Path(__file__).parents[1] / 'tools/publish.py')
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)


class PublicationGuards(unittest.TestCase):
    def test_only_numbered_previews_and_official_versions_can_publish(self):
        self.assertTrue(publish.is_preview('0.1.0-preview.13'))
        self.assertFalse(publish.is_preview('0.1.0'))
        for value in ['latest', '0.1', '0.1.0-beta', '0.1.0-preview', '../0.1.0', None]:
            with self.subTest(version=value), self.assertRaises(ValueError):
                publish.is_preview(value)

    def test_pointer_uses_verified_versioned_downloads_and_only_moves_its_own_tag(self):
        for existing, version, prior in [(False, '0.2.0', '0.1.0'), (True, '0.2.0', '0.1.0'),
                                         (False, '0.1.0-preview.14', '0.1.0-preview.9'),
                                         (True, '0.1.0-preview.14', '0.1.0-preview.9')]:
            with self.subTest(existing=existing, version=version):
                manifest = dict(version=version, source_commit='a' * 40,
                                iso={'name': f'harness-{version}-x86_64.iso'})
                release = {'html_url': f'https://github.com/owner/repo/releases/tag/os-v{version}'}
                endpoint = 'repos/owner/repo/releases/tags/os-latest'
                state = {'draft': False, 'prerelease': publish.is_preview(version),
                         'html_url': 'https://github.com/owner/repo/releases/tag/os-latest',
                         'body': '<!-- harness-os-latest:' + json.dumps({'version': prior, 'source_commit': 'old'}) + ' -->'}
                previous = SimpleNamespace(returncode=0 if existing else 1,
                                           stdout=json.dumps(state), stderr='' if existing else 'HTTP 404')
                calls = []
                def github(*args):
                    calls.append(args)
                    if args[:2] in [('release', 'create'), ('release', 'edit')] and '--notes-file' in args:
                        state['body'] = Path(args[args.index('--notes-file') + 1]).read_text()
                    if args == ('api', endpoint):
                        return json.dumps(state)
                    if args == ('api', 'repos/owner/repo/git/ref/tags/os-latest'):
                        return json.dumps({'object': {'sha': 'a' * 40}})
                    return ''
                with patch.object(publish.subprocess, 'run', return_value=previous), patch.object(publish, 'gh', side_effect=github):
                    result = publish.publish_latest_pointer('owner/repo', manifest, release)
                self.assertEqual(result['status'], 'published')
                self.assertIn(f'/releases/download/os-v{version}/harness-{version}-x86_64.iso', state['body'])
                self.assertIn(f'/releases/download/os-v{version}/INSTALL.md', state['body'])
                self.assertIn(release['html_url'], state['body'])
                latest = [c for c in calls if '--latest=true' in c]
                self.assertEqual(latest, [] if publish.is_preview(version) else [
                    ('release', 'edit', 'os-v' + version, '--repo', 'owner/repo', '--latest=true')])
                mutations = [c for c in calls if c[:3] == ('api', '--method', 'PATCH')]
                self.assertEqual(len(mutations), int(existing))
                if mutations:
                    self.assertEqual(mutations[0][3], 'repos/owner/repo/git/refs/tags/os-latest')

    def test_preview_or_late_older_publication_cannot_replace_the_official_pointer(self):
        manifest = dict(version='0.1.0-preview.14', source_commit='a' * 40)
        old = {'body': '<!-- harness-os-latest:{"version":"0.1.0","source_commit":"old"} -->'}
        with patch.object(publish, 'gh') as github, patch.object(publish.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=json.dumps(old))):
            self.assertEqual(publish.publish_latest_pointer('owner/repo', manifest, {})['status'], 'official-release-retained')
            github.assert_not_called()
        manifest['version'] = '0.9.0'
        old = {'body': '<!-- harness-os-latest:{"version":"0.10.0","source_commit":"old"} -->'}
        with patch.object(publish.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=json.dumps(old))), patch.object(publish, 'gh') as github:
            self.assertEqual(publish.publish_latest_pointer('owner/repo', manifest, {})['status'], 'newer-release-retained')
            github.assert_not_called()

    def test_unknown_pointer_or_rewritten_version_fails_before_any_public_mutation(self):
        manifest = dict(version='0.1.0', source_commit='a' * 40)
        for body in ['unmanaged release', '<!-- harness-os-latest:{"version":"0.1.0","source_commit":"different"} -->']:
            with self.subTest(body=body), patch.object(publish.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=json.dumps({'body': body}))), patch.object(publish, 'gh') as github:
                with self.assertRaises(ValueError):
                    publish.publish_latest_pointer('owner/repo', manifest, {})
                github.assert_not_called()

    def test_nvidia_requires_exact_image_authenticated_offline_install_and_reboot(self):
        manifest = {'source_commit': 'source-one', 'iso': {'sha256': 'image-one'},
                    'hardware': {'nvidia': {'kernel': 'exact-kernel', 'driver_version': '615.71.09',
                    'packages': {'driver.pkg.tar.zst': {'name': 'driver', 'version': '1'}}}}}
        receipt = dict(status='passed', iso_sha256='image-one', image_source_commit='source-one',
                       test_source_commit='source-one', candidate_injected=False,
                       keyboard={'confirmed_seconds_since_boot': 20}, return_keyboard={'confirmed_seconds_since_boot': 40},
                       early_display_modules_and_firmware='passed', generic_browser_after_driver_reboot='passed',
                       installation=dict(status='passed', kernel='exact-kernel', driver_version='615.71.09',
                           optional_packages={'driver': '1'}, cache_extraction_excluded=True,
                           corrupted_archive_rejected=True, invalid_signature_rejected=True,
                           negative_selections_unchanged=True, cache_absent=True, base_packages_unchanged=True))
        publish.validate_nvidia(manifest, receipt)
        for key, value in receipt.items():
            bad = copy.deepcopy(receipt)
            bad.pop(key)
            with self.subTest(missing=key), self.assertRaises(ValueError):
                publish.validate_nvidia(manifest, bad)
            if key.endswith('commit') or key == 'iso_sha256':
                bad[key] = 'other'
                with self.subTest(different=key), self.assertRaises(ValueError):
                    publish.validate_nvidia(manifest, bad)
        bad = dict(receipt, candidate_injected=True)
        with self.assertRaises(ValueError):
            publish.validate_nvidia(manifest, bad)
        for key in receipt['installation']:
            bad = copy.deepcopy(receipt)
            bad['installation'].pop(key)
            with self.subTest(missing=key), self.assertRaises(ValueError):
                publish.validate_nvidia(manifest, bad)

    def test_optional_hardware_requires_matching_native_install_and_rebuild(self):
        manifest = {'source_commit': 'source-one', 'iso': {'sha256': 'image-one'},
                    'hardware': {'broadcom': {'kernel': 'exact-kernel',
                    'packages': {'driver.pkg.tar.zst': {'name': 'driver', 'version': '1'}}}}}
        receipt = dict(status='passed', iso_sha256='image-one', image_source_commit='source-one', test_source_commit='source-one',
                       installed_offline_rebuild_seconds=12,
                       keyboard={'confirmed_seconds_since_boot': 20},
                       post_rebuild_keyboard={'confirmed_seconds_since_boot': 40},
                       installation=dict(status='passed', kernel='exact-kernel',
                           optional_packages={'driver': '1'}, corrupted_bundle_rejected=True,
                           cache_removed=True, base_packages_unchanged=True, native_drivers_preserved=True))
        publish.validate_hardware(manifest, receipt)
        for change in [dict(status='failed'), dict(iso_sha256='other'), dict(image_source_commit='other'), dict(test_source_commit='other'),
                       dict(keyboard={}), dict(post_rebuild_keyboard={}), dict(installed_offline_rebuild_seconds=0)]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                publish.validate_hardware(manifest, dict(receipt, **change))
        for change in [dict(status='failed'), dict(kernel='other'), dict(optional_packages={'driver': '2'}),
                       dict(corrupted_bundle_rejected=False), dict(cache_removed=False),
                       dict(base_packages_unchanged=False), dict(native_drivers_preserved=False)]:
            bad = copy.deepcopy(receipt)
            bad['installation'].update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                publish.validate_hardware(manifest, bad)

    def test_installation_guide_cannot_name_an_older_release_or_image(self):
        manifest = {'version': '0.1.0-preview.4', 'iso': {'name': 'harness-0.1.0-preview.4-x86_64.iso'}}
        guide = 'These instructions are for **0.1.0-preview.4**. Download harness-0.1.0-preview.4-x86_64.iso.'
        publish.validate_install_guide(manifest, guide)
        for old in [guide.replace('**0.1.0-preview.4**', '**0.1.0-preview.3**'),
                    guide.replace('harness-0.1.0-preview.4-x86_64.iso', 'programmer-os-0.1.0-preview.3-x86_64.iso')]:
            with self.subTest(guide=old), self.assertRaises(ValueError):
                publish.validate_install_guide(manifest, old)

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

    def test_install_first_requires_the_new_journey_and_installed_agent(self):
        manifest = {'source_commit': 'source-one', 'iso': {'sha256': 'image-one'}, 'capabilities': ['install-first']}
        extras = ['Harness unlock screen renders, masks input, accepts a retry',
                  'Claude Code, Codex and pi install on demand; bundled OpenCode',
                  'On-demand gcc/make installation']
        receipts = [dict(firmware=fw, encrypted=encrypted, status='passed', iso_sha256='image-one',
                         image_source_commit='source-one', checks=publish.INSTALL_FIRST_CHECKS + extras)
                    for fw, encrypted in [('bios', False), ('uefi', True)]]
        publish.validate_receipts(manifest, receipts)
        for required in publish.INSTALL_FIRST_CHECKS:
            bad = copy.deepcopy(receipts)
            bad[0]['checks'].remove(required)
            with self.subTest(missing=required), self.assertRaises(ValueError):
                publish.validate_receipts(manifest, bad)
        for row in receipts:
            row['checks'] = publish.REQUIRED_CHECKS + extras
        with self.assertRaises(ValueError):
            publish.validate_receipts(manifest, receipts)

    def test_only_complete_matching_machine_evidence_can_publish(self):
        manifest = {'source_commit': 'source-one', 'iso': {'sha256': 'image-one'}}
        receipts = [dict(firmware=fw, encrypted=encrypted, status='passed', iso_sha256='image-one',
                         image_source_commit='source-one', checks=publish.REQUIRED_CHECKS +
                         ['Harness unlock screen renders, masks input, accepts a retry after a wrong password',
                          'Claude Code, Codex and pi install on demand; bundled OpenCode and all four agents report versions',
                          'On-demand gcc/make installation and local preview passed'])
                    for fw, encrypted in [('bios', False), ('uefi', True)]]
        publish.validate_receipts(manifest, receipts)
        hardware_manifest = dict(manifest, capabilities=['broadcom-offline'])
        with self.assertRaisesRegex(ValueError, 'optional-driver exclusion'):
            publish.validate_receipts(hardware_manifest, receipts)
        hardware_receipts = copy.deepcopy(receipts)
        for row in hardware_receipts:
            row['checks'].append('Unrelated hardware receives no optional Wi-Fi packages and retains no USB driver cache')
        publish.validate_receipts(hardware_manifest, hardware_receipts)
        gpu_manifest = dict(manifest, capabilities=['nvidia-offline'])
        with self.assertRaisesRegex(ValueError, 'NVIDIA-driver exclusion'):
            publish.validate_receipts(gpu_manifest, receipts)
        gpu_receipts = copy.deepcopy(receipts)
        for row in gpu_receipts:
            row['checks'].append('Unrelated hardware receives no NVIDIA packages, boot configuration or USB GPU cache')
        publish.validate_receipts(gpu_manifest, gpu_receipts)
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
        for prefix, index in [('USB opens network', 0), ('USB first agent', 0), ('Bundled OpenCode loads', 0),
                              ('Bundled OpenCode starts', 0), ('Agent-created USB trial', 0), ('Harness unlock', 1), ('Claude Code', 0)]:
            incomplete = copy.deepcopy(receipts)
            incomplete[index]['checks'] = [row for row in incomplete[index]['checks'] if not row.startswith(prefix)]
            with self.subTest(missing=prefix), self.assertRaises(ValueError):
                publish.validate_receipts(manifest, incomplete)


if __name__ == '__main__':
    unittest.main()
