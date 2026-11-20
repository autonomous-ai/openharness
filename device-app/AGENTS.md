# Harness Device (device-app)

A menu-bar and tray app for the round dial, for people who do not use the Harness desktop app, on macOS, Windows and
Linux. People see it as **Harness**: only its installed name stays `Harness Device` (`productName`: `Harness
Device.app` beside the desktop app's `Harness.app`, the `Harness Device` folder, Start menu entry and Run value on
Windows, where the desktop app owns `Harness`), and the bundle id, binary, release files and update path keep the
Harness Device name, so installed apps keep updating. It installs the `harness` CLI, keeps the daemon running, shows
the dial's state in its menu, and offers sign-in once and, on a Mac with the ChatGPT app, Follow ChatGPT. It also
exports the logs (`Export logs`), through the CLI. It has no row for Claude Code, Codex or Orca: the devices service
sets them up. Rust and Tauri 2 in `src-tauri/`; the window's three screens are plain TypeScript in `ui/`.

## Toolchain

- Rust stable, 1.95 or newer (`rust-version` in `src-tauri/Cargo.toml`): `rustup update stable`. The repo pins no
  toolchain; CI uses `dtolnay/rust-toolchain@stable`.
- The Tauri CLI 2.12.4, to build and run the app: `cargo install tauri-cli --version 2.12.4 --locked`. PR CI does not
  use it; the release pins that version (`scripts/release-setup.sh`).
- It runs on macOS 13 or later (`SMAppService`), Windows 10 or 11 (x64 and arm64, an NSIS installer per user) and Linux
  (x64 and arm64, an AppImage). Linux builds need webkit2gtk 4.1, appindicator, rsvg and libxdo.
- Tauri's dependencies take minutes to compile: one `CARGO_TARGET_DIR` outside the repository compiles them once.

## Commands

- `cd src-tauri && cargo test --lib`: every rule. It needs no `ui/dist`.
- `cd ui && npm run build` first, before `cargo test` or `cargo build`: the binary embeds `ui/dist`.
- `cd ui && npm test` and `npm run typecheck`: the window.
- `cd src-tauri && cargo tauri build --debug`: the app bundle. A local build is version 0.0.0 and never checks for
  updates: only a build the release stamped with its version updates itself.
- `cd ui && npm run gallery`: every screen in every state, both themes (`ui/gallery.html`).
- `cd src-tauri && cargo test --locked --lib -- --ignored scratch_terminal_windows`, on a Mac, run from another
  terminal app than Terminal, with Terminal running and another app in front: the Terminal scripts against two Terminal
  windows the test opens and closes. macOS may first ask to let that terminal app control Terminal.
- On Windows, `cd src-tauri && cargo test --locked --lib`: the rules, as PR CI's Windows leg runs them.
- Linux-only code (`#[cfg(target_os = "linux")]`) from a Mac: a container of `rust:1-bookworm` plus
  `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev`, the repository mounted and
  `CARGO_TARGET_DIR` on a volume. Most Linux rules compile under `cfg(all(test, unix))`, so a Mac runs them too.
- End to end, against the fake CLI (`src-tauri/tests/fake-harness`), each printing `ok:` per check:
  `scripts/e2e/macos.sh`, `scripts/e2e/windows.ps1 -Installer <debug installer>` and
  `scripts/e2e/linux.sh <AppImage>` (a fake tray host, X11, sway and a scripted Hyprland). `scripts/e2e/update-pair.sh`
  builds 0.0.1 and 0.0.2 for each driver's update check (`macos.sh --update`, and the same in the other two).
- `python3 -m unittest discover -s scripts -p 'test_*.py'`: the release rules. How a release is cut:
  [RELEASE.md](RELEASE.md).

## Rules a change keeps

- **Thin over the CLI.** The app owns no daemon logic: it runs the `harness` CLI and reads its NDJSON. It also
  fetches its own update manifest (`update.rs`), with nothing from the webview in the request.
- **Fixed arguments.** The app runs only what is listed here, each with arguments fixed in Rust. Nothing from the
  webview becomes a command line: it sends one of five action names (`retry`, `sign_in`, `later`, `cancel`,
  `allow`).
  - The CLI it found; `logs export --json` is among its commands.
  - The two install lines, `install.sh --host` and `--desktop`, through `/bin/sh -c` (`install.rs`). On Linux the
    `--host` line runs in a terminal the person sees, so `sudo` can ask for a password: the first of
    `x-terminal-emulator -e`, `gnome-terminal --` and `xterm -e` that is there, given `/bin/sh` and the path of
    `host-<n>.sh`, a fixed script around that line that writes its exit code to `host-<n>.exit` and that it started to
    `host-<n>.started` (`terminal.rs`), in `<data>/setup` (0700, emptied at each run). A terminal that never runs it
    fails within 30 s; with no terminal the line runs behind the screen, as on macOS.
  - On Windows, `powershell.exe` from `System32`, with `-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`
    and the fixed line that runs `install.ps1 -Desktop` (`install.rs`).
  - To open a page: `/usr/bin/open` on macOS, `xdg-open` on Linux, and Windows' shell `open` on an `https:` URL with
    no quote, space or control character (`open.rs`).
  - On macOS, System Settings' Accessibility list:
    `open x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`.
  - To show the logs' zip: `open -R` on macOS, `explorer.exe /select,"<zip>"` on Windows, `xdg-open` with the zip's
    folder on Linux.
  - To open the desktop app: `open -b ai.autonomous.harness` on macOS; elsewhere its own file, run with no argument
    (`Harness\Harness.exe` in the shell's user programs folder, `FOLDERID_UserProgramFiles`, else in
    `%LOCALAPPDATA%\Programs`; or the AppImage its `harness.desktop` entry names).
  - Tauri's restart to relaunch itself (`open -n` on its own bundle on macOS), and the updater plugin's `touch` on the
    bundle after the swap (the `touch` found on the person's PATH) and its installer on Windows.

  One argument is not fixed text: the zip the CLI's answer names, kept only when it is an absolute path whose file
  name is `harness-logs-YYYYMMDD-HHMM.zip` (`logs.rs`). Nothing from the webview or the manifest reaches any of them.
  On Linux the app also writes an `Exec=` line into the login entry `harnessd.desktop`, fixed text around the
  AppImage's and the launcher's paths, each in single quotes inside its `sh -c` text, so systemd's autostart
  generator, which escapes `$`, reads it as GLib does; a path holding `'`, `"`, `$`, a backtick, a backslash or a
  control character gets no entry (`loginitem_linux.rs`). The desktop session runs it, never the app.
- **Children start clean.** On Windows every child runs with no console, in a job of its own that the daemon leaves:
  the job ends what a child left behind when the child ends, and every child with the app. Its stdin sits behind a
  queue that never blocks the app (`child_windows.rs`, `stdin_queue.rs`). On Linux every child gets the person's
  environment back, without what the AppImage added (`appimage_env.rs`).
- **The app in front is private.** It is written to the watch's stdin and nowhere else (`front.rs`), and never logged.
  Its sources: AppKit on macOS, a WinEvent hook on Windows, and on Linux X11, sway or Hyprland, whichever the session
  is; GNOME and KDE on Wayland give it to no other program, so there it is not followed.
  The one Event derived from it is the offer cue, `Event::FollowOffer`: valueless, never logged.
- **The ChatGPT window's title is private as a tty.** It is written to the watch's stdin and nowhere else
  (`follow.rs`). A `chatgpt:` log line is fixed words, never a title.
- **What Accessibility reads.** Only ChatGPT's focused window's `AXTitle`, and only while ChatGPT is in front, a watch
  runs, the dial is attached and Harness is trusted. It sets nothing and performs no action; `follow.rs`'s test holds
  `follow_macos.rs` to it.
- **Fixed scripts.** Every AppleScript is fixed text in `tabs_macos.rs`, for an app from its own list of three. A tty
  passes the tty check and reaches a script only as a handler parameter, never in its text.
- **A tab's tty is private.** It is written to the watch's stdin and nowhere else. A `tabs:` log line names Terminal,
  iTerm2 or Ghostty, never a tty.
- **One entitlement.** `src-tauri/Entitlements.plist` holds `com.apple.security.automation.apple-events` and no other
  key: without it a build signed with the hardened runtime sends no Apple Event. Accessibility needs none.
- **One plugin.** `tauri-plugin-updater`, called from Rust only; the capability gives the webview none of it.
- **One log, redacted.** Every line passes `log::redact`; no email, token, URL query or path of the person's. An
  install logs its step lines (`▸`, `✓`, `✗`, on Windows install.ps1's own; at most 200 a run, each redacted, then
  cut to 512 characters), each run's result and, after a failure, the lines the screen shows; never the rest of what
  a run prints (`install.rs`). A Linux terminal run logs only its exit code: its lines are the person's.
  An export logs `logs: exported` or `logs: export failed:` and a fixed reason, and the menu's line as `Saved`; never
  the zip's path.
- **No other component's path in a string.** `scripts/ci-plan.py` reads a quoted path of another component as a
  read of that folder: join path segments one by one, and name other components only in comments.
- **`HARNESS_DEVICE_CLI`** (the fake CLI for tests) is read by debug builds only.

PR CI compiles and tests the app on Linux and Windows (`device-app-checks`); macOS is built and tested by hand. All
three are released by `make release-device`.
