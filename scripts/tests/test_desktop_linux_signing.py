"""Run the Linux signing script with a recording minisign, and nothing else on PATH but tools that log their argv and
environment."""
import base64
import hashlib
import json
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "desktop/scripts/sign-desktop-linux.sh"
BASH = shutil.which("bash")
NAMES = ("Harness-linux-x64.AppImage", "Harness-linux-arm64.AppImage")
# The key file minisign reads, and the secret's value: Tauri keeps the key as base64 of that file's text.
SECRET_LINE = "RWRTY0IyFixtureSecretKeyLineNotARealKey"
KEY = f"untrusted comment: rsign encrypted secret key\n{SECRET_LINE}\n"
TAURI_KEY = base64.b64encode(KEY.encode()).decode()
PASSWORD = "fixture password"
MINISIG = b"untrusted comment: signature from minisign secret key\nRUQfixture\ntrusted comment: fixture\nfixture\n"
# The only tools on PATH besides minisign. Each logs its argv and environment, so a secret in either shows, and a tool
# the script starts to run fails here until it is listed.
TOOLS = ("base64", "date", "mktemp", "rm", "sha256sum", "tr")
SECRET_NAMES = ("TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD")

MINISIGN = r'''
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
key = Path(args[args.index("-s") + 1])
with open(os.environ["MINISIGN_LOG"], "a") as log:
    log.write(json.dumps({"argv": sys.argv, "stdin": sys.stdin.read(), "key": key.read_text(),
                          "key_path": str(key), "mode": key.stat().st_mode & 0o777,
                          "environment": sorted(os.environ)}) + "\n")
fail = os.environ.get("MINISIGN_FAIL")
if fail and args[args.index("-m") + 1].endswith(fail):
    sys.exit("minisign: fixture failure")
Path(args[args.index("-x") + 1]).write_bytes(MINISIG)
'''


class Release:
    """One disposable run: the folder the build handed on, RUNNER_TEMP, and a PATH of recording tools."""

    def __init__(self, case):
        temp = tempfile.TemporaryDirectory()
        case.addCleanup(temp.cleanup)
        root = Path(temp.name) / "fixture with spaces"
        self.folder = root / "release files"
        self.runner_temp = root / "runner temp"
        self.argv_log = root / "argv.log"
        self.minisign_log = root / "minisign.log"
        self.environment_log = root / "environment.log"
        tools = root / "bin"
        for folder in (self.folder, self.runner_temp, tools):
            folder.mkdir(parents=True)
        for name in NAMES:
            data = f"{name} bytes".encode()
            (self.folder / name).write_bytes(data)
            (self.folder / f"{name}.sha256").write_text(f"{hashlib.sha256(data).hexdigest()}  {name}\n")
        (tools / "minisign").write_text(f"#!{sys.executable}\nMINISIG = {MINISIG!r}\n" + MINISIGN)
        (tools / "minisign").chmod(0o755)
        for tool in TOOLS:
            real = shutil.which(tool)
            case.assertIsNotNone(real, tool)
            # export -p, the shell's own, lists what the real tool inherits, and starts no other tool.
            (tools / tool).write_text(
                f'#!/bin/sh\nprintf "%s\\n" "$0" "$@" >> "$ARGV_LOG"\nexport -p >> "$ENVIRONMENT_LOG"\n'
                f'exec {shlex.quote(real)} "$@"\n')
            (tools / tool).chmod(0o755)
        self.env = {"PATH": str(tools), "RUNNER_TEMP": str(self.runner_temp), "ARGV_LOG": str(self.argv_log),
                    "MINISIGN_LOG": str(self.minisign_log), "ENVIRONMENT_LOG": str(self.environment_log),
                    "TAURI_SIGNING_PRIVATE_KEY": TAURI_KEY,
                    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD": PASSWORD}

    def sign(self, version="1.2.3", **env):
        environment = {key: value for key, value in {**self.env, **env}.items() if value is not None}
        return subprocess.run([BASH, str(SCRIPT), version, str(self.folder)], env=environment, text=True,
                              capture_output=True, stdin=subprocess.DEVNULL, timeout=60)

    def minisign_runs(self):
        if not self.minisign_log.exists():
            return []
        return [json.loads(line) for line in self.minisign_log.read_text().splitlines()]

    def argv(self):
        logged = self.argv_log.read_text() if self.argv_log.exists() else ""
        return logged + "".join("\n".join(run["argv"]) for run in self.minisign_runs())

    def signatures(self):
        return sorted(path.name for path in self.folder.glob("*.sig"))


class LinuxSigningTests(unittest.TestCase):
    def assert_signed_nothing(self, release, result):
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(release.signatures(), [])
        self.assertEqual(list(release.runner_temp.iterdir()), [])

    def assert_refused(self, release, result, *says):
        self.assert_signed_nothing(release, result)
        self.assertEqual(release.minisign_runs(), [])
        for text in says:
            self.assertIn(text, result.stderr)

    def test_signs_both_appimages_with_a_comment_naming_the_file_and_the_desktop_version_and_no_version_field(self):
        release = Release(self)
        result = release.sign()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        runs = release.minisign_runs()
        self.assertEqual([run["argv"][run["argv"].index("-m") + 1] for run in runs],
                         [str(release.folder / name) for name in NAMES])
        for name, run in zip(NAMES, runs):
            argv = run["argv"]
            self.assertEqual(argv[1], "-S")
            fields = argv[argv.index("-t") + 1].split("\t")
            self.assertEqual(len(fields), 3, fields)
            self.assertRegex(fields[0], r"^timestamp:[0-9]+$")
            self.assertEqual(fields[1:], [f"file:{name}", "desktop-version:1.2.3"])
            # Harness Device's updater reads version:, so a Desktop signature must never carry it.
            self.assertEqual([field for field in fields if field.startswith("version:")], [])
        for name in NAMES:
            # Tauri's form, as `cargo tauri signer sign` writes it: the .minisig base64-encoded, one line, no newline.
            self.assertEqual((release.folder / f"{name}.sig").read_text(), base64.b64encode(MINISIG).decode())

    def test_the_key_and_its_password_reach_minisign_through_a_file_and_stdin_only(self):
        release = Release(self)
        result = release.sign()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        runs = release.minisign_runs()
        self.assertEqual(len(runs), 2)
        for secret in (TAURI_KEY, SECRET_LINE, PASSWORD):
            for seen in (release.argv(), result.stdout, result.stderr):
                self.assertNotIn(secret, seen)
        for run in runs:
            self.assertEqual(run["stdin"], PASSWORD + "\n")
            self.assertEqual(run["key"], KEY)
            self.assertEqual(run["mode"], 0o600)
            self.assertIn(release.runner_temp, Path(run["key_path"]).parents)
        self.assertEqual(list(release.runner_temp.iterdir()), [])

    def test_no_tool_the_script_starts_inherits_the_key_or_its_password(self):
        release = Release(self)
        result = release.sign()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        runs = release.minisign_runs()
        self.assertEqual(len(runs), 2)
        for run in runs:
            self.assertIn("MINISIGN_LOG", run["environment"])
            self.assertEqual([name for name in SECRET_NAMES if name in run["environment"]], [])
        inherited = release.environment_log.read_text()
        self.assertIn("ARGV_LOG", inherited)
        for secret in (*SECRET_NAMES, TAURI_KEY, PASSWORD):
            self.assertNotIn(secret, inherited)

    def test_an_appimage_whose_sums_do_not_match_signs_nothing(self):
        x64, arm64 = (Path(name) for name in NAMES)

        def changed_after_the_build(release):
            (release.folder / arm64).write_bytes(b"changed after the build")

        # `sha256sum --check` alone passes this one: the list checks x64 and never arm64.
        def sums_naming_another_file(release):
            shutil.copyfile(release.folder / f"{x64}.sha256", release.folder / f"{arm64}.sha256")

        def no_sums(release):
            (release.folder / f"{arm64}.sha256").unlink()

        for change in (changed_after_the_build, sums_naming_another_file, no_sums):
            with self.subTest(change.__name__):
                release = Release(self)
                change(release)
                self.assert_refused(release, release.sign(), str(arm64), "nothing was signed")

    def test_no_key_signs_nothing(self):
        for env in ({"TAURI_SIGNING_PRIVATE_KEY": None}, {"TAURI_SIGNING_PRIVATE_KEY": ""},
                    {"TAURI_SIGNING_PRIVATE_KEY_PASSWORD": None}):
            with self.subTest(env=env):
                release = Release(self)
                self.assert_refused(release, release.sign(**env), "TAURI_SIGNING_PRIVATE_KEY", "nothing was signed")

    def test_a_version_that_is_not_x_y_z_signs_nothing(self):
        # The version goes into the trusted comment: a tab in it would add a field Harness Device's updater reads.
        for version in ("1.2", "v1.2.3", "1.2.3\tversion:1.2.3"):
            with self.subTest(version=version):
                release = Release(self)
                self.assert_refused(release, release.sign(version), "usage:")

    def test_a_minisign_failure_leaves_no_key_file(self):
        release = Release(self)
        # arm64 fails after x64 signed, so a half-signed folder would show.
        result = release.sign(MINISIGN_FAIL=NAMES[1])
        self.assert_signed_nothing(release, result)
        self.assertIn("minisign: fixture failure", result.stderr)
        runs = release.minisign_runs()
        self.assertEqual(len(runs), 2)
        self.assertFalse(Path(runs[1]["key_path"]).exists())


if __name__ == "__main__":
    unittest.main()
