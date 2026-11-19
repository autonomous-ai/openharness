"""release-build.sh and release-check.sh in a temp tree, as on each OS, with a fake uname, cargo and minisign first on
PATH. The fake cargo records its arguments, names a temp target folder for `metadata` and writes the files a bundle
would. Nothing is compiled, signed, checked by Apple or Microsoft, or uploaded."""
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent
SECRETS = ("APPLE_SIGNING_IDENTITY", "APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID", "TAURI_SIGNING_PRIVATE_KEY",
           "TAURI_SIGNING_PRIVATE_KEY_PASSWORD")
MACOS = ("Darwin", "arm64")
LINUX_X64 = ("Linux", "x86_64")
LINUX_ARM64 = ("Linux", "aarch64")
# Git Bash's answer, which runs a Windows job's bash steps.
WINDOWS = ("MINGW64_NT-10.0-26100", "x86_64")

UNAME = r'''#!/bin/sh
case "$1" in
  -s) echo "$FAKE_UNAME_S" ;;
  -m) echo "$FAKE_UNAME_M" ;;
  *) exit 64 ;;
esac
'''

# Appends {"args", "secrets"} to FAKE_CARGO_LOG. `metadata` answers compact JSON, as cargo does. `tauri bundle` writes
# the files Tauri 2.12's bundler names, and, as Tauri does, refuses to make updater artifacts with no private key.
# `tauri signer sign` writes the file's .sig.
CARGO = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path

SECRETS = %r
args = sys.argv[1:]
with open(os.environ["FAKE_CARGO_LOG"], "a") as log:
    log.write(json.dumps({"args": args, "secrets": [name for name in SECRETS if name in os.environ]}) + "\n")
target = Path(os.environ["FAKE_TARGET"])

def value(flag):
    return args[args.index(flag) + 1]

if args[:1] == ["metadata"]:
    print(json.dumps({"packages": [], "target_directory": str(target), "version": 1}, separators=(",", ":")))
elif args[:2] == ["tauri", "bundle"]:
    config = {}
    for index, arg in enumerate(args):
        if arg == "--config":
            for key, item in json.loads(args[index + 1]).items():
                config[key] = {**config[key], **item} if isinstance(item, dict) and key in config else item
    version, updater = config["version"], config.get("bundle", {}).get("createUpdaterArtifacts", False)
    if updater and "TAURI_SIGNING_PRIVATE_KEY" not in os.environ:
        sys.exit("A public key has been found, but no private key.")
    triple, bundles = value("--target"), value("--bundles")
    if bundles == "app,dmg":
        files, signed = [f"dmg/Harness Device_{version}_universal.dmg"], "macos/Harness Device.app.tar.gz"
    elif bundles == "appimage":
        arch = {"x86_64-unknown-linux-gnu": "amd64", "aarch64-unknown-linux-gnu": "aarch64"}[triple]
        files, signed = [], f"appimage/Harness Device_{version}_{arch}.AppImage"
    else:
        arch = {"x86_64-pc-windows-msvc": "x64", "aarch64-pc-windows-msvc": "arm64"}[triple]
        files, signed = [], f"nsis/Harness Device_{version}_{arch}-setup.exe"
    files += [signed, signed + ".sig"] if updater else [signed]
    for name in files:
        path = target / triple / "release" / "bundle" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(name)
elif args[:3] == ["tauri", "signer", "sign"]:
    Path(args[-1] + ".sig").write_text("signed " + value("--app-version"))
''' % (SECRETS,)

# Exits 0 when the key, the signature and the file it is given all exist: the signature's bytes are not checked here.
MINISIGN = r'''#!/usr/bin/env python3
import os, sys

args = sys.argv[1:]
paths = [args[args.index(flag) + 1] for flag in ("-p", "-x", "-m")]
sys.exit(0 if args[0] == "-V" and all(os.path.isfile(path) for path in paths) else 1)
'''

PUBKEY = base64.b64encode(b"untrusted comment: minisign public key: 4739BFCC687B1F62\nRWRiH3tozL85R7Hi\n").decode()


class Fakes(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.target, self.out, self.log = self.root / "target", self.root / "out", self.root / "cargo.jsonl"
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        for name, body in (("uname", UNAME), ("cargo", CARGO), ("minisign", MINISIGN)):
            (bin_dir / name).write_text(body)
            (bin_dir / name).chmod(0o755)
        shutil.copytree(SCRIPTS, self.root / "device-app" / "scripts", ignore=shutil.ignore_patterns("__pycache__"))
        (self.root / "device-app" / "src-tauri").mkdir()
        # No signing secret or target of the machine running the tests.
        self.env = {key: value for key, value in os.environ.items() if key not in SECRETS and key != "DEVICE_TARGET"}
        self.env.update(PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}", FAKE_CARGO_LOG=str(self.log),
                        FAKE_TARGET=str(self.target), PYTHONDONTWRITEBYTECODE="1")

    def run_script(self, script, os_, *args, **env):
        return subprocess.run(["bash", str(self.root / "device-app" / "scripts" / script), *args],
                              env=dict(self.env, FAKE_UNAME_S=os_[0], FAKE_UNAME_M=os_[1], **env),
                              capture_output=True, text=True, timeout=60)

    def cargo_calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def tauri_calls(self, verb):
        return [call["args"] for call in self.cargo_calls() if call["args"][:2] == ["tauri", verb]]

    def out_files(self):
        return sorted(path.name for path in self.out.iterdir())


class ReleaseBuildTests(Fakes):
    def build(self, os_, *args, **env):
        return self.run_script("release-build.sh", os_, *args, **env)

    def test_compile_refuses_a_signing_secret_on_every_os(self):
        for os_, env in ((MACOS, {}), (LINUX_X64, {}), (WINDOWS, {"DEVICE_TARGET": "x86_64-pc-windows-msvc"})):
            for secret in ("TAURI_SIGNING_PRIVATE_KEY", "APPLE_ID"):
                with self.subTest(os=os_[0], secret=secret):
                    result = self.build(os_, "compile", "0.1.3", **env, **{secret: "x"})
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(f"compile runs with no {secret} in its environment", result.stderr)
                    self.assertEqual(self.tauri_calls("build"), [])

    def test_compile_builds_this_os_target_without_a_bundle(self):
        for os_, env, target in ((MACOS, {}, "universal-apple-darwin"),
                                 (LINUX_X64, {}, "x86_64-unknown-linux-gnu"),
                                 (LINUX_ARM64, {}, "aarch64-unknown-linux-gnu"),
                                 (WINDOWS, {"DEVICE_TARGET": "aarch64-pc-windows-msvc"}, "aarch64-pc-windows-msvc")):
            with self.subTest(target=target):
                self.log.unlink(missing_ok=True)
                result = self.build(os_, "compile", "0.1.3", **env)
                self.assertEqual(result.returncode, 0, result.stderr)
                [args] = self.tauri_calls("build")
                self.assertEqual(args[:6], ["tauri", "build", "--ci", "--no-bundle", "--target", target])
                self.assertEqual(args[-2:], ["--", "--locked"])

    def test_macos_bundles_its_three_files_as_before(self):
        result = self.build(MACOS, "bundle", "0.1.3", str(self.out), TAURI_SIGNING_PRIVATE_KEY="key")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.out_files(),
                         ["Harness-Device.app.tar.gz", "Harness-Device.app.tar.gz.sig", "Harness-Device.dmg"])
        self.assertEqual(self.tauri_calls("bundle"), [
            ["tauri", "bundle", "--ci", "--target", "universal-apple-darwin", "--bundles", "app,dmg", "--config",
             '{"version":"0.1.3","bundle":{"createUpdaterArtifacts":true}}']])

    def test_linux_bundles_an_appimage_under_its_fixed_name(self):
        for os_, arch, target in ((LINUX_X64, "x64", "x86_64-unknown-linux-gnu"),
                                  (LINUX_ARM64, "arm64", "aarch64-unknown-linux-gnu")):
            with self.subTest(arch=arch):
                self.log.unlink(missing_ok=True)
                out = self.out / arch
                result = self.build(os_, "bundle", "0.1.3", str(out), TAURI_SIGNING_PRIVATE_KEY="key")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(sorted(path.name for path in out.iterdir()),
                                 [f"Harness-Device-linux-{arch}.AppImage", f"Harness-Device-linux-{arch}.AppImage.sig"])
                self.assertEqual(self.tauri_calls("bundle"), [
                    ["tauri", "bundle", "--ci", "--target", target, "--bundles", "appimage", "--config",
                     '{"version":"0.1.3","bundle":{"createUpdaterArtifacts":true}}']])

    def test_windows_bundles_an_installer_and_no_signature(self):
        for arch, target in (("x64", "x86_64-pc-windows-msvc"), ("arm64", "aarch64-pc-windows-msvc")):
            with self.subTest(arch=arch):
                self.log.unlink(missing_ok=True)
                out = self.out / arch
                # No updater key, as in the job that holds the signing identity: the fake fails as Tauri does if the
                # bundle asks for an update signature.
                result = self.build(WINDOWS, "bundle", "0.1.3", str(out), DEVICE_TARGET=target)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(sorted(path.name for path in out.iterdir()),
                                 [f"Harness-Device-windows-{arch}-setup.exe"])
                [args] = self.tauri_calls("bundle")
                self.assertEqual(args[:7], ["tauri", "bundle", "--ci", "--target", target, "--bundles", "nsis"])
                self.assertNotIn('"createUpdaterArtifacts":true', " ".join(args))

    def test_windows_bundles_the_signed_exe_unpatched(self):
        # Tauri writes the bundle type into the exe it packs, which breaks the Authenticode signature it already has.
        result = self.build(WINDOWS, "bundle", "0.1.3", str(self.out), DEVICE_TARGET="x86_64-pc-windows-msvc")
        self.assertEqual(result.returncode, 0, result.stderr)
        [args] = self.tauri_calls("bundle")
        self.assertIn("--no-binary-patching", args)

    def test_windows_needs_its_target_named(self):
        for step, args in (("compile", ()), ("bundle", (str(self.out),))):
            with self.subTest(step=step):
                result = self.build(WINDOWS, step, "0.1.3", *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("DEVICE_TARGET", result.stderr)
                self.assertEqual(self.tauri_calls(step), [])

    def test_sign_update_binds_the_version(self):
        self.out.mkdir()
        installers = [self.out / f"Harness-Device-windows-{arch}-setup.exe" for arch in ("arm64", "x64")]
        for installer in installers:
            installer.write_text("signed by Authenticode")
        result = self.build(WINDOWS, "sign-update", "0.1.3", str(self.out), TAURI_SIGNING_PRIVATE_KEY="key")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sorted(self.tauri_calls("signer")),
                         [["tauri", "signer", "sign", "--app-version", "0.1.3", str(path)] for path in installers])
        self.assertEqual(self.out_files(),
                         sorted(name for path in installers for name in (path.name, path.name + ".sig")))

    def test_sign_update_stops_with_no_installer_and_off_windows(self):
        self.out.mkdir()
        result = self.build(WINDOWS, "sign-update", "0.1.3", str(self.out), TAURI_SIGNING_PRIVATE_KEY="key")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("release-build: OUT_DIR holds no installer", result.stderr)
        # macOS and Linux sign their update files in bundle.
        (self.out / "Harness-Device-windows-x64-setup.exe").write_text("MZ")
        for os_ in (MACOS, LINUX_X64):
            with self.subTest(os=os_[0]):
                result = self.build(os_, "sign-update", "0.1.3", str(self.out), TAURI_SIGNING_PRIVATE_KEY="key")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("release-build: ", result.stderr)
        self.assertEqual(self.tauri_calls("signer"), [])

    def test_an_unknown_os_or_target_stops(self):
        for os_, env in ((("FreeBSD", "amd64"), {}),
                         (("Linux", "riscv64"), {}),
                         (LINUX_X64, {"DEVICE_TARGET": "aarch64-unknown-linux-gnu"}),
                         (MACOS, {"DEVICE_TARGET": "aarch64-apple-darwin"}),
                         (WINDOWS, {"DEVICE_TARGET": "i686-pc-windows-msvc"}),
                         (WINDOWS, {"DEVICE_TARGET": "x86_64-unknown-linux-gnu"})):
            # The updater key only where the step takes it: compile would refuse it before looking at the target.
            for step, args, key in (("compile", (), {}),
                                    ("bundle", (str(self.out),), {"TAURI_SIGNING_PRIVATE_KEY": "key"})):
                with self.subTest(os=os_, env=env, step=step):
                    result = self.build(os_, step, "0.1.3", *args, **env, **key)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("release-build: ", result.stderr)
                    self.assertEqual(self.tauri_calls(step), [])


def signature(name, version):
    """A .sig as Tauri writes it: minisign's signature file, base64-wrapped."""
    text = (f"untrusted comment: signature from tauri secret key\nRUR=\n"
            f"trusted comment: timestamp:1763600000\tfile:{name}\tversion:{version}\nAAAA\n")
    return base64.b64encode(text.encode()).decode()


def elf(machine):
    """An ELF file's first 64 bytes: the magic, 64-bit little-endian, an executable, then e_machine."""
    return b"\x7fELF\x02\x01\x01" + bytes(9) + b"\x02\x00" + machine.to_bytes(2, "little") + bytes(44)


class ReleaseCheckTests(Fakes):
    def check(self, os_, *flag):
        return self.run_script("release-check.sh", os_, str(self.out), "0.1.3", PUBKEY, *flag)

    def appimage(self, arch, machine, version="0.1.3"):
        self.out.mkdir(exist_ok=True)
        name = f"Harness-Device-linux-{arch}.AppImage"
        (self.out / name).write_bytes(elf(machine))
        (self.out / f"{name}.sig").write_text(signature(name, version))

    def installer(self, arch, version="0.1.3"):
        self.out.mkdir(exist_ok=True)
        name = f"Harness-Device-windows-{arch}-setup.exe"
        (self.out / name).write_text("MZ")
        (self.out / f"{name}.sig").write_text(signature(name, version))

    def test_linux_checks_its_archs_appimage_and_the_signed_version(self):
        for os_, arch, machine in ((LINUX_X64, "x64", 62), (LINUX_ARM64, "arm64", 183)):
            with self.subTest(arch=arch):
                shutil.rmtree(self.out, ignore_errors=True)
                self.appimage(arch, machine)
                result = self.check(os_)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(result.stdout.splitlines(), [
                    "ok: the AppImage and its update signature",
                    f"ok: the AppImage is {os_[1]}",
                    "ok: the AppImage's update signature",
                    "ok: the update signature is for 0.1.3"])

    def test_linux_fails_another_archs_appimage(self):
        self.appimage("arm64", 62)
        result = self.check(LINUX_ARM64)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout.splitlines()[-1], "FAILED: the AppImage is aarch64")

    def test_linux_fails_a_signature_for_another_version(self):
        self.appimage("x64", 62, version="0.1.2")
        result = self.check(LINUX_X64)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout.splitlines()[-1], "FAILED: the update signature is for 0.1.3")

    def test_windows_checks_each_installers_signed_version(self):
        self.installer("arm64")
        self.installer("x64")
        result = self.check(WINDOWS)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout.splitlines(), [
            "ok: an installer",
            "ok: Harness-Device-windows-arm64-setup.exe's update signature",
            "ok: Harness-Device-windows-arm64-setup.exe's update signature is for 0.1.3",
            "ok: Harness-Device-windows-x64-setup.exe's update signature",
            "ok: Harness-Device-windows-x64-setup.exe's update signature is for 0.1.3"])

        self.installer("x64", version="0.1.2")
        result = self.check(WINDOWS)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout.splitlines()[-1],
                         "FAILED: Harness-Device-windows-x64-setup.exe's update signature is for 0.1.3")

    def test_windows_fails_with_no_installer(self):
        self.out.mkdir()
        result = self.check(WINDOWS)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout.splitlines(), ["FAILED: an installer"])

    def test_a_flag_of_another_os_is_a_usage_error(self):
        self.appimage("x64", 62)
        for os_, flag in ((LINUX_X64, "--notarized"), (LINUX_X64, "--signed"), (WINDOWS, "--notarized"),
                          (MACOS, "--signed")):
            with self.subTest(os=os_[0], flag=flag):
                result = self.check(os_, flag)
                self.assertEqual(result.returncode, 2)
                self.assertIn("usage: release-check.sh", result.stderr)
                self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
