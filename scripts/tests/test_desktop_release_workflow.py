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


def checkout(job):
    """The paths a job's sparse checkout lists."""
    listed = re.search(r"(?m)^          sparse-checkout: \|\n((?:            .+\n)+)", job).group(1)
    return {line.strip().lstrip("/") for line in listed.splitlines()}


def modules(path):
    """path and the repository modules it loads, and theirs in turn, in each way the release scripts load one."""
    loaded, pending = set(), [Path(path)]
    while pending:
        path = pending.pop()
        if path.as_posix() in loaded:
            continue
        loaded.add(path.as_posix())
        text = (ROOT / path).read_text()
        pending += [path.parent / name for name in re.findall(r"""with_name\(['"]([\w-]+\.py)['"]\)""", text)]
        pending += [path.parent / f"{name}.py" for name in re.findall(r"""\bsibling\(['"]([\w-]+)['"]\)""", text)]
        pending += [Path(name) for name in re.findall(r"""ROOT / ['"]([\w/-]+\.py)['"]""", text)]
        # The GCS checks put scripts/tests/ on sys.path for the fixture they share with the tests.
        pending += [path.parent / "tests" / f"{name}.py" for name in re.findall(r"(?m)^from (\w+) import", text)
                    if (ROOT / path.parent / "tests" / f"{name}.py").is_file()]
    return loaded


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

    def test_build_linux_runs_appimagetool_only_when_its_pinned_sha256_matches(self):
        # What appimagetool packages gets Harness's signature, so the tool is pinned by its bytes, not only its tag.
        job = self.job("build-linux")
        download = steps(job)[self.step(job, "appimagetool-${APPIMAGE_ARCH}.AppImage")]
        self.assertIn("APPIMAGE_ARCH: ${{ matrix.arch == 'arm64' && 'aarch64' || 'x86_64' }}\n", download)
        sums = re.search(r"APPIMAGETOOL_SHA256: \$\{\{ matrix\.arch == 'arm64' && '([0-9a-f]{64})' \|\| '([0-9a-f]{64})' \}\}\n",
                         download)
        self.assertIsNotNone(sums, "a pinned sha256 for each architecture")
        self.assertNotEqual(sums.group(1), sums.group(2))
        check = download.find('"$APPIMAGETOOL_SHA256  $RUNNER_TEMP/appimagetool" | sha256sum --check --strict')
        self.assertGreater(check, download.find("curl -fL"))
        self.assertLess(check, download.find("chmod +x"))

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
        upload = self.step(job, 'upload-desktop-linux.sh "$VERSION"')
        self.assertLess(self.step(job, "uses: ./.github/actions/setup-gcloud"), upload)
        self.assertNotIn("TAURI_SIGNING", job)

    def test_upload_linux_uploads_only_appimages_their_signatures_verify(self):
        # The merged download holds build-linux's artifact too, made by build code: sign-linux's check is repeated on the
        # very files that go up.
        job = self.job("upload-linux")
        check = self.step(job, "--signed")
        self.assertIn('python3 scripts/verify-desktop-release.py "$VERSION"', steps(job)[check])
        for name in ("Harness-linux-x64.AppImage", "Harness-linux-arm64.AppImage"):
            with self.subTest(checked=name):
                self.assertIn(f"linux-release/{name}", steps(job)[check])
        self.assertLess(self.step(job, "actions/download-artifact@"), check)
        self.assertLess(check, self.step(job, 'upload-desktop-linux.sh "$VERSION"'))
        # The check and the key it trusts, the one the apps pin.
        self.assertLessEqual({"scripts/verify-desktop-release.py", "device-app/src-tauri/tauri.conf.json"}, checkout(job))

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

    def test_the_publication_check_checks_out_every_module_it_loads_and_every_upload_script_it_runs(self):
        # Only a dispatched run uses this checkout, and the only real runs of the create-only uploads, seal and promote
        # are there: a file left out fails them with FileNotFoundError.
        job = self.job("publication-test")
        checks = re.findall(r"python3 (scripts/[\w-]+\.py)", job)
        self.assertEqual(sorted(checks), ["scripts/check-desktop-candidate-gcs.py", "scripts/check-desktop-publication-gcs.py"])
        needed = set().union(*(modules(check) for check in checks))
        # Reached only through the fixture and the publisher, so a walk that stopped at the checks would miss it.
        self.assertIn("scripts/verify-desktop-release.py", needed)
        # The scripts whose gcs_cp and upload line the publication check runs, from desktop/scripts/.
        uploads = re.findall(r'"([\w-]+\.sh)"', (ROOT / "scripts/check-desktop-publication-gcs.py").read_text())
        needed |= {f"desktop/scripts/{name}" for name in uploads}
        self.assertEqual(sorted(needed - checkout(job)), [])


if __name__ == "__main__":
    unittest.main()
