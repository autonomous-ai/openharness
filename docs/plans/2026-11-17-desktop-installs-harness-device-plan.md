# Desktop installs Harness Device: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **devcrew phase 3**. Tasks 1 to 11 are test-first: a red commit
> (the tests alone), then the code commit. Task 12's red commit is the doc and the gallery section, its second the
> two images. Task 13 adds a test only and is one commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Harness Desktop sees a dial on this Mac and the Harness menu-bar app (`Harness Device.app`) is not
installed, it offers it in a band and on the Devices tab, and one click downloads, verifies, installs and opens it.

**Architecture:** All in `desktop/`. One small Swift channel asks LaunchServices and AppKit whether the app is
installed and running. In Dart: a manifest parser, an installer of seven named steps, and one controller
(`DeviceAppOffer`, a `ChangeNotifier` owned by `AppNotifier`) that both surfaces draw from. Nothing in `cli/` or
`backend/` changes.

**Tech Stack:** Flutter 3.47 / Dart 3.13, Swift (AppKit), Dio 5, `cryptography` (`DartSha256`), `archive` (tests
only, to build a `.tar.gz`), `/usr/bin/tar`, `/usr/bin/ditto`, `/usr/bin/codesign`, `/usr/bin/open`. No new
dependency.

**Spec:** [docs/plans/2026-11-17-desktop-installs-harness-device-design.md](2026-11-17-desktop-installs-harness-device-design.md).
Read it with this plan, the root `AGENTS.md`, `desktop/AGENTS.md`, `desktop/CLAUDE.md`,
`desktop/design/desktop-design-system.md` and `docs/naming-system.md`. The spec is the authority. Branch
`feat/desktop-installs-harness-device`, on `main` at `6e31e00202`.

## Decided

By the PM, 2026-11-17 (the spec and the brief). Not reopened:

1. Desktop does it all in Dart plus one Swift channel. Nothing in `cli/` or `backend/` changes.
2. Two surfaces: a band at the top of the window, under the `deviceBands` gate in `app_shell.dart`, in the style of
   `NewDeviceNotice`; and a row at the top of the settings column on the Devices tab, for a dial on this computer.
3. One click. Install installs, no dialog. `Installing…`, then a failure line and `Retry`, or the app opens.
4. `Not now` hides the band for good on this computer (local key `device_app.offer_dismissed`). The row stays.
5. macOS 13 or later only. Linux, Windows, the web and macOS 12 show nothing and make no lookup.
6. The lookup is LaunchServices (`urlsForApplications`, filtered in Dart, see 23) and `NSRunningApplication`.
   Installed and not running shows `Open`, on the row only.
7. The download is the manifest's `Harness-Device.app.tar.gz` (`device-macos-arm64` then `device-macos` on Apple
   Silicon, `device-macos` on Intel), checked by sha256 and size, unpacked with `tar`, checked by `codesign` against
   the running Desktop's Team ID and the identifier `ai.autonomous.harness.device`. `/Applications`, then
   `~/Applications`. Never overwrite. Never a password.
8. No product measure in this branch. Log lines only.
9. The links to `harness.autonomous.ai/device` are a later pull request.

The plan's own, each from what the code showed (below):

10. Shared facts (ids, the support rule, the steps and their lines, the probe's interface) are one small file,
    `device_app.dart`, so the installer and the controller can be built at the same time.
11. The manifest's rules are their own file, `device_app_manifest.dart`: pure, tested on every host.
12. The row is its own widget file, `device_app_row.dart`, placed by `devices_screen.dart`: the gallery must
    import it, and the row and the screen's wiring are then separate tasks.
13. The installer's manifest URL, target folders, signature check and opener are **required** parameters. Only
    `device_app_setup.dart` passes the real ones, so a test that forgets one does not compile, instead of
    installing on the developer's Mac.
14. Tests reach the loopback server through a Dio interceptor that rewrites the CDN host. The two allowed URL
    prefixes stay constants nobody can pass in.
15. `app_state.dart` (22,376 lines) is touched by one task only.

The PM's answers to the plan's questions, 2026-11-17 (the spec carries them too):

16. **The band's buttons.** The quiet `Not now` first, the main `Install` last, as every other band and the design
    doc.
17. **The band's colour and icon.** The amber band of `NewDeviceNotice`, with `AppIcons.arrowDownToLine` in place
    of the shield, and `AppIcons.triangleAlert` on a failure, as the update band does.
18. **Where the band sits.** Last of the device bands: under the held-computer band, above the shared-tab notice.
19. **Apostrophes.** `’` in every line of copy (`Couldn’t …`), as the rest of the app.
20. **The signature cases' file.** The requirement cases go in the existing `desktop/test/update_signature_test.dart`.
21. **The manifest's size, and redirects.** The manifest's body is read up to 64 KiB, and neither request follows
    a redirect, so nothing a server sends but the two checked values reaches a request.
22. **Timeouts.** `tar`, `ditto` and `open` 60 seconds each, the signature check's own value. The archive's cap
    is 200 MiB (200 × 1024 × 1024 bytes).
23. **The lookup's filter is in Dart.** Swift returns the paths `urlsForApplications` gives and whether the app
    runs, and filters nothing. Dart counts a path as installed when it exists on disk, is in no Trash and is not
    under `/Volumes/`, in a pure function pull request CI tests (Tasks 2 and 3).
24. **A wrongly signed bundle, and real `codesign`.** Both: the native test serves an ad-hoc signed stand-in from
    loopback and expects it refused at `signature` (Task 13), and three real-`codesign` cases for
    `verifyMacBundle` go in `desktop/test/update_signature_macos_test.dart`, so `make desktop-test` on a Mac keeps
    checking it (Task 4).
25. **After an install, and when a lookup fails.** (a) Installed but `open` failed: `Retry` on the band and `Open`
    on the row only open the app, with no second download. (b) `Not now` is disabled while an install runs, as
    the update band's Skip is. (c) `Open` failing from the row shows `Installed. Couldn’t open it.` (d) A lookup
    that fails keeps the last answer, or shows nothing when there is none. (e) Two log lines beside the spec's
    three: `device app: lookup failed` and `device app: open failed`. (f) After an install, a lookup that still
    says "not installed" is not believed until one says "installed" (LaunchServices registers late); someone who
    deletes the app in that gap sees no offer until Desktop restarts.
26. **Any device.** A square Harness Pro alone shows the offer too, with the same copy (Task 11 clicks it).
27. **The mockups.** The ASCII mockups under [Mockups](#mockups) are the confirmed ones.
28. **A real install, seen by a person, holds the merge.** After the final review and every other check passes,
    the owner checks it on his Mac from a signed internal build of the final head ([Verification](#verification)
    6). No task: nothing in the code changes for it (no switch, no `--dart-define`).

## Global Constraints

- **Platforms.** macOS 13 or later (tested). Linux, Windows, the web, macOS 12: no band, no row, no lookup.
- **Copy, exact.** Band: `Your dial follows apps and terminal tabs with the Harness menu-bar app.` Row title
  `Menu-bar app`, detail `Follows the app and terminal tab in front.` Buttons: `Install`, `Installing…` (U+2026),
  `Retry`, `Open`, `Not now`. Failure lines: `Couldn’t download the app.` (manifest, download),
  `Couldn’t verify the download.` (checksum, unpack, signature), `Couldn’t install the app.` (install),
  `Installed. Couldn’t open it.` (open).
- **Fixed values.** Bundle id `ai.autonomous.harness.device`. Bundle name `Harness Device.app`. Channel
  `harness/device_app`, method `lookup`. Manifest
  `https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/metadata.json`. Allowed URL prefixes
  `https://cdn.autonomous.ai/harness/device/` and
  `https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/`. Local key `device_app.offer_dismissed`,
  value `true`. Timeouts: manifest 15 s, download 5 min, each tool 60 s.
- **Never** a password prompt, `sudo`, an overwrite of an existing `Harness Device.app`, a dmg or `hdiutil`.
- **Fixed arguments.** Every process is started with arguments built in Dart. Of the manifest, only the URL (checked
  against the prefixes), the sha256 and the size are used.
- **Tests never touch the developer's Mac.** Temporary folders, a loopback `HttpServer`, a recording opener. No
  test writes outside its own temporary directories. Of the tests this plan adds, only Task 4's three cases in
  `test/update_signature_macos_test.dart` (on temporary bundles, skipped off macOS) and Task 13's native test run
  the real `codesign`. No test runs the real `open`.
- **Every test passes or is skipped on Linux and Windows.** Pull request CI runs the suite on Linux. A case that
  needs `/usr/bin/ditto` is skipped unless `Platform.isMacOS`, as `test/update_signature_macos_test.dart` does.
- **Logs.** `device app: install started`, `device app: install done`, `device app: install failed <step>`,
  `device app: lookup failed`, `device app: open failed`. No path, URL, network version string or Team ID.
- **No product measure.** No timer in the controller. No fixed sleep in a test.
- **The web build still compiles.** `app_shell.dart`, `app_state.dart` and `devices_screen.dart` are in it. Import
  the CPU through `core/runtime_architecture.dart` (the conditional one); no new `dart:ffi` import.
- **No quoted string that names another component's path** (`device-app/…`, `devices/…`, `cli/…`) in a Desktop
  source or test: `make merge-pr` reads it as a file read. Name other components in comments only.
- **Commands** run from `desktop/`: `flutter test --no-pub --concurrency=2 --timeout=60s <files>` and
  `flutter analyze <files>`. Format the lines you write; never run `dart format` over an existing file.
- **Stage only your own files.** Never `git add -A`.

## Found while reading the code

- **The live release, read today.** The manifest has `device-macos` and `device-macos-arm64`, both naming
  `https://cdn.autonomous.ai/harness/device/0.1.4/Harness-Device.app.tar.gz`, 12,424,649 bytes. The archive holds
  one top-level entry, the directory `Harness Device.app`, and no `._` files. The bundle is universal, needs macOS
  13.0, is stapled, and on this Mac passes
  `codesign --verify --deep --strict -R=<the updater's requirement with team 54DJVWMJCC and identifier
  ai.autonomous.harness.device>`. With the identifier `ai.autonomous.harness` it fails. Both URLs answer 200 with
  no redirect.
- **This Mac has `/Applications/Harness Device.app` and `/Applications/Harness.app`.** The real lookup says
  "installed" here.
- **`Platform.operatingSystemVersion` on macOS** reads `Version 26.6.2 (Build 25G83)`.
- **The band recipe.** Each band draws its own (`new_device_notice.dart`, `shared_tab_notice.dart`,
  `update_notice.dart`): `WindowDragArea`, a transparent `Material`, a 10% tint blended over
  `AppPalette.windowBg`, a 28% bottom rule, padding `fromLTRB(14 + trafficLightClearance, 7, 10, 7)`, a 16-point
  icon, `AppType.body` text, the quiet button, then the main one. `_DeviceBand` is private and draws a shield.
- **`trafficLightClearance` is the host's, not the test's:** 78 on a Mac, 0 elsewhere
  (`RuntimePlatform.isMacOS`, `lib/widgets/window_chrome.dart:20`). A band drawn into a gallery image with it
  would differ between this Mac and Linux CI, and both run the gallery.
- **`dial.status.attached` is "any device attached".** The daemon's top-level status is the first attached device,
  or `{attached: false}` (`cli/src/cable/cableFleet.ts:384-386`).
- **"Not a viewer build"** is already `!kIsWeb && !kViewerMode` (`AppNotifier.devicesEnabled`).
- **Local state.** `DialState` gets `paneLayoutStore?.storage`, a `LocalKeyValueStore` over `state.json`
  (`app_state.dart:4197`). With no store (tests) nothing is written.
- **The updater's signature check** (`lib/update/update_signature.dart`): `parseMacSigner`,
  `macUpdateRequirement(MacSigner)`, `verifyMacUpdate`, and a private `_run` with `signatureCheckTimeout` (60 s).
  `test/update_signature_macos_test.dart` runs the real `codesign` on temporary bundles and is skipped off macOS.
- **Tests are flat under `desktop/test/`,** with a few folders. `scripts/test-desktop.py` finds every
  `*_test.dart` under it, so `test/devices/` is found. In-memory store: `test/support/memory_key_value_store.dart`.
  Shell mount: `test/device_notice_bands_shell_test.dart`. Devices screen mount and `deviceStatus`/`report`:
  `test/devices_screen_test.dart`, `test/devices_controller_test.dart`.
- **The gallery** (`test/elements_gallery_test.dart`): one section per `RepaintBoundary` keyed `elements/<id>`,
  one image per section and brightness, and a test that the images are exactly the sections'.
- **Swift.** Sources are listed by hand in `project.pbxproj` (`MoveToApplications.swift`: ids `…0D01`, `…0D02`,
  six mentions). Channels are set up in `MainFlutterWindow.awakeFromNib`. The deployment target is 12.0;
  `urlsForApplications(withBundleIdentifier:)` exists from 12.0. `RunnerTests` is hosted in `Harness.app`: running
  it starts the real Desktop, and no gate or doc runs it.
- **What pull request CI runs.** `desktop-tests`: the VM suite on Linux, six shards. It builds no macOS app and no
  web app. `scripts/local-checks.py` names `desktop-macos` (`make desktop-test` on a Mac) for `desktop/macos/*`.
- **This worktree has no `desktop/.dart_tool` and no build.** First:
  `flutter config --enable-swift-package-manager`, then `flutter pub get` in `desktop/`.

## File map

| Task | File | What |
|---|---|---|
| 1 | `desktop/lib/devices/device_app.dart` (new), `desktop/test/devices/device_app_test.dart` (new) | ids, the support rule, steps and lines, the probe's interface |
| 2 | `desktop/macos/Runner/HarnessDeviceApp.swift` (new), `desktop/macos/Runner/MainFlutterWindow.swift`, `desktop/macos/Runner.xcodeproj/project.pbxproj`, `desktop/test/macos_device_app_channel_test.dart` (new) | the Swift lookup: paths and running, no filter |
| 3 | `desktop/lib/devices/device_app_probe.dart` (new), `desktop/test/devices/device_app_probe_test.dart` (new) | the channel's Dart side, and the filter (on disk, no Trash, not `/Volumes/`) |
| 4 | `desktop/lib/update/update_signature.dart`, `desktop/test/update_signature_test.dart`, `desktop/test/update_signature_macos_test.dart` | the requirement by team and identifier; `verifyMacBundle` with real `codesign` |
| 5 | `desktop/lib/devices/device_app_manifest.dart` (new), `desktop/test/devices/device_app_manifest_test.dart` (new) | which entry, and whether it may be fetched |
| 6 | `desktop/lib/devices/device_app_installer.dart` (new), `desktop/test/devices/device_app_installer_test.dart` (new) | the seven steps |
| 7 | `desktop/lib/devices/device_app_offer.dart` (new), `desktop/test/devices/device_app_offer_test.dart` (new), `desktop/test/support/device_app.dart` (new) | the controller, and the fakes every later test uses |
| 8 | `desktop/lib/widgets/device_app_band.dart` (new), `desktop/test/devices/device_app_band_test.dart` (new) | the band |
| 9 | `desktop/lib/devices/device_app_row.dart` (new), `desktop/test/devices/device_app_row_test.dart` (new) | the row |
| 10 | `desktop/lib/devices/device_app_setup.dart` (new), `desktop/lib/state/app_state.dart`, `desktop/test/devices/device_app_setup_test.dart` (new) | the real parts put together; `AppNotifier` owns and feeds the offer |
| 11 | `desktop/lib/app_shell.dart`, `desktop/lib/devices/devices_screen.dart`, `desktop/test/devices/device_app_flow_test.dart` (new) | both surfaces mounted; the click-through |
| 12 | `desktop/design/desktop-design-system.md`, `desktop/test/elements_gallery_test.dart`, `desktop/test/goldens/elements/device-app-light.png` and `-dark.png` (new) | the doc and the gallery |
| 13 | `desktop/integration_test/device_app_install_native_test.dart` (new) | the end-to-end test on a Mac |

No two tasks share a file. Dependencies: 1, 2, 4, 5 on nothing; 3 and 7 on 1; 6 on 1 and 5; 8 and 9 on 7; 10 on 3,
4, 6 and 7; 11 on 8, 9 and 10; 12 on 8 and 9; 13 on 2, 3, 4 and 6. The longest chain is four tasks
(5 → 6 → 10 → 11).

## Mockups

The band, across the window (offer, installing, failed):

```text
 ↓  Your dial follows apps and terminal tabs with the Harness menu-bar app.       Not now  [ Install ]
 ↓  Your dial follows apps and terminal tabs with the Harness menu-bar app.       Not now  [ Installing… ]
 ⚠  Couldn’t download the app.                                                    Not now  [ Retry ]
```

While installing, both buttons are disabled. The row, at the top of the Devices tab's settings column:

```text
┌────────────────────────────────────────────────────────────┐   ┌───────────────────────────────────────────────┐
│ Menu-bar app                                   [ Install ] │   │ Menu-bar app                        [ Retry ] │
│ Follows the app and terminal tab in front.                 │   │ Follows the app and terminal tab in front.    │
└────────────────────────────────────────────────────────────┘   │ Couldn’t verify the download.                 │
                                                                 └───────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────┐   ┌───────────────────────────────────────────────┐
│ Menu-bar app                                      [ Open ] │   │ Menu-bar app                         [ Open ] │
│ Follows the app and terminal tab in front.                 │   │ Follows the app and terminal tab in front.    │
└────────────────────────────────────────────────────────────┘   │ Installed. Couldn’t open it.                  │
                                                                 └───────────────────────────────────────────────┘
```

Installing reads `[ Installing… ]`, disabled. Installed and running: no row.

## Review Focus

Most likely first. Each has its test in the task that owns the code.

1. **The network drops or stalls mid-download.** A person expects `Couldn’t download the app.`, nothing left in
   the temporary folder, and `Retry` to start clean. Task 6: "a download that stalls", "a connection that closes
   early", "a second install after a failure starts clean".
2. **LaunchServices has not registered the fresh install when the next lookup runs.** The offer must not come back
   over an app that was just installed. Task 7: "trusts its result at once".
3. **The dial is unplugged while installing.** The install finishes, the app opens, both surfaces go, nothing
   throws. Task 7: "the dial leaving during an install".
4. **A manifest of the wrong shape** (an HTML error page, a list, a size as text, a body with no end, a redirect).
   `Couldn’t download the app.`, and its `url` is never requested. Tasks 5 and 6.
5. **Large text and a long line in a small window.** At 200% text in an 880-point window the band keeps both
   buttons reachable and nothing overflows; the row stacks its button under its text. Tasks 8 and 9.

---

### Task 1: The app's facts

**Depends on:** nothing. **Effort:** medium.

**Files:**
- Create: `desktop/lib/devices/device_app.dart`
- Test: `desktop/test/devices/device_app_test.dart`

**The test that fails before the change:** every case in `test/devices/device_app_test.dart` (the library does not
exist).

**Interfaces:**
- Produces:

```dart
const deviceAppBundleId = 'ai.autonomous.harness.device';
const deviceAppBundleName = 'Harness Device.app';

/// What LaunchServices and AppKit say about the menu-bar app on this computer.
class DeviceAppPresence {
  const DeviceAppPresence({required this.installed, required this.running});
  final bool installed, running;
}

abstract interface class DeviceAppProbe {
  /// Throws when the lookup cannot be made.
  Future<DeviceAppPresence> lookup();
}

/// Opens the menu-bar app: the bundle at [path], or by bundle id when [path] is null. True when `open` exited 0.
typedef DeviceAppOpen = Future<bool> Function({String? path});

enum DeviceAppInstallStep { manifest, download, checksum, unpack, signature, install, open }

extension DeviceAppFailureLine on DeviceAppInstallStep {
  String get failureLine; // the four lines of Global Constraints
}

class DeviceAppInstallResult {
  const DeviceAppInstallResult.done(String this.installedAt) : failed = null;
  const DeviceAppInstallResult.failed(DeviceAppInstallStep this.failed, {this.installedAt});
  final DeviceAppInstallStep? failed; // null: installed and opened
  final String? installedAt;          // the bundle's path once it is in place, also when only `open` failed
}

/// macOS 13 or later, and not a viewer build. Defaults: [defaultTargetPlatform],
/// [RuntimePlatform.operatingSystemVersion], `kIsWeb || kViewerMode`.
bool deviceAppSupported({TargetPlatform? platform, String? osVersion, bool? viewer});
```

- [ ] **Step 1: Write the failing tests**

```dart
test('each step has its line', () {
  expect({for (final s in DeviceAppInstallStep.values) s.name: s.failureLine}, {
    'manifest': 'Couldn’t download the app.',
    'download': 'Couldn’t download the app.',
    'checksum': 'Couldn’t verify the download.',
    'unpack': 'Couldn’t verify the download.',
    'signature': 'Couldn’t verify the download.',
    'install': 'Couldn’t install the app.',
    'open': 'Installed. Couldn’t open it.',
  });
});

test('only macOS 13 or later, and never a viewer build', () {
  bool on(String version, {TargetPlatform platform = TargetPlatform.macOS, bool viewer = false}) =>
      deviceAppSupported(platform: platform, osVersion: version, viewer: viewer);
  expect(on('Version 13.0 (Build 22A380)'), isTrue);
  expect(on('Version 26.6.2 (Build 25G83)'), isTrue);
  expect(on('Version 12.7.6 (Build 21H1320)'), isFalse);
  expect(on(''), isFalse);
  expect(on('6.8.0-45-generic'), isFalse);
  expect(on('Version 15.6 (Build 24G84)', platform: TargetPlatform.linux), isFalse);
  expect(on('Version 15.6 (Build 24G84)', platform: TargetPlatform.windows), isFalse);
  expect(on('Version 15.6 (Build 24G84)', viewer: true), isFalse);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `flutter test --no-pub --concurrency=2 --timeout=60s test/devices/device_app_test.dart`
Expected: FAIL, `device_app.dart` not found.

- [ ] **Step 3: Commit the red tests** (`git add desktop/test/devices/device_app_test.dart`; message
  `Menu-bar app offer: the steps' lines and the macOS 13 rule (tests)`)

- [ ] **Step 4: Write `device_app.dart`** as the Interfaces block. The major version is the number after `Version `
  at the start of the string (`^Version (\d+)`); anything else is not supported.

- [ ] **Step 5: Run the tests and the analyzer**

Run: `flutter test --no-pub --concurrency=2 --timeout=60s test/devices/device_app_test.dart && flutter analyze lib/devices/device_app.dart test/devices/device_app_test.dart`
Expected: all pass; `No issues found!`

- [ ] **Step 6: Commit** (`git add desktop/lib/devices/device_app.dart`; message
  `Menu-bar app offer: its ids, steps and lines, and where it is offered`)

---

### Task 2: The lookup in Swift

**Depends on:** nothing. **Effort:** high. (Changed by decision 23: Swift returns the paths and filters nothing.)

**Files:**
- Create: `desktop/macos/Runner/HarnessDeviceApp.swift`
- Modify: `desktop/macos/Runner/MainFlutterWindow.swift:52` (one line after `AppDelegate.installCommunityLinks`)
- Modify: `desktop/macos/Runner.xcodeproj/project.pbxproj` (four entries, beside `MoveToApplications.swift`'s at
  `:29`, `:76`, `:191`, `:385`; ids `B20100000000000000000E01` for the build file, `B20100000000000000000E02` for
  the file)
- Test: `desktop/test/macos_device_app_channel_test.dart`

**The test that fails before the change:** `test/macos_device_app_channel_test.dart`, all three cases. It reads
the sources, so it runs in pull request CI: a Swift file left out of the project compiles nowhere, the channel
then answers nothing, and the offer never shows.

**Interfaces:**
- Produces: channel `harness/device_app`, method `lookup`, no arguments, reply
  `{"paths": [String], "running": Bool}`: `paths` is every URL `urlsForApplications` gives, as its file path, in
  its order, none left out (Task 3 filters them). Any other method: `FlutterMethodNotImplemented`.

```swift
enum HarnessDeviceApp {
  static let bundleIdentifier = "ai.autonomous.harness.device"
  /// Sets up `harness/device_app` and keeps the channel.
  static func install(messenger: FlutterBinaryMessenger)
}
```

- [ ] **Step 1: Write the failing test**

```dart
// Reads the macOS sources, as test/swarm_screen_test.dart reads SwarmTitlebar.swift. Substrings only: a Windows
// checkout has CRLF line ends.
void main() {
  final swift = File('macos/Runner/HarnessDeviceApp.swift');
  final project = File('macos/Runner.xcodeproj/project.pbxproj').readAsStringSync();
  final window = File('macos/Runner/MainFlutterWindow.swift').readAsStringSync();
  int count(String text, String part) => part.allMatches(text).length;

  test('the lookup is compiled into the macOS app and registered', () {
    expect(count(project, 'HarnessDeviceApp.swift'), count(project, 'MoveToApplications.swift'));
    expect(window, contains('HarnessDeviceApp.install(messenger:'));
    final source = swift.readAsStringSync();
    for (final part in [
      '"harness/device_app"', '"lookup"', '"ai.autonomous.harness.device"', '"paths"', '"running"',
      'urlsForApplications(withBundleIdentifier:', 'runningApplications(withBundleIdentifier:',
    ]) {
      expect(source, contains(part), reason: part);
    }
  });

  // The filter is Dart's (device_app_probe.dart), where pull request CI tests it: a second one here would
  // be a rule no gate runs.
  test('the lookup filters nothing', () {
    final source = swift.readAsStringSync();
    for (final part in ['/Volumes/', '.Trash', 'fileExists', '.filter']) {
      expect(source, isNot(contains(part)), reason: part);
    }
  });

  test('the lookup starts no process and opens nothing', () {
    final source = swift.readAsStringSync();
    for (final part in ['Process(', 'NSTask', '.open(', 'openApplication', 'launchApplication']) {
      expect(source, isNot(contains(part)), reason: part);
    }
  });
}
```

- [ ] **Step 2: Run it and see it fail**

Run: `flutter test --no-pub --concurrency=2 --timeout=60s test/macos_device_app_channel_test.dart`
Expected: FAIL (the file does not exist; the project names it 0 times, not 6).

- [ ] **Step 3: Commit the red test** (message `Menu-bar app offer: the macOS lookup is compiled in and registered (test)`)

- [ ] **Step 4: Write `HarnessDeviceApp.swift`.** `lookup` answers on the main thread with
  `"paths": NSWorkspace.shared.urlsForApplications(withBundleIdentifier: bundleIdentifier).map(\.path)` and
  `"running": !NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier).isEmpty`. The
  header comment says why it filters nothing: LaunchServices also lists copies in the Trash and on mounted disk
  images, and Dart decides which count, where a test that pull request CI runs checks it.

- [ ] **Step 5: Add the file to the project and register it.** In `project.pbxproj`, one line next to each of
  `MoveToApplications.swift`'s four, same shape, with the two new ids. In `MainFlutterWindow.swift`, after line 52:
  `HarnessDeviceApp.install(messenger: flutterViewController.engine.binaryMessenger)`.

- [ ] **Step 6: Run the test, then compile the app**

Run: `flutter test --no-pub --concurrency=2 --timeout=60s test/macos_device_app_channel_test.dart`
Expected: PASS.
Run: `bash scripts/build-macos-debug.sh --no-pub`
Expected: ends `Local review build ready (Impeller): …/Harness.app` (Skia on Intel). A Swift error fails here.
Run: `git status --short desktop/macos`
Expected: only the three files of this task (a build with Swift Package Manager off rewrites tracked files:
revert those).

- [ ] **Step 7: Commit** (the three macOS files; message
  `Menu-bar app offer: Desktop asks macOS where Harness Device is and whether it runs`)

---

### Task 3: The channel's Dart side, and which copy counts as installed

**Depends on:** Task 1. **Effort:** high. (Changed by decision 23: the filter moved here from Swift, so the effort
rose from medium.)

**Files:**
- Create: `desktop/lib/devices/device_app_probe.dart`
- Test: `desktop/test/devices/device_app_probe_test.dart`

**The test that fails before the change:** every case in `test/devices/device_app_probe_test.dart`. It runs on
every host, so pull request CI tests the filter.

**Interfaces:**
- Consumes: `DeviceAppProbe`, `DeviceAppPresence` (Task 1); the channel's reply as Task 2 states it.
- Produces:

```dart
/// Whether any of [paths] is an installed copy: it exists on disk, it is in no Trash (no path component is
/// `.Trash` or `.Trashes`), and it is not under `/Volumes/` (a mounted disk image or another disk).
/// [exists] defaults to `FileSystemEntity.type(path) != FileSystemEntityType.notFound`.
Future<bool> deviceAppInstalledAt(List<String> paths, {Future<bool> Function(String path)? exists});

class ChannelDeviceAppProbe implements DeviceAppProbe {
  const ChannelDeviceAppProbe({
    MethodChannel channel = const MethodChannel('harness/device_app'),
    Future<bool> Function(String path)? exists, // passed to deviceAppInstalledAt
  });
  /// Throws a [FormatException] on a reply that is not `{paths: a list of strings, running: a bool}`, and
  /// whatever the channel throws.
  @override
  Future<DeviceAppPresence> lookup();
}
```

- [ ] **Step 1: Write the failing tests.** The filter, with an `exists` that answers true for a set of paths the
  test names:
  - `'a copy in Applications counts'`: `['/Applications/Harness Device.app']` → true; the same under
    `/Users/a/Applications/` → true.
  - `'a copy in a Trash does not count'`: `/Users/a/.Trash/Harness Device.app` and
    `/Volumes/X/.Trashes/501/Harness Device.app`, both existing → false.
  - `'a copy under /Volumes/ does not count'`: `/Volumes/Harness Device/Harness Device.app`, existing → false.
  - `'a path that is gone does not count'`: `/Applications/Harness Device.app`, not existing → false.
  - `'one good copy among others is enough'`: the Trash copy, the `/Volumes/` copy, then the Applications one →
    true; `[]` → false.
  - `'a folder that only looks like a Trash counts'`: `/Users/a/Apps.Trash/Harness Device.app` and
    `/Users/a/VolumesX/Harness Device.app`, existing → true (whole components and the `/Volumes/` prefix only).
  - `'the real check reads the disk'`: with the default `exists`, a `Harness Device.app` directory made in a
    temporary folder → true; after deleting it → false.

  The channel, with
  `TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler` on
  `MethodChannel('harness/device_app')`, cleared in `tearDown`, and the probe built with the test's `exists`:
  - `'asks lookup, with no argument, and filters the paths'`: the handler records the call and returns
    `{'paths': ['/Users/a/.Trash/Harness Device.app', '/Applications/Harness Device.app'], 'running': false}`,
    both existing; expect one call, method `lookup`, `arguments` null, and a presence with `installed` true and
    `running` false. With only the Trash path: `installed` false.
  - `'running is read as it comes'`: `{'paths': [], 'running': true}` → `installed` false, `running` true.
  - `'a reply of the wrong shape is refused'`: for `{'paths': []}`, `{'running': false}`,
    `{'paths': '/Applications/Harness Device.app', 'running': false}`, `{'paths': [7], 'running': false}`,
    `{'paths': [], 'running': 0}`, `{'installed': true, 'running': false}`, `'yes'` and `null`, `lookup()` throws
    a `FormatException`.
  - `'a Mac whose app has no such channel throws'`: no handler set; `lookup()` throws a `MissingPluginException`.

- [ ] **Step 2: Run them and see them fail**

Run: `flutter test --no-pub --concurrency=2 --timeout=60s test/devices/device_app_probe_test.dart`
Expected: FAIL, `device_app_probe.dart` not found.

- [ ] **Step 3: Commit the red tests** (message `Menu-bar app offer: the lookup's Dart side and its filter (tests)`)

- [ ] **Step 4: Write `deviceAppInstalledAt` and `ChannelDeviceAppProbe`** with `invokeMethod<Object?>('lookup')`,
  read with `is`, never `as`. Components by `package:path`'s `posix.split`. The filter's comment says why it
  exists (LaunchServices also lists copies in the Trash and on mounted disk images, which are not installs) and
  why it is in Dart (a test pull request CI runs).

- [ ] **Step 5: Run the tests and the analyzer**

Run: `flutter test --no-pub --concurrency=2 --timeout=60s test/devices/device_app_probe_test.dart && flutter analyze lib/devices/device_app_probe.dart test/devices/device_app_probe_test.dart`
Expected: all pass; `No issues found!`

- [ ] **Step 6: Commit** (message
  `Menu-bar app offer: the lookup's Dart side; a copy in a Trash or on a mounted disk is not installed`)

---

### Task 4: The code requirement by team and identifier

**Depends on:** nothing. **Effort:** xhigh (the updater's signature check). (Decision 24 adds the three
real-`codesign` cases and their file.)

**Files:**
- Modify: `desktop/lib/update/update_signature.dart:98-108` (`macUpdateRequirement`), `:260-292`
  (`verifyMacUpdate`)
- Test: `desktop/test/update_signature_test.dart:104-125`
- Test: `desktop/test/update_signature_macos_test.dart` (three cases after the existing ones; its helpers stay)

**The test that fails before the change:** in `test/update_signature_test.dart`, "the updater's requirement is
unchanged" and "Harness Device's requirement carries the team, its identifier and notarization"; in
`test/update_signature_macos_test.dart`, the three `verifyMacBundle` cases (neither file compiles: the new
signature and `verifyMacBundle` do not exist yet). On Linux the macOS file's cases are skipped once it compiles.

**Interfaces:**
- Produces:

```dart
String macUpdateRequirement({required String team, required String identifier});

/// The signer of [bundle], or null when it is ad hoc or unsigned. Throws [cannotCheckSignature] when codesign
/// cannot say.
Future<MacSigner?> readMacSigner(String bundle, {Duration timeout = signatureCheckTimeout});

/// Whether [bundle] meets [macUpdateRequirement] for [team] and [identifier]. Throws [cannotCheckSignature] when
/// codesign cannot start or runs out of time.
Future<bool> verifyMacBundle({
  required String bundle,
  required String team,
  required String identifier,
  Duration timeout = signatureCheckTimeout,
});
```

  `verifyMacUpdate` keeps its signature, its messages and its two log lines. It is built from the two: no signer,
  return; `verifyMacBundle` false, throw `notFromPublisher(signer.name)`. One place runs `codesign --verify`.

- [ ] **Step 1: Write the failing tests.** Replace the existing requirement case with:

```dart
test("the updater's requirement is unchanged", () {
  final signer = parseMacSigner(_released)!;
  expect(
    macUpdateRequirement(team: signer.team, identifier: signer.identifier),
    'anchor apple generic'
    ' and certificate 1[field.1.2.840.113635.100.6.2.6]'
    ' and certificate leaf[field.1.2.840.113635.100.6.1.13]'
    ' and certificate leaf[subject.OU] = "54DJVWMJCC"'
    ' and identifier "ai.autonomous.harness"'
    ' and notarized',
  );
});

test("Harness Device's requirement carries the team, its identifier and notarization", () {
  final requirement = macUpdateRequirement(team: '54DJVWMJCC', identifier: 'ai.autonomous.harness.device');
  expect(requirement, contains('certificate leaf[subject.OU] = "54DJVWMJCC"'));
  expect(requirement, contains('identifier "ai.autonomous.harness.device"'));
  expect(requirement, isNot(contains('identifier "ai.autonomous.harness" ')));
  expect(requirement, endsWith(' and notarized'));
});
```

  And in `test/update_signature_macos_test.dart`, with its own helpers (`_adHocBundle`, `_clone`, `_signedRelease`)
  and skips (`_macOnly`, `noSigned`); real `codesign` on temporary bundles, the release only read or cloned:
  - `'verifyMacBundle refuses an ad-hoc bundle'` (skip `_macOnly`): `_adHocBundle(scratch.path,
    'Harness Device.app')` with `team: '54DJVWMJCC', identifier: 'ai.autonomous.harness.device'` → false.
  - `'verifyMacBundle accepts a notarized bundle of that team and identifier'` (skip `noSigned`): a `_clone` of
    the signed release with `team: '54DJVWMJCC', identifier: 'ai.autonomous.harness'` → true.
  - `'verifyMacBundle refuses a notarized bundle with another identifier'` (skip `noSigned`): the same clone with
    `identifier: 'ai.autonomous.harness.device'` → false (Harness Desktop is not Harness Device).

- [ ] **Step 2: Run them and see them fail**

Run: `flutter test --no-pub --concurrency=2 --timeout=60s test/update_signature_test.dart test/update_signature_macos_test.dart`
Expected: FAIL to compile (`macUpdateRequirement` takes a `MacSigner`; `verifyMacBundle` is not defined).

- [ ] **Step 3: Commit the red tests** (both test files; message
  `Updater: the code requirement by team and identifier (tests)`)

- [ ] **Step 4: Change `update_signature.dart`** as the Interfaces block. `readMacSigner` is the first half of
  today's `verifyMacUpdate` (`codesign -dv --verbose=2`, then `parseMacSigner`); `verifyMacBundle` the second
  (`--verify --deep --strict -R=…`, exit 0 is true, the `refused:` log line stays). Both go through `_run`.

- [ ] **Step 5: Run the tests, and the existing real-`codesign` cases on this Mac**

Run: `flutter test --no-pub --concurrency=2 --timeout=60s test/update_signature_test.dart test/update_signature_macos_test.dart test/desktop_updater_test.dart test/update_progress_test.dart && flutter analyze lib/update test/update_signature_test.dart test/update_signature_macos_test.dart`
Expected: all pass, the three new cases among them (on a Mac the macOS file's cases run; its signed cases use
`/Applications/Harness.app`, which this Mac has, and are skipped where it is missing); `No issues found!`

- [ ] **Step 6: Commit** (message
  `Updater: the signature check takes a team and an identifier, so Harness Device can be checked by it`)

---

### Task 5: The manifest's rules

**Depends on:** nothing. **Effort:** xhigh (what may be fetched).

**Files:**
- Create: `desktop/lib/devices/device_app_manifest.dart`
- Test: `desktop/test/devices/device_app_manifest_test.dart`

**The test that fails before the change:** every case in `test/devices/device_app_manifest_test.dart`.

**Interfaces:**
- Produces:

```dart
const deviceAppManifestUrl =
    'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/metadata.json';
const deviceAppUrlPrefixes = [
  'https://cdn.autonomous.ai/harness/device/',
  'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/',
];
const deviceAppMaxBytes = 200 * 1024 * 1024;
const deviceAppManifestMaxBytes = 64 * 1024;

class DeviceAppRelease {
  const DeviceAppRelease({required this.url, required this.sha256, required this.size});
  final String url;
  final String sha256; // lowercase
  final int size;
}

/// The entry this computer installs, or null when the manifest names none it may fetch.
/// [architecture] is `arm64` or `x64`.
DeviceAppRelease? parseDeviceAppManifest(Object? manifest, {required String architecture});
```

  Rules. Keys: `arm64` reads `device-macos-arm64`, then `device-macos`; anything else reads `device-macos`. The
  first key whose entry passes every check wins. `url`: a string that starts with one of the prefixes, equals its
  own normal form (`Uri.parse(url).normalizePath().toString() == url`), and has no query, fragment, user info,
  port or backslash. `sha256`: a string of 64 hex digits, kept lowercase. `size`: an `int` from 1 to
  `deviceAppMaxBytes`.

- [ ] **Step 1: Write the failing tests.** A helper `entry({url, sha256, size})` with good defaults
  (`https://cdn.autonomous.ai/harness/device/0.1.4/Harness-Device.app.tar.gz`, `'a' * 64`, `12424649`). Cases:
  - `'Apple Silicon takes the arm64 entry, then the other'`: both present with different URLs → the arm64 URL;
    arm64 missing → `device-macos`; arm64 malformed (size `'12'`) → `device-macos`.
  - `'Intel never takes the arm64 entry'`: only `device-macos-arm64` present, `architecture: 'x64'` → null.
  - `'the live manifest's shape: the archive, never the dmg'`: a map with `version`, `notes`, `pub_date`,
    `platforms`, the two archive keys and the two `-dmg` keys → the `.app.tar.gz` URL.
  - `'both prefixes are allowed'`: one URL under each → not null.
  - `'a URL outside the prefixes is refused'`: each of these → null:
    `http://cdn.autonomous.ai/harness/device/a.tar.gz`, `https://cdn.autonomous.ai/harness/desktop/a.zip`,
    `https://cdn.autonomous.ai.evil.example/harness/device/a.tar.gz`,
    `https://cdn.autonomous.ai@evil.example/harness/device/a.tar.gz`,
    `https://cdn.autonomous.ai/harness/device/../desktop/a.zip`,
    `https://cdn.autonomous.ai/harness/device/%2e%2e/desktop/a.zip`,
    `https://cdn.autonomous.ai/harness/device/a.tar.gz?x=1`,
    `https://cdn.autonomous.ai/harness/device/a.tar.gz#x`,
    `https://cdn.autonomous.ai:8443/harness/device/a.tar.gz`, `''`, and `7` (not a string).
  - `'a sha256 that is not 64 hex digits is refused'`: 63 digits, 65 digits, `'g' * 64`, `null`; and
    `'A' * 64` is accepted and comes back as `'a' * 64`.
  - `'a size outside 1 byte to 200 MB is refused'`: `0`, `-1`, `deviceAppMaxBytes + 1`, `12424649.0`,
    `'12424649'`, `null` → null; `1` and `deviceAppMaxBytes` → not null.
  - `'a manifest that is not an object is refused'`: `null`, `[]`, `'<html>'`, `{'device-macos': 'x'}` → null.

- [ ] **Step 2: Run them and see them fail**

Run: `flutter test --no-pub --concurrency=2 --timeout=60s test/devices/device_app_manifest_test.dart`
Expected: FAIL, `device_app_manifest.dart` not found.

- [ ] **Step 3: Commit the red tests** (message `Menu-bar app offer: which manifest entry may be fetched (tests)`)

- [ ] **Step 4: Write `device_app_manifest.dart`** as the Interfaces block and the rules. Read with `is`, never
  `as`. The header comment says the manifest is read from the bucket, never the CDN, and why the URL is still
  checked (a manifest someone else wrote).

- [ ] **Step 5: Run the tests and the analyzer**

Run: `flutter test --no-pub --concurrency=2 --timeout=60s test/devices/device_app_manifest_test.dart && flutter analyze lib/devices/device_app_manifest.dart test/devices/device_app_manifest_test.dart`
Expected: all pass; `No issues found!`

- [ ] **Step 6: Commit** (message `Menu-bar app offer: which manifest entry this Mac installs, and whether it may be fetched`)

---

### Task 6: The installer

**Depends on:** Tasks 1 and 5. **Effort:** xhigh (a download that ends in an installed, opened app).

**Files:**
- Create: `desktop/lib/devices/device_app_installer.dart`
- Test: `desktop/test/devices/device_app_installer_test.dart`

**The test that fails before the change:** every case in `test/devices/device_app_installer_test.dart`.

**Interfaces:**
- Consumes: `DeviceAppInstallStep`, `DeviceAppInstallResult`, `DeviceAppOpen`, `deviceAppBundleId`,
  `deviceAppBundleName` (Task 1); `parseDeviceAppManifest`, `DeviceAppRelease`, `deviceAppManifestMaxBytes`
  (Task 5).
- Produces:

```dart
typedef DeviceAppRun = Future<ProcessResult> Function(String executable, List<String> arguments);
typedef DeviceAppSignatureCheck = Future<bool> Function(String bundle);

/// tar, ditto and open through [startHidden]; a tool still running after [timeout] is killed and throws.
Future<ProcessResult> runDeviceAppTool(
  String executable,
  List<String> arguments, {
  Duration timeout = const Duration(seconds: 60),
});

/// `/usr/bin/open <path>`, or `/usr/bin/open -b ai.autonomous.harness.device` when [path] is null.
Future<bool> openDeviceApp(DeviceAppRun run, {String? path});

/// `/Applications`, then `<home>/Applications` ([homeDir]; left out when nothing names a home).
List<String> deviceAppTargetFolders();

class DeviceAppInstaller {
  DeviceAppInstaller({
    required String manifestUrl,
    required List<String> targetFolders,
    required DeviceAppSignatureCheck verifySignature,
    required DeviceAppOpen open,
    Dio? dio,                          // default: the updater's shape, connect 10 s, receive 30 s
    DeviceAppRun run = runDeviceAppTool,
    String? architecture,              // default: runtimeArchitecture
    Directory? tempRoot,               // default: Directory.systemTemp
    Duration manifestTimeout = const Duration(seconds: 15),
    Duration downloadTimeout = const Duration(minutes: 5),
  });

  /// Never throws: every failure is a step. Removes its temporary directory whatever happened.
  Future<DeviceAppInstallResult> install();
}
```

  The steps, in order. A failure returns `DeviceAppInstallResult.failed(<that step>)`.
  1. **manifest.** `GET manifestUrl` as a stream, `followRedirects: false`, within `manifestTimeout`. Status 200.
     Reading stops, and fails, past `deviceAppManifestMaxBytes`. UTF-8 JSON, `parseDeviceAppManifest` not null.
  2. **download.** A new directory `harness-device-app-…` under `tempRoot` (`createTemp`). `GET release.url` as a
     stream, `followRedirects: false`, into `<temp>/Harness-Device.app.tar.gz` (a fixed name), within
     `downloadTimeout`. Status 200. Stops, and fails, on the first byte past `release.size`.
  3. **checksum.** The file's length is `release.size` and its sha256 is `release.sha256`. The hash reads the file
     in chunks inside `Isolate.run`, over the path (`const DartSha256().newHashSink()`).
  4. **unpack.** `run('/usr/bin/tar', ['-xzf', <archive>, '-C', <temp>/app])`, exit 0. `<temp>/app` then holds
     exactly one entry (`listSync(followLinks: false)`), named `Harness Device.app`, whose type without following
     links is a directory.
  5. **signature.** `verifySignature(<temp>/app/Harness Device.app)` is true. False or a throw fails the step.
  6. **install.** For each target folder in order: if `<folder>/Harness Device.app` exists (any type), stop, it is
     installed there, nothing written. Else create the folder when it is not the first and is missing, and
     `run('/usr/bin/ditto', [<bundle>, <folder>/.Harness Device.app.<16 random hex>.partial])`. Non-zero with no
     partial on disk, or the folder could not be created or written (`FileSystemException`): next folder. Non-zero
     with a partial on disk: remove it and fail. Exit 0: rename the partial to `Harness Device.app`. A rename
     that fails removes the partial; if the target exists now (another window won), it is installed there, else
     fail. No folder left: fail.
  7. **open.** `open(path: <installed bundle>)` is true, else
     `DeviceAppInstallResult.failed(DeviceAppInstallStep.open, installedAt: <path>)`.

- [ ] **Step 1: Write the failing tests.** One file. A fixture per test: a loopback `HttpServer` on
  `InternetAddress.loopbackIPv4`, port 0, with a handler the test sets; a manifest served at `/metadata.json`
  that names `https://cdn.autonomous.ai/harness/device/0.0.0/Harness-Device.app.tar.gz`; a `Dio` whose
  interceptor rewrites `https://cdn.autonomous.ai` to the server's address; the archive built in Dart with
  `package:archive` (`TarEncoder`, `GZipEncoder`) from a made-up `Harness Device.app/Contents/Info.plist` and
  `Contents/MacOS/harness-device`; four temporary directories (first target, second target's parent, `tempRoot`,
  scratch), deleted in `tearDown` after `chmod 755`; a recording signature check (returns a value the test sets);
  a recording opener; a runner that records every call and then calls `runDeviceAppTool`. A helper
  `expectNothingInstalled()` asserts both targets hold no `Harness Device.app` and no `.partial`, `tempRoot` is
  empty, and the opener was not called.

  On every host:
  - `'a manifest that cannot be read fails at manifest and fetches nothing else'`: for status 500, a body
    `<html>`, a body `[]`, a body with no end, and a 302 to another path → `failed == manifest`; the server saw no
    request for the archive; `expectNothingInstalled()`.
  - `'a manifest whose entry may not be fetched fails at manifest'`: a URL under `/harness/desktop/`.
  - `'Intel asks for device-macos, Apple Silicon for device-macos-arm64'`: two entries with different file names;
    the path the server saw differs by `architecture`.
  - `'a download that is refused fails at download'`: the archive answers 404.
  - `'a connection that closes early fails at download'`: `Content-Length` of the full size, half the bytes, then
    the socket is destroyed.
  - `'a download that stalls fails at download'`: the server sends the headers and never the body;
    `downloadTimeout: const Duration(milliseconds: 200)`.
  - `'a body longer than the manifest says stops at download'`: the server writes chunks until the client goes
    away, with no end; the install returns `failed == download` (it could not return otherwise).
  - `'a shorter file fails at checksum'` and `'a file with another sha256 fails at checksum'` (one byte changed,
    same length).
  - `'a redirect on the archive is not followed'`: a 302 to a path that would serve it → `failed == download`.
  - `'a second install after a failure starts clean'`: the first run meets a 404 (`failed == download`), the
    second a file with another sha256 (`failed == checksum`); `tempRoot` is empty after each, and the server saw
    the manifest asked for twice.
  - `'open goes by path, or by bundle id'`: `openDeviceApp(recorder, path: '/x/Harness Device.app')` ran
    `/usr/bin/open` with `['/x/Harness Device.app']`; `openDeviceApp(recorder)` with
    `['-b', 'ai.autonomous.harness.device']`; a non-zero exit is false.

  Only on macOS (`skip: Platform.isMacOS ? null : 'needs /usr/bin/ditto (macOS)'`):
  - `'installs into the first folder, opens it, and leaves nothing behind'`: result `failed == null`,
    `installedAt == <first>/Harness Device.app`; the two files are there; the opener got that path; `tempRoot` is
    empty; the runner's calls are exactly `/usr/bin/tar` with `['-xzf', <…/Harness-Device.app.tar.gz>, '-C',
    <…/app>]` and `/usr/bin/ditto` with two paths, the second matching
    `/\.Harness Device\.app\.[0-9a-f]{16}\.partial$`; the signature check got `<…/app/Harness Device.app>`.
  - `'a folder it cannot write falls back to the next, created if missing'`: first target `chmod 555`; the second
    does not exist yet → installed there.
  - `'neither folder writable fails at install'`.
  - `'an existing copy is installed: nothing is written and it is opened'`: a `Harness Device.app` directory with
    a marker file in the first target → `failed == null`, the marker unchanged, `ditto` never ran, the opener got
    that path. The same with the copy in the second target and the first read-only.
  - `'an archive that is not one bundle fails at unpack'`: two top-level entries; a top-level symlink named
    `Harness Device.app` (`ArchiveFile.symlink`); a file of that name; a directory named `Other.app`; bytes that
    are not gzip. Each: `failed == unpack`, `expectNothingInstalled()`.
  - `'a bundle the signature check refuses fails at signature'`: the check returns false; and the check throws.
  - `'another window finishing first counts as installed'`: the runner, after `ditto` returns, creates
    `<first>/Harness Device.app/marker` → `failed == null`, the marker is still there, no `.partial` remains.
  - `'a partial that cannot be renamed fails at install'`: the runner, after `ditto` returns, deletes the partial
    → `failed == install`, no `Harness Device.app`.
  - `'a copy that stops part way is removed'`: the runner runs `ditto`, then returns exit 1 → `failed == install`,
    no `.partial` in either folder, the second folder untouched.
  - `'an app that will not open is still installed'`: the opener returns false → `failed == open`,
    `installedAt` set, the bundle in place.

- [ ] **Step 2: Run them and see them fail**

Run: `flutter test --no-pub --concurrency=2 --timeout=60s test/devices/device_app_installer_test.dart`
Expected: FAIL, `device_app_installer.dart` not found.

- [ ] **Step 3: Commit the red tests** (message `Menu-bar app offer: the seven steps of the install (tests)`)

- [ ] **Step 4: Write `device_app_installer.dart`** as the Interfaces block and the seven steps. One `try` around
  the steps, the temporary directory removed in `finally`. Comments say why at: reading the bucket, not following
  redirects, the fixed archive name, the partial in the same folder (so the rename is atomic), and never
  overwriting.

- [ ] **Step 5: Run the tests and the analyzer**

Run: `flutter test --no-pub --concurrency=2 --timeout=60s test/devices/device_app_installer_test.dart && flutter analyze lib/devices/device_app_installer.dart test/devices/device_app_installer_test.dart`
Expected: all pass on a Mac (the macOS cases run); `No issues found!`
Run: `ls /Applications ~/Applications 2>/dev/null | grep -c partial`
Expected: `0`.

- [ ] **Step 6: Commit** (message
  `Menu-bar app offer: download, verify, install and open Harness Device, into Applications or the home's`)

---

### Task 7: The controller

**Depends on:** Task 1. **Effort:** xhigh (a second press, a late lookup, a dial that leaves mid-install).

**Files:**
- Create: `desktop/lib/devices/device_app_offer.dart`
- Create: `desktop/test/support/device_app.dart`
- Test: `desktop/test/devices/device_app_offer_test.dart`

**The test that fails before the change:** every case in `test/devices/device_app_offer_test.dart`.

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces:

```dart
enum DeviceAppOfferState { hidden, offer, installing, failed, notRunning }

class DeviceAppOffer extends ChangeNotifier {
  DeviceAppOffer({
    required bool supported,        // deviceAppSupported(), read once
    required DeviceAppProbe probe,
    required Future<DeviceAppInstallResult> Function() install,
    required DeviceAppOpen open,
    LocalKeyValueStore? store,      // null: nothing is kept (tests)
    void Function(String line)? log,
  });

  static const dismissedKey = 'device_app.offer_dismissed';

  DeviceAppOfferState get state;
  DeviceAppInstallStep? get failedStep; // set while state is failed
  bool get bandVisible;                 // the stored answer was read, Not now was never pressed,
                                        // and state is offer, installing or failed
  Future<void> get restored;            // completes once the stored answer was read

  void dialChanged(bool attached);      // AppNotifier, on every dial status
  void windowFronted();                 // AppNotifier, when the window comes back to the front
  Future<void> refresh();               // the Devices tab's tick
  Future<void> install();               // joins a running install
  Future<void> open();                  // the path this run installed, else the bundle id
  Future<void> dismiss();               // Not now
}
```

  And in `test/support/device_app.dart`, for Tasks 8 to 12:

```dart
const notInstalled = DeviceAppPresence(installed: false, running: false);
const installedNotRunning = DeviceAppPresence(installed: true, running: false);
const installedRunning = DeviceAppPresence(installed: true, running: true);

class FakeDeviceAppProbe implements DeviceAppProbe {
  DeviceAppPresence presence = notInstalled;
  Object? error;         // thrown by lookup when set
  Completer<void>? gate; // lookup waits for it when set
  int lookups = 0;
}

class FakeDeviceAppInstall {
  DeviceAppInstallResult result = const DeviceAppInstallResult.done('/t/Harness Device.app');
  Object? error;
  Completer<void>? gate; // call() waits for it when set
  int calls = 0;
  Future<DeviceAppInstallResult> call();
}

class FakeDeviceAppOpen {
  bool ok = true;
  final paths = <String?>[]; // one per call; null is the bundle id form
  Future<bool> call({String? path});
}

/// An offer over the three fakes and an in-memory store.
class DeviceAppFixture {
  DeviceAppFixture({bool supported = true, MemoryKeyValueStore? store});
  final probe = FakeDeviceAppProbe();
  final install = FakeDeviceAppInstall();
  final open = FakeDeviceAppOpen();
  final lines = <String>[];
  late final MemoryKeyValueStore store;
  late final DeviceAppOffer offer;

  /// The offer brought to [state] with a dial attached; `failed` at [step] (default download). Failed at `open`
  /// carries `installedAt: '/t/Harness Device.app'`. `installing` never ends: dispose the offer.
  static Future<DeviceAppFixture> inState(DeviceAppOfferState state, {DeviceAppInstallStep? step});
}
```

  The rules.
  - **State**, in this order: not supported or no dial → `hidden`; an install running → `installing`;
    `failedStep` set → `failed`; no answer yet → `hidden`; not installed → `offer`; installed and not running →
    `notRunning`; else `hidden`.
  - **Lookups.** `dialChanged(true)` looks only when the dial was not attached before. `windowFronted()` and
    `refresh()` look only while a dial is attached. A lookup asked while one runs joins it. Not supported: never.
    A lookup that throws keeps the last answer and logs `device app: lookup failed`. An answer from a lookup asked
    before an install or an open ended is dropped: it describes the computer before them. An answer that arrives
    while an install runs changes nothing, because the install's result replaces it.
  - **An answer.** "Installed" clears `failedStep`. "Not installed" keeps it.
  - **Install.** Logs `device app: install started`. Done: the answer becomes installed and running at once, logs
    `device app: install done`, then one lookup. Failed at `open`: the answer becomes installed and not running,
    `failedStep` is `open`. Failed elsewhere: `failedStep` is the step. Each failure logs
    `device app: install failed <step.name>`. A throw counts as failed at `install`. After a result with
    `installedAt`, an answer of "not installed" is ignored until one says "installed".
  - **Open.** `open(path: <installedAt of this run, or null>)`. True: the answer becomes running, `failedStep`
    cleared. False: `failedStep` is `open`, logs `device app: open failed`.
  - **Not now.** Dismissed at once, then `store.write(dismissedKey, 'true')`. A read or write that throws is a
    first run: not dismissed on read, dismissed for this run on write.
  - Nothing notifies after `dispose()`.

- [ ] **Step 1: Write the support file and the failing tests.** Cases, each on a `DeviceAppFixture`:
  - `'a dial and no app: the offer'`: `dialChanged(true)`, `await restored` → `state == offer`,
    `bandVisible`, `probe.lookups == 1`.
  - `'each missing condition hides it'`: `supported: false` → `hidden`, and `lookups == 0` after
    `dialChanged(true)`, `windowFronted()` and `refresh()`; no dial → `hidden`, `lookups == 0` after
    `windowFronted()` and `refresh()`; `installedRunning` → `hidden`; `installedNotRunning` → `notRunning` and
    `bandVisible` false.
  - `'the dial coming looks once; later status frames do not'`: `dialChanged(true)` three times → 1.
  - `'the window coming back and the Devices tick look again'`: → 2, then 3; after `dialChanged(false)` both
    leave it at 3 and `state == hidden`.
  - `'two lookups asked at once are one'`: `probe.gate` set, `refresh()` twice → 1.
  - `'a lookup that fails keeps the last answer and says so'`: `probe.error` set, `refresh()` → state unchanged,
    `lines` contains `device app: lookup failed`.
  - `'Install runs it, says so, and trusts its result at once'`: `install.gate` set; `install()` →
    `state == installing`; complete the gate → `hidden`; `lines` is
    `['device app: install started', 'device app: install done']`; the probe still says `notInstalled`,
    `refresh()` → still `hidden`; it says `installedNotRunning`, `refresh()` → `notRunning`; it says
    `notInstalled` again, `refresh()` → `offer`.
  - `'a second press joins the running install'`: `install()` twice with the gate set → `install.calls == 1`;
    both futures complete.
  - `'a failure names its step and keeps Retry until the app is there'`: result `failed(checksum)` →
    `state == failed`, `failedStep == checksum`, last line `device app: install failed checksum`; `refresh()` with
    `notInstalled` → still `failed`; `install()` → `install.calls == 2`; `refresh()` with `installedRunning` →
    `hidden`, `failedStep` null.
  - `'installed but not opened: Retry only opens it'`: result
    `failed(open, installedAt: '/t/Harness Device.app')` → `failed`, `failedStep == open`, `bandVisible`;
    `open()` → `open.paths == ['/t/Harness Device.app']`, `install.calls == 1`, `state == hidden`.
  - `'Open from the row goes by bundle id; a refusal shows the line'`: `installedNotRunning`; `open.ok = false`;
    `open()` → `open.paths == [null]`, `state == failed`, `failedStep == open`, last line
    `device app: open failed`.
  - `'the dial leaving during an install'`: gate set, `install()`, `dialChanged(false)` → `hidden`; complete the
    gate → still `hidden`, `lines` ends `device app: install done`, no error.
  - `'an install that throws is a failed install step'`: `install.error` set → `failedStep == install`.
  - `'Not now hides the band for good and keeps the row'`: `dismiss()` → `bandVisible` false, `state == offer`,
    `store.values['device_app.offer_dismissed'] == 'true'`; a second fixture over the same store, with a dial,
    after `restored` → `state == offer`, `bandVisible` false.
  - `'the band waits for the stored answer'`: a store whose `read` waits on a completer → `bandVisible` false
    with `state == offer`; complete it → true.
  - `'a store that cannot be read or written is a first run'`.
  - `'the lines carry only step names'`: run every step's failure, a lookup failure and an open failure; every
    line matches
    `^device app: (install started|install done|install failed (manifest|download|checksum|unpack|signature|install|open)|lookup failed|open failed)$`.
  - `'after dispose nothing notifies'`: gate set, `install()`, `dispose()`, complete the gate → no error.

- [ ] **Step 2: Run them and see them fail**

Run: `flutter test --no-pub --concurrency=2 --timeout=60s test/devices/device_app_offer_test.dart`
Expected: FAIL, `device_app_offer.dart` not found.

- [ ] **Step 3: Commit the red tests** (the test and the support file; message
  `Menu-bar app offer: when it shows, one install at a time, Not now (tests)`)

- [ ] **Step 4: Write `device_app_offer.dart`** as the Interfaces block and the rules. No timer. The stored
  answer is read from the constructor.

- [ ] **Step 5: Run the tests and the analyzer**

Run: `flutter test --no-pub --concurrency=2 --timeout=60s test/devices/device_app_offer_test.dart && flutter analyze lib/devices/device_app_offer.dart test/devices/device_app_offer_test.dart test/support/device_app.dart`
Expected: all pass; `No issues found!`

- [ ] **Step 6: Commit** (message `Menu-bar app offer: one controller for the band and the Devices row`)

---

### Task 8: The band

**Depends on:** Task 7. **Effort:** high.

**Files:**
- Create: `desktop/lib/widgets/device_app_band.dart`
- Test: `desktop/test/devices/device_app_band_test.dart`

**The test that fails before the change:** every case in `test/devices/device_app_band_test.dart`.

**Interfaces:**
- Consumes: `DeviceAppOffer`, `DeviceAppOfferState` (Task 7); `failureLine` (Task 1); `DeviceAppFixture` (Task 7's
  support file).
- Produces: `class DeviceAppBand extends StatelessWidget { const DeviceAppBand({super.key, required this.offer, this.leadingClearance}); final DeviceAppOffer offer; final double? leadingClearance; }`.
  It listens to the offer itself and draws nothing while `!offer.bandVisible`. `leadingClearance` is the room
  left for the traffic lights; null is `trafficLightClearance`. The gallery passes 0, so its image is the same on
  every host. Keys: text `device-app-band`, main button `device-app-band-install`, quiet button
  `device-app-band-dismiss`.

  The look, as [Mockups](#mockups): the band recipe of `NewDeviceNotice` (see Found while reading the code), amber
  (`AppPalette.warn`), text of at most two lines with an ellipsis. Icon `AppIcons.arrowDownToLine`, or
  `AppIcons.triangleAlert` while failed. `TextButton` `Not now`, then `OutlinedButton` `Install` / `Installing…`
  / `Retry`. Both buttons are disabled while installing. The main button calls `offer.install()`, or
  `offer.open()` when `failedStep` is `open`. A failure line is in a `Semantics(liveRegion: true)`.

- [ ] **Step 1: Write the failing tests.** Mounted in a `MaterialApp` with `grid.buildAppTheme`, 1200 × 900, the
  band above an `Expanded`. Cases:
  - `'the offer: its sentence, Not now, then Install'`: the text is
    `Your dial follows apps and terminal tabs with the Harness menu-bar app.`; the `Not now` button's left edge is
    left of the `Install` button's.
  - `'Install installs once and reads Installing…'`: `install.gate` set; tap `Install` → the label is
    `Installing…`, both buttons have `onPressed == null`, `install.calls == 1`; complete the gate → the band
    draws nothing (`find.byKey(const Key('device-app-band'))` finds nothing).
  - `'a failure shows its line and Retry'`: `inState(failed, step: download)` → text
    `Couldn’t download the app.`, button `Retry`; tap → `install.calls == 2`.
  - `'installed but not opened: Retry opens it'`: `inState(failed, step: open)` → text
    `Installed. Couldn’t open it.`; tap `Retry` → `open.paths` has one path, `install.calls` unchanged.
  - `'Not now hides it and keeps the answer'`: tap → nothing drawn; `store.values` has
    `device_app.offer_dismissed: true`.
  - `'installed and not running: no band'`.
  - `'200% text in an 880-point window: nothing overflows'`: `MediaQuery` with `TextScaler.linear(2)`, 880 × 700,
    for the offer and for `failed` at `open` → `tester.takeException()` is null and both buttons are hit-testable.
  - `'the failure line is announced'`: the text's `Semantics` has `liveRegion`.

- [ ] **Step 2: Run them and see them fail**

Run: `flutter test --no-pub --concurrency=2 --timeout=60s test/devices/device_app_band_test.dart`
Expected: FAIL, `device_app_band.dart` not found.

- [ ] **Step 3: Commit the red tests** (message `Menu-bar app offer: the band (tests)`)

- [ ] **Step 4: Write `DeviceAppBand`.** Named roles only (`AppType`, `AppPalette`, `AppIcons`).

- [ ] **Step 5: Run the tests and the analyzer**

Run: `flutter test --no-pub --concurrency=2 --timeout=60s test/devices/device_app_band_test.dart && flutter analyze lib/widgets/device_app_band.dart test/devices/device_app_band_test.dart`
Expected: all pass; `No issues found!`

- [ ] **Step 6: Commit** (message `Menu-bar app offer: the band across the window`)

---

### Task 9: The Devices row

**Depends on:** Task 7. **Effort:** high.

**Files:**
- Create: `desktop/lib/devices/device_app_row.dart`
- Test: `desktop/test/devices/device_app_row_test.dart`

**The test that fails before the change:** every case in `test/devices/device_app_row_test.dart`.

**Interfaces:**
- Consumes: as Task 8; `SettingRow` (`lib/shared/widgets/setting_row.dart`).
- Produces: `class DeviceAppRow extends StatelessWidget { const DeviceAppRow({super.key, required this.offer}); final DeviceAppOffer offer; }`.
  It listens to the offer itself. While `state` is `hidden` it has no height. Otherwise a `SettingRow` (title
  `Menu-bar app`, detail `Follows the app and terminal tab in front.`, `controlSemanticLabel: 'Menu-bar app'`)
  with 10 points under it. Keys: `device-app-row`, button `device-app-row-action`, line `device-app-row-failure`.

  | State | Button | Line under the detail (`footer`, live region, error colour) | Press |
  |---|---|---|---|
  | `offer` | `Install` | none | `offer.install()` |
  | `installing` | `Installing…`, disabled | none | — |
  | `failed`, not at `open` | `Retry` | the step's line | `offer.install()` |
  | `failed` at `open` | `Open` | `Installed. Couldn’t open it.` | `offer.open()` |
  | `notRunning` | `Open` | none | `offer.open()` |

  The button is an `OutlinedButton`.

- [ ] **Step 1: Write the failing tests.** Mounted in a `MaterialApp` with `grid.buildAppTheme`, in a 480-wide
  column. One case per row of the table, each asserting the title, the detail, the button's label, the line (or
  its absence) and what a press called (`install.calls`, `open.paths`). And:
  - `'installed and running: nothing'`: `tester.getSize(find.byType(DeviceAppRow)).height == 0`.
  - `'Not now on the band leaves the row'`: `offer.dismiss()` → the row still shows `Install`.
  - `'a press while installing does nothing'`: `install.gate` set, tap twice → `install.calls == 1`.
  - `'200% text in a 320-point column: the button goes under the text'`: `tester.takeException()` is null; the
    button's top is below the detail's bottom.

- [ ] **Step 2: Run them and see them fail**

Run: `flutter test --no-pub --concurrency=2 --timeout=60s test/devices/device_app_row_test.dart`
Expected: FAIL, `device_app_row.dart` not found.

- [ ] **Step 3: Commit the red tests** (message `Menu-bar app offer: the Devices row (tests)`)

- [ ] **Step 4: Write `DeviceAppRow`.**

- [ ] **Step 5: Run the tests and the analyzer**

Run: `flutter test --no-pub --concurrency=2 --timeout=60s test/devices/device_app_row_test.dart && flutter analyze lib/devices/device_app_row.dart test/devices/device_app_row_test.dart`
Expected: all pass; `No issues found!`

- [ ] **Step 6: Commit** (message `Menu-bar app offer: the row on the Devices tab`)

---

### Task 10: The real parts put together, and `AppNotifier` owns the offer

**Depends on:** Tasks 3, 4, 6 and 7. **Effort:** xhigh (the only place a real install is wired; the app's state
file).

**Files:**
- Create: `desktop/lib/devices/device_app_setup.dart`
- Modify: `desktop/lib/state/app_state.dart:4149-4174` (a constructor parameter), `:4194-4197` (the initializer),
  `:4273-4279` (two listeners), `:22276` (dispose), and the field beside `dial` (`:4525-4528`)
- Test: `desktop/test/devices/device_app_setup_test.dart`

**The test that fails before the change:** every case in `test/devices/device_app_setup_test.dart`.

**Interfaces:**
- Consumes: `ChannelDeviceAppProbe` (3); `readMacSigner`, `verifyMacBundle`, `MacSigner` (4);
  `DeviceAppInstaller`, `runDeviceAppTool`, `openDeviceApp`, `deviceAppTargetFolders` (6);
  `deviceAppManifestUrl` (5, through 6); `DeviceAppOffer` (7); `deviceAppSupported`, `deviceAppBundleId` (1);
  `currentBundlePath` (`lib/update/desktop_updater.dart`).
- Produces:

```dart
/// Signed by the running Desktop's team as ai.autonomous.harness.device, and notarized. A running Desktop with
/// no signer (a local build) keeps the sha256 check alone, as its own updater does. A Desktop whose bundle or
/// signer cannot be read refuses.
Future<bool> deviceAppSignedLikeDesktop(
  String bundle, {
  String? Function()? runningBundle, // default: currentBundlePath(isLinux: false, isWindows: false)
  Future<MacSigner?> Function(String bundle) readSigner = readMacSigner,
  Future<bool> Function({required String bundle, required String team, required String identifier}) verify =
      verifyMacBundle,
});

/// The offer with the real lookup, installer and opener. [supported] defaults to
/// `!kUnderTest && deviceAppSupported()`: under test it shows nothing and never looks.
DeviceAppOffer deviceAppOfferForThisComputer({LocalKeyValueStore? store, bool? supported});
```

  And on `AppNotifier`: a constructor parameter `DeviceAppOffer? deviceAppOffer`, and
  `final DeviceAppOffer deviceAppOffer` (default
  `deviceAppOfferForThisComputer(store: paneLayoutStore?.storage)`). It calls
  `deviceAppOffer.dialChanged(dial.status.attached)` on every `dial` change and `deviceAppOffer.windowFronted()`
  when `foreground` turns true, neither after dispose, and disposes the offer. The offer logs through
  `appLog.info('devices', line)`.

- [ ] **Step 1: Write the failing tests.**
  - `'a Desktop with no signer keeps the sha256 check alone'`: `readSigner` returns null → true, `verify` not
    called.
  - `'a signed Desktop asks for its own team and Harness Device's identifier'`: `readSigner` returns
    `MacSigner(team: '54DJVWMJCC', identifier: 'ai.autonomous.harness', name: 'Autonomous Inc.')`; `verify`
    records its arguments and returns true, then false → the result follows it; the recorded call is
    `bundle: '/t/Harness Device.app', team: '54DJVWMJCC', identifier: 'ai.autonomous.harness.device'`.
  - `'a Desktop whose bundle or signer cannot be read refuses'`: `runningBundle` returns null → false;
    `readSigner` throws `cannotCheckSignature` → false.
  - `'the app feeds the offer the dial and the window'` (`testWidgets`, `TargetPlatformVariant.only(TargetPlatform.macOS)`):
    `AppNotifier(config: AppConfig.dev, authSession: AuthSession(), configStore: null, deviceAppOffer: fixture.offer)`;
    `app.dial.apply(const DialStatus(attached: true))` → `fixture.probe.lookups == 1`,
    `app.deviceAppOffer.state == offer`; a second `apply` → still 1;
    `app.appLifecycleChanged(AppLifecycleState.inactive)` then `resumed` → 2; `app.dial.disconnect()` → `hidden`.
  - `'under test the app's own offer shows nothing and never looks'` (same variant): a default `AppNotifier`, a
    mock handler on `harness/device_app` that counts; `app.dial.apply(const DialStatus(attached: true))` →
    `state == hidden`, 0 calls.
  - `'disposing the app disposes the offer'`: after `app.dispose()`, `app.dial.apply(…)` throws nothing.

- [ ] **Step 2: Run them and see them fail**

Run: `flutter test --no-pub --concurrency=2 --timeout=60s test/devices/device_app_setup_test.dart`
Expected: FAIL, `device_app_setup.dart` not found.

- [ ] **Step 3: Commit the red tests** (message `Menu-bar app offer: the app owns it and feeds it the dial (tests)`)

- [ ] **Step 4: Write `device_app_setup.dart`.** `deviceAppOfferForThisComputer` builds one `DeviceAppInstaller`
  with `manifestUrl: deviceAppManifestUrl`, `targetFolders: deviceAppTargetFolders()`,
  `verifySignature: deviceAppSignedLikeDesktop`, `open: ({path}) => openDeviceApp(runDeviceAppTool, path: path)`,
  and passes `installer.install`, the same opener and `const ChannelDeviceAppProbe()` to the offer.

- [ ] **Step 5: Wire `AppNotifier`.** The parameter, the field, the two listeners in the constructor body beside
  `addListener(_syncDeviceHosts)`, and `deviceAppOffer.dispose()` beside `deviceHosts.dispose()`. Nothing else in
  the file changes.

- [ ] **Step 6: Run the tests, the neighbours and the analyzer**

Run: `flutter test --no-pub --concurrency=2 --timeout=60s test/devices/device_app_setup_test.dart test/dial_status_test.dart test/hidden_widget_pollers_test.dart test/device_notice_bands_shell_test.dart && flutter analyze lib/devices/device_app_setup.dart lib/state/app_state.dart test/devices/device_app_setup_test.dart`
Expected: all pass; `No issues found!`

- [ ] **Step 7: Commit** (message `Menu-bar app offer: the app owns it, with the real lookup and installer`)

---

### Task 11: Both surfaces mounted, and the click-through

**Depends on:** Tasks 8, 9 and 10. **Effort:** high.

**Files:**
- Modify: `desktop/lib/app_shell.dart:574-576` (one band, after `DeviceConflictNoticeBand`), and its import
- Modify: `desktop/lib/devices/devices_screen.dart:66` (`DevicesTab.onTick`), `:84-93` (`DevicesTab.build`),
  `:96-121` (`DevicesScreen`'s parameter), `:613-624` (the settings column)
- Test: `desktop/test/devices/device_app_flow_test.dart`

**The test that fails before the change:** every case in `test/devices/device_app_flow_test.dart` but "Linux shows
nothing" and "before the workspace: no band" (neither surface is mounted yet).

**Interfaces:**
- Consumes: `DeviceAppBand` (8), `DeviceAppRow` (9), `AppNotifier.deviceAppOffer` (10), `DeviceAppFixture` (7).
- Produces: in the shell, `if (deviceBands) DeviceAppBand(offer: app.deviceAppOffer)` under the held-computer
  band and above the shared-tab notice. `DevicesScreen` takes `final DeviceAppOffer? deviceAppOffer` (null: no
  row) and puts `DeviceAppRow` above `DeviceSettingsPanel`, in one `Column`, only when
  `selected.local && selected.status.attached`. `DevicesTab` passes `widget.notifier.deviceAppOffer` and its
  `onTick` also calls `unawaited(widget.notifier.deviceAppOffer.refresh())`.

- [ ] **Step 1: Write the failing tests.** The window as a person has it: the real shell, as
  `test/device_notice_bands_shell_test.dart`'s `_pump` mounts it, with
  `authenticatedScreen: (app) => Scaffold(body: DevicesScreen(controller: controller, deviceAppOffer: app.deviceAppOffer))`,
  where `controller` is a `DevicesController(dial: app.dial, …)` over a `MemoryKeyValueStore`, loaded, as
  `test/devices_screen_test.dart` builds one,
  the app built with `deviceAppOffer: fixture.offer`, `status = AppStatus.authenticated` and a current user. The
  device images are precached as `test/devices_screen_test.dart`'s `pump` does. A dial arrives with
  `report(app.dial, [deviceStatus('d1')])` (`test/devices_controller_test.dart`). Window 1280 × 940. Cases, all
  `TargetPlatformVariant.only(TargetPlatform.macOS)` but the last two:
  - `'a dial and no menu-bar app: the band; Install installs, opens it, and the band goes'`: the band's sentence
    shows; `install.gate` set; tap `device-app-band-install` → `Installing…` on the band **and** on the row;
    complete the gate → `fixture.install.calls == 1`, no band, no row.
  - `'Not now hides the band, and it stays hidden after the window is built again'`: tap
    `device-app-band-dismiss` → no band, the row still shows `Install`; then a new app and a new fixture over the
    same store, mounted afresh, the dial attached → no band, the row shows `Install`.
  - `'the Devices row: Install, then Open, then nothing'`: tap `device-app-row-action` → installs; set the probe
    to `installedNotRunning` and `offer.refresh()` → the row's button reads `Open`, no band; tap it →
    `fixture.open.paths` has one entry; set `installedRunning`, `refresh()` → no row.
  - `'a failed install shows its line and Retry on both'`: `install.result = failed(signature)`; tap Install on
    the band → the band reads `Couldn’t verify the download.` with `Retry`, the row shows the same line with
    `Retry`; `install.result = done`, tap the row's `Retry` → both gone.
  - `'a dial on another computer: no row'`: the screen's controller over a `DeviceHosts` with one host that is
    not local (as `test/devices_hosts_test.dart` builds one), and `fixture.offer.dialChanged(true)` → the band
    shows, the row does not.
  - `'a Harness Pro alone: the same band and row'` (decision 26): the only device reported is a square Harness
    Pro, a status built as `deviceStatus` builds one plus `'board': 'pro'` (`DialStatus.isPro` true) → the band
    shows the same sentence, the row shows `Menu-bar app` with `Install`, and tapping the band's `Install` runs
    `fixture.install` once.
  - `'the Devices tab's tick looks again'`: `MaterialApp(home: Scaffold(body: DevicesTab(notifier: app, refreshEvery: const Duration(seconds: 10))))`
    with an `AppNotifier` subclass whose `refreshDevices` does nothing, the dial attached → after
    `tester.pump(const Duration(seconds: 10))`, `fixture.probe.lookups` is one more than before.
  - `'before the workspace: no band'`: `status = AppStatus.unauthenticated`, a dial attached, the offer in
    `offer` → `find.byKey(const Key('device-app-band'))` finds nothing.
  - `'Linux shows nothing'` (`TargetPlatformVariant.only(TargetPlatform.linux)`): the fixture built in the test
    body with `supported: deviceAppSupported(osVersion: 'Version 15.6 (Build 24G84)', viewer: false)`, the same
    mount and dial → no band, no row, `fixture.probe.lookups == 0`.

- [ ] **Step 2: Run them and see them fail**

Run: `flutter test --no-pub --concurrency=2 --timeout=60s test/devices/device_app_flow_test.dart`
Expected: FAIL to compile (`DevicesScreen` has no `deviceAppOffer`).

- [ ] **Step 3: Commit the red tests** (message `Menu-bar app offer: clicked through, band and Devices row (tests)`)

- [ ] **Step 4: Mount the band** in `app_shell.dart`, and extend the comment above `deviceBands` by one clause:
  the menu-bar app's offer comes last, as the least urgent.

- [ ] **Step 5: Mount the row and the tick** in `devices_screen.dart`.

- [ ] **Step 6: Run the tests, the neighbours and the analyzer**

Run: `flutter test --no-pub --concurrency=2 --timeout=60s test/devices/device_app_flow_test.dart test/device_notice_bands_shell_test.dart test/devices_screen_test.dart test/devices_tab_test.dart test/hidden_widget_pollers_test.dart test/new_device_notice_test.dart && flutter analyze lib/app_shell.dart lib/devices/devices_screen.dart test/devices/device_app_flow_test.dart`
Expected: all pass; `No issues found!`

- [ ] **Step 7: Commit** (message
  `Desktop offers and installs the Harness menu-bar app when a dial is plugged in`)

---

### Task 12: The design doc and the gallery

**Depends on:** Tasks 8 and 9. **Effort:** high.

**Files:**
- Modify: `desktop/design/desktop-design-system.md` (Elements gallery, `:290-300`; Surface families, a new
  paragraph after "Old Team Account"; Harness Device, `:696-702`, one sentence)
- Modify: `desktop/test/elements_gallery_test.dart` (a section in `_Gallery`, and its offers in `_show`)
- Create: `desktop/test/goldens/elements/device-app-light.png`, `desktop/test/goldens/elements/device-app-dark.png`

**The test that fails before the change:** in `test/elements_gallery_test.dart`, "every element matches its
section's image" in light and in dark (`device-app-…png: no image yet`), and "the images are exactly the
sections' images".

**Interfaces:**
- Consumes: `DeviceAppBand` (8), `DeviceAppRow` (9), `DeviceAppFixture.inState` (7).
- Produces: gallery section `device-app`.

- [ ] **Step 1: Add the section, and see the gallery fail.** In `_show`, before `pumpWidget`, build the offers
  with `DeviceAppFixture.inState` (dispose each in `addTearDown`) and pass them to `_Gallery`. The section, last:
  `section('device-app', 'The menu-bar app: its band offered, installing and failed; its Devices row offered, installing, failed, not opened and not running', [...])`
  with three bands, each `DeviceAppBand(offer: …, leadingClearance: 0)` in a `SizedBox(width: 720)` (`offer`,
  `installing`, `failed` at `download`), then five
  rows, each in a `SizedBox(width: 420)` (`offer`, `installing`, `failed` at `checksum`, `failed` at `open`,
  `notRunning`). If the page overflows, raise the view's height (it is in none of the images).

Run: `flutter test --no-pub --concurrency=2 --timeout=60s test/elements_gallery_test.dart`
Expected: FAIL, three tests, naming `goldens/elements/device-app-light.png` and `-dark.png`.

- [ ] **Step 2: Write the doc.**
  - Elements gallery: add `device-app` to the list of sections.
  - Surface families, a new paragraph: **Menu-bar app offer** (`widgets/device_app_band.dart`,
    `devices/device_app_row.dart`). It says: shown on macOS 13 or later while a dial is plugged in to this
    computer and the Harness menu-bar app is not installed; the band is a window band (the recipe above, amber,
    `arrowDownToLine`, `triangleAlert` on a failure), the quiet `Not now` first and `Install` last, both off while
    it reads `Installing…`, a failure replacing the sentence with its line and `Install` with `Retry`; `Not now`
    hides the band for good on this computer; the row is a setting row at the top of the Devices tab's settings
    column for a dial on this computer, one button (`Install`, `Installing…`, `Retry`, `Open`), a failure line
    under its detail as a live region, and no row once the app is installed and running; the five lines of copy,
    exact. Include the [Mockups](#mockups) as its ASCII sketch.
  - Harness Device: one sentence after the first paragraph: the desktop app offers and installs it (Surface
    families, Menu-bar app offer).

- [ ] **Step 3: Commit the red state** (the doc and the gallery test; message
  `Design system: the menu-bar app's band and Devices row (doc and gallery section)`)

- [ ] **Step 4: Make the images, and look at them**

Run: `flutter test --no-pub --update-goldens test/elements_gallery_test.dart`
Then: `git status --short desktop/test/goldens/elements`
Expected: two new files, `device-app-light.png` and `device-app-dark.png`. If another section's image shows as
changed, restore it (`git checkout -- <that file>`): this task changes no other element. Open both new images and
check each of the eight states against [Mockups](#mockups).

- [ ] **Step 5: Run the gallery again**

Run: `flutter test --no-pub --concurrency=2 --timeout=60s test/elements_gallery_test.dart`
Expected: PASS, three tests.

- [ ] **Step 6: Commit** (the two images; message `Design system: the menu-bar app offer's gallery images`)

---

### Task 13: The end-to-end test on a Mac

**Depends on:** Tasks 2, 3, 4 and 6. **Effort:** high. **No red test:** it adds a test and changes no behavior;
one commit. The tester runs it ([Verification](#verification) 1); pull request CI does not, since it reads the
network.

**Files:**
- Create: `desktop/integration_test/device_app_install_native_test.dart`

**Interfaces:**
- Consumes: `DeviceAppInstaller`, `runDeviceAppTool` (6); `deviceAppManifestUrl`, `parseDeviceAppManifest` (5);
  `verifyMacBundle` (4);
  `ChannelDeviceAppProbe` (3); the Swift channel (2); `deviceAppBundleId`, `deviceAppBundleName` (1).

- [ ] **Step 1: Write the test.** The header says how to run it and that it installs only into temporary
  folders. It refuses to run without `kUnderTest` (`FLUTTER_TEST=1`) and off macOS. Team ID `54DJVWMJCC` is a
  constant in the file (the runner is an unsigned debug build, so it cannot be read from the running bundle). No
  app switch and no `--dart-define`. Every run uses its own temporary folders, a recording opener, and a runner
  and a Dio interceptor that print one line per step (`manifest 200`, `download <n> bytes`, `tar`, `codesign ok`
  or `codesign refused`, `ditto`, `open (recorded)`), never a temporary path. Four cases:
  - `'the real release installs into the fallback folder and would open'`: `manifestUrl: deviceAppManifestUrl`,
    the default Dio, `verifySignature: (bundle) => verifyMacBundle(bundle: bundle, team: '54DJVWMJCC', identifier: deviceAppBundleId)`,
    `targetFolders: [<first, chmod 555>, <second>]`, `tempRoot: <its own>`. Expect `failed == null`,
    `installedAt == <second>/Harness Device.app`, nothing in the first folder, the opener called once with that
    path, `tempRoot` empty. Then run `/usr/bin/codesign -dv --verbose=2 <installedAt>`, print its `Identifier`,
    `TeamIdentifier`, `Authority` and `Notarization Ticket` lines, and expect
    `Identifier=ai.autonomous.harness.device` and `TeamIdentifier=54DJVWMJCC`.
  - `'a copy with one byte changed is refused at the checksum'`: download the archive the real manifest names
    into the test's own folder, change one byte in the middle, serve it from a loopback `HttpServer`; a Dio whose
    interceptor sends the CDN's archive URL there; the manifest stays the real one. Expect `failed == checksum`,
    both folders without `Harness Device.app`, `tempRoot` empty, the opener not called.
  - `'a bundle signed by someone else is refused at the signature'`: build a stand-in `Harness Device.app` in a
    temporary folder (an `Info.plist` with `CFBundleIdentifier` `ai.autonomous.harness.device`, a copy of
    `/usr/bin/true`, `codesign --force --sign -`), pack it with `/usr/bin/tar -czf`, serve it and a manifest that
    names it under the CDN prefix from loopback (the interceptor sends that URL there); the same real
    `verifyMacBundle`. Expect `failed == signature`,
    nothing installed, `tempRoot` empty, the opener not called.
  - `'the real lookup answers'`: `await const ChannelDeviceAppProbe().lookup()` returns; print both values; if
    `/Applications/Harness Device.app` exists, `installed` is true.

  `tearDown` restores the first folder to 755 and deletes every folder the case made.

- [ ] **Step 2: Run it on this Mac**

Run: `FLUTTER_TEST=1 flutter test -d macos --no-pub integration_test/device_app_install_native_test.dart`
(Intel: add `--no-enable-impeller`.)
Expected: `All tests passed!`, four tests, with the step lines and the `codesign -dv` lines in the output.
Run: `ls /Applications ~/Applications 2>/dev/null | grep -c partial`
Expected: `0`.

- [ ] **Step 3: Commit** (message `Menu-bar app offer: the real release installed, end to end, into temporary folders (native test)`)

---

## Left out

- **Product measures** (offer shown, Install, Not now, installed, failed by step). They need a new Desktop flow in
  the backend's list and a bump of the daemon core's `APP_USAGE_VOCABULARY`, a core change this feature may not
  make. The final report proposes them as their own item.
- **The links to `harness.autonomous.ai/device`** (the spec's Follow-up, a to e): a separate pull request after
  this one merges.
- **`desktop/CLAUDE.md`.** A line for the new files under "Persistence and native integration" would help the
  next reader. Not in the spec; a proposal.
- **A Swift unit test.** The Swift side has no rule left to test (decision 23: the filter is Dart's, tested by pull
  request CI), and `RunnerTests` starts the real Desktop and no gate runs it.
- **A permanent workflow for Task 13's test.** It reads the live manifest, so it cannot gate pull requests. Not
  proposed.

## Verification

1. **The native test, on this Mac (the tester).** After `flutter pub get` in `desktop/`:
   `FLUTTER_TEST=1 flutter test -d macos --no-pub integration_test/device_app_install_native_test.dart`.
   - Isolation: it reads two public files (the bucket's manifest and the CDN's archive) and writes nothing outside
     temporary folders it deletes. Install targets are two temporary folders, the first read-only. The opener
     records, so no second menu-bar app starts. `/Applications/Harness Device.app` on this Mac is never touched.
     No sign-in, no daemon, no account.
   - What to see: four tests pass. In the output: the step lines of the real install ending `open (recorded)`;
     `Identifier=ai.autonomous.harness.device`, `TeamIdentifier=54DJVWMJCC` and `Notarization Ticket=stapled`
     from the installed copy; the changed copy refused at `checksum`; the stand-in refused at `signature`; the
     lookup's two answers. Afterwards `ls /Applications ~/Applications | grep partial` prints nothing.
   - No workflow, temporary or permanent: the brief and the spec place it on this Mac, it is one debug build and
     about a minute of test, and macOS runners are capped at five for the account.
2. **`desktop-macos`, the local check the repo requires** for `desktop/macos/*` and pull request CI does not run
   (`docs/validation-and-release.md`, "What PR CI does not run"). From the repository root, on a clean tree at
   the final commit: `python3 scripts/local-checks.py --run`. It runs `make desktop-test` (the whole VM suite on
   macOS, where the installer's macOS cases and `test/update_signature_macos_test.dart` run, Task 4's three
   `verifyMacBundle` cases among them) and prints one
   `harness-local-checks` fence. Paste it into the pull request body **before** the push CI reads:
   `process-checks` takes the body from the push event. A slower Mac: `make desktop-test ARGS="--timeout 3600"`
   is the only form the receipt accepts besides `--workers`.
3. **The affected tests and the analyzer, locally, before the pull request:**
   `flutter test --no-pub --concurrency=2 --timeout=60s test/devices test/macos_device_app_channel_test.dart test/update_signature_test.dart test/update_signature_macos_test.dart test/elements_gallery_test.dart test/device_notice_bands_shell_test.dart test/devices_screen_test.dart test/hidden_widget_pollers_test.dart`
   and `flutter analyze`. Expected: all pass; `No issues found!`. Pull request CI then runs the whole suite on
   Linux (`desktop-tests`), where the cases that need `ditto` are skipped.
4. **The macOS app compiles with the new Swift file:** `bash scripts/build-macos-debug.sh --no-pub`. Expected:
   `Local review build ready`. (Check 1 builds it too.)
5. **The web build still compiles:** `flutter build web --release --no-wasm-dry-run --no-web-resources-cdn` in
   `desktop/`. Expected: `✓ Built build/web`. No pull request check builds it, and three files it holds gain
   imports. A few minutes, locally; no workflow.
6. **A real install, seen by a person. Only the owner (Diego) does it, and it holds the merge** (decision 28). It is the
   one path no test reaches: a signed Desktop reading its own Team ID and installing into `/Applications`.
   - When: last, after the final review and checks 1 to 5 and pull request CI are green on the final head, and
     only on the PM's go: the workflow is heavy (both macOS builds, signed and notarized) and uploads an unlisted
     build to the release bucket.
   - The build: from the final head, `git push origin HEAD:internal/<name>` (for example
     `internal/desktop-installs-harness-device`), which runs `.github/workflows/desktop-internal-build.yml`
     (`desktop/CLAUDE.md`, "internal"; `desktop/RELEASE.md`, "Internal builds"). The run page prints two `.dmg`
     links, `Harness-macos-…dmg` (Intel) and `Harness-macos-arm64-…dmg` (Apple Silicon). Self-update is off in
     it, so it stays the build under test. Nothing in the code changes for it: no switch, no `--dart-define`.
   - Isolation: the owner's own Mac, his own sign-in and his own dial, by his choice; no test account is needed,
     since the band needs only a dial and a missing app. The build installs the real menu-bar app into the real
     `/Applications`, which is what is being checked; the copy he moved to the Trash at step 3 also checks that a
     Trash copy does not count as installed. The internal build replaces his Desktop in `/Applications` until he
     installs the regular one again (step 9). Afterwards the build can be taken back with the `gcloud storage rm`
     line its run summary prints.
   - The steps to send him, as they are:

     > 1. Plug your dial into your Mac.
     > 2. Quit the Harness menu-bar app: click its icon in the menu bar, then Quit.
     > 3. In Finder, open Applications and move `Harness Device.app` to the Trash.
     > 4. Quit the Harness app (⌘Q). Download the internal build from this link: `<the .dmg link for your Mac>`.
     >    Open it, drag Harness to Applications, replacing the one there, and open it from Applications.
     > 5. At the top of the window you should see: "Your dial follows apps and terminal tabs with the Harness
     >    menu-bar app." with `Not now` and `Install`.
     > 6. Press `Install`. It reads `Installing…` for a moment.
     > 7. You should then see `Harness Device.app` back in Applications, the Harness icon back in the menu bar, and
     >    the band gone.
     > 8. Reply with what you saw at steps 5 to 7 (a screenshot of the band helps), or the line the band showed if
     >    it failed.
     > 9. This build never updates itself: when you are done, install the regular Harness again.

   - The result goes in the pull request body. Until it is there, the pull request is not merged.

For the pull request: platforms macOS (tested), Linux and Windows (nothing shown; Task 11's Linux case); the UI
checklist with the gallery's two images; each task's red and green commits; the receipt of check 2; the output of
check 1; the lookup's cost (one AppKit call when a dial arrives, when the window comes back, and every 10 s
while the Devices tab is seen; none with no dial).
