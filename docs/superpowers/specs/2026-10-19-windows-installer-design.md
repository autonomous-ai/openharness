# Windows native: `harness-install.exe` and the Windows desktop release (sub-project F)

Date: 2026-10-19
Status: draft, for review

## Goal

A person on a Windows 10/11 PC opens the Harness website, presses **Download for Windows**, opens the file it
downloads, and gets the Harness desktop app installed and open. They never touch PowerShell.

- The installer is `harness-install.exe`: a small program that downloads this PC's current desktop zip, checks it,
  and hands it to the zip's own `Harness.exe --install`.
- Every desktop release ships Windows with macOS and Linux: one version, one manifest, one workflow.
- Everything is per user, with no administrator rights and no UAC prompt, as in C.

The build is **not code-signed**: there is no signing service. Windows shows its SmartScreen prompt once, when the
person opens the downloaded installer. Signing stays for later (D).

## Decomposition

| | Sub-project | Depends on |
|---|---|---|
| A | PTY host, terminal backend and Windows process control (done) | — |
| B | CLI on Windows (done; merge pending) | A |
| C | Desktop on Windows (in progress) | B |
| D | Code signing, winget (later; not in this PR) | A–C, F |
| E | The dial on Windows | B, C |
| **F** | `harness-install.exe`, Windows in the desktop release, the website's Windows download (this spec) | C |

F is built on `feat/windows-installer`, cut from `feat/windows-desktop` after C, and ships in the Windows PR with A, B and C. E (the dial) is built in parallel and ships later, in its own PR (owner's decision, 2026-10-20). It takes over two of the items
C left to D: the installer `.exe` and the production release of the Windows artifacts. D keeps signing and winget.

## Current state

- **Install.** `Harness.exe --install` (`pty/src/desktop/install.rs`, C §3.3) runs from an extracted zip and does
  every install step: it copies the app, creates the Start Menu shortcut, writes the `harness://` key and the
  uninstall entry, then opens the installed app. If that version is already installed, it just opens it. If the zip
  holds an older version, it says so. A different version that is running is asked to quit first.
- **Install by one command.** `install.ps1 -App` (`cli/scripts/install.ps1`, `Install-HarnessApp`, C §3.7):
  1. reads `desktop/metadata.json` under `$HarnessManifestBase`, the GCS origin
     `https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/`;
  2. picks this PC's entry (`Select-HarnessAppEntry`): x64 takes `desktop-windows-x64`; arm64 takes the newer of
     `desktop-windows-arm64` and `desktop-windows-x64`, with arm64 winning a tie;
  3. downloads into a temp folder and checks size and SHA-256 (`Save-HarnessVerified`);
  4. unpacks with `System32\tar.exe`;
  5. runs `Harness.exe --install`, waits for it, and removes the temp folder.

  Its tests are `cli/src/scripts/installPs1App.spec.ts`, run by `windows-desktop.yml` against the packaged zip.
- **Release.** Windows has only a staging path: `windows-desktop.yml`'s release mode builds both zips and
  `desktop/scripts/publish-desktop-windows-staging.sh` writes `desktop-windows-x64` and `desktop-windows-arm64` into
  the staging manifest. `release-desktop.yml` ships macOS and Linux:
  - `build-macos` and `build-linux` each upload their artifacts and write a scratch part under
    `harness/desktop/.ci/<run>/`;
  - `publish` merges the parts (`scripts/publish-desktop-manifest.py`, `PARTS`: four files, six keys);
  - it then downloads and checks every public artifact (`scripts/verify-desktop-release.py`, `KEYS`: six);
  - `--prepare` candidates and their reuse (`scripts/desktop-release-candidate.py`, `FILES`: six; `BUILD_INPUTS`)
    seal the same six.
- **Website.** `/desktop` on Windows says "There is no Windows version yet" (`website/src/app/desktop/DesktopDownload.tsx`).
  `DESKTOP_BUILDS` (`website/src/lib/desktopPlatform.ts`) lists macOS and two Linux builds. Each
  `/desktop/download/<build>` route 302s to the manifest's asset through `resolveDesktopDownload`
  (`website/src/lib/desktopManifest.ts`), which accepts only URLs under the bucket or the CDN's `harness/desktop/`.

## Decisions

1. **A bootstrapper, not an offline installer.** `harness-install.exe` is about 1 MB and carries no app. It reads the
   manifest when it runs, so any copy, however old, installs the current release, and no installer has to be built
   per architecture. The app needs the network on its first start anyway, to install the CLI (C §1.4).
2. **Its own crate, `installer/`**, in Rust, GUI subsystem. It is not a bin of `pty/`, which is the terminal host's
   crate, for the same reason `harness-serial` is its own crate (E). It does not link `harness-pty`: what it needs
   from C (version order, entry choice) is a few lines, kept in step with `install.ps1` by shared test vectors.
3. **No PowerShell.** An unsigned program that starts PowerShell to download and run something is a pattern
   antivirus heuristics flag. The installer downloads with WinINet itself and unpacks with Windows' `tar.exe`.
4. **One x64 build for every PC.** Windows 11 on Arm runs x64 programs under emulation, and the installer asks the
   OS for the real machine, so an arm64 PC still gets the arm64 app. Windows 10 on Arm cannot run x64 programs
   (Known limits).
5. **Windows joins `release-desktop.yml`.** Every `make release-desktop` publishes nine artifacts instead of six. A
   failed Windows build stops the release, as a failed macOS or Linux build does.

## 1. `harness-install.exe`

### 1.1 What it does

The window is titled **Install Harness**. It shows one line of status, a progress bar and **Cancel**:

1. **Check this PC.** Windows 10 1809 (build 17763) or later, which C's terminal host needs; `System32\tar.exe`
   present. Otherwise it says what is missing, as `install.ps1`'s `Test-HarnessHost` does.
2. **Read the manifest** (status "Checking for the latest Harness…"): `<base>desktop/metadata.json`.
   - The base is compiled in from the build-time variable `HARNESS_INSTALL_BASE`: production
     `https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/`, staging the same with `staging/` appended.
     These are `install.ps1`'s bases.
   - `HARNESS_INSTALL_MANIFEST` (a file path or an `https://` URL) replaces it, for tests: the name `install.ps1`
     already uses.
3. **Pick this PC's entry** exactly as `Select-HarnessAppEntry` does. The machine comes from `IsWow64Process2`
   (native machine); where that call does not exist, x64. An entry with a missing or ill-typed `version`, `url`,
   `sha256` or `size` is skipped, and the versions order by their three numeric parts.
4. **Check the URL.** It must start with one of:
   - `https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/`
   - `https://cdn.autonomous.ai/harness/desktop/`
   - the same two with `harness/staging/desktop/`, in a staging build only.

   This is `resolveDesktopDownload`'s rule. A local manifest (tests) may name a local file.
5. **Download** (status "Downloading Harness…", the bar shows bytes against the manifest's `size`).
   - WinINet with the preconfigured proxy (`INTERNET_OPEN_TYPE_PRECONFIG`), the person's own proxy settings, and
     Windows' TLS. A redirect from https to http fails.
   - Into `%TEMP%\.harness-desktop-staging-<pid>-<time>\harness-desktop.zip`, `install.ps1`'s own temp folder name.
     The program writes the bytes itself, so the file gets no `Zone.Identifier`: no file of the app is marked as
     downloaded, and SmartScreen does not ask again.
   - Thirty seconds with no byte received is a failure. A body larger than `size` is a failure at once, with no
     second try.
   - Three tries over the network, two seconds apart, as `install.ps1`'s Invoke-HarnessRetry gives them; the manifest
     read in step 2 gets the same. A local manifest's file is copied, once.
6. **Verify** size and SHA-256 against the manifest, with `install.ps1`'s messages: "… is N bytes, but the manifest
   says M: the download is incomplete, or is not the published file." and "… failed its checksum (expected …, got
   …): it is not the published file."
7. **Unpack** with `%SystemRoot%\System32\tar.exe -xf`, no window (`CREATE_NO_WINDOW`), into `…\zip\`. As in
   `install.ps1`'s Expand-HarnessZip, the archive is moved into that folder and `tar.exe` runs there on an ASCII name:
   `tar.exe` reads its arguments in the ANSI code page, and a profile path outside it reached it as `?`. The result
   must hold `Harness.exe`.
8. **Install** (status "Installing Harness…", Cancel disabled): run `zip\Harness.exe --install` with no shell
   (`CreateProcessW`), its folder as the working directory, and wait for it. Exit code 0 means installed and open.
9. **Clean up.** Remove the temp folder, then close. The opened app is Harness's own process, not a child the
   installer waits on.

### 1.2 Failure, cancel, a second copy

- **Failure.** The window shows "Harness could not be installed.", then, in a read-only box the person can copy from,
  the step that failed and the reason, with **Try again** (from step 1) and **Close**. A non-zero exit from `--install` names its log, as `install.ps1` does:
  `launch.log` in `%LOCALAPPDATA%\Programs\Harness`.
- **Log.** Each run rewrites `%TEMP%\harness-install.log`: the steps, the manifest source, the chosen key and
  version, and any error. No personal data beyond the profile's temp path.
- **Cancel** (the button, Esc or the close box) hides the window at once; the download stops at its next piece, the
  temp folder is removed and the program exits 2. A stalled connection takes up to its thirty seconds to notice. Cancel
  is disabled during step 8: `--install` stages and renames, and is not stopped halfway.
- **A second copy** (a double double-click) finds the named mutex `Local\HarnessInstall` taken, brings the first
  copy's window to the front, and exits 0. In quiet mode it exits 1 and says so in the log.
- **Temp folder left behind** (a file held open by antivirus): the window says so after success or failure, with the
  path, as `install.ps1` does.

### 1.3 Quiet mode

`harness-install.exe --quiet` shows no window and writes the same log. It exists so tests and scripted installs never
wait on a dialog. It sets `HARNESS_DESKTOP_NO_DIALOG` for `Harness.exe --install`, which would otherwise say a failure
in a message box. It is the only argument; anything else writes the usage to the log and exits 1.

Exit codes, in both modes: 0 installed (and opened), 1 failed, 2 cancelled (only the window has Cancel).

### 1.4 The executable

- A resource script, built by `installer/build.rs` with `embed-resource`, embeds:
  - an application manifest: `requestedExecutionLevel level="asInvoker"`, so Windows never prompts for elevation.
    Windows' installer detection would otherwise treat a program named `*install*` as needing administrator rights;
  - Common Controls v6 (themed progress bar and buttons) and per-monitor DPI awareness;
  - the icon, `desktop/windows/runner/resources/app_icon.ico` (the one `package-windows.ps1` ships as `Harness.ico`);
  - a version resource: `FileDescription` "Install Harness", `ProductName` Harness, `CompanyName` Autonomous,
    `FileVersion`/`ProductVersion` the desktop version (`HARNESS_INSTALL_VERSION` at build time).
- Built for `x86_64-pc-windows-msvc`, release, with the static CRT (`+crt-static`), so it needs no Visual C++
  runtime.
- The code splits as E's `harness-serial` does:
  - a pure module (manifest parsing, entry choice, version order, URL rule, size and hash checks, the step
    machine), testable on any OS;
  - `windows.rs`: WinINet, `IsWow64Process2`, `tar.exe`, `CreateProcessW`, the mutex and the window.

### 1.5 The window

One plain Win32 window, not a TaskDialog, so the progress bar, Cancel and the failure state live in one place:

- a status line, a `PROGRESS_CLASS` bar, a read-only detail box (the failure), and one or two buttons;
- `SS_NOPREFIX` on the text, so a path with `&` is text and not an accelerator;
- the work runs on a worker thread and posts its progress to the window;
- closing the window is Cancel.

## 2. Release

### 2.1 Artifacts

Three new production artifacts, under `harness/desktop/<ver>/` with the others:

| Manifest key | File | Built on |
|---|---|---|
| `desktop-windows-x64` | `Harness-windows-x64.zip` | `windows-latest` |
| `desktop-windows-arm64` | `Harness-windows-arm64.zip` | `windows-11-arm` |
| `desktop-windows-installer` | `harness-install.exe` | `windows-latest`, the x64 job |

Each entry has `version`, `url`, `sha256` and `size`, as the others do. The Windows updater (C §3.4) and
`install.ps1 -App` already read the two zip keys. Only the website and the installer read
`desktop-windows-installer`.

### 2.2 `release-desktop.yml`

- **`build-windows`** (matrix x64 on `windows-latest`, arm64 on `windows-11-arm`; needs `version` and `preflight`;
  skipped when a candidate is reused, like the others):
  1. build `harness-desktop-launcher`;
  2. `flutter build windows --release --build-name $VERSION --build-number <run number>`, production (no
     `HARNESS_STAGING`);
  3. `desktop/scripts/package-windows.ps1`, then rename the zip to `Harness-windows-<arch>.zip`;
  4. x64 only: build `harness-install.exe` with `HARNESS_INSTALL_BASE` production and `HARNESS_INSTALL_VERSION`
     `$VERSION`;
  5. upload them as Actions artifacts.

  It uses the same `FLUTTER_VERSION` pin and the Windows Flutter setup `windows-desktop.yml` uses. Like the other
  release builds, it builds and runs no test suite.
- **`upload-windows`** (ubuntu; needs `build-windows`): downloads the artifacts, uploads them to
  `${artifact_prefix}/`, and writes two scratch parts:
  - `windows-x64.json`: `desktop-windows-x64` and `desktop-windows-installer`;
  - `windows-arm64.json`: `desktop-windows-arm64`.

  It uses the same upload helper conventions as `upload-desktop-linux.sh`: create the object only when absent, read it
  back, and write CDN URLs (or the GCS origin for candidates and checks, from `artifact_base_url`). Uploading from
  ubuntu keeps gcloud off the Windows runners, as `windows-desktop.yml` already does for staging.
- **`publish`**, **`candidate`** and **`cleanup`** add `upload-windows` to `needs`, with the same result conditions as
  `build-linux`.
- **Release notes**: the Downloads table gains Windows (installer), Windows x64 (zip) and Windows arm64 (zip).
- The workflow's header comment lists the new keys.

### 2.3 The release scripts

- `scripts/publish-desktop-manifest.py`: `PARTS` gains `windows-x64.json` and `windows-arm64.json` (six files, nine
  keys); its messages stop saying "four" and "six".
- `scripts/verify-desktop-release.py`: `KEYS` gains the three keys; it checks nine downloads.
- `scripts/desktop-release-candidate.py`:
  - `FILES` gains `Harness-windows-x64.zip`, `Harness-windows-arm64.zip` and `harness-install.exe`;
  - `BUILD_INPUTS` gains `installer` and `pty`, `term` and `tui/vendor` (the launcher's crate and the crates it builds
    from), so a candidate is not reused across a launcher or installer change;
  - its messages stop saying "six".
- Their tests (`scripts/tests/`, the publication fixture `scripts/tests/desktop_publication_fixture.py`,
  `scripts/check-desktop-publication-gcs.py`, `scripts/check-desktop-candidate-gcs.py`) move to nine, and the
  immutable-upload checks cover `upload-desktop-windows.sh`'s call too.
- `desktop/scripts/upload-desktop-windows.sh` (new) is `upload-windows`'s step. `desktop/scripts/check-windows-zip.py`
  (new) is the zip-shape check, moved out of `publish-desktop-windows-staging.sh` so both refuse the same zips.
- `desktop/scripts/release-desktop.sh` and `desktop/RELEASE.md` say a release ships Windows, and RELEASE.md's
  Windows section gains production next to staging.

### 2.4 Staging

`windows-desktop.yml`'s release mode builds `harness-install.exe` with the staging base in its x64 job, and
`publish-desktop-windows-staging.sh` uploads it and writes `desktop-windows-installer` into the staging manifest,
under the same rules as the zips. A staging publish still needs the owner's OK.

### 2.5 Once, after the merge

`bash cli/scripts/upload-install-ps1.sh --app --production` publishes `harness/desktop/install.ps1`, the PowerShell
alternative the website names. It goes after the first release that carries the Windows keys.

## 3. Website

- `website/src/lib/desktopPlatform.ts`:
  - `DesktopBuildId` gains `windows`;
  - `DESKTOP_BUILD.windows` is `{ name: "Windows", detail: "x64 and ARM", href: DESKTOP_DOWNLOAD_WINDOWS_URL }`;
  - `DESKTOP_BUILDS` lists it after the two Linux builds;
  - `VisitorPlatform`'s `windows` is now a build that suits the computer, and its doc comment says so.
- `website/src/lib/installCommand.ts`: `DESKTOP_DOWNLOAD_WINDOWS_URL = "/desktop/download/windows"`, and
  `DESKTOP_WINDOWS_INSTALL_COMMAND` for the PowerShell line.
- `website/src/app/desktop/download/windows/route.ts`: `resolveDesktopDownload("desktop-windows-installer", ".exe")`,
  with a `route.spec.ts` like the Linux ones.
- `DesktopDownload.tsx`, on Windows:
  - the button **Download for Windows**;
  - description: "Download the installer and open it. It sets up Harness and opens the app.";
  - note: "Harness for Windows isn't code-signed yet, so Windows may say it protected your PC. Choose More info,
    then Run anyway. Prefer PowerShell? Run `irm https://cdn.autonomous.ai/harness/desktop/install.ps1 | iex`.
    Requires Windows 10 or 11.";
  - other downloads: the macOS and Linux builds.
- Every other place that says the app runs on "macOS and Linux" or "a Mac or a Linux computer" names Windows too:
  the mobile description in `DesktopDownload.tsx`, and any page copy a `grep` of `website/src` for those phrases finds.
- Specs: `desktopPlatform` (Windows is a build; the Mac and Linux pages list it), the `/desktop` page on Windows, and
  the `/download` page's list.

**Order after the merge:** the CLI side first, then `make release-desktop`, the first with Windows, then §2.5, then the
website release, as `desktop/RELEASE.md` ("First production release") lists step by step.

The Windows route answers 503 until the manifest has the key, so the website goes last.

## 4. Testing

### 4.1 Any OS

`cargo test` in `installer/` covers the pure module:

- entry choice for x64 and arm64, including ties, missing or ill-typed fields, and a prerelease;
- version order;
- the URL rule, for production and staging builds;
- size and hash checks;
- the step machine's transitions: cancel, try again, a failure at each step.

The entry-choice vectors are one JSON file, `installer/tests/entry-vectors.json`, which
`cli/src/scripts/installPs1App.spec.ts` also runs against `Select-HarnessAppEntry`, so the two installers cannot
drift.

### 4.2 Windows CI (`windows-desktop.yml`, x64 and arm64)

- `cargo test` for `installer/`, including its Windows tests:
  - `IsWow64Process2` answers the runner's own machine;
  - the WinINet download of a small public object (the production `desktop/metadata.json`) succeeds, is JSON, and has
    no `Zone.Identifier`; a missing object fails with its HTTP status. A local manifest's file is copied, not
    downloaded, so these are the cases that run WinINet on CI;
  - the mutex.
- After C4.7's package smoke builds the zip: run `harness-install.exe --quiet` with `HARNESS_INSTALL_MANIFEST` naming
  a local manifest for that zip. Then check what `installPs1App.spec.ts` checks after `install.ps1 -App`: the install
  folder, the shortcut, the `harness://` key and the uninstall entry. The same spec file gains these cases, so both
  installers are held to one set of expectations. It also checks that the exit code is 1 and the log names the step
  for a zip whose hash does not match.
- The executable's resources: `asInvoker`, the version strings and the icon, read back from the built file.

### 4.3 Before the merge: one release candidate

With the owner's OK, run `make release-desktop ARGS="--prepare"` from `feat/windows-desktop` once. It builds all
nine artifacts and seals them without publishing, which proves the new jobs, parts and nine-way verification end to
end. Also, with the owner's OK, run the workflow's `test_publication` mode once, against its disposable prefix.

### 4.4 End to end on the Windows PCs

On the x64 test PC, as a new local Windows user the owner signs in at the screen, with a staging build (published
with the owner's OK):

| # | Scenario | Expected |
|---|---|---|
| 1 | Download the installer **with Edge** from the staging link, and open it | SmartScreen asks once (More info ▸ Run anyway). No UAC. The window shows progress and the app opens. No file under `Programs\Harness` has a `Zone.Identifier`. |
| 2 | Open the installer again, same version installed | The installed app opens; nothing is reinstalled. |
| 3 | Cancel during the download | Nothing is installed; the temp folder is gone. |
| 4 | A local manifest whose zip hash is wrong | The failure window names the step; the log has it; Try again repeats it. |
| 5 | An older version installed and running, then the installer for a newer one (CI zip, local manifest) | The old app quits, the new one is installed and opens. |
| 6 | Settings ▸ Apps ▸ Harness ▸ Uninstall | C's uninstall; the installer left nothing else behind. |
| 7 | `MpCmdRun -Scan -ScanType 3 -File harness-install.exe` | Recorded. If Defender flags it, RELEASE.md's note on submitting a file to Microsoft applies. |

On the Windows 11 ARM64 VM, with C's test user and never `C:\work\e2e` or the admin profile: `harness-install.exe
--quiet` with `HARNESS_INSTALL_MANIFEST` naming the staging manifest. It runs under x64 emulation and installs the
**arm64** zip: the installed `harness-desktop.exe` is an ARM64 image.

Evidence goes in F's E2E doc, as C's and E's do, with no addresses, account names or serials.

## Release

F ships in the Windows PR (A + B + C + F); E follows in its own PR. After the merge, asking the owner before each step: §3's order, then
`curl -sI https://harness.autonomous.ai/desktop/download/windows` shows a 302 to the CDN's `harness-install.exe`.

## Out of scope

- Code signing, SmartScreen reputation, winget (D).
- An offline installer, a per-machine (all users) install, a choice of install folder.
- Detecting Windows 10 on Arm on the website to send it to PowerShell.
- The CLI: the app installs it on first start (C §1.4), and `install.ps1` remains the CLI's own installer.

## Known limits

- **SmartScreen**, once: "Windows protected your PC" until the person chooses More info ▸ Run anyway. Edge or Chrome
  may also say the file "isn't commonly downloaded". The website's note says what to do.
- **Smart App Control**, where it is on, blocks the unsigned installer and the unsigned app, with no way to run them.
- **Windows 10 on Arm** cannot run the x64 installer. The PowerShell line works there.
- **A quiet install leaves `HARNESS_DESKTOP_NO_DIALOG` in the app's environment.** `--quiet` sets it so
  `Harness.exe --install` never waits on a message box, and the app it opens inherits it; a later `Harness.exe` the
  app starts then says its failures in `launch.log` only. Only quiet (scripted, test) installs. The fix belongs in C's
  launcher, which would drop the variable before it starts the app.
- **Antivirus heuristics** may flag an unsigned program that downloads and runs another. Mitigations: no PowerShell,
  a full version resource, a fixed download source checked against the manifest. The E2E scan records the result.

## Risks

- **The release grows by two Windows runners.** A Windows failure now stops a macOS or Linux release (Decision 5).
  The candidate (§4.3) proves the jobs before the first real release.
- **The two installers drift.** Mitigations: one set of entry-choice vectors, one spec file for what an install
  leaves behind.
- **WinINet behind unusual proxies.** It uses the person's settings, as Edge and PowerShell 5.1 do; a failure says
  "Downloading Harness" and why, and the PowerShell line is the fallback.
