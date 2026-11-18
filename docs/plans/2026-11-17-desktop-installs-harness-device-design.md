# Desktop installs Harness Device

Date: 2026-11-17. Branch: `feat/desktop-installs-harness-device`. Components: `desktop/` only.

## Why

People on Harness Desktop with a dial plugged in, but without the Harness Device menu-bar app
(`device-app/`, `Harness Device.app`, bundle id `ai.autonomous.harness.device`), miss what only that app does: the
app-in-front watch (`front.rs`) that swipe and follow for Orca, the Claude app, Herdr and VS Code need, Terminal,
iTerm2 and Ghostty tab follow (`tabs.rs`), and keeping the daemon up (`keepalive.rs`, login item). The dial itself,
voice, recap and the #4399 auto setup already work through the CLI.

Diego (2026-11-17): when Desktop sees a dial and Harness Device is not installed, Desktop offers it and installs it in
place: the right build for this computer, from the release's own manifest, verified, installed and opened. No web
page: `harness.autonomous.ai/device` is no longer used.

## Decisions (PM, 2026-11-17)

1. **Where.** Both: a band across the top of the window, and a row on the Devices tab under the selected dial on this
   computer.
2. **One click.** Install installs: no dialog before it. The button reads `Installing…` while it runs; a failure shows
   one line and Retry; on success the app opens.
3. **Declined.** `Not now` hides the band for good on this computer. The Devices row stays.
4. **Platforms.** macOS 13 or later only (`SMAppService`; Desktop itself runs from macOS 12). Linux, Windows, the web
   and macOS 12 show nothing: Harness Device publishes no other build.
5. **Installed, running.** Desktop asks LaunchServices by bundle id, and AppKit whether it runs. Installed but not
   running: the Devices row offers `Open`; the band never shows for it.
6. **What is downloaded.** The update archive `Harness-Device.app.tar.gz` the manifest names, with its sha256 and
   size, then its code signature is checked. No dmg, no `hdiutil`.
7. **Where it goes.** `/Applications` when Desktop can write there, else `~/Applications`. Never a password prompt.
   An existing `Harness Device.app` at the target counts as installed and is never overwritten.
8. **Links to `harness.autonomous.ai/device`.** A separate small PR after this one (see Follow-up). Not in this branch.
9. **Any device.** Any attached device on this computer shows the offer, a square Harness Pro too, with the same copy.
10. **A real install, seen by a person, holds the merge.** Diego checks it on his Mac from a signed internal build
    (Verification); every other check runs to green CI before it.

Answers to the plan's questions (PM, 2026-11-17): the band's buttons, colour, icon and place; `’` in copy; a 64 KiB
manifest and no redirects; 60 s timeouts; the lookup filtered in Dart; a signature-refused run and real-`codesign`
cases; the behavior after an install (below); the plan's ASCII mockups are the confirmed ones.

## Approach

Desktop does it all in Dart, plus one small Swift channel for the LaunchServices and AppKit lookups. It reuses the
updater's pieces (`lib/update/`): the Dio client shape, the off-isolate sha256, and `codesign` through the same
runner with a timeout. Nothing in the CLI or the daemon core changes. Rejected: a `harness device-app install` CLI
command (a new CLI surface for a Desktop-only offer), and opening the dmg for a person to drag (Diego ruled it out).

## Behavior

### When the offer shows

All of these hold:

- macOS, version 13 or later (`Platform.operatingSystemVersion`), not a viewer build;
- signed in, past setup, the tour and the sign-in step (the same `deviceBands` gate the other bands use);
- a dial is plugged in to this computer: `AppNotifier.dial.status.attached` (the local daemon's `dial_status`);
- the probe says Harness Device is not installed.

The probe runs when the dial becomes attached (`AppNotifier.dial`), when the window comes back to the front while a
dial is attached (`AppNotifier.foreground`), when the Devices tab ticks (its own 10 s `visibleTick` in `DevicesTab`,
which calls the controller's `refresh()`), and after an install. It is one AppKit call each; nothing polls while no
dial is attached. A finished install is trusted at once (the controller moves to installed from the installer's own
result), since LaunchServices may register a freshly renamed bundle a moment later.

### The band

Top of the window, last of the device bands in `app_shell.dart` (under the held-computer band, above the shared-tab
notice), in the band style of `NewDeviceNotice`: the same amber band, with `AppIcons.arrowDownToLine` in place of the
shield, and `AppIcons.triangleAlert` on a failure, as the update band does. The quiet button first, the main one last:

> Your dial follows apps and terminal tabs with the Harness menu-bar app.   `Not now`  `Install`

Copy names the app as the [Naming System](../naming-system.md) does: the menu-bar app is **Harness**, with the
descriptor "menu-bar app" beside Desktop (also Harness); only the file is `Harness Device.app`.

- `Install` runs the install (below); the button reads `Installing…`, disabled, until it ends.
- Success: the app opens and the band goes (the probe now says installed).
- Failure: the band stays, its text becomes the failure line (below), the button reads `Retry`.
- `Not now` stores the dismissal (Data) and the band never shows on this computer again. It is disabled while an
  install runs, as the update band's Skip is.

### The Devices row

On the Devices tab, at the top of the settings column (`DeviceSettingsPanel`'s column, beside the showcase), only
when the selected device is on this computer (`local`) and attached. A `SettingRow`-shaped block:

- Not installed: title `Menu-bar app`, detail `Follows the app and terminal tab in front.`, button `Install`
  (`Installing…`, then `Retry` with the failure line, as on the band).
- Installed, not running: same title and detail, button `Open`, which runs `/usr/bin/open -b
  ai.autonomous.harness.device` (fixed arguments).
- Installed and running: no row (an empty state shows nothing).

Both surfaces share one controller, so an install started from one shows `Installing…` on the other, and a second
press joins the running install instead of starting another.

After an install, and when a lookup fails:

- Installed but `open` failed: `Retry` on the band and `Open` on the row only open the app, with no second download.
- `Open` failing from the row shows `Installed. Couldn’t open it.`
- A lookup that fails keeps the last answer, or shows nothing when there is none.
- After an install, a lookup that still says "not installed" is not believed until one says "installed"
  (LaunchServices registers late). Someone who deletes the app in that gap sees no offer until Desktop restarts.

### The install

`DeviceAppInstaller.install()`, one at a time per window; steps in order, each with a name used in logs and measures:

1. **manifest**: `GET https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/metadata.json` (the
   bucket, never the CDN), 15 s timeout. Entry: on Apple Silicon `device-macos-arm64`, then `device-macos`; on Intel
   `device-macos`. Refused unless `url` is `https://` under `https://cdn.autonomous.ai/harness/device/` or
   `https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/`, `sha256` is 64 hex, and `size` is an
   integer from 1 byte to 200 MiB (200 × 1024 × 1024). The manifest's body is read up to 64 KiB, and neither request
   follows a redirect, so nothing a server sends but the two checked values reaches a request.
2. **download**: Dio stream into a new private temp directory (`Directory.systemTemp.createTemp`), 5 min timeout;
   stops past the manifest's `size`.
3. **checksum**: the file's size and sha256 equal the manifest's. The hash reads the file in chunks inside an
   isolate (`Isolate.run` over the path), never the whole archive in memory.
4. **unpack**: `/usr/bin/tar -xzf <archive> -C <temp>/app`, 60 s timeout. The result must be exactly one top-level entry, a
   directory named `Harness Device.app`, not a link. (bsdtar already refuses absolute paths and `..` without `-P`.)
5. **signature**: `codesign --verify --deep --strict -R=<requirement>` on the unpacked bundle, where the requirement
   is the updater's (`anchor apple generic`, Developer ID leaf, `notarized`) with the running Desktop's Team ID
   (read from `currentBundlePath` by `parseMacSigner`, as the updater does) and identifier
   `ai.autonomous.harness.device` (both apps are signed by the same team today). `update_signature.dart` is changed
   to serve both: `macUpdateRequirement` takes the identifier as a parameter, and a `verifyMacBundle({bundle, team,
   identifier})` beside `verifyMacUpdate` runs the check through the same private runner and timeout; the updater
   keeps its behavior. Same rule as Desktop's own updater: a running Desktop with no signer (a local dev build)
   checks sha256 only; every released Desktop is signed, so released builds always check the signature.
6. **install**: try `/Applications` first, then `~/Applications` (created if missing). In each, if
   `Harness Device.app` exists, stop: installed, nothing written. Otherwise `/usr/bin/ditto` (60 s timeout) the bundle to
   `.Harness Device.app.<random>.partial` in that folder; a permission refusal there (EACCES/EPERM, or `ditto`
   exiting non-zero with nothing written) moves on to `~/Applications`. Then rename the partial to
   `Harness Device.app` (same folder, so the rename is atomic); a failed rename removes the partial.
7. **open**: `/usr/bin/open <target>/Harness Device.app`, 60 s timeout. The app's own first run handles its login item.

The temp directory is removed in `finally`, whatever happened. Every process runs with fixed arguments built in Dart;
nothing from the manifest except the URL (prefix-checked) and the sha256 reaches a command or request.

Failure lines (one line, short):

| Step | Line |
|---|---|
| manifest, download | `Couldn’t download the app.` |
| checksum, unpack, signature | `Couldn’t verify the download.` |
| install | `Couldn’t install the app.` |
| open | `Installed. Couldn’t open it.` (the row then offers `Open`) |

### Logs and measures

- `appLog` lines: `device app: install started`, `device app: install done`,
  `device app: install failed <step>`, `device app: lookup failed`, `device app: open failed`. No path, URL, version string from the network, or team id.
- No product measure in this branch. A new Desktop flow counts only once the backend lists it
  (`PRODUCT_USAGE_DESKTOP_FLOWS`) and the daemon core's `APP_USAGE_VOCABULARY` (`cli/src/core/api.ts`) is raised;
  that is a core change, which this feature may not make. The final report proposes the measures (offer shown,
  Install, Not now, installed, failed by step) as their own item.

## Components

| Unit | File | Does |
|---|---|---|
| Probe | `desktop/macos/Runner/HarnessDeviceApp.swift` (added to `Runner.xcodeproj/project.pbxproj` as `MoveToApplications.swift` is; registered in `MainFlutterWindow.swift`), channel `harness/device_app`, method `lookup` | Returns `{paths, running}` for `ai.autonomous.harness.device`: the paths of `NSWorkspace.urlsForApplications(withBundleIdentifier:)`, and running from `NSRunningApplication.runningApplications(withBundleIdentifier:)`. It filters nothing. |
| Probe (Dart) | `desktop/lib/devices/device_app_probe.dart` | `DeviceAppProbe` interface and the channel implementation. Off macOS, below 13 or in a viewer build the probe is never asked: `deviceAppSupported()` (`device_app.dart`), read in `device_app_setup.dart`, is the offer's `supported`, and an unsupported offer never looks and never shows. Installed when any returned path exists on disk and is neither in a Trash nor under `/Volumes/`; this filter is pure Dart, tested by PR CI. |
| Installer | `desktop/lib/devices/device_app_installer.dart` | The seven steps; injectable manifest URL, Dio, process runner, signature check, target folders and opener for tests. |
| Controller | `desktop/lib/devices/device_app_offer.dart` | `DeviceAppOffer` (ChangeNotifier): state `hidden / offer / installing / failed(step) / notRunning`, the dismissal, the join of a second press, the log lines. Owned by `AppNotifier`, which feeds it the dial and window-front events. |
| Band | `desktop/lib/widgets/device_app_band.dart` | The band, placed in `app_shell.dart` under `deviceBands`. |
| Row | `desktop/lib/devices/device_app_row.dart`, placed by `desktop/lib/devices/devices_screen.dart` | The Devices row (its own file, so the gallery can import it). |
| Design | `desktop/design/desktop-design-system.md`, `desktop/test/elements_gallery_test.dart`, `desktop/test/goldens/elements/` | The band and row in the doc and the gallery (a new section key, light and dark goldens), each state. |

## Data and Design (docs/feature-design-rules.md)

Stored: one local key, `device_app.offer_dismissed` = `true`, in `HarnessFileStore` (`state.json`, 0600) through
`LocalKeyValueStore`. Nothing is synced or sent to the backend; the manifest is public.

1. Growth: one boolean per computer; written once by Not now; deleted with `state.json`. Nothing else is kept
   (the temp directory is removed after every attempt).
2. Concurrency: one install per window (the controller joins a second press). Two Desktop windows or processes
   installing at once: each writes its own `.partial`, and the rename fails for the second (target exists), which
   then reports installed. Nothing locks.
3. Read cost: the manifest (2.4 KB today, read up to 64 KiB) once per Install press; the archive once per attempt (about 12 MB today,
   bounded at 200 MB). The probe is one in-process AppKit call.
4. Scale: per computer, per press; nothing grows with people or agents.
5. Compatibility: no new field in any server, CLI or daemon reply. An older Desktop ignores the new key. A future
   manifest without `device-macos` fails the manifest step and says so.
6. Migration and rollback: none; a rolled-back Desktop ignores the key and offers nothing. An installed Harness
   Device stays and updates itself.
7. Audience: N/A because nothing is shared or served; logs name only the step.
8. Identity: the install runs as the person running Desktop, into a folder they can write; never `sudo`, never a
   password prompt.
9. Failure: the person sees the step's line and Retry on the surface they pressed; logs and measures name the step;
   nothing on disk changes before the rename, and the partial is removed if the rename fails.
10. Platforms: macOS 13+ only. Linux, Windows, web and macOS 12: no band, no row, no probe call.

## Testing

- **Installer** (`desktop/test/devices/device_app_installer_test.dart`): a loopback `HttpServer` serves a manifest
  and a `.tar.gz` built in the test from a fake `Harness Device.app` folder; the install and fallback folders are temp
  directories; the signature check and the opener are fakes that record their calls. Cases: success into
  `/Applications`-stand-in; not writable → the fallback; target exists → nothing written; arm64 key preferred, Intel
  key fallback; each refusal (URL outside the prefixes, bad sha256 field, size over the cap, sha256 mismatch, size
  mismatch, two top-level entries, a link, signature refused, rename fails) reports its step, writes nothing at the
  target and leaves no temp directory.
- **Signature requirement** (`desktop/test/update_signature_test.dart`): the requirement string for Harness
  Device carries the given Team ID, its identifier and `notarized`; the updater's requirement is unchanged. Three
  `verifyMacBundle` cases with real `codesign` on temporary bundles go in `desktop/test/update_signature_macos_test.dart`,
  so `make desktop-test` on a Mac keeps checking it.
- **Lookup filter** (Dart): a path in a Trash, under `/Volumes/` or missing on disk does not count as installed.
- **Controller** (`desktop/test/devices/device_app_offer_test.dart`): the conditions in "When the offer shows"
  (each one false hides it), the dismissal persisted through an in-memory `LocalKeyValueStore`, a second press joins,
  the log lines carry only step names.
- **Click-through** (`desktop/test/devices/device_app_flow_test.dart`, `TargetPlatformVariant({TargetPlatform.macOS})`):
  a dial attached and the probe saying not installed shows the band; pressing Install shows `Installing…`, then the
  opener is called and the band goes; Not now hides it and it stays hidden after a rebuild; the Devices row shows
  Install, then Open for installed-not-running, then nothing; a failure shows the line and Retry. Linux shows nothing.
- **Gallery**: the band and the row in each state.
- Never install anything on Diego's Mac in tests: no test writes outside its temp directories or runs the real
  `open`.

## Verification (end to end)

On this Mac, `desktop/integration_test/device_app_install_native_test.dart` (`flutter test -d macos`, run by the
tester, not by PR CI, since it reads the network): it builds the real `DeviceAppInstaller` against the real bucket
manifest and the real CDN archive, with the real `tar`, `ditto` and `codesign`, the Team ID `54DJVWMJCC` passed in
(the test runner is an unsigned debug build, so it cannot be read from the running bundle), two temp folders as the
install targets (the first made read-only, so the fallback runs), and a recording opener, so no second menu-bar app
starts. No app switch or `--dart-define` is added for it. Evidence: the step log, `codesign -dv` of the installed
copy, the temp folders removed afterwards, a run with a corrupted byte in a served copy refused at checksum, and an
ad-hoc signed stand-in served from loopback refused at signature. Platforms named in the PR: macOS (tested), Linux and Windows (nothing shown; covered by the
click-through test's Linux case).

**Held for the owner (holds the merge).** A signed internal build of the final head (`git push origin
HEAD:internal/<name>`, `desktop-internal-build.yml`, on the PM's go for the heavy workflow). Diego, on his Mac with a
dial: quit and remove `Harness Device.app` from `/Applications`, open the internal build, see the band, press Install,
and see the menu-bar app installed in `/Applications` and opened. The result goes in the PR body.

## Follow-up (separate small PR, after this merges)

The links to `harness.autonomous.ai/device`, as the PM decided:

- a. `device-app/src-tauri/src/app.rs:20,244`: "Update X…" (when the app cannot replace its own bundle) opens the
  dmg URL from the manifest it already read, only under `https://cdn.autonomous.ai/harness/device/`.
- b. `device-app/RELEASE.md:4,150`: the dmg on the CDN per the manifest; Desktop installs it; marketing is
  `https://www.autonomous.ai/harness-device`.
- c. `website/src/app/device/page.tsx` (+ spec): a 308 redirect to `https://www.autonomous.ai/harness-device`, so old
  links keep working.
- d. `website/src/app/device/download-macos/` stays; `website/README.md:32` is corrected.
- e. `docs/plans/2026-11-16-device-app-release-design.md:33`: the dial's QR opens
  `https://www.autonomous.ai/harness-device`. Older plans stay as they are (history).

No CLI message, Desktop copy, firmware or mobile string points at the page today.
