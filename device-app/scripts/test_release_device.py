"""release-device.sh against a temp repository and a bare origin beside it, with a fake curl and a fake gh first on
PATH. Nothing reaches GitHub, a bucket or the network, and no workflow starts."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent
# Written out here so a change to the script's URL fails a test.
MANIFEST_URL = "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/metadata.json"
SETTINGS = {"user.name": "Fixture", "user.email": "fixture@example.test", "maintenance.auto": "false"}
GIT = ["git", *(arg for key, value in SETTINGS.items() for arg in ("-c", f"{key}={value}"))]
DISPATCH = ["workflow", "run", "release-device.yml"]

# The live manifest: prints the file FAKE_MANIFEST names when asked for the manifest's URL, else exits 22 as curl -f
# does on an HTTP error.
CURL = rf'''#!/usr/bin/env python3
import os, sys
from pathlib import Path

manifest = Path(os.environ["FAKE_MANIFEST"])
if "{MANIFEST_URL}" not in sys.argv[1:] or not manifest.exists():
    sys.exit(22)
sys.stdout.write(manifest.read_text())
'''

# Appends its arguments to FAKE_GH_LOG as a JSON line, exits 1 when FAKE_GH_FAIL is set, and lists an older run, its
# clock ahead, and, once a run was started, the new one, its clock 10 s behind: --wait must follow the new one by its
# id, not by a clock.
GH = r'''#!/usr/bin/env python3
from datetime import datetime, timedelta, timezone
import json, os, sys

args = sys.argv[1:]
with open(os.environ["FAKE_GH_LOG"], "a+") as log:
    log.seek(0)
    started = any(json.loads(line)[:2] == ["workflow", "run"] for line in log)
    log.write(json.dumps(args) + "\n")
if os.environ.get("FAKE_GH_FAIL"):
    sys.exit("HTTP 401: Bad credentials")
if args[:2] == ["run", "list"]:
    runs = [{"databaseId": 1111, "createdAt": "2999-01-01T00:00:00Z"}]
    if started:
        behind = datetime.now(timezone.utc) - timedelta(seconds=10)
        runs.append({"databaseId": 4242, "createdAt": behind.strftime("%Y-%m-%dT%H:%M:%SZ")})
    print(json.dumps(runs))
'''


class ReleaseDeviceTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.repo, self.origin, bin_dir = self.root / "repo", self.root / "origin.git", self.root / "bin"
        self.gh_log, self.manifest = self.root / "gh.jsonl", self.root / "metadata.json"
        self.repo.mkdir()
        bin_dir.mkdir()
        for name, body in (("curl", CURL), ("gh", GH)):
            (bin_dir / name).write_text(body)
            (bin_dir / name).chmod(0o755)
        # No Git setting of this machine's (signing, hooks), and the fixture's settings for the script's own Git calls,
        # which take no -c.
        self.env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        self.env.update(PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}", FAKE_GH_LOG=str(self.gh_log),
                        FAKE_MANIFEST=str(self.manifest), PYTHONDONTWRITEBYTECODE="1", GIT_CONFIG_GLOBAL=os.devnull,
                        GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_COUNT=str(len(SETTINGS)))
        for index, (key, value) in enumerate(SETTINGS.items()):
            self.env.update({f"GIT_CONFIG_KEY_{index}": key, f"GIT_CONFIG_VALUE_{index}": value})
        self.git("init", "-q", "-b", "main")
        shutil.copytree(SCRIPTS, self.repo / "device-app" / "scripts", ignore=shutil.ignore_patterns("__pycache__"))
        self.git("add", ".")
        self.git("commit", "-qm", "first change")
        self.git("tag", "-a", "v0.1.0_device", "-m", "Harness Device 0.1.0")
        self.commit("device-app/change.txt", "newer change")
        self.git("init", "-q", "--bare", str(self.origin))
        self.git("remote", "add", "origin", str(self.origin))
        self.git("push", "-q", "origin", "main", "--tags")
        self.live("0.1.0")

    def git(self, *args):
        return subprocess.check_output([*GIT, *args], cwd=self.repo, env=self.env, stderr=subprocess.PIPE, text=True,
                                       timeout=30).strip()

    def commit(self, path, message):
        """A commit that changes path: the notes list only the commits that change device-app."""
        (self.repo / path).parent.mkdir(parents=True, exist_ok=True)
        (self.repo / path).write_text(message)
        self.git("add", path)
        self.git("commit", "-qm", message)

    def live(self, version):
        self.manifest.write_text(json.dumps({"version": version}))

    def run_script(self, *args, fail_gh=False):
        env = dict(self.env, FAKE_GH_FAIL="1") if fail_gh else self.env
        return subprocess.run(["bash", str(self.repo / "device-app" / "scripts" / "release-device.sh"), *args],
                              cwd=self.repo, env=env, capture_output=True, text=True, timeout=60)

    def gh_calls(self):
        return [json.loads(line) for line in self.gh_log.read_text().splitlines()] if self.gh_log.exists() else []

    def tags(self, repo):
        return self.git("-C", str(repo), "tag", "-l").split()

    def message(self, tag):
        return self.git("-C", str(self.origin), "tag", "-l", "--format=%(contents)", tag)

    def test_a_release_tags_pushes_and_starts_the_run_on_the_tag(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git("-C", str(self.origin), "cat-file", "-t", "v0.1.1_device"), "tag")
        self.assertEqual(self.git("-C", str(self.origin), "rev-parse", "v0.1.1_device^{commit}"),
                         self.git("rev-parse", "HEAD"))
        message = self.message("v0.1.1_device")
        self.assertTrue(message.startswith("Harness Device 0.1.1\n\n"), message)
        self.assertIn("- newer change", message)
        self.assertNotIn("first change", message)
        self.assertEqual(self.gh_calls(), [[*DISPATCH, "--ref", "v0.1.1_device", "-f", "version=0.1.1",
                                            "-f", "publish=true"]])

    def test_a_signing_setting_puts_no_signature_in_the_notes(self):
        # Signs anything: a signature block on stdout, gpg's status line on the status fd Git passes (2).
        gpg = self.root / "gpg"
        gpg.write_text("#!/bin/sh\ncat >/dev/null\nprintf -- '-----BEGIN PGP SIGNATURE-----\\nZmFrZQ==\\n"
                       "-----END PGP SIGNATURE-----\\n'\nprintf '\\n[GNUPG:] SIG_CREATED D 1 8 00 0 FAKE\\n' >&2\n")
        gpg.chmod(0o755)
        count = len(SETTINGS)
        for index, (key, value) in enumerate((("tag.gpgSign", "true"), ("gpg.program", str(gpg))), count):
            self.env.update({f"GIT_CONFIG_KEY_{index}": key, f"GIT_CONFIG_VALUE_{index}": value})
        self.env["GIT_CONFIG_COUNT"] = str(count + 2)
        # The fake signs: a tag cut with these settings carries its block.
        self.git("tag", "-a", "signed", "-m", "signed")
        self.assertIn("BEGIN PGP SIGNATURE", self.git("tag", "-l", "--format=%(contents)", "signed"))
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("PGP SIGNATURE", self.message("v0.1.1_device"))

    def test_the_notes_list_only_the_device_apps_commits(self):
        self.commit("another-app/change.txt", "another app's change")
        self.git("push", "-q", "origin", "main")
        result = self.run_script("--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("- newer change", result.stdout)
        self.assertNotIn("another app's change", result.stdout)
        # The first release, with no tag to start from.
        self.git("tag", "-d", "v0.1.0_device")
        self.git("push", "-q", "origin", ":refs/tags/v0.1.0_device")
        self.manifest.unlink()
        result = self.run_script("--dry-run", "0.1.0", "--allow-no-manifest")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("- first change", result.stdout)
        self.assertNotIn("another app's change", result.stdout)

    def test_a_dry_run_tags_pushes_and_starts_nothing(self):
        result = self.run_script("--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("0.1.1", result.stdout)
        self.assertIn("- newer change", result.stdout)
        self.assertIn("gh workflow run release-device.yml --ref v0.1.1_device -f version=0.1.1 -f publish=true",
                      result.stdout)
        self.assertEqual(self.tags(self.repo), ["v0.1.0_device"])
        self.assertEqual(self.tags(self.origin), ["v0.1.0_device"])
        self.assertFalse(self.gh_log.exists())

    def test_prepare_starts_main_without_a_tag(self):
        result = self.run_script("--prepare")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.gh_calls(), [[*DISPATCH, "--ref", "main", "-f", "version=0.1.1", "-f", "publish=false"]])
        self.assertEqual(self.tags(self.repo), ["v0.1.0_device"])
        self.assertEqual(self.tags(self.origin), ["v0.1.0_device"])

    def test_prepare_runs_only_at_origin_mains_tip(self):
        self.git("checkout", "-q", "--detach", "HEAD~1")
        result = self.run_script("--prepare")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("origin/main's tip", result.stderr)
        self.git("checkout", "-q", "-b", "feature", "main")
        self.git("commit", "--allow-empty", "-qm", "unreviewed change")
        self.git("push", "-q", "origin", "feature")
        result = self.run_script("--prepare")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("not on origin/main", result.stderr)
        self.assertFalse(self.gh_log.exists())

    def test_refuses_dirty_unpushed_and_existing(self):
        (self.repo / "untracked.txt").write_text("not committed")
        result = self.run_script()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("dirty", result.stderr)
        (self.repo / "untracked.txt").unlink()
        self.git("commit", "--allow-empty", "-qm", "not pushed")
        result = self.run_script()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("not on origin/main", result.stderr)
        self.git("reset", "-q", "--hard", "HEAD~1")
        # Above the live version, so only the existing tag refuses it.
        self.live("0.0.9")
        result = self.run_script("0.1.0")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("v0.1.0_device exists", result.stderr)
        self.assertEqual(self.tags(self.origin), ["v0.1.0_device"])
        self.assertFalse(self.gh_log.exists())

    def test_refuses_code_older_than_the_last_release(self):
        # The last tag was cut on the newer commit; this checkout is one behind it, still on origin/main, and holds
        # the live version's tag.
        self.git("tag", "-a", "v0.1.1_device", "-m", "Harness Device 0.1.1")
        self.git("push", "-q", "origin", "v0.1.1_device")
        self.git("reset", "-q", "--hard", "HEAD~1")
        result = self.run_script()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("does not contain v0.1.1_device", result.stderr)
        result = self.run_script("--allow-older", "--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("0.1.2", result.stdout)
        # Now 0.1.1 is live, and the highest tag, held here, never went live.
        self.live("0.1.1")
        self.git("tag", "-a", "v0.1.2_device", "-m", "Harness Device 0.1.2")
        self.git("push", "-q", "origin", "v0.1.2_device")
        result = self.run_script()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("does not contain v0.1.1_device", result.stderr)
        self.assertEqual(self.tags(self.origin), ["v0.1.0_device", "v0.1.1_device", "v0.1.2_device"])
        self.assertFalse(self.gh_log.exists())

    def test_an_unreadable_manifest_stops_unless_it_is_the_first_release(self):
        self.manifest.unlink()
        result = self.run_script()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn(MANIFEST_URL, result.stderr)
        # The first release: no tag anywhere yet.
        self.git("tag", "-d", "v0.1.0_device")
        self.git("push", "-q", "origin", ":refs/tags/v0.1.0_device")
        result = self.run_script("--prepare", "0.1.0", "--allow-no-manifest")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.gh_calls(), [[*DISPATCH, "--ref", "main", "-f", "version=0.1.0", "-f", "publish=false"]])
        self.assertEqual(self.tags(self.repo) + self.tags(self.origin), [])
        result = self.run_script("0.1.0", "--allow-no-manifest")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.tags(self.origin), ["v0.1.0_device"])
        self.assertEqual(self.gh_calls()[-1], [*DISPATCH, "--ref", "v0.1.0_device", "-f", "version=0.1.0",
                                               "-f", "publish=true"])
        result = self.run_script("0.1.1", "--allow-no-manifest")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("v0.1.0_device", result.stderr)
        self.assertEqual(self.tags(self.origin), ["v0.1.0_device"])

    def test_a_refused_push_leaves_no_tag_and_a_rerun_releases(self):
        hook = self.origin / "hooks" / "pre-receive"
        hook.write_text("#!/bin/sh\nexit 1\n")
        hook.chmod(0o755)
        result = self.run_script()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("could not push v0.1.1_device", result.stderr)
        self.assertEqual(self.tags(self.repo), ["v0.1.0_device"])
        self.assertFalse(self.gh_log.exists())
        hook.unlink()
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.tags(self.origin), ["v0.1.0_device", "v0.1.1_device"])

    def test_a_dispatch_that_fails_after_the_push_says_what_to_run(self):
        result = self.run_script(fail_gh=True)
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("gh workflow run release-device.yml --ref v0.1.1_device -f version=0.1.1 -f publish=true",
                      result.stderr)
        self.assertIn("v0.1.1_device", self.tags(self.origin))
        self.assertIn("v0.1.1_device", self.tags(self.repo))
        # The other way out the message names: a second run releases the next version.
        self.assertIn("or run make release-device again to release the next version", result.stderr)
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.gh_calls()[-1], [*DISPATCH, "--ref", "v0.1.2_device", "-f", "version=0.1.2",
                                               "-f", "publish=true"])

    def test_wait_follows_the_run_it_started(self):
        head = self.git("rev-parse", "HEAD")
        for args, dispatch, run_filter in (
                (["--wait"], ["--ref", "v0.1.1_device", "-f", "version=0.1.1", "-f", "publish=true"],
                 ["--commit", head]),
                (["--prepare", "--wait"], ["--ref", "main", "-f", "version=0.1.2", "-f", "publish=false"],
                 ["--branch", "main"])):
            with self.subTest(args=args):
                self.gh_log.unlink(missing_ok=True)
                result = self.run_script(*args)
                self.assertEqual(result.returncode, 0, result.stderr)
                # The runs listed before the start, then the one that was not listed.
                runs = ["run", "list", "--workflow", "release-device.yml", "--event", "workflow_dispatch",
                        "--json", "databaseId", *run_filter]
                self.assertEqual(self.gh_calls(), [runs, [*DISPATCH, *dispatch], runs,
                                                   ["run", "watch", "4242", "--exit-status"]])

    def test_the_notes_file_is_the_tag_message(self):
        # Outside the repository, so the tree stays clean; a "#" line stays, as the tag is written verbatim.
        notes = self.root / "notes.md"
        notes.write_text("Harness Device 0.1.1\n\n# Highlights\n- Hand-written.\n")
        result = self.run_script("--notes-file", str(notes))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.message("v0.1.1_device"), "Harness Device 0.1.1\n\n# Highlights\n- Hand-written.")
        notes.write_text("\n \n")
        result = self.run_script("--notes-file", str(notes))
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("notes", result.stderr)
        self.assertNotIn("v0.1.2_device", self.tags(self.origin))

    def test_an_unknown_flag_stops(self):
        result = self.run_script("--publish")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("--publish", result.stderr)
        self.assertFalse(self.gh_log.exists())


if __name__ == "__main__":
    unittest.main()
