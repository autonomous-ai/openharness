# Harness Device shows its own name — implementation plan

> **For agentic workers:** REQUIRED: execute with devcrew phase 3, task by task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** everywhere a person sees the menu-bar app's name (macOS TCC lists, Login Items, Finder, About; Windows
tray, About, window; Linux login entry, About, window; the app's own copy) it reads **Harness Device**, while the
bundle id, `productName`, binary, release files, update path and signing stay as they are.

**Architecture:** drop the macOS localization #4411 added, so Tauri writes `CFBundleName` = `CFBundleDisplayName` =
`productName`. One constant per name (`APP_NAME` in `types.rs`, `UPDATING_APP` in `model.rs`) feeds the binary and the
tests. The Linux login entry `harnessd.desktop` gets `Name=Harness Device` when the app writes or takes it over, and a
person's own name is kept.

**Tech Stack:** Rust + Tauri 2 (`device-app/src-tauri`), TypeScript + vitest (`device-app/ui`), bash and PowerShell
end-to-end drivers (`device-app/scripts/e2e`).

**Spec:** `docs/plans/2026-11-23-device-app-shown-name-design.md`

## Global Constraints

- Shown name: `Harness Device`. "Harness" stays where it means the product, CLI or daemon: `Setting up Harness`,
  `Downloading Harness…`, `Starting Harness`, `Harness stopped`, `Harness removed`, the daemon's `Updating Harness`,
  `Harness did not answer`, `Open Harness`, the About credits `Harness 0.6.58`.
- Never change: identifier `ai.autonomous.harness.device`; `productName` `Harness Device`; binary `harness-device`
  (`Cargo.toml` `[[bin]]`); release files (`scripts/test_release_build.py` stays as is and green); updater endpoint
  `https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/metadata.json` and the committed pubkey;
  `bundle.macOS.entitlements` = `Entitlements.plist`; `bundle.macOS.minimumSystemVersion` `13.0`; the Windows installer.
- `NSLocalNetworkUsageDescription`: `Harness Device finds and connects to Autonomous robots on your local network.`
- Follow ChatGPT body: `Your dial moves to the thread you open in ChatGPT. Harness Device reads only the ChatGPT
  window's title, while ChatGPT is in front.`
- App update row: `Updating Harness Device…` (with the ellipsis character `…`).
- No release. The app is never run on this Mac (`scripts/e2e/macos.sh` is not run). Commit nothing beyond each task's
  own commits; stage only the task's files.
- Out of scope: Desktop's band copy (`desktop/lib/devices/device_app.dart`), the website download routes' error text.

## Review Focus

1. **An update keeps the Accessibility grant.** No unit test can see TCC; Task 1 pins every input of the designated
   requirement (identifier, entitlements) and the update path, and Verification compares `codesign -d -r-`. Diego's
   held check after a release closes it.
2. **A login entry with localized names** (`Name[vi]=Harness` before `Name=Harness`): only the plain `Name=` line
   changes, every `Name[xx]=` stays. Test in Task 3.
3. **A login entry with a second group** (`[Desktop Action x]` holding `Name=Harness`) and no `Name=` in
   `[Desktop Entry]`: the name is added in `[Desktop Entry]`, the action's line is untouched. Test in Task 3.
4. **An app-owned entry still named Harness, at two launches in a row:** written once, then left (a command that
   arrives twice does its work once). Test in Task 3.
5. **The old name must fail the drivers:** the Windows tray match is exact (`-eq 'Harness Device'`) and the Linux
   window search is anchored (`'^Harness Device$'`), so a build still named Harness fails them (Tasks 1 and 3).

---

### Task 1: The bundle, window, tray and About read Harness Device; the identity is pinned

Effort: **xhigh** (the bundle identity every installed app updates through and every TCC grant is keyed on).
Depends on: none.

**Files:**
- Modify: `device-app/src-tauri/tauri.conf.json` (drop `bundle.macOS.bundleName` and `bundle.macOS.files`;
  `app.windows[0].title` → `Harness Device`)
- Modify: `device-app/src-tauri/Info.plist` (drop `CFBundleDevelopmentRegion` and `LSHasLocalizedDisplayName`; new
  `NSLocalNetworkUsageDescription`)
- Delete: `device-app/src-tauri/en.lproj/InfoPlist.strings` and the `en.lproj` folder
- Modify: `device-app/src-tauri/src/types.rs` (`APP_NAME`, tests)
- Modify: `device-app/src-tauri/src/packaging.rs` (test)
- Modify: `device-app/src-tauri/src/main.rs` (`.tooltip(APP_NAME)`, `AboutMetadata.name: Some(APP_NAME.into())`;
  `APP_NAME` added to the existing `harness_device::types::{…}` import)
- Modify: `device-app/ui/index.html` (`<title>Harness Device</title>`)
- Modify: `device-app/scripts/e2e/windows.ps1` (~884 `$ABOUT = 'About Harness Device'`; ~1555
  `Find($script:app.Id, 'Harness Device')`; ~1103 `$button.Current.Name -eq 'Harness Device'`, comment ~1098 "its
  tooltip is Harness Device")

**Interfaces:**
- Produces: `pub const APP_NAME: &str = "Harness Device";` in `harness_device::types`, with a doc comment saying why
  (the desktop app is Harness; two apps named Harness in Accessibility). Window title `Harness Device`, which Task 3's
  `linux.sh` window search relies on.

- [ ] **Step 1: Write the failing tests (`types.rs`, `packaging.rs`)**

  - Rename `the_app_is_named_harness` → `the_app_is_named_harness_device`; replace its body and doc comment. It
    asserts, reading `tauri.conf.json`, `Info.plist` (trimmed lines joined, as today) and `Cargo.toml`:
    - `config["productName"] == "Harness Device"`, `config["identifier"] == "ai.autonomous.harness.device"`;
    - `bundle.macOS` has no `bundleName` and no `files` key (`.get(..) == None`), and
      `bundle.macOS.entitlements == "Entitlements.plist"`;
    - `!Path::new(env!("CARGO_MANIFEST_DIR")).join("en.lproj").exists()`;
    - the plist contains none of `CFBundleDevelopmentRegion`, `LSHasLocalizedDisplayName`, `CFBundleName`,
      `CFBundleDisplayName`;
    - `plugins.updater.endpoints == ["https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/metadata.json"]`
      and `plugins.updater.pubkey` equals the committed key string exactly;
    - `Cargo.toml` holds the lines `[[bin]]`, `name = "harness-device"`, `path = "src/main.rs"` in that order.
  - `the_window_is_small_fixed_and_hidden`: `window["title"] == config["productName"]`.
  - `the_bundle_asks_for_the_local_network`: the entry string becomes
    `<string>Harness Device finds and connects to Autonomous robots on your local network.</string>`.
  - `packaging.rs`: rename `the_window_is_harness_at_420_by_320_with_no_taskbar_button` →
    `the_window_is_harness_device_at_420_by_320_with_no_taskbar_button`, `window["title"] == "Harness Device"`.

- [ ] **Step 2: Run to see them fail**

  Run: `cd device-app/src-tauri && cargo test --locked --lib -- the_app_is_named_harness_device the_window_is the_bundle_asks`
  Expected: FAIL (`bundleName` is still there; title `Harness`; old plist sentence). Red commit:
  `git add device-app/src-tauri/src/types.rs device-app/src-tauri/src/packaging.rs`.

- [ ] **Step 3: Make them pass**

  Edit the config, plist and HTML as listed; `git rm -r device-app/src-tauri/en.lproj`; add `APP_NAME` to `types.rs`
  and the line `assert_eq!(APP_NAME, config["productName"]);` to `the_app_is_named_harness_device` (added here, so the
  red commit compiled); use it in `main.rs`; update `windows.ps1` as listed.

- [ ] **Step 4: Run to see them pass**

  Run: `cd device-app/ui && npm run build && cd ../src-tauri && cargo test --locked` (a Mac: compiles `main.rs` too)
  and `python3 -m unittest discover -s device-app/scripts -p 'test_*.py'` from the repo root.
  Expected: all PASS; `test_release_build` unchanged and green.

- [ ] **Step 5: Commit** the files listed above.

### Task 2: The app's own update row reads `Updating Harness Device…`

Effort: **high**. Depends on: none.

**Files:**
- Modify: `device-app/src-tauri/src/model.rs` (constant, `AppUpdate::Installing` row, tests)
- Modify: `device-app/src-tauri/src/parity.rs` (`shows_the_row`)
- Modify: `device-app/src-tauri/src/app.rs` (the row checks ~1478, 1486, 1551, 1559, 1626, 1652, 1683)

**Interfaces:**
- Produces: `pub const UPDATING_APP: &str = "Updating Harness Device…";` in `harness_device::model`, with a comment
  that the firmware's row is `Updating device…` and the daemon's `Updating Harness`.

- [ ] **Step 1: Write the failing test.** In `model.rs` `the_update_rows`, the `Installing` row expects
  `text("Updating Harness Device…")` (a literal, so the red commit compiles).
- [ ] **Step 2: Run it.** `cd device-app/src-tauri && cargo test --locked --lib model::tests::the_update_rows` →
  FAIL (`Updating Harness…`). Red commit: `model.rs`.
- [ ] **Step 3: Make it pass.** Add `UPDATING_APP`; `model.rs:72` pushes `MenuItem::Text(UPDATING_APP.into())`; add
  test `the_apps_update_row_names_harness_device`: `assert_eq!(UPDATING_APP, "Updating Harness Device…")` and the
  daemon status for `Daemon::Updating` still `"Updating Harness"`; `the_update_rows` uses `text(UPDATING_APP)`. In
  `parity.rs` and every `app.rs` check of the row (positive and negative) use `UPDATING_APP`, so none still looks for
  the old text.
- [ ] **Step 4: Run.** `cd device-app/src-tauri && cargo test --locked --lib` → PASS;
  `grep -rn 'Updating Harness…' device-app/src-tauri/src` → no match.
- [ ] **Step 5: Commit** the three files.

### Task 3: Linux login entry: `Name=Harness Device`, a person's name kept

Effort: **xhigh** (rewrites a file in the person's home that the CLI's installer shares). Depends on: Task 1 (the
`linux.sh` window search expects the title Task 1 sets).

**Files:**
- Modify: `device-app/src-tauri/src/loginitem_linux.rs` (`fresh`, `change`, a name helper, tests)
- Modify: `device-app/scripts/e2e/linux.sh`

**Interfaces:**
- Consumes: window title `Harness Device` (Task 1).
- Produces: nothing other tasks use. `fresh(exec: &str) -> String` and
  `change(existing: Option<&str>, exec: &str, first: bool) -> Change` keep their signatures.

Rules (spec, "Linux: the login entry the app writes"), for `change` on an entry that is on:
- The **name line** is the first line, after the `[Desktop Entry]` header and before the next line starting with `[`,
  that splits at its first `=` into a key that, trimmed, is exactly `Name` (not `Name[xx]`). Its value is read
  trimmed too, as `is_off` reads key and value: `Name = Harness` is the name `Harness`. "Named Harness" below means
  that trimmed value is exactly `Harness`; such a line is replaced whole by `Name=Harness Device`, so an entry with a
  name line never gets a second `Name` key.
- Other `Exec=` (installer's, moved AppImage): replace the `Exec=` line as today; a name line named Harness becomes
  `Name=Harness Device`; with no name line, insert `Name=Harness Device` after the group's first `Type=` line, else
  right after the `[Desktop Entry]` header; any other name line is kept.
- No `[Desktop Entry]` header: no name line and no `Name=` added; only `Exec=` changes, as today.
- Own `Exec=`: a name line named Harness → `Write` with it replaced; anything else (another name, no name line,
  already `Harness Device`) → `Leave`.
- Off, absent, no `Exec=` line: as today (`fresh` now carries `Name=Harness Device`). Every other byte is kept.

- [ ] **Step 1: Write the failing tests** (literal strings, no new constant)
  - `a_fresh_entry_is_dial_linuxs_format`: `"[Desktop Entry]\nType=Application\nName=Harness Device\nExec=X\nX-GNOME-Autostart-enabled=true\n"`.
  - `an_entry_that_is_on_is_taken_over_and_keeps_its_other_lines`: `taken` also has `Name=Harness Device` in place of
    `Name=Harness` (installer's and moved cases).
  - `a_taken_over_entry_without_a_name_gets_one`: installer's entry with no `Name=` → `Name=Harness Device` right
    after `Type=Application`; one with neither → right after `[Desktop Entry]`.
  - `a_name_the_person_gave_is_kept`: `Name=My dial` with the installer's `Exec=` → only `Exec=` changes; the app's
    own `Exec=` with `Name=My dial` → `Leave`.
  - `localized_names_and_other_groups_are_kept`: `Name[vi]=Harness` before `Name=Harness` → only `Name=` changes; an
    entry whose `[Desktop Entry]` has no `Name=` and a later `[Desktop Action x]` with `Name=Harness` → the name is
    inserted in `[Desktop Entry]`, the action's line is untouched.
  - `a_name_with_spaces_around_the_equals_is_the_name_line`: the installer's entry with `Name = Harness` → `Write`
    whose text holds `Name=Harness Device` in that line's place, no `Name = Harness`, and exactly one line whose key
    trims to `Name`; the app's own `Exec=` with `Name = Harness` → `Write` with the same single `Name=Harness Device`;
    the installer's entry with `Name = My dial` → only `Exec=` changes, no `Name=` line added.
  - `an_entry_without_the_header_gets_no_name`: an entry that is on, with `Type=Application` and the installer's
    `Exec=` but no `[Desktop Entry]` line → `Write` whose text is the input with only the `Exec=` line replaced (no
    `Name=` line); the same with the app's own `Exec=` → `Leave`.
  - `the_apps_own_entry_named_harness_is_renamed_once`: own `Exec=` + `Name=Harness` → `Write` with
    `Name=Harness Device`; `change` on that result → `Leave`.
  - `the_apps_own_entry_is_not_rewritten` stays (now `fresh` is already `Harness Device`); add an own entry with no
    name line → `Leave`.
  - `an_entry_that_is_off_is_left_alone` stays unchanged (fixtures `Name=Harness`).
- [ ] **Step 2: Run.** `cd device-app/src-tauri && cargo test --locked --lib loginitem_linux` (runs on a Mac:
  `cfg(all(test, unix))`) → FAIL. Red commit: `loginitem_linux.rs`.
- [ ] **Step 3: Implement** in `loginitem_linux.rs`: `fresh` with `Name=Harness Device`; `change` per the rules above,
  through one private helper that returns the text with the name applied (`fn named(entry: &str, add: bool) -> Option<String>`,
  `None` when it changes nothing; `add` is true only when the `Exec=` line is being written). Update the module and
  `change` doc comments.
- [ ] **Step 4: Update `linux.sh`.**
  - ~414 expected first-run entry: `Name=Harness Device`.
  - ~551 `installers`: takes the name as a second argument; the fixture writes `Name=Harness`, the expectation at
    ~578 compares `installers "$own_exec" 'Name=Harness Device'`.
  - ~501 turned-off fixture and ~592 the desktop app's `harness.desktop`: unchanged.
  - ~610, ~611, ~620: `xdotool search --onlyvisible --name '^Harness Device$'`.
  - `bash -n device-app/scripts/e2e/linux.sh` passes (the driver itself runs in PR CI's `device-app-e2e`).
- [ ] **Step 5: Run.** `cargo test --locked --lib` → PASS. Commit both files.

### Task 4: The window's copy and the gallery say Harness Device

Effort: **medium** (mechanical copy in `ui/`). Depends on: none.

**Files:**
- Modify: `device-app/ui/src/screens.ts` (~56, the Follow ChatGPT body)
- Modify: `device-app/ui/src/screens.test.ts` (~129, ~221)
- Modify: `device-app/ui/src/gallery.ts` (~54 `tray.alt = 'Harness Device'`)
- Modify: `device-app/ui/gallery.html` (`<title>Harness Device gallery</title>`)

- [ ] **Step 1: Failing test.** Both `screens.test.ts` expectations of the Follow ChatGPT body read the sentence in
  Global Constraints.
- [ ] **Step 2: Run.** `cd device-app/ui && npx vitest run src/screens.test.ts` → FAIL. Red commit: `screens.test.ts`.
- [ ] **Step 3: Implement** the three copy changes.
- [ ] **Step 4: Run.** `npx vitest run && npx tsc --noEmit && npm run gallery` → PASS, gallery builds.
- [ ] **Step 5: Commit** the four files.

### Task 5: Docs name the app Harness Device

Effort: **medium**. Depends on: none. No behavior change: no test, one commit.

**Files:**
- Modify: `device-app/AGENTS.md` — the opening paragraph: named Harness Device everywhere a person sees it, because
  the desktop app is Harness and two apps named Harness sat in Accessibility; the bundle id, binary, release files and
  update path never change. "once Harness has Accessibility", "has not given Harness Accessibility", "Harness is
  trusted" → Harness Device.
- Modify: `docs/naming-system.md` (line 27, the menu-bar app's row): **Harness Device**, the reasoning rewritten (named
  Harness Device everywhere, since the desktop app is Harness), keeping its code name, tray and device wording.
- Modify: `desktop/design/desktop-design-system.md` ("Harness Device", ~776-778): named **Harness Device** wherever a
  person sees it.
- Modify: `device-app/RELEASE.md` (~237): the row reads `Updating Harness Device…`.

- [ ] **Step 1:** make the four edits, then reread each edited paragraph: no "Harness" is left that names this app,
  and the product, CLI and daemon uses stay.
- [ ] **Step 2: Commit** the four files.

---

## Verification

1. **PR CI** (planner on these paths selects `device-app`, `device-app-e2e`, `device-app-update`,
   `device-app-desktop`, `device-app-install`, `desktop`, `os` (ships `docs/naming-system.md`) and `cross-read-scan`;
   confirm with `python3 scripts/ci-plan.py` before starting checks):
   - `device-app-checks` (Linux, Windows): release-script tests, `tsc`, `vitest`, `cargo test --locked` (Linux runs
     `loginitem_linux` and the non-macOS `main.rs` About path compiles there).
   - `device-app-e2e`: `linux.sh` (login entry `Name=Harness Device` on first run and take-over, the turned-off entry
     left with `Name=Harness`, window found as `^Harness Device$`) and `windows.ps1` (About window `About Harness
     Device`, window `Harness Device`, tray icon exactly `Harness Device`), against the fake CLI, on GitHub's
     disposable runners.
   - `device-app-update`, `device-app-desktop`, `device-app-install` (triggered by `tauri*.conf.json`, `linux.sh`,
     `windows.ps1`): the update pair, Desktop's install and the one-line Linux install still work with the unchanged
     identity and file names.
2. **Local gate on this Mac** ([What PR CI does not run](../validation-and-release.md#what-pr-ci-does-not-run),
   "Harness Device on macOS"): `cd device-app/ui && npm run build && cd ../src-tauri && cargo test --locked`.
   `macos.sh` and `appimage-starts.sh` are not run (the app is never run on this Mac; nothing here changes how an
   AppImage starts).
3. **macOS bundle, built, never run:**
   ```bash
   T=$(mktemp -d "$TMPDIR/hd-build.XXXX")
   cd device-app/src-tauri && CARGO_TARGET_DIR="$T" cargo tauri build --debug
   P="$T/debug/bundle/macos/Harness Device.app"
   for k in CFBundleName CFBundleDisplayName CFBundleIdentifier CFBundleExecutable; do
     /usr/libexec/PlistBuddy -c "Print :$k" "$P/Contents/Info.plist"; done
   /usr/libexec/PlistBuddy -c "Print :LSHasLocalizedDisplayName" "$P/Contents/Info.plist"   # must fail: no entry
   ls "$P/Contents/Resources"                                                               # no en.lproj
   codesign -d -r- "$P"
   ```
   Expected: `Harness Device`, `Harness Device`, `ai.autonomous.harness.device`, `harness-device`; no
   `LSHasLocalizedDisplayName`; no `en.lproj`; the requirement names `identifier "ai.autonomous.harness.device"` (an
   ad-hoc debug build shows no team; the PR body quotes it beside the installed 0.1.13's from the spec). The bundle is
   never opened, installed or copied to `/Applications`; delete `$T` after.
4. **Held for Diego after a Harness Device release (his own Mac and eye; merge does not wait):** after the update,
   Accessibility, Login Items and the About panel read Harness Device, his Accessibility switch is still on, the dial
   still follows ChatGPT.
5. **Windows check (Ken's side), optional, in the PR body:** with the PR's debug installer on the Windows ARM64 VM,
   the tray tooltip, the About dialog and Apps & features read Harness Device; the install folder and Start entry stay
   `Harness Device`.

No new workflow: every long check already has its PR CI job.
