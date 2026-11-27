# Harness Device: a signed release that updates itself — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `make release-device` cuts one signed, notarized, universal macOS `.dmg` of Harness Device with a stable download link, and an installed app finds a newer release, checks its signature, installs it and relaunches on its own.

**Architecture:**
- **Release.** `device-app/scripts/device-manifest.py` holds every release rule (next version, allowed ref, the run's commit on `origin/main`, manifest, publish order, public verification) and is unit-tested with a fake `gcloud` and a temp Git repository; its only Git call is a read-only ancestry check. `release-device.sh` does the rest of the Git work, one HTTPS read and `gh`. `release-device.yml` (`workflow_dispatch` only) has three jobs: `version`, `build` (macos-15, Apple and updater secrets, no GCS credential), `publish` (the only job with `id-token: write`).
- **App.** The decision is pure (`app.rs`): three events, three effects, one more piece of menu state. The runner answers `CheckUpdate` and `InstallUpdate` from a thread through one door (`update.rs`, trait `AppUpdater`); only the door's system half calls `tauri-plugin-updater`. The webview gets no permission.
- **Website.** `/device` is a static page; `/device/download-macos` redirects to the manifest's `dmg.url` through the resolver Desktop's routes already use, generalised.

**Tech Stack:** Rust and Tauri 2.12 (`tauri-plugin-updater` 2.x, Rust side only), Python 3 standard library, bash, GitHub Actions, Next.js 16 and Vitest.

**Spec:** [docs/plans/2026-11-16-device-app-release-design.md](2026-11-16-device-app-release-design.md). Read it with this plan; where they differ, stop and report.

## Base

- Branch `feat/device-app-release`, from `main` at `1ee076c588`.
- Before the first task: `cd device-app/ui && npm ci && npm run build` (the binary embeds `ui/dist`) and `cd website && npm ci`. Neither `node_modules` is in this worktree today.
- Tauri's dependencies take minutes to compile: one `CARGO_TARGET_DIR` outside the repository (`device-app/AGENTS.md`).
- Tasks name code by name, never by line. If a name below is gone, stop and report.
- Each behavior task commits twice: the failing tests, then the code.

## Hard limits, every task and every check

- Nothing publishes, uploads to GCS, pushes a tag to GitHub, or starts `release-device.yml`. `release-device.sh` is run only by its tests, against a private Git remote in a temp folder with a fake `gh` and `curl`.
- No test, and no step of the temporary workflow, reads a secret or reaches a production backend. That includes the live manifest: no step runs `make release-device`, even with `--dry-run`, and nobody clicks Download on a locally served `/device`.
- No fixed sleep in a test: wait on a condition, with a bound.
- Until Task 10 lands Diego's public key, every local build that starts the app passes `--config '{"plugins":{"updater":{"pubkey":"<a key from cargo tauri signer generate>"}}}'` (the updater plugin will not start without one). PR CI never starts the app and needs nothing.

## Files

| Files | Task | Gate |
|---|---|---|
| `website/src/lib/desktopManifest.ts`, `website/src/app/device/**`, `website/README.md` | 1 | `website-checks` (PR CI) |
| `device-app/scripts/device-manifest.py`, `test_device_manifest.py`, `.github/workflows/ci.yml` | 2 | `device-app-checks`, new step |
| `device-app/scripts/release-device.sh`, `test_release_device.py`, `Makefile` | 3 | the same step |
| `device-app/src-tauri/src/{types,app,model,runner,update,lib,main}.rs`, `docs/plans/2026-11-13-device-menubar-design.md` | 4 | `cargo test --locked`: PR CI on Linux, a Mac by hand |
| `device-app/src-tauri/{Cargo.toml,Cargo.lock,tauri.conf.json}`, `src/{update,main,types}.rs` | 5 | the same |
| `device-app/scripts/{release-setup,release-build,release-check}.sh` | 6 | Task 9's run |
| `.github/workflows/release-device.yml` | 7 | `actionlint`; after merge, `--prepare` |
| `device-app/RELEASE.md`, `device-app/AGENTS.md`, `docs/validation-and-release.md` | 8 | none |
| `.github/workflows/tmp-device-app-release.yml`, `device-app/scripts/tmp-e2e-update.sh` | 9 | its own run; both removed before merge |
| `device-app/src-tauri/tauri.conf.json`, `src/types.rs` | 10 | `cargo test --locked` |

Nothing under `cli/` changes. The daemon core is not touched.

## Global Constraints

- **Version.** Tags are `vX.Y.Z_device`; each part matches `0|[1-9][0-9]*`. Next version: patch bump of max(highest `v*_device` tag, live `version`); `.99` rolls to the next minor at `.1`; `--minor` gives `X.(Y+1).1`. A release must be strictly greater than the live version. `Cargo.toml` and `Cargo.lock` carry `0.0.0`; `tauri.conf.json` has no `version`.
- **Fixed names.** `Harness-Device.dmg`, `Harness-Device.app.tar.gz`, `Harness-Device.app.tar.gz.sig`.
- **Fixed places.** Bucket `gs://s3-autonomous-upgrade-3/harness/device/`; files under `<version>/`; manifest `metadata.json`. Asset URLs start `https://cdn.autonomous.ai/harness/device/<version>/`. The manifest is read at `https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/metadata.json`, never through the CDN. Page `https://harness.autonomous.ai/device`; link `https://harness.autonomous.ai/device/download-macos`.
- **Manifest.** Exactly the spec's shape: `version`, `notes`, `pub_date`, `platforms.darwin-aarch64` and `platforms.darwin-x86_64` (same `url` and `signature`), `dmg` (`url`, `sha256`, `size`).
- **Cache-Control.** Assets `public, max-age=31536000, immutable`; manifest `no-cache`.
- **Secrets, by name only.** `APPLE_CERTIFICATE_BASE64`, `APPLE_CERTIFICATE_PASSWORD`, `KEYCHAIN_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT`, `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. No value appears in a file, a log or the pull request.
- **Workflow.** `workflow_dispatch` only. Workflow `permissions: contents: read`; `id-token: write` on `publish` only. A secret or a ref name reaches a script through `env:`, never inline in `run:`.
- **Update timing.** Tick every 5 s (unchanged). A check is due when none has started, or the last started 21 600 s ago or more, by `abs_diff`. Check timeout 30 s; download timeout 300 s.
- **Menu copy.** `Updating to 0.1.3…` (disabled) and `Update 0.1.3…` (action), each just before the separator; `…` is U+2026.
- **Log lines.** `update: found 0.1.3`, `update: installed 0.1.3`, `update: failed check|download|signature|install`, `update: skipped not-writable`. No URL, no path, nothing else from the manifest.
- **No password.** The plugin's administrator-password path is never reached: the app checks it can replace its bundle before it downloads.
- **`device-app/AGENTS.md`.** One entitlement, unchanged. One log, redacted. The capability file is unchanged. No other component's path in a quoted string: in the scripts, build every path from the script's own folder (`"$here/…"`), and never start a quoted string with `tests/`, `scripts/`, `docs/`, `desktop/`, `cli/` or `website/` (`scripts/ci-plan.py` reads it as a read of that folder).
- **Copy.** Short; buttons 1-2 words (`Download`, `Update 0.1.3…`). Names follow `docs/naming-system.md`: the app is **Harness Device**, the hardware is the **dial**.
- **Platforms.** App: macOS 13 or later, arm64 and Intel in one build; Linux compiles the same code and never checks. Website: every browser. Windows: none.

## Review Focus

1. **A second run for the same version after the first failed midway.** Its rebuilt files differ from the ones already in the bucket, and no-clobber keeps the old ones. A manifest written then would name bytes that fail every app's signature check. Expected: `publish` stops before the manifest write unless each file in the bucket equals this build's. Task 2, `test_publish_stops_when_a_file_in_the_bucket_differs`.
2. **A run started by hand on the wrong ref, a commit not on `main`, or a version that is not `X.Y.Z`** (a branch with `publish`, another product's tag, a `_device` tag pushed on an unreviewed commit, `v0.1.0`, a newline). Expected: refused in seconds, before any build. Task 2, `test_ref_rules` and `test_the_runs_commit_must_be_on_main`; Task 7's `version` job calls `ref` right after it fetches `main`, before any build.
3. **A manifest whose `version` is not plain `X.Y.Z`** (a pre-release, 10 000 characters, anything a writer of the bucket chose). It would reach the menu and the log. Expected: it counts as a failed check, and none of its text is shown or logged. Task 5, `only_a_plain_version_is_an_update`.
4. **No release yet: the bucket answers 403.** The website may go live before the first release. Expected: `/device` renders, the link answers 503 naming Harness Device, and the release script stops unless `--allow-no-manifest`. Task 1, `reports 503 when the bucket refuses the manifest`; Task 3, `test_an_unreadable_manifest_stops_unless_it_is_the_first_release`.
5. **The dispatch fails after the tag is pushed** (`gh` signed out, network). A second run of the script would refuse the existing tag, with no run started. Expected: the script exits non-zero and prints the one `gh workflow run …` line to run by hand; the tag is never deleted or moved. Task 3, `test_a_dispatch_that_fails_after_the_push_says_what_to_run`.

## Decided (PM, 2026-11-16)

Not reopened: the dial's QR is its own item; the app updates without asking, on the existing Tick; no administrator password, and a bundle that cannot be replaced gets a log line once per version and the row **Update 0.1.3…** opening the fixed page through `Effect::OpenUrl`; one universal dmg; the tag is the version; `Cargo.toml` carries `0.0.0`; the workflow runs only by hand, with `version` and `publish`; Desktop's signing action and secrets by name, plus the two updater secrets; the same bucket and CDN; no GitHub Release page; no Homebrew cask; no website deploy from this branch; no placeholder key.

The plan's six questions, answered as recommended (PM, 2026-11-16):

1. Every run's commit must be on `origin/main`, checked by `device-manifest.py ref` (Task 2, tested) after the `version` job fetches `main` (Task 7).
2. Until Diego's public key lands, every local build that starts the app passes a generated key through `--config` (Hard limits); PR CI is unaffected. Task 10 stays blocked on the key and stays the last change to shipped code.
3. The end-to-end run also starts `0.0.1` from a folder it cannot write; pass is `update: skipped not-writable` in the log, the bundle unchanged, the app still running (Task 9, Verification 1).
4. The first commands, after the merge and only with Diego's go: `make release-device ARGS="--prepare 0.1.0 --allow-no-manifest"`, then `make release-device ARGS="0.1.0 --allow-no-manifest"` (Task 3's tests, Task 8's docs, Verification 6).
5. `/device` is as the spec has it; the phone's copy belongs to the QR item.
6. The Design section's reviewer is "PM (orchestrator)", already in the spec.

## Decided here, where the spec was silent

1. **Not writable is a kind of `UpdateFailed`.** The spec names three events; `UpdateFailure::NotWritable` carries the fourth outcome, and the reducer logs it as `skipped`, not `failed`.
2. **Writable means the bundle's folder and the bundle itself.** The plugin asks for a password when moving the bundle is refused, which either can cause. A bare binary (no `.app` around it) counts as not writable.
3. **A version already blocked stays `Update 0.1.3…` while it is tried again** every 6 hours, so the menu and its log line do not flip twice a check.
4. **After the install the `Updating to…` row goes;** the relaunch follows on the first tick with nothing running. `Relaunch` is preceded by `StopWatch`, as `Quit` is.
5. **A build that does not update itself has no door** (`Doors.updater: None`, as `shell` is where the install is not offered). The runner then answers `UpdateChecked(None)` at once, so the reducer needs no flag and a debug or Linux build reaches no network.
6. **`publish` lives in `device-manifest.py`,** not in the workflow's YAML, as Desktop's does in `scripts/publish-desktop-manifest.py`: the order, the generation rule and the 404 rule are then tested before merge. So do the allowed-ref rule and the on-`main` rule (`ref`) and the build's checksums (`sums`).
7. **A tag with no message of its own is refused by the `version` job,** before the build: the manifest's `notes` are the tag message.
8. **`0.0.2` in the end-to-end check reads `https://127.0.0.1:<port>/metadata.json`.** A release build refuses `http` without the dangerous key, which only `0.0.1` may carry; `https` to a plain server fails locally, so the relaunched app reaches nothing beyond 127.0.0.1.
9. **The release notes list is Desktop's:** every commit since the last `_device` tag, or the last 20 with none.
10. **The Tauri CLI is `cargo install tauri-cli --version 2.12.4 --locked`:** the version that wrote `Cargo.lock` (tauri 2.12.5). About 8 minutes of each run.
11. **The menu table in `docs/plans/2026-11-13-device-menubar-design.md` gains the two rows,** as the Sound change did. `desktop/design/desktop-design-system.md` does not change: both rows are kinds it already has.
12. **The temporary script goes with the temporary workflow.** Kept alone it would be dead code. A permanent check is a proposal (end of this plan).
13. **The on-`main` rule holds for every run, not only `publish`.** A prepare's commit is `main`'s by its ref, so the check never refuses one; one rule with no branch is simpler than an argument used only sometimes.

## Tasks

| # | Title | Effort | Depends on |
|---|---|---|---|
| 1 | Website: `/device` and its download link | high | none |
| 2 | `device-manifest.py`: the release rules | xhigh | none |
| 3 | `release-device.sh` and `make release-device` | xhigh | 2 |
| 4 | The update rules: reducer, menu rows, the runner's door | xhigh | none |
| 5 | The updater plugin behind the door; the version placeholder | xhigh | 4 |
| 6 | The release build scripts | high | none |
| 7 | `release-device.yml` | xhigh | 2, 6 |
| 8 | Docs | medium | none |
| 9 | TEMPORARY: the end-to-end workflow and its script | xhigh | 2, 5, 6 |
| 10 | The updater's public key (blocked on Diego) | medium | 5 |

Longest chain: 4 → 5 → 9 (or 10).

---

### Task 1: Website: `/device` and its download link

**Effort:** high. **Depends on:** none.

**Files:**
- Modify: `website/src/lib/desktopManifest.ts`, `website/README.md`
- Create: `website/src/app/device/page.tsx`, `website/src/app/device/download-macos/route.ts`
- Test: `website/src/app/device/page.spec.tsx`, `website/src/app/device/download-macos/route.spec.ts`

**Interfaces:**
- Produces, in `desktopManifest.ts`:
  ```ts
  export type ManifestDownload = {
    manifestUrl: string;
    field: string;                       // the manifest key whose `url` is the asset
    allowedPrefixes: readonly string[];
    extension: string;
    product: string;                     // names the product in the 503 text
  };
  export async function resolveManifestDownload(download: ManifestDownload): Promise<Response>;
  ```
- Keeps `resolveDesktopDownload(manifestKey: string, expectedExt: string)` for its five routes, now one call of the function above with Desktop's values (`product: "Desktop"`, the existing URL with its `HARNESS_DESKTOP_METADATA_URL` override, the existing two prefixes).

**Test that fails first:** both new spec files (the modules they import do not exist).

- [ ] **Step 1: Write `route.spec.ts`.** Stub `fetch` as `website/src/app/desktop/download-macos/route.spec.ts` does. Constants:
  ```ts
  const MANIFEST = "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/metadata.json";
  const CDN_DMG = "https://cdn.autonomous.ai/harness/device/0.1.0/Harness-Device.dmg";
  const ORIGIN_DMG = "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/0.1.0/Harness-Device.dmg";
  ```
  Cases, one `it` each:
  - `redirects to the dmg the manifest names`: body `{ version: "0.1.0", platforms: {}, dmg: { url: CDN_DMG, sha256: "x", size: 1 } }` → 302, `Location` is `CDN_DMG`, `Cache-Control` is `no-store, max-age=0`, and `fetch` was called with `MANIFEST` and `{ cache: "no-store" }`.
  - `also redirects to the bucket's own address`: `ORIGIN_DMG` → 302.
  - `reports 503 when the bucket refuses the manifest`: `fetch` resolves `new Response("", { status: 403 })` → 503, body `Harness Device download is temporarily unavailable (manifest HTTP 403).\n`.
  - `reports 503 when the manifest cannot be fetched`: `fetch` rejects → 503, body ends `(manifest unreachable).\n`.
  - `refuses anything outside its own folder`: each of `https://evil.example/Harness-Device.dmg`, `https://cdn.autonomous.ai/harness/desktop/1.2.3/Harness-macos.dmg`, `https://cdn.autonomous.ai/harness/device/0.1.0/Harness-Device.app.tar.gz` as `dmg.url` → 503, no `Location`, body ends `(no usable dmg entry).\n`.
  - `reports 503 when the manifest has no dmg`: bodies `{ platforms: { "darwin-aarch64": { url: CDN_DMG } } }`, `null` and `"x"` → 503.
  - `reads one fixed manifest`: `vi.stubEnv("HARNESS_DESKTOP_METADATA_URL", "https://example.test/m.json")`, `vi.resetModules()`, import the route again, call it → `fetch` was called with `MANIFEST`. Restore with `vi.unstubAllEnvs()`.
- [ ] **Step 2: Write `page.spec.tsx`.** Render `DevicePage`. Assert: a heading named `Harness Device`; the text `The menu-bar app for the dial. macOS 13 or later.`; `screen.getAllByRole("link")` has length 1, named `Download`, with `href` `/device/download-macos`.
- [ ] **Step 3: Run and see them fail.** `cd website && npx vitest run src/app/device` → both files fail to import.
- [ ] **Step 4: Commit the tests.** `git add website/src/app/device && git commit -m "Website: tests for /device and its download link"`
- [ ] **Step 5: Generalise the resolver.** Move the body of `resolveDesktopDownload` into `resolveManifestDownload`; the 503 text becomes `` `${product} download is temporarily unavailable (${reason}).\n` `` and the bad-entry reason `` `no usable ${field} entry` ``. Desktop's five route specs must pass unchanged.
- [ ] **Step 6: Write the route.** `export const dynamic = "force-dynamic"`; `GET` returns `resolveManifestDownload` with the constants above: the fixed manifest URL (no environment read), `field: "dmg"`, the two device prefixes (`https://cdn.autonomous.ai/harness/device/`, `https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/`), `extension: ".dmg"`, `product: "Harness Device"`.
- [ ] **Step 7: Write the page.** A server component, no client code. Classes from Desktop's page through the alias, `import styles from "@/app/desktop/page.module.css"` (`wrap`, `card`, `badge`, `title`, `description`, `download`); no new CSS file. Content: the `Download` icon badge, `<h1>` `Harness Device`, one paragraph `The menu-bar app for the dial. macOS 13 or later.`, one `<a className={styles.download} href="/device/download-macos">` with an `aria-hidden` icon and the word `Download`.
- [ ] **Step 8: Add two rows to the route table in `website/README.md`:** `/device` (the page) and `/device/download-macos` (302 to the dmg in the device manifest).
- [ ] **Step 9: Run the component's checks.** `cd website && npx tsc --noEmit && npx eslint . && npx vitest run && npm run build` → all pass; the build lists `/device` and `/device/download-macos`.
- [ ] **Step 10: Commit.** `git add website && git commit -m "Website: /device, and a download link that follows the device manifest"`

---

### Task 2: `device-manifest.py`: the release rules

**Effort:** xhigh (what is published, and in what order). **Depends on:** none.

**Files:**
- Create: `device-app/scripts/device-manifest.py`
- Test: `device-app/scripts/test_device_manifest.py`
- Modify: `.github/workflows/ci.yml` (job `device-app-checks`, one step)

**Interfaces:** Python 3, standard library only. The device-app's own copy of the rules: no import of anything under `scripts/` or `desktop/`.

Constants: `BUCKET = "gs://s3-autonomous-upgrade-3/harness/device"`, `CDN_BASE = "https://cdn.autonomous.ai/harness/device"`, `ORIGIN_MANIFEST = "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/metadata.json"`, `FILES = ("Harness-Device.dmg", "Harness-Device.app.tar.gz", "Harness-Device.app.tar.gz.sig")`.

| Command | Does | Output |
|---|---|---|
| `next --tags FILE [--manifest FILE] [--minor] [--allow-no-manifest] [X.Y.Z]` | The next version. `--tags`: `git tag -l` output. No `--manifest`: the live manifest could not be read. | stdout `version=…`, `last_tag=…` (empty with none), `live=…`, one a line |
| `ref VERSION GIT_REF PUBLISH COMMIT` | Whether a run may proceed. `PUBLISH` is `true` or `false`. `COMMIT` is the run's commit (40 lowercase hex); it must be `origin/main` or an ancestor of it in the current repository, so the caller fetches `main` first. The ref rules are checked before Git runs. | exit 0, or 1 |
| `sums --dir DIR --out FILE` / `sums --dir DIR --check FILE` | sha256 and size of the three files, written or compared | JSON `{name: {sha256, size}}` |
| `build --version V --dir DIR --notes-file F --pub-date T --base-url U --out FILE` | The manifest, from the three files in `DIR` | the JSON file, 2-space indent |
| `publish --version V --dir DIR --notes-file F --pub-date T` | The spec's publish steps 1-3, through `gcloud` | the manifest written, on stdout |
| `verify --version V --dir DIR` | Step 4: the public copy against `DIR` | exit 0, or 1 |

Every failure is one line on stderr starting `ERROR ` and exit 1. Functions the tests call directly: `next_version(tags, live, minor=False, explicit=None, allow_no_manifest=False) -> dict`, `check_ref(version, ref, publish)` (pure), `check_on_main(commit, repo=".")` (refuses a `commit` not matching `^[0-9a-f]{40}$` before any Git call, then `git merge-base --is-ancestor <commit> refs/remotes/origin/main` in `repo`: exit 0 passes, 1 is refused with a message naming `origin/main`, anything else, such as an unknown commit or no `origin/main`, is refused too), `build_manifest(version, folder, notes, pub_date, base_url) -> dict`, `publish(version, folder, notes, pub_date) -> dict`, `verify(version, folder, manifest_url=ORIGIN_MANIFEST, base_url=CDN_BASE, tries=3, pause=5.0)`. `gcloud(*args)` runs `["gcloud", *args]` with a timeout, no shell; the tests put a fake `gcloud` first on `PATH`. The one Git call runs `["git", "-C", repo, ...]` the same way, with a 30 s timeout.

`publish`, in this order:
1. `gcloud storage objects describe BUCKET/metadata.json --format=json`. An error holding `404` as a word: generation `0`, live `0.0.0`. Any other error stops. Otherwise read exactly `…metadata.json#<generation>` and take its `version`.
2. Refuse a version not strictly greater than the live one. Nothing has been uploaded yet.
3. For each of the three files: `gcloud storage cp --no-clobber --cache-control=public, max-age=31536000, immutable FILE BUCKET/<version>/<name>`, then copy the object back and compare its sha256 with the local file. A difference stops here.
4. `gcloud storage cp metadata.json BUCKET/metadata.json --if-generation-match=<generation> --content-type=application/json --cache-control=no-cache`.

`verify`: read `manifest_url` (20 s, at most 1 MiB); its `version`, both platform entries and `dmg` must equal `build_manifest(...)` for `folder` and `base_url`; then download the archive and the dmg from the URLs it names (each must start `base_url/<version>/`; 120 s; never more than the expected size plus one byte; `tries` attempts `pause` seconds apart) and compare sha256 and size.

**Test that fails first:** `test_device_manifest.py` (the script does not exist). Load the script with `importlib.util.spec_from_file_location`, as `scripts/tests/` does for hyphenated names.

- [ ] **Step 1: Write the tests.**
  - `test_next_version`, a table of `(tags, live, flags) → version`:
    `(["v0.1.0_device"], "0.1.0") → 0.1.1`; `([…"v0.1.99_device"], "0.1.99") → 0.2.1`; `--minor` from `0.1.5` → `0.2.1`; `(["v0.1.2_device"], "0.1.5") → 0.1.6`; `(["v0.2.0_device"], "0.1.9") → 0.2.1`; `(["v0.9.9_device"], "0.10.0") → 0.10.1` (numbers, not text); tags `v9.9.9_desktop`, `v01.2.3_device`, `v1.2.3_device_x`, `v1.2_device` are not counted; explicit `0.3.0` over live `0.1.0` → `0.3.0`.
  - `test_next_refuses`: explicit equal to or below the live version; explicit `0.01.0`, `v0.1.0`, `0.1`; `live=None` without the flag (the message names the manifest); `live=None` with `allow_no_manifest` and a `v0.1.0_device` tag (refused: not the first release). With the flag and no tag, explicit `0.1.0` → `0.1.0`, `live` `0.0.0`.
  - `test_a_manifest_that_is_not_one_cannot_be_read`: text `not json`, `[]`, `{}`, `{"version":"1.0"}` each read as no live version.
  - `test_ref_rules`: allowed: `("0.1.0", "refs/tags/v0.1.0_device", "true")`, `("0.1.0", "refs/heads/main", "false")`. Refused: publish on `refs/heads/main`; publish on `refs/tags/v0.1.1_device` and on `refs/tags/v0.1.0_desktop`; not publishing on `refs/heads/feat/x` and on `refs/tags/v0.1.0_device`; versions `0.1`, `v0.1.0`, `0.1.0_device`, `01.2.3`, `"0.1.0\n"`, `"$(id)"`; `PUBLISH` anything but `true` or `false`.
  - `test_the_runs_commit_must_be_on_main`: a temp repository (`git init`; every call passes `-c user.name=Fixture -c user.email=fixture@example.test -c maintenance.auto=false`; `GIT_DIR` and `GIT_WORK_TREE` dropped from the environment): commits A then B, `git update-ref refs/remotes/origin/main B`, and C on a branch from A that `main` does not hold. `check_on_main(A)` and `check_on_main(B)` pass. Refused: C (the message names `origin/main`); a 40-hex commit the repository does not have; `--help`, `-x`, `HEAD`, A's short form (none reaches Git); any commit in a second temp repository with no `refs/remotes/origin/main`.
  - `test_the_ref_command_checks_both`: run the script as a process in that repository: `ref 0.1.0 refs/tags/v0.1.0_device true <C>` exits 1 with one stderr line starting `ERROR `; with `<B>` it exits 0; `ref 0.1 refs/tags/v0.1_device true <B>` exits 1.
  - `test_build_manifest_is_the_spec_shape`: three small files in a temp folder → keys exactly `version, notes, pub_date, platforms, dmg`; both platforms hold `{"url": "<base>/0.1.0/Harness-Device.app.tar.gz", "signature": <the .sig text, stripped>}`; `dmg` holds the URL, the 64-hex sha256 and the byte size; `notes` is the file's text without trailing newlines. A missing file, or a `pub_date` not `YYYY-MM-DDTHH:MM:SSZ`, raises.
  - `test_sums_round_trip`: `--check` passes on the same folder and fails after one byte changes.
  - Publish tests use a fake `gcloud`: a Python script in a temp `bin` that keeps objects as files, a generation per object in a JSON file, logs every call, and can be told to fail one call. Cases: `test_first_release_writes_only_where_none_exists` (describe says 404 → the write carries `--if-generation-match=0`); `test_publish_guards_the_generation_it_read` (generation 7 → `=7`; cache headers as above; three uploads before the manifest write); `test_publish_refuses_a_version_not_greater` (live `0.1.0`, version `0.1.0` and `0.0.9` → error, no `cp` call logged); `test_a_refused_read_is_not_a_missing_manifest` (describe fails with `403` → error, no upload); `test_a_lost_race_never_overwrites` (the conditional write fails → error, exit 1); `test_publish_stops_when_a_file_in_the_bucket_differs` (the object exists with other bytes → error before any write of `metadata.json`); `test_a_second_run_with_the_same_files_finishes` (objects exist, identical → manifest written).
  - Verify tests serve a temp folder from `http.server` on `127.0.0.1` port 0, in a thread, and pass its URLs with `pause=0`: `test_verify_passes_on_the_published_copy`; `test_verify_fails_on_each_difference` (a changed dmg byte, a changed archive, another signature in the manifest, another version, a URL outside `base_url/<version>/`).
- [ ] **Step 2: Run and see them fail.** `python3 -m unittest discover -s device-app/scripts -p 'test_*.py' -v` → import error.
- [ ] **Step 3: Commit the tests.**
- [ ] **Step 4: Write `device-manifest.py`** to the interfaces above.
- [ ] **Step 5: Run.** The same command → all pass, with no network beyond 127.0.0.1.
- [ ] **Step 6: Add the CI step,** first after checkout in `device-app-checks` (it needs nothing installed):
  ```yaml
      # The release rules (device-app/scripts): versions, refs and the commit on main, the manifest, the publish order
      # and the release command, against temp Git repositories and fake gcloud, curl and gh. Nothing leaves 127.0.0.1.
      - name: Release script tests
        run: python3 -m unittest discover -s device-app/scripts -p 'test_*.py' -v
  ```
- [ ] **Step 7: Commit.** `git commit -m "Harness Device: the release rules in one tested script"`

---

### Task 3: `release-device.sh` and `make release-device`

**Effort:** xhigh (it tags, pushes and starts a release). **Depends on:** 2.

**Files:**
- Create: `device-app/scripts/release-device.sh`
- Test: `device-app/scripts/test_release_device.py`
- Modify: `Makefile`

**Interfaces:**
- Consumes: `device-manifest.py next` (Task 2).
- Produces: `bash device-app/scripts/release-device.sh [--dry-run] [--prepare] [--minor] [--allow-older] [--allow-no-manifest] [--wait] [--notes-file F] [X.Y.Z]`, and `make release-device ARGS="…"`.

Order, mirroring `desktop/scripts/release-desktop.sh` (read it; copy no path of it into this script):
1. Tools: `git`, `curl`, `python3`; `gh` unless `--dry-run`. An unknown flag stops.
2. `git fetch --tags --quiet origin`. Refuse a dirty tree. Refuse a `HEAD` not on `origin/main`. With `--prepare`, refuse a `HEAD` that is not `origin/main`'s tip.
3. Tags to a temp file (`git tag -l 'v*_device'`); the manifest with `curl -fsSL --connect-timeout 10 --max-time 30` from the fixed URL to a temp file. A failed read passes no `--manifest`.
4. `device-manifest.py next …` gives `version`, `last_tag`, `live`. Its error stops the script with its line.
5. Without `--prepare`: `HEAD` must contain `last_tag` and `v<live>_device` where they exist, unless `--allow-older`.
6. Refuse a tag that exists.
7. Notes: `--notes-file`, or `Harness Device <version>`, a blank line, then `git log --no-merges --pretty='- %s' <last_tag>..HEAD` (the last 20 with no tag). Empty notes stop.
8. Print the last tag, the live version, the version, the commit, the notes, and the commands it would run. `--dry-run` ends here.
9. `--prepare`: `gh workflow run release-device.yml --ref main -f version=<version> -f publish=false`. No tag.
10. Otherwise: `git tag -a v<version>_device --cleanup=verbatim -F <notes>`, `git push origin v<version>_device`, then `gh workflow run release-device.yml --ref v<version>_device -f version=<version> -f publish=true`. If that fails: say the tag is pushed, print that exact line to run by hand, exit 1. Never delete the tag.
11. `--wait`, after either dispatch: find the newest run of `release-device.yml` for `HEAD`'s commit created at or after the dispatch (`gh run list --workflow release-device.yml --commit <sha> --event workflow_dispatch --json databaseId,createdAt`, at most 12 tries 5 s apart), then `gh run watch <id> --exit-status`.

**Test that fails first:** `test_release_device.py`. Model it on `scripts/tests/test_desktop_release_prepare.py`: a temp repository holding a copy of `device-app/scripts/` (copy the folder from this file's own directory), a bare `origin` beside it, and a temp `bin` first on `PATH` with a fake `curl` (prints the file a variable names, or exits 22) and a fake `gh` (appends its arguments as JSON lines to a log; can be told to exit 1; answers `run list` with one run). Every `git` call passes `-c user.name=Fixture -c user.email=fixture@example.test -c maintenance.auto=false`. Drop `GIT_DIR` and `GIT_WORK_TREE` from the environment.

- [ ] **Step 1: Write the tests.**
  - `test_a_release_tags_pushes_and_starts_the_run_on_the_tag`: tag `v0.1.0_device`, live `0.1.0`, one newer commit on `origin/main` → exit 0; `origin` has an annotated `v0.1.1_device` whose message starts `Harness Device 0.1.1`; the `gh` log is `["workflow","run","release-device.yml","--ref","v0.1.1_device","-f","version=0.1.1","-f","publish=true"]`.
  - `test_a_dry_run_tags_pushes_and_starts_nothing`: output names `0.1.1`, the notes and the `gh workflow run` line; no tag here or on `origin`; no `gh` log.
  - `test_prepare_starts_main_without_a_tag`: `gh` log `[…,"--ref","main","-f","version=0.1.1","-f","publish=false"]`; no tag.
  - `test_prepare_runs_only_at_origin_mains_tip`: one commit behind `origin/main` → refused, stderr names `origin/main`; on a pushed branch that is not `main` → refused.
  - `test_refuses_dirty_unpushed_and_existing`: an untracked file; a commit not pushed; `0.1.0` given while `v0.1.0_device` exists.
  - `test_refuses_code_older_than_the_last_release`: `v0.1.0_device` on the newer commit, `HEAD` reset to the older one (still on `origin/main`) → refused; with `--allow-older --dry-run` → exit 0.
  - `test_an_unreadable_manifest_stops_unless_it_is_the_first_release`: `curl` exits 22 → refused, stderr names the manifest; no tags, `--prepare 0.1.0 --allow-no-manifest` at `origin/main`'s tip → the `gh` log is `[…,"--ref","main","-f","version=0.1.0","-f","publish=false"]` and no tag exists here or on `origin` (the first command of a first release); no tags, `0.1.0 --allow-no-manifest` → `v0.1.0_device` pushed; with `v0.1.0_device` present, `0.1.1 --allow-no-manifest` → refused.
  - `test_a_dispatch_that_fails_after_the_push_says_what_to_run`: `gh` exits 1 → exit 1; stderr holds `gh workflow run release-device.yml --ref v0.1.1_device -f version=0.1.1 -f publish=true`; the tag is still on `origin`.
  - `test_wait_follows_the_run_it_started`: the `gh` log ends with `["run","watch","<id>","--exit-status"]`.
  - `test_the_notes_file_is_the_tag_message`.
- [ ] **Step 2: Run and see them fail.** `python3 -m unittest discover -s device-app/scripts -p 'test_release*.py' -v`
- [ ] **Step 3: Commit the tests.**
- [ ] **Step 4: Write `release-device.sh`** (`set -euo pipefail`; a header comment with the usage, as Desktop's has).
- [ ] **Step 5: Add the target to `Makefile`,** after `release-desktop`, and `release-device` to `.PHONY`:
  ```make
  ## release-device: tag this commit vX.Y.Z_device, push the tag and start release-device.yml on it — CI builds one
  ## universal macOS app, signs and notarizes it, publishes it to GCS and verifies the downloads. The version is bumped
  ## from max(last git tag, live harness/device/metadata.json). ARGS="--dry-run" to preview, ARGS="--prepare" to build,
  ## sign and check main's tip without publishing, ARGS="--minor" or ARGS="X.Y.Z". See device-app/RELEASE.md.
  release-device:
  	bash device-app/scripts/release-device.sh $(ARGS)
  ```
- [ ] **Step 6: Run.** The whole folder's tests pass. Do not run the script or the target by hand.
- [ ] **Step 7: Commit.** `git commit -m "make release-device: tag, push and start the device release"`

---

### Task 4: The update rules: reducer, menu rows, the runner's door

**Effort:** xhigh (threads answer the reducer; it decides the relaunch). **Depends on:** none.

One task because `match` on `Event` (`app.rs`), on `Effect` (`runner.rs`) and on `MenuAction` (`main.rs`) are all exhaustive: the words cannot land without their rules.

**Files:**
- Create: `device-app/src-tauri/src/update.rs`
- Modify: `device-app/src-tauri/src/types.rs`, `app.rs`, `model.rs`, `runner.rs`, `lib.rs`, `main.rs`
- Modify: `docs/plans/2026-11-13-device-menubar-design.md` (the Menu table, two rows)
- Test: the `tests` modules of `app.rs`, `model.rs`, `runner.rs`, `main.rs`

**Interfaces:**
- Produces, in `types.rs`:
  ```rust
  /// Why an update did not happen. NotWritable: the person cannot replace the bundle; nothing was downloaded.
  #[derive(Clone, Copy, Debug, PartialEq, Eq)]
  pub enum UpdateFailure { Check, Download, Signature, Install, NotWritable }

  /// The app's own update, as the menu shows it.
  #[derive(Clone, Debug, Default, PartialEq, Eq)]
  pub enum AppUpdate { #[default] None, Installing(String), Blocked(String) }

  // Event:      UpdateChecked(Option<String>), UpdateInstalled, UpdateFailed(UpdateFailure)
  // Effect:     CheckUpdate, InstallUpdate, Relaunch        (Relaunch is the binary's, as Quit is)
  // MenuAction: Update
  // AppState:   pub app_update: AppUpdate
  ```
- Produces, in `update.rs`:
  ```rust
  /// The app's own update: the one door the updater is reached through.
  pub trait AppUpdater: Send + Sync {
      /// Asks once. Ok(Some(version)): a strictly newer release.
      fn check(&self) -> Result<Option<String>, UpdateFailure>;
      /// Downloads the release the last check found, checks its signature and puts it over the running bundle.
      fn install(&self) -> Result<(), UpdateFailure>;
  }
  ```
- Produces, in `runner.rs`: `Doors.updater: Option<Arc<dyn AppUpdater>>` ("None where the app does not update itself"). `main.rs` sets `updater: None` in this task; Task 5 replaces it.

**The rules** (`app.rs`). New private state: `checked_at: Option<u64>`, `found: Option<String>`, `skipped: Option<String>`, `relaunch: bool`. Constants `CHECK_EVERY_SECS: u64 = 21_600` and `DEVICE_PAGE: &str = "https://harness.autonomous.ai/device"`. Something *runs* while `state.cli == CliState::Installing` or a sign-in is held (`self.login`).

| Event | Rule |
|---|---|
| `Tick`, a relaunch waits, nothing runs | Stop the watch as Quit does, then `Relaunch`. Nothing else this tick. |
| `Tick`, after the keep-alive | If nothing runs, `app_update` is not `Installing`, and a check is due: `checked_at = now`, `CheckUpdate`. |
| `UpdateChecked(None)` | `found = None`; `app_update = None`. |
| `UpdateChecked(Some(v))` | Log `update: found {v}`; `found = v`; `app_update = Installing(v)` unless it is already `Blocked(v)`; `InstallUpdate`. Not held back by a sign-in. |
| `UpdateInstalled` | Log `update: installed {v}`; `app_update = None`; the relaunch waits. |
| `UpdateFailed(NotWritable)` | `app_update = Blocked(v)`; log `update: skipped not-writable` unless `skipped` is already `v`; `skipped = v`. |
| `UpdateFailed(other)` | Log `update: failed check\|download\|signature\|install`; an `Installing` row goes; a `Blocked` row stays. |
| `Menu(MenuAction::Update)` | `OpenUrl(DEVICE_PAGE)`. |

**The menu** (`model.rs`), after the Sound row and before the separator: `Installing(v)` → `MenuItem::Text("Updating to {v}…")`; `Blocked(v)` → `MenuItem::Action(MenuAction::Update, "Update {v}…")`.

**The runner.** `Relaunch` joins `Menu`, `Show` and `Quit` (returned to the binary). `CheckUpdate` and `InstallUpdate` each run on a thread of their own and answer with one event: `check` → `UpdateChecked(found)` or `UpdateFailed(kind)`; `install` → `UpdateInstalled` or `UpdateFailed(kind)`. With no door, both answer `UpdateChecked(None)` at once.

**`main.rs`.** `menu_id(MenuAction::Update)` is `"update"`; `menu_action` lists it. `draw` gains `Effect::Relaunch => handle.restart()`: on the main thread, as `Quit` is.

**Test that fails first:** the tests below (they name variants that do not exist).

- [ ] **Step 1: Write the reducer tests** in `app.rs`, with the helpers already there (`found`, `fresh`, `on_sign_in`, `tick`, `login`, `has`, `rows`, `logs`, `menu_of`) and `const H6: u64 = 21_600;`. The PM's red test, in full:
  ```rust
  #[test]
  fn a_bundle_that_cannot_be_replaced_offers_the_page_and_says_so_once() {
      let mut app = found();
      app.handle(tick(B + 5));
      app.handle(Event::UpdateChecked(Some("0.1.3".into())));
      let effects = app.handle(Event::UpdateFailed(UpdateFailure::NotWritable));
      assert_eq!(logs(&effects), ["update: skipped not-writable"]);
      let menu = menu_of(&effects);
      let row = MenuItem::Action(MenuAction::Update, "Update 0.1.3…".into());
      let at = menu.iter().position(|item| *item == row).expect("the row");
      assert_eq!(menu[at + 1], MenuItem::Separator);
      // The fixed page, with nothing of the manifest in it.
      assert_eq!(
          app.handle(Event::Menu(MenuAction::Update)),
          [Effect::OpenUrl("https://harness.autonomous.ai/device".into())]
      );

      // Six hours on, the same version: tried again, the row stays, and the line is not said twice.
      assert!(has(&app.handle(tick(B + 5 + H6)), &Effect::CheckUpdate));
      let effects = app.handle(Event::UpdateChecked(Some("0.1.3".into())));
      assert!(has(&effects, &Effect::InstallUpdate));
      assert!(!effects.iter().any(|effect| matches!(effect, Effect::Menu(_))));
      assert!(logs(&app.handle(Event::UpdateFailed(UpdateFailure::NotWritable))).is_empty());

      // A newer version changes the row, and is said once more.
      app.handle(tick(B + 5 + 2 * H6));
      app.handle(Event::UpdateChecked(Some("0.1.4".into())));
      let effects = app.handle(Event::UpdateFailed(UpdateFailure::NotWritable));
      assert_eq!(logs(&effects), ["update: skipped not-writable"]);
      assert!(rows(&effects).contains(&"Update 0.1.4…".to_string()));
  }
  ```
  The others, by name and what each asserts:
  - `the_first_tick_checks_and_then_every_six_hours`: `tick(B + 5)` has `CheckUpdate`; after `UpdateChecked(None)`, `tick(B + 10)` and `tick(B + H6)` do not; `tick(B + 5 + H6)` does; then `tick(B + 5)` does (a clock set back: `abs_diff`).
  - `no_check_starts_while_the_cli_installs_or_a_sign_in_runs`: `fresh()`: `tick(B + 5)` has no `CheckUpdate`; after `InstallDone(Ok(()))`, `tick(B + 10)` has it. `on_sign_in()` after `Act(Action::SignIn)`: none at `tick(B + 5)`; after `Login(Done(Ok(())))`, `tick(B + 10)` has it.
  - `a_newer_version_is_installed_and_the_app_relaunches`: `UpdateChecked(Some("0.1.3"))` → has `InstallUpdate`, `logs` is `["update: found 0.1.3"]`, the menu holds `Text("Updating to 0.1.3…")` directly before its `Separator`; `tick(B + 5 + H6)` has no `CheckUpdate` while it installs; `UpdateInstalled` → `logs` is `["update: installed 0.1.3"]`, no `Updating to` row, no `Relaunch`; the next tick is exactly `[Effect::StopWatch, Effect::Relaunch]`.
  - `a_sign_in_delays_the_relaunch_not_the_download`: `on_sign_in()`, `tick(B + 5)`, `Act(SignIn)`, then `UpdateChecked(Some(..))` still has `InstallUpdate`; after `UpdateInstalled`, `tick(B + 10)` has no `Relaunch`; after `Login(Done(Ok(())))`, `tick(B + 15)` ends with `StopWatch`, `Relaunch`.
  - `a_failure_is_one_line_and_the_next_check_tries_again`: for each of `Check`, `Download`, `Signature`, `Install`: `logs` is `["update: failed <word>"]`; no `Relaunch` or `InstallUpdate`; no `Updating to` row left; `tick(B + 10)` has no `CheckUpdate`; `tick(B + 5 + H6)` has it.
  - `nothing_newer_changes_nothing`: `UpdateChecked(None)` gives no effects; after a `Blocked` row, it removes the row.
- [ ] **Step 2: Change the expected lists of existing tests that assert a first tick exactly.** `CheckUpdate` comes last: `the_keep_alive_drives_the_daemon` and `only_a_watch_the_app_stopped_ends_for_good` (`[SpawnWatch, CheckUpdate]`), `a_cli_that_comes_back_is_found_on_a_tick` (`[FindCli, CheckUpdate]`). If any other expectation needs to change, stop and report.
- [ ] **Step 3: Write the menu tests** in `model.rs` (`state()` gains `app_update: AppUpdate::None`, and `the_whole_menu` passes unchanged): `the_update_rows`: `Installing("0.1.3")` puts `Text("Updating to 0.1.3…")` directly before `Separator`, after a Sound row when there is one; `Blocked("0.1.3")` puts `Action(MenuAction::Update, "Update 0.1.3…")` there; `menu_log` ends `… | Update 0.1.3… | Open Harness | Quit`.
- [ ] **Step 4: Write the runner tests** in `runner.rs`. A double implementing `AppUpdater`: it answers what the test set, counts calls, and its `check` waits on a gate (a `Mutex<bool>` and a `Condvar`, as `Scripts` does).
  - `an_update_check_runs_on_its_own_thread`: gate shut; `runner.run(Effect::CheckUpdate)` returns `None` at once; open the gate; `next()` is `Event::UpdateChecked(Some("0.1.3".into()))`.
  - `a_check_or_an_install_answers_its_failure`: `check` → `Err(Check)` gives `UpdateFailed(UpdateFailure::Check)`; `install` → `Ok` gives `UpdateInstalled`; `Err(NotWritable)` gives `UpdateFailed(UpdateFailure::NotWritable)`.
  - `with_no_updater_a_check_finds_nothing`: the default `world()`: `answer(Effect::CheckUpdate)` is `Event::UpdateChecked(None)`.
  - `relaunch_is_the_binarys`: `runner.run(Effect::Relaunch)` is `Some(Effect::Relaunch)`.
- [ ] **Step 5: Add `Update` to `every_menu_action_has_its_own_id`** in `main.rs`.
- [ ] **Step 6: Run and see them fail.** `cd device-app/src-tauri && cargo test --locked` → compile errors naming the missing variants.
- [ ] **Step 7: Commit the tests.**
- [ ] **Step 8: Write the code:** the words (`types.rs`), the trait (`update.rs`, `pub mod update;` in `lib.rs`), the rules (`app.rs`), the rows (`model.rs`), the door and its arms (`runner.rs`), the id, the `Relaunch` arm and `updater: None` (`main.rs`).
- [ ] **Step 9: Add two rows to the Menu table** in `docs/plans/2026-11-13-device-menubar-design.md`, after Sound: `"Updating to X…" (disabled)` while the app installs its own update; `**Update X…**` when the app cannot replace its bundle, opening `harness.autonomous.ai/device`. Link this spec.
- [ ] **Step 10: Run.** `cargo test --locked` and `cargo fmt --check` → pass.
- [ ] **Step 11: Commit.** `git commit -m "Harness Device: the rules of its own update, and the menu rows"`

---

### Task 5: The updater plugin behind the door; the version placeholder

**Effort:** xhigh (signature check, no password path, text from outside). **Depends on:** 4.

**Files:**
- Modify: `device-app/src-tauri/Cargo.toml`, `Cargo.lock`, `tauri.conf.json`, `src/update.rs`, `src/main.rs`, `src/types.rs`
- Test: the `tests` modules of `update.rs` and `types.rs`

**Facts checked** (docs.rs, `tauri-plugin-updater` 2.14.1, 2026-11-16; read the version `Cargo.lock` resolves before relying on them):
- `handle.updater_builder()` (`UpdaterExt`) `.timeout(d).build()?`, then `updater.check().await -> Result<Option<Update>>`. The timeout covers the check only.
- `Update` has public `version: String` and `timeout: Option<Duration>` (None after a check); `download(on_chunk, on_finish).await -> Result<Vec<u8>>` verifies the signature before it returns; `install(bytes) -> Result<()>` does not relaunch.
- On macOS `install` asks for an administrator password when moving the bundle is refused. This task makes that unreachable.
- The plugin's config requires `pubkey`. This task does not add one; Task 10 adds Diego's (PM, 2026-11-16). Until then, start the app only with `--config '{"plugins":{"updater":{"pubkey":"<a key from cargo tauri signer generate>"}}}'` (Hard limits).
- `AppHandle::restart(&self) -> !` relaunches through `/usr/bin/open` on the bundle.

**Interfaces:**
- Consumes: `AppUpdater`, `UpdateFailure`, `Doors.updater` (Task 4).
- Produces, in `update.rs`:
  ```rust
  /// Whether this build updates itself: a release build on macOS.
  pub fn enabled(debug: bool, os: &str) -> bool;
  /// A manifest's version when it is plain X.Y.Z, each part 1 to 5 digits: the only text of the manifest that
  /// reaches the menu and the log.
  pub fn plain_version(version: &str) -> Option<String>;
  /// The bundle an executable runs from: <name>.app/Contents/MacOS/<exe>.
  pub fn bundle_of(exe: &Path) -> Option<PathBuf>;
  /// Whether the person can replace the bundle: its folder and the bundle itself are writable.
  pub fn replaceable(bundle: &Path) -> bool;
  /// The door, where this build updates itself (`enabled`); None elsewhere.
  pub fn system(handle: &tauri::AppHandle) -> Option<Arc<dyn AppUpdater>>;
  ```
  `SystemUpdater` (private) keeps the `Update` its last check found in a `Mutex<Option<_>>`.
  - `check`: build with a 30 s timeout, `tauri::async_runtime::block_on(updater.check())`. An error is `Check`. A version `plain_version` refuses is `Check`. Otherwise keep the update and answer its version.
  - `install`: take the kept update (none: `Check`). `bundle_of(current_exe)` then `replaceable`; if not, `NotWritable`, before any download. Set `update.timeout = Some(300 s)`; `download`: a signature error (`Minisign`, `Base64`, `SignatureUtf8`, `SignedVersionMismatch`, `MissingSignedVersion`, and any other variant the resolved version names for the signature) is `Signature`, any other is `Download`; `install(bytes)`: an error is `Install`.
  - No error's text is logged or returned: it may hold a URL.

**Test that fails first:** the tests below.

- [ ] **Step 1: Write the `update.rs` tests.**
  - `only_a_release_build_on_a_mac_updates_itself`: `enabled(false, "macos")` is true; `(true, "macos")`, `(false, "linux")`, `(false, "windows")` are false.
  - `only_a_plain_version_is_an_update`: `0.1.3` and `10.20.30` pass; refused: `0.1.3-beta`, `0.1.3+build`, `v0.1.3`, `0.1`, `1.2.3.4`, `""`, `0.1.x`, `" 0.1.3"`, `"0.1.3\n"`, `123456.0.0`, and a 10 000-character string.
  - `the_bundle_is_three_folders_up`: `/Applications/Harness Device.app/Contents/MacOS/harness-device` → `/Applications/Harness Device.app`; `/x/target/release/harness-device` and `/x/Y.app/Contents/Resources/z` → `None`.
  - `a_bundle_is_replaceable_only_when_it_and_its_folder_are_writable` (unix; return early when `libc::geteuid() == 0`): a temp folder holding `X.app` → true; the folder at mode `0o555` → false; the folder writable and `X.app` at `0o555` → false; a path that does not exist → false. Restore the modes before the temp folder drops.
  - `a_signature_error_is_not_a_download_error`: the private mapping gives `Signature` for `Error::SignatureUtf8("x".into())` and `Download` for `Error::Network("x".into())` and `Error::ReleaseNotFound`.
- [ ] **Step 2: Write the `types.rs` tests.**
  - In `the_webview_may_close_itself_and_call_two_commands`, replace the last assertion: the lines of `Cargo.toml` that contain `tauri-plugin` are exactly one, and it starts `tauri-plugin-updater = `. The permissions assertion stays as it is.
  - `the_app_reads_one_https_manifest`: `plugins.updater.endpoints` is exactly `["https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/metadata.json"]`; every key of `plugins.updater` is `endpoints` or `pubkey` (so no `dangerous…` key); `bundle` has no `createUpdaterArtifacts`.
  - `the_version_is_the_releases`: `Cargo.toml` holds the line `version = "0.0.0"`; `tauri.conf.json` has no `version` key.
- [ ] **Step 3: Run and see them fail.** `cargo test --locked --lib`.
- [ ] **Step 4: Commit the tests.**
- [ ] **Step 5: Add the dependency and the placeholder.** `tauri-plugin-updater = "2"` under `[dependencies]`; `version = "0.0.0"`. Let `cargo check` write `Cargo.lock`: it gains the plugin and what it needs, and `harness-device` reads `0.0.0`. If `tauri` itself would move from 2.12.5, stop and report.
- [ ] **Step 6: Add to `tauri.conf.json`:**
  ```json
  "plugins": {
    "updater": {
      "endpoints": ["https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/metadata.json"]
    }
  }
  ```
- [ ] **Step 7: Write the door's system half** in `update.rs`.
- [ ] **Step 8: Wire `main.rs`:** `.plugin(tauri_plugin_updater::Builder::new().build())` on the builder; `updater: harness_device::update::system(handle)` in `Doors`. `capabilities/default.json` and `build.rs` do not change.
- [ ] **Step 9: Run.** `cargo test --locked` and `cargo fmt --check` → pass. No test opens a socket.
- [ ] **Step 10: Commit.** `git commit -m "Harness Device: install its own signed update, never with a password"`

---

### Task 6: The release build scripts

**Effort:** high. **Depends on:** none.

**Files:**
- Create: `device-app/scripts/release-setup.sh`, `device-app/scripts/release-build.sh`, `device-app/scripts/release-check.sh`

**Test that fails first:** none — packaging for a macOS runner, no product behavior; one commit. Their proof is Task 9's run, which also shows `release-check.sh` fail on a wrong version and on a wrong key.

**Interfaces** (each `set -euo pipefail`, each finds the app from its own folder, `here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"`):
- `release-setup.sh`: refuses unless `GITHUB_ACTIONS=true` (it installs tools). Runs `rustup toolchain install stable --profile minimal`, `rustup target add aarch64-apple-darwin x86_64-apple-darwin`, `cargo install tauri-cli --version 2.12.4 --locked`, `npm ci --no-audit --no-fund` in `ui/`, `brew install minisign`.
- `release-build.sh VERSION OUT_DIR [CONFIG_JSON]`: refuses a version not `X.Y.Z` and a machine that is not a Mac. In `src-tauri/`: `cargo tauri build --ci --target universal-apple-darwin --bundles app,dmg --config '{"version":"<VERSION>","bundle":{"createUpdaterArtifacts":true}}'`, then `--config CONFIG_JSON` when given (later wins). Signing comes from the environment, untouched: `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Then move, into an empty `OUT_DIR`, from the target folder `cargo metadata` names, under `universal-apple-darwin/release/bundle/`: `dmg/Harness Device_<VERSION>_universal.dmg` → `Harness-Device.dmg`; `macos/Harness Device.app.tar.gz` → `Harness-Device.app.tar.gz`; its `.sig` → `Harness-Device.app.tar.gz.sig`. A missing file stops.
- `release-check.sh DIR VERSION PUBKEY [--notarized]`: prints `ok: <check>` for each, or `FAILED: <check>` and exits 1. Temp folders and the mounted image are removed on exit.
  1. `DIR` holds the three fixed names.
  2. The archive unpacks to `Harness Device.app`; `lipo -archs` of `Contents/MacOS/harness-device` is the set {`x86_64`, `arm64`}.
  3. `CFBundleShortVersionString` (`/usr/libexec/PlistBuddy`) is `VERSION`.
  4. `codesign --verify --deep --strict` accepts the app.
  5. The archive's signature verifies: base64-decode `PUBKEY` and the `.sig` to files, `minisign -V -p <pub> -x <sig> -m <archive>`.
  6. The dmg, attached read-only with `-nobrowse`, holds `Harness Device.app` at `VERSION` with both architectures, and the `Applications` link.
  7. With `--notarized` only: `spctl -a -t exec -vv` and `xcrun stapler validate` accept the archive's app and the dmg's; `xcrun stapler validate` and `spctl -a -t open --context context:primary-signature -vv` accept the dmg.

- [ ] **Step 1: Write the three scripts.**
- [ ] **Step 2: Check their syntax.** `bash -n device-app/scripts/release-setup.sh device-app/scripts/release-build.sh device-app/scripts/release-check.sh`; `shellcheck` on the three when it is installed.
- [ ] **Step 3: Commit.** `git commit -m "Harness Device: build and check a release on a macOS runner"`

---

### Task 7: `release-device.yml`

**Effort:** xhigh (secrets, signing, publishing). **Depends on:** 2, 6 (its last step checks that every script it names exists).

**Files:**
- Create: `.github/workflows/release-device.yml`

**Test that fails first:** none — a workflow; one commit. It cannot be started before merge (`workflow_dispatch` needs the file on `main`). It is checked by `actionlint`, by Task 2's tests of every rule it calls (the commit on `main` among them), by Task 9's run of the scripts its `build` job calls, and after merge by `--prepare`.

**Content:**
- `name: Release Harness Device`; `run-name: Harness Device ${{ inputs.publish && 'release' || 'candidate' }} ${{ inputs.version }}`.
- `on: workflow_dispatch` only, inputs `version` (required, `Version (X.Y.Z)`) and `publish` (`type: boolean`, `default: false`).
- `permissions: contents: read`. `concurrency: group: device-release-${{ inputs.version }}`, `cancel-in-progress: false`.
- Action versions as `release-desktop.yml` uses them (`actions/checkout@v7`, `actions/upload-artifact@v4`, `actions/download-artifact@v4`, `actions/setup-node@v7`, `google-github-actions/auth@v2`).

| Job | Steps |
|---|---|
| `version` (ubuntu-latest, 5 min; output `version`) | Checkout, sparse `/device-app/scripts/` (every sparse checkout here sets `sparse-checkout-cone-mode: false`), `fetch-depth: 0`, `filter: blob:none` (the commits, not their files). Fetch `main`: `git fetch --no-tags --filter=blob:none origin +refs/heads/main:refs/remotes/origin/main`. Then `python3 device-app/scripts/device-manifest.py ref "$VERSION" "$REF" "$PUBLISH" "$COMMIT"` with `VERSION: ${{ inputs.version }}`, `REF: ${{ github.ref }}`, `PUBLISH: ${{ inputs.publish }}`, `COMMIT: ${{ github.sha }}` in `env:` (the ref rules and the commit on `origin/main`, Task 2). With `publish`: `git fetch --depth=1 --force origin tag "$REF_NAME"` (`REF_NAME: ${{ github.ref_name }}` in `env:`; checkout leaves a pushed tag lightweight, as `release-desktop.yml` notes); the ref must be an annotated tag (`git cat-file -t` is `tag`) with a message that is not empty. |
| `build` (macos-15, 60 min; `needs: version`) | Checkout, sparse `/device-app/` and `/.github/actions/macos-signing/`. `actions/setup-node@v7`, `node-version: 24.22.2`. `bash device-app/scripts/release-setup.sh`. `./.github/actions/macos-signing` with the six secrets as `release-desktop.yml` passes them. Build: `security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"`, then `bash device-app/scripts/release-build.sh "$VERSION" "$RUNNER_TEMP/out"`, with `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (from `APPLE_APP_PASSWORD`), `APPLE_TEAM_ID`, `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `KEYCHAIN_PASSWORD` in `env:`. Notarize the dmg: `xcrun notarytool submit "$RUNNER_TEMP/out/Harness-Device.dmg" --keychain-profile harness-notarize --wait --output-format json`; any status but `Accepted` prints `notarytool log <id>` and fails; then `xcrun stapler staple`, at most 3 tries 10 s apart. Check: `bash device-app/scripts/release-check.sh "$RUNNER_TEMP/out" "$VERSION" "$PUBKEY" --notarized`, `PUBKEY` read from `plugins.updater.pubkey` of the committed `tauri.conf.json`. `device-manifest.py sums --dir "$RUNNER_TEMP/out" --out "$RUNNER_TEMP/out/sums.json"`. Upload `harness-device-${{ needs.version.outputs.version }}` (`retention-days: 7`, `if-no-files-found: error`). Last, `if: always()`: `security delete-keychain "$KEYCHAIN_PATH" \|\| true`. |
| `publish` (ubuntu-latest, 15 min; `needs: [version, build]`; `if: ${{ inputs.publish }}`; `permissions: contents: read, id-token: write`) | Checkout, sparse `/device-app/scripts/` and `/.github/actions/setup-gcloud/`. Download the artifact to `out/`. `device-manifest.py sums --dir out --check out/sums.json`. Notes: fetch the tag as above, `git tag -l --format='%(contents)' "$REF_NAME" > notes.txt`. `google-github-actions/auth@v2` with `GCP_WORKLOAD_IDENTITY_PROVIDER` and `GCP_SERVICE_ACCOUNT`; `./.github/actions/setup-gcloud`. `device-manifest.py publish --version "$VERSION" --dir out --notes-file notes.txt --pub-date "$(date -u +%Y-%m-%dT%H:%M:%SZ)"`. `device-manifest.py verify --version "$VERSION" --dir out`. One line in `$GITHUB_STEP_SUMMARY`. |

No job but `publish` names a GCP secret; `publish` names no Apple or updater secret.

- [ ] **Step 1: Write the workflow.**
- [ ] **Step 2: Lint it.** `GOTOOLCHAIN=go1.26.8 go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 .github/workflows/release-device.yml` → no output.
- [ ] **Step 3: Check what it names exists.** `grep -o 'device-app/scripts/[a-z-]*\.\(sh\|py\)' .github/workflows/release-device.yml | sort -u | xargs ls -l` → every file listed. `grep -c 'id-token' .github/workflows/release-device.yml` → `1`. `grep -n 'pull_request\|push:\|schedule' .github/workflows/release-device.yml` → nothing.
- [ ] **Step 4: Commit.** `git commit -m "Release Harness Device: build, sign, notarize, publish, by hand only"`. Do not start the workflow.

---

### Task 8: Docs

**Effort:** medium. **Depends on:** none (every name it uses is fixed by this plan).

**Files:**
- Create: `device-app/RELEASE.md`
- Modify: `device-app/AGENTS.md`, `docs/validation-and-release.md`

**Test that fails first:** none — docs; one commit.

- [ ] **Step 1: Write `device-app/RELEASE.md`,** short, in the repo's plain words:
  - **Cutting a release:** `make release-device` and each flag, with one line each. The first release, with Diego's go: first `make release-device ARGS="--prepare 0.1.0 --allow-no-manifest"`, then `make release-device ARGS="0.1.0 --allow-no-manifest"` (the bucket holds no manifest yet, so both name the version and pass the flag).
  - **What CI does:** the three jobs; every run's commit must be on `main`; two notarizations (the app by Tauri, the dmg by the workflow); the checks before anything leaves the build; nothing reaches GCS without `publish`; only `main` may be prepared, and why.
  - **The manifest:** its address, its shape, who reads which field (the app: `platforms`; the website: `dmg`).
  - **Keys:** the secret names only. The updater key: made with `cargo tauri signer generate -w ~/.tauri/harness-device.key`; its public half is `plugins.updater.pubkey`; losing the private key means installed apps can never update again.
  - **When it fails:** a red run names its step; the live manifest is untouched until the last write; a second run for the same version finishes only if the bucket's files equal its own; a dispatch that failed after the tag was pushed is started by hand with the line the script printed; a bad release is fixed by a higher version (`--allow-older` for older code).
  - **How an installed app updates:** when it checks, the four log lines, and the row for a bundle it cannot replace.
- [ ] **Step 2: Change `device-app/AGENTS.md`.**
  - *Thin over the CLI* gains: "It also fetches its own update manifest (`update.rs`), with nothing from the webview in the request."
  - *Fixed arguments* gains: "It relaunches itself through Tauri's restart (`open -n` on its own bundle), with nothing from the webview or the manifest in it."
  - A new rule: "**One plugin.** `tauri-plugin-updater`, called from Rust only; the capability gives the webview none of it."
  - Commands gain: `python3 -m unittest discover -s scripts -p 'test_*.py'` (the release rules), and a pointer to `RELEASE.md`.
  - The last line becomes: PR CI compiles and tests the app on Linux only; macOS is built and tested by hand, and released by `make release-device`.
- [ ] **Step 3: Change `docs/validation-and-release.md`.** In the PR CI table, the `device-app/` row also names the release scripts' tests. In "In short", one bullet after Desktop's: an authorized Harness Device release is `make release-device`; `ARGS="--prepare"` builds, signs and checks `main`'s tip and publishes nothing ([device-app/RELEASE.md](../device-app/RELEASE.md)).
- [ ] **Step 4: Commit.** `git commit -m "Harness Device: how it is released and how it updates"`

---

### Task 9: TEMPORARY: the end-to-end workflow and its script

**Effort:** xhigh (processes and waits on a real Mac; each failed run costs a macOS runner turn). **Depends on:** 2, 5, 6.

**Files (both TEMPORARY, removed in one commit before the merge):**
- Create: `.github/workflows/tmp-device-app-release.yml`
- Create: `device-app/scripts/tmp-e2e-update.sh`

**Test that fails first:** none — a temporary workflow; one commit.

**The workflow:** `name: TEMPORARY device-app release e2e`; a first-line comment saying it is removed before the merge. `on: push: branches: [feat/device-app-release]`, nothing else. `permissions: contents: read`. No `secrets.` anywhere. `concurrency: group: tmp-device-app-release`, `cancel-in-progress: true`. One job on `macos-15`, `timeout-minutes: 75`: checkout (sparse `/device-app/`, `sparse-checkout-cone-mode: false`), `actions/setup-node@v7` at `24.22.2`, `bash device-app/scripts/release-setup.sh`, `bash device-app/scripts/tmp-e2e-update.sh`, then `actions/upload-artifact@v4` with `if: always()`, name `device-app-e2e`, path `${{ runner.temp }}/device-e2e/logs`, `retention-days: 7`. Logs only: no build is uploaded. No cache action (a cache outlives the run).

**The script** (`set -euo pipefail`; a first-line comment saying it is temporary). One helper, `wait_until SECONDS COMMAND…`: runs the command once a second until it succeeds or the bound passes.
1. Refuse unless `GITHUB_ACTIONS=true` and the machine is a Mac. Refuse if `$HOME/.local/bin/harness` or the app's state folder already exists. `work="$RUNNER_TEMP/device-e2e"`, with `serve/`, `logs/`, `old/`, `new/`.
2. Keys, made in the run: `cargo tauri signer generate --ci -w "$work/key"` and a second pair `"$work/other"`. `export TAURI_SIGNING_PRIVATE_KEY="$work/key" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" APPLE_SIGNING_IDENTITY=-`. `pub` is the text of `key.pub`.
3. Server: `python3 -u -m http.server 0 --bind 127.0.0.1 --directory "$work/serve"` in the background, its output to `logs/server.log`; `wait_until 10` for the line naming its port.
4. Build `0.0.1` into `old/` with `{"plugins":{"updater":{"pubkey":"<pub>","endpoints":["http://127.0.0.1:<port>/metadata.json"],"dangerousInsecureTransportProtocol":true}}}`. Build `0.0.2` into `new/` with `{"plugins":{"updater":{"pubkey":"<pub>","endpoints":["https://127.0.0.1:<port>/metadata.json"]}}}`.
5. `release-check.sh` passes for `old` at `0.0.1` and `new` at `0.0.2` with `pub`. It must fail for `new` at `0.0.3`, and for `new` at `0.0.2` with the other pair's public key.
6. `device-manifest.py build --version 0.0.2 --dir new --notes-file <a one-line file> --pub-date <now, UTC> --base-url "http://127.0.0.1:<port>" --out serve/metadata.json`; copy `new/`'s three files to `serve/0.0.2/`.
7. Seed the runner's own `HOME` (LaunchServices drops a temporary one): `~/.local/bin/harness` as a link to `src-tauri/tests/fake-harness`, with a `fake/` folder beside it holding `hardware_watch_--json` (`{"attached":false}` then `@stdin`) and `auth_status_--json` (`{"loggedIn":true}`); and `~/Library/Application Support/ai.autonomous.harness.device/state.json` as `{"version":1,"cliSeen":true,"askedSignIn":true,"askedClaude":true,"loginItem":true}`. The log is `~/Library/Logs/ai.autonomous.harness.device/app-*.log`.
8. **A folder it cannot write** (PM, 2026-11-16): unpack `old`'s archive into `locked/`, `chmod -R a-w locked`, `open -n "locked/Harness Device.app"`. `wait_until 120` for `update: skipped not-writable` in the log. Then: the log has `update: found 0.0.2` and no `update: installed`; the bundle's `CFBundleShortVersionString` is still `0.0.1`; a process from `locked/` still runs. Stop it and `wait_until 15` for it to be gone; `chmod -R u+w locked`.
9. **The update:** unpack `old`'s archive into `run/`, `open -n "run/Harness Device.app"`; `wait_until 30` for its process, and keep its pid. Pass when all three hold: `wait_until 180` the bundle's `CFBundleShortVersionString` is `0.0.2`; `wait_until 60` the log has `update: installed 0.0.2`; `wait_until 60` a process from `run/` runs under another pid. Print `PASS: 0.0.1 updated itself to 0.0.2 and relaunched`.
10. On exit, always: stop every process from `locked/` and `run/`, stop the server, copy the app's log to `logs/app.log`.

- [ ] **Step 1: Write both files.**
- [ ] **Step 2: Lint.** `actionlint` on the workflow (the command of Task 7, Step 2) → no output; `bash -n device-app/scripts/tmp-e2e-update.sh`; `grep -c 'secrets\.' .github/workflows/tmp-device-app-release.yml` → `0`.
- [ ] **Step 3: Commit.** `git commit -m "TEMPORARY: end-to-end check of the device app's release and update"`
- [ ] **Removal (devcrew, before the merge):** delete both files in one commit. `git grep -n 'tmp-e2e-update\|tmp-device-app-release'` then finds nothing outside `docs/plans/`.

---

### Task 10: The updater's public key (blocked on Diego)

**Effort:** medium. **Depends on:** 5. **Blocked on:** the public key from Diego (`cargo tauri signer generate -w ~/.tauri/harness-device.key`; the public half is not secret). Until it arrives this task does not start, and the branch does not merge.

This is the last change to shipped code before the merge. No other task, and no test, uses this key: Task 9 builds with keys made in its own run, so its result stands whether this lands before or after it.

**Files:**
- Modify: `device-app/src-tauri/tauri.conf.json`
- Test: `device-app/src-tauri/src/types.rs`

**Test that fails first:** `the_updater_checks_with_the_committed_key`.

- [ ] **Step 1: Write the test** in `types.rs`. `plugins.updater.pubkey` is a string of 100 to 300 characters, each of `A-Z a-z 0-9 + / =`, starting `dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6` (base64 of `untrusted comment: minisign public key:`, the first line of every key Tauri writes).
- [ ] **Step 2: Run and see it fail.** `cargo test --locked --lib the_updater_checks_with_the_committed_key` → fails: no `pubkey`.
- [ ] **Step 3: Commit the test.**
- [ ] **Step 4: Add `"pubkey": "<the key, exactly as Diego gave it>"`** beside `endpoints`. Never a key made anywhere else.
- [ ] **Step 5: Run.** `cargo test --locked --lib` → pass (`the_app_reads_one_https_manifest` already allows the key).
- [ ] **Step 6: Commit.** `git commit -m "Harness Device: the updater's public key"`

The private half and its password are Diego's to store as `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; they are needed only by the first run of `release-device.yml`, after the merge. If the secret and this key ever disagree, the build job's signature check fails before anything is published.

---

## Verification

No check publishes, uses a production backend, reads a secret, or touches the apps or the daemon on anyone's Mac.

1. **End to end: the app updates itself** (Task 9). Workflow `tmp-device-app-release.yml`, on GitHub, `macos-15`, started by a push to `feat/device-app-release`. Backend: a Python file server on 127.0.0.1 (a free port) inside the runner, serving the manifest `device-manifest.py` wrote; the CLI is the repo's fake; the keys are made in the run. Isolation: the repo has no guide for this app, so the script is the guide: it runs only on a disposable runner (it refuses anywhere else, and refuses a `HOME` that already holds a `harness` launcher or the app's state), seeds that runner's own `HOME`, signs ad hoc, and stops every process it started. A person should see: the run green; in its log the `ok:` lines of `release-check.sh` for both builds, its two expected failures, and `PASS: 0.0.1 updated itself to 0.0.2 and relaunched`; in the artifact `device-app-e2e`, `app.log` with `update: found 0.0.2`, then `update: skipped not-writable` with the bundle still `0.0.1` and that app still running, then `update: installed 0.0.2`. The evidence is the run on the last head that still holds the workflow; after it only the removal commit, and Task 10 if the key came late, may follow. No by-hand workflow exists for this; see Proposals.
2. **PR CI** (automatic, once the pull request is ready): `device-app-checks` (Linux: the release scripts' tests, the UI's typecheck, Vitest and bundle, `cargo test --locked`) and `website-checks` (tsc, eslint, vitest, build); `process-checks` for `ci.yml` and `Makefile`.
3. **Workflow lint, locally:** `actionlint` on `release-device.yml` and, while it exists, `tmp-device-app-release.yml` (Task 7, Step 2). PR CI's own `actionlint` list does not name them.
4. **Local checks for the touched areas,** at the final commit, recorded in the pull request:
   - On a Mac (PR CI compiles only the Linux code): `cd device-app/src-tauri && cargo test --locked`.
   - `cd device-app/ui && npm test && npm run typecheck`.
   - `python3 -m unittest discover -s device-app/scripts -p 'test_*.py' -v`.
   - `cd website && npx tsc --noEmit && npx eslint . && npx vitest run && npm run build`.
   - `python3 scripts/local-checks.py --list <the branch's paths>`: no gate maps `device-app/`, `website/`, the workflows or the docs, so it should name none. If it names one, run it.
5. **By eye, the user's own (optional):** `cd website && npm run dev`, open `http://localhost:3000/device`: the name, the one line, one **Download** button, light and dark. Do not click it: the link reads the live manifest.
6. **After the merge, with Diego's go only; not a merge gate:** first `make release-device ARGS="--prepare 0.1.0 --allow-no-manifest"`. It needs the two updater secrets and Task 10's key. It proves the real signing, both notarizations and `release-check.sh --notarized`, and publishes nothing: the signed files exist only as that run's artifact for 7 days. Then the first release: `make release-device ARGS="0.1.0 --allow-no-manifest"`. A person should see both runs green, the second with its `verify` step passing.

## Proposals (not built)

- **A Homebrew cask** for Harness Device (the spec's out-of-scope list).
- **A permanent update check.** Keep Task 9's script and run it from a `workflow_dispatch` workflow on `macos-15` when `device-app/src-tauri/src/update.rs`, the release scripts or the Tauri version change.
- **Lint the release workflow in PR CI:** add `release-device.yml` to the `plan` job's `actionlint` list.
- **The download resolver and `..`:** a manifest URL such as `…/harness/device/../desktop/x.dmg` passes the prefix test for Desktop's routes and this one alike. Refusing `..` segments is a change to both.
