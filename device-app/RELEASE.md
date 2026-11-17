# Releasing Harness Device

One signed, notarized, universal (arm64 + x86_64) `.dmg` for macOS 13 or later. The page is
`https://harness.autonomous.ai/device`; its stable link `https://harness.autonomous.ai/device/download-macos`
follows the manifest. An installed app finds a newer release and installs it on its own.

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

The next version is the patch bump of max(highest `v*_device` tag, the live manifest's `version`); `.99` rolls to the
next minor at `.1`. The tag is the version; `_device` only keeps it apart from the other products' tags. The script
refuses a dirty tree, a commit not on `origin/main`, a tag that exists, a version not above the live one, and a commit
that does not contain the last release's tag (unless `--allow-older`). The rules live in `scripts/device-manifest.py`;
`python3 -m unittest discover -s scripts -p 'test_*.py'` tests them.

The first release, with Diego's go. The bucket holds no manifest yet, so both name the version and pass the flag:

1. `make release-device ARGS="--prepare 0.1.0 --allow-no-manifest"`: proves the signing and both notarizations,
   publishes nothing.
2. `make release-device ARGS="0.1.0 --allow-no-manifest"`: the release.

## What CI does

`.github/workflows/release-device.yml` runs only when started (`workflow_dispatch`), with the inputs `version` and
`publish`. It has three jobs:

| Job | Runs on | Does |
|---|---|---|
| `version` | ubuntu | Checks the version, the run's ref, and that the run's commit is on `main`; with `publish=true`, that the tag is annotated and its message (the notes) is not empty. |
| `build` | macos-15 | Compiles, then bundles, signs, notarizes and checks; keeps the three files and their sha256 and size as a run artifact for 7 days. |
| `publish` | ubuntu, only with `publish=true` | Uploads to GCS, writes the manifest, verifies the public downloads. |

- **Every run's commit is on `main`.** With `publish=true` the run's ref must be `refs/tags/v<version>_device`; without
  it, `refs/heads/main`. Only `main` may be prepared: the repository is public, so anyone can download a run's
  artifact, and a signed, notarized build of unreviewed branch code must not exist.
- **The build's code runs before any secret exists.** `Compile` runs the crates' build scripts and the UI's npm
  packages before the keychain or any secret exists, and refuses a signing secret in its environment; `Bundle and
  sign`, which holds them, runs only the Tauri CLI. Both steps share one runner, so this stops a build script that
  reads or prints its environment, not one that leaves something behind for the later step to run.
- **Two notarizations.** Tauri notarizes and staples the app; it signs the dmg but does not notarize it, so the
  workflow submits the dmg itself (`notarytool submit --wait`) and staples it.
- **Checks before anything leaves `build`** (`scripts/release-check.sh --notarized`): the three files; the app is
  universal (`lipo`) and at the release version; `codesign --verify --deep --strict`; the update archive's signature
  against the public key (`minisign`), and its trusted comment's `version:X.Y.Z`, which the app requires
  (`requireSignedVersion`); the dmg holds the app and an `Applications` link; `spctl` and `stapler validate` accept
  the app and the dmg. Each prints `ok: <check>`, or `FAILED: <check>` and stops.
- **Nothing reaches GCS without `publish`.** Only that job holds `id-token: write`; `build` has no GCS credential.
  `publish` uploads the files to `gs://s3-autonomous-upgrade-3/harness/device/<version>/` with no-clobber and a
  year-long cache, writes `metadata.json` only over the generation it read (`no-cache`), then reads the manifest back
  and downloads each file it names from the CDN, comparing it with the build's.

The scripts the jobs run: `scripts/release-setup.sh` (the runner's tools), `scripts/release-build.sh` (`compile`, then
`bundle` under the fixed names `Harness-Device.dmg`, `Harness-Device.app.tar.gz`, `Harness-Device.app.tar.gz.sig`),
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

The app is universal, so the arm64 pair names the same files as the other pair. The app reads `platforms` (its
updater ignores the rest); the website's download link reads `device-macos-dmg`.

## Keys

Repository secrets, by name:

- Apple signing and notarization: `APPLE_CERTIFICATE_BASE64`, `APPLE_CERTIFICATE_PASSWORD`, `KEYCHAIN_PASSWORD`,
  `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD`, `APPLE_SIGNING_IDENTITY`.
- GCS, in `publish` only, by Workload Identity Federation: `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT`.
- The updater key: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

The updater key pair is made with `cargo tauri signer generate -w ~/.tauri/harness-device.key`. Its public half is
`plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. Keep the private key safe beyond the secret too: losing it
means installed apps can never update again.

## When it fails

A red run names its step.

- **Before `Publish`, nothing changes**, and `Publish` uploads the three files to the version's own folder before it
  writes the manifest. A transient failure (Apple's notary service or stapler, the network, the runner) gets
  **Re-run failed jobs** on the same run: the same commit, and `publish` takes the same artifact. The dmg's staple
  already tries six times over about 8 minutes first.
- **A fix that needs a new commit:** once a manifest is live, cut a higher version (the bump passes the failed tag).
  While none is live (the first release), `--allow-no-manifest` refuses once a tag exists: delete the unreleased tag
  (`git push origin :refs/tags/v0.1.0_device`, then `git tag -d v0.1.0_device`) and cut it again. Never move or delete
  a tag a manifest has named.
- **A failed `Verify`** comes after `Publish` wrote the manifest: it already names the new release, and a re-run is
  refused as not above the live version. Download the dmg it names from the CDN and compare its sha256 with the
  manifest's; a wrong one is fixed forward with a higher version.
- A second run for the same version finishes only if the files already in the bucket equal its own; otherwise it
  stops before the manifest.
- If the dispatch fails after the tag was pushed, the script prints the `gh workflow run` line: start the run by hand
  with it.
- A bad release is fixed by a higher version; the updater never moves back. For older code, pass `--allow-older`.

## How an installed app updates

A build the release stamped with its version checks the manifest on macOS on its first tick after launch, then every
6 hours, but never while the CLI installs or a sign-in runs. A local `cargo tauri build` is version 0.0.0 and never
checks. A newer version is downloaded, its signature checked against the public key and the version signed into it
against the manifest's, installed over the running bundle, and the app relaunches. The relaunch waits while the window
is open, `harness start` runs, or the CLI installs or a sign-in runs. While it updates, the
menu's row reads `Updating Harness Device…`. Timeouts: check 30 s, download 5 min. A failure changes nothing on disk;
the next check tries again.

Its log (`~/Library/Logs/ai.autonomous.harness.device/`) has one line per step, never a URL:

- `update: found 0.1.3`
- `update: installed 0.1.3`
- `update: failed check|download|signature|install`
- `update: skipped not-writable`

Before it downloads, the app checks it can replace its own bundle. If it cannot (a standard user's `/Applications`, or
the app run from the mounted dmg), it installs nothing and never asks for a password: it logs
`update: skipped not-writable` once per version, and the menu shows `Update 0.1.3…`, which opens
`https://harness.autonomous.ai/device`.
