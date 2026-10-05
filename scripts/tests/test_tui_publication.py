"""Execute the workflow's real publisher against a disposable fake object store."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = "gs://fixture-bucket/harness/tui/metadata.json"
PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]

GCLOUD = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
state_path = Path(os.environ['FAKE_CLOUD_STATE'])
state = json.loads(state_path.read_text())
args = sys.argv[1:]
state.setdefault('calls', []).append(args)
def save(): state_path.write_text(json.dumps(state))
def fail(message):
    save()
    sys.exit(message)
if args[:3] == ['storage', 'objects', 'describe']:
    print(state['generation'])
elif args[:2] == ['storage', 'cp']:
    source, target = args[2:4]
    if source.startswith('gs://'):
        if source not in state['objects']: fail('404 missing object')
        Path(target).write_text(state['objects'][source])
    else:
        if target.endswith('/metadata.json') and os.environ.get('FAKE_CONCURRENT_PUBLISH'):
            state['generation'] += 1
            state['objects'][target] = json.dumps({'version': '0.9.0'})
        expected = next((a.split('=', 1)[1] for a in args if a.startswith('--if-generation-match=')), None)
        actual = state['generation'] if target.endswith('/metadata.json') else (1 if target in state['objects'] else 0)
        if expected is not None and int(expected) != actual: fail('412 generation mismatch')
        state['objects'][target] = Path(source).read_text()
        if target.endswith('/metadata.json'): state['generation'] += 1
else:
    fail('unexpected gcloud operation: ' + repr(args))
save()
'''


class TuiPublicationTests(unittest.TestCase):
    def setUp(self):
        for command in ('bash', 'jq', 'sha256sum', 'python3'):
            self.assertIsNotNone(shutil.which(command), f"publisher contract tests require {command}")
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "bin").mkdir()
        (self.root / "scripts").mkdir()
        (self.root / "dist").mkdir()
        shutil.copy2(ROOT / "scripts/check-release-version.py", self.root / "scripts/check-release-version.py")
        for platform in PLATFORMS:
            (self.root / "dist" / f"harness-tui-{platform}").write_text(platform)
        mock = self.root / "bin/gcloud"
        mock.write_text(GCLOUD)
        mock.chmod(0o755)
        self.state = self.root / "cloud.json"
        self.seed("0.1.10")
        workflow = (ROOT / ".github/workflows/release-tui.yml").read_text()
        # This final step is deliberately tested as executed, including conditional
        # gcloud flags. Moving it to a helper requires updating this extraction.
        block = workflow.split("      - name: Publish binaries and manifest\n", 1)[1]
        self.publisher = textwrap.dedent(block.split("        run: |\n", 1)[1])

    def seed(self, version):
        self.state.write_text(json.dumps({"generation": 7, "objects": {MANIFEST: json.dumps({"version": version})}}))

    def publish(self, version="0.1.11", race=False):
        env = dict(os.environ, PATH=f"{self.root / 'bin'}:{os.environ['PATH']}",
                   GCS_BUCKET="fixture-bucket", VERSION=version,
                   FAKE_CLOUD_STATE=str(self.state), GITHUB_STEP_SUMMARY=str(self.root / "summary"))
        if race:
            env["FAKE_CONCURRENT_PUBLISH"] = "1"
        result = subprocess.run(["bash", "-e", "-c", self.publisher], cwd=self.root, env=env,
                                capture_output=True, text=True, timeout=15)
        return result, json.loads(self.state.read_text())

    def test_publishes_all_platform_hashes_then_updates_one_manifest(self):
        result, state = self.publish()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        manifest = json.loads(state["objects"][MANIFEST])
        self.assertEqual(manifest["version"], "0.1.11")
        self.assertEqual(set(manifest["builds"]), set(PLATFORMS))
        for platform in PLATFORMS:
            self.assertEqual(manifest["builds"][platform]["sha256"], hashlib.sha256(platform.encode()).hexdigest())
        writes = [c for c in state["calls"] if c[:2] == ["storage", "cp"] and not c[2].startswith("gs://")]
        self.assertEqual(len(writes), 5)
        self.assertTrue(all("--if-generation-match=0" in c for c in writes[:4]))
        self.assertIn("--if-generation-match=7", writes[-1])

    def test_duplicate_version_fails_before_any_artifact_write(self):
        result, state = self.publish("0.1.10")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(state["objects"]), 1)
        self.assertEqual(state["generation"], 7)

    def test_existing_immutable_artifact_is_not_replaced(self):
        state = json.loads(self.state.read_text())
        artifact = "gs://fixture-bucket/harness/tui/0.1.11/harness-tui-darwin-arm64"
        state["objects"][artifact] = "previous bytes"
        self.state.write_text(json.dumps(state))
        result, state = self.publish()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(state["objects"][artifact], "previous bytes")
        self.assertEqual(json.loads(state["objects"][MANIFEST])["version"], "0.1.10")

    def test_concurrent_manifest_update_is_not_lost(self):
        result, state = self.publish(race=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(json.loads(state["objects"][MANIFEST])["version"], "0.9.0")

    def test_invalid_live_manifest_fails_before_upload(self):
        state = json.loads(self.state.read_text())
        state["objects"][MANIFEST] = "not json"
        self.state.write_text(json.dumps(state))
        result, state = self.publish()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(state["objects"]), 1)


if __name__ == "__main__":
    unittest.main()
