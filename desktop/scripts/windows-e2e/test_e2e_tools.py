"""Tests for e2e_tools.py: python3 -m unittest discover -s desktop/scripts/windows-e2e -p 'test_*.py' -v"""
import base64
import hashlib
import io
import json
import os
import shutil
import tempfile
import unittest
import zipfile
import subprocess
import sys
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import e2e_tools as t

GOOD = {
    'Harness.exe': b'launcher',
    'Harness.ico': b'icon',
    'current': b'1.4.0\r\n',
    'app/1.4.0/harness-desktop.exe': b'MZ app',
    'app/1.4.0/flutter_windows.dll': b'engine',
    'app/1.4.0/harness_pipe_io.dll': b'bridge',
    'app/1.4.0/data/app.so': b'aot',
    'app/1.4.0/data/flutter_assets/AssetManifest.bin': b'assets',
}


def make_zip(path, entries=GOOD, backslash=False):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for name, data in entries.items():
            zf.writestr(name.replace('/', '\\') if backslash else name, data)
    return Path(path)


def names(path):
    with zipfile.ZipFile(path) as zf:
        return sorted(i.filename for i in zf.infolist())


class Temp(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.dir = Path(self._dir.name)

    def tearDown(self):
        self._dir.cleanup()


class RedactTest(unittest.TestCase):
    def test_ids_become_their_short_form(self):
        self.assertEqual(t.redact('agent 7e92c45a-1b2c-4d5e-8f90-123456789abc ok', home=''), 'agent 7e92c45a… ok')
        self.assertEqual(t.redact(r'pipe \\.\pipe\harness-41b22efa0123456789abcdef01234567', home=''),
                         r'pipe \\.\pipe\harness-41b22efa…')
        self.assertEqual(t.redact('sha 2d6bdfb341be3a6234b24742377f93aa7c7cfb0d9fd64efa9282c87852e57085', home=''), 'sha 2d6bdfb3…')
        self.assertEqual(t.redact('hxe2e S-1-5-21-1000000001-1000000002-1000000003-1006', home=''), 'hxe2e S-1-5-21-…-1006')

    def test_no_email_token_or_proof_is_left(self):
        self.assertEqual(t.redact('signed in as person.name+x@example.com.', home=''), 'signed in as <email>.')
        self.assertEqual(t.redact('Authorization: Bearer abc.DEF-123_~+/=', home=''), 'Authorization: Bearer <token>')
        self.assertEqual(t.redact('jwt eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl end', home=''), 'jwt <token> end')
        self.assertEqual(t.redact('x-harness-auth: 41b22efa.deadbeef', home=''), 'x-harness-auth: <redacted>')
        self.assertEqual(t.redact('X-Harness-Proof:abc', home=''), 'X-Harness-Proof: <redacted>')

    def test_the_macs_home_becomes_a_tilde(self):
        self.assertEqual(t.redact('/Users/someone/work/x.log', home='/Users/someone'), '~/work/x.log')

    def test_ssh_destinations_short_hex_and_versions_stay(self):
        line = 'hxe2e@192.168.65.3 admin@WIN-TESTVM pid 7500 build 1.4.0 commit 338e589bc'
        self.assertEqual(t.redact(line, home=''), line)


class ArgsTest(unittest.TestCase):
    def decode(self, value):
        return json.loads(base64.b64decode(value).decode('utf-8'))

    def test_values_reach_powershell_exactly_as_typed(self):
        odd = "Downloads\\Nguyễn Văn A' & 100%!\\Harness"
        encoded = t.args_b64([f'To={odd}', 'Seconds=90', 'Probe=true', 'ArgumentList=["--uninstall"]'])
        self.assertEqual(self.decode(encoded), {'To': odd, 'Seconds': '90', 'Probe': 'true', 'ArgumentList': ['--uninstall']})
        self.assertEqual(self.decode(t.args_b64([])), {})

    def test_a_bad_or_repeated_name_is_refused(self):
        for pairs in (['novalue'], ['-Out=x'], ['A=1', 'A=2'], ['1st=x']):
            with self.assertRaises(ValueError):
                t.args_b64(pairs)


class ZipTest(Temp):
    def test_info_reads_the_pointer_and_the_app_folder(self):
        info = t.zip_info(make_zip(self.dir / 'harness-desktop-1.4.0-windows-arm64.zip'))
        self.assertEqual(info['version'], '1.4.0')
        self.assertEqual((info['name_version'], info['arch']), ('1.4.0', 'arm64'))
        self.assertEqual(info['app_folders'], ['1.4.0'])
        self.assertTrue(info['has_exe'] and info['has_launcher'])
        self.assertFalse(info['current_bom'] or info['backslashes'])

    def test_info_reads_a_zip_written_with_backslashes_and_reports_a_bom(self):
        entries = dict(GOOD, current=b'\xef\xbb\xbf1.4.0\n')
        info = t.zip_info(make_zip(self.dir / 'harness-desktop-1.4.0-windows-x64.zip', entries, backslash=True))
        self.assertTrue(info['has_exe'] and info['backslashes'] and info['current_bom'])

    def test_info_refuses_a_zip_without_its_pointer(self):
        entries = {k: v for k, v in GOOD.items() if k != 'current'}
        with self.assertRaises(ValueError):
            t.zip_info(make_zip(self.dir / 'harness-desktop-1.4.0-windows-arm64.zip', entries))

    def test_no_exe_moves_the_build_to_the_new_version_without_its_executable(self):
        src = make_zip(self.dir / 'harness-desktop-1.4.0-windows-arm64.zip')
        dst = t.zip_variant('no-exe', src, '1.4.2', self.dir / 'out')
        self.assertEqual(dst.name, 'harness-desktop-1.4.2-windows-arm64.zip')
        self.assertEqual(names(dst), ['Harness.exe', 'Harness.ico', 'app/1.4.2/data/app.so', 'app/1.4.2/data/flutter_assets/AssetManifest.bin',
                                      'app/1.4.2/flutter_windows.dll', 'app/1.4.2/harness_pipe_io.dll', 'current'])
        with zipfile.ZipFile(dst) as zf:
            self.assertEqual(zf.read('current'), b'1.4.2\r\n')
        self.assertFalse(t.zip_info(dst)['has_exe'])

    def test_no_start_drops_the_aot_snapshot_and_keeps_backslashes(self):
        src = make_zip(self.dir / 'harness-desktop-1.4.0-windows-x64.zip', backslash=True)
        dst = t.zip_variant('no-start', src, '1.4.3', self.dir / 'out')
        self.assertIn('app\\1.4.3\\harness-desktop.exe', names(dst))
        self.assertNotIn('app\\1.4.3\\data\\app.so', names(dst))
        self.assertTrue(t.zip_info(dst)['has_exe'])

    def test_a_variant_needs_another_version_and_something_to_break(self):
        src = make_zip(self.dir / 'harness-desktop-1.4.0-windows-arm64.zip')
        with self.assertRaises(ValueError):
            t.zip_variant('no-exe', src, '1.4.0', self.dir / 'out')
        (self.dir / 'bare').mkdir()
        bare = make_zip(self.dir / 'bare' / 'harness-desktop-1.4.0-windows-arm64.zip',
                        {k: v for k, v in GOOD.items() if k != 'app/1.4.0/data/app.so'})
        with self.assertRaises(ValueError):
            t.zip_variant('no-start', bare, '1.4.3', self.dir / 'out')
        self.assertFalse((self.dir / 'out' / 'harness-desktop-1.4.3-windows-arm64.zip').exists())

    def test_truncate_keeps_the_first_half_in_another_folder(self):
        src = make_zip(self.dir / 'harness-desktop-1.4.0-windows-arm64.zip')
        cut = t.truncate(src, self.dir / 'cut')
        self.assertEqual(cut.name, src.name)
        self.assertEqual(cut.read_bytes(), src.read_bytes()[:src.stat().st_size // 2])
        with self.assertRaises(ValueError):
            t.truncate(src, self.dir)


class LayoutTest(unittest.TestCase):
    def test_staging_names_the_zip_and_the_manifest(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop('STAGING_DESKTOP_PREFIX', None)
            where = t.layout('1.4.0', 'arm64')
        self.assertEqual(where['zip_url'], 'https://cdn.autonomous.ai/harness/staging/desktop/1.4.0/harness-desktop-1.4.0-windows-arm64.zip')
        self.assertEqual(where['manifest_url'], 'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/staging/desktop/metadata.json')
        self.assertEqual(where['manifest_key'], 'desktop-windows-arm64')

    def test_the_prefix_can_be_overridden_and_bad_input_is_refused(self):
        with mock.patch.dict(os.environ, {'STAGING_DESKTOP_PREFIX': '/harness/staging/desktop-win/'}):
            self.assertEqual(t.layout('1.4.0', 'x64')['zip_object'], 'harness/staging/desktop-win/1.4.0/harness-desktop-1.4.0-windows-x64.zip')
        for version, arch in (('1.4', 'x64'), ('1.4.0', 'ia32')):
            with self.assertRaises(ValueError):
                t.layout(version, arch)

    def test_main_prints_name_value_lines_for_the_shell(self):
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(t.main(['layout', '1.4.0', 'x64']), 0)
        self.assertIn('manifest_key=desktop-windows-x64\n', out.getvalue())


class VerifyTest(Temp):
    def test_the_zip_must_match_its_manifest_entry(self):
        z = make_zip(self.dir / 'harness-desktop-1.4.0-windows-arm64.zip')
        body = z.read_bytes()
        good = {'desktop-windows-arm64': {'version': '1.4.0', 'sha256': hashlib.sha256(body).hexdigest(), 'size': len(body)}}
        self.assertTrue(t.verify(good, 'arm64', z)[0])
        bad = {'desktop-windows-arm64': dict(good['desktop-windows-arm64'], size=1)}
        ok, line = t.verify(bad, 'arm64', z)
        self.assertFalse(ok)
        self.assertIn('size', line)

    def test_a_manifest_offering_another_version_or_none_is_not_a_mismatch(self):
        z = make_zip(self.dir / 'harness-desktop-1.4.0-windows-arm64.zip')
        self.assertTrue(t.verify({'desktop-windows-arm64': {'version': '1.4.1', 'sha256': 'x', 'size': 1}}, 'arm64', z)[0])
        self.assertTrue(t.verify({}, 'arm64', z)[0])


class CdnStageTest(Temp):
    def test_invalid_arch_spec_preserves_previous_owned_layout(self):
        z = make_zip(self.dir / 'harness-desktop-1.4.0-windows-arm64.zip')
        root = self.dir / 'root'
        manifest = t.cdn_stage(root, [f'arm64={z}'])
        for spec in ('bad-spec', f'x64={z}'):
            with self.subTest(spec=spec), self.assertRaises(ValueError):
                t.cdn_stage(root, [spec])
            self.assertEqual(json.loads((root / 'harness/staging/desktop/metadata.json').read_text()), manifest)

    def test_the_manifest_claims_the_full_zip_while_the_cut_one_is_served(self):
        full = make_zip(self.dir / 'harness-desktop-1.4.4-windows-arm64.zip',
                        {k.replace('1.4.0', '1.4.4'): (b'1.4.4\n' if k == 'current' else v) for k, v in GOOD.items()})
        cut = t.truncate(full, self.dir / 'cut')
        root = self.dir / 'root'
        stale = root / 'harness/staging/desktop/9.9.9/old.zip'
        stale.parent.mkdir(parents=True)
        stale.write_bytes(b'old')
        manifest = t.cdn_stage(root, [f'arm64={cut}@{full}'])
        entry = manifest['desktop-windows-arm64']
        self.assertEqual(entry['version'], '1.4.4')
        self.assertEqual(entry['sha256'], hashlib.sha256(full.read_bytes()).hexdigest())
        self.assertEqual(entry['size'], full.stat().st_size)
        self.assertEqual(entry['url'], 'https://cdn.autonomous.ai/harness/staging/desktop/1.4.4/harness-desktop-1.4.4-windows-arm64.zip')
        self.assertEqual((root / 'harness/staging/desktop/1.4.4/harness-desktop-1.4.4-windows-arm64.zip').read_bytes(), cut.read_bytes())
        self.assertEqual(json.loads((root / 'harness/staging/desktop/metadata.json').read_text()), manifest)
        self.assertFalse(stale.exists())

    def test_a_key_given_twice_or_a_bad_spec_is_refused(self):
        z = make_zip(self.dir / 'harness-desktop-1.4.0-windows-arm64.zip')
        for specs in ([f'arm64={z}', f'arm64={z}'], [f'ia32={z}'], ['arm64=']):
            with self.assertRaises(ValueError):
                t.cdn_stage(self.dir / 'root', specs)


def events(path, tests, start=0):
    """Flutter JSON reporter lines for one file: tests is [(name, result, hidden, skipped)]."""
    lines = [{'type': 'suite', 'suite': {'id': start, 'platform': 'vm', 'path': path}},
             {'type': 'group', 'group': {'id': start + 1, 'suiteID': start, 'parentID': None,
                                       'testCount': sum(not hidden for _, _, hidden, _ in tests)}}]
    for i, (name, result, hidden, skipped) in enumerate(tests):
        tid = start + 10 + i
        lines.append({'type': 'testStart', 'test': {'id': tid, 'name': name, 'suiteID': start, 'groupIDs': []}})
        lines.append({'type': 'testDone', 'testID': tid, 'result': result, 'hidden': hidden, 'skipped': skipped})
    return lines


def write_log(path, *files):
    rows = [row for f in files for row in f]
    rows.append({'type': 'done', 'success': all(e.get('result') == 'success' for e in rows if e.get('type') == 'testDone')})
    Path(path).write_text('Building...\n' + '\n'.join(json.dumps(r) for r in rows) + '\n')
    return Path(path)


class CompareTest(Temp):
    def test_registered_but_unexecuted_cases_are_not_removed_tests(self):
        file = '/r/desktop/test/a_test.dart'
        base = write_log(self.dir/'base.log', events(file, [('case0', 'success', False, False), ('case1', 'success', False, False)]))
        partial = events(file, [('case0', 'success', False, False)])
        partial[1]['group']['testCount'] = 2
        head = write_log(self.dir/'head.log', partial)
        with self.assertRaisesRegex(ValueError, 'inventory'):
            t.compare_runs(base, head)

    def test_suite_only_file_cannot_satisfy_a_selected_inventory(self):
        a, b = '/r/desktop/test/a_test.dart', '/r/desktop/test/b_test.dart'
        log = write_log(self.dir/'run.log', events(a, [('ok', 'success', False, False)]),
                        [{'type': 'suite', 'suite': {'id': 100, 'platform': 'vm', 'path': b}}])
        receipt = self.dir/'receipt.json'
        receipt.write_text(json.dumps({'desktop_root': '/r/desktop', 'selected_files': [a, b],
                                     'checks': [{'name': 'desktop-vm', 'log': str(log)}]}))
        with self.assertRaisesRegex(ValueError, 'suite|inventory'):
            t.test_results(receipt)

    def test_explicit_zero_case_file_is_complete_after_loading(self):
        file = '/r/desktop/test/zero_test.dart'
        log = write_log(self.dir/'zero.log', events(file, [('loading ' + file, 'success', True, False)]))
        self.assertEqual(t.test_results(log), {})
        self.assertEqual(t.compare_runs(log, log)[0], 0)

    def test_successful_loading_without_root_inventory_is_incomplete(self):
        file = '/r/desktop/test/a_test.dart'
        loading = [e for e in events(file, [('loading ' + file, 'success', True, False)]) if e['type'] != 'group']
        log = write_log(self.dir/'run.log', loading, events('/r/desktop/test/b_test.dart', [('ok', 'success', False, False)], start=100))
        with self.assertRaisesRegex(ValueError, 'inventory'):
            t.test_results(log)

    def test_empty_truncated_and_orphan_errors_are_not_comparable_runs(self):
        file = '/r/desktop/test/a_test.dart'
        valid = events(file, [('ok', 'success', False, False)])
        cases = ([], valid, valid + [{'type': 'done', 'success': True}, {'type': 'error', 'testID': 999, 'error': 'orphan'}],
                 valid + [{'type': 'done', 'success': True}, {'type': 'error', 'error': 'unknown'}],
                 valid[:-1] + [{'type': 'done', 'success': True}])
        for i, lines in enumerate(cases):
            with self.subTest(case=i):
                log = self.dir / f'bad{i}.log'
                log.write_text('\n'.join(json.dumps(e) for e in lines))
                with self.assertRaises(ValueError):
                    t.test_results(log)

    def test_declared_inventory_missing_a_file_is_not_a_complete_receipt(self):
        log = write_log(self.dir/'run.log', events('/r/desktop/test/a_test.dart', [('ok', 'success', False, False)]))
        receipt = self.dir/'receipt.json'
        receipt.write_text(json.dumps({'desktop_root': '/r/desktop',
            'selected_files': ['/r/desktop/test/a_test.dart', '/r/desktop/test/missing_test.dart'],
            'checks': [{'name': 'desktop-vm', 'log': str(log)}]}))
        with self.assertRaisesRegex(ValueError, 'inventory'):
            t.test_results(receipt)

    def test_completed_failing_receipt_is_comparable_despite_coverage_count(self):
        log = write_log(self.dir/'run.log', events('/r/desktop/test/a_test.dart', [('known red', 'failure', False, False)]))
        receipt = self.dir/'receipt.json'
        receipt.write_text(json.dumps({'desktop_root': '/r/desktop',
            'selected_files': ['/r/desktop/test/a_test.dart'], 'coverage': {'files': 1, 'verified_files': 0},
            'checks': [{'name': 'desktop-vm', 'log': str(log)}]}))
        self.assertEqual(t.compare_runs(receipt, receipt)[0], 0)

    def test_windows_paths_match_the_same_relative_test_inventory(self):
        log = write_log(self.dir/'run.log', events(r'C:\r\desktop\test\a_test.dart', [('ok', 'success', False, False)]))
        self.assertEqual(t.test_results(log), {('test/a_test.dart', 'ok'): 'pass'})

    def run_logs(self, root):
        a = f'{root}/desktop/test/a_test.dart'
        b = f'{root}/desktop/test/linux_menu_bar_test.dart'
        return a, b

    def test_a_regression_a_fix_a_rename_and_a_known_failure(self):
        a, b = self.run_logs('/base')
        base = write_log(self.dir / 'base.log',
                         events(a, [('loading ' + a, 'success', True, False), ('keeps', 'success', False, False),
                                    ('breaks', 'success', False, False), ('was red', 'failure', False, False),
                                    ('known red', 'error', False, False), ('same name', 'success', False, False),
                                    ('same name', 'success', False, False)]),
                         events(b, [('draws the menus', 'success', False, False)], start=100))
        a2 = '/head/desktop/test/a_test.dart'
        c2 = '/head/desktop/test/in_window_menu_bar_test.dart'
        head = write_log(self.dir / 'head.log',
                         events(a2, [('loading ' + a2, 'success', True, False), ('keeps', 'success', False, False),
                                     ('breaks', 'failure', False, False), ('was red', 'success', False, False),
                                     ('known red', 'error', False, False), ('same name', 'success', False, False),
                                     ('same name', 'failure', False, False), ('brand new red', 'failure', False, False)]),
                         events(c2, [('draws the menus', 'success', False, False)], start=100))
        code, report = t.compare_runs(base, head)
        self.assertEqual(code, 1)
        self.assertIn('newly failing (passing, skipped or absent in base): 3', report)
        self.assertIn('  test/a_test.dart :: breaks  (base: pass)', report)
        self.assertIn('  test/a_test.dart :: same name #2  (base: pass)', report)
        self.assertIn('  test/a_test.dart :: brand new red  (base: absent)', report)
        self.assertIn('still failing (failing in base too): 1', report)
        self.assertIn('fixed (failing in base, passing in head): 1', report)
        self.assertIn('  test/linux_menu_bar_test.dart :: draws the menus  (base: pass)', report)
        self.assertIn('  test/in_window_menu_bar_test.dart :: draws the menus  (pass)', report)
        self.assertNotIn('<loading>', report)
        self.assertTrue(report.endswith('verdict: REGRESSIONS\n'))

    def test_no_regression_when_head_fails_only_what_base_failed(self):
        a, _ = self.run_logs('/base')
        a2, _ = self.run_logs('/head')
        base = write_log(self.dir / 'base.log', events(a, [('known red', 'failure', False, False), ('ok', 'success', False, False)]))
        head = write_log(self.dir / 'head.log', events(a2, [('known red', 'failure', False, False), ('ok', 'success', False, False)]))
        code, report = t.compare_runs(base, head)
        self.assertEqual(code, 0)
        self.assertTrue(report.endswith('verdict: no regressions\n'))

    def test_a_receipt_reads_its_logs_and_the_loader_retry_replaces_the_first_attempt(self):
        root = '/r'
        a = f'{root}/desktop/test/a_test.dart'
        loader = [e for e in events(a, [(f'loading {a}', 'error', False, False)]) if e['type'] != 'group']
        loader.append({'type': 'error', 'testID': 10, 'isFailure': False, 'error': f'Failed to load "{a}": fixture startup failure'})
        first = write_log(self.dir / 'desktop-vm.log', loader)
        retry = write_log(self.dir / 'desktop-vm-loader-retry.log',
                          events(a, [(f'loading {a}', 'success', True, False), ('ok', 'success', False, False)]))
        receipt = self.dir / 'receipt.json'
        receipt.write_text(json.dumps({'desktop_root': f'{root}/desktop', 'checks': [
            {'name': 'desktop-vm', 'log': str(first)}, {'name': 'desktop-vm-loader-retry', 'log': '/moved/desktop-vm-loader-retry.log'}]}))
        self.assertEqual(t.test_results(receipt), {('test/a_test.dart', 'ok'): 'pass'})



class BundleContractTest(Temp):
    def test_staging_prefix_cannot_escape_or_become_shell_source(self):
        for prefix in ('../../outside', 'harness/staging/../outside', "harness/staging/x'; echo bad", '/tmp/out'):
            with self.subTest(prefix=prefix), mock.patch.dict(os.environ, STAGING_DESKTOP_PREFIX=prefix):
                with self.assertRaises(ValueError):
                    t.layout('1.4.0', 'arm64')

    def test_good_bundle_requires_its_icon_and_private_bridge(self):
        for missing in ('Harness.ico', 'app/1.4.0/harness_pipe_io.dll'):
            with self.subTest(missing=missing):
                archive = make_zip(self.dir / 'harness-desktop-1.4.0-windows-arm64.zip',
                                   {k: v for k, v in GOOD.items() if k != missing})
                with self.assertRaisesRegex(ValueError, 'missing'):
                    t.zip_info(archive)

    def test_variants_keep_icon_bridge_and_every_unbroken_member(self):
        src = make_zip(self.dir / 'harness-desktop-1.4.0-windows-arm64.zip')
        for kind, dropped in (('no-exe', 'harness-desktop.exe'), ('no-start', 'data/app.so')):
            with self.subTest(kind=kind):
                dst = t.zip_variant(kind, src, '1.4.1', self.dir / kind)
                with zipfile.ZipFile(dst) as zf:
                    for name, body in GOOD.items():
                        new_name = name.replace('1.4.0', '1.4.1')
                        if name == 'current':
                            self.assertEqual(zf.read(name), b'1.4.1\r\n')
                        elif name == 'app/1.4.0/' + dropped:
                            self.assertNotIn(new_name, zf.namelist())
                        else:
                            self.assertEqual(zf.read(new_name), body)


class OwnedRecordTest(unittest.TestCase):
    def test_port_is_the_owned_records_actual_port(self):
        self.assertEqual(t.record_port({'port': 50123}), 50123)
        for value in ({}, None, [], {'port': True}, {'port': '18473'},
                      {'port': 0}, {'port': 65536}, {'port': 1.5}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                t.record_port(value)

    def test_owner_requires_the_exact_new_account_identity(self):
        own = {'run_id': 'a' * 32, 'user': 'hxtool', 'sid': 'S-1-5-21-1-2-3-1005',
               'profile': r'C:\Users\hxtool', 'created': True}
        self.assertEqual(t.owned_user(own, 'hxtool', 'a' * 32), own)
        for patch in ({'created': False}, {'sid': ''}, {'profile': ''}, {'user': 'admin'}, {'run_id': 'b' * 32}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                t.owned_user(dict(own, **patch), 'hxtool', 'a' * 32)
        with self.assertRaises(ValueError):
            t.owned_user(own, 'hxother', 'a' * 32)

    def test_shell_base64_preserves_powershell_source_exactly(self):
        source = "Write-Output 'Nguyễn & % !'\n"
        self.assertEqual(base64.b64decode(t.ps_b64(source)).decode('utf-16le'), source)


class PreservationTest(unittest.TestCase):
    def test_baseline_preserves_unrelated_process_task_and_listener(self):
        before = {'processes': [{'ProcessId': 4, 'CreationDate': 'today', 'Name': 'node.exe'}],
                  'tasks': [{'TaskName': 'Harness admin', 'TaskPath': '\\'}],
                  'listeners': ['TCP 127.0.0.1:18473 0.0.0.0:0 LISTENING 4']}
        after = dict(before, processes=before['processes'] + [{'ProcessId': 5}],
                     listeners=before['listeners'] + ['TCP 127.0.0.1:50123 0.0.0.0:0 LISTENING 5'])
        self.assertEqual(t.compare_baseline(before, after), [])
        self.assertEqual(len(t.compare_baseline(before, dict(after, tasks=[]))), 1)
        replaced = dict(after, processes=[{'ProcessId': 4, 'CreationDate': 'tomorrow', 'Name': 'node.exe'}])
        self.assertTrue(t.compare_baseline(before, replaced))


class ShellSafetyTest(Temp):
    def run_tool(self, command, owned=False, root_failure=False, admin=None):
        scripts = Path(__file__).resolve().parent
        fake = self.dir / 'bin'
        fake.mkdir(exist_ok=True)
        trace = self.dir / 'transport.jsonl'
        trace.unlink(missing_ok=True)
        # A local fake transport records serialized commands; it performs no SSH/network/native operation.
        stub = '#!' + sys.executable + '\n' + r'''
import base64, json, os, sys
args = sys.argv[1:]
source = ''
if args and '-EncodedCommand ' in args[-1]:
    source = base64.b64decode(args[-1].split('-EncodedCommand ')[1]).decode('utf-16le')
with open(os.environ['TEST_TRACE'], 'a') as out:
    out.write(json.dumps({'args': args, 'source': source}) + '\n')
if 'harness-desktop-e2e-' in source and "Write-Output $dir.Replace" in source:
    if os.environ.get('TEST_ROOT_FAILURE') == '1':
        print('scratch creation failed', file=sys.stderr)
        sys.exit(7)
    print('C:/Users/admin/Temp/harness-desktop-e2e-' + 'a'*32)
elif "-Script 'session-run.ps1'" in source:
    print('unavailable: no owned active unlocked desktop')
    sys.exit(3)
'''
        for name in ('ssh', 'scp'):
            tool = fake / name
            tool.write_text(stub)
            tool.chmod(0o755)
        work = self.dir / 'work'
        (work / 'users').mkdir(parents=True, exist_ok=True)
        (work / 'run.json').write_text(json.dumps({'run_id': 'a'*32}))
        if owned:
            (work / 'users/hxtool.json').write_text(json.dumps({'run_id': 'a'*32, 'user': 'hxtool',
                'sid': 'S-1-5-21-1-2-3-1005', 'profile': r'C:\Users\hxtool', 'created': True}))
        env = dict(os.environ, PATH=str(fake)+os.pathsep+os.environ['PATH'], TEST_TRACE=str(trace),
                   E2E_WORK=str(work), EV=str(self.dir/'evidence'), E2E_USER='hxtool',
                   VM_HOST='kit-test.invalid',
                   TEST_ROOT_FAILURE='1' if root_failure else '0')
        env.pop('VM_ADMIN', None)
        if admin is not None:
            env['VM_ADMIN'] = admin
        result = subprocess.run(['bash', str(scripts/'desktop-e2e.sh'), *command], env=env,
                                capture_output=True, text=True, timeout=15)
        calls = [json.loads(line) for line in trace.read_text().splitlines()] if trace.exists() else []
        return result, calls

    def test_admin_commands_use_the_configured_account_for_every_transport(self):
        for command in (['sh-admin', 'whoami'], ['admin', 'parse-check.ps1']):
            with self.subTest(command=command):
                result, calls = self.run_tool(command, admin='kit-owner')
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertTrue(calls)
                destinations = [arg for call in calls for arg in call['args'] if '@' in arg]
                self.assertTrue(destinations)
                self.assertTrue(all(arg.startswith('kit-owner@kit-test.invalid') for arg in destinations), destinations)

    def test_default_admin_account_still_works(self):
        result, calls = self.run_tool(['sh-admin', 'whoami'])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('admin@kit-test.invalid', calls[0]['args'])

    def test_put_admin_copies_one_file_to_this_runs_scratch(self):
        binary = self.dir / 'harness serial.exe'
        binary.write_bytes(b'fixture, never executed')
        result, calls = self.run_tool(['put-admin', str(binary)], admin='kit-owner')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        copies = [call for call in calls if str(binary) in call['args']]
        self.assertEqual(len(copies), 1)
        self.assertEqual(copies[0]['args'][-1],
                         'kit-owner@kit-test.invalid:C:/Users/admin/Temp/harness-desktop-e2e-' + 'a'*32 + '/')
        self.assertTrue(all(not arg.startswith('admin@') for call in calls for arg in call['args']))

    def test_put_admin_missing_file_refuses_before_any_transport(self):
        result, calls = self.run_tool(['put-admin', str(self.dir / 'absent.exe')])
        self.assertEqual(result.returncode, 2)
        self.assertIn('no file', result.stderr)
        self.assertEqual(calls, [])

    def test_put_admin_failed_scratch_creation_never_copies(self):
        binary = self.dir / 'harness-serial.exe'
        binary.write_bytes(b'fixture, never executed')
        result, calls = self.run_tool(['put-admin', str(binary)], root_failure=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(calls), 1)

    def test_unowned_cleanup_and_session_refuse_before_any_transport(self):
        for command in ('cleanup', 'session-on', 'session-off'):
            with self.subTest(command=command):
                result, calls = self.run_tool([command])
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(calls, [])

    def test_shared_cdn_activation_is_unavailable_without_transport(self):
        for command in ('cdn-on', 'cdn-off'):
            result, calls = self.run_tool([command])
            self.assertEqual(result.returncode, 3)
            self.assertIn('preserved', result.stderr)
            self.assertEqual(calls, [])

    def test_session_on_reports_missing_gui_without_any_boot_or_logoff(self):
        result, calls = self.run_tool(['session-on'], owned=True)
        self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
        self.assertIn('no owned active unlocked desktop', result.stdout)
        self.assertTrue(calls)
        transmitted = '\n'.join(c['source'] for c in calls).lower()
        for mutation in ('shutdown', 'winlogon', 'wtslogoff', 'stop-process', 'restart-computer'):
            self.assertNotIn(mutation, transmitted)

    def test_failed_scratch_creation_does_not_continue_copying_or_running(self):
        result, calls = self.run_tool(['session-on'], owned=True, root_failure=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(calls), 1)


POWERSHELL = shutil.which('powershell.exe') if os.name == 'nt' else os.environ.get('HARNESS_TEST_POWERSHELL')


@unittest.skipUnless(POWERSHELL, 'PowerShell unavailable; set HARNESS_TEST_POWERSHELL for a local behavior check')
class DialStateTest(Temp):
    def run_dial_state(self, hardware):
        # Execute the actual helper with only its Windows identity/process and CLI boundaries replaced.
        # The two CLI namespaces deliberately return different real-world document shapes.
        scripts = Path(__file__).resolve().parent
        script = self.dir / 'dial-state.ps1'
        shutil.copyfile(scripts / script.name, script)
        (self.dir / 'ownership.ps1').write_text('function Assert-OwnedUser { }\n', encoding='ascii')
        profile = self.dir / 'profile'
        binary = profile / '.harness/bin/harness.exe'
        binary.parent.mkdir(parents=True)
        binary.write_text('fixture, never executed', encoding='ascii')
        (profile / '.harness/logs').mkdir()
        trace = self.dir / 'argv.json'
        source = r'''
$ErrorActionPreference = 'Stop'
function Invoke-FixtureHarness {
    ConvertTo-Json -InputObject @($args) -Compress | Set-Content -LiteralPath $env:DIAL_ARGV
    $global:LASTEXITCODE = 0
    if (($args -join ' ') -eq 'hardware list --json') { $env:DIAL_HARDWARE }
    elseif (($args -join ' ') -eq 'devices list --json') { '{"members":[],"frozen":null,"frozenPeers":[]}' }
    else { $global:LASTEXITCODE = 2 }
}
Set-Alias -Name (Join-Path $env:USERPROFILE '.harness\bin\harness.exe') -Value Invoke-FixtureHarness
function Get-Process { }
& $env:DIAL_SCRIPT
'''
        env = dict(os.environ, USERPROFILE=str(profile), DIAL_SCRIPT=str(script), DIAL_ARGV=str(trace),
                   DIAL_HARDWARE=json.dumps(hardware))
        encoded = base64.b64encode(source.encode('utf-16le')).decode('ascii')
        result = subprocess.run([POWERSHELL, '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
                                env=env, capture_output=True, text=True, timeout=15)
        return result, json.loads(trace.read_text(encoding='utf-8-sig')) if trace.exists() else []

    def test_dial_state_reads_hardware_hosts_without_exposing_settings_values(self):
        result, argv = self.run_dial_state({'hosts': [{
            'machineId': '0123456789abcdef', 'name': 'Fixture computer', 'online': True, 'available': True,
            'status': {'devices': [{'id': 'fedcba9876543210', 'attached': True, 'fw': '1.2.3', 'hw': 'circle',
                                   'settings': {'brightness': 73, 'face': 'private-face-value'}, 'updating': False}]},
        }]})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(argv, ['hardware', 'list', '--json'])
        self.assertEqual(result.stdout.splitlines(), [
            'host 01234567... online=True available=True devices=1',
            '  device fedcba98... attached=True fw=1.2.3 hw=circle settings=brightness,face updating=False',
            'harness-serial processes of this user: 0', 'dial log: (none yet)',
        ])

    def test_dial_state_rejects_trust_members_output_and_still_reports_diagnostics(self):
        result, argv = self.run_dial_state({'members': [], 'frozen': None, 'frozenPeers': []})
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertEqual(argv, ['hardware', 'list', '--json'])
        self.assertEqual(result.stdout.splitlines(), [
            'hardware list unavailable (command failed or invalid JSON)',
            'harness-serial processes of this user: 0', 'dial log: (none yet)',
        ])


if __name__ == '__main__':
    unittest.main()
