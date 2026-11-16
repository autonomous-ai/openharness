"""The release rules (device-manifest.py) against temp folders, temp Git repositories, a fake gcloud and a file server on
127.0.0.1. Nothing reaches a bucket, a CDN or GitHub."""
import functools
import hashlib
from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parent / "device-manifest.py"
spec = importlib.util.spec_from_file_location("device_manifest", SCRIPT)
rules = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rules)

# The fixed places, written out here so a change to the script's constants fails a test.
BUCKET = "gs://s3-autonomous-upgrade-3/harness/device"
LIVE = f"{BUCKET}/metadata.json"
CDN = "https://cdn.autonomous.ai/harness/device"
ORIGIN_MANIFEST = "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/metadata.json"
FILES = ("Harness-Device.dmg", "Harness-Device.app.tar.gz", "Harness-Device.app.tar.gz.sig")
PUB_DATE = "2026-11-16T10:00:00Z"
DMG, ARCHIVE, SIGNATURE = b"dmg bytes", b"archive bytes", "c2lnbmF0dXJl"
GIT = ["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "maintenance.auto=false",
       "-c", "commit.gpgsign=false"]

# A bucket in a folder: objects are files under objects/, their generations in generations.json, every call a line of
# calls.jsonl. fail.json ({"when": [...], "stderr": "..."}) fails the calls whose arguments hold every "when" string.
GCLOUD = r'''#!/usr/bin/env python3
import json, os, shutil, sys
from pathlib import Path

state = Path(os.environ["FAKE_GCLOUD"])
args = sys.argv[1:]
with open(state / "calls.jsonl", "a") as log:
    log.write(json.dumps(args) + "\n")
fail = state / "fail.json"
if fail.exists():
    rule = json.loads(fail.read_text())
    if all(text in args for text in rule["when"]):
        sys.exit(rule["stderr"])
generations = json.loads((state / "generations.json").read_text())


def stored(uri):
    return state / "objects" / uri.removeprefix("gs://")


def missing(uri):
    sys.exit(f"ERROR: (gcloud.storage) {uri} not found: 404.")


if args[:3] == ["storage", "objects", "describe"]:
    if args[3] not in generations:
        missing(args[3])
    print(json.dumps({"name": args[3], "generation": str(generations[args[3]])}))
elif args[:2] == ["storage", "cat"]:
    uri, _, generation = args[2].partition("#")
    if generations.get(uri) != int(generation):
        missing(args[2])
    sys.stdout.write(stored(uri).read_text())
elif args[:2] == ["storage", "cp"]:
    source, target = [arg for arg in args[2:] if not arg.startswith("--")]
    match = [arg.split("=", 1)[1] for arg in args if arg.startswith("--if-generation-match=")]
    if source.startswith("gs://"):
        if source not in generations:
            missing(source)
        shutil.copyfile(stored(source), target)
    elif "--no-clobber" in args and target in generations:
        print(f"Skipping existing destination item (no-clobber): {target}", file=sys.stderr)
    elif match and int(match[0]) != generations.get(target, 0):
        sys.exit("ERROR: (gcloud.storage.cp) HTTPError 412: At least one of the pre-conditions did not hold.")
    else:
        stored(target).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, stored(target))
        generations[target] = generations.get(target, 0) + 1
        (state / "generations.json").write_text(json.dumps(generations))
else:
    sys.exit(f"unexpected gcloud arguments: {args!r}")
'''


def make_build(folder):
    """The three files of a build, as the build job leaves them."""
    folder.mkdir(parents=True)
    for name, data in zip(FILES, (DMG, ARCHIVE, (SIGNATURE + "\n").encode())):
        (folder / name).write_bytes(data)
    return folder


def flip(path):
    """Change one byte, keeping the size."""
    data = bytearray(path.read_bytes())
    data[0] ^= 1
    path.write_bytes(bytes(data))


def run(*args, cwd=None):
    return subprocess.run([sys.executable, str(SCRIPT), *map(str, args)], capture_output=True, text=True,
                          timeout=60, cwd=cwd)


def refused(test, result):
    test.assertEqual(result.returncode, 1, result.stdout + result.stderr)
    test.assertEqual(len(result.stderr.splitlines()), 1, result.stderr)
    test.assertTrue(result.stderr.startswith("ERROR "), result.stderr)


def git(repo, *args):
    return subprocess.run([*GIT, "-C", str(repo), *args], check=True, capture_output=True, text=True,
                          timeout=30).stdout.strip()


def commit(repo, message):
    git(repo, "commit", "-q", "--allow-empty", "-m", message)
    return git(repo, "rev-parse", "HEAD")


class TempTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        environment = mock.patch.dict(os.environ)
        environment.start()
        self.addCleanup(environment.stop)
        for name in ("GIT_DIR", "GIT_WORK_TREE"):
            os.environ.pop(name, None)


class VersionTests(TempTest):
    def test_next_version(self):
        ignored = ["v9.9.9_desktop", "v01.2.3_device", "v1.2.3_device_x", "v1.2_device"]
        for tags, live, flags, version, last_tag in [
            (["v0.1.0_device"], "0.1.0", {}, "0.1.1", "v0.1.0_device"),
            (["v0.1.0_device", "v0.1.99_device"], "0.1.99", {}, "0.2.1", "v0.1.99_device"),
            (["v0.1.5_device"], "0.1.5", {"minor": True}, "0.2.1", "v0.1.5_device"),
            (["v0.1.2_device"], "0.1.5", {}, "0.1.6", "v0.1.2_device"),
            (["v0.2.0_device"], "0.1.9", {}, "0.2.1", "v0.2.0_device"),
            (["v0.9.9_device"], "0.10.0", {}, "0.10.1", "v0.9.9_device"),
            (["v0.10.0_device", "v0.9.9_device"], "0.9.9", {}, "0.10.1", "v0.10.0_device"),
            (["v0.1.0_device", *ignored], "0.1.0", {}, "0.1.1", "v0.1.0_device"),
            (["v0.1.0_device"], "0.1.0", {"explicit": "0.3.0"}, "0.3.0", "v0.1.0_device"),
        ]:
            with self.subTest(tags=tags, live=live, flags=flags):
                self.assertEqual(rules.next_version(tags, live, **flags),
                                 {"version": version, "last_tag": last_tag, "live": live})

    def test_next_refuses(self):
        for explicit in ("0.1.0", "0.0.9", "0.01.0", "v0.1.0", "0.1"):
            with self.subTest(explicit=explicit), self.assertRaises(ValueError):
                rules.next_version(["v0.1.0_device"], "0.1.0", explicit=explicit)
        with self.assertRaisesRegex(ValueError, re.escape(ORIGIN_MANIFEST)):
            rules.next_version([], None, explicit="0.1.0")
        with self.assertRaisesRegex(ValueError, "first release"):
            rules.next_version(["v0.1.0_device"], None, explicit="0.1.1", allow_no_manifest=True)
        self.assertEqual(rules.next_version([], None, explicit="0.1.0", allow_no_manifest=True),
                         {"version": "0.1.0", "last_tag": "", "live": "0.0.0"})

    def test_a_manifest_that_is_not_one_cannot_be_read(self):
        tags, no_tags, manifest = self.root / "tags", self.root / "no-tags", self.root / "metadata.json"
        tags.write_text("v0.1.0_device\n")
        no_tags.write_text("")
        for text in ("not json", "[]", "{}", '{"version":"1.0"}'):
            with self.subTest(text=text):
                self.assertIsNone(rules.live_version(text))
                manifest.write_text(text)
                # Something is live, so not even the first release may go on without its version.
                for args in (("--tags", tags), ("--tags", no_tags, "--allow-no-manifest", "0.1.0")):
                    result = run("next", "--manifest", manifest, *args)
                    refused(self, result)
                    self.assertIn(f"the live manifest at {ORIGIN_MANIFEST} has no readable X.Y.Z version",
                                  result.stderr)

    def test_next_prints_one_value_a_line(self):
        tags, manifest = self.root / "tags", self.root / "metadata.json"
        tags.write_text("v0.1.0_device\nv0.1.0_desktop\n")
        manifest.write_text('{"version": "0.1.0", "notes": "Harness Device 0.1.0"}')
        result = run("next", "--tags", tags, "--manifest", manifest)
        self.assertEqual((result.returncode, result.stdout), (0, "version=0.1.1\nlast_tag=v0.1.0_device\nlive=0.1.0\n"),
                         result.stderr)
        tags.write_text("")
        result = run("next", "--tags", tags, "--allow-no-manifest", "0.1.0")
        self.assertEqual((result.returncode, result.stdout), (0, "version=0.1.0\nlast_tag=\nlive=0.0.0\n"), result.stderr)
        refused(self, run("next", "--manifest", manifest))  # a usage error is one ERROR line too


class RefTests(TempTest):
    def setUp(self):
        super().setUp()
        self.repo = self.root / "repo"
        self.repo.mkdir()
        git(self.repo, "init", "-q", "-b", "main")
        self.a = commit(self.repo, "A")
        self.b = commit(self.repo, "B")
        git(self.repo, "update-ref", "refs/remotes/origin/main", self.b)
        git(self.repo, "checkout", "-q", "-b", "side", self.a)
        self.c = commit(self.repo, "C")

    def test_ref_rules(self):
        for args in [("0.1.0", "refs/tags/v0.1.0_device", "true"), ("0.1.0", "refs/heads/main", "false")]:
            rules.check_ref(*args)
        bad_versions = ("0.1", "v0.1.0", "0.1.0_device", "01.2.3", "0.1.0\n", "$(id)")
        for args in [
            ("0.1.0", "refs/heads/main", "true"),
            ("0.1.0", "refs/tags/v0.1.1_device", "true"),
            ("0.1.0", "refs/tags/v0.1.0_desktop", "true"),
            ("0.1.0", "refs/heads/feat/x", "false"),
            ("0.1.0", "refs/tags/v0.1.0_device", "false"),
            *[(version, f"refs/tags/v{version}_device", "true") for version in bad_versions],
            *[(version, "refs/heads/main", "false") for version in bad_versions],
            *[("0.1.0", ref, publish) for publish in ("True", "1", "", "yes")
              for ref in ("refs/tags/v0.1.0_device", "refs/heads/main")],
        ]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                rules.check_ref(*args)

    def test_the_runs_commit_must_be_on_main(self):
        rules.check_on_main(self.a, str(self.repo))
        rules.check_on_main(self.b, str(self.repo))
        with self.assertRaisesRegex(ValueError, "origin/main"):
            rules.check_on_main(self.c, str(self.repo))
        with self.assertRaises(ValueError):
            rules.check_on_main("a" * 40, str(self.repo))
        with mock.patch("subprocess.run", side_effect=AssertionError("Git ran")):
            for commit_ in ("--help", "-x", "HEAD", self.a[:12], self.a.upper()):
                with self.subTest(commit=commit_), self.assertRaises(ValueError):
                    rules.check_on_main(commit_, str(self.repo))
        other = self.root / "other"
        other.mkdir()
        git(other, "init", "-q", "-b", "main")
        with self.assertRaises(ValueError):
            rules.check_on_main(commit(other, "D"), str(other))

    def test_the_ref_command_checks_both(self):
        refused(self, run("ref", "0.1.0", "refs/tags/v0.1.0_device", "true", self.c, cwd=self.repo))
        result = run("ref", "0.1.0", "refs/tags/v0.1.0_device", "true", self.b, cwd=self.repo)
        self.assertEqual(result.returncode, 0, result.stderr)
        refused(self, run("ref", "0.1", "refs/tags/v0.1_device", "true", self.b, cwd=self.repo))


class ManifestTests(TempTest):
    def setUp(self):
        super().setUp()
        self.build = make_build(self.root / "build")

    def test_build_manifest_is_the_spec_shape(self):
        manifest = rules.build_manifest("0.1.0", self.build, "Harness Device 0.1.0\n\n- one\n\n", PUB_DATE, CDN)
        self.assertEqual(list(manifest), ["version", "notes", "pub_date", "platforms", "dmg"])
        update = {"url": f"{CDN}/0.1.0/Harness-Device.app.tar.gz", "signature": SIGNATURE}
        self.assertEqual(manifest["platforms"], {"darwin-aarch64": update, "darwin-x86_64": update})
        self.assertEqual(manifest["dmg"], {"url": f"{CDN}/0.1.0/Harness-Device.dmg",
                                           "sha256": hashlib.sha256(DMG).hexdigest(), "size": len(DMG)})
        self.assertRegex(manifest["dmg"]["sha256"], r"^[0-9a-f]{64}$")
        self.assertEqual((manifest["version"], manifest["notes"], manifest["pub_date"]),
                         ("0.1.0", "Harness Device 0.1.0\n\n- one", PUB_DATE))

        notes, out = self.root / "notes.txt", self.root / "metadata.json"
        notes.write_text("Harness Device 0.1.0\n\n- one\n\n")
        result = run("build", "--version", "0.1.0", "--dir", self.build, "--notes-file", notes, "--pub-date", PUB_DATE,
                     "--base-url", CDN, "--out", out)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(out.read_text(), json.dumps(manifest, indent=2) + "\n")

        for name in FILES:
            with self.subTest(missing=name):
                folder = self.root / f"without-{name}"
                shutil.copytree(self.build, folder)
                (folder / name).unlink()
                with self.assertRaises(OSError):
                    rules.build_manifest("0.1.0", folder, "notes", PUB_DATE, CDN)
        for pub_date in ("2026-11-16 10:00:00", "2026-11-16T10:00:00+00:00", "2026-11-16T10:00Z", "2026-13-01T10:00:00Z",
                         "2026-1-16T10:00:00Z", "2026-11-16T10:00:00Z\n"):
            with self.subTest(pub_date=pub_date), self.assertRaises(ValueError):
                rules.build_manifest("0.1.0", self.build, "notes", pub_date, CDN)

    def test_sums_round_trip(self):
        sums = self.root / "sums.json"
        result = run("sums", "--dir", self.build, "--out", sums)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(sums.read_text()), {
            name: {"sha256": hashlib.sha256((self.build / name).read_bytes()).hexdigest(),
                   "size": (self.build / name).stat().st_size} for name in FILES})
        result = run("sums", "--dir", self.build, "--check", sums)
        self.assertEqual(result.returncode, 0, result.stderr)
        flip(self.build / "Harness-Device.dmg")
        result = run("sums", "--dir", self.build, "--check", sums)
        refused(self, result)
        self.assertIn("Harness-Device.dmg", result.stderr)


class PublishTests(TempTest):
    def setUp(self):
        super().setUp()
        self.build = make_build(self.root / "build")
        bin_folder = self.root / "bin"
        bin_folder.mkdir()
        (bin_folder / "gcloud").write_text(GCLOUD)
        (bin_folder / "gcloud").chmod(0o755)
        os.environ["PATH"] = f"{bin_folder}{os.pathsep}{os.environ['PATH']}"
        self.new_cloud("cloud")

    def new_cloud(self, label):
        """An empty bucket, which the fake gcloud then uses."""
        self.cloud = self.root / label
        (self.cloud / "objects").mkdir(parents=True)
        (self.cloud / "generations.json").write_text("{}")
        os.environ["FAKE_GCLOUD"] = str(self.cloud)

    def put(self, name, data, generation=1):
        uri = f"{BUCKET}/{name}"
        path = self.cloud / "objects" / uri.removeprefix("gs://")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data if isinstance(data, bytes) else data.encode())
        (self.cloud / "generations.json").write_text(json.dumps(dict(self.generations(), **{uri: generation})))

    def stored(self, name):
        return (self.cloud / "objects" / f"{BUCKET}/{name}".removeprefix("gs://")).read_bytes()

    def generations(self):
        return json.loads((self.cloud / "generations.json").read_text())

    def fail_call(self, when, stderr):
        (self.cloud / "fail.json").write_text(json.dumps({"when": when, "stderr": stderr}))

    def calls(self):
        log = self.cloud / "calls.jsonl"
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

    def steps(self):
        """Each gcloud call as (what, object): describe, cat, upload or download."""
        steps = []
        for call in self.calls():
            names = [arg for arg in call[2:] if not arg.startswith("--")]
            if call[1] == "cp":
                steps.append(("download", names[0]) if names[0].startswith("gs://") else ("upload", names[1]))
            else:
                steps.append(("cat" if call[1] == "cat" else "describe", names[-1]))
        return steps

    def uploads(self, version):
        """Each file uploaded, then read back."""
        return [step for name in FILES for step in (("upload", f"{BUCKET}/{version}/{name}"),
                                                   ("download", f"{BUCKET}/{version}/{name}"))]

    def publish(self, version):
        return rules.publish(version, self.build, "Harness Device notes\n", PUB_DATE)

    def test_first_release_writes_only_where_none_exists(self):
        written = self.publish("0.1.0")
        self.assertEqual(self.steps(), [("describe", LIVE), *self.uploads("0.1.0"), ("upload", LIVE)])
        self.assertIn("--if-generation-match=0", self.calls()[-1])
        self.assertEqual(json.loads(self.stored("metadata.json")), written)

    def test_publish_guards_the_generation_it_read(self):
        self.put("metadata.json", '{"version": "0.1.0"}', generation=7)
        written = self.publish("0.1.1")
        self.assertEqual(self.steps(), [("describe", LIVE), ("cat", f"{LIVE}#7"), *self.uploads("0.1.1"),
                                        ("upload", LIVE)])
        calls = self.calls()
        uploads = [call for call in calls if call[-1].startswith(f"{BUCKET}/0.1.1/")]
        self.assertEqual([call[:4] + call[5:] for call in uploads],
                         [["storage", "cp", "--no-clobber", "--cache-control=public, max-age=31536000, immutable",
                           f"{BUCKET}/0.1.1/{name}"] for name in FILES])
        self.assertEqual([Path(call[4]) for call in uploads], [self.build / name for name in FILES])
        self.assertEqual(calls[-1][3:], [LIVE, "--if-generation-match=7", "--content-type=application/json",
                                         "--cache-control=no-cache"])
        self.assertEqual(json.loads(self.stored("metadata.json")), written)
        self.assertEqual(self.generations()[LIVE], 8)
        self.assertEqual(written["dmg"]["url"], f"{CDN}/0.1.1/Harness-Device.dmg")
        self.assertEqual(written["notes"], "Harness Device notes")

    def test_publish_refuses_a_version_not_greater(self):
        self.put("metadata.json", '{"version": "0.1.0"}', generation=7)
        with self.assertRaisesRegex(ValueError, "not greater"):
            self.publish("0.0.9")
        self.assertNotIn("cp", [call[1] for call in self.calls()])

    def live_build(self, change=None):
        """This build live as 0.1.1 at generation 7, its three files in the bucket, as a run that wrote the manifest
        leaves it; notes and date of that run's own."""
        live = rules.build_manifest("0.1.1", self.build, "Harness Device 0.1.1", "2026-11-15T09:00:00Z", CDN)
        if change:
            change(live)
        self.put("metadata.json", json.dumps(live), generation=7)
        for name in FILES:
            self.put(f"0.1.1/{name}", (self.build / name).read_bytes())
        return live

    def test_a_rerun_of_the_live_build_writes_nothing(self):
        # So the run's verify step runs again, after a failed verify or a write gcloud timed out on.
        live = self.live_build()
        self.assertEqual(self.publish("0.1.1"), live)
        self.assertEqual(self.steps(), [("describe", LIVE), ("cat", f"{LIVE}#7")])
        self.assertEqual(self.generations()[LIVE], 7)

    def test_a_rerun_refuses_other_files_under_the_live_version(self):
        self.live_build(lambda live: live["platforms"]["darwin-aarch64"].update(signature="b3RoZXI="))
        with self.assertRaisesRegex(ValueError, "^0.1.1 is already published with other files; release a new version$"):
            self.publish("0.1.1")
        self.assertNotIn("cp", [call[1] for call in self.calls()])
        self.assertEqual(self.generations()[LIVE], 7)

    def test_a_refused_read_is_not_a_missing_manifest(self):
        self.fail_call(["describe"], "ERROR: (gcloud.storage.objects.describe) HTTPError 403: no storage.objects.get access")
        with self.assertRaisesRegex(RuntimeError, "403"):
            self.publish("0.1.0")
        self.assertNotIn("cp", [call[1] for call in self.calls()])

    def test_a_lost_race_never_overwrites(self):
        self.put("metadata.json", '{"version": "0.1.0"}', generation=7)
        self.fail_call(["--if-generation-match=7"], "ERROR: (gcloud.storage.cp) HTTPError 412: a pre-condition failed")
        notes = self.root / "notes.txt"
        notes.write_text("Harness Device 0.1.1\n")
        result = run("publish", "--version", "0.1.1", "--dir", self.build, "--notes-file", notes, "--pub-date", PUB_DATE)
        refused(self, result)
        self.assertIn("412", result.stderr)
        self.assertEqual(self.stored("metadata.json"), b'{"version": "0.1.0"}')
        self.assertEqual(self.generations()[LIVE], 7)

    def test_publish_stops_when_a_file_in_the_bucket_differs(self):
        for name in FILES:
            with self.subTest(name=name):
                self.new_cloud(f"cloud-{name}")
                self.put("metadata.json", '{"version": "0.1.0"}', generation=7)
                self.put(f"0.1.1/{name}", b"bytes of an earlier build")
                with self.assertRaisesRegex(ValueError, re.escape(name)):
                    self.publish("0.1.1")
                self.assertNotIn(("upload", LIVE), self.steps())
                self.assertEqual(self.stored("metadata.json"), b'{"version": "0.1.0"}')

    def test_a_second_run_with_the_same_files_finishes(self):
        self.put("metadata.json", '{"version": "0.1.0"}', generation=7)
        for name in FILES:
            self.put(f"0.1.1/{name}", (self.build / name).read_bytes())
        written = self.publish("0.1.1")
        self.assertEqual(json.loads(self.stored("metadata.json")), written)
        self.assertEqual(self.generations()[LIVE], 8)


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass  # the test's output stays its own


class TrickleHandler(BaseHTTPRequestHandler):
    """A 16-byte body, one byte every 0.5 s: never idle long enough for a socket timeout to fire."""

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", "16")
        self.end_headers()
        try:
            for _ in range(16):
                self.wfile.write(b"x")
                time.sleep(0.5)
        except OSError:
            pass  # the client gave up, as it should

    def log_message(self, *args):
        pass


def serve(test, handler):
    """The base URL of handler served on 127.0.0.1 until test ends."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    test.addCleanup(thread.join, 10)
    test.addCleanup(server.server_close)
    test.addCleanup(server.shutdown)
    return f"http://127.0.0.1:{server.server_address[1]}"


class FetchTests(TempTest):
    def test_a_trickling_download_stops_at_its_deadline(self):
        base = serve(self, TrickleHandler)
        start = time.monotonic()
        with self.assertRaises(TimeoutError):
            rules.fetch(f"{base}/", 100, 2)
        self.assertLess(time.monotonic() - start, 4)


class VerifyTests(TempTest):
    def setUp(self):
        super().setUp()
        self.build = make_build(self.root / "build")
        self.served = self.root / "served"
        self.base = serve(self, functools.partial(QuietHandler, directory=str(self.served)))

    def publish_copy(self, change=None):
        """Serve the build as publish leaves it, with change applied to its manifest."""
        shutil.rmtree(self.served, ignore_errors=True)
        (self.served / "0.1.0").mkdir(parents=True)
        for name in FILES:
            shutil.copyfile(self.build / name, self.served / "0.1.0" / name)
        manifest = rules.build_manifest("0.1.0", self.build, "Harness Device 0.1.0", PUB_DATE, self.base)
        if change:
            change(manifest)
        (self.served / "metadata.json").write_text(json.dumps(manifest))

    def verify(self):
        rules.verify("0.1.0", self.build, manifest_url=f"{self.base}/metadata.json", base_url=self.base, pause=0)

    def test_verify_passes_on_the_published_copy(self):
        self.publish_copy()
        self.verify()

    def test_verify_fails_on_each_difference(self):
        def outside():
            self.publish_copy(lambda manifest: manifest["dmg"].update(url=f"{self.base}/0.0.9/Harness-Device.dmg"))
            (self.served / "0.0.9").mkdir()
            shutil.copyfile(self.build / "Harness-Device.dmg", self.served / "0.0.9" / "Harness-Device.dmg")

        for difference, change in {
            "a changed dmg byte": lambda: flip(self.served / "0.1.0" / "Harness-Device.dmg"),
            "a changed archive": lambda: flip(self.served / "0.1.0" / "Harness-Device.app.tar.gz"),
            "another signature": lambda: self.publish_copy(
                lambda manifest: manifest["platforms"]["darwin-x86_64"].update(signature="b3RoZXI=")),
            "another version": lambda: self.publish_copy(lambda manifest: manifest.update(version="0.1.1")),
            "a URL outside its version's folder": outside,
        }.items():
            with self.subTest(difference):
                self.publish_copy()
                change()
                with self.assertRaises(ValueError):
                    self.verify()


if __name__ == "__main__":
    unittest.main()
