# Harness Device: sign the NSIS uninstaller and plugin DLLs

## Why

The first Windows release of Harness Device cannot ship: on a Windows 11 Pro 25H2 x64 PC with Smart App Control on,
the prepare run 45098872790 (0.1.12) installed and ran (the installer and `harness-device.exe` are Authenticode-signed
as AUTONOMOUS INC.), but the `%LOCALAPPDATA%\Harness Device\uninstall.exe` the installer writes is not signed and Smart
App Control blocks it (Code Integrity 3033/3089, status `0xC0E90002`). Uninstall fails, from Settings → Apps too, and a
manual reinstall with `/P` hangs on it. `device-app/RELEASE.md` and `docs/windows-code-signing.md` already say Windows
does not ship until these are signed.

NSIS's plugin DLLs (`System.dll`, `nsis_tauri_utils.dll`, `nsDialogs.dll`, extracted to `$PLUGINSDIR` at run time)
loaded on that PC with no event, but they are unsigned too: a Smart App Control reputation change could block them
and break every install. They are signed in the same change.

## Goals

- The uninstaller the installer writes, and every NSIS plugin DLL the installer and the uninstaller carry, are
  Authenticode-signed with the same Azure Artifact Signing identity as the exe and the installer (AUTONOMOUS INC.,
  SHA-256, RFC 3161 timestamp from `timestamp.acs.microsoft.com`).
- `release-check.sh --signed` refuses an installer whose uninstaller or any DLL it carries is not validly signed, so
  CI stops an unsigned one before `publish` (the rule is code, not a note).
- `sign-windows` still runs no build code, and the signing identity is still only in `sign-windows`.
- The docs say what is signed and drop the wrong claim that an update runs the old uninstaller.

## Non-goals

- Desktop's and the CLI's signing (`.github/actions/windows-signing`, `release-desktop.yml`, `release.yml`): unchanged.
- PR CI and local builds: they stay unsigned; no signing in `tauri.windows.conf.json`.
- A new workflow, a switch to turn this signing off, or a fallback to unsigned.
- The SmartScreen prompt for a new publisher.

## Anti-goals

- A step that signs a file it was not meant to sign (a build artefact getting itself signed).
- The Azure session or a token in any log.
- An installer that ships with an unsigned uninstaller because a signing command failed silently.

## How Tauri signs inside the bundle (Tauri CLI 2.12.4, tauri-bundler 2.10.4)

When `bundle.windows.signCommand` is set, `can_sign()` is true and `cargo tauri bundle --bundles nsis` calls that
command once per file, with the file's path for `%1`:

1. **`harness-device.exe`**, in `target/<target>/release/`, right before NSIS packs it (always, with or without
   binary patching; it does not check whether the file is already signed).
2. **The plugin DLLs**: Tauri copies NSIS's `Plugins/x86-unicode` and its downloaded `additional/` folder into
   `target/<target>/release/nsis/<x64|arm64>/Plugins/x86-unicode/` and signs the copies of `NSISdl.dll`,
   `StartMenu.dll`, `System.dll`, `nsDialogs.dll` and `additional/nsis_tauri_utils.dll`; the template's
   `!addplugindir` puts that folder first, so makensis embeds the signed copies. These five are every plugin the
   template calls.
3. **The uninstaller**: the template sets `!uninstfinalize` to the same command. makensis (NSIS 3.13) writes the
   uninstaller to a `GetTempFileName` file in the user's temp folder (`%TEMP%\nst<hex>.tmp`), runs the command through
   `cmd.exe /C IF 1==1 <command>`, then reads the file back and stores it whole in the installer. **makensis ignores
   that command's exit code** (`!uninstfinalize` with no comparison): a failed signature here leaves an unsigned
   uninstaller and the bundle still succeeds. The check in `release-check.sh` is therefore the real gate.
4. **The installer**, `target/<target>/release/bundle/nsis/Harness Device_<version>_<arch>-setup.exe`, after makensis.

Steps 1, 2 and 4 fail the bundle when the command fails (Tauri checks its exit status). The command reaches makensis as
Rust's `Debug` of the command (each part quoted, backslashes doubled), so its own paths use forward slashes.

7-Zip (the runners' 24.x or later) opens the NSIS installer, lists the plugin DLLs under `$PLUGINSDIR` and the
uninstaller, and extracts an uninstaller stored whole (NSIS 3.08+ with `!uninstfinalize`) as the signed file itself.
It opens the extracted uninstaller the same way.

## Approaches

| | What | Trade-off |
|---|---|---|
| **A (chosen)** | Tauri's `signCommand`, given only to `sign-windows`'s Bundle step, runs `device-app/scripts/windows-sign.ps1`, which signs through `Invoke-ArtifactSigning`: the module and the parameters `azure/artifact-signing-action@v2` itself uses. The exes keep their action step before the bundle; the action's second step ("Sign the installers") is removed, since Tauri now signs the installers through the command. | Covers the uninstaller, the five DLLs and the installer with Tauri's own supported door. The script relies on the module and the Azure CLI session the first action step left in the job, and fails clearly when they are not there. |
| B | Drop the action from this job: `azure/login`, `Install-Module ArtifactSigning` pinned, and the command signs everything, the exes too. | One signing engine in the job, but a larger change that repeats the action's setup, and the exes lose the action's checks. |
| C | `!uninstfinalize` in an NSIS `installerHooks` file. | Signs the uninstaller only (the DLLs stay unsigned), and adds a second way beside Tauri's. |

The orchestrator chose A (2026-11-23), with an allowlist in the script and no Azure session in any log.

**The trust split holds.** `sign-windows`'s rule is that no build code (a crate's build script, an npm package) runs
in the job that holds the signing identity. With A, the Bundle step runs what it ran before (the Tauri CLI that
`tauri-cli-windows` made, the NSIS toolset and `nsis_tauri_utils.dll` Tauri downloads and checks by SHA-1) plus this
repository's script from the checked-out `main`; nothing compiles or installs. The identity's reach does not grow
either: `azure/login` in the first signing step leaves the Azure CLI session on the runner until the job ends, so the
Bundle step already ran beside it. C would run at the same moment in the same process tree, so it keeps the split
equally; it loses on coverage and on one way of doing a thing.

## Design

### The sign command

Given only by `sign-windows`'s Bundle step, never committed in a `tauri*.conf.json`: PR CI's and local Windows builds
(`update-pair.sh`, the end-to-end debug installers) bundle with no identity and must stay unsigned. It reaches
`cargo tauri bundle` as `--config` JSON through `release-build.sh bundle`'s CONFIG_JSON (the bundle alone reads it; the
app never does), so `release-build.sh`'s comment about CONFIG_JSON says so. The command is `pwsh` with
`-NoProfile -NonInteractive -ExecutionPolicy Bypass -File <script> <release folder> %1`, every path with forward slashes.

### `device-app/scripts/windows-sign.ps1 <release folder> <file>`

The release folder is `target/<target>/release` of the arch being bundled (absolute). The script:

1. **Allowlist.** Resolves `<file>` to a full path and refuses (exit 1, naming the file) anything but:
   - `<release folder>/harness-device.exe`;
   - `<release folder>/nsis/x64|arm64/Plugins/x86-unicode/{NSISdl,StartMenu,System,nsDialogs}.dll` and
     `.../additional/nsis_tauri_utils.dll`;
   - `<release folder>/bundle/nsis/Harness Device_*_x64|arm64-setup.exe`;
   - a file named `nst<1 to 4 hex digits>.tmp` directly in the user's temp folder (`[IO.Path]::GetTempPath()`), the
     uninstaller makensis just wrote.

   Paths compare case-insensitively after `GetFullPath`, with no wildcard but the version and the temp name's hex.
2. **Already signed.** `Get-AuthenticodeSignature` reads the file: `Valid` → leaves it as it is and says so (the exe
   the action signed); `NotSigned` → signs it; any other status → refuses (it was changed after it was signed).
3. **Signs** with `Invoke-ArtifactSigning -Endpoint -CodeSigningAccountName -CertificateProfileName -Files <file>
   -FileDigest SHA256 -TimestampRfc3161 http://timestamp.acs.microsoft.com -TimestampDigest SHA256` and the same
   credential exclusions the action sets in `.github/actions/windows-signing/action.yml` (only the Azure CLI session).
   The endpoint, account, profile and publisher come from the step's environment (`SIGNING_ENDPOINT`,
   `SIGNING_ACCOUNT`, `SIGNING_PROFILE`, `WINDOWS_SIGNING_PUBLISHER`), identifiers, not secrets. A missing value, or
   no `Invoke-ArtifactSigning` (the action has not run in this job), refuses with a line that says so.
4. **Verifies** what it signed as the action does: `Valid`, a timestamp, and the signer's simple name equal to the
   publisher (`AUTONOMOUS INC.` by default, as the workflow passes it).
5. **Prints** one line per file (`signed`, `already signed` or the refusal and its reason) and the module's own output,
   never a token, a credential or `az` output; no `-Trace`.

A test holds the script's signing settings equal to the action's (digest, timestamp URL and digest, credential
exclusions), so the two signing paths cannot drift apart.

### `sign-windows` (`release-device.yml`)

`Sign the exes` (the action) → `Bundle` (with the sign command and the four identifiers in its environment) →
`Sign the updates` → `Record the checksums` → upload. The `Sign the installers` step is removed. The comments at the
top of the workflow and on the job say the installers, their uninstallers and the plugin DLLs are signed inside the
bundle by Tauri's command.

### `release-check.sh --signed`

For each installer, after the checks it runs today, with 7-Zip as `packed_app` uses it:

- `<name> packs uninstall.exe` and `the uninstall.exe in <name> is Authenticode-signed` (`Get-AuthenticodeSignature`
  Valid);
- `<name> carries plugin DLLs` (at least one `.dll`, so an extraction that finds nothing cannot pass) and
  `every DLL in <name> is Authenticode-signed`;
- the same two for the DLLs inside the extracted `uninstall.exe`.

Each prints `ok:` or `FAILED:` and stops, as the others do. `test_release_build.py`'s fake `7z` and `pwsh` grow to
cover them: a red test per new check (unsigned uninstaller, missing uninstaller, an unsigned DLL in the installer, an
unsigned DLL in the uninstaller, no DLL at all).

### Docs and comments

- `device-app/RELEASE.md`: the Windows rows and "Windows signs in order" (Tauri's command signs the plugin DLLs, the
  uninstaller and the installer inside the bundle; the sentence that they stay unsigned goes); the `--signed` checks
  list; "How an installed app updates": the installer in update mode (`/UPDATE`) does not run the old uninstaller, so
  nothing deletes the Run value.
- `docs/windows-code-signing.md`: the Harness Device row of "What is signed"; first-run item 4's bullet (an update does
  not run `uninstall.exe`; the uninstaller and DLLs are signed now); Design → Scale (a Harness Device release with
  Windows signs 16 files: per arch the exe, five DLLs, the uninstaller and the installer).
- `device-app/src-tauri/src/packaging.rs`: the doc comment on `the_run_value_is_named_after_the_product` (an update
  does not run the old uninstaller).

### Data and security lines

- Growth, concurrency, read cost: N/A, nothing is stored or read.
- Scale: 16 signatures per Windows release instead of 4, inside the Basic plan's 5,000 a month.
- Time: in run 45098872790 the two signing steps took 48 s for four files (about 10 s a call once the module is
  cached); 12 more calls inside the two bundles add about 2 to 3 minutes, well inside `sign-windows`'s 30.
- Identity: unchanged, the `release` environment's OIDC subject, only in `sign-windows`.
- Failure: a refused or failed signature of the exe, a DLL or the installer fails the Bundle step; a failed uninstaller
  signature fails `check-windows`; either way nothing reaches `publish`.
- Platforms: Windows x64 and arm64 installers, both bundled and signed on the x64 runner. macOS and Linux unchanged.

## Verification

- **Unit:** `python3 -m unittest discover -s device-app/scripts -p 'test_*.py'` (the release-check cases above, the
  workflow's step order and the sign command only in Bundle, no `signCommand` in any `tauri*.conf.json`, the script's
  settings equal to the action's). `Get-AuthenticodeSignature` exists only on Windows and this Mac has no `pwsh`, so
  the script's allowlist and status rules are proven on the Windows VM below; the planner decides whether part of them
  also gets a Python-run test.
- **Before merge, on the Windows VM** (UTM Win11 ARM64, lent by the orchestrator, one tester at a time): bundle the
  NSIS installer with `release-build.sh bundle` and the same sign command the workflow gives, running the real
  `windows-sign.ps1` with a stand-in `ArtifactSigning` module first on `PSModulePath` whose `Invoke-ArtifactSigning`
  signs with a self-signed certificate (common name passed as `WINDOWS_SIGNING_PUBLISHER`) trusted on the VM only,
  timestamped by a public RFC 3161 server. Then `release-check.sh --signed` against it: the uninstaller and every DLL
  are signed and 7-Zip extracts them; an installer bundled without the command fails the new checks; and the script
  refuses a file outside its allowlist. The certificate is removed from the VM afterwards.
- **After merge:** the orchestrator runs `make release-device ARGS="--prepare --platforms all"` from `main`;
  `check-windows` must pass with the new checks. Then the Dell (Windows 11 Pro 25H2 x64, Smart App Control on, never
  changed): install, run, uninstall from Settings → Apps, reinstall with `/P` over an install, and the update path
  (`/P /UPDATE`), with no Code Integrity 3033/3089 event. The Dell's 0.1.12 install has the unsigned uninstaller: it is
  removed by hand first (folder, uninstall entry, Run value), with Smart App Control left on.

## Left to the builder

How the script's tests run, the exact 7-Zip arguments, the fake tools' shape, and the wording of the docs.
