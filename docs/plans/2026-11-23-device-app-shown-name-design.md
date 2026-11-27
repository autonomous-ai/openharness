# Harness Device shows its own name — design

Date: 2026-11-23. Component: `device-app/` (plus the docs that name it). Size: full.

## Why

macOS lists two apps named **Harness** in System Settings ▸ Privacy & Security ▸ Accessibility: the Harness desktop
app (`Harness.app`, `ai.autonomous.harness`) and Harness Device (`Harness Device.app`, `ai.autonomous.harness.device`).
On 2026-11-23 the person turned on the wrong one, so the dial never followed ChatGPT. #4565 (in 0.1.13) asks for
Accessibility at the first launch, but the ask and the list still say "Harness".

The name comes from #4411, which named the menu-bar app **Harness** on purpose:

- `tauri.conf.json` `bundle.macOS.bundleName: "Harness"` → `CFBundleName = Harness`;
- `src-tauri/en.lproj/InfoPlist.strings` (`CFBundleName` and `CFBundleDisplayName` = "Harness"), shipped through
  `bundle.macOS.files`, with `LSHasLocalizedDisplayName` and `CFBundleDevelopmentRegion = en` in `Info.plist`, so
  macOS shows the localized "Harness" in Finder, Login Items, the About panel, TCC lists and permission prompts.

The installed 0.1.13 reads `CFBundleName = Harness`, `CFBundleDisplayName = Harness Device` (Tauri writes the display
name from `productName`), and the localized strings override both to "Harness".

## Goal

Everywhere a person sees this app's name, it reads **Harness Device**: macOS (Accessibility and the other TCC lists,
Login Items, Finder, the About panel, the Accessibility and Apple Events prompts), Windows (Apps & features, Start,
the tray tooltip, About), Linux (the app-list entry, the login entry, About; AppIndicator shows no tray tooltip, so
Linux has none), and the app's own window and copy wherever it names itself.

"Harness" stays where it means the Harness product, the CLI or the daemon: `Setting up Harness`,
`Downloading Harness…`, `Starting Harness`, `Harness stopped`, `Harness removed`, the daemon's `Updating Harness`,
`Harness did not answer`, `Open Harness` (the desktop app), and the CLI's version in the About credits
(`Harness 0.6.58`).

## What must not change

So installed apps keep updating and keep every permission already granted:

| Kept | Value |
|---|---|
| Bundle id | `ai.autonomous.harness.device` |
| `productName` | `Harness Device` (so `Harness Device.app`, the Windows folder, Start entry, uninstall key and Run value) |
| Binary | `harness-device` (`CFBundleExecutable`, `harness-device.exe`) |
| Release files | `Harness Device.app.tar.gz`, `Harness Device_<v>_universal.dmg`, `Harness Device_<v>_<arch>.AppImage`, `Harness Device_<v>_<arch>-setup.exe`, the `Harness-Device*` public names |
| Update path | the updater endpoint and pubkey in `tauri.conf.json`; the manifest keys |
| Signing | Developer ID team `54DJVWMJCC`, entitlements (`Entitlements.plist`), the Windows signer |
| Linux app-list entry | `harness-device.desktop`, already `Name=Harness Device` |

## Why the grants survive (TCC)

macOS keys a TCC grant (Accessibility, Apple Events) on the client's bundle id plus its **code requirement**
(`csreq`), which the system stores from the app's designated requirement. The installed 0.1.13's designated
requirement, read from the bundle on disk with `codesign -d -r- "/Applications/Harness Device.app"` (the app was not
run):

```
designated => identifier "ai.autonomous.harness.device" and anchor apple generic and
  certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and
  certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and
  certificate leaf[subject.OU] = "54DJVWMJCC"
```

It names the bundle id and the Developer ID team, nothing in `Info.plist` beyond the identifier. This change keeps
both. Every release already changes `Info.plist` (`CFBundleShortVersionString`, `CFBundleVersion`) and grants
survive it; #4411 itself changed `CFBundleName` (Harness Device → Harness) in an update. So the grant already given
stays. The one visible lag: System Settings shows the name LaunchServices has registered for the bundle, which the
update refreshes (the updater `touch`es the bundle after the swap, and the next launch registers it). The PR carries
the designated requirement of the built bundle beside this one, to show they match.

## Design

### macOS: drop the localized name

Tauri writes `CFBundleName` from `bundleName`, else `productName`, and `CFBundleDisplayName` from `productName`
(tauri-bundler 2.10.4, `bundle/macos/app.rs`). With no override both are "Harness Device", the file's name, so no
localization is needed:

- remove `bundle.macOS.bundleName` and `bundle.macOS.files` (the strings mapping) from `tauri.conf.json`;
- delete `src-tauri/en.lproj/InfoPlist.strings` (and the folder);
- remove `LSHasLocalizedDisplayName` and `CFBundleDevelopmentRegion` from `src-tauri/Info.plist`: both were added by
  #4411 for the strings only (Tauri writes its own `CFBundleDevelopmentRegion`);
- `NSLocalNetworkUsageDescription`: "Harness Device finds and connects to Autonomous robots on your local network."

The Accessibility prompt (`AXIsProcessTrustedWithOptions` in `follow_macos.rs`) and the Apple Events prompt name the
app from the bundle, so they read "Harness Device" with no code change. An update swaps the whole bundle, so the old
`en.lproj` leaves with it.

Rejected: keeping the localization and changing the strings to "Harness Device" (two ways to set one name, two files
to keep).

### The app's own copy

Each place where the app names itself:

| Where | Now | Becomes |
|---|---|---|
| Window title (`tauri.conf.json` `app.windows[0].title`), `ui/index.html` `<title>` | Harness | Harness Device |
| Tray tooltip (`main.rs`; shows on macOS and Windows, AppIndicator has none) | Harness | Harness Device |
| About dialog name on Windows and Linux (`main.rs` `AboutMetadata.name`) | Harness | Harness Device |
| Follow ChatGPT screen (`ui/src/screens.ts`) | "… Harness reads only the ChatGPT window's title …" | "… Harness Device reads only the ChatGPT window's title …" |
| The app's own update row (`model.rs`, `AppUpdate::Installing`) | Updating Harness… | Updating Harness Device… |
| Gallery tray `alt` (`ui/src/gallery.ts`), `ui/gallery.html` `<title>` | Harness, Harness gallery | Harness Device, Harness Device gallery |

macOS's About panel takes its name from the bundle, so it follows the macOS change.

One name, one place: `pub const APP_NAME: &str = "Harness Device"` in the library (`types.rs`), which `main.rs` uses
for the tooltip and `AboutMetadata.name`; and `pub const UPDATING_APP: &str = "Updating Harness Device…"` in
`model.rs`, which the menu and every test that looks for the row use.

### Linux: the login entry the app writes

`harnessd.desktop` in `~/.config/autostart` is shared with the CLI's installer (`install.sh write_login_entry`),
which writes `Name=Harness` for its own entry (it starts the daemon). The app takes the entry over and points its
`Exec=` at the AppImage, so the session starts the app. Startup Applications and similar lists show its `Name=`.

- `fresh` (a new entry the app writes): `Name=Harness Device`.
- `change` (an entry that is on). Its name line is the first line whose key, trimmed, is exactly `Name` (not
  `Name[xx]`) inside the `[Desktop Entry]` group, before the next `[group]` header; key and value are read with the
  spaces the Desktop Entry spec allows around `=` trimmed, as `is_off` reads them (so `Name = Harness` is the name
  `Harness`). An entry with no `[Desktop Entry]` header gets no `Name=` added: only its `Exec=` changes, as today.
  - Whenever it writes the app's `Exec=` line (taking over the installer's entry, or an AppImage since moved), a name
    line that is exactly `Name=Harness` becomes `Name=Harness Device`; with no name line, `Name=Harness Device` is
    added after the group's `Type=` line, else right after the `[Desktop Entry]` header.
  - An entry already the app's (its own `Exec=`) whose name line is exactly `Name=Harness` is written once with
    `Name=Harness Device`, so installed apps get it at their next launch; with any other name it is left as it is.
  - A name the person gave the entry (any other `Name=` value) is kept. Everything else in the file is kept, as
    today.
- An entry turned off, or one the person deleted, is left as it is (today's rule).
- The installer's own entry, which the app has not taken over, is the installer's; nothing here changes it.

The installer and the uninstaller read only the first `Exec=` line to tell whose entry it is, so the name changes
nothing for them.

### Windows

Nothing in the installer changes: NSIS already takes `productName` for the uninstall `DisplayName`, the Start menu
`Harness Device.lnk` and the folder, and tauri-build already writes `FileDescription = ProductName = Harness Device`
into the exe (what the taskbar's notification-area settings list). Only the tooltip, the About dialog and the window
title change, as above.

### Docs

In the same pull request, as the repo's rules require:

- `device-app/AGENTS.md`: the opening paragraph says the app is named Harness Device everywhere a person sees it,
  and why (the desktop app is Harness; two apps named Harness in Accessibility), and that the bundle id, binary,
  release files and update path never change. The rules that say Harness for this app ("once Harness has
  Accessibility", "has not given Harness Accessibility", "Harness is trusted") say Harness Device.
- `docs/naming-system.md`: the menu-bar app's row says **Harness Device**, its reasoning rewritten (named Harness
  Device everywhere, since the desktop app is Harness), keeping its code name, tray and device wording.
- `desktop/design/desktop-design-system.md` "Harness Device": the app is named Harness Device wherever a person
  sees it.
- `device-app/RELEASE.md`: the app update row reads `Updating Harness Device…`.

Left as they are: the Desktop app's band copy ("…with the Harness menu-bar app.", `desktop/lib/devices/device_app.dart`,
and its design doc lines), Desktop's own copy; and the website download routes' `product: "Harness"` error text
(`website/src/app/device/download-*/route.ts`). Both are other components' copy; the final report names them as
possible follow-ups.

## Tests (red first)

- `src-tauri/src/types.rs`: `the_app_is_named_harness` becomes `the_app_is_named_harness_device`, a test that the
  shown name is Harness Device:
  `productName` "Harness Device", no `bundleName`, no `bundle.macOS.files`, no `en.lproj` folder, `Info.plist` without
  `LSHasLocalizedDisplayName`, `CFBundleDevelopmentRegion` or any `CFBundleName`/`CFBundleDisplayName`. In the
  same test, the kept identity: identifier `ai.autonomous.harness.device`, the updater endpoint and pubkey,
  `Cargo.toml`'s `[[bin]]` `harness-device`, and the entitlements path. It also asserts `APP_NAME` equals
  `productName`. `the_window_is_small_fixed_and_hidden`: title equals `productName`.
  `the_bundle_asks_for_the_local_network`: the new `NSLocalNetworkUsageDescription` sentence.
- `src-tauri/src/packaging.rs`: `the_window_is_harness_at_420_by_320_with_no_taskbar_button` becomes
  `the_window_is_harness_device_at_420_by_320_with_no_taskbar_button`, title "Harness Device".
- `model.rs`: one test pins `UPDATING_APP` to `Updating Harness Device…`; the daemon's row stays `Updating Harness`.
  `parity.rs` (`shows_the_row`) and every `app.rs` check of the row (positive and negative) use `UPDATING_APP`, so
  the negative checks keep testing something.
- `main.rs` is the binary, which `cargo test --lib` does not run: no test there; it only uses `APP_NAME`.
- `loginitem_linux.rs`: `fresh` writes `Name=Harness Device`. `change` sets the name when it takes over an entry
  (installer's `Exec=`, moved AppImage), rewrites an app-owned entry still named exactly Harness once, adds a missing
  `Name=` (after `Type=`, else after the header), keeps a person's own name and `Name[xx]=` lines, and leaves an
  entry turned off as it is. The existing tests at `loginitem_linux.rs` ~383, 398, 408, 420 are updated.
- `ui/src/screens.test.ts`: the Follow ChatGPT sentence names Harness Device.
- `scripts/test_release_build.py` already pins the release file names; it stays as is and must stay green.
- End to end, updated with the code; PR CI runs both:
  - `scripts/e2e/linux.sh`: the login entry expectations read `Name=Harness Device` where the app wrote (~414) or
    took over (~551, ~578) the entry; the turned-off fixture (~501) stays `Name=Harness`; the window searches
    (~610, ~611, ~620) use `--name '^Harness Device$'`.
  - `scripts/e2e/windows.ps1`: `$ABOUT = 'About Harness Device'` (~884), the window search `Find(..., 'Harness
    Device')` (~1555), and the tray icon match made exact, `-eq 'Harness Device'` (~1103, comment ~1098), so it fails
    on the old name.
  - `scripts/e2e/macos.sh` asserts no shown name (only `Harness Device.app` paths and the desktop app's
    `Open Harness`): unchanged.

## Verification

- PR CI: `device-app-checks` (Linux and Windows `cargo test`), `device-app-e2e` (`linux.sh`, `windows.ps1`),
  `device-app-update`, `device-app-desktop` and `device-app-install` (`tauri*.conf.json` changes trigger them).
- macOS, local, no run: build `cargo tauri build --debug` with its own `CARGO_TARGET_DIR` in a scratch folder (never
  `/Applications`, never opened, never installed), then read the built `Info.plist` with PlistBuddy:
  `CFBundleName` and `CFBundleDisplayName` = Harness Device, `CFBundleIdentifier` = `ai.autonomous.harness.device`,
  `CFBundleExecutable` = `harness-device`, no `en.lproj` in `Resources`. Also `codesign -d -r-` of the built bundle to
  show the identifier in its requirement is unchanged (a local debug build is ad-hoc signed, so the team part shows
  only in a release build). `scripts/e2e/macos.sh` is not run: the app is never run on this Mac.
- Held for Diego after a Harness Device release (his call): on his Mac, after the update, Accessibility, Login Items
  and the About panel read Harness Device, the Accessibility switch he already turned on is still on, and the dial
  still follows ChatGPT.
- Windows check (Ken's side), optional: the installer does not change; with the PR's build, the tray tooltip, the About
  dialog and Apps & features read Harness Device.

## Out of scope

- Any change to `productName`, the bundle id, the binary, release file names, the update path or the signing.
- The desktop app's own name, entries and copy.
- A release (Diego decides; the change ships in the next Harness Device release).
