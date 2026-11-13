# Mac signing only in the release environment: Implementation Plan

> Written by the writing-plans skill, implemented by its Engineer task by task, test first (task #4434).

**Goal:** No job that runs a branch's code ever holds the Apple signing or notarization material: macOS builds
unsigned on any ref, and a separate `sign-macos` job in the `release` environment, for `main` and `v*_desktop` tags
only, signs, notarizes and uploads the built bundles without building anything.

**Architecture:** `build-macos` compiles the universal app with an ad-hoc signature (`FLUTTER_XCODE_CODE_SIGN_IDENTITY=-`),
pins both renderers, and hands the two bundles to the next job as a GitHub artifact. It reads no secret and no GCP
identity. `sign-macos` checks out only the packaging scripts and entitlements, imports the certificate, signs every
framework and then the app (`desktop/scripts/sign-macos-app.sh`), and runs the existing notarize/staple/dmg/upload
path (`upload-desktop.sh --no-build`) through `build-macos-variants.py --no-build`. No Flutter, Pods, Xcode build or
Dart hook runs there. The Apple secrets move to the `release` environment, which the admin limits to `main` and
`v*_desktop` tags. The internal tester build, which today signs any branch, ships ad-hoc signed and not notarized.

**Tech Stack:** GitHub Actions YAML, bash (macOS bash 3.2), Python 3 stdlib `unittest`, `codesign`/`notarytool`.

**Spec:** Task #4434 brief (Swarm conversation cddea80c6129f8ab2d5a0453): split the workflow; unsigned build for any
ref; `environment: release` sign job for main or a release tag that runs no branch code; secrets read only there;
admin steps in the PR; `make release-desktop` working for main and tags with the nine-artifact verification unchanged;
Windows untouched unless it has the same gap.

## Global Constraints

- Never read, print or log a secret, a certificate or a keychain password, locally or in CI.
- Don't change repository settings; the PR body lists them for the admin.
- The nine-artifact verification in `publish` (`scripts/verify-desktop-release.py`) is unchanged.
- The shipped signature stays the same: frameworks signed with Developer ID and a timestamp, no hardened runtime
  flag, no entitlements; the app with Developer ID, timestamp, hardened runtime and exactly
  `desktop/macos/Runner/Release.entitlements`.
- `if:` conditions in the workflow are a branch's own text: the enforcement is the `release` environment's
  deployment rule and environment-scoped secrets. The conditions only make branch runs skip instead of fail.
- macOS scripts run on bash 3.2: no `${x,,}`, guard empty arrays under `set -u`.

## Review Focus

1. A branch run that edits the workflow to reference `secrets.APPLE_*` in any job: it must get empty values once the
   secrets are environment secrets. Covered by the admin steps, not by a test; the PR says so.
2. Anyone with write access pushing a `v*_desktop` tag at an unreviewed commit reaches the environment by its tag
   rule. The admin steps add a tag ruleset limiting who may create `v*_desktop` tags.
3. A future build that embeds new nested code (a helper, a dylib, an XPC service) would ship unsigned inside a signed
   app. `sign-macos-app.sh` refuses any executable outside `Contents/MacOS/Harness` and `Contents/Frameworks/*.framework`
   (Task 1 test).
4. A branch `--prepare` run must still pass as an unsigned build check and must never seal a reusable candidate
   (Task 4 test on `check_jobs`; Task 6 message).
5. A `workflow_dispatch` real release (or a metadata-test dry run) from a branch must fail at once with a clear
   message, not build for 15 minutes and skip `publish` (Task 4 test running the `resolve` block).

## Design

- growth, concurrency, read cost, scale: N/A because no stored data changes; one GitHub artifact per release run
  (two unsigned bundles, retention 1 day).
- compatibility: published contracts unchanged (manifest keys, file names, nine downloads). Candidates made before
  this change lack `sign-macos` and are refused by `check_jobs`, falling back to a full build.
- migration and rollback: merge, then the admin moves the secrets and limits the environment. Rolling back is a
  revert, and, once the admin has moved them, the Apple secrets back at repository level: the old `build-macos`
  declares no environment.
- audience, identity: signing runs only in the `release` environment, under the repository's own Apple account.
- failure: a branch real release fails in `version`; a non-ad-hoc branch build fails in `build-macos`; unexpected
  nested code fails in `sign-macos`.
- platforms: macOS release and internal builds; Windows signing gets the same ref condition; Linux untouched.

---

### Task 1: One signing script for the app bundle

**Files:**
- Create: `desktop/scripts/sign-macos-app.sh`
- Test: `scripts/tests/test_macos_signing.py`

**Interfaces:**
- Produces: `SIGN_IDENTITY=<identity> bash desktop/scripts/sign-macos-app.sh <APP_BUNDLE>`; exit 0 when signed and
  `codesign --verify --deep --strict` passes. `SIGN_IDENTITY` defaults to `Developer ID Application`; `-` signs ad hoc.

- [ ] **Step 1: Write the failing tests** (fake `codesign` on PATH records each call as JSON lines)
  - `test_frameworks_are_signed_before_the_app_with_runtime_and_release_entitlements`: calls are, in order, each
    `Contents/Frameworks/*.framework` with `--force --sign ID --timestamp` and no `--options`/`--entitlements`; then
    the app with `--options runtime --entitlements <desktop/macos/Runner/Release.entitlements>`; then
    `--verify --deep --strict`.
  - `test_unexpected_nested_code_is_refused_before_any_signing`: an executable file in `Contents/Resources/` or a
    `Contents/Library/LoginItems/x.app` makes it exit non-zero with "unexpected code" and record no `--sign` call.
  - `test_a_failed_verification_fails_the_script`.
- [ ] **Step 2: Run** `python3 -m unittest scripts/tests/test_macos_signing.py -v` — FAIL (script missing).
- [ ] **Step 3: Implement** the script.
- [ ] **Step 4: Run** the same — PASS. Also, by hand, ad-hoc re-sign a copy of the published 1.3.88 app and check
  `codesign --verify --deep --strict` and the entitlements equal the shipped ones.
- [ ] **Step 5: Commit** test, then script.

### Task 2: The uploader signs through that script and needs no Flutter to publish a built bundle

**Files:**
- Modify: `desktop/scripts/upload-desktop.sh` (flutter check only when building; sign via Task 1 after the version
  check, before packaging)
- Test: `scripts/tests/test_macos_upload.py`

- [ ] **Step 1: Failing tests:** `test_publishing_a_built_bundle_needs_no_flutter` (no `flutter` on PATH, `--no-build`
  succeeds); `test_the_app_is_signed_before_its_notarization_zip` (the fake records the sign script's app call before
  the first `ditto -c`).
- [ ] **Step 2: Run** `python3 -m unittest scripts/tests/test_macos_upload.py -v` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS, with the existing upload tests.
- [ ] **Step 5: Commit** test, then code.

### Task 3: Builds are ad-hoc signed; the coordinator can publish existing bundles

**Files:**
- Modify: `desktop/scripts/publish-macos-variant.sh` (build with `FLUTTER_XCODE_CODE_SIGN_IDENTITY=-`; the Skia
  re-sign uses `-`; after a build, refuse a bundle whose signature is not `Signature=adhoc`)
- Modify: `desktop/scripts/build-macos-variants.py` (`--no-build`: publish `build/macos-variants/<variant>/Harness.app`
  without compiling, requires `--metadata-prefix`; `--no-notarize`: forwarded to `upload-desktop.sh`)
- Test: `scripts/tests/test_macos_variants.py`

- [ ] **Step 1: Failing tests:** `test_no_build_publishes_existing_bundles_without_compiling` (compile count stays
  absent, both publications run); `test_no_build_requires_both_bundles_and_a_metadata_prefix`;
  `test_no_notarize_is_forwarded_to_both_publications`.
- [ ] **Step 2: Run** `python3 -m unittest scripts/tests/test_macos_variants.py -v` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** test, then code.

### Task 4: Split the release workflow

**Files:**
- Modify: `.github/workflows/release-desktop.yml`, `scripts/desktop-release-candidate.py` (`check_jobs` requires
  `sign-macos`)
- Test: `scripts/tests/test_desktop_release_signing.py` (new), `scripts/tests/test_desktop_release_candidate.py`

- [ ] **Step 1: Failing tests** in the new file, reading job bodies the way `test_desktop_release_candidate.py` does:
  - `test_only_sign_macos_and_sign_windows_read_signing_material`: every `secrets.APPLE_`, `secrets.KEYCHAIN_PASSWORD`
    and `macos-signing` use is inside `sign-macos`.
  - `test_signing_jobs_run_in_the_release_environment_for_main_and_desktop_tags_only`: both have
    `environment: release` and an `if:` naming `refs/heads/main` and `refs/tags/v` … `_desktop`.
  - `test_sign_macos_runs_no_build_tooling`: its body has no `desktop-flutter`, `flutter `, `pod `, `xcodebuild`, and
    its sparse checkout lists files, not the `/desktop/` tree.
  - `test_build_macos_holds_no_secret_or_cloud_identity`: no `secrets.` in `build-macos`.
  - `test_publication_and_candidates_wait_for_signed_macos`: `publish` and `candidate` need `sign-macos` and require
    its success.
  - `test_branch_release_is_refused_but_branch_prepare_and_tags_resolve`: runs the `resolve` step's script with
    `REF=refs/heads/feature` (fails, message names main and tags), the same with `PREPARE_ONLY=true` (passes),
    `refs/tags/v1.2.3_desktop` and `refs/heads/main` (pass).
  - In `test_desktop_release_candidate.py`: `test_builds_and_verification_cannot_be_missing_skipped_or_failed`
    covers a missing or skipped `sign-macos`.
- [ ] **Step 2: Run** `python3 -m unittest discover -s scripts/tests -p 'test_desktop_release_*.py' -v` — FAIL.
- [ ] **Step 3: Implement:** `build-macos` (no signing, no GCP; build, assert ad hoc, `ditto` each bundle into
  `desktop-macos-unsigned`, compression 0, 1 day); `sign-macos` (needs version, preflight, build-macos;
  `environment: release`; sparse checkout of `.github/actions/macos-signing/`, the four packaging scripts,
  `desktop/macos/Runner/Release.entitlements`, `scripts/validate-change.py`, `scripts/verify-desktop-release.py`;
  download, unpack, sign keychain, WIF, `build-macos-variants.py --no-build`, timings as `macos-sign-timings`,
  delete keychain); `sign-windows` gets the same ref condition; `publish`/`candidate`/`cleanup` need `sign-macos`;
  `resolve` refuses a non-prepare, non-promotion-check run outside main and `v*_desktop` tags and writes a summary
  line for a branch candidate.
- [ ] **Step 4: Run** — PASS, with all `scripts/tests`.
- [ ] **Step 5: Commit** tests, then code.

### Task 5: Internal tester builds stop signing branches

**Files:**
- Modify: `.github/workflows/desktop-internal-build.yml` (no `macos-signing`, no Apple secrets, `SIGN_IDENTITY: '-'`,
  `--no-notarize`; the summary says the build is not notarized and how to open it)
- Test: `scripts/tests/test_desktop_release_signing.py`

- [ ] **Step 1: Failing test** `test_internal_builds_read_no_signing_material`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS. **Step 5: Commit** test, then code.

### Task 6: Release script and docs

**Files:**
- Modify: `desktop/scripts/release-desktop.sh` (`--prepare` off `main` says it is an unsigned build check and the
  release builds and signs from its tag)
- Modify: `docs/validation-and-release.md`, `docs/windows-code-signing.md`, `desktop/RELEASE.md`,
  `.github/actions/macos-signing/action.yml` (description)
- Test: `scripts/tests/test_desktop_release_prepare.py`

- [ ] **Step 1: Failing test** `test_prepare_on_a_branch_says_it_is_an_unsigned_build_check`.
- [ ] **Step 2: Run** `python3 -m unittest scripts/tests/test_desktop_release_prepare.py -v` — FAIL.
- [ ] **Step 3: Implement**, and update the docs.
- [ ] **Step 4: Run** — PASS. **Step 5: Commit.**
- [ ] **Step 6:** One `prepare_only` run of `release-desktop.yml` from this branch: `build-macos` passes ad hoc,
  `sign-macos` and `sign-windows` are skipped, nothing is sealed. Link it in the PR.

### Task 7: Publication only from the release environment (added by the PM, P0)

The Google Cloud login worked from any branch run and could write the live manifest, which the updater trusts by
sha256 alone. Every job that logs in to Google Cloud moves into the `release` environment; builds hand packages
on as artifacts.

**Files:**
- Modify: `desktop/scripts/upload-desktop-linux.sh` (`--no-upload`: build and package, no cloud call;
  `--upload-only`: publish the AppImage `--no-upload` left in `build/`; bash 3.2-safe architecture lowercase)
- Modify: `.github/workflows/release-desktop.yml` (`build-linux` packages and uploads `desktop-linux-<arch>`; new
  `upload-linux`; `preflight`, `upload-windows`, `publish`, `candidate`, `cleanup`, `expire-candidates`,
  `publication-test` get `environment: release`; builds run when `preflight` is skipped; a promotion check also
  needs main or a tag), `scripts/desktop-release-candidate.py` (`check_jobs` requires `upload-linux`)
- Modify: `docs/validation-and-release.md` ("Who can sign and publish Desktop": the GitHub and Google Cloud settings)
- Test: `scripts/tests/test_linux_upload.py` (new), `scripts/tests/test_desktop_release_signing.py`,
  `scripts/tests/test_desktop_release_candidate.py`

- [x] **Step 1: Failing tests:** `test_every_cloud_login_is_in_the_release_environment`,
  `test_builds_hold_no_secret_or_cloud_identity_and_hand_over_packages`, the ref rule on `preflight`,
  `upload-linux`, `upload-windows`, `cleanup`; `test_no_upload_packages_without_any_cloud_call`,
  `test_upload_only_publishes_the_packaged_file_without_building`,
  `test_upload_only_without_a_package_uploads_nothing`; a candidate without `upload-linux` is refused.
- [x] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS. **Step 5: Commit** tests, then code.
- [ ] **Step 6:** A second `prepare_only` run from this branch at the new head: builds pass, every
  `release`-environment job is skipped.
