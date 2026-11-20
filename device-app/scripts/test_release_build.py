"""release-build.sh, release-check.sh and release-setup.sh in a temp tree, as on each OS, with a fake uname, cargo and
minisign first on PATH, and fakes of the installers release-setup.sh runs. The fake cargo records its arguments, names a
temp target folder for `metadata` and writes the files a bundle would. Nothing is compiled, signed, checked by Apple or
Microsoft, installed, downloaded or uploaded."""
import base64
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent
SECRETS = ("APPLE_SIGNING_IDENTITY", "APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID", "APPLE_API_KEY", "APPLE_API_ISSUER",
           "APPLE_API_KEY_PATH", "APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "TAURI_SIGNING_PRIVATE_KEY",
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
# `tauri signer sign` writes the file's .sig. `tauri --version` answers FAKE_TAURI_CLI, and fails without it, as cargo
# does with no Tauri CLI installed. A CLI FAKE_TAURI_CLI names is one CI's cache restored, without cargo's record of
# it, so `install` refuses to overwrite it unless forced, as cargo does.
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

if args == ["tauri", "--version"]:
    if "FAKE_TAURI_CLI" not in os.environ:
        sys.exit("error: no such command: `tauri`")
    print(os.environ["FAKE_TAURI_CLI"])
elif args[:1] == ["install"] and "FAKE_TAURI_CLI" in os.environ and "--force" not in args:
    sys.exit("error: binary `cargo-tauri` already exists in destination\nAdd --force to overwrite")
elif args[:1] == ["metadata"]:
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
        self.env = {key: value for key, value in os.environ.items()
                    if key not in SECRETS and key not in ("DEVICE_TARGET", "FAKE_TAURI_CLI")}
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
            for secret in SECRETS:
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

    def test_linux_bundles_an_appimage_and_no_signature(self):
        # Tauri's AppImage bundler downloads and runs linuxdeploy and its plugins unpinned, so the updater key is not
        # in its environment: sign-update writes the signature next.
        for os_, arch, target in ((LINUX_X64, "x64", "x86_64-unknown-linux-gnu"),
                                  (LINUX_ARM64, "arm64", "aarch64-unknown-linux-gnu")):
            with self.subTest(arch=arch):
                self.log.unlink(missing_ok=True)
                out = self.out / arch
                result = self.build(os_, "bundle", "0.1.3", str(out))
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(sorted(path.name for path in out.iterdir()), [f"Harness-Device-linux-{arch}.AppImage"])
                self.assertEqual(self.tauri_calls("bundle"), [
                    ["tauri", "bundle", "--ci", "--target", target, "--bundles", "appimage", "--config",
                     '{"version":"0.1.3","bundle":{"createUpdaterArtifacts":false}}']])

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
        for os_, names in ((WINDOWS, [f"Harness-Device-windows-{arch}-setup.exe" for arch in ("arm64", "x64")]),
                           (LINUX_X64, ["Harness-Device-linux-x64.AppImage"])):
            with self.subTest(os=os_[0]):
                self.log.unlink(missing_ok=True)
                shutil.rmtree(self.out, ignore_errors=True)
                self.out.mkdir()
                files = [self.out / name for name in names]
                for path in files:
                    path.write_text("the bytes that ship")
                result = self.build(os_, "sign-update", "0.1.3", str(self.out), TAURI_SIGNING_PRIVATE_KEY="key")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(sorted(self.tauri_calls("signer")),
                                 [["tauri", "signer", "sign", "--app-version", "0.1.3", str(path)] for path in files])
                self.assertEqual(self.out_files(),
                                 sorted(name for path in files for name in (path.name, path.name + ".sig")))

    def test_sign_update_stops_with_nothing_to_sign_and_on_macos(self):
        self.out.mkdir()
        for os_, kind in ((WINDOWS, "installer"), (LINUX_X64, "AppImage")):
            with self.subTest(os=os_[0]):
                result = self.build(os_, "sign-update", "0.1.3", str(self.out), TAURI_SIGNING_PRIVATE_KEY="key")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f"release-build: OUT_DIR holds no {kind}", result.stderr)
        # macOS signs its update archive in bundle.
        (self.out / "Harness-Device.app.tar.gz").write_text("archive")
        result = self.build(MACOS, "sign-update", "0.1.3", str(self.out), TAURI_SIGNING_PRIVATE_KEY="key")
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


# Windows' own tools, for --signed: a file the tests write is JSON, {"signed": bool, "version": "X.Y.Z"}, and an
# installer also holds the "app" NSIS packed. pwsh answers Get-AuthenticodeSignature (SIGNED_FILE) and the version
# resource's ProductVersion (APP_FILE against APP_VERSION) from it. 7z appends its arguments to FAKE_7Z_LOG and, as
# `7z e`, writes the installer's app into its -o folder.
PWSH = r'''#!/usr/bin/env python3
import json, os, sys
command = sys.argv[-1]
if "Get-AuthenticodeSignature" in command:
    sys.exit(0 if json.load(open(os.environ["SIGNED_FILE"])).get("signed") else 1)
if "ProductVersion" in command:
    sys.exit(0 if json.load(open(os.environ["APP_FILE"])).get("version") == os.environ["APP_VERSION"] else 1)
sys.exit(64)
'''

SEVEN_ZIP = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
with open(os.environ["FAKE_7Z_LOG"], "a") as log:
    log.write(json.dumps(args) + "\n")
out = Path(next(arg[2:] for arg in args if arg.startswith("-o")))
archive, name = [arg for arg in args[1:] if not arg.startswith("-")]
app = json.loads(Path(archive).read_text()).get("app")
out.mkdir(parents=True, exist_ok=True)
if app is not None and name == "harness-device.exe":
    (out / name).write_text(json.dumps(app))
'''


def elf(machine, interp=False):
    """An ELF file's header and program headers, as the AppImage's runtime begins: the magic, 64-bit little-endian, a
    position-independent executable, e_machine, then a PT_LOAD; with interp a PT_INTERP before it, as a runtime linked
    dynamically (the one that needs libfuse2) has."""
    types = ([3] if interp else []) + [1]
    header = b"\x7fELF\x02\x01\x01" + bytes(9) + struct.pack("<HHIQQQIHHHHHH", 3, machine, 1, 0, 64, 0, 0, 64, 56,
                                                             len(types), 0, 0, 0)
    return header + b"".join(struct.pack("<II", kind, 0) + bytes(48) for kind in types)


class ReleaseCheckTests(Fakes):
    def setUp(self):
        super().setUp()
        bin_dir = self.root / "bin"
        for name, body in (("pwsh", PWSH), ("7z", SEVEN_ZIP),
                           ("cygpath", '#!/bin/sh\nfor last; do :; done\necho "$last"\n')):
            (bin_dir / name).write_text(body)
            (bin_dir / name).chmod(0o755)
        self.seven_zip_log = self.root / "7z.jsonl"
        self.env["FAKE_7Z_LOG"] = str(self.seven_zip_log)

    def check(self, os_, *flag):
        return self.run_script("release-check.sh", os_, str(self.out), "0.1.3", PUBKEY, *flag)

    def appimage(self, arch, machine, version="0.1.3", interp=False):
        self.out.mkdir(exist_ok=True)
        name = f"Harness-Device-linux-{arch}.AppImage"
        (self.out / name).write_bytes(elf(machine, interp))
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
                    "ok: the AppImage's runtime is static: it needs no libfuse2",
                    "ok: the AppImage's update signature",
                    "ok: the update signature is for 0.1.3"])

    def test_linux_fails_a_runtime_that_needs_libfuse2(self):
        # Tauri's bundler takes the runtime from upstream unpinned: one linked dynamically would not start on an
        # Ubuntu without libfuse2.
        self.appimage("x64", 62, interp=True)
        result = self.check(LINUX_X64)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout.splitlines()[-1], "FAILED: the AppImage's runtime is static: it needs no libfuse2")

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

    def signed_installer(self, arch, app=None):
        """An installer Authenticode signed, packing app: by default this release's exe, signed."""
        self.installer(arch)
        name = f"Harness-Device-windows-{arch}-setup.exe"
        packed = {"signed": True, "version": "0.1.3"} if app is None else app
        (self.out / name).write_text(json.dumps({"signed": True, **({"app": packed} if packed else {})}))
        return self.out / name

    def test_windows_signed_checks_the_app_each_installer_packs(self):
        # --no-binary-patching exists so the exe keeps the signature it had before NSIS packed it; Smart App Control
        # blocks it otherwise.
        installers = [self.signed_installer(arch) for arch in ("arm64", "x64")]
        result = self.check(WINDOWS, "--signed")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        expected = ["ok: an installer"]
        for installer in installers:
            name = installer.name
            expected += [f"ok: {name}'s update signature", f"ok: {name}'s update signature is for 0.1.3",
                         f"ok: {name}'s Authenticode signature", f"ok: {name} packs harness-device.exe",
                         f"ok: the harness-device.exe in {name} keeps its Authenticode signature",
                         f"ok: the harness-device.exe in {name} is 0.1.3"]
        self.assertEqual(result.stdout.splitlines(), expected)
        calls = [json.loads(line) for line in self.seven_zip_log.read_text().splitlines()]
        self.assertEqual([(call[0], call[-2], call[-1]) for call in calls],
                         [("e", str(installer), "harness-device.exe") for installer in installers])

    def test_windows_signed_fails_an_app_unsigned_at_another_version_or_missing(self):
        name = "Harness-Device-windows-x64-setup.exe"
        for app, failed in (({"signed": False, "version": "0.1.3"},
                             f"the harness-device.exe in {name} keeps its Authenticode signature"),
                            ({"signed": True, "version": "0.1.2"}, f"the harness-device.exe in {name} is 0.1.3"),
                            ({}, f"{name} packs harness-device.exe")):
            with self.subTest(app=app):
                shutil.rmtree(self.out, ignore_errors=True)
                self.signed_installer("x64", app)
                result = self.check(WINDOWS, "--signed")
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout.splitlines()[-1], f"FAILED: {failed}")

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


# Appends {"cmd", "args"} to FAKE_SETUP_LOG.
RECORD = r'''#!/usr/bin/env python3
import json, os, sys
with open(os.environ["FAKE_SETUP_LOG"], "a") as log:
    log.write(json.dumps({"cmd": os.path.basename(sys.argv[0]), "args": sys.argv[1:]}) + "\n")
'''

# Records the URL, then writes to -o a file of the asset's layout: minisign's Linux tarball holds
# minisign-linux/<arch>/minisign.
CURL = RECORD + r'''
import io, tarfile
url, out = sys.argv[-1], sys.argv[sys.argv.index("-o") + 1]
if url.endswith(".tar.gz"):
    with tarfile.open(out, "w:gz") as tar:
        for arch in ("x86_64", "aarch64"):
            info = tarfile.TarInfo(f"minisign-linux/{arch}/minisign")
            info.size, info.mode = 2, 0o755
            tar.addfile(info, io.BytesIO(b"#!"))
else:
    open(out, "w").write("PK")
'''

# Answers FAKE_ASSET_SHA256 as the hash of what it reads. Git Bash's sha256sum marks its input binary: "<hash> *-".
SHA256SUM = r'''#!/usr/bin/env python3
import os, sys
binary = os.environ["FAKE_UNAME_S"].startswith("MINGW")
print(os.environ["FAKE_ASSET_SHA256"] + (" *" if binary else "  ") + (sys.argv[-1] if sys.argv[1:] else "-"))
'''

MINISIGN_RELEASE = "https://github.com/jedisct1/minisign/releases/download/0.12/"
LINUX_MINISIGN = (MINISIGN_RELEASE + "minisign-0.12-linux.tar.gz",
                  "9a599b48ba6eb7b1e80f12f36b94ceca7c00b7a5173c95c3efc88d9822957e73")
WINDOWS_MINISIGN = (MINISIGN_RELEASE + "minisign-0.12-win64.zip",
                    "37b600344e20c19314b2e82813db2bfdcc408b77b876f7727889dbd46d539479")
# Forced: a CLI CI's cache restored at another version has no cargo record, and cargo refuses to overwrite it.
INSTALL_TAURI_CLI = ["install", "tauri-cli", "--version", "2.12.4", "--locked", "--force"]


class ReleaseSetupTests(Fakes):
    def setUp(self):
        super().setUp()
        bin_dir = self.root / "bin"
        for name, body in (("rustup", RECORD), ("npm", RECORD), ("brew", RECORD), ("apt-get", RECORD),
                           ("pwsh", RECORD), ("curl", CURL), ("sha256sum", SHA256SUM),
                           ("sudo", '#!/bin/sh\nexec "$@"\n'),
                           ("cygpath", '#!/bin/sh\nfor last; do :; done\necho "$last"\n')):
            (bin_dir / name).write_text(body)
            (bin_dir / name).chmod(0o755)
        (self.root / "device-app" / "ui").mkdir()
        # PR CI's apt installer, at the repository's root: one line of its arguments a run.
        self.apt_install_log = self.root / "apt-install.log"
        (self.root / "scripts").mkdir()
        (self.root / "scripts" / "apt-install.sh").write_text(f'echo "$*" >>"{self.apt_install_log}"\n')
        self.setup_log, self.github_path = self.root / "setup.jsonl", self.root / "github-path"
        self.runner_temp = self.root / "runner-temp"
        self.runner_temp.mkdir()

    def setup(self, os_, sha256, *mode, **env):
        return self.run_script("release-setup.sh", os_, *mode, GITHUB_ACTIONS="true",
                               FAKE_SETUP_LOG=str(self.setup_log), GITHUB_PATH=str(self.github_path),
                               RUNNER_TEMP=str(self.runner_temp), FAKE_ASSET_SHA256=sha256, **env)

    def cargo_installs(self):
        return [call["args"] for call in self.cargo_calls() if call["args"][:1] == ["install"]]

    def calls(self, cmd):
        lines = self.setup_log.read_text().splitlines() if self.setup_log.exists() else []
        return [call["args"] for call in map(json.loads, lines) if call["cmd"] == cmd]

    def apt_installs(self):
        return self.apt_install_log.read_text().splitlines() if self.apt_install_log.exists() else []

    def test_linux_and_windows_install_minisigns_own_pinned_release(self):
        tools = self.runner_temp / "minisign"
        for os_, (url, sha256), folder in ((LINUX_X64, LINUX_MINISIGN, "minisign-linux/x86_64"),
                                           (LINUX_ARM64, LINUX_MINISIGN, "minisign-linux/aarch64"),
                                           (WINDOWS, WINDOWS_MINISIGN, "minisign-win64/x86_64")):
            with self.subTest(os=os_):
                self.setup_log.unlink(missing_ok=True)
                self.github_path.unlink(missing_ok=True)
                result = self.setup(os_, sha256)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual([args[-1] for args in self.calls("curl")], [url])
                # Ubuntu 22.04's apt has no minisign.
                self.assertNotIn("minisign", " ".join(self.apt_installs()))
                self.assertEqual(self.github_path.read_text().splitlines(), [str(tools / folder)])
                if os_[0] == "Linux":
                    self.assertTrue((tools / folder / "minisign").is_file())

    def test_a_download_that_is_not_the_pinned_file_stops(self):
        for os_, asset in ((LINUX_X64, "minisign-0.12-linux.tar.gz"), (WINDOWS, "minisign-0.12-win64.zip")):
            with self.subTest(os=os_):
                result = self.setup(os_, "0" * 64)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f"release-setup: {asset} is not the file pinned here", result.stderr)
                self.assertFalse(self.github_path.exists())

    def test_linux_installs_tauris_packages_through_apt_install(self):
        # PR CI's installer bounds and retries each network step, so a mirror outage fails in minutes, naming apt.
        result = self.setup(LINUX_X64, LINUX_MINISIGN[1])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.apt_installs(),
                         ["libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev file"])
        self.assertEqual(self.calls("apt-get"), [])

    def test_macos_installs_minisign_with_brew(self):
        result = self.setup(MACOS, "0" * 64)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls("brew"), [["install", "minisign"]])
        self.assertEqual(self.calls("curl"), [])

    def test_with_no_mode_it_installs_every_build_tool(self):
        result = self.setup(MACOS, "0" * 64)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls("rustup"), [["toolchain", "install", "stable", "--profile", "minimal"],
                                                ["target", "add", "aarch64-apple-darwin", "x86_64-apple-darwin"]])
        self.assertEqual(self.cargo_installs(), [INSTALL_TAURI_CLI])
        self.assertEqual(self.calls("npm"), [["ci", "--no-audit", "--no-fund"]])

    def test_the_tauri_cli_mode_installs_rust_and_the_cli_only(self):
        # The Windows signing job runs this CLI, so it is made where no app code runs: no UI package, no target.
        result = self.setup(WINDOWS, "0" * 64, "tauri-cli")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls("rustup"), [["toolchain", "install", "stable", "--profile", "minimal"]])
        self.assertEqual(self.cargo_installs(), [INSTALL_TAURI_CLI])
        for cmd in ("npm", "curl", "pwsh"):
            with self.subTest(cmd=cmd):
                self.assertEqual(self.calls(cmd), [])
        self.assertFalse(self.github_path.exists())

    def test_setup_keeps_the_pinned_tauri_cli_already_there(self):
        # CI restores the CLI from a cache: compiling it again would cost minutes a run.
        for os_, mode, rustup in ((MACOS, (), [["toolchain", "install", "stable", "--profile", "minimal"],
                                              ["target", "add", "aarch64-apple-darwin", "x86_64-apple-darwin"]]),
                                  (WINDOWS, ("tauri-cli",), [["toolchain", "install", "stable", "--profile", "minimal"]])):
            with self.subTest(os=os_, mode=mode):
                self.setup_log.unlink(missing_ok=True)
                self.log.unlink(missing_ok=True)
                result = self.setup(os_, "0" * 64, *mode, FAKE_TAURI_CLI="tauri-cli 2.12.4")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.cargo_installs(), [])
                self.assertEqual(self.calls("rustup"), rustup)
                self.assertEqual(self.calls("npm"), [] if mode else [["ci", "--no-audit", "--no-fund"]])

    def test_setup_installs_the_pin_over_another_version(self):
        # The cache's CLI, which cargo has no record of.
        for mode in ((), ("tauri-cli",)):
            with self.subTest(mode=mode):
                self.log.unlink(missing_ok=True)
                result = self.setup(MACOS, "0" * 64, *mode, FAKE_TAURI_CLI="tauri-cli 2.12.3")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.cargo_installs(), [INSTALL_TAURI_CLI])

    def test_the_minisign_mode_installs_minisign_only(self):
        # The job that checks the signed installers needs nothing else: no Rust, no Tauri CLI, no UI package.
        for os_, (url, sha256) in ((LINUX_X64, LINUX_MINISIGN), (WINDOWS, WINDOWS_MINISIGN), (MACOS, (None, "0" * 64))):
            with self.subTest(os=os_):
                self.setup_log.unlink(missing_ok=True)
                result = self.setup(os_, sha256, "minisign")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual([args[-1] for args in self.calls("curl")], [url] if url else [])
                self.assertEqual(self.calls("brew"), [] if url else [["install", "minisign"]])
                for cmd in ("rustup", "npm", "apt-get"):
                    self.assertEqual(self.calls(cmd), [], cmd)
        self.assertEqual(self.cargo_calls(), [])

    def test_an_unknown_mode_is_a_usage_error(self):
        result = self.setup(LINUX_X64, LINUX_MINISIGN[1], "everything")
        self.assertEqual(result.returncode, 2)
        self.assertIn("usage: release-setup.sh", result.stderr)
        self.assertFalse(self.setup_log.exists())
        self.assertEqual(self.cargo_calls(), [])


if __name__ == "__main__":
    unittest.main()
