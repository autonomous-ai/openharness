# Releasing Harness Device

One release carries, under one version:

| Platform | Files | Signed |
|---|---|---|
| macOS 13 or later, universal | `Harness-Device.dmg`, the update `Harness-Device.app.tar.gz` and its `.sig` | Developer ID, notarized |
| Windows 10 or 11, x64 and arm64 | `Harness-Device-windows-<arch>-setup.exe` (NSIS, per user) and its `.sig` | Authenticode, the app's exe and the installer |
| Linux, x64 and arm64 | `Harness-Device-linux-<arch>.AppImage` and its `.sig` | the update signature only |

Each `.sig` is the updater's signature. The page is `https://harness.autonomous.ai/device`, with a button per OS; its
links `/device/download-macos`, `/device/download-windows` and `/device/download-linux` follow the manifest. The last
two pick x64 or arm64 from the browser's Client Hints (Linux also from its user agent), x64 when it cannot tell, and
answer 503 until a release carries their keys. An installed app finds a newer release and installs it on its own.

Windows and Linux ship only when a release asks for them: `platforms` is `macos` by default, and `all` builds and
publishes the three. Once Windows and Linux are live, `publish` refuses a macOS-only release: the manifest has one
version, so their apps would take the new one with the last release's files, signed for another version, and fail
every update. The input is temporary: the first Windows and Linux release makes `all` the only behavior and removes
it.

## Cutting a release

From the repository root, on a clean checkout of `origin/main`:

- `make release-device`: bump the patch, tag this commit `vX.Y.Z_device`, push the tag and start
  `release-device.yml` on it with `publish=true`.
- `ARGS="--dry-run"`: print the version, the notes and what it would run; tag, push and start nothing.
- `ARGS="--prepare"`: build, sign and check `origin/main`'s tip with `publish=false`; tag and publish nothing.
- `ARGS="--minor"`: `X.(Y+1).1` instead of the patch bump.
- `ARGS="X.Y.Z"`: an explicit version.
- `ARGS="--notes-file f.md"`: hand-written notes instead of the commits since the last tag that touch `device-app/`,
  at most 100.
- `ARGS="--wait"`: follow the run it started to its end (`gh run watch`).
- `ARGS="--allow-older"`: a rollback, older code under a higher version.
- `ARGS="--allow-no-manifest"`: the first release only, while the bucket holds no manifest; refused once any
  `v*_device` tag exists.
- `ARGS="--platforms all"`: Windows and Linux too (the workflow's `platforms` input); `macos` by default. Temporary,
  as above.

The next version is the patch bump of max(highest `v*_device` tag, the live manifest's `version`); `.99` rolls to the
next minor at `.1`. The tag is the version; `_device` only keeps it apart from the other products' tags. The script
refuses a dirty tree, a commit not on `origin/main`, a tag that exists, a version not above the live one, and a commit
that does not contain the last release's tag (unless `--allow-older`). The rules live in `scripts/device-manifest.py`;
`python3 -m unittest discover -s scripts -p 'test_*.py'` tests them.

The first release, with Diego's go. The bucket holds no manifest yet, so both name the version and pass the flag:

1. `make release-device ARGS="--prepare 0.1.0 --allow-no-manifest"`: proves the signing and both notarizations,
   publishes nothing.
2. `make release-device ARGS="0.1.0 --allow-no-manifest"`: the release.

The first Windows and Linux release:

1. `make release-device ARGS="--prepare --platforms all"`: the first run of `sign-windows`, whose bundle takes the exe
   and the Tauri CLI from other jobs, and of Azure's signing in this workflow; no test runs either. Then the real-PC
   checks of [Windows code signing](../docs/windows-code-signing.md#first-run-and-rollout) on its installers.
2. `make release-device ARGS="--platforms all"`: the release. From then on `publish` refuses a macOS-only one.

## What CI does

`.github/workflows/release-device.yml` runs only when started (`workflow_dispatch`), with the inputs `version`,
`publish` and `platforms`. Its jobs:

| Job | Runs on | Does |
|---|---|---|
| `version` | ubuntu | Checks the version, the run's ref, and that the run's commit is on `main`; with `publish=true`, that the tag is annotated and its message (the notes) is not empty. |
| `build` | macos-15 | Compiles, then bundles, signs, notarizes and checks; keeps the three files and their sha256 and size as a run artifact for 7 days. |
| `tauri-cli-windows` | windows, with `all` | Installs the Tauri CLI `sign-windows` runs, with no app code checked out; no secret, no identity. |
| `build-windows` | windows, x64 and arm64, with `all` | Compiles `harness-device.exe` for its arch; no secret, no identity. |
| `sign-windows` | windows, with `all` | Signs both exes, bundles each installer with that Tauri CLI, signs the installers, writes their update signatures, then records their sums; keeps them for 7 days. Compiles and installs nothing. |
| `check-windows` | windows, with `all` | Checks the installers `sign-windows` made; hands nothing on. |
| `build-linux` | ubuntu-22.04 x64 and ubuntu-22.04-arm, with `all` | Compiles, bundles the AppImage, then signs it as an update in a step of its own, checks it; keeps it for 7 days. |
| `publish` | ubuntu, only with `publish=true` | Checks each artifact against the sums its build recorded, uploads to GCS, writes the manifest, verifies the public downloads. With `all` it waits for every build. |

- **Every run's commit is on `main`.** With `publish=true` the run's ref must be `refs/tags/v<version>_device`; without
  it, `refs/heads/main`. Only `main` may be prepared: the repository is public, so anyone can download a run's
  artifact, and a signed, notarized build of unreviewed branch code must not exist.
- **The build's code runs before any secret exists.** `Compile` runs the crates' build scripts and the UI's npm
  packages before the keychain or any secret exists, and refuses a signing secret in its environment; `Bundle and
  sign`, which holds them, runs only the Tauri CLI. Both steps share one runner, so this stops a build script that
  reads or prints its environment, not one that leaves something behind for the later step to run. On Linux the
  bundle holds no secret either, as Tauri's AppImage bundler downloads and runs linuxdeploy and its plugins unpinned:
  `Sign the update`, after it, holds the updater key and runs only the Tauri CLI's signer, on the same runner: the same
  limit holds.
- **Windows signs in order** (`sign-windows`): the app's exe with Authenticode through Azure Artifact Signing
  ([Windows code signing](../docs/windows-code-signing.md)), always, since Smart App Control blocks an unsigned
  program; then NSIS packs it, with `--no-binary-patching`, so Tauri writes nothing into the signed exe and it keeps
  its signature; then the installer is signed; then the update signature, last, over the bytes that ship. This job
  runs no build code: the Tauri CLI comes from `tauri-cli-windows`, which checks out no app code, so a crate's build
  script or an npm package cannot replace the program that runs beside the signing identity and the updater key. The
  sums `publish` checks are recorded here too, as the files are made. A job that runs build code could still replace
  another job's artifact, so the CLI's sha256 and the sums' travel as job outputs, which only the job that made them
  can set: `sign-windows` runs the CLI, and `publish` takes the Windows sums, only when they match. NSIS's uninstaller
  and plugin DLLs, which the installer writes to disk, stay unsigned: Tauri signs them only through a sign command it
  runs in the middle of the bundle, and the signing action signs files between steps. Whether Smart App Control lets
  them run is checked on a real PC before the first Windows release.
- **Each AppImage builds on its own arch**, on the oldest Ubuntu the desktop app supports: an AppImage carries the
  libraries of the machine that bundled it.
- **Two notarizations.** Tauri notarizes and staples the app; it signs the dmg but does not notarize it, so the
  workflow submits the dmg itself (`notarytool submit --wait`) and staples it.
- **Checks before anything leaves `build`** (`scripts/release-check.sh --notarized`): the three files; the app is
  universal (`lipo`) and at the release version; `codesign --verify --deep --strict`; the update archive's signature
  against the public key (`minisign`), and its trusted comment's `version:X.Y.Z`, which the app requires
  (`requireSignedVersion`); the dmg holds the app and an `Applications` link; `spctl` and `stapler validate` accept
  the app and the dmg. On Windows (`--signed`): each installer's update signature and its version, its Authenticode
  signature, and the `harness-device.exe` it packs (read out with 7-Zip): its Authenticode signature, kept through
  NSIS, and its version. On Linux: the AppImage's arch and its update signature and version. Each prints
  `ok: <check>`, or `FAILED: <check>` and stops.
- **Nothing reaches GCS without `publish`.** Only it and `sign-windows` hold `id-token: write`, and only `publish`
  authenticates to GCP; that `sign-windows`'s token (subject `…:environment:release`) gets no GCS credential is GCP's
  workload identity provider's condition to hold. `build` has no GCS credential.
  `publish` uploads the files to `gs://s3-autonomous-upgrade-3/harness/device/<version>/` with no-clobber and a
  year-long cache, writes `metadata.json` only over the generation it read (`no-cache`), then reads the manifest back
  and downloads each file it names from the CDN, comparing it with the build's.

The scripts the jobs run: `scripts/release-setup.sh` (the runner's tools), `scripts/release-build.sh` (`compile`, then
`bundle` under the fixed names above; on Windows, after Authenticode, and on Linux `sign-update`),
`scripts/release-check.sh` and `scripts/device-manifest.py`.

## The manifest

`https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/metadata.json`, read from the bucket, never
through the CDN. Tauri's static update format, plus entries for the archive and the dmg in the shape of Desktop's
manifest:

```json
{
  "version": "0.1.0",
  "notes": "<the tag message>",
  "pub_date": "2026-11-20T10:00:00Z",
  "platforms": {
    "darwin-aarch64": { "url": "https://cdn.autonomous.ai/harness/device/0.1.0/Harness-Device.app.tar.gz", "signature": "<.sig contents>" },
    "darwin-x86_64": { "url": "https://cdn.autonomous.ai/harness/device/0.1.0/Harness-Device.app.tar.gz", "signature": "<.sig contents>" }
  },
  "device-macos": { "version": "0.1.0", "url": "https://cdn.autonomous.ai/harness/device/0.1.0/Harness-Device.app.tar.gz", "sha256": "<64 hex>", "size": 12000000 },
  "device-macos-dmg": { "version": "0.1.0", "url": "https://cdn.autonomous.ai/harness/device/0.1.0/Harness-Device.dmg", "sha256": "<64 hex>", "size": 12345678 },
  "device-macos-arm64": { "version": "0.1.0", "url": "https://cdn.autonomous.ai/harness/device/0.1.0/Harness-Device.app.tar.gz", "sha256": "<64 hex>", "size": 12000000 },
  "device-macos-arm64-dmg": { "version": "0.1.0", "url": "https://cdn.autonomous.ai/harness/device/0.1.0/Harness-Device.dmg", "sha256": "<64 hex>", "size": 12345678 }
}
```

The app is universal, so the arm64 pair names the same files as the other pair. A release with `all` adds, each with
its own file:

| Updater key (`platforms`) | Download key | File |
|---|---|---|
| `windows-x86_64` | `device-windows-x64` | `Harness-Device-windows-x64-setup.exe` |
| `windows-aarch64` | `device-windows-arm64` | `Harness-Device-windows-arm64-setup.exe` |
| `linux-x86_64` | `device-linux-x64` | `Harness-Device-linux-x64.AppImage` |
| `linux-aarch64` | `device-linux-arm64` | `Harness-Device-linux-arm64.AppImage` |

The app reads `platforms` (its updater ignores the rest). The website reads `device-macos-dmg`, `device-windows-*` and
`device-linux-*`. Desktop reads `device-macos-arm64`/`device-macos`, `device-windows-*` and `device-linux-*`; on
Windows it runs the installer with `/S`, and on Linux it puts the AppImage at `~/.local/opt/Harness-Device.AppImage`
and lists it in the app list as `harness-device.desktop`, removed at Desktop's next launch once the AppImage is gone.

## Keys

Repository secrets, by name:

- Apple signing and notarization: `APPLE_CERTIFICATE_BASE64`, `APPLE_CERTIFICATE_PASSWORD`, `KEYCHAIN_PASSWORD`,
  `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD`, `APPLE_SIGNING_IDENTITY`.
- Windows signing, in `sign-windows` only, by its OIDC token in the `release` environment: the variables
  `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `SIGNING_ENDPOINT`, `SIGNING_ACCOUNT`,
  `SIGNING_PROFILE`; no secret.
- GCS, in `publish` only, by Workload Identity Federation: `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT`.
- The updater key: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

The updater key pair is made with `cargo tauri signer generate -w ~/.tauri/harness-device.key`. Its public half is
`plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. Keep the private key safe beyond the secret too: losing it
means installed apps can never update again.

## When it fails

A red run names its step.

- **Before `Publish`, nothing changes**, and `Publish` uploads the release's files (three for `macos`, eleven for `all`)
  to the version's own folder before it writes the manifest. A transient failure (Apple's notary service or stapler, the
  network, the runner) gets **Re-run failed jobs** on the same run: the same commit, and `publish` takes the same
  artifact. The dmg's staple already tries six times over about 8 minutes first.
- **A fix that needs a new commit:** once a manifest is live, cut a higher version (the bump passes the failed tag).
  While none is live (the first release), `--allow-no-manifest` refuses once a tag exists: delete the unreleased tag
  (`git push origin :refs/tags/v0.1.0_device`, then `git tag -d v0.1.0_device`) and cut it again. Never move or delete
  a tag a manifest has named.
- **A failed `Verify`** comes after `Publish` wrote the manifest: it already names the new release. **Re-run failed
  jobs**: `publish` finds this build live under its version, writes nothing and goes on to `Verify` again (other files
  under that version are refused). Still failing: download the dmg it names from the CDN and compare its sha256 with
  the manifest's; a wrong one is fixed forward with a higher version.
- A second run for the same version finishes only if the files already in the bucket equal its own; otherwise it
  stops before the manifest.
- If the dispatch fails after the tag was pushed, the script prints the `gh workflow run` line: start the run by hand
  with it.
- A bad release is fixed by a higher version; the updater never moves back. For older code, pass `--allow-older`.

## How an installed app updates

A build the release stamped with its version checks the manifest on its first tick after launch, then every minute,
as the CLI does, but never while the CLI installs or a sign-in runs: on macOS, on Windows, and on Linux when it runs
as an AppImage, the one Linux form the updater replaces. A local `cargo tauri build` is version 0.0.0 and never
checks. A newer version is downloaded, its signature checked against the public key and the version signed into it
against the manifest's, installed over the running bundle or AppImage, and the app relaunches. The relaunch waits
while the window is open, `harness start` runs, or the CLI installs or a sign-in runs. While it updates, the menu's row
reads `Updating Harness…`. Timeouts: check 30 s, download 5 min. A failure changes nothing on disk; the next check
tries again, but a version whose download, signature or install failed waits 2 minutes, then 4, 8, up to an hour, and
a newer version is tried at once.

On Windows the installer ends the app the moment it starts, so the app downloads and checks the update at once, then
holds the install until nothing a relaunch waits for runs. The installer (NSIS, passive) replaces the app in its
folder and starts it again; the login item's Run value stays, since an update runs the old uninstaller with
`/UPDATE`, which keeps it. The app also sets it again at every launch when it is missing, after an uninstall and a
reinstall or a hand deletion; one Startup Apps turned off stays off.

Its log has one line per step, never a URL. The folder: `~/Library/Logs/ai.autonomous.harness.device/` on macOS,
`%LOCALAPPDATA%\ai.autonomous.harness.device\logs\` on Windows, `~/.local/share/ai.autonomous.harness.device/logs/`
on Linux.

- `update: found 0.1.3`, once per version
- `update: installing 0.1.3`, on Windows, as the installer starts
- `update: installed 0.1.3`, elsewhere
- `update: failed check|download|signature|install`
- `update: skipped not-writable`

Before it downloads, the app checks it can replace its own bundle, install folder or AppImage. If it cannot (a
standard user's `/Applications`, the app run from the mounted dmg, a Windows copy an administrator installed, an
AppImage in a folder the person cannot write), it installs nothing and never asks for a password: it logs
`update: skipped not-writable` once per version, and the menu shows `Update 0.1.3…`, which opens
`https://harness.autonomous.ai/device`.
