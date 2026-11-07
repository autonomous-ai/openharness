# Desktop Update Signature Implementation Plan

> Task #4435. Written by the writing-plans skill as this project's Engineer works: one Engineer implements it task by
> task, test first, and the pull request's review is the one independent review.

**Goal:** The Desktop updater installs a build only when the same publisher that signed the running app signed it, so a
wrong manifest (right sha256, wrong build) is refused on macOS and Windows.

**Architecture:** One new file, `desktop/lib/update/update_signature.dart`, holds the rule and the two OS checks; the
updater calls it once the download is unpacked and before anything is installed. macOS asks `codesign` to check the
staged bundle against a Developer ID requirement built from the running app's own team and identifier, `notarized`
included. Windows asks a hidden PowerShell for the Authenticode signer of every `.exe` and `.dll` and for a signed file
catalog that covers the whole version folder (the Dart code is `data/app.so`, which Authenticode cannot sign), and the
rule compares them with the running app's signer in Dart. The release signs that catalog.

**Tech Stack:** Dart/Flutter (desktop), `/usr/bin/codesign`, Windows PowerShell 5.1 (`Get-AuthenticodeSignature`,
`New-FileCatalog`, `Test-FileCatalog`), GitHub Actions (release-desktop.yml, windows-signing action).

**Spec:** the task brief (#4435). Verified on main 610ccb05c and the published 1.3.89 packages, 2026-11-07:

1. `downloadAndStage` (desktop_updater.dart:435) checks size and sha256, then unpacks; nothing checks a signature.
2. macOS 1.3.89 (`Harness-macos-arm64.zip`): Developer ID Application: Autonomous Inc. (54DJVWMJCC), identifier
   `ai.autonomous.harness`, hardened runtime, notarized and stapled. `codesign --verify --deep --strict -R='anchor apple
   generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and
   certificate leaf[subject.OU] = "54DJVWMJCC" and notarized'` passes in 1.3 s; an ad-hoc copy, a tampered copy and
   another team's app fail.
3. Windows 1.3.89 (`Harness-windows-x64.zip`, signing `required` since 2026-11-03): `Harness.exe`, `harness-desktop.exe`
   and every plugin DLL are signed `C=US, ST=California, L=Redlands, O=AUTONOMOUS INC., CN=AUTONOMOUS INC.`, leaf valid
   3 days, with the Artifact Signing identity EKU `1.3.6.1.4.1.311.97.585055327.208923272.208213867.148721407`;
   `WebView2Loader.dll` is signed by Microsoft Corporation. `data/app.so`, `icudtl.dat` and `flutter_assets/` carry no
   signature.
4. Windows staging builds (windows-desktop.yml release mode) and local macOS builds are unsigned or ad-hoc.

## Global Constraints

- Desktop only for app code; the release change is the Windows signing job and action that already sign Desktop.
- Never read a signing secret. Tests sign nothing with a real identity: ad-hoc and unsigned fixtures only.
- Must not break the update from 1.3.89 to the next release: 1.3.89 runs the old updater, which accepts any extra file
  under `app/<version>/`, so the catalog is invisible to it.
- Windows rules: every child process through `startHidden` (`lib/core/hidden_process.dart`); no window opens.
- Every wait has a timeout (60 s); a check that cannot finish refuses the update.
- Copy is plain words, shown in the update banner through the existing `updateError`.

## The rule

- The running app's signer is read from the running app: macOS team ID + bundle identifier (`codesign -dv`), Windows
  certificate subject + Artifact Signing identity EKUs (`Get-AuthenticodeSignature` on the running
  `harness-desktop.exe`).
- A running app that is verifiably unsigned (macOS ad-hoc or no signature, Windows `NotSigned`) has no signer to match;
  it keeps today's sha256-only behaviour and logs that. Only dev and staging builds are unsigned, so this never weakens
  a released install, and once an install is signed it accepts only signed updates.
- Anything else that fails to read the running signer refuses the update.
- macOS: the staged bundle must satisfy the Developer ID requirement with the running team and identifier, deep and
  strict, and `notarized`.
- Windows: every staged `.exe`/`.dll` and the staged launcher must be `Valid`; `harness-desktop.exe`, `Harness.exe` and
  the catalog must have the running signer; any other file may also have a signer one of the running version folder's
  own files has (Microsoft for `WebView2Loader.dll`). The catalog `app/<version>/harness-desktop.cat` must exist and
  `Test-FileCatalog` must say `Valid` (every file listed, none changed, none extra).

## Key rotation

- macOS: a new Developer ID certificate under the same team changes nothing. A new team: one bridge release, signed by
  the old team, whose rule also accepts the new team ID; releases after it are signed by the new team.
- Windows: Artifact Signing's 3-day certificates rotate by themselves; the rule compares the subject and the identity
  EKU, never a thumbprint. Renewing the identity validation keeps the EKU. A new identity validation (new EKU or
  subject): the same bridge release, accepting the next identity as well.

## Review Focus

- A running app whose signer cannot be read (codesign or PowerShell missing, times out, prints nothing): refused, not
  treated as unsigned. Test: `readMacSigner` on a missing path and a runner that times out → refusal.
- A package with one extra unsigned DLL or a changed `app.so` but valid signed exes: refused. Test: Windows rule with an
  extra `NotSigned` file, and catalog status `ValidationFailed`.
- Same team, different app (`identifier` differs): refused. Test: requirement contains the identifier.
- Refusal leaves the current version untouched and removes the staged files. Test: Windows `current` unchanged and the
  attempt folder gone after a refusal.
- The 1.3.89 → next update: nothing in 1.3.89's path changes. Test: the existing staging tests still pass with the
  catalog entry present in the zip.

---

### Task 1: The rule (pure Dart, any OS)

**Files:**
- Create: `desktop/lib/update/update_signature.dart`
- Test: `desktop/test/update_signature_test.dart`

**Interfaces:**
- Produces: `class UpdateRefused implements Exception { final String message; }` (`toString()` is the message);
  `class MacSigner { team, identifier, name }`, `MacSigner? parseMacSigner(String codesignDv)` (null = unsigned/ad-hoc),
  `String macUpdateRequirement(MacSigner)`;
  `class WindowsSigner { status, subject, identity }`, `class WindowsSignatureReport { running, runningFolder, files,
  catalog }` with `fromJson`, `String? windowsUpdateRefusal(WindowsSignatureReport, {version})` (null = accept).

- [ ] **Step 1: Write the failing tests:** `parseMacSigner` reads team, identifier and the Developer ID name from the
  1.3.89 `codesign -dv --verbose=2` text, and returns null for `Signature=adhoc` and for "code object is not signed at
  all"; `macUpdateRequirement` holds the anchor, both Developer ID fields, the team, the identifier and `notarized`;
  `windowsUpdateRefusal` accepts the 1.3.89 shape (AUTONOMOUS files + Microsoft WebView2Loader, catalog Valid by
  AUTONOMOUS), and refuses: an extra `NotSigned` dll; `harness-desktop.exe` signed by Microsoft; a different identity
  EKU with the same subject; catalog missing; catalog `ValidationFailed`; catalog `NotSigned`; running status
  `HashMismatch`. Running `NotSigned` → accept.
- [ ] **Step 2: Run** `flutter test test/update_signature_test.dart` → fails to compile (no file).
- [ ] **Step 3: Implement** the types and functions.
- [ ] **Step 4: Run** the same → PASS.
- [ ] **Step 5: Commit** (test first, then code).

### Task 2: The macOS check

**Files:**
- Modify: `desktop/lib/update/update_signature.dart`
- Test: `desktop/test/update_signature_macos_test.dart` (skipped off macOS)

**Interfaces:**
- Produces: `Future<void> verifyMacUpdate({required String stagedBundle, required String runningBundle, String
  version, Duration timeout})` throwing `UpdateRefused`.

- [ ] **Step 1: Write the failing tests** with fixtures built in the test (a tiny bundle whose executable is a copy of
  `/usr/bin/true`): unsigned staged → refused; ad-hoc staged → refused; running ad-hoc → accepted (no signer); and,
  when a notarized Developer ID Harness is on the machine (`HARNESS_SIGNED_APP_FIXTURE`, else
  `/Applications/Harness.app` if it verifies), a clone of it → accepted, a tampered clone → refused, the unsigned
  fixture against it → refused.
- [ ] **Step 2: Run** `flutter test test/update_signature_macos_test.dart` → fails (no `verifyMacUpdate`).
- [ ] **Step 3: Implement** with `codesign -dv --verbose=2` on the running bundle and `codesign --verify --deep
  --strict -R=<requirement>` on the staged one, both through one timed runner.
- [ ] **Step 4: Run** → PASS. **Step 5: Commit.**

### Task 3: The Windows check

**Files:**
- Modify: `desktop/lib/update/update_signature.dart`
- Test: `desktop/test/update_signature_windows_test.dart` (skipped off Windows)

**Interfaces:**
- Produces: `Future<void> verifyWindowsUpdate({required String stagedFolder, required String stagedLauncher, required
  String runningExe, String version, Duration timeout})` throwing `UpdateRefused`; the PowerShell script reads paths
  from environment variables and prints one JSON `WindowsSignatureReport`.

- [ ] **Step 1: Write the failing tests:** running = a Microsoft-signed system exe, staged folder with a copy of it and
  an unsigned dll → refused naming the dll; a folder with a `New-FileCatalog` catalog (unsigned) → refused for the
  catalog; the report reads `Valid` and the Microsoft subject for the system exe; running = an unsigned exe → accepted.
  The PowerShell runs through `startHidden`.
- [ ] **Step 2–5:** run → fails; implement; run → PASS (Windows CI or a Windows machine); commit.

### Task 4: The updater refuses, cleans up and says why

**Files:**
- Modify: `desktop/lib/update/desktop_updater.dart`, `desktop/lib/update/windows_update_swap.dart` (staged paths)
- Test: `desktop/test/desktop_updater_test.dart`

**Interfaces:**
- Consumes: `verifyMacUpdate`, `verifyWindowsUpdate`, `UpdateRefused`.
- Produces: `DesktopUpdater({... Future<void> Function(String staged)? verifySignature})`; `downloadAndStage` throws
  `UpdateRefused` after deleting what it staged; `WindowsUpdateSwap.stagedFolder` / `stagedLauncher`.

- [ ] **Step 1: Write the failing tests:** macOS and Windows staging with a `verifySignature` that throws → the call
  throws `UpdateRefused`, the staging dir is gone, Windows `current` still names the old version; the verifier
  receives the staged bundle (macOS) and the staged folder (Windows). Existing staging tests pass an accepting verifier.
- [ ] **Step 2–5:** run → fails; wire the check in after the version check (macOS) and after `swap.stage` (Windows);
  run `flutter test test/desktop_updater_test.dart test/windows_update_swap_test.dart` → PASS; commit. The banner
  already shows `Could not install Harness X: <message>` through the generic catch in `app_state.dart`.

### Task 5: The release signs a catalog

**Files:**
- Modify: `.github/workflows/release-desktop.yml` (`sign-windows`), `.github/actions/windows-signing/action.yml`
  (`.cat` beside `.exe`/`.dll`), `desktop/RELEASE.md`, `docs/windows-code-signing.md`, `desktop/CLAUDE.md`

- [ ] **Step 1:** after the first signing pass, `New-FileCatalog -CatalogVersion 2.0` over each `app/<version>` folder
  into `harness-desktop.cat` (written outside, then moved in), a second signing pass signs it, and `Test-FileCatalog`
  must say `Valid` before the zips are written again.
- [ ] **Step 2:** `actionlint` both workflows; docs say what the updater checks and how rotation works.
- [ ] **Step 3: Commit.**
