# Harness Device: sign the NSIS uninstaller and plugin DLLs: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Windows installer `sign-windows` makes carries an uninstaller and NSIS plugin DLLs Authenticode-signed
as AUTONOMOUS INC., and `release-check.sh --signed` refuses an installer whose uninstaller or any DLL is not.

**Architecture:** `sign-windows`'s Bundle step gives `cargo tauri bundle` a `bundle.windows.signCommand` (through
`release-build.sh bundle`'s CONFIG_JSON) that runs a new `device-app/scripts/windows-sign.ps1` once per file Tauri
signs: the exe (already signed by the action, left as it is), the five plugin DLL copies, makensis's temporary
uninstaller and the installer. The script refuses any file outside a fixed allowlist and signs through
`Invoke-ArtifactSigning`, the module and Azure CLI session the `Sign the exes` action step left in the job, with the
action's own settings. The `Sign the installers` step goes. `release-check.sh --signed` extracts `uninstall.exe` and
every DLL with 7-Zip and requires each to be Valid, since makensis ignores the uninstaller command's exit code.

**Tech Stack:** PowerShell 7 (`pwsh`), Bash (Git Bash on the runner), GitHub Actions YAML, Python 3 stdlib tests, Tauri
CLI 2.12.4 / tauri-bundler 2.10.4, NSIS (Tauri's), 7-Zip, Azure Artifact Signing (`ArtifactSigning` module).

**Spec:** [2026-11-23-device-win-sign-uninstaller-design.md](2026-11-23-device-win-sign-uninstaller-design.md)

## Decisions this plan makes (the spec left them to the builder)

- **Where the script's lines go.** Success lines go to stdout, refusals to stderr. Tauri logs a sign command's stdout
  when it succeeds, and when it fails it puts the command's stderr into its error (tauri-bundler 2.10.4,
  `utils::CommandExt::output_ok`). So the reason reaches the Bundle step's log either way. Exact copy:
  `windows-sign: already signed <full path>`, `windows-sign: signed <full path>`, and
  `windows-sign: refused <full path>: <reason>` (exit 1).
- **The allowlist's exact forms.** The installer's version is `\d+\.\d+\.\d+` (release-build.sh only takes X.Y.Z). The
  uninstaller is `^nst[0-9A-F]{1,4}\.tmp$`, compared case-insensitively, directly in
  `[IO.Path]::GetFullPath([IO.Path]::GetTempPath())`. The release folder must be an absolute path to a folder that
  exists. A path holding a comma is refused: `Invoke-ArtifactSigning -Files` takes a comma-separated list (the action
  joins its files with `,`), so a comma would make it sign two other paths. A file that does not exist is refused.
- **Check order.** Allowlist, then exists, then `Get-AuthenticodeSignature`, then identifiers and module, then sign,
  then verify. An exe the action already signed passes even if nothing else is in place, and nothing gets signed
  unless everything is in place.
- **Settings.** The script holds them in one hashtable literal, `$signing`, with one `Name = value` per line. It has
  the three values `.github/actions/windows-signing/action.yml` gives (`FileDigest = 'SHA256'`,
  `TimestampRfc3161 = 'http://timestamp.acs.microsoft.com'`, `TimestampDigest = 'SHA256'`) and all ten credential
  exclusions `azure/artifact-signing-action@v2` passes to `Invoke-ArtifactSigning`. Four come from our action.yml. The
  other six use the artifact-signing action's defaults (checked on 2026-11-23 at its `v2` tag, commit `c0ae2c1d0c18`).
  Every exclusion is `$true` except `ExcludeAzureCliCredential = $false`: "only the Azure CLI session".
  `Endpoint`, `CodeSigningAccountName`, `CertificateProfileName` and `Files` are added at the call. There is no
  `-Trace`, `Timeout` or `BatchSize`.
- **The module.** The script calls `Invoke-ArtifactSigning` by name, so PowerShell loads the module the action
  installed. It never runs `Install-Module` or `Import-Module` and pins no version. It reads its four identifiers only
  as `$env:SIGNING_ENDPOINT`, `$env:SIGNING_ACCOUNT`, `$env:SIGNING_PROFILE` and `$env:WINDOWS_SIGNING_PUBLISHER`.
  Task 4's test holds the step's env names to that set. It calls `Get-AuthenticodeSignature -LiteralPath` unqualified.
- **The script gets a Python-run test** (`test_windows_sign.py`). The tests run the real script with the workflow's
  exact command line (`pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <script> <release> <file>`), with
  fake `ArtifactSigning` and `Get-AuthenticodeSignature` modules first on `PSModulePath`. They run wherever `pwsh` is
  installed on a host that is not Windows (on Windows the built-in cmdlet competes with the fake). On the Mac, which
  has no `pwsh`, they skip. Under GitHub Actions a missing `pwsh` fails instead of skipping, so CI's Linux leg
  (`device-app-checks`, ubuntu-latest, which ships PowerShell 7) always runs them. Locally they run in Podman
  (Verification 1). The real `Get-AuthenticodeSignature` and the real module are covered on the Windows VM.
- **The drift test reads the signing action** through a path built from parts. So `scripts/ci-plan.py` declares
  `.github/actions/windows-signing/action.yml` as a `device-app` input (`DEPENDS` and `PR_READS`), so that a change to
  the action alone runs the test. A change to `ci-plan.py` needs two independent security reviews before merge
  (docs/validation-and-release.md).
- **release-check's 7-Zip calls** use the filters `harness-device.exe`, `uninstall.exe` and `*.dll` (`7z e -y -r`, as
  `packed_app` does). `packed_app` becomes `packed ARCHIVE FOLDER NAME`, one way to extract a named file. The DLLs of
  `<name>` go to `<folder>/dlls`, the uninstaller to `<folder>/uninstall.exe`, and its DLLs to
  `<folder>/uninstall-dlls`. Duplicates under `$PLUGINSDIR` are copies of the same plugin, so `-y` overwriting them
  checks the same file. A DLL that fails is named on stderr (`release-check: <file name> is not Authenticode-signed`).
  If the VM trial shows 7-Zip names the uninstaller differently, the filter and its fake change together.
- **The sign command's form.** It uses Tauri's object form, `{"cmd":"pwsh","args":[...]}`, so each path is one argument
  and needs no quoting. It is built per arch in the Bundle step. Its paths come from `cygpath -m`: absolute, with
  forward slashes, since makensis gets the command as Rust's `Debug` of it.
- **The VM trial reuses a real signed exe when it can.** It takes `harness-device.exe` out of run 45098872790's arm64
  installer while that artifact is still kept (7 days), at version 0.1.12. Otherwise it compiles with `release-build.sh
  compile`. It also installs the trial installer silently and runs the installed `uninstall.exe`. This proves that
  signing after `!uninstfinalize` keeps the uninstaller working (NSIS checks its own CRC) before any real PC sees it.

## Global Constraints

- Tauri CLI 2.12.4, tauri-bundler 2.10.4; `bundle.windows.signCommand` is never in a committed `tauri*.conf.json`. PR
  CI's and local bundles stay unsigned.
- Signing settings: SHA256 file digest, RFC 3161 timestamp `http://timestamp.acs.microsoft.com`, SHA256 timestamp
  digest; publisher `${{ vars.WINDOWS_SIGNING_PUBLISHER || 'AUTONOMOUS INC.' }}`.
- The sign command: `pwsh` with `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File <script> <release folder> %1`,
  every path absolute with forward slashes.
- Allowlist (relative to the release folder `target/<target>/release`): `harness-device.exe`;
  `nsis/{x64,arm64}/Plugins/x86-unicode/{NSISdl,StartMenu,System,nsDialogs}.dll`;
  `nsis/{x64,arm64}/Plugins/x86-unicode/additional/nsis_tauri_utils.dll`;
  `bundle/nsis/Harness Device_<X.Y.Z>_{x64,arm64}-setup.exe`; plus `nst<1-4 hex>.tmp` directly in the user's temp
  folder.
- `sign-windows` runs no build code and installs nothing. The identity stays in `sign-windows`. No new workflow, no
  switch to turn signing off, no fallback to unsigned.
- Never print the Azure session, a token or `az` output: no `az` call, no `Set-PSDebug`, no `-Trace`, no listing of
  the environment.
- A path to another component inside a Python string is built from parts (`scripts/ci-plan.py` reads a quoted path as
  a read of that folder).
- Platforms: Windows x64 and arm64 installers, both made on the x64 runner. macOS and Linux do not change.
- Docs and comments in English and short, and comments say why. Every commit ends with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Nothing is committed except by the tasks' own steps.

## Review Focus

1. **The paths Tauri really hands the script differ in form from the release folder**: a `\\?\` prefix, an 8.3 short
   temp folder (`RUNNER~1`), mixed slashes, the drive letter's case. A real file must be accepted and a look-alike
   refused. Case: Task 1 tests. Slashes, prefixes and short names exist only on Windows: the VM trial (arm64) and the
   after-merge prepare run (x64).
2. **The uninstaller's signature fails silently** (makensis ignores `!uninstfinalize`'s exit code). `release-check.sh
   --signed` must stop the installer: Task 3 tests, and the VM trial case where the stand-in fails only for `nst*.tmp`.
3. **An extraction that finds nothing, or 7-Zip naming things otherwise**, must fail the check, never pass it vacuously:
   Task 3's "no DLL" and "no uninstaller" tests, and the VM trial against real 7-Zip.
4. **Look-alike paths** must be refused: a sibling folder sharing the release folder's name as a prefix, `..` out of
   it, a comma, the other bundle folder `nsis-updater`, an `x86` plugin folder, a 5-digit or non-hex temp name, `nst`
   in a temp subfolder. Task 1 tests.
5. **A Bundle step without the identity** (a var unset, the action step moved or gone, so no module) must refuse with a
   line that names what is missing, before any signing call. Task 1 tests the refusals, Task 4 the step order.

---

### Task 1: `windows-sign.ps1` signs only the files Tauri is meant to hand it

Effort: xhigh. Depends on: nothing.

**Files:**
- Create: `device-app/scripts/windows-sign.ps1`
- Test: `device-app/scripts/test_windows_sign.py` (create)

**Interfaces:**
- Produces: `windows-sign.ps1 <Release> <File>`, both mandatory positional `[string]` params,
  `$ErrorActionPreference = 'Stop'`. Exit 0 after `windows-sign: already signed <full path>` or
  `windows-sign: signed <full path>` on stdout. Exit 1 after `windows-sign: refused <full path>: <reason>` on stderr.
  Env read, through `$env:` only: `SIGNING_ENDPOINT`, `SIGNING_ACCOUNT`, `SIGNING_PROFILE`, `WINDOWS_SIGNING_PUBLISHER`.
  Settings in the `$signing = @{ … }` literal (Decisions). Task 4 uses the path, the arguments and the env names.

- [ ] **Step 1: Write the failing tests** in `test_windows_sign.py`. Paths: `SCRIPT = SCRIPTS / "windows-sign.ps1"`;
  the action is `Path(__file__).resolve().parents[2] / ".github" / "actions" / "windows-signing" / "action.yml"` (from
  parts). `CREDENTIALS` lists the ten names `Exclude{Environment,WorkloadIdentity,ManagedIdentity,SharedTokenCache,
  VisualStudio,VisualStudioCode,AzureCli,AzurePowerShell,AzureDeveloperCli,InteractiveBrowser}Credential`, with a
  comment that the artifact-signing action passes all ten.

  `SettingsTests` (no `pwsh`, runs everywhere):
  - `test_the_signing_settings_are_the_actions`. Parse `$signing` (lines between `$signing = @{` and the `}` that
    closes it: `'…'` is a string, `$true`/`$false` a bool). Parse the action's `uses: azure/artifact-signing-action@v2`
    step's `with:` lines, skipping comment lines and values starting `${{`. Map kebab to Pascal case (`file-digest` →
    `FileDigest`, `timestamp-rfc3161` → `TimestampRfc3161`), with `true`/`false` as bools. Assert every action entry is
    in `$signing` with an equal value. Assert `$signing`'s keys are exactly `{FileDigest, TimestampRfc3161,
    TimestampDigest} ∪ CREDENTIALS`, and every `CREDENTIALS` key the action does not name is `True`.
  - `test_the_script_never_traces_installs_or_calls_az`. With comment lines removed, the script holds no `Set-PSDebug`,
    `-Trace`, `Install-Module`, `Import-Module`, `Get-AzAccessToken`, no `Env:` listing (`Get-ChildItem Env:`,
    `gci env:`, `dir env:`) and no `az` call (`(?im)(^|[\s;&|(])az(\.cmd|\.exe)?\s`).

  `WindowsSignTests` (`skipUnless(shutil.which("pwsh") and os.name != "nt")`, except that under `GITHUB_ACTIONS=true` a
  missing `pwsh` fails with `pwsh is required on CI`). `setUp` builds `release = root/target/x86_64-pc-windows-msvc/
  release` and `temp = root/temp`, and two fake module folders, each a `.psm1` plus a `.psd1` whose `FunctionsToExport`
  names its one function, so autoload finds it:
  - `fakes/authenticode/FakeAuthenticode`: `Get-AuthenticodeSignature -LiteralPath` reads `FAKE_SIGNATURES` (JSON:
    full path → `{"status", "signer", "timestamp"}`, a missing path meaning `NotSigned`). It returns `Status` as a
    string, `SignerCertificate` as `$null` or an object whose ScriptMethod `GetNameInfo('SimpleName', $false)` returns
    `signer`, and `TimeStamperCertificate` as `$null` or an object.
  - `fakes/signing/ArtifactSigning`: `Invoke-ArtifactSigning` declares every parameter the action passes, each
    `[object]`. It appends `$PSBoundParameters` as one JSON line to `FAKE_SIGNING_LOG`. Then, by `FAKE_SIGNING_OUTCOME`
    (`valid` by default, or `unsigned`, `no-timestamp`, `other-signer`, `throws`), it writes `-Files`' new state:
    `Valid` by `WINDOWS_SIGNING_PUBLISHER` with a timestamp, unchanged, `Valid` with no timestamp, `Valid` by
    `Someone Else`, or it throws `signing failed`.

  The env is `PSModulePath` = both fake folders, then the existing value; `TMPDIR=temp`; `SIGNING_ENDPOINT=
  https://eus.codesigning.azure.net/`, `SIGNING_ACCOUNT=account`, `SIGNING_PROFILE=profile`,
  `WINDOWS_SIGNING_PUBLISHER=AUTONOMOUS INC.`. `sign(path, release=None, **env)` writes the file if it is missing
  (unless told not to), runs the workflow's exact command line with `timeout=60` and returns the result. `calls()`
  reads the log.
  - `test_it_signs_each_file_tauri_hands_it`. Each of `release/harness-device.exe`; the five plugin paths under
    `nsis/x64` and under `nsis/arm64`; `bundle/nsis/Harness Device_0.1.13_x64-setup.exe` and `…_arm64-setup.exe`;
    `temp/nst0.tmp`, `temp/nst1A2B.tmp`, `temp/nstffff.tmp`, and `release/HARNESS-DEVICE.EXE` (case). For each: exit 0,
    stdout holds `windows-sign: signed <path>`, and it adds exactly one call whose `Files` is that path.
  - `test_the_call_carries_the_actions_settings_and_nothing_else`. The call's keys are exactly `Endpoint,
    CodeSigningAccountName, CertificateProfileName, Files` plus `$signing`'s keys. The three identifiers equal the
    env, `FileDigest == "SHA256"`, `ExcludeAzureCliCredential is False`, and every other exclusion is `True`.
  - `test_a_valid_file_is_left_as_it_is`. `Valid` by `AUTONOMOUS INC.`, with the four identifiers unset and the signing
    fake off `PSModulePath`: exit 0, `windows-sign: already signed <path>`, no call.
  - `test_twice_signs_once`. The same unsigned DLL twice: one call; the second run prints `already signed`.
  - `test_it_refuses_a_file_outside_the_allowlist`. Each of `release/harness-device2.exe`;
    `release/../harness-device.exe`; `target/x86_64-pc-windows-msvc/release-old/harness-device.exe` (with `release` as
    the folder); `nsis/x86/Plugins/x86-unicode/System.dll`; `nsis/x64/Plugins/x86-unicode/Other.dll`;
    `nsis/x64/Plugins/x86-unicode/additional/System.dll`; `bundle/nsis/Harness Device_0.1.13_x86-setup.exe`;
    `bundle/nsis/Harness Device_latest_x64-setup.exe`; `bundle/nsis/Other_0.1.13_x64-setup.exe`;
    `bundle/nsis-updater/Harness Device_0.1.13_x64-setup.exe`; `temp/nst12345.tmp`; `temp/nstG1.tmp`;
    `temp/sub/nst1A2B.tmp`; `temp/xnst1A2B.tmp`; `temp/nst1A2B.tmp.exe`; `release/harness-device.exe` with the release
    folder `root/a,b/release` (comma); `release/harness-device.exe` with the relative folder `target/x/release`; and an
    allowlisted path that does not exist. For each: exit 1, stderr holds `windows-sign: refused` and the path, no call.
  - `test_it_refuses_a_changed_signature`. Statuses `HashMismatch`, `NotTrusted`, `UnknownError`: exit 1, the status in
    stderr, no call.
  - `test_it_refuses_without_the_identifiers_or_the_module`. Each of the four identifiers unset, then set to `" "`:
    exit 1, stderr names it, no call. With the signing fake off `PSModulePath`: exit 1, stderr holds
    `Invoke-ArtifactSigning`.
  - `test_it_refuses_what_did_not_come_out_signed`. Outcomes `unsigned`, `no-timestamp`, `other-signer`: exit 1, one
    call, stderr holds `NotSigned`, `no timestamp`, `signed by 'Someone Else', not 'AUTONOMOUS INC.'` respectively.
    Outcome `throws`: a non-zero exit.
- [ ] **Step 2: Run them to see them fail.** `python3 -m unittest discover -s device-app/scripts -p
  'test_windows_sign.py' -v` on the Mac: `SettingsTests` fails (no script) and `WindowsSignTests` skips. Then in
  Podman (Verification 1): everything fails.
- [ ] **Step 3: Commit the red tests** (`Harness Device: windows-sign.ps1 tests, red`).
- [ ] **Step 4: Write `windows-sign.ps1`.** The header comment says why it exists, that the allowlist is the only
  files Tauri signs in this bundle, and that it relies on the action's module and session. Then the steps in the
  Decisions' order. Compare paths with `[string]::Equals(a, b, [StringComparison]::OrdinalIgnoreCase)` after
  `[IO.Path]::GetFullPath`, with folders trimmed of a trailing separator. Build the fixed paths with
  `[IO.Path]::Combine`, and match the installer name and the temp name by regex on the leaf, with the parent equal to
  the folder. Refuse through one helper that writes the line with `[Console]::Error.WriteLine` and runs `exit 1`.
  Verify as the action does: `Valid`, `TimeStamperCertificate`, and
  `SignerCertificate.GetNameInfo('SimpleName', $false)` equal to the publisher.
- [ ] **Step 5: Run them to see them pass**, on the Mac (`SettingsTests`) and in Podman (all).
- [ ] **Step 6: Commit** (`Harness Device: windows-sign.ps1, Tauri's sign command for the release bundle`).

### Task 2: A change to the signing action runs the Device app's checks

Effort: high. Depends on: nothing.

**Files:**
- Modify: `scripts/ci-plan.py` (`DEPENDS["device-app"]` near line 249, `PR_READS["device-app"]` near line 353, and the
  comments above them)
- Modify: `docs/validation-and-release.md` (the `device-app-checks` selection row, line 80)
- Test: `scripts/tests/test_ci_plan.py` (`test_either_release_workflow_runs_the_device_app_suite`, line 533)

- [ ] **Step 1: Write the failing test.** Rename it `test_either_release_workflow_or_the_signing_action_runs_the_device_app_suite`.
  Add `.github/actions/windows-signing/action.yml` to its paths, and add to its comment that `test_windows_sign.py`
  holds `windows-sign.ps1`'s settings to that action through a path built from parts. Same assertions:
  `select([path])[0] == {"device-app"}` and `reads("device-app", path)`.
- [ ] **Step 2: Run it to see it fail.** `cd scripts/tests && python3 -m unittest
  test_ci_plan.SelectionTests.test_either_release_workflow_or_the_signing_action_runs_the_device_app_suite -v`.
  Expected: the action's `select` is `set()`.
- [ ] **Step 3: Commit the red test** (`CI plan: the signing action selects device-app, red`).
- [ ] **Step 4: Declare the read.** Add the path to both `device-app` tuples. Their comments say
  `test_windows_sign.py` reads the signing action's inputs. The docs row adds "or the Windows signing action" and says
  the release tests read all three.
- [ ] **Step 5: Run `test_ci_plan.py` whole** (`python3 -m unittest test_ci_plan -v` in `scripts/tests`). Expected:
  pass, including `test_every_declared_input_selects_the_suite_that_reads_it` and
  `test_every_declared_input_exists`.
- [ ] **Step 6: Commit** (`CI plan: the signing action selects device-app`).

### Task 3: `release-check.sh --signed` refuses an unsigned uninstaller or DLL

Effort: xhigh. Depends on: nothing.

**Files:**
- Modify: `device-app/scripts/release-check.sh` (`packed_app` → `packed`, new `packed_dlls` and `dlls_signed`, and the
  Windows `--signed` block, lines 131–136 and 188–197)
- Test: `device-app/scripts/test_release_build.py` (`SEVEN_ZIP`, `ReleaseCheckTests.signed_installer` and the
  `--signed` tests)

**Interfaces:**
- Produces, per installer `<name>` and after today's checks, in this order:
  - `<name> packs uninstall.exe`
  - `the uninstall.exe in <name> is Authenticode-signed`
  - `<name> carries plugin DLLs`
  - `every DLL in <name> is Authenticode-signed`
  - `the uninstall.exe in <name> carries plugin DLLs`
  - `every DLL in the uninstall.exe in <name> is Authenticode-signed`

  Each is printed as `ok: …` or `FAILED: …`, which then exits 1. Task 5 lists them in RELEASE.md.

- [ ] **Step 1: Write the failing tests.** Installer JSON gains `"uninstaller": {"signed": bool, "dlls": {name:
  bool}}` and `"dlls": {name: bool}`. A falsy value means "not packed", as `app={}` already means.
  `signed_installer(arch, app=None, uninstaller=None, dlls=None)` defaults to all five plugin names signed for `dlls`,
  and to a signed uninstaller carrying `System.dll`, `nsDialogs.dll` and `nsis_tauri_utils.dll`. `SEVEN_ZIP` keeps its
  log and `-o` handling. For `uninstall.exe` it writes the archive's `uninstaller` as JSON, and for `*.dll` it writes
  each `dlls` entry as `{"signed": bool}` under its name. The comment above it says so.
  - Rename `test_windows_signed_checks_the_app_each_installer_packs` to
    `test_windows_signed_checks_the_app_the_uninstaller_and_every_dll_each_installer_packs`. Expected stdout is
    today's lines per installer, followed by the six Interfaces lines. The 7-Zip calls, as `(call[0],
    Path(call[-2]).name, call[-1])`, are per installer: `("e", name, "harness-device.exe")`,
    `("e", name, "uninstall.exe")`, `("e", name, "*.dll")` and `("e", "uninstall.exe", "*.dll")`.
  - `test_windows_signed_fails_an_uninstaller_unsigned_or_missing`: `uninstaller={"signed": False, "dlls": {...}}` →
    last line `FAILED: the uninstall.exe in <name> is Authenticode-signed`. `uninstaller={}` →
    `FAILED: <name> packs uninstall.exe`.
  - `test_windows_signed_fails_an_unsigned_dll_and_names_it`. `System.dll` unsigned in `dlls` gives `FAILED: every
    DLL in <name> is Authenticode-signed`. In the uninstaller's `dlls` it gives `FAILED: every DLL in the
    uninstall.exe in <name> is Authenticode-signed`. In both cases stderr holds `System.dll`.
  - `test_windows_signed_fails_when_no_dll_is_found` (Review Focus 3): `dlls={}` gives `FAILED: <name> carries
    plugin DLLs`, and an uninstaller with `"dlls": {}` gives `FAILED: the uninstall.exe in <name> carries plugin
    DLLs`.
  - `test_windows_signed_fails_an_app_unsigned_at_another_version_or_missing` keeps its cases. They still fail at their
    own lines.
- [ ] **Step 2: Run them to see them fail.** `python3 -m unittest discover -s device-app/scripts -p
  'test_release_build.py' -v`. Expected: the new and renamed tests fail and the others pass.
- [ ] **Step 3: Commit the red tests** (`Harness Device: release-check refuses an unsigned uninstaller or DLL, red`).
- [ ] **Step 4: Implement.** `packed ARCHIVE FOLDER NAME` replaces `packed_app` (the harness-device.exe check uses it).
  `packed_dlls ARCHIVE FOLDER` extracts `*.dll` (quoted for bash) and is true when `FOLDER` holds at least one
  `.dll`. `dlls_signed FOLDER` calls `authenticode_valid` on each `.dll` and stops at the first failure, naming it on
  stderr. Each is one `&&` chain or returns explicitly, since errexit is off inside `check`. A comment on the new
  block says this is the gate because makensis ignores the uninstaller command's exit code, and Smart App Control
  blocks an unsigned uninstaller (Code Integrity 3033/3089).
- [ ] **Step 5: Run `test_release_build.py` to see it pass.**
- [ ] **Step 6: Commit** (`Harness Device: release-check refuses an unsigned uninstaller or DLL`).

### Task 4: `sign-windows` signs inside the bundle through Tauri's command

Effort: xhigh. Depends on: Task 1 (the script's path, arguments and env names).

**Files:**
- Modify: `.github/workflows/release-device.yml` (header comment lines 7–16, `sign-windows`'s comment lines 307–310,
  the Bundle step lines 380–393, and the `Sign the installers` step lines 395–405, which goes)
- Test: `device-app/scripts/test_release_workflow.py`

**Interfaces:**
- Consumes: `device-app/scripts/windows-sign.ps1 <Release> <File>` and its four `$env:` names (Task 1).

- [ ] **Step 1: Write the failing tests.**
  - Replace `test_the_installer_is_signed_after_the_exe_and_before_the_update_signature` with
    `test_the_exes_are_signed_before_the_bundle_and_the_update_signature_last`. `sign-windows` has exactly one `SIGNING`
    step, and its index is less than Bundle's (`release-build.sh bundle`), which is less than `release-build.sh
    sign-update`, then `device-manifest.py sums`, then `actions/upload-artifact@`. The Bundle step holds `mv bundle/x64/*
    bundle/arm64/* out/`, and sign-update holds `sign-update "$VERSION" out`. The step carries release-desktop.yml's
    seven inputs, as today. No step is named `Sign the installers`.
  - `test_tauri_signs_inside_the_bundle_through_windows_sign`. The Bundle step holds
    `script="$(cygpath -m "$PWD/device-app/scripts/windows-sign.ps1")"` and `folder="$(cygpath -m "$PWD/$release")"`.
    It also holds the string
    `"signCommand":{"cmd":"pwsh","args":["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File","'"$script"'","'"$folder"'","%1"]}`
    inside `sign='{"bundle":{"windows":{…}}}'`, and
    `release-build.sh bundle "$VERSION" "bundle/$arch" "$sign"`. Its `env:` is exactly
    `SIGNING_ENDPOINT: ${{ vars.SIGNING_ENDPOINT }}`, `SIGNING_ACCOUNT: ${{ vars.SIGNING_ACCOUNT }}`,
    `SIGNING_PROFILE: ${{ vars.SIGNING_PROFILE }}`, and `WINDOWS_SIGNING_PUBLISHER:` followed by the same expression as
    the action step's `publisher:` input. It has no `secrets.`. Those env names equal
    `set(re.findall(r"\$env:(\w+)", <windows-sign.ps1 text>))`.
  - `test_the_sign_command_is_given_only_to_the_release_bundle`. Across every job's code (comments out), only
    `sign-windows`'s Bundle step holds `signCommand`, and no `device-app/src-tauri/tauri*.conf.json` holds it.
  - `test_the_signing_job_compiles_and_installs_nothing` also forbids `Install-Module`.
- [ ] **Step 2: Run them to see them fail.** `python3 -m unittest discover -s device-app/scripts -p
  'test_release_workflow.py' -v`. Expected: the three new or changed tests fail (two signing steps, no `signCommand`).
- [ ] **Step 3: Commit the red tests** (`Harness Device: sign-windows signs inside the bundle, red`).
- [ ] **Step 4: Change the workflow.** The Bundle step gets the `env:` above. Its loop builds `folder` and `sign` per
  arch after the `mv`, and passes `"$sign"` as `release-build.sh bundle`'s fourth argument. `script` is set once
  before the loop. The `Sign the installers` step goes. The comments say why:
  - On the step: only the Tauri CLI and this repository's `windows-sign.ps1` run there, with no secret. Tauri's sign
    command signs NSIS's plugin DLLs, the uninstaller and the installer inside the bundle, through the session
    `Sign the exes` left. The identifiers are not secrets. Only this step gives the command, so PR CI and local
    bundles stay unsigned. The paths use forward slashes because makensis gets the command as Rust's `Debug` of it.
  - On the job and at the top: the installers, their uninstallers and the plugin DLLs are signed inside the bundle by
    Tauri's command.
- [ ] **Step 5: Run the tests and actionlint.** `python3 -m unittest discover -s device-app/scripts -p
  'test_release_workflow.py' -v` passes, and `actionlint .github/workflows/release-device.yml` prints nothing.
- [ ] **Step 6: Commit** (`Harness Device: sign-windows signs the uninstaller and plugin DLLs inside the bundle`).

### Task 5: The docs say what is signed and how an update runs

Effort: high. Depends on: Task 3 (check names), Task 4 (step order). No behavior changes and no test, so it is one
commit.

**Files:**
- Modify: `device-app/RELEASE.md`, `docs/windows-code-signing.md`, `device-app/src-tauri/src/packaging.rs` (the doc
  comment on `the_run_value_is_named_after_the_product`, lines 27–29), `device-app/scripts/release-build.sh` (the
  header comment, lines 6–19), `device-app/AGENTS.md` (Commands)

- [ ] **Step 1: Write the facts.**
  - `RELEASE.md` line 8, the Windows row's Signed column: Authenticode for the app's exe, the installer, its
    uninstaller and NSIS's plugin DLLs.
  - Its `sign-windows` row (line 72): signs both exes, then bundles each installer with that Tauri CLI, whose sign
    command (`scripts/windows-sign.ps1`) signs the plugin DLLs, the uninstaller and the installer. Then the update
    signatures and the sums.
  - "Windows signs in order": the exe by the action, then NSIS packs it. Inside the bundle Tauri's command signs the
    five plugin DLLs, the uninstaller makensis writes and the installer, and the script refuses any other file. The
    update signature comes last. The sentence saying they stay unsigned goes.
  - The `--signed` list (lines 107–109) adds the uninstaller and every DLL in the installer and in that uninstaller
    (7-Zip, each Valid, at least one DLL in each). This is the gate, because makensis ignores a failed uninstaller
    signature.
  - "The scripts the jobs run" adds `scripts/windows-sign.ps1`.
  - "How an installed app updates" (lines 239–241): the Run value stays because the installer in update mode
    (`/UPDATE`) does not run the old uninstaller, so nothing deletes it.
  - `docs/windows-code-signing.md`, the Harness Device row of "What is signed": `harness-device.exe` for x64 and arm64.
    Then, inside each bundle through Tauri's sign command, NSIS's five plugin DLLs, the uninstaller and each
    `Harness-Device-windows-<arch>-setup.exe`. Always on. The "Not the uninstaller…" sentence goes.
  - Its first-run item 4 bullet: Smart App Control lets the installer, the app, an update (`/P /UPDATE`, which does not
    run the old `uninstall.exe`), a reinstall with `/P` over an install and an uninstall from Settings → Apps run, with
    no Code Integrity 3033/3089 event. The uninstaller and DLLs are signed now.
  - Its Design → Scale: a Harness Device release with Windows signs 16 files, which per arch are the exe, five DLLs,
    the uninstaller and the installer.
  - `packaging.rs`: Tauri's uninstaller deletes the Run value named after the product, and an update (`/UPDATE`) does
    not run the old uninstaller. So the value carries the product's name: an uninstall removes it and an update keeps
    it.
  - `release-build.sh`: on Windows, `bundle` signs nothing by itself. `sign-windows` passes Tauri's sign command as
    CONFIG_JSON, which only the bundle reads (the app never does), so `compile` does not take it. Today's "Authenticode
    signs it next" goes.
  - `device-app/AGENTS.md`, beside the release tests' command: `test_windows_sign.py` runs `windows-sign.ps1` under
    `pwsh` where it is installed (CI's Linux leg). Without `pwsh` those tests skip.
- [ ] **Step 2: Check.** `cd device-app/src-tauri && cargo test --locked --lib packaging` on the Mac passes (comment
  only). `git diff --stat` shows only these five files.
- [ ] **Step 3: Commit** (`Harness Device: the docs say the uninstaller and plugin DLLs are signed`).

---

## Verification

Nothing here reaches production, a real account or the real signing identity before merge. The VM trial uses a
self-signed certificate trusted on the VM only, a throwaway updater key and a scratch folder. The only real-identity
checks run after merge, through the release workflow's `--prepare`, which publishes nothing, and on the Dell.

1. **Local, on the Mac, at the end.** `python3 -m unittest discover -s device-app/scripts -p 'test_*.py' -v`
   (`WindowsSignTests` skips there). In `scripts/tests`, `python3 -m unittest test_ci_plan -v`. Also
   `actionlint .github/workflows/release-device.yml`, and `cd device-app/src-tauri && cargo test --locked --lib
   packaging`. `WindowsSignTests` runs in Podman, in a machine of its own (not `harness` or `podman-machine-default`):
   `podman machine init --cpus 4 --memory 4096 devcrew-test` once, then `podman machine start devcrew-test`, then
   `podman run --rm -e PYTHONDONTWRITEBYTECODE=1 -v "$PWD":/repo:ro -w /repo <a PowerShell 7 LTS Ubuntu image from
   mcr.microsoft.com/powershell> bash -c 'apt-get update -qq && apt-get install -y -qq python3 >/dev/null && python3 -m
   unittest discover -s device-app/scripts -p test_windows_sign.py -v'`, then `podman machine stop devcrew-test`.
   Expected: every test ran and passed (none skipped). Before the push that marks the PR ready, paste the output of
   `python3 scripts/local-checks.py --run` (it maps none of these paths today) into the PR body.
2. **PR CI** (draft, then ready). The planner selects `device-app` (`device-app-checks`: on Linux the release tests,
   with `test_windows_sign.py`'s pwsh tests run, not skipped, in its `-v` log), `device-app-e2e`, `device-app-update`,
   `device-app-desktop` and `device-app-install` (`packaging.rs`), `cross-read-scan` and `process-checks`. `ci/required`
   must be green. None of them signs: PR CI stays unsigned by design.
3. **Before merge, on the Windows VM** (UTM Win11 ARM64, `ssh admin@192.168.64.5`, key auth). The orchestrator lends
   and resumes it on request, and one tester uses it at a time. Everything goes in a new `C:\work\sign-trial`. Never
   touch `C:\work\e2e` or its signed-in CLI, and never start the installed app (no `/R`), so nothing reaches a
   backend.
   - Tools, installed if missing: Git for Windows (bash), PowerShell 7, Rust stable with `aarch64-pc-windows-msvc`,
     `cargo install tauri-cli --version 2.12.4 --locked`, 7-Zip on PATH, and minisign 0.12's `minisign-0.12-win64.zip`
     checked against release-setup.sh's sha256 pin. `release-setup.sh` itself refuses to run outside GitHub Actions.
     The branch's tree is copied in with `git archive`.
   - A self-signed code-signing certificate, `CN=Harness Trial Signer`, in `Cert:\CurrentUser\My`, with its public part
     in `Cert:\LocalMachine\Root`. A stand-in module, `C:\work\sign-trial\modules\ArtifactSigning`, is put first on
     `PSModulePath`. Its `Invoke-ArtifactSigning` declares every parameter the script passes and logs each `-Files` to
     `stand-in.log`. It signs with `Set-AuthenticodeSignature -HashAlgorithm SHA256 -TimestampServer
     http://timestamp.digicert.com`, a public RFC 3161 server. With `TRIAL_FAIL_UNINSTALLER=1` it throws for
     `nst*.tmp` only.
   - The exe: `harness-device.exe` from run 45098872790's `harness-device-0.1.12-windows` arm64 installer (`7z e`),
     version 0.1.12, which is AUTONOMOUS INC.-signed. If that artifact has expired, use `DEVICE_TARGET=
     aarch64-pc-windows-msvc bash device-app/scripts/release-build.sh compile 0.0.1` and sign its exe with the
     stand-in. In both cases it goes in `<target>/aarch64-pc-windows-msvc/release/`, with `<target>` from `cargo
     metadata`.
   - **Signed bundle.** Use the workflow's exact command, built the same way (`cygpath -m` paths), with the env
     `SIGNING_ENDPOINT=trial SIGNING_ACCOUNT=trial SIGNING_PROFILE=trial WINDOWS_SIGNING_PUBLISHER='Harness Trial
     Signer'` and `DEVICE_TARGET=aarch64-pc-windows-msvc`, and run `release-build.sh bundle <version> out "$sign"`. The bundle log should show `windows-sign:
     already signed …harness-device.exe` and `windows-sign: signed` for the five DLLs, for `…\nst<hex>.tmp` and for
     `…\Harness Device_<version>_arm64-setup.exe`. `stand-in.log` lists exactly those seven files. Next, make a
     throwaway key with `cargo tauri signer generate --ci -p trial -w C:\work\sign-trial\trial.key`, run `sign-update`
     with it, and run `release-check.sh out <version> <its public key> --signed`. Every line should be `ok:`, including
     the six new ones.
   - **Silent failure caught.** Repeat the bundle into `out2` with `TRIAL_FAIL_UNINSTALLER=1`. The bundle should still
     succeed (makensis ignores it), and `release-check.sh --signed` should end with `FAILED: the uninstall.exe in
     Harness-Device-windows-arm64-setup.exe is Authenticode-signed`.
   - **Old pipeline caught.** Bundle into `out3` with no sign command. Sign only that installer with the stand-in, as
     the removed step did. Then `sign-update` and `release-check.sh --signed` should fail at the same uninstaller line.
   - **Allowlist.** Run `pwsh -NoProfile -NonInteractive -File device-app\scripts\windows-sign.ps1 <release folder>
     C:\work\sign-trial\other.exe` (a copy of an unsigned exe). Expected: exit 1, `windows-sign: refused …other.exe`,
     and nothing new in `stand-in.log`.
   - **The signed uninstaller works.** Install `out`'s installer with `/S`. The installed
     `%LOCALAPPDATA%\Harness Device\uninstall.exe` should be Valid by `Harness Trial Signer`. Run it with `/S`; the
     folder, the Start menu entry and the uninstall key should then be gone.
   - Clean up: remove the certificate from both stores and confirm `Get-ChildItem Cert:\LocalMachine\Root,
     Cert:\CurrentUser\My | ? Subject -eq 'CN=Harness Trial Signer'` is empty. Delete `C:\work\sign-trial` and the key.
     Remove `%LOCALAPPDATA%\tauri` only if the trial created it (note whether it existed first).
4. **After merge (the orchestrator's): `make release-device ARGS="--prepare --platforms all"` from `main`.** This runs
   `release-device.yml` by `workflow_dispatch`, only from `main`, publishing nothing. `sign-windows`'s Bundle log should
   show two `already signed`, ten DLL, two `nst*.tmp` and two installer `windows-sign: signed` lines, with no token or
   `az` output. `check-windows` should pass with the six new `ok:` lines per installer. For the PR's numbers, compare
   `sign-windows`'s duration with run 45098872790's. The spec expects about 2 to 3 minutes more, within its 30.
5. **Then on the Dell (the orchestrator's, with a person's eye; Smart App Control stays on).** The Windows 11 Pro 25H2
   x64 test PC is reached with `ssh DELL@172.168.20.15`, one tester at a time. First remove the 0.1.12 install by hand
   (folder, uninstall entry, Run value). Then, with item 4's x64 installer: install, run, uninstall from Settings →
   Apps, reinstall with `/P` over an install, and update with `/P /UPDATE`. Expected: no Code Integrity 3033/3089
   event (Event Viewer → Microsoft → Windows → CodeIntegrity → Operational). If the app offers sign-in, use a test
   account, never a person's own.
6. **Two independent security reviews**, since `scripts/ci-plan.py` changes: phase 4's final review and a second
   fresh reviewer on Task 2's diff.
7. **Proposal, for the maintainers (not built here).** A PR-CI job on `windows-latest` (inside `ci.yml`, beside
   `device-app-build`) that bundles the debug NSIS installer with this sign command and a self-signed stand-in module,
   then runs `release-check.sh --signed`. It would run for changes to `windows-sign.ps1`, `release-check.sh`,
   `release-build.sh` and `tauri*.conf.json`, so the VM trial's checks run on later pull requests.
