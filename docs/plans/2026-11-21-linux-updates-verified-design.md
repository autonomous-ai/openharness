# Linux updates are verified

Branch `fix/linux-updates-verified`. Security fix. One pull request.

## Why

Harness Desktop on Linux trusts the release bucket alone. The manifest
(`harness/desktop/metadata.json`) names each AppImage's URL and its sha256 in the same bucket, so whoever can write to
the bucket can make every installed Linux Desktop update itself to their build, and can make Desktop install their
build as Harness Device. macOS and Windows do not have this hole: the Desktop updater there requires the running app's
own Developer ID or Authenticode signer (`desktop/lib/update/update_signature.dart`), and Harness Device's own updater
requires its Tauri minisign signature with a key pinned in the app (`device-app/src-tauri/tauri.conf.json`).

Today, on Linux:

- `desktop_updater.dart` `_signedLikeThisApp` returns at once ("Linux AppImages carry no signature, so Linux keeps
  the sha256 check").
- `device_app_installer.dart` installs the Device AppImage after the sha256 check alone ("Linux checks no signature").
- `release-desktop.yml` `build-linux` authenticates to GCP before it runs `flutter build` and `appimagetool`, so build
  code (pub packages, CMake, the unpinned-by-hash appimagetool download) runs holding bucket write.

A signature only protects where the key that checks it is pinned somewhere the bucket writer cannot change: in a
shipped binary. That is the scope.

## Decisions already made

By the orchestrator for Ken, 2026-11-21:

1. **Reuse the Tauri updater key** of Harness Device for the Desktop Linux AppImage. No new secret: the repository
   secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` already exist (repo-level:
   `release-device.yml`'s `build` job reads them with no `environment`). Key id `4739BFCC687B1F62`.
2. **Sign in an isolated step** that runs only a pinned signer, never build code, with a trusted comment that binds
   product, file and version.
3. **Include both Linux paths in Desktop**: the Desktop updater on Linux verifies its own signature, and Desktop
   installing Harness Device on Linux verifies the Device's signature.
4. **Split the GCS upload out of `build-linux`**: build code never holds bucket write.
5. **The one-line install scripts stay on the CDN, unchanged** (Ken, 2026-11-21): no signature check inside
   `website/scripts/desktop-install.sh` or `device-install.sh`, no move to the web app, no codesign step on macOS.
   A key pinned in a script served from the same bucket adds nothing.
6. **The CLI's installers and updater are a separate item**, not this branch (same gap, about three times the size:
   five manifests, `install.ps1`, the daemon's self-update).

## Goals

- Every Linux Desktop release AppImage carries a minisign signature made with the Tauri key, published in its
  manifest entry.
- A Linux Desktop installs an update only when that signature verifies against the key pinned in the app, and its
  trusted comment names this file and this version.
- Desktop on Linux installs Harness Device only when the Device AppImage's Tauri signature verifies against the same
  pinned key, for that file and that version.
- No job that runs build code holds GCS write, and no job that runs build code holds the signing key.
- A refusal is seen: the person reads why in the existing banner or row, and the log has a line with no content.

## Non-goals

- The one-line install scripts (decision 5), the CLI and its runtimes (decision 6).
- macOS and Windows: their checks stay exactly as they are.
- Rollback protection: an old, genuinely signed release with a matching manifest still installs. The updater already
  takes only strictly newer versions; the Device installer takes what the manifest names.
- Key rotation machinery. One pinned key; rotating it is a new release of Desktop.

## Anti-goals

- A key, a switch or an environment variable that lets a release build trust another key, or skip the check.
- The private key, its password or a decrypted copy reaching a log, an artifact, a file left on a runner, or any step
  that runs build code.
- A Linux Desktop that can no longer update: the first signed release must be in place before any build that requires
  a signature is published (Rollout).

## The signature

The minisign format, as Tauri writes it for Harness Device (verified on 2026-11-21 against the live Device 0.1.11
macOS archive):

- The manifest value is the `.minisig` file's text, base64-encoded, exactly as `platforms.*.signature` in the Device
  manifest.
- Decoded, four lines: an untrusted comment (ignored); the signature line, base64 of `ED` (2 bytes: Ed25519 over the
  BLAKE2b-512 of the file, "prehashed"), the key id (8 bytes) and the signature (64 bytes); `trusted comment: ` and
  its text; the global signature (64 bytes, base64), Ed25519 over the 64 signature bytes followed by the trusted
  comment's text.
- The trusted comment is tab-separated `key:value` fields. Tauri writes `timestamp:<unix>`, `file:<name>`,
  `version:<X.Y.Z>`.

A signature is accepted only when all of these hold:

1. it decodes to that shape, with algorithm `ED` (the legacy, non-prehashed `Ed` is refused);
2. its key id is the pinned key's;
3. the file signature verifies over BLAKE2b-512 of the exact bytes that will be installed;
4. the global signature verifies over the signature and the trusted comment;
5. the trusted comment's `file:` is the expected file name and its version field the expected version (each field
   matched whole, among the tab-separated fields, as `device-app/scripts/release-check.sh` matches `version:`).

Expected values:

| Path | `file:` | version field |
| --- | --- | --- |
| Desktop updater, Linux | `Harness-linux-<x64\|arm64>.AppImage` | `desktop-version:<the manifest entry's version>`, and no `version:` field |
| Desktop installs Device, Linux | the Device AppImage's name as `release-build.sh sign-update` signs it (the builder confirms it is `Harness-Device-linux-<x64\|arm64>.AppImage`; if Tauri writes another name, that name) | `version:<the Device manifest entry's version>` |

One key signs both products, so the comment binds the product both ways:

- Desktop checks `file:`, so a Device signature never passes for a Desktop file, nor a Desktop one for a Device file.
- Harness Device's own updater (`tauri-plugin-updater` 2.14.1 with `requireSignedVersion: true`) reads only a whole
  `version:` field (`signed_version` in its `updater.rs`) and refuses a signature without one. A Desktop signature has
  no `version:` field, so a bucket writer cannot make Linux Devices replace themselves with a genuine Desktop AppImage
  (found by the builder check, 2026-11-21). The Device app is not changed.

## Part 1: the Desktop release signs its Linux AppImages

`release-desktop.yml` today: `build-linux` (x64, arm64) authenticates to GCP, then `desktop/scripts/upload-desktop-linux.sh`
resolves the version, builds, packages, uploads the AppImage to the run's artifact prefix and writes a scratch manifest
(`linux-<arch>.json`) that `publish` merges into the live manifest.

New shape, three jobs per arch, the Windows desktop pattern (`build-windows` → `sign-windows` → `upload-windows`):

- **`build-linux`**: no GCP authentication and no secret. Builds and packages the AppImage as today and keeps it, with
  its sha256 and size, as a run artifact. Nothing else.
- **`sign-linux`**: a fresh runner. Checks the artifact against the sums its build recorded, installs only a pinned
  signer, and signs the AppImage with the Tauri key, the trusted comment
  `timestamp:<unix>\tfile:Harness-linux-<arch>.AppImage\tdesktop-version:<X.Y.Z>` (no `version:` field: see The
  signature). Then it verifies what it wrote against the
  public key in the repository (the five conditions above) before handing the signature on. No checkout of build code
  runs here; no GCP credential.
- **`upload-linux`**: a fresh runner with GCP credentials and no signing key. Checks the AppImage against its sums,
  uploads it to the artifact prefix (refusing to overwrite, as today), and writes the scratch manifest entry with
  `version`, `url`, `sha256`, `size` and `signature`.

`publish`, `candidate`, `cleanup` and `publication-test` take the new job names in their `needs` and keep their
conditions' meaning. `publish-desktop-manifest.py` carries `signature` through for the Linux entries and refuses a
Linux entry without one; so does the candidate path (`desktop-release-candidate.py` `promote()` keeps only `version`,
`size` and `sha256` today and must carry `signature`). The release's own post-publish verification
(`verify-desktop-release.py` or the step that checks public downloads) also checks each Linux signature against the
pinned key, so a release can never publish one the apps would refuse.

The disposable checks (`publication-test`: `check-desktop-publication-gcs.py`, `check-desktop-candidate-gcs.py`,
fixtures from `desktop_publication_fixture.make_parts`) run the real `publish()` and `verify()` on fake Linux entries.
They sign their fakes with a throwaway key made in the run and pass its public key to the Python verifier as a
function argument. The command-line entry points always use the key pinned in the repository: no flag or environment
variable names another (builder check, 2026-11-21; the anti-goal on other keys is about what a release trusts, and a
release run never takes this argument). The real signing key stays in `sign-linux` alone.

The signer: minisign 0.12, the build `device-app/scripts/release-setup.sh minisign` already fetches pinned by sha256,
reads the Tauri key after base64 decoding and its password on stdin (checked on 2026-11-21: `minisign -S -s <key> -t
<comment>` with a key from `cargo tauri signer generate`, prehashed `ED` output, and openssl 3 verifies it). The key and
password reach the signer only through its stdin or a file in `$RUNNER_TEMP` that the step deletes, never argv or a
log. The builder may use the Tauri CLI's signer instead if it is simpler; the format is the same.

`desktop/scripts/upload-desktop-linux.sh` splits along the same line: building and packaging in one script that holds
no credential, uploading and the scratch manifest in another. The by-hand path (`make upload-desktop-linux` on an
Ubuntu host) can no longer make a release the apps accept, since signing needs the key a person must not hold: it is
removed, and `desktop/RELEASE.md` says Linux releases go through `release-desktop.yml` alone. (Builder's call
recorded here: this removes an escape hatch; the release workflow already builds Linux on every release.)

The same cause on the other build jobs (orchestrator, 2026-11-21): the workflow grants `id-token: write` to every job,
so build code can mint the token the GCP federation accepts. `build-windows` holds no secret and no GCP step: it gets
job-level `permissions: contents: read`, as `build-linux` and `sign-linux` do. `build-macos` builds, signs, notarizes
and uploads in one step with the Apple keychain and GCP credentials; splitting it is more than moving the token, so it
is listed in the pull request as a follow-up, not done here.

The first Desktop release after this merges runs `release-desktop.yml` with `test_publication=true` before the real
one (the orchestrator holds the release to it): it is the only real run of the changed publication checks, and it
writes disposable objects to the release bucket, so this branch never runs it.

## Part 2: the Desktop updater on Linux verifies

`desktop/lib/update/desktop_updater.dart`:

- `UpdateInfo` gains `signature` (nullable). The Linux entry reads it from the manifest; macOS and Windows entries
  ignore it.
- On Linux, after the size and sha256 checks and before anything is written to the staging folder, the downloaded bytes
  must pass the shared verifier (below) with `file: Harness-linux-<arch>.AppImage` and `version: <info.version>`. A
  missing or failing signature throws `UpdateRefused`, as macOS and Windows refusals do, so the banner says why and
  nothing is staged.
- The check runs on every Linux build, release or not: the key is pinned in the code, so there is no "unsigned running
  app" case as on macOS and Windows. Tests inject their own key through the verifier's seam.
- Copy (the banner prints "Could not install Harness X: " before it): one short sentence in the voice of the existing
  ones, e.g. "it is not signed by Harness, so it may not be genuine. You are still on your current version."

## Part 3: Desktop installs Harness Device on Linux only when it verifies

`desktop/lib/devices/`:

- The Device manifest's Linux entry (`device-linux-<arch>-appimage`, Desktop's shape) carries no signature; the
  Tauri signature of the same file is in `platforms.linux-<x86_64|aarch64>.signature`, beside its `url`. The installer
  reads that signature, and refuses unless that `platforms` entry's `url` is the entry's `url` (both name the same
  file). No change to `device-manifest.py` or the Device release: the signature has shipped since the Device's first
  Linux release.
- `DeviceAppInstaller.install()`, Linux: after the checksum step, a `signature` step verifies the downloaded file with
  the shared verifier (`file:` and `version:` per the table), before the AppImage is placed. A failure is
  `DeviceAppInstallStep.signature`, whose row already reads "Couldn’t verify the download."
- `deviceAppSignatureCheckFor(TargetPlatform.linux)` and the comments that say Linux checks no signature change to
  match.

## The shared verifier

One Dart function, in `desktop/lib/update/` beside `update_signature.dart`, used by Parts 2 and 3 and nowhere
duplicated: given the signature text (base64, as in the manifests), the expected `file:` and `version:`, and the bytes
or a file path, it returns or throws `UpdateRefused`. Ed25519 and BLAKE2b-512 from the `cryptography` package Desktop
already depends on (`DartEd25519`, `DartBlake2b`); no new dependency. BLAKE2b over a 100 MB AppImage runs off the UI
isolate (`Isolate.run`, as `sha256HexOffUiIsolate` does), streamed from the file for Part 3.

The pinned public key is one constant in that file. A Desktop test holds it equal to `device-app/src-tauri/tauri.conf.json`'s
`plugins.updater.pubkey`, so the two pins cannot drift; `scripts/ci-plan.py`'s `PR_READS` gains that read, so a change
to `tauri.conf.json` runs Desktop's tests.

## Rollout

Order matters, because a new Linux Desktop refuses an unsigned update:

1. This pull request merges.
2. The next Desktop release is the first with signed Linux entries. Linux apps already installed update to it on
   sha256 alone, as today; from then on they hold the check.
3. Nothing else waits: Part 3 reads signatures every Device release with Linux already publishes.

The release itself is not part of this branch: releases happen only when Ken asks. The pull request states the order.

## Measures

- BLAKE2b and Ed25519 time on a 100 MB file on the Linux x64 runner (or a Linux machine), before and after: the update
  and the Device install each gain this wait once; the number goes in the pull request.
- Log lines, no content and no path: `update: signature refused (<reason>)` and `devices: device app signature refused
  (<reason>)`, `<reason>` one of a fixed set (missing, malformed, key, file, global, comment).

## Tests

Red first, at the layer where each behavior lives:

- Verifier unit tests against fixtures made by the real tools with a throwaway test key (`cargo tauri signer generate`,
  `minisign -S`), committed with the generating command in a comment: a good signature passes; a changed byte, a
  signature for another file name (a Device signature offered for Desktop), another version, another key id, a broken
  global signature, an edited trusted comment, the legacy `Ed` algorithm, a missing signature and garbage each refuse
  with their reason. One real-key test: the live Device 0.1.11 macOS archive's BLAKE2b-512 digest and its signature
  (committed, without the 11 MB file) verify against the pinned key, proving the pinned key and the format.
- Updater (Linux branch, `TargetPlatform` and the existing seams): a signed update stages; a tampered file with its
  sha256 updated in the manifest is refused with `UpdateRefused` and nothing is staged; an entry with no signature is
  refused. macOS and Windows tests unchanged and green.
- Device installer (Linux): signed installs; tampered refuses at `signature` and leaves nothing at the place; a
  `platforms` url naming another file refuses; no signature refuses.
- Release: the workflow and script tests the repository keeps for these workflows (the Python tests under `scripts/`
  and `device-app/scripts/test_release_workflow.py`'s style) assert: `build-linux` has no GCP auth and no secret;
  `sign-linux` has the key, no GCP auth, no build step; `upload-linux` has GCP auth and no key; the manifest entry
  carries `signature`; `publish` and `promote()` refuse a Linux entry without one; the signing script's trusted
  comment holds `file:` and `desktop-version:` and no field that starts with `version:` (Tauri's own reading, so a
  Device app would refuse it).
- A Flutter test that clicks through what a person sees for a refused Linux update (the banner's sentence), per the
  product rule that every Desktop feature gets one.

## Verification

- `device-app-desktop` (PR CI, selected by `desktop/lib/devices/`): Desktop installs the Device app on
  `ubuntu-22.04` and `ubuntu-22.04-arm`. Its fixture now needs a signature made with a test key, and its Desktop must
  trust that test key through the test seam only; the builder adapts the fixture and adds the case where a tampered
  AppImage is refused.
- The signing job cannot run on GitHub without publishing (a `--prepare` release writes candidates to the bucket), so
  it is checked by the workflow tests above and by running the signing script locally with a throwaway key (the
  pinned minisign on a Linux container, x64 and arm64 where the machine can), then verifying its output with the
  Dart verifier. No temporary workflow.
- Required local receipts: `python3 scripts/local-checks.py --run` at the final head, its output pasted into the PR
  body as it is, before the push that marks it ready. It maps none of this branch's paths today; no extra
  `make desktop-test` (no macOS-only code changes).
- `scripts/ci-plan.py` and `scripts/record-ci-validation.py` change, so two independent security reviews before the
  merge (docs/validation-and-release.md): the final review and one more fresh reviewer on those files.
- `desktop/lib/update/tauri_signature.dart` joins `device-app-desktop`'s paths in `scripts/ci-plan.py`, so a change
  to the verifier runs Desktop's Device install end to end.

## Left to the builder

- Job and script names, and whether `sign-linux` and `upload-linux` are per-arch matrix jobs or one job for both
  arches.
- minisign or the Tauri CLI's signer.
- How the fixtures are generated and where they live, within the test folders.
- The exact copy of the refusal sentence, within the existing refusals' voice and the product's short-copy rule.
