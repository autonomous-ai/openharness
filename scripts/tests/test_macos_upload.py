"""Exercise the real uploader with disposable signing/storage tool processes."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
UPLOADER = ROOT / "desktop/scripts/upload-desktop.sh"

TOOL = r'''
import json, os, shutil, sys, time
from pathlib import Path
root = Path(os.environ["UPLOAD_FIXTURE"])
tool = Path(sys.argv[0]).name
args = sys.argv[1:]
mode = os.environ.get("UPLOAD_FAILURE", "")
notarize = os.environ.get("UPLOAD_NOTARIZE", "1") == "1"
def mark(name):
    (root / name).touch()
def wait_for(name):
    end = time.monotonic() + 4
    while not (root / name).exists():
        if time.monotonic() >= end:
            raise RuntimeError("did not overlap: waiting for " + name)
        time.sleep(.01)
if tool == "curl":
    print('{}')
elif tool == "plutil":
    print('1.2.3')
elif tool == "ditto":
    source, target = map(Path, args[-2:])
    if "-c" not in args:
        if notarize:
            assert (source / 'ticket').exists()
            assert (root / 'app-approved').exists()
        shutil.copytree(source, target)
        (root / 'stage-path').write_text(str(target.parent))
    elif "--zlibCompressionLevel" in args:
        assert not (source / 'ticket').exists()
        target.write_text('unstapled submission')
    else:
        if notarize:
            assert (source / 'ticket').exists()
            assert (root / 'app-approved').exists()
        mark('zip-started')
        if notarize:
            wait_for('dmg-terminal')
        mark('zip-finished')
        if mode == 'zip':
            sys.exit(9)
        target.write_text('stapled final zip' if notarize else 'signed zip')
elif tool == "hdiutil":
    stage = Path(args[args.index('-srcfolder') + 1])
    if notarize:
        assert (stage / 'Harness.app/ticket').exists()
    if mode == 'dmg-create':
        sys.exit(8)
    Path(args[-1]).write_text('stapled app in dmg' if notarize else 'signed app in dmg')
elif tool == "xcrun":
    if args[:2] == ['notarytool', 'submit']:
        dmg = args[2].endswith('.dmg')
        if dmg:
            wait_for('zip-started')
            mark('dmg-notary-started')
            if mode in ('dmg-notary', 'dmg-tool'):
                mark('dmg-terminal')
            if mode == 'dmg-tool':
                sys.exit(7)
        invalid = mode == ('dmg-notary' if dmg else 'app-notary')
        print(json.dumps({'id': 'fixture', 'status': 'Invalid' if invalid else 'Accepted'}))
    elif args[:2] == ['stapler', 'staple']:
        target = Path(args[2])
        if target.is_dir():
            (target / 'ticket').touch()
        else:
            target.write_text(target.read_text() + ' and dmg ticket')
elif tool == "spctl":
    if args[-1].endswith('.dmg'):
        mark('dmg-terminal')
        if mode == 'dmg-gatekeeper':
            sys.exit(6)
        mark('dmg-approved')
    else:
        if mode == 'app-gatekeeper':
            sys.exit(6)
        mark('app-approved')
elif tool == "gcloud":
    if args[:2] == ['storage', 'ls']:
        sys.exit(1)
    if args[:2] == ['storage', 'cp']:
        source, target = args[-2:]
        if source.startswith('gs://'):
            sys.exit(1)
        assert (root / 'zip-finished').exists(), 'uploaded before compression finished'
        if notarize:
            assert (root / 'dmg-approved').exists(), 'uploaded before DMG verification'
        uploads = root / 'uploads'
        uploads.mkdir(exist_ok=True)
        destination = uploads / target.rsplit('/', 1)[-1]
        shutil.copyfile(source, destination)
elif tool not in ('flutter', 'codesign'):
    raise AssertionError('unexpected tool: ' + tool)
'''


class MacOSUploadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "fixture with spaces"
        self.root.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name in ("curl", "plutil", "ditto", "hdiutil", "xcrun", "spctl", "gcloud", "flutter", "codesign"):
            path = self.bin / name
            path.write_text(f"#!{sys.executable}\n" + TOOL)
            path.chmod(0o755)
        self.app = self.root / "Harness.app"
        self.app.mkdir()
        self.output = self.root / "output"
        self.env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ["PATH"],
                        APP_BUNDLE=str(self.app), OUTPUT_DIR=str(self.output),
                        UPLOAD_FIXTURE=str(self.root), GCS_BUCKET="fixture-bucket",
                        GCS_PATH="fixture/Harness.zip", DMG_GCS_PATH="fixture/Harness.dmg",
                        METADATA_PATH="fixture/metadata.json")

    def upload(self, failure="", notarize=True):
        options = [] if notarize else ["--no-notarize"]
        result = subprocess.run(["bash", str(UPLOADER), "--no-build", "1.2.3", *options],
                                env=dict(self.env, UPLOAD_FAILURE=failure, UPLOAD_NOTARIZE=str(int(notarize))),
                                text=True, capture_output=True, timeout=12)
        stage = self.root / "stage-path"
        if stage.exists():
            self.assertFalse(Path(stage.read_text()).exists(), "DMG staging directory leaked")
        return result

    def test_compression_and_dmg_notarization_overlap_but_upload_waits_for_both(self):
        result = self.upload()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((self.root / "dmg-notary-started").exists())
        uploads = self.root / "uploads"
        self.assertEqual((uploads / "Harness.zip").read_text(), "stapled final zip")
        self.assertEqual((uploads / "Harness.dmg").read_text(), "stapled app in dmg and dmg ticket")
        self.assertEqual(set(json.loads((uploads / "metadata.json").read_text())),
                         {"desktop-macos", "desktop-macos-dmg"})
        self.assertIn("packaging timing: final-zip ", result.stderr)
        self.assertIn("packaging timing: dmg-notarization ", result.stderr)

    def test_failed_zip_prevents_all_uploads(self):
        result = self.upload("zip")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("final ZIP compression failed", result.stderr)
        self.assertFalse((self.root / "uploads").exists())

    def test_dmg_failures_reap_the_compressor_before_returning(self):
        for failure in ("dmg-notary", "dmg-tool", "dmg-gatekeeper"):
            with self.subTest(failure=failure):
                # Each failure runs in its own disposable fixture.
                case = MacOSUploadTests()
                case.setUp()
                try:
                    result = case.upload(failure)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertTrue((case.root / "zip-finished").exists())
                    self.assertFalse((case.root / "uploads").exists())
                finally:
                    case.doCleanups()

    def test_app_rejections_stop_before_final_artifacts(self):
        for failure in ("app-notary", "app-gatekeeper", "dmg-create"):
            with self.subTest(failure=failure):
                case = MacOSUploadTests()
                case.setUp()
                try:
                    result = case.upload(failure)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse((case.root / "zip-started").exists())
                    self.assertFalse((case.root / "uploads").exists())
                finally:
                    case.doCleanups()

    def test_explicit_no_notarize_keeps_its_existing_artifacts(self):
        result = self.upload(notarize=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse((self.root / "dmg-notary-started").exists())
        self.assertEqual((self.root / "uploads/Harness.zip").read_text(), "signed zip")


if __name__ == "__main__":
    unittest.main()
