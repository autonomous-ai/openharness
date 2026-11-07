"""The release workflow keeps Apple signing material away from every job that runs a branch's code.

`if:` conditions are the branch's own text, so the enforcement is the `release` environment (limited
to main and v*_desktop tags) holding the secrets. These tests keep the workflow's shape matching it:
only the signing jobs read signing material, and they build nothing.
"""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]
RELEASE = ROOT / '.github/workflows/release-desktop.yml'
INTERNAL = ROOT / '.github/workflows/desktop-internal-build.yml'
SIGNING_MATERIAL = ('secrets.APPLE_', 'secrets.KEYCHAIN_PASSWORD', 'macos-signing')


def jobs(path):
    text = path.read_text()
    section = text[text.index('\njobs:\n'):]
    return dict(re.findall(r'^  ([\w-]+):\n(.*?)(?=^  [\w-]+:\n|\Z)', section, re.M | re.S))


def condition(body):
    return re.search(r'^    if: (.+)$', body, re.M)[1]


def resolve_script(body):
    step = body[body.index('- id: resolve'):]
    block = re.search(r'^        run: \|\n((?:(?: {10}.*)?\n)+)', step, re.M)[1]
    return textwrap.dedent(block)


class ReleaseSigningTests(unittest.TestCase):
    def setUp(self):
        self.jobs = jobs(RELEASE)

    def test_only_sign_macos_reads_apple_signing_material(self):
        self.assertIn('sign-macos', self.jobs)
        for job, body in self.jobs.items():
            for material in SIGNING_MATERIAL:
                if job != 'sign-macos':
                    self.assertNotIn(material, body, f'{job} reads {material}')
        for material in SIGNING_MATERIAL:
            self.assertIn(material, self.jobs['sign-macos'])

    def test_signing_jobs_run_in_the_release_environment_for_main_and_desktop_tags_only(self):
        for job in ('sign-macos', 'sign-windows'):
            with self.subTest(job=job):
                body = self.jobs[job]
                self.assertRegex(body, r'(?m)^    environment: release$')
                rule = condition(body)
                for part in ("github.ref == 'refs/heads/main'", "startsWith(github.ref, 'refs/tags/v')",
                             "endsWith(github.ref, '_desktop')"):
                    self.assertIn(part, rule)

    def test_sign_macos_runs_no_build_tooling(self):
        body = self.jobs['sign-macos']
        for tool in ('desktop-flutter', 'flutter ', 'pod ', 'xcodebuild', 'publish-macos-variant', 'dart '):
            self.assertNotIn(tool, body)
        self.assertEqual(set(re.findall(r'uses: (\./[^\s]+)', body)), {'./.github/actions/macos-signing'})
        checkout = re.search(r'^          sparse-checkout: \|\n((?:            .+\n)+)', body, re.M)[1].split()
        for path in checkout:
            self.assertTrue(path == '/.github/actions/macos-signing/' or not path.endswith('/'),
                            f'{path}: sign-macos checks out single files, never a source tree')
        self.assertIn('--no-build', body)

    def test_build_macos_holds_no_secret_or_cloud_identity(self):
        body = self.jobs['build-macos']
        self.assertNotIn('secrets.', body)
        self.assertNotIn('google-github-actions/auth', body)
        self.assertIn('desktop-macos-unsigned', body)
        self.assertIn('desktop-macos-unsigned', self.jobs['sign-macos'])

    def test_publication_and_candidates_wait_for_signed_macos(self):
        for job in ('publish', 'candidate'):
            with self.subTest(job=job):
                body = self.jobs[job]
                self.assertIn('sign-macos', re.search(r'^    needs: (.+)$', body, re.M)[1])
                self.assertIn("needs.sign-macos.result == 'success'", condition(body))

    def test_branch_release_is_refused_but_branch_prepare_and_tags_resolve(self):
        body = self.jobs['version']
        self.assertIn('REF: ${{ github.ref }}', body)
        script = resolve_script(body)
        cases = [('refs/heads/feature', {}, False), ('refs/heads/feature', dict(PREPARE_ONLY='true'), True),
                 ('refs/heads/feature', dict(TEST_REUSE='true'), True), ('refs/heads/main', {}, True),
                 ('refs/tags/v1.2.3_desktop', {}, True), ('refs/tags/v1.2.3_cli', {}, False)]
        for ref, extra, passes in cases:
            with self.subTest(ref=ref, **extra), tempfile.TemporaryDirectory() as folder:
                output, summary = Path(folder, 'output'), Path(folder, 'summary')
                env = dict(os.environ, REF=ref, REF_NAME=ref.rsplit('/', 1)[-1], INPUT_VERSION='1.2.3',
                           INPUT_METADATA_PATH='', PREPARE_ONLY='false', TEST_REUSE='false', GCS_BUCKET='bucket',
                           GITHUB_OUTPUT=str(output), GITHUB_STEP_SUMMARY=str(summary), GITHUB_RUN_ID='1',
                           GITHUB_RUN_ATTEMPT='1')
                env.update(extra)
                result = subprocess.run(['bash', '-c', script], env=env, capture_output=True, text=True, timeout=20)
                if passes:
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertIn('version=1.2.3', output.read_text())
                    if extra.get('PREPARE_ONLY'):
                        self.assertIn('unsigned', summary.read_text())
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('main or a vX.Y.Z_desktop tag', result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
