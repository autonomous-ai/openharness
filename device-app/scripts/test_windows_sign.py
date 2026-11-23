"""windows-sign.ps1, Tauri's sign command in sign-windows's Bundle step, run with the workflow's own command line under
pwsh, with fake ArtifactSigning and Get-AuthenticodeSignature modules first on PSModulePath. Nothing is signed and
nothing reaches Azure: the real cmdlet and module run on the Windows VM and in the release workflow."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent
SCRIPT = SCRIPTS / "windows-sign.ps1"
# Built from parts, so scripts/ci-plan.py declares this read of the signing action by hand.
ACTION = Path(__file__).resolve().parents[2] / ".github" / "actions" / "windows-signing" / "action.yml"
# The artifact-signing action passes all ten to Invoke-ArtifactSigning: the four our action sets, its defaults for the
# rest.
CREDENTIALS = ("ExcludeEnvironmentCredential", "ExcludeWorkloadIdentityCredential", "ExcludeManagedIdentityCredential",
               "ExcludeSharedTokenCacheCredential", "ExcludeVisualStudioCredential",
               "ExcludeVisualStudioCodeCredential", "ExcludeAzureCliCredential", "ExcludeAzurePowerShellCredential",
               "ExcludeAzureDeveloperCliCredential", "ExcludeInteractiveBrowserCredential")
IDENTIFIERS = ("SIGNING_ENDPOINT", "SIGNING_ACCOUNT", "SIGNING_PROFILE", "WINDOWS_SIGNING_PUBLISHER")
PWSH = shutil.which("pwsh")


def script_settings():
    """$signing's entries: 'text' as a string, $true and $false as bools."""
    lines = SCRIPT.read_text().splitlines()
    start = [line.strip() for line in lines].index("$signing = @{")
    settings = {}
    for line in (line.strip() for line in lines[start + 1:]):
        if line == "}":
            return settings
        if not line or line.startswith("#"):
            continue
        name, value = (part.strip() for part in line.split("=", 1))
        text = re.fullmatch(r"'([^']*)'", value)
        settings[name] = text.group(1) if text else {"$true": True, "$false": False}[value]
    raise AssertionError("$signing has no closing }")


def action_settings():
    """The artifact-signing step's literal inputs, under Invoke-ArtifactSigning's parameter names."""
    lines = ACTION.read_text().splitlines()
    uses = [line.strip() for line in lines].index("uses: azure/artifact-signing-action@v2")
    start = next(index for index in range(uses + 1, len(lines)) if lines[index].strip() == "with:")
    indent = len(lines[start]) - len(lines[start].lstrip())
    settings = {}
    for line in lines[start + 1:]:
        if line.strip() and len(line) - len(line.lstrip()) <= indent:
            break
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, value = (part.strip() for part in line.split(":", 1))
        if not value.startswith("${{"):
            settings["".join(part.capitalize() for part in key.split("-"))] = {"true": True, "false": False}.get(value,
                                                                                                                value)
    return settings


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCRIPT.is_file(), f"{SCRIPT} is missing")

    def test_the_signing_settings_are_the_actions(self):
        ours, action = script_settings(), action_settings()
        self.assertLessEqual({"FileDigest", "TimestampRfc3161", "TimestampDigest"}, set(action))
        for name, value in action.items():
            with self.subTest(name=name):
                self.assertIn(name, ours)
                self.assertEqual((type(ours[name]), ours[name]), (type(value), value))
        self.assertEqual(set(ours), {"FileDigest", "TimestampRfc3161", "TimestampDigest", *CREDENTIALS})
        for name in set(CREDENTIALS) - set(action):
            with self.subTest(name=name):
                self.assertIs(ours[name], True)

    def test_the_script_never_traces_installs_or_calls_az(self):
        code = "\n".join(line for line in SCRIPT.read_text().splitlines() if not line.lstrip().startswith("#"))
        for pattern in (r"(?i)Set-PSDebug", r"(?i)-Trace", r"(?i)Install-Module", r"(?i)Import-Module",
                        r"(?i)Get-AzAccessToken", r"(?i)\b(Get-ChildItem|gci|dir|ls)\s+env:",
                        r"(?im)(^|[\s;&|(])az(\.cmd|\.exe)?\s"):
            with self.subTest(pattern=pattern):
                self.assertIsNone(re.search(pattern, code))


# Answers from FAKE_SIGNATURES, a JSON file of full path -> {status, signer, timestamp}; a path it lacks is NotSigned.
# The certificate answers only the call the action makes, GetNameInfo('SimpleName', $false).
AUTHENTICODE = r'''
function Get-AuthenticodeSignature {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$LiteralPath)
    $entry = (Get-Content -Raw -LiteralPath $env:FAKE_SIGNATURES | ConvertFrom-Json -AsHashtable)[$LiteralPath]
    if (-not $entry) { $entry = @{ status = 'NotSigned' } }
    $certificate = $null
    if ($entry.signer) {
        $certificate = [pscustomobject]@{ Name = $entry.signer }
        $certificate | Add-Member -MemberType ScriptMethod -Name GetNameInfo -Value {
            param($type, $forIssuer)
            if ("$type" -ne 'SimpleName' -or $forIssuer) { throw 'the fake answers SimpleName, $false only' }
            $this.Name
        }
    }
    $timestamp = if ($entry.timestamp) { [pscustomobject]@{ Subject = 'CN=Fake Timestamp' } }
    [pscustomobject]@{ Status = $entry.status; SignerCertificate = $certificate; TimeStamperCertificate = $timestamp }
}
'''

# Declares every parameter the artifact-signing action passes, and appends the bound ones as one JSON line to
# FAKE_SIGNING_LOG. Then FAKE_SIGNING_OUTCOME gives -Files its new state in FAKE_SIGNATURES: valid (the default: Valid
# by WINDOWS_SIGNING_PUBLISHER, timestamped), unsigned (unchanged), no-timestamp, other-signer, or throws.
SIGNING = r'''
function Invoke-ArtifactSigning {
    [CmdletBinding()]
    param(
        [object]$Endpoint, [object]$CodeSigningAccountName, [object]$CertificateProfileName, [object]$Files,
        [object]$FilesFolder, [object]$FilesFolderFilter, [object]$FilesFolderRecurse, [object]$FilesFolderDepth,
        [object]$FilesCatalog, [object]$FileDigest, [object]$TimestampRfc3161, [object]$TimestampDigest,
        [object]$AppendSignature, [object]$Description, [object]$DescriptionUrl, [object]$GenerateDigestPath,
        [object]$GenerateDigestXml, [object]$IngestDigestPath, [object]$SignDigest, [object]$GeneratePageHashes,
        [object]$SuppressPageHashes, [object]$GeneratePkcs7, [object]$Pkcs7Options, [object]$Pkcs7Oid,
        [object]$EnhancedKeyUsage, [object]$ExcludeEnvironmentCredential, [object]$ExcludeWorkloadIdentityCredential,
        [object]$ExcludeManagedIdentityCredential, [object]$ExcludeSharedTokenCacheCredential,
        [object]$ExcludeVisualStudioCredential, [object]$ExcludeVisualStudioCodeCredential,
        [object]$ExcludeAzureCliCredential, [object]$ExcludeAzurePowerShellCredential,
        [object]$ExcludeAzureDeveloperCliCredential, [object]$ExcludeInteractiveBrowserCredential, [object]$Timeout,
        [object]$BatchSize, [object]$ClickOnceApplicationName, [object]$ClickOncePublisherName
    )
    Add-Content -LiteralPath $env:FAKE_SIGNING_LOG -Value (ConvertTo-Json -InputObject $PSBoundParameters -Compress)
    $outcome = if ($env:FAKE_SIGNING_OUTCOME) { $env:FAKE_SIGNING_OUTCOME } else { 'valid' }
    if ($outcome -eq 'throws') { throw 'signing failed' }
    $signatures = Get-Content -Raw -LiteralPath $env:FAKE_SIGNATURES | ConvertFrom-Json -AsHashtable
    $state = switch ($outcome) {
        'valid' { @{ status = 'Valid'; signer = $env:WINDOWS_SIGNING_PUBLISHER; timestamp = $true } }
        'no-timestamp' { @{ status = 'Valid'; signer = $env:WINDOWS_SIGNING_PUBLISHER; timestamp = $false } }
        'other-signer' { @{ status = 'Valid'; signer = 'Someone Else'; timestamp = $true } }
    }
    if ($state) { $signatures[$Files] = $state }
    Set-Content -LiteralPath $env:FAKE_SIGNATURES -Value (ConvertTo-Json -InputObject $signatures -Depth 3)
}
'''


# On Windows the built-in Get-AuthenticodeSignature would answer instead of the fake. CI's Linux leg ships pwsh, so a
# missing one there fails rather than skipping the only run of these tests before the Windows VM.
@unittest.skipUnless(os.name != "nt" and (PWSH or os.environ.get("GITHUB_ACTIONS") == "true"),
                     "needs pwsh, on a host that is not Windows")
class WindowsSignTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(PWSH, "pwsh is required on CI")
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.release = self.root / "target" / "x86_64-pc-windows-msvc" / "release"
        self.temp = self.root / "temp"
        self.release.mkdir(parents=True)
        self.temp.mkdir()
        self.log, self.signatures_file = self.root / "signing.jsonl", self.root / "signatures.json"
        self.signatures({})
        authenticode = self.module("authenticode", "FakeAuthenticode", "Get-AuthenticodeSignature", AUTHENTICODE)
        signing = self.module("signing", "ArtifactSigning", "Invoke-ArtifactSigning", SIGNING)
        inherited = [entry for entry in os.environ.get("PSModulePath", "").split(os.pathsep) if entry]
        self.without_signing = os.pathsep.join([str(authenticode), *inherited])
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith("FAKE_") and key not in IDENTIFIERS}
        self.env.update(PSModulePath=os.pathsep.join([str(authenticode), str(signing), *inherited]),
                        TMPDIR=str(self.temp), FAKE_SIGNATURES=str(self.signatures_file),
                        FAKE_SIGNING_LOG=str(self.log), SIGNING_ENDPOINT="https://eus.codesigning.azure.net/",
                        SIGNING_ACCOUNT="account", SIGNING_PROFILE="profile",
                        WINDOWS_SIGNING_PUBLISHER="AUTONOMOUS INC.")

    def module(self, folder, name, function, body):
        """A module folder autoload finds: its manifest names the one function it exports."""
        path = self.root / "fakes" / folder / name
        path.mkdir(parents=True)
        (path / f"{name}.psm1").write_text(body)
        (path / f"{name}.psd1").write_text(
            f"@{{ RootModule = '{name}.psm1'; ModuleVersion = '1.0'; FunctionsToExport = @('{function}') }}\n")
        return path.parent

    def signatures(self, entries):
        self.signatures_file.write_text(json.dumps(entries))

    def sign(self, path, release=None, write=True, **env):
        """The workflow's command line, from the root (a relative release folder resolves there). An env value of None
        unsets it."""
        if write and not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"MZ")
        environment = {key: value for key, value in {**self.env, **env}.items() if value is not None}
        return subprocess.run([PWSH, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
                               str(SCRIPT), str(self.release if release is None else release), str(path)],
                              cwd=self.root, env=environment, capture_output=True, text=True, timeout=60)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def assert_refused(self, result, *texts):
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("windows-sign: refused", result.stderr)
        for text in texts:
            self.assertIn(text, result.stderr)
        self.assertEqual(self.calls(), [])

    def test_it_signs_each_file_tauri_hands_it(self):
        files = [self.release / "harness-device.exe"]
        for arch in ("x64", "arm64"):
            plugins = self.release / "nsis" / arch / "Plugins" / "x86-unicode"
            files += [plugins / "NSISdl.dll", plugins / "StartMenu.dll", plugins / "System.dll",
                      plugins / "nsDialogs.dll", plugins / "additional" / "nsis_tauri_utils.dll"]
        installers = self.release / "bundle" / "nsis"
        files += [installers / "Harness Device_0.1.13_x64-setup.exe",
                  installers / "Harness Device_0.1.13_arm64-setup.exe", self.temp / "nst0.tmp",
                  self.temp / "nst1A2B.tmp", self.temp / "nstffff.tmp", self.release / "HARNESS-DEVICE.EXE"]
        for path in files:
            with self.subTest(path=str(path.relative_to(self.root))):
                self.signatures({})
                before = len(self.calls())
                result = self.sign(path)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn(f"windows-sign: signed {path}", result.stdout.splitlines())
                self.assertEqual([call["Files"] for call in self.calls()[before:]], [str(path)])

    def test_the_call_carries_the_actions_settings_and_nothing_else(self):
        result = self.sign(self.release / "harness-device.exe")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        [call] = self.calls()
        self.assertEqual(set(call), {"Endpoint", "CodeSigningAccountName", "CertificateProfileName", "Files",
                                     "FileDigest", "TimestampRfc3161", "TimestampDigest", *CREDENTIALS})
        self.assertEqual((call["Endpoint"], call["CodeSigningAccountName"], call["CertificateProfileName"]),
                         ("https://eus.codesigning.azure.net/", "account", "profile"))
        self.assertEqual((call["FileDigest"], call["TimestampRfc3161"], call["TimestampDigest"]),
                         ("SHA256", "http://timestamp.acs.microsoft.com", "SHA256"))
        self.assertIs(call["ExcludeAzureCliCredential"], False)
        for name in CREDENTIALS:
            if name != "ExcludeAzureCliCredential":
                with self.subTest(name=name):
                    self.assertIs(call[name], True)

    def test_a_valid_file_is_left_as_it_is(self):
        path = self.release / "harness-device.exe"
        self.signatures({str(path): {"status": "Valid", "signer": "AUTONOMOUS INC.", "timestamp": True}})
        result = self.sign(path, PSModulePath=self.without_signing, **dict.fromkeys(IDENTIFIERS))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f"windows-sign: already signed {path}", result.stdout.splitlines())
        self.assertEqual(self.calls(), [])

    def test_twice_signs_once(self):
        path = self.release / "nsis" / "x64" / "Plugins" / "x86-unicode" / "System.dll"
        first, second = self.sign(path), self.sign(path)
        self.assertEqual((first.returncode, second.returncode), (0, 0), first.stderr + second.stderr)
        self.assertIn(f"windows-sign: signed {path}", first.stdout.splitlines())
        self.assertIn(f"windows-sign: already signed {path}", second.stdout.splitlines())
        self.assertEqual(len(self.calls()), 1)

    def test_it_refuses_a_file_outside_the_allowlist(self):
        plugins = self.release / "nsis" / "x64" / "Plugins" / "x86-unicode"
        installers = self.release / "bundle" / "nsis"
        comma = self.root / "a,b" / "release"
        comma.mkdir(parents=True)
        cases = [
            (self.release / "harness-device2.exe", self.release, True),
            (self.release / ".." / "harness-device.exe", self.release, True),
            (self.release.parent / "release-old" / "harness-device.exe", self.release, True),
            (self.release / "nsis" / "x86" / "Plugins" / "x86-unicode" / "System.dll", self.release, True),
            (plugins / "Other.dll", self.release, True),
            (plugins / "additional" / "System.dll", self.release, True),
            (installers / "Harness Device_0.1.13_x86-setup.exe", self.release, True),
            (installers / "Harness Device_latest_x64-setup.exe", self.release, True),
            (installers / "Other_0.1.13_x64-setup.exe", self.release, True),
            (self.release / "bundle" / "nsis-updater" / "Harness Device_0.1.13_x64-setup.exe", self.release, True),
            (self.temp / "nst12345.tmp", self.release, True),
            (self.temp / "nstG1.tmp", self.release, True),
            (self.temp / "sub" / "nst1A2B.tmp", self.release, True),
            (self.temp / "xnst1A2B.tmp", self.release, True),
            (self.temp / "nst1A2B.tmp.exe", self.release, True),
            (comma / "harness-device.exe", comma, True),
            # From the root this names the release folder itself: only its being relative refuses it.
            (self.release / "harness-device.exe", Path("target") / "x86_64-pc-windows-msvc" / "release", True),
            (self.temp / "nst1A2B.tmp", self.root / "target" / "none" / "release", True),
            (installers / "Harness Device_0.1.13_x64-setup.exe", self.release, False),
        ]
        for path, release, write in cases:
            with self.subTest(path=str(path.relative_to(self.root)), release=str(release)):
                self.assert_refused(self.sign(path, release, write), os.path.normpath(path))

    def test_it_refuses_a_changed_signature(self):
        path = self.release / "harness-device.exe"
        for status in ("HashMismatch", "NotTrusted", "UnknownError"):
            with self.subTest(status=status):
                self.signatures({str(path): {"status": status, "signer": "AUTONOMOUS INC.", "timestamp": True}})
                self.assert_refused(self.sign(path), str(path), status)

    def test_it_refuses_without_the_identifiers_or_the_module(self):
        path = self.release / "harness-device.exe"
        for name in IDENTIFIERS:
            for value in (None, " "):
                with self.subTest(name=name, value=value):
                    self.assert_refused(self.sign(path, **{name: value}), str(path), name)
        self.assert_refused(self.sign(path, PSModulePath=self.without_signing), str(path), "Invoke-ArtifactSigning")

    def test_it_refuses_what_did_not_come_out_signed(self):
        path = self.release / "harness-device.exe"
        for outcome, reason in (("unsigned", "NotSigned"), ("no-timestamp", "no timestamp"),
                                ("other-signer", "signed by 'Someone Else', not 'AUTONOMOUS INC.'")):
            with self.subTest(outcome=outcome):
                self.signatures({})
                before = len(self.calls())
                result = self.sign(path, FAKE_SIGNING_OUTCOME=outcome)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn(f"windows-sign: refused {path}", result.stderr)
                self.assertIn(reason, result.stderr)
                self.assertEqual(len(self.calls()) - before, 1)
        self.signatures({})
        result = self.sign(path, FAKE_SIGNING_OUTCOME="throws")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("windows-sign: signed", result.stdout)


if __name__ == "__main__":
    unittest.main()
