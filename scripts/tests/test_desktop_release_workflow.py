"""release-desktop.yml, read from its text as device-app/scripts/test_release_workflow.py reads release-device.yml:
which jobs run build code, which one holds the Tauri key and which ones hold the bucket. Nothing runs."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
KEY = {"TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"}
# The workflow grants every job id-token: write, from which build code could mint the token the GCP federation accepts.
READ_ONLY = r"(?m)^    permissions:\n      contents: read\n    \S"


def code(text):
    """text without its comment lines, so a comment's words are never taken for the workflow's."""
    return "".join(line for line in text.splitlines(keepends=True) if not line.lstrip().startswith("#"))


def jobs(text):
    """Each job's lines under `jobs:`, comments left out."""
    body = text.split("\njobs:\n", 1)[1]
    return {name: code(job) for name, job in re.findall(r"(?m)^  ([\w-]+):\n((?:(?:    .*)?\n)+)", body)}


def header(job):
    """What a job sets before its steps: every step sees it."""
    return job.split("\n    steps:\n", 1)[0]


def steps(job):
    return re.split(r"(?m)^      - ", job.split("\n    steps:\n", 1)[1])[1:]


def needs(job):
    return set(re.search(r"(?m)^    needs: \[(.+)\]$", job).group(1).split(", "))


class ReleaseDesktopWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.jobs = jobs((ROOT / ".github/workflows/release-desktop.yml").read_text())

    def job(self, name):
        if name not in self.jobs:
            self.fail(f"release-desktop.yml has no {name} job")
        return self.jobs[name]

    def step(self, job, text):
        """The index of the one step of job that holds text."""
        found = [index for index, step in enumerate(steps(job)) if text in step]
        self.assertEqual(len(found), 1, f"steps holding {text!r}: {len(found)}")
        return found[0]

    def test_build_linux_runs_build_code_with_no_secret_no_gcp_and_no_token(self):
        job = self.job("build-linux")
        for text in ("secrets.", "google-github-actions/auth", "setup-gcloud", "gcloud", "TAURI_SIGNING", "id-token"):
            with self.subTest(text=text):
                self.assertNotIn(text, job)
        self.assertRegex(job, READ_ONLY)
        self.step(job, 'bash scripts/package-desktop-linux.sh "$VERSION"')
        upload = steps(job)[self.step(job, "actions/upload-artifact@")]
        self.assertIn("name: desktop-linux-${{ matrix.arch }}\n", upload)
        self.assertIn("path: desktop/build/linux-release/\n", upload)

    def test_sign_linux_holds_the_key_and_runs_no_build_code(self):
        job = self.job("sign-linux")
        self.assertRegex(job, r"(?m)^    needs: \[version, build-linux\]$")
        self.assertRegex(job, READ_ONLY)
        # The signer's script and installer, the check, and the key the check trusts: nothing a build reads.
        self.assertIn("          sparse-checkout: |\n"
                      "            /desktop/scripts/sign-desktop-linux.sh\n"
                      "            /scripts/verify-desktop-release.py\n"
                      "            /device-app/scripts/release-setup.sh\n"
                      "            /device-app/src-tauri/tauri.conf.json\n"
                      "          sparse-checkout-cone-mode: false\n", job)
        order = [self.step(job, text) for text in (
            "release-setup.sh minisign", "actions/download-artifact@", 'sign-desktop-linux.sh "$VERSION"',
            '--signed', "actions/upload-artifact@")]
        self.assertEqual(order, sorted(set(order)))
        named = steps(job)
        sign, check, upload = order[2], order[3], order[4]
        self.assertNotIn("secrets.", header(job))
        holders = [index for index, step in enumerate(named) if "secrets." in step or "TAURI_SIGNING" in step]
        self.assertEqual(holders, [sign])
        self.assertEqual(set(re.findall(r"secrets\.(\w+)", named[sign])), KEY)
        for name in ("Harness-linux-x64.AppImage", "Harness-linux-arm64.AppImage"):
            with self.subTest(checked=name):
                self.assertIn(name, named[check])
        self.assertIn("verify-desktop-release.py", named[check])
        self.assertIn("name: desktop-linux-signatures\n", named[upload])
        self.assertIn("overwrite: true\n", named[upload])
        for text in ("flutter", "appimagetool", "google-github-actions/auth", "gcloud"):
            with self.subTest(text=text):
                self.assertNotIn(text, job)
        self.assertNotRegex(job, r"\bapt(-get)?\b")

    def test_upload_linux_holds_gcp_and_no_key(self):
        job = self.job("upload-linux")
        self.assertRegex(job, r"(?m)^    needs: \[version, build-linux, sign-linux\]$")
        self.step(job, "uses: google-github-actions/auth@")
        download = steps(job)[self.step(job, "actions/download-artifact@")]
        self.assertIn("pattern: desktop-linux-*\n", download)
        self.assertIn("merge-multiple: true\n", download)
        self.assertLess(self.step(job, "uses: ./.github/actions/setup-gcloud"),
                        self.step(job, 'upload-desktop-linux.sh "$VERSION"'))
        self.assertNotIn("TAURI_SIGNING", job)

    def test_build_windows_runs_build_code_with_no_token(self):
        job = self.job("build-windows")
        self.assertRegex(job, READ_ONLY)
        for text in ("secrets.", "google-github-actions/auth", "setup-gcloud"):
            with self.subTest(text=text):
                self.assertNotIn(text, job)

    def test_no_other_job_names_the_signing_key(self):
        self.assertEqual({name for name, job in self.jobs.items() if "TAURI_SIGNING" in job}, {"sign-linux"})

    def test_publish_candidate_and_cleanup_wait_for_the_linux_upload(self):
        for name in ("publish", "candidate"):
            with self.subTest(job=name):
                job = self.job(name)
                condition = re.search(r"(?m)^    if: (.+)$", job).group(1)
                self.assertIn("needs.upload-linux.result == 'success'", condition)
                self.assertNotIn("needs.build-linux.result", condition)
                self.assertIn("upload-linux", needs(job))
                # They check the Linux signatures against the key Harness Device pins.
                self.assertIn("            /device-app/src-tauri/tauri.conf.json\n", job)
        self.assertLessEqual({"sign-linux", "upload-linux"}, needs(self.job("cleanup")))


if __name__ == "__main__":
    unittest.main()
