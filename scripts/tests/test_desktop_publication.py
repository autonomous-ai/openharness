"""Execute the real publisher/upload commands against a disposable object store."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from desktop_publication_fixture import ROOT, artifact_upload_script, make_parts, publisher

URI = "gs://fixture-bucket/harness/desktop/metadata.json"
GCLOUD = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
path = Path(os.environ['FAKE_CLOUD_STATE'])
state = json.loads(path.read_text())
args = sys.argv[1:]
state.setdefault('calls', []).append(args)
objects = state['objects']
def save(): path.write_text(json.dumps(state))
def fail(message):
    save()
    print(message, file=sys.stderr)
    sys.exit(1)
if args[:3] == ['storage', 'objects', 'describe']:
    if os.environ.get('FAKE_READ_ERROR'): fail(os.environ['FAKE_READ_ERROR'])
    obj = objects.get(args[3])
    if obj is None: fail('HTTPError 404: object not found')
    print(json.dumps({'generation': str(obj['generation'])}))
elif args[:2] == ['storage', 'cat']:
    uri, generation = args[2].rsplit('#', 1)
    obj = objects[uri]
    if os.environ.get('FAKE_READ_RACE'):
        obj['generation'] += 1
        obj['data'] = '{"external": "preserved"}'
    if int(generation) != obj['generation']: fail('HTTPError 404: old generation gone')
    print(obj['data'])
elif args[:2] == ['storage', 'cp']:
    source, target = [a for a in args[2:] if not a.startswith('--')]
    obj = objects.get(target)
    if os.environ.get('FAKE_WRITE_RACE') and target.endswith('/metadata.json'):
        obj['generation'] += 1
        obj['data'] = '{"external": "preserved"}'
    expected = next((a.split('=', 1)[1] for a in args if a.startswith('--if-generation-match=')), None)
    actual = obj['generation'] if obj else 0
    if expected is not None and int(expected) != actual: fail('HTTPError 412: generation mismatch')
    objects[target] = {'generation': actual + 1, 'data': Path(source).read_text()}
else:
    fail('unexpected gcloud arguments: ' + repr(args))
save()
'''


class DesktopPublicationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.parts = self.root / "parts"
        self.entries = make_parts(self.parts, "1.2.2", "https://fixture.invalid/1.2.2")
        bindir = self.root / "bin"
        bindir.mkdir()
        client = bindir / "gcloud"
        client.write_text(GCLOUD)
        client.chmod(0o755)
        self.state_path = self.root / "cloud.json"
        self.env = dict(os.environ, PATH=f"{bindir}:{os.environ['PATH']}", FAKE_CLOUD_STATE=str(self.state_path))
        self.seed()

    def seed(self, version="1.2.1"):
        live = {key: dict(entry, version=version) for key, entry in self.entries.items()}
        live["other-product"] = {"keep": True}
        self.state_path.write_text(json.dumps(dict(objects={URI: dict(generation=7, data=json.dumps(live))})))

    def state(self):
        return json.loads(self.state_path.read_text())

    def run_publisher(self, version="1.2.2", flags=(), env=None):
        result = subprocess.run([sys.executable, str(ROOT / "scripts/publish-desktop-manifest.py"),
                                 version, URI, "--parts", str(self.parts), *flags],
                                env=dict(self.env, **(env or {})), capture_output=True, text=True, timeout=15)
        return result, self.state()

    def test_complete_manifest_is_written_once_and_preserves_other_keys(self):
        result, state = self.run_publisher()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        live = json.loads(state["objects"][URI]["data"])
        self.assertEqual(live["other-product"], {"keep": True})
        self.assertEqual({key: live[key] for key in self.entries}, self.entries)
        writes = [call for call in state["calls"] if call[:2] == ["storage", "cp"]]
        self.assertEqual(len(writes), 1)
        self.assertEqual(state["objects"][URI]["generation"], 8)

    def test_duplicate_and_superseded_versions_fail_in_preflight_and_publication(self):
        for live_version in ("1.2.2", "1.2.3", "1.10.0"):
            for flags in ((), ("--check-only",)):
                with self.subTest(live_version=live_version, flags=flags):
                    self.seed(live_version)
                    result, state = self.run_publisher(flags=flags)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("not newer", result.stderr)
                    self.assertEqual(state["objects"][URI]["generation"], 7)

    def test_all_live_desktop_versions_are_checked(self):
        state = self.state()
        live = json.loads(state["objects"][URI]["data"])
        live["desktop-linux-arm64"]["version"] = "1.2.9"
        state["objects"][URI]["data"] = json.dumps(live)
        self.state_path.write_text(json.dumps(state))
        result, state = self.run_publisher()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(state["objects"][URI]["generation"], 7)

    def test_missing_extra_wrong_platform_and_mixed_version_parts_fail_before_gcs(self):
        for change in ("missing", "extra", "wrong-platform", "mixed-version", "bad-hash", "bad-size"):
            with self.subTest(change=change):
                self.seed()
                make_parts(self.parts, "1.2.2", "https://fixture.invalid/1.2.2")
                path = self.parts / "linux-arm64.json"
                part = json.loads(path.read_text())
                if change == "missing":
                    path.unlink()
                elif change == "extra":
                    (self.parts / "extra.json").write_text("{}")
                else:
                    if change == "wrong-platform": part = {"desktop-linux-x64": part["desktop-linux-arm64"]}
                    if change == "mixed-version": part["desktop-linux-arm64"]["version"] = "1.2.1"
                    if change == "bad-hash": part["desktop-linux-arm64"]["sha256"] = "invalid"
                    if change == "bad-size": part["desktop-linux-arm64"]["size"] = False
                    path.write_text(json.dumps(part))
                result, state = self.run_publisher()
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(state.get("calls", []), [])
                (self.parts / "extra.json").unlink(missing_ok=True)

    def test_concurrent_writes_and_reads_do_not_replace_external_changes(self):
        for variable in ("FAKE_WRITE_RACE", "FAKE_READ_RACE"):
            with self.subTest(variable=variable):
                self.seed()
                result, state = self.run_publisher(env={variable: "1"})
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(json.loads(state["objects"][URI]["data"]), {"external": "preserved"})

    def test_initialization_is_explicit_and_permission_errors_fail_closed(self):
        for flags, success in (((), False), (("--allow-initialize",), True)):
            self.state_path.write_text(json.dumps({"objects": {}}))
            result, state = self.run_publisher(flags=flags)
            self.assertEqual(result.returncode == 0, success, result.stderr)
        self.seed()
        result, state = self.run_publisher(flags=("--allow-initialize",), env={"FAKE_READ_ERROR": "HTTPError 403: access denied"})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(state["objects"][URI]["generation"], 7)

    def test_corrupt_or_empty_live_manifest_is_not_silently_reset(self):
        for payload in ("not json", "[]", "{}", '{"desktop-macos":{"version":"bad"}}'):
            with self.subTest(payload=payload):
                state = self.state()
                state["objects"][URI] = dict(generation=7, data=payload)
                self.state_path.write_text(json.dumps(state))
                result, state = self.run_publisher()
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(state["objects"][URI]["data"], payload)

    def test_real_artifact_upload_commands_cannot_overwrite_existing_bytes(self):
        for script, variable in (("upload-desktop.sh", "ZIP"), ("upload-desktop.sh", "DMG"), ("upload-desktop-linux.sh", "OUTPUT")):
            with self.subTest(script=script, variable=variable):
                payload = self.root / "artifact"
                payload.write_text("original bytes")
                target = f"harness/desktop/1.2.2/{variable}"
                env = dict(self.env, **{variable: str(payload)}, GCS_BUCKET="fixture-bucket", GCS_PATH=target, DMG_GCS_PATH=target)
                command = ["bash", "-eu", "-c", artifact_upload_script(script, variable)]
                first = subprocess.run(command, env=env, capture_output=True, text=True, timeout=5)
                self.assertEqual(first.returncode, 0, first.stderr)
                payload.write_text("replacement bytes")
                second = subprocess.run(command, env=env, capture_output=True, text=True, timeout=5)
                self.assertNotEqual(second.returncode, 0)
                self.assertEqual(self.state()["objects"][f"gs://fixture-bucket/{target}"]["data"], "original bytes")


if __name__ == "__main__":
    unittest.main()
