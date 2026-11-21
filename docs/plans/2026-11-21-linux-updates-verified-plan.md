# Linux updates are verified: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Linux Desktop installs an update, and installs Harness Device, only when the AppImage carries a minisign
signature made with Harness Device's Tauri key for that file and version; the Desktop release signs its Linux AppImages
in a job that runs no build code, and no job that runs build code holds the key or bucket write.

**Architecture:** One Dart verifier (`desktop/lib/update/tauri_signature.dart`) with the public key pinned as a
constant, used by the Desktop updater's Linux branch and by Desktop's Linux install of Harness Device. On the release
side, `release-desktop.yml` splits `build-linux` into `build-linux` (no secret, no GCP) → `sign-linux` (key only, pinned
minisign) → `upload-linux` (GCP only), and a Python verifier in `scripts/verify-desktop-release.py` (key read from
`device-app/src-tauri/tauri.conf.json`) checks what was signed, what publish and promotion carry, and what the public
downloads hold.

**Tech stack:** Dart/Flutter (`package:cryptography` `DartEd25519`, `DartBlake2b`), Python 3 stdlib + the OpenSSL 3
command line, Bash, GitHub Actions YAML, minisign 0.12.

**Spec:** [2026-11-21-linux-updates-verified-design.md](2026-11-21-linux-updates-verified-design.md)

## Decisions this plan makes (the spec left them to the builder)

- **Verifier API and check order.** `checkTauriSignature(signature, fileName:, versionField:, digest:, publicKey:)`
  takes the file's BLAKE2b-512 as a thunk, called only after the cheap checks pass. Order: missing → malformed (shape,
  `ED` only, length cap 4096 characters) → key (key id) → global → comment → file. So each refusal has one reason: an
  edited trusted comment is `global`; a genuine signature for another file or version is `comment`; a changed byte is
  `file`. The Python verifier keeps the same order and reasons.
- **Test key seams are arguments only.** Dart: a `tauriPublicKey` named argument (default the pinned constant) on
  `DesktopUpdater`, `DeviceAppInstaller` and `deviceAppInstallerFor`. Python: `public_key=None` (meaning the pinned key)
  on `verify_minisign`, `check_signature`, `verify_artifact`, `verify` and the candidate `seal`. No flag, no environment
  variable.
- **Fixtures.** The verifier's own tests use signatures made by `cargo tauri signer generate` + `minisign -S` with
  throwaway keys, committed with their commands, plus the live Device 0.1.11 signature. Tests that need signatures over
  bytes made in the test (updater, Device installer, the end-to-end test, the banner) use a test-only Dart signer,
  `TauriTestSigner` (`desktop/test/support/`); Python tests use `FixtureSigner` (OpenSSL) in
  `scripts/tests/desktop_publication_fixture.py`. The real-tool fixtures and the live signature pin the format in both
  languages.
- **The end-to-end test signs the CI-built Device package itself** with a key it makes, and hands the installer that
  key through `tauriPublicKey`. `ci.yml`'s `device-app-desktop` job does not change.
- **Python checks Ed25519 with `openssl pkeyutl -verify -rawin`** (checked on 2026-11-21 against the live Device 0.1.11
  signature: file and global verify, a changed digest fails) and BLAKE2b with `hashlib`: no new dependency. A
  non-OpenSSL-3 `openssl` (macOS's LibreSSL) is refused with `OpenSSL 3 is required to check signatures`. Local runs on
  a Mac need Homebrew's `openssl@3` first on PATH.
- **Python reads the pinned key from `device-app/src-tauri/tauri.conf.json` when it checks**, so the release side holds
  no copy; Desktop's constant is held equal to the same file by its test. That file therefore joins the `process` and
  `desktop` sparse checkouts (`SOURCE_INPUTS`, `ci.yml`), `PR_READS["desktop"]`, the checkouts of the release jobs that
  check (`sign-linux`, `publish`, `candidate`) and the candidate `BUILD_INPUTS`.
- **The release refuses a Desktop signature that carries any field starting with `version:`** (reason `comment`). The
  apps would not refuse it; the release must never publish one Harness Device's updater could accept.
- **Expected `file:` names are fixed per architecture**, never taken from a URL: `Harness-linux-<x64|arm64>.AppImage`
  for Desktop, `Harness-Device-linux-<x64|arm64>.AppImage` for the Device (checked on 2026-11-21: `cargo tauri signer
  sign --app-version 0.0.3` on that file name writes `file:Harness-Device-linux-x64.AppImage\tversion:0.0.3`).
- **Jobs.** `build-linux` stays the x64/arm64 matrix; `sign-linux` and `upload-linux` are one job each for both arches,
  as `sign-windows` and `upload-windows` are. `build-linux`, `sign-linux` and `build-windows` set job-level
  `permissions: contents: read`: the workflow's `id-token: write` would otherwise let their code mint the token the GCP
  federation accepts. `build-macos` (build, Apple keychain and GCP upload in one step) does not change: the pull
  request names it as a follow-up.
- **The verifier selects the Device install end to end.** `desktop/lib/update/tauri_signature.dart` joins
  `DEVICE_APP_PATHS["device-app-desktop"]` in `scripts/ci-plan.py`, so a change to it alone runs Desktop's Device
  install on CI.
- **Scripts.** `desktop/scripts/package-desktop-linux.sh` (build and package, no credential),
  `desktop/scripts/sign-desktop-linux.sh` (minisign only) and `desktop/scripts/upload-desktop-linux.sh` (rewritten:
  upload and parts, in `upload-desktop-windows.sh`'s shape). The upload keeps the line `gcs_cp "$OUTPUT"
  "gs://${GCS_BUCKET}/${GCS_PATH}" "public, max-age=31536000, immutable" "" 0`, which the publication checks run as is.
  The signature check is its own workflow step (`verify-desktop-release.py --signed`), not part of the sign script, so
  the script can run locally with a throwaway key.
- **Artifacts.** `desktop-linux-x64`, `desktop-linux-arm64` (the AppImage and `Harness-linux-<arch>.AppImage.sha256` in
  `sha256sum` form) and `desktop-linux-signatures` (both `.sig`, Tauri's form: the `.minisig` text base64-encoded on one
  line). Downloads use `pattern: desktop-linux-*` with `merge-multiple: true`.
- **The Device manifest** gives a Linux release a signature only when `platforms.linux-<x86_64|aarch64>` is an object
  whose `url` equals the entry's `url` exactly and whose `signature` is a string, and the entry's `version` is X.Y.Z.
  Otherwise the release has no signature, and the install fails at `signature` ("Couldn’t verify the download."), not
  at `manifest`.
- **`deviceAppSignatureCheckFor(TargetPlatform.linux)` still refuses if asked**: the installer checks the AppImage itself,
  since the check needs the manifest's signature and version. Its comment says so.
- **Measure.** The end-to-end test's Linux legs print `signature check: 100 MB in <n> ms`; before this change the step
  did not exist (0 ms).

## Global Constraints

- Key id `4739BFCC687B1F62`. Pinned public key (Tauri's form, `plugins.updater.pubkey` of
  `device-app/src-tauri/tauri.conf.json`):
  `dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDQ3MzlCRkNDNjg3QjFGNjIKUldSaUgzdG96TDg1UjdIaUhrOUZJQWF1Q1BMUGVyV0crMmNZZ0ZMWkx1QWp0dS9UbE9IcXAwdjkK`.
- Desktop's trusted comment: `timestamp:<unix>\tfile:Harness-linux-<x64|arm64>.AppImage\tdesktop-version:<X.Y.Z>`, no
  `version:` field. The Device's, as checked by Desktop: `file:Harness-Device-linux-<x64|arm64>.AppImage` and
  `version:<the device-linux-<arch>-appimage entry's version>`; its signature is `platforms.linux-x86_64` /
  `platforms.linux-aarch64`'s `signature`. Every field matched whole among the tab-separated fields.
- Algorithm `ED` (prehashed) only; legacy `Ed` is `malformed`.
- Refusal reasons, a fixed set: `missing`, `malformed`, `key`, `file`, `global`, `comment`.
- Log lines, no content and no path: `update: signature refused (<reason>)` (`appLog.warn('update', …)`) and
  `devices: device app signature refused (<reason>)` (`appLog.warn('devices', …)`).
- Banner copy (after "Could not install Harness X: "): `it is not signed by Harness, so it may not be genuine. You are
  still on your current version.`
- Signer: minisign 0.12 from `bash device-app/scripts/release-setup.sh minisign`. Secrets `TAURI_SIGNING_PRIVATE_KEY`
  and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` appear in `sign-linux`'s signing step alone; the key reaches minisign as a
  0600 file under `$RUNNER_TEMP` the script deletes, the password on stdin; never argv, a log or an artifact.
- No key option, switch or environment variable in any shipped code or command-line entry point.
- No new dependency. macOS and Windows checks, `website/scripts/*-install.sh`, the CLI and the Device app do not change.
- `scripts/ci-plan.py` is the planner: two independent security reviews before merge (docs/validation-and-release.md).
- Docs and comments in English and short; comments say why. Every commit ends with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Nothing is committed but by the tasks' own steps.

## Review Focus

1. **Another key's signature carrying the pinned key id** (an attacker's first try): refused `global`, never accepted
   (tests in Tasks 2 and 6).
2. **Trusted-comment look-alikes**: `file:` a prefix or extension of the expected name, `desktop-version:1.2.30` for
   1.2.3, a Desktop signature checked for `version:1.2.3` (a substring of `desktop-version:1.2.3`): refused `comment`
   (Tasks 2 and 6).
3. **Hostile signature text in the manifest** (over 4096 characters, not base64, CRLF lines, three or five lines):
   refused `malformed` at once, the file never hashed (Task 2).
4. **A Device manifest whose `platforms` entry is the other arch's, or whose `url` differs in one character** (case, a
   trailing `/`, another version folder): no signature, the install fails at `signature`, nothing at the place
   (Tasks 4 and 5).
5. **A Device manifest Linux entry with no `version`, or one that is not X.Y.Z**: the install fails at `signature`, not
   at `manifest` (Tasks 4 and 5).

---

### Task 1: `tauri.conf.json` reaches the process and Desktop checkouts and selects Desktop; the verifier selects the Device install

Effort: high. Depends on: nothing.

**Files:**
- Modify: `scripts/record-ci-validation.py` (`SOURCE_INPUTS["process"]`, `SOURCE_INPUTS["desktop"]`),
  `scripts/ci-plan.py` (`PR_READS["desktop"]`, `DEVICE_APP_PATHS["device-app-desktop"]`), `.github/workflows/ci.yml`
  (`process-checks` and `desktop-tests` sparse checkouts)
- Test: `scripts/tests/test_ci_plan.py`, `scripts/tests/test_ci_source_inputs.py`

**Interfaces:**
- Produces: `device-app/src-tauri/tauri.conf.json` present in both sparse checkouts (Task 2's Desktop test and Task 6's
  Python tests read it there); a change to it selects `desktop`; a change to `desktop/lib/update/tauri_signature.dart`
  selects `desktop` and `device-app-desktop`.

- [ ] **Step 1: Write the failing tests.** In `test_each_device_app_job_runs_on_its_own_paths`, the
  `tauri.conf.json` case alone becomes `app | {"device-app-update", "device-app-desktop", "device-app-install",
  "desktop"}` (`tauri.linux.conf.json` and `tauri.windows.conf.json` unchanged), and
  `desktop/lib/update/tauri_signature.dart` joins the loop whose paths expect `{"desktop", "device-app-desktop"}`
  (beside `device_app_installer.dart`). In `test_ci_source_inputs.py`, add
  `device-app/src-tauri/tauri.conf.json` to `setUp`'s files and assert it exists after `self.sparse(...)` in both the
  process and the desktop checkout tests.
- [ ] **Step 2: Run them to see them fail.** `python3 -m unittest scripts/tests/test_ci_plan.py
  scripts/tests/test_ci_source_inputs.py` (with `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto
  GIT_CONFIG_VALUE_0=false`). Expected: the three changed cases FAIL.
- [ ] **Step 3: Commit the red tests** (`CI: tauri.conf.json is a Desktop and process input, red`).
- [ ] **Step 4: Implement.** Add the path to both `SOURCE_INPUTS` entries, to `PR_READS["desktop"]` with the comment
  `# tauri_signature_test.dart holds Desktop's pinned update key to the Device app's.`, and `/device-app/src-tauri/tauri.conf.json`
  to both sparse lists in `ci.yml`. Add `"desktop/lib/update/tauri_signature.dart"` to
  `DEVICE_APP_PATHS["device-app-desktop"]` after `"desktop/lib/devices/"`; its comment gains "the signature check it
  runs on Linux".
- [ ] **Step 5: Run the two files again.** Expected: PASS.
- [ ] **Step 6: Commit** (`CI: the Device app's update key reaches Desktop's and the release scripts' tests`).

### Task 2: One Dart verifier for Tauri's minisign signatures

Effort: xhigh. Depends on: nothing.

**Files:**
- Create: `desktop/lib/update/tauri_signature.dart`, `desktop/test/tauri_signature_test.dart`,
  `desktop/test/support/tauri_test_signer.dart`, `desktop/test/fixtures/tauri_signature/` (`payload.bin`,
  `test_key.pub`, `desktop.sig`, `device.sig`, `other_key.sig`, `legacy.sig`, `device-0.1.11.json`)

**Interfaces:**
- Produces, in `tauri_signature.dart`:
  - `const tauriUpdatePublicKey = '<the Global Constraints key>';`
  - `enum SignatureRefusal { missing, malformed, key, file, global, comment }`
  - `const notSignedByHarness = 'it is not signed by Harness, so it may not be genuine. You are still on your current version.';`
  - `class TauriSignatureRefused extends UpdateRefused { const TauriSignatureRefused(this.reason) : super(notSignedByHarness); final SignatureRefusal reason; }`
  - `Future<void> checkTauriSignature(String? signature, {required String fileName, required String versionField, required Future<List<int>> Function() digest, String publicKey = tauriUpdatePublicKey})`
    — `versionField` is the whole field, e.g. `desktop-version:1.2.3` or `version:0.1.11`; throws
    `TauriSignatureRefused`.
  - `Future<List<int>> blake2b512OfBytes(List<int> bytes)` and `Future<List<int>> blake2b512OfFile(String path)`, both
    on `Isolate.run` (`DartBlake2b()`, 64-byte output), the file read in chunks.
- Produces, in `desktop/test/support/tauri_test_signer.dart`: `class TauriTestSigner { static Future<TauriTestSigner>
  generate(); String get publicKey; Future<String> sign(List<int> digest, String trustedComment); }` — `publicKey` and
  the signature in Tauri's form, algorithm `ED`, a random key id.

- [ ] **Step 1: Make the fixtures** with a throwaway key pair from `cargo tauri signer generate --ci -p fixture -w
  test.key` and a second one for `other_key.sig`. `payload.bin`: `Harness signature fixture\n` × 40. `test_key.pub`:
  `test.key.pub` as written (one line). Each `.sig` is `base64 < x.minisig | tr -d '\n'` of
  `printf 'fixture\n' | minisign -S -s <(base64 --decode < test.key) -m payload.bin -x x.minisig -t "<comment>"`:
  `desktop.sig` with `timestamp:1795200000\tfile:Harness-linux-x64.AppImage\tdesktop-version:1.2.3`, `device.sig` with
  `timestamp:1795200000\tfile:Harness-Device-linux-x64.AppImage\tversion:0.1.12`, `other_key.sig` the desktop comment
  with the other key, `legacy.sig` the desktop comment with `-l`. `device-0.1.11.json`:
  `{"file": "Harness Device.app.tar.gz", "version": "0.1.11", "blake2b512": "66175b2291420a04be465626bd0dcd7a6851b71fc64e1643d49eac3336f93f0d678637ac35aea5f315acdba90083d84b0e25dafa7d0d173df98cf3bf0f7ac159", "signature": <platforms.darwin-aarch64.signature of https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/metadata.json>}`
  (the digest is `openssl dgst -blake2b512` of the 0.1.11 archive, computed on 2026-11-21). Private keys are not
  committed. The test file's header comment holds these commands.
- [ ] **Step 2: Write the failing tests** in `tauri_signature_test.dart` (`test()`, not `testWidgets`; `refused(r)` is
  `throwsA(isA<TauriSignatureRefused>().having((e) => e.reason, 'reason', r))`; `desktop()` checks with
  `fileName: 'Harness-linux-x64.AppImage', versionField: 'desktop-version:1.2.3'` and the test key):
  - `a signature minisign made with a Tauri key passes` — `desktop.sig` over `payload.bin` completes.
  - `one changed byte refuses: file`.
  - `a Device signature offered for Desktop refuses: comment`, and `a Desktop signature offered for the Device refuses:
    comment` (`desktop.sig` with `Harness-Device-linux-x64.AppImage`, `version:1.2.3`).
  - `another version refuses: comment` (`desktop-version:1.2.4`).
  - `another key refuses: key` (`other_key.sig`).
  - Review Focus 1: `another key's signature with the pinned key id written in refuses: global` (`other_key.sig` with
    bytes 2–9 of its decoded signature line replaced by the test key's id).
  - `a broken global signature refuses: global`; `an edited trusted comment refuses: global` (`1.2.3` → `1.2.4` in the
    comment line, checked for `desktop-version:1.2.4`).
  - `the legacy Ed algorithm refuses: malformed`; `no signature refuses: missing` (null and `''`).
  - Review Focus 3: `garbage refuses: malformed and never hashes the file` — `'not base64!'`, base64 of `hello`, a
    3-line and a 5-line text, `desktop.sig`'s text with `\r\n` line ends, and 4097 characters; each `malformed`, and a
    `digest` thunk that counts its calls was called 0 times.
  - Review Focus 2: `look-alike fields refuse: comment` — file names `Harness-linux-x64.App` and
    `Harness-linux-x64.AppImage.old`, `desktop-version:1.2`, `desktop-version:1.2.30`, and `version:1.2.3` against
    `desktop.sig`.
  - `the pinned key verifies the live Device 0.1.11 archive's signature` — `device-0.1.11.json`, default key, its
    `file` and `version:0.1.11`, `digest` the committed hex.
  - `the pinned key is the one Harness Device trusts` — `tauriUpdatePublicKey ==
    jsonDecode(File('../device-app/src-tauri/tauri.conf.json').readAsStringSync())['plugins']['updater']['pubkey']`.
  - `BLAKE2b-512 of bytes and of a file agree` — both give
    `ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923`
    for `abc`.
  - `the test signer's signatures verify, and no other key passes them` — `TauriTestSigner` output passes with its key,
    refuses `key` with the fixture key.
- [ ] **Step 3: Run it to see it fail.** `cd desktop && flutter test test/tauri_signature_test.dart`. Expected: fails to
  compile (no `tauri_signature.dart`).
- [ ] **Step 4: Commit the red tests and fixtures** (`Desktop: Tauri signature checks, red`).
- [ ] **Step 5: Implement `tauri_signature.dart` and `tauri_test_signer.dart`.** Decoded signature: four `\n` lines
  (a trailing empty line allowed): `untrusted comment: …`; base64 of 74 bytes (`ED`, key id 8, signature 64);
  `trusted comment: <text>`; base64 of 64 bytes. Public key: base64 of `untrusted comment: …\n<base64 of 42 bytes: Ed,
  key id 8, Ed25519 key 32>\n`. Global: Ed25519 over the 64 signature bytes then the comment's UTF-8 bytes. File:
  Ed25519 over the digest. `DartEd25519().verify` with `SimplePublicKey(…, type: KeyPairType.ed25519)`. The file doc
  says why the key is pinned here and where its twin lives.
- [ ] **Step 6: Run the test file.** Expected: PASS. `flutter analyze lib/update/tauri_signature.dart test/` clean.
- [ ] **Step 7: Commit** (`Desktop: one check for Harness's Tauri signatures, the key pinned in the app`).

### Task 3: The Desktop updater on Linux installs only what Harness signed

Effort: xhigh. Depends on: Task 2.

**Files:**
- Modify: `desktop/lib/update/desktop_updater.dart`
- Test: `desktop/test/desktop_updater_test.dart`, `desktop/test/update_progress_test.dart`

**Interfaces:**
- Consumes: `checkTauriSignature`, `blake2b512OfBytes`, `TauriSignatureRefused`, `tauriUpdatePublicKey` (Task 2);
  `TauriTestSigner` in tests.
- Produces: `UpdateInfo({…, this.signature})`, `final String? signature;` (read from a manifest entry's `signature`
  when it is a string, else null); `DesktopUpdater({…, String tauriPublicKey = tauriUpdatePublicKey})`.

- [ ] **Step 1: Write the failing tests** in the `Linux architecture packaging` group. `serveLinuxMetadataAndAppImage`
  serves `signature` (`signer.sign(await blake2b512OfBytes(appImageBytes), 'timestamp:1\tfile:Harness-linux-<arch>.AppImage\tdesktop-version:<manifestVersion>')`),
  and each Linux updater gets `tauriPublicKey: signer.publicKey`:
  - `checkOnce carries the Linux entry's signature` — `info.signature` equals the served one.
  - `downloadAndStage stages a signed AppImage` (the existing staging test, signed).
  - `a tampered AppImage whose sha256 the manifest names is refused, and nothing is staged` — bytes changed, `sha256`
    and `size` of the changed bytes, the original signature: `throwsA` reason `file`; no `harness-update-` folder in
    `Directory.systemTemp` that was not there before.
  - `an entry with no signature is refused` — reason `missing`.
  - `the other architecture's signature is refused` — an arm64-commented signature on an x64 updater: reason `comment`.
  - `a refusal logs one line with its reason and no path` — `appLog` set to a recorder: one `warn`, category `update`,
    message `signature refused (file)`.
  - `downloadAndStage verifies a large download off the UI isolate` — the existing 24 MB test with a signature; its
    threshold unchanged, so the BLAKE2b runs off the UI isolate too.
  - In `update_progress_test.dart`, `testWidgets('a Linux update Harness did not sign says so in the banner')`: an
    `AppNotifier` with a real `DesktopUpdater(isLinux: true, isWindows: false, enabled: true, releaseMode: true,
    architecture: 'x64', tauriPublicKey: signer.publicKey, dio: <an adapter serving the tampered bytes>)` and
    `availableUpdate` = the tampered entry; pump `UpdateNotice`; inside `tester.runAsync`, tap
    `Key('install-update-button')` and wait, bounded, until `app.updateError != null`; pump; expect
    `find.text('Could not install Harness 1.2.3: it is not signed by Harness, so it may not be genuine. You are still on your current version.')`
    `findsOneWidget`.
- [ ] **Step 2: Run them to see them fail.** `cd desktop && flutter test test/desktop_updater_test.dart
  test/update_progress_test.dart`. Expected: compile errors (`signature`, `tauriPublicKey`), then once stubbed the
  refusal cases FAIL.
- [ ] **Step 3: Commit the red tests** (`Desktop: a Linux update must be signed by Harness, red`).
- [ ] **Step 4: Implement.** In `downloadAndStage`, after the sha256 matches and before `createTemp`, on Linux (not
  Windows): `checkTauriSignature(info.signature, fileName: 'Harness-linux-$_architecture.AppImage', versionField:
  'desktop-version:${info.version}', digest: () => blake2b512OfBytes(bytes), publicKey: _tauriPublicKey)`; on
  `TauriSignatureRefused` log `appLog.warn('update', 'signature refused (${e.reason.name})')` and rethrow (the existing
  `on UpdateRefused` path). Remove `_signedLikeThisApp`'s unreachable `if (_isLinux) return;` and its comment; the
  `downloadAndStage` and `currentBundlePath` docs say Linux checks the AppImage's signature and name
  `scripts/package-desktop-linux.sh`. macOS and Windows code does not change.
- [ ] **Step 5: Run the two files.** Expected: PASS, the macOS and Windows cases included.
- [ ] **Step 6: Commit** (`Desktop: Linux installs an update only when Harness signed it`).

### Task 4: The Device manifest gives Linux the Tauri signature of the same file

Effort: high. Depends on: nothing.

**Files:**
- Modify: `desktop/lib/devices/device_app_manifest.dart`
- Test: `desktop/test/devices/device_app_manifest_test.dart`

**Interfaces:**
- Produces: `DeviceAppRelease({required url, required sha256, required size, this.version, this.signature})` with
  `final String? version;` (the entry's `version` when it is X.Y.Z, any platform) and `final String? signature;`
  (Linux only, per the decision above; `linux-x86_64` for x64, `linux-aarch64` for arm64).

- [ ] **Step 1: Write the failing tests:**
  - `Linux takes the Tauri signature of the same file from platforms` — `signature` and `version` (`0.2.0`) read.
  - Review Focus 4: `a platforms url naming another file gives no signature` — the url with another version folder,
    in upper case, and with a trailing `/`: the release is still returned, `signature` null.
  - Review Focus 4: `the other arch's platforms entry gives no signature` — x64 with only `linux-aarch64`.
  - Review Focus 5: `an entry with no version, or not X.Y.Z, gives no signature` — `version` absent and `'0.2'`.
  - `macOS and Windows releases carry no signature` — a `platforms` entry of theirs is not read.
- [ ] **Step 2: Run to see them fail.** `cd desktop && flutter test test/devices/device_app_manifest_test.dart`.
  Expected: compile errors, then FAIL.
- [ ] **Step 3: Commit the red tests** (`Desktop: the Device manifest's Linux signature, red`).
- [ ] **Step 4: Implement** in `parseDeviceAppManifest` / `_release`.
- [ ] **Step 5: Run the file.** Expected: PASS.
- [ ] **Step 6: Commit** (`Desktop: the Device manifest names the signature of the Linux AppImage it installs`).

### Task 5: Desktop installs Harness Device on Linux only when it verifies

Effort: xhigh. Depends on: Task 2, Task 4.

**Files:**
- Modify: `desktop/lib/devices/device_app_installer.dart`, `desktop/lib/devices/device_app_setup.dart`,
  `desktop/integration_test/device_app_install_windows_linux_native_test.dart`
- Test: `desktop/test/devices/device_app_installer_test.dart`, `desktop/test/devices/device_app_setup_test.dart`

**Interfaces:**
- Consumes: Task 2's verifier and `TauriTestSigner`; Task 4's `DeviceAppRelease.version` and `.signature`.
- Produces: `DeviceAppInstaller({…, String tauriPublicKey = tauriUpdatePublicKey})` and
  `deviceAppInstallerFor(platform, {…, String tauriPublicKey = tauriUpdatePublicKey})`, which passes it on.

- [ ] **Step 1: Write the failing tests** in `device_app_installer_test.dart`. `publishFor(TargetPlatform.linux, …)`
  also writes `platforms.linux-x86_64` `{url, signature}` (a `TauriTestSigner` signature with
  `timestamp:1\tfile:Harness-Device-linux-x64.AppImage\tversion:0.0.0`), and `onLinux()` passes `tauriPublicKey`:
  - `linux: a signed AppImage lands executable at its place and opens` (the existing case, signed).
  - `linux: an AppImage changed after signing, its sha256 in the manifest, fails at signature` — `failed ==
    DeviceAppInstallStep.signature`, `installedAt` null, nothing at the place, no `chmod` run.
  - `linux: a platforms url naming another file fails at signature`; `linux: no signature fails at signature`;
    `linux: a signature for another version fails at signature`; Review Focus 5: `linux: an entry with no version fails
    at signature`.
  - `linux: a refusal logs one line with its reason and no path` — category `devices`, message
    `device app signature refused (file)`.
  - `linux: a copy already at the place is kept` keeps passing once signed. `linux: no signature step runs` is removed.
  In `device_app_setup_test.dart`, the Linux comment on `deviceAppSignatureCheckFor` says the installer checks the
  AppImage itself; the assertion (it refuses if asked) stays.
- [ ] **Step 2: Run to see them fail.** `cd desktop && flutter test test/devices/device_app_installer_test.dart
  test/devices/device_app_setup_test.dart`. Expected: the refusal cases FAIL (the install succeeds).
- [ ] **Step 3: Commit the red tests** (`Desktop: the Device AppImage must be signed, red`).
- [ ] **Step 4: Implement.** Linux branch: `step = DeviceAppInstallStep.signature;` then
  `checkTauriSignature(release.version == null ? null : release.signature, fileName:
  'Harness-Device-linux-${_architecture ?? runtimeArchitecture}.AppImage', versionField: 'version:${release.version}',
  digest: () => blake2b512OfFile(download), publicKey: _tauriPublicKey)`; a `TauriSignatureRefused` logs the line
  above and fails the step. The class doc and `deviceAppSignatureCheckFor`'s doc no longer say Linux checks no
  signature.
- [ ] **Step 5: Adapt the end-to-end test** (it runs only on CI, Step 7). In `setUpAll`, on Linux, make a
  `TauriTestSigner`, sign the package (`blake2b512OfFile`) with `timestamp:<now>\tfile:Harness-Device-linux-$arch.AppImage\tversion:0.0.0`,
  and add `platforms.linux-<x86_64|aarch64>` `{url, signature}` to the stand-in manifest; `installer()` passes
  `tauriPublicKey: signer.publicKey`. Add, after the checksum case: `linux: a package changed after signing, its sha256
  in the manifest, fails at the signature, and nothing is installed` (`failed == signature`, `installedAt` null, `runs`
  empty, nothing at the place). Add `linux: verifying a 100 MB AppImage` (a 100 MiB file in `root`, signed, then
  `Stopwatch` around `checkTauriSignature` with `blake2b512OfFile`; passes; `debugPrint('signature check: 100 MB in <ms> ms')`).
  The header comment says Linux's signature step is the real one, with a key made for the run.
- [ ] **Step 6: Run the unit tests and analyze.** The Step 2 command PASSES; `flutter analyze lib/devices
  integration_test/device_app_install_windows_linux_native_test.dart` is clean.
- [ ] **Step 7: Commit** (`Desktop: Linux installs Harness Device only when its Tauri signature verifies`). The
  end-to-end change is proven by PR CI's `device-app-desktop` (Verification 3).

### Task 6: The release's Python check of a Tauri signature

Effort: xhigh. Depends on: nothing.

**Files:**
- Modify: `scripts/verify-desktop-release.py`, `scripts/tests/desktop_publication_fixture.py`
- Create: `scripts/tests/test_desktop_signature.py`

**Interfaces:**
- Produces, in `verify-desktop-release.py`:
  - `SIGNED = {"desktop-linux-x64": "Harness-linux-x64.AppImage", "desktop-linux-arm64": "Harness-linux-arm64.AppImage"}`
  - `class SignatureRefused(ValueError)` with `.reason` (one of the six); `str()` is `signature refused (<reason>)`.
  - `pinned_public_key() -> str` — `plugins.updater.pubkey` of `ROOT / "device-app" / "src-tauri" / "tauri.conf.json"`.
  - `parse_signature(text) -> (key_id: bytes, file_signature: bytes, trusted_comment: str, global_signature: bytes)`,
    raising `SignatureRefused("missing" | "malformed")`.
  - `verify_minisign(signature, digest: bytes, public_key=None) -> str` — shape, key, global, file; returns the trusted
    comment.
  - `check_signature(signature, digest, file_name, version, public_key=None)` — `verify_minisign`, then the comment
    holds `file:<file_name>` and `desktop-version:<version>` and no field starting with `version:`, else `comment`.
  - `ed25519_verify(public_key: bytes, message: bytes, signature: bytes) -> bool` — `openssl pkeyutl -verify -pubin
    -inkey <pem> -rawin -in <message> -sigfile <signature>` in a temporary folder (DER prefix
    `302a300506032b6570032100` + the 32 bytes); `RuntimeError("OpenSSL 3 is required to check signatures")` unless
    `openssl version` starts with `OpenSSL 3`.
  - `main`: `--signed PATH [PATH ...]` checks each `PATH` (its name one of `SIGNED`'s values) against `PATH.sig` with the
    pinned key, prints `<name>: signature verified` or `error: <name>: signature refused (<reason>)` and exits 1;
    writes no receipt. No option names a key.
- Produces, in `desktop_publication_fixture.py`: `class FixtureSigner` (`__init__(self, folder)` makes an Ed25519 key
  with `openssl genpkey -algorithm ed25519`; `.public_key` in Tauri's form; `.sign(data: bytes, comment: str, *,
  algorithm=b"ED", key_id=None) -> str` in Tauri's form) and `desktop_comment(file_name, version) ->
  "timestamp:1795200000\tfile:<file_name>\tdesktop-version:<version>"`.

- [ ] **Step 1: Write the failing tests** in `test_desktop_signature.py`, one `FixtureSigner` per test class, over the
  BLAKE2b-512 of a fixed payload: a good signature passes; a changed digest → `file`; another key → `key`; Review Focus
  1 (another key's signature with this key's id) → `global`; a broken global signature and an edited comment →
  `global`; a Device comment (`file:Harness-Device-linux-x64.AppImage\tversion:0.1.12`) → `comment`; a Desktop comment
  that also carries `version:1.2.3` → `comment`; Review Focus 2 look-alikes (`Harness-linux-x64.AppImage.old`,
  `desktop-version:1.2.30`) → `comment`; algorithm `Ed` → `malformed`; `None`, `""`, garbage, 4097 characters →
  `missing` / `malformed`; the live Device 0.1.11 signature (`platforms.darwin-aarch64.signature`, committed as a
  constant) and digest (Task 2's hex) pass `verify_minisign` with the pinned key and return
  `timestamp:1795156839\tfile:Harness Device.app.tar.gz\tversion:0.1.11`; `main(["1.2.3", "--signed", <AppImage signed
  by the fixture key>])` returns 1 and prints `signature refused (key)`; the parser has `--signed` and no option whose
  name contains `key` or `pub`.
- [ ] **Step 2: Run to see them fail.** `python3 -m unittest scripts/tests/test_desktop_signature.py` (OpenSSL 3 on
  PATH). Expected: FAIL (`AttributeError`).
- [ ] **Step 3: Commit the red tests** (`Release: the Python check of a Tauri signature, red`).
- [ ] **Step 4: Implement** the functions, `FixtureSigner` and `desktop_comment`. `entries_for_version`, `verify` and
  `verify_artifact` do not change here (Task 7).
- [ ] **Step 5: Run the file and `test_desktop_verification.py`.** Expected: PASS.
- [ ] **Step 6: Commit** (`Release: check a Tauri signature against the key Harness Device pins`).

### Task 7: Publish, promotion and the public check carry and check Linux signatures

Effort: xhigh. Depends on: Task 6.

**Files:**
- Modify: `scripts/verify-desktop-release.py`, `scripts/desktop-release-candidate.py` (`seal`, `promote`),
  `scripts/check-desktop-publication-gcs.py`, `scripts/check-desktop-candidate-gcs.py`,
  `scripts/tests/desktop_publication_fixture.py` (`make_parts`)
- Test: `scripts/tests/test_desktop_verification.py`, `scripts/tests/test_desktop_publication.py`,
  `scripts/tests/test_desktop_release_candidate.py`

**Interfaces:**
- Consumes: Task 6's functions, `FixtureSigner`, `desktop_comment`.
- Produces: `entries_for_version` refuses a `SIGNED` key in `keys` whose `signature` does not parse
  (`ValueError("<key>: signature refused (<reason>)")`); `download(entry, timeout) -> (size, sha256, blake2b)`;
  `verify_artifact(item, timeout, public_key=None)` checks `SIGNED` entries after the sha256
  (`check_signature(entry["signature"], blake2b, SIGNED[key], entry["version"], public_key)`);
  `verify(version, manifest_url=MANIFEST, jobs=3, timeout=90, public_key=None)`; `seal(version, bucket, prefix, parts,
  identity, public_key=None)`; `promote` refuses, before any write, a receipt whose `artifacts` fail
  `entries_for_version`, and writes `signature` into the Linux parts; `make_parts(directory, version, base_url, signer)`
  signs each Linux entry's payload with `desktop_comment(SIGNED[key], version)`.

- [ ] **Step 1: Write the failing tests:**
  - `test_desktop_verification.py`: the manifest's Linux entries are signed by a `FixtureSigner` over `self.payload`,
    and `run_verification` passes `public_key`. New: `a Linux download whose signature does not verify fails, naming the
    reason` (a signature of other bytes: the artifact's `error` is `signature refused (file)`, receipt failed);
    `a Linux entry with no signature fails before any download` (no artifact request made); `without a key argument,
    the pinned key decides` (both Linux artifacts fail `signature refused (key)`).
  - `test_desktop_publication.py`: `make_parts(…, signer)`; a `no-signature` change in
    `test_missing_extra_wrong_platform_and_mixed_version_parts_fail_before_gcs` (exit non-zero, manifest untouched); the
    complete-manifest test asserts each Linux entry's `signature` is the part's.
  - `test_desktop_release_candidate.py`: `make_receipt` signs its Linux entries; the promotion test asserts the Linux
    parts carry `signature`; `promotion refuses a receipt whose Linux entry has no signature before any write`
    (`gcloud` never called); sealing passes `public_key` through to `verify_artifact`.
- [ ] **Step 2: Run to see them fail.** `python3 -m unittest scripts/tests/test_desktop_verification.py
  scripts/tests/test_desktop_publication.py scripts/tests/test_desktop_release_candidate.py` (with the `GIT_CONFIG_*`
  prefix). Expected: the new cases FAIL.
- [ ] **Step 3: Commit the red tests** (`Release: Linux entries carry a checked signature, red`).
- [ ] **Step 4: Implement**, and in both `check-desktop-*-gcs.py` make one `FixtureSigner` in their temporary folder,
  sign the Linux fakes and pass `public_key=signer.public_key` to `verify` and `seal` (the candidate check imports the
  fixture as the publication check does).
- [ ] **Step 5: Run the three files and `test_desktop_signature.py`.** Expected: PASS.
- [ ] **Step 6: Commit** (`Release: publish and promotion carry Linux signatures; the public check verifies them`).

### Task 8: The signing script

Effort: xhigh. Depends on: nothing.

**Files:**
- Create: `desktop/scripts/sign-desktop-linux.sh`, `scripts/tests/test_desktop_linux_signing.py`

**Interfaces:**
- Produces: `bash desktop/scripts/sign-desktop-linux.sh <X.Y.Z> <folder>` — for x64 then arm64, checks
  `Harness-linux-<arch>.AppImage` against `Harness-linux-<arch>.AppImage.sha256` (`sha256sum --check`), signs it with
  `minisign -S -s <key file> -m <AppImage> -x <tmp>.minisig -t <comment>` (password on stdin) and writes
  `Harness-linux-<arch>.AppImage.sig` (Tauri's form). Requires `TAURI_SIGNING_PRIVATE_KEY` non-empty and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` set; the key file is made with `umask 077` under `${RUNNER_TEMP:-$TMPDIR}` and
  removed on exit, failure included.

- [ ] **Step 1: Write the failing tests.** A fake `minisign` on PATH records its argv, its stdin, the key file's bytes
  and whether that file is 0600, and writes a fixed `.minisig` to `-x`:
  - `signs both AppImages with a comment naming the file and the Desktop version and no version field` — each `-t`
    splits on tabs into `timestamp:<digits>`, `file:Harness-linux-<arch>.AppImage`, `desktop-version:1.2.3`; no field
    starts with `version:`; each `.sig` is the fake `.minisig` base64-encoded on one line.
  - `the key and its password reach minisign through a file and stdin only` — neither secret in any argv, stdout or
    stderr; stdin is the password and a newline; the file held the base64-decoded key, mode 0600; after the run no file
    of the script's is left in `RUNNER_TEMP`.
  - `an AppImage whose sums do not match signs nothing`; `no key signs nothing`; `a minisign failure leaves no key
    file` (the fake exits 1).
- [ ] **Step 2: Run to see them fail.** `python3 -m unittest scripts/tests/test_desktop_linux_signing.py`. Expected:
  FAIL (no script).
- [ ] **Step 3: Commit the red tests** (`Release: the Linux signing script, red`).
- [ ] **Step 4: Implement** (`set -euo pipefail`, `set +x`; the key decoded with `printf '%s' … | base64 --decode`, the
  password with `printf '%s\n' … |`, builtins, so no process argv holds them; the header says why it runs nothing but
  minisign and why the check is a separate step).
- [ ] **Step 5: Run the file.** Expected: PASS.
- [ ] **Step 6: Commit** (`Release: sign the Linux AppImages with the Tauri key, nothing else running`).

### Task 9: Build and package with no credential; upload with no key

Effort: high. Depends on: nothing.

**Files:**
- Create: `desktop/scripts/package-desktop-linux.sh`, `scripts/tests/test_desktop_linux_packaging.py`
- Modify (rewrite): `desktop/scripts/upload-desktop-linux.sh`

**Interfaces:**
- Produces: `bash desktop/scripts/package-desktop-linux.sh <X.Y.Z>` — Linux only, the host's arch; `flutter build linux
  --release`, `version.txt`, the AppDir and `appimagetool` (`APPIMAGETOOL`) exactly as the old script's steps 2–3; writes
  only `desktop/build/linux-release/Harness-linux-<arch>.AppImage` and its `.sha256`; names no `gcloud`, `gs://`,
  `curl`, `secrets` or `TAURI_SIGNING`.
- Produces: `bash desktop/scripts/upload-desktop-linux.sh <X.Y.Z> <folder>` — `upload-desktop-windows.sh`'s environment
  and checks (`GCS_BUCKET`, the three `ARTIFACT_PREFIX` forms, `SCRATCH_PREFIX`, `CDN_ASSET_BASE_URL`); for each arch
  checks the sums and that the `.sig` is one line of base64; uploads each AppImage create-only with the `gcs_cp
  "$OUTPUT" …` line (decision above); writes `linux-<arch>.json` = `{"desktop-linux-<arch>": {"version", "url", "sha256",
  "size", "signature"}}` to `SCRATCH_PREFIX` create-only. No key, no bump, no by-hand flags.

- [ ] **Step 1: Write the failing tests** (a fake `gcloud` recording each `cp` and the file it copied):
  - `uploads both AppImages create-only and writes each part with its signature` — the parts equal the expected
    objects, URL `${CDN_ASSET_BASE_URL}/${ARTIFACT_PREFIX}/Harness-linux-<arch>.AppImage`; every `cp` has
    `--if-generation-match=0`.
  - `an AppImage whose sums do not match uploads nothing`; `a missing or two-line signature uploads nothing`;
    `a prefix that is no release's, candidate's or promotion check's uploads nothing`.
  - `the build script holds no credential and names no bucket` (its text).
  - `the build script packages the bundle with its sums` — Linux only (`skipUnless`), the script copied into a temporary
    `desktop/scripts/`, fake `flutter` (writes the bundle with `harness` and `harness.png`) and `appimagetool` (writes its
    output) on PATH: the `.AppImage` and a `.sha256` that `sha256sum --check` accepts.
- [ ] **Step 2: Run to see them fail.** `python3 -m unittest scripts/tests/test_desktop_linux_packaging.py
  scripts/tests/test_desktop_publication.py`. Expected: the new cases FAIL; the publication file's upload-command test
  still PASSES.
- [ ] **Step 3: Commit the red tests** (`Release: Linux packaging and upload apart, red`).
- [ ] **Step 4: Implement** the two scripts.
- [ ] **Step 5: Run the Step 2 command.** Expected: PASS.
- [ ] **Step 6: Commit** (`Release: Linux builds with no credential, and uploads with no key`).

### Task 10: `release-desktop.yml` builds, signs and uploads Linux in three jobs

Effort: xhigh. Depends on: Task 6, Task 8, Task 9.

**Files:**
- Modify: `.github/workflows/release-desktop.yml`, `scripts/desktop-release-candidate.py` (`check_jobs`,
  `BUILD_INPUTS`)
- Create: `scripts/tests/test_desktop_release_workflow.py`
- Test: `scripts/tests/test_desktop_release_candidate.py`

**Interfaces:**
- Consumes: Task 6's `--signed`; Tasks 8 and 9's scripts and artifact names.
- Produces: jobs `build-linux` (matrix as today), `sign-linux`, `upload-linux`. `check_jobs`' required set gains
  `sign-linux` and `upload-linux`; `BUILD_INPUTS` gains `'device-app/scripts/release-setup.sh': 'blob'` and
  `'device-app/src-tauri/tauri.conf.json': 'blob'`.

- [ ] **Step 1: Write the failing tests** in `test_desktop_release_workflow.py`, reading jobs as
  `device-app/scripts/test_release_workflow.py` does (comment lines left out):
  - `build-linux runs build code with no secret, no GCP and no token` — no `secrets.`, `google-github-actions/auth`,
    `setup-gcloud` or `TAURI_SIGNING`; `permissions:` is `contents: read` alone; it runs `package-desktop-linux.sh` and
    uploads `desktop-linux-${{ matrix.arch }}`.
  - `sign-linux holds the key and runs no build code` — `needs: [version, build-linux]`; `permissions: contents: read`;
    its sparse checkout is exactly `/desktop/scripts/sign-desktop-linux.sh`, `/scripts/verify-desktop-release.py`,
    `/device-app/scripts/release-setup.sh`, `/device-app/src-tauri/tauri.conf.json`; steps in order: `release-setup.sh
    minisign`, the download, the signing step (the only step naming `TAURI_SIGNING_PRIVATE_KEY` and `_PASSWORD`), the
    `--signed` check of both AppImages, the upload of `desktop-linux-signatures`; no `flutter`, `apt`, `auth` or
    `gcloud`.
  - `upload-linux holds GCP and no key` — `needs: [version, build-linux, sign-linux]`; the GCP auth step;
    `upload-desktop-linux.sh "$VERSION"`; no `TAURI_SIGNING`.
  - `build-windows runs build code with no token` — its `permissions:` is `contents: read` alone; no `secrets.`,
    `google-github-actions/auth` or `setup-gcloud`.
  - `no other job names the signing key`.
  - `publish, candidate and cleanup wait for the Linux upload` — `publish` and `candidate` require
    `needs.upload-linux.result == 'success'` where they required `build-linux`'s; `cleanup`'s `needs` hold `sign-linux`
    and `upload-linux`; `publish`'s and `candidate`'s checkouts hold `/device-app/src-tauri/tauri.conf.json`.
  - In `test_desktop_release_candidate.py`: `check_jobs` requires `sign-linux` and `upload-linux`;
    `test_native_checkout_inputs_are_all_covered_by_the_reuse_contract` also covers `sign-linux` and `upload-linux`;
    the tree fixtures hold the two new inputs.
- [ ] **Step 2: Run to see them fail.** `python3 -m unittest scripts/tests/test_desktop_release_workflow.py
  scripts/tests/test_desktop_release_candidate.py`. Expected: FAIL.
- [ ] **Step 3: Commit the red tests** (`Release: Linux build, sign and upload apart, red`).
- [ ] **Step 4: Change the workflow and the candidate contract.** `build-linux` loses the GCP steps and its upload
  environment; `sign-linux` and `upload-linux` as the tests say (`runs-on: ubuntu-latest`, `timeout-minutes` 10 and
  15, `actions/download-artifact@v4` `pattern: desktop-linux-*` `merge-multiple: true`, the signatures uploaded with
  `overwrite: true`). `build-windows` gains job-level `permissions: contents: read` with a one-line comment (its build
  code must not mint the GCP token); `build-macos` does not change. The header comment describes the Linux jobs.
  Validate: `GOTOOLCHAIN=go1.26.8 go run
  github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 .github/workflows/release-desktop.yml`.
- [ ] **Step 5: Run the Step 2 command, and `python3 -m unittest discover -s device-app/scripts -p
  'test_release_workflow.py'`.** Expected: PASS.
- [ ] **Step 6: Commit** (`Release: Linux is built with no credential, signed apart, and uploaded with no key`).

### Task 11: The docs say how Linux is signed and checked

Effort: high. Depends on: Task 3, Task 5, Task 10. Red test: none (docs, comments and the by-hand target's removal).
One commit.

**Files:**
- Modify: `desktop/RELEASE.md`, `desktop/README.md`, `desktop/CLAUDE.md`, `desktop/Makefile`, `Makefile`,
  `desktop/lib/core/app_version.dart`, `mobile/lib/core/app_version.dart`, `device-app/RELEASE.md`,
  `docs/validation-and-release.md`

- [ ] **Step 1: `desktop/RELEASE.md`.** "Publishing by hand": no Linux line; Linux releases go through
  `release-desktop.yml` alone (signing needs a key no person holds). Self-update step 4: Linux checks the AppImage's
  Tauri signature against the key pinned in the app. "Linux": `build-linux` → `sign-linux` → `upload-linux`, what each
  holds and runs, the trusted comment and why it has no `version:` field; no "No signing step" paragraph; the GCS layout
  example gains `signature`; "How a running Linux app self-updates" gains the signature step and its sentence;
  "Rolling out safely / rollback" (Linux) gains the rollout order (the first signed release before a build that
  requires one) and that the first Desktop release after this change runs `release-desktop.yml` with
  `test_publication=true` before the real one, since it is the first real run of the changed publication checks.
- [ ] **Step 2: The rest.** `desktop/Makefile`: no `upload-desktop-linux` target or `.PHONY` entry; `Makefile`'s
  release comment drops it; `desktop/README.md` drops its three lines; `desktop/CLAUDE.md` names
  `package-desktop-linux.sh` for packaging, drops the Linux by-hand hatch, and says the updater checks Linux's Tauri
  signature; both `app_version.dart` comments name `scripts/package-desktop-linux.sh`; `device-app/RELEASE.md`'s key
  paragraph says the same key signs Desktop's Linux AppImages (`release-desktop.yml` `sign-linux`) and Desktop pins its
  public half too, so a new key is a release of both apps; `docs/validation-and-release.md`'s `device-app-desktop` row
  says the Linux legs install a package signed with a key made for the run.
- [ ] **Step 3: Commit** (`Docs: Linux Desktop releases are signed, and checked before they install`).

## Verification

Nothing here reaches production, a real account or the real signing key: loopback stand-ins, throwaway keys made in
the run, disposable containers. Public reads only: the live Device 0.1.11 manifest and archive (Task 2's fixture, read
once, already done) and minisign's pinned GitHub release.

1. **Local, at the end, on the Mac.** `cd desktop && flutter test test/tauri_signature_test.dart
   test/desktop_updater_test.dart test/update_progress_test.dart test/devices/device_app_manifest_test.dart
   test/devices/device_app_installer_test.dart test/devices/device_app_setup_test.dart && flutter analyze`; with
   OpenSSL 3 first on PATH and the `GIT_CONFIG_*` prefix, `python3 -m unittest` on the test files Tasks 1 and 6–10
   touched (`test_ci_plan`, `test_ci_source_inputs`, `test_desktop_signature`, `test_desktop_verification`,
   `test_desktop_publication`, `test_desktop_release_candidate`, `test_desktop_linux_signing`,
   `test_desktop_linux_packaging`, `test_desktop_release_workflow`) and on `device-app/scripts/test_release_workflow.py`;
   actionlint on `release-desktop.yml` and `ci.yml` (Task 10's command). All pass; full suites run on CI. Then the required local
   receipts once: `python3 scripts/local-checks.py --run` at the final head, its output pasted into the PR body as it
   is, before the push that marks it ready. It maps none of this branch's paths today; no extra `make desktop-test`
   (no macOS-only code changes).
2. **The signing script on Linux, local, in Podman** (arm64 natively; x64 with `--platform linux/amd64` if the Podman
   machine emulates it). On the Mac, in the session scratchpad: `cargo tauri signer generate --ci -p pw -w
   throwaway.key`, two 1 MiB random files named `Harness-linux-x64.AppImage` and `Harness-linux-arm64.AppImage` and
   their `.sha256`. In a fresh `ubuntu:24.04` container with the repository mounted read-only and the scratch folder
   read-write: `apt-get install -y curl ca-certificates python3 openssl`; `GITHUB_ACTIONS=true RUNNER_TEMP=/tmp/rt
   GITHUB_PATH=/tmp/rt/path bash device-app/scripts/release-setup.sh minisign` (the pinned 0.12, sha256-checked), its
   folder on PATH; `TAURI_SIGNING_PRIVATE_KEY="$(cat throwaway.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=pw
   RUNNER_TEMP=/tmp/rt bash desktop/scripts/sign-desktop-linux.sh 1.2.3 /scratch`. Seen: two `.sig` files, nothing of the
   key left in `/tmp/rt`; `python3 scripts/verify-desktop-release.py 1.2.3 --signed /scratch/Harness-linux-*.AppImage`
   exits 1 with `signature refused (key)` (the pinned key decides, nothing overrides it). Back on the Mac, a scratch
   test `desktop/test/zz_linux_signing_check_test.dart` (made for this check, deleted after, never committed) runs
   `checkTauriSignature` on each pair with `fileName` the file's name, `versionField: 'desktop-version:1.2.3'` and the
   throwaway public key: passes; with the default key: `key`. The container is removed.
3. **PR CI** (open as a draft, then ready). The plan selects `desktop`, `device-app`, `device-app-desktop`, `mobile`,
   `cross-read-scan` and `process-checks`. **`device-app-desktop` is the end-to-end check**: the four Device builds,
   then Desktop installs this run's Device package on `ubuntu-22.04` and `ubuntu-22.04-arm` (and on `windows-latest`
   and `windows-11-arm`, unchanged). Seen in the Linux legs: the signed install passes, `a package changed after
   signing … fails at the signature` passes, and `signature check: 100 MB in <n> ms`. `ci/required` green. To run it
   again by hand: **Actions → CI → Run workflow**, `scope=device-app-desktop`. No new workflow.
4. **The release workflow on GitHub: not run on this branch**, `test_publication=true` included: a `--prepare` run
   writes candidates to the release bucket, and the publication checks write disposable objects there. Its jobs are
   held by Task 10's tests, its scripts by Tasks 6–9's and by check 2. The first real signed release is the next
   Desktop release, when Ken asks. The PR body says: the first Desktop release after this merges runs
   `release-desktop.yml` with `test_publication=true` before the real one (the only real run of the changed
   `check-desktop-*-gcs.py` scripts), and states the rollout order (Task 11 writes both into `desktop/RELEASE.md`).
5. **Numbers for the PR body.** From check 3's two Linux legs: the 100 MB BLAKE2b-512 + Ed25519 time on x64 and arm64
   (debug runner); before, 0 ms (no check).
6. **Two independent security reviews** (docs/validation-and-release.md), since `scripts/ci-plan.py` and
   `scripts/record-ci-validation.py` change: phase 4's final review, and a second fresh reviewer on those two files'
   change. No task.
7. **Follow-up the PR names.** `build-macos` still builds, uses the Apple keychain and uploads to GCP in one step
   under the workflow's `id-token: write`; splitting it is out of this change.

No check needs the user's own login or eye.
