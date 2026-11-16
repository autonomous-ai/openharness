# Harness Device: a signed release that updates itself

Status: approved (PM, 2026-11-16), with the not-writable menu row added at approval. Branch `feat/device-app-release`. Decisions by the PM (2026-11-16): the dial QR is its own item; the app
updates itself without asking; one universal build; the tag is the version; the release workflow runs only by hand.

## What and why

Harness Device (`device-app/`, the menu-bar app for the dial) cannot be installed by anyone today: there is no release
workflow, no signing or notarization, no download link and no update path. PR CI compiles it on Linux only.

Done when:

- `make release-device` cuts a release: one signed, notarized, universal (arm64 + x86_64) `.dmg` for macOS 13 or later,
  published beside Harness Desktop's downloads, with a stable link `https://harness.autonomous.ai/device/download-macos`
  and a page `https://harness.autonomous.ai/device`.
- An installed app finds a newer release, checks its signature, installs it and relaunches on its own.
- Nothing in this branch publishes anything. The release workflow runs only when started by hand.

## Scope

In:

- The release workflow `.github/workflows/release-device.yml` (`workflow_dispatch` only) and `make release-device`.
- Tauri's updater in the app (`tauri-plugin-updater`, Rust side only).
- The website page `/device` and the redirect route `/device/download-macos`.
- `device-app/RELEASE.md`, and the release lines in `device-app/AGENTS.md`, the root `Makefile` and
  `docs/validation-and-release.md`.

Out:

- **The QR code on the dial** (devices/harness-device firmware): its own item in the PM's backlog. The dial has a custom
  renderer with no QR encoder and no simulator, and firmware ships on its own release. The contract between the two
  items is one URL: the QR opens `https://harness.autonomous.ai/device`.
- **A Homebrew cask**: proposed in the final report, not built.
- A GitHub Release page: the release notes live in the update manifest (from the tag message).
- Linux and Windows releases. The Linux build keeps compiling and testing in PR CI; the updater is macOS only.
- Deploying the website: the page and route go live with the next `make release-web`, not from this branch.

## Version

The tag is the version, as for Desktop.

- Tags are `vX.Y.Z_device`. The `_device` suffix routes nothing (the workflow has no tag trigger); it keeps the tag
  apart from `_desktop`, `_cli`, `_backend` and `_web` and is stripped before anything treats it as a version.
- The next version is the patch bump of max(highest `v*_device` tag, `version` in the live manifest), with Desktop's
  rollover rule (`.99` goes to the next minor at `.1`). `--minor` and an explicit `X.Y.Z` work as in
  `make release-desktop`. The first release is cut with an explicit version: `make release-device ARGS="0.1.0"`.
- A manifest that cannot be read stops the script. `--allow-no-manifest` (the first release only) counts it as 0.0.0,
  and is refused once any `v*_device` tag exists. A public read cannot tell a missing object from a refused one (the
  bucket answers 403 to both), so this is a flag, not a status-code rule.
- CI writes the version into the build (`cargo tauri build --config` sets `version`). `Cargo.toml`'s `version`
  becomes `0.0.0` (and `Cargo.lock` with it), a placeholder no release reads or changes, so a local build never
  outranks a release.
- The release refuses a version not strictly greater than the live one, a tag that exists, a dirty tree, a commit not
  on `origin/main`, and a commit that does not contain the last release's tag (`--allow-older` for a rollback), the same
  guards as `desktop/scripts/release-desktop.sh`.

## The build

One universal app: `cargo tauri build --target universal-apple-darwin --bundles app,dmg` on `macos-15` (rustup
targets `aarch64-apple-darwin` and `x86_64-apple-darwin`). The release's `--config` adds the version and
`bundle.createUpdaterArtifacts: true`, so Tauri also writes `Harness Device.app.tar.gz` and its `.sig`. The committed
`tauri.conf.json` leaves `createUpdaterArtifacts` off: on, every `cargo tauri build --debug` would need the private
key. It does commit the updater's `endpoints` (the https manifest URL) and `pubkey`; a unit test asserts the endpoint
is https and no `dangerousInsecureTransportProtocol` key is present.

Signing and notarization reuse Desktop's infrastructure:

- `.github/actions/macos-signing` imports the Developer ID certificate into a throwaway keychain and stores the
  `harness-notarize` notarytool profile, from the secrets `APPLE_CERTIFICATE_BASE64`, `APPLE_CERTIFICATE_PASSWORD`,
  `KEYCHAIN_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID` and `APPLE_APP_PASSWORD`; the identity is
  `APPLE_SIGNING_IDENTITY`. The keychain is deleted in an `if: always()` step.
- Tauri signs the app with the hardened runtime and `Entitlements.plist` (its one key unchanged), then notarizes and
  staples it (`APPLE_ID`, `APPLE_PASSWORD` from `APPLE_APP_PASSWORD`, `APPLE_TEAM_ID`).
- Tauri signs the dmg but does not notarize it. The workflow submits the dmg with `notarytool submit --wait
  --keychain-profile harness-notarize` and staples it: two notarizations per release, as Desktop's RELEASE.md explains.
- The update archive is signed with Tauri's updater key from two new secrets, `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (Diego creates them, below). Its public key is committed in
  `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`).

Before anything leaves the build job, it checks: `lipo -archs` gives the set {`x86_64`, `arm64`}; `CFBundleShortVersionString` is
the release version; `codesign --verify --deep --strict` and `spctl -a -t exec` accept the app; `stapler validate`
accepts the app and the dmg; `spctl -a -t open --context context:primary-signature` accepts the dmg; the archive's
signature verifies against the committed public key (`minisign -V`, installed with `brew install minisign`, on the
format Tauri writes, base64-unwrapped).

The files are renamed to fixed names: `Harness-Device.dmg`, `Harness-Device.app.tar.gz`, `Harness-Device.app.tar.gz.sig`.

## The release workflow

`release-device.yml`, `workflow_dispatch` only, inputs `version` (X.Y.Z) and `publish` (boolean, default false).
Workflow `permissions: contents: read`; only the `publish` job adds `id-token: write`, so a build never holds a GCS
credential. Concurrency group per version, never cancelling.

| Job | Runs on | Does |
|---|---|---|
| `version` | ubuntu | Validates `version`. With `publish`, requires the run's ref to be `refs/tags/v<version>_device` and the tagged commit to be on `origin/main`; without it, `refs/heads/main`. |
| `build` | macos-15 | Builds, signs, notarizes and checks as above. Uploads the three files and their sha256/size as a run artifact (7 days). |
| `publish` | ubuntu, only with `publish` | Uploads to GCS, writes the manifest, verifies the public downloads. |

Without `publish` (`make release-device ARGS="--prepare"`), the run stops after `build`: the signed files exist only
as that run's artifact. Nothing is written to GCS. Only `main` may be prepared: the repository is public, so a run
artifact can be downloaded by others, and a signed, notarized build of unreviewed branch code must not exist.

`publish`, authenticated by Workload Identity Federation (`GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT`):

1. Reads the live manifest and its generation; refuses a version not strictly greater.
2. Uploads the three files to `gs://s3-autonomous-upgrade-3/harness/device/<version>/` with no-clobber and a
   year-long `Cache-Control` (they never change).
3. Writes `harness/device/metadata.json` with `--if-generation-match` on the generation read in step 1 (`0` for the
   first release: the object must not exist), so a concurrent writer fails and never overwrites; `Cache-Control:
   no-cache`.
4. Reads the manifest back from the GCS origin and downloads every URL it names from the CDN, comparing sha256, size
   and signature with the build's. A mismatch fails the run, red.

### The manifest

Read straight from the GCS origin, never through the CDN (as Desktop's), at
`https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/metadata.json`. Tauri's static update format,
plus one field the updater ignores and the website reads:

```json
{
  "version": "0.1.0",
  "notes": "<the tag message>",
  "pub_date": "2026-11-20T10:00:00Z",
  "platforms": {
    "darwin-aarch64": { "url": "https://cdn.autonomous.ai/harness/device/0.1.0/Harness-Device.app.tar.gz", "signature": "<.sig contents>" },
    "darwin-x86_64": { "url": "https://cdn.autonomous.ai/harness/device/0.1.0/Harness-Device.app.tar.gz", "signature": "<.sig contents>" }
  },
  "dmg": { "url": "https://cdn.autonomous.ai/harness/device/0.1.0/Harness-Device.dmg", "sha256": "<64 hex>", "size": 12345678 }
}
```

One script, `device-app/scripts/device-manifest.py`, holds every rule: the next version (bump, rollover, `--minor`,
explicit, comparisons), building the manifest from the files, checking the version is greater, verifying the public
copy. It is the device-app's own copy of the rules, not an import of Desktop's scripts (`scripts/ci-plan.py` would
read that as a dependency on another component). Its unit tests (`device-app/scripts/test_device_manifest.py`) run in
a new step of PR CI's `device-app-checks`. The end-to-end check below feeds the updater the manifest this script
writes, so the extra `dmg` field is proven harmless to the updater.

### `make release-device`

`device-app/scripts/release-device.sh`, mirroring `release-desktop.sh` with Desktop's flags that apply:

- no flag: work out the version, write the notes (`--notes-file`, or the commits since the last tag that touch
  `device-app/`, at most 100; unlike Desktop's, which lists every commit, so the public manifest stays small and about
  this app: PM, 2026-11-16), create the
  annotated tag, push it, then `gh workflow run release-device.yml --ref v<ver>_device -f version=<ver> -f publish=true`.
- `--dry-run`: print the version, the notes and what it would run; tag, push and start nothing.
- `--prepare`: start the workflow on the pushed branch tip with `publish=false`; tag nothing.
- `--minor`, `X.Y.Z`, `--allow-older`, `--allow-no-manifest` (first release only), `--wait` (follow the run to its
  end with `gh run watch`).
- `--prepare` runs only at `origin/main`'s tip, matching the workflow's rule.

The shell script does git, the HTTPS read and `gh`; it asks `device-manifest.py` for the version, so the rules are
tested there.

## The app updates itself

Rust only: `tauri-plugin-updater` is registered in Rust and the webview gets no updater permission
(`capabilities/default.json` is unchanged), so the window still sends only its six action names.

- **When.** On the 5-second `Tick` the app already has: a check is due when none has run yet or the last one started
  6 hours ago or more (by `now`, with `abs_diff` like the rest of `app.rs`, so a clock moved back cannot stall it). No
  new timer event. Release builds on macOS only: a debug build never checks, as it reads `HARNESS_DEVICE_CLI`; Linux
  compiles the same code with the check off, so PR CI compiles the glue.
- **What.** A newer version (strictly greater, Tauri's rule) is downloaded, its signature checked against the
  committed public key, installed over the running bundle, and the app relaunches. No question is asked: a menu-bar
  app's menu is rarely opened, so an offered update would rarely be taken.
- **Not mid-task.** While the CLI install or a sign-in runs, no check starts; the first tick after it ends starts the
  one that was due (so a first launch, which installs the CLI at once, checks right after the install, not 6 hours
  later). A sign-in that starts while an update downloads delays the relaunch, not the download: the reducer emits
  `Relaunch` on the first tick with no run in progress. The relaunch also waits while a Claude Code change runs,
  while the keep-alive's `harness start --if-down` runs, and while the window is open (PM, 2026-11-16).
- **The menu.** While an update downloads and installs, one disabled row `Updating to 0.1.3…` sits just before the
  separator; otherwise the menu is as today.
- **Failures are seen.** One log line each, through `log::redact`, never a URL: `update: found 0.1.3`,
  `update: installed 0.1.3`, `update: failed <check|download|signature|install>`. A failure changes nothing on disk;
  the next check tries again. Every network step has a timeout (check 30 s, download 5 min).
- **No password.** Before downloading, the app checks it can replace its own bundle (the bundle's folder is
  writable by the person). If not (a standard user's `/Applications`, or the app run from the mounted dmg), it does
  not install: one log line `update: skipped not-writable` per version, and no prompt. The plugin's own
  administrator-password path is never reached. So that person still learns of it, the menu then shows one action
  row **Update 0.1.3…** (two words, as buttons are) just before the separator; a click opens the fixed URL
  `https://harness.autonomous.ai/device` through the existing `Effect::OpenUrl` (`open` with that URL, nothing from
  the manifest in it). The row stays until a newer check changes it or the app runs a version at least that new. The
  reducer test for it is written red first.
- **Shape.** Like every rule in the app, the decision is pure (`app.rs`: events `UpdateChecked(Option<version>)`,
  `UpdateInstalled`, `UpdateFailed(kind)`; effects `CheckUpdate`, `InstallUpdate`, `Relaunch`), tested in
  `cargo test --lib`. `CheckUpdate` and `InstallUpdate` run on their own thread and answer with an event, as
  `RunInstall` does; the plugin calls live in one small file (`update.rs`) behind a trait, so no test reaches the
  network. `Relaunch` is drawn on the main thread like `Quit`, through Tauri's restart.
- **Repo rules this amends** (`device-app/AGENTS.md`): *Thin over the CLI* and *Fixed arguments* gain one line each:
  the app also fetches its own update manifest, and relaunches itself through Tauri's restart (`open -n` on its own
  bundle), with nothing from the webview or the manifest in either. The test that `Cargo.toml` has no `tauri-plugin`
  (`types.rs`) becomes: `tauri-plugin-updater` is the only plugin, and the capability is unchanged.

The endpoint and public key are build config, not settings: the end-to-end check below builds with its own through
`cargo tauri build --config`, so the app has no switch for them.

## The website

- `website/src/app/device/page.tsx`: "Harness Device", one line ("The menu-bar app for the dial. macOS 13 or
  later."), one button **Download** to `/device/download-macos`. Built like `/desktop`.
- `website/src/app/device/download-macos/route.ts`: 302 to the manifest's `dmg.url`, resolved on every request, by
  the shared resolver in `website/src/lib/desktopManifest.ts` generalised to take the manifest URL, the field, the
  allowed prefixes (`https://cdn.autonomous.ai/harness/device/`, `https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/`,
  `.dmg`) and the product name for its 503 text ("Harness Device download is temporarily unavailable (…)"). 503 when
  the manifest is unreachable or its `dmg.url` fails the check. The device manifest URL is fixed: no environment
  override (Desktop's `HARNESS_DESKTOP_METADATA_URL` stays as it is).
- Vitest covers the route (redirect, each 503) and the page (the button's link), with a stubbed fetch.

## Verification

No check publishes, uses a production backend or touches the apps on this Mac.

1. **`tmp-device-app-release.yml`** (temporary, removed before merge): `push` to `feat/device-app-release` only,
   `macos-15`, `permissions: contents: read`, no secrets. It builds the release twice, universal, ad hoc signed
   (`APPLE_SIGNING_IDENTITY=-`), with a key pair generated in the run: an old `0.0.1` whose endpoint is
   `http://127.0.0.1:<port>/metadata.json` (its `--config` alone sets `dangerousInsecureTransportProtocol`), and a new
   `0.0.2`. It checks `lipo`, the dmg's contents and the archive's signature, writes the manifest with
   `device-manifest.py`, serves it and `0.0.2`'s files on 127.0.0.1, then runs a copy of `0.0.1` from a writable folder.
   Isolation: the relaunch goes through LaunchServices (`open -n`), which drops a temporary `HOME` or `PATH`, so the
   check runs only on the disposable runner (its script refuses unless `GITHUB_ACTIONS=true`) and seeds the runner's own
   `HOME` first: a stub `harness` where `find_cli` looks, and a saved state that has already seen the CLI and
   registered the login item, so neither process installs anything or reaches the network beyond 127.0.0.1. Pass:
   within a bounded wait the bundle's `CFBundleShortVersionString` is `0.0.2`, the relaunched app runs, and the log has
   `update: installed 0.0.2`. The same run also starts `0.0.1` from a folder it cannot write: pass is
   `update: skipped not-writable` in the log, the bundle unchanged, the app still running. Artifacts stay in the run.
   Needs one macOS runner turn from the PM.
2. **PR CI**: `device-app-checks` (Linux: `cargo test --lib`, UI tests, and the new `test_device_manifest.py` step);
   `website-checks` (tsc, eslint, vitest, build).
3. **Workflow lint**: `actionlint` on `release-device.yml` locally.
4. **After merge, with Diego's go only**: `make release-device ARGS="--prepare 0.1.0 --allow-no-manifest"` proves
   the real signing and both notarizations (it uses the Apple secrets and publishes nothing). Not a merge gate; the
   first real release follows it: `make release-device ARGS="0.1.0 --allow-no-manifest"`.

## Needs from Diego before merge

Tauri's updater key pair: `cargo tauri signer generate -w ~/.tauri/harness-device.key`, the private key and its
password as the repository secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, kept safe
elsewhere too (losing it means installed apps can never update again), and the public key (not secret) for
`tauri.conf.json`. The updater plugin refuses to start without a public key, so until it lands every local build
passes one generated for the purpose through `--config`, as the end-to-end check does; PR CI does not start the app.

## Design (docs/feature-design-rules.md)

Reviewed revision: approved spec  Reviewer: PM (orchestrator)

1. Growth: one versioned folder per release in the bucket, as Desktop's; nothing deletes them (a release is
   immutable and old installs may still be on it). Run artifacts expire after 7 days. The manifest is one object,
   overwritten.
2. Concurrency: the manifest write is generation-conditional; two releases at once cannot both win. Asset uploads are
   no-clobber. The workflow's concurrency group is per version.
3. Read cost: each app reads one manifest (about 1 KB) at launch and every 6 hours; the website reads it once per
   download click.
4. Scale: 10x installs is 10x small GCS origin reads every 6 hours; the downloads come from the CDN. The metric that
   warns first is the bucket's request count for `harness/device/metadata.json`.
5. Compatibility: the first release has no older readers. Later manifests keep Tauri's format; an old app ignores
   fields it does not know.
6. Migration and rollback: no migration. A rollback is a higher version with the older code (`--allow-older`); the
   updater never moves backwards.
7. Audience: everything published is public by design (a public download). Nothing personal is published or sent:
   the app's check is an anonymous GET.
8. Identity: CI publishes as the release service account via federation, in the `publish` job only; the app runs
   nothing as anyone but the person running it and never asks for an administrator password.
9. Failure: a failed release is a red run with its step named; the live manifest is untouched until step 3 and
   verified after it. A failed update is a log line and a retry 6 hours later; the installed app stays as it was.
10. Platforms: macOS 13+ (arm64 and Intel, one universal build). Linux keeps compiling with the updater off. Windows:
    none.
