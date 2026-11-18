# Harness Device (device-app)

A menu-bar app for the round dial, for people who do not use the Harness desktop app. People see it as **Harness**:
only its file stays `Harness Device.app` (`productName`), beside the desktop app's `Harness.app`, and the bundle id,
binary, release files and update path keep the Harness Device name, so installed apps keep updating. It installs the
`harness` CLI, keeps the daemon running, shows the dial's state in its menu, and offers sign-in once. While Orca runs
without Harness's plugin, it offers `Connect Orca…` once. It also exports the logs (`Export logs`), through the CLI. It
has no row for Claude Code or Codex: the devices service sets them up. Rust and Tauri 2 in `src-tauri/`; the window's
three screens are plain TypeScript in `ui/`.

## Toolchain

- Rust stable, 1.95 or newer (`rust-version` in `src-tauri/Cargo.toml`): `rustup update stable`. The repo pins no
  toolchain; CI uses `dtolnay/rust-toolchain@stable`.
- The Tauri CLI 2.12.4, to build and run the app: `cargo install tauri-cli --version 2.12.4 --locked`. PR CI does not
  use it; the release pins that version (`scripts/release-setup.sh`).
- macOS 13 or later (`SMAppService`). Linux builds need webkit2gtk 4.1, appindicator and rsvg.
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
- `python3 -m unittest discover -s scripts -p 'test_*.py'`: the release rules. How a release is cut:
  [RELEASE.md](RELEASE.md).

## Rules a change keeps

- **Thin over the CLI.** The app owns no daemon logic: it runs the `harness` CLI and reads its NDJSON. It also
  fetches its own update manifest (`update.rs`), with nothing from the webview in the request.
- **Fixed arguments.** The app runs only the CLI it found, the two install lines and `open`, each with arguments
  fixed in Rust; `logs export --json`, `device orca status --json` and `device orca connect --json` are among them.
  Nothing from the webview becomes a command line: it sends one of five action names (`retry`, `sign_in`, `later`,
  `cancel`, `connect_orca`). Two arguments are not fixed text. `open -R` takes the zip the CLI's answer names, kept
  only when it is an absolute path whose file name is `harness-logs-YYYYMMDD-HHMM.zip` (`logs.rs`); on Linux
  `xdg-open` takes that zip's folder. The fingerprint after `--approve` is the CLI's own answer, held to
  `^ap1-[0-9a-f]{32}$` in Rust, never anything from the webview, and the log's name of the run leaves it out. It
  relaunches itself through Tauri's restart (`open -n` on its own bundle), and the updater plugin runs `touch` on the
  bundle after the swap (the `touch` found on the person's PATH); nothing from the webview or the manifest is in
  either.
- **The app in front is private.** It is written to the watch's stdin and nowhere else (`front.rs`), and never logged.
- **Fixed scripts.** Every AppleScript is fixed text in `tabs_macos.rs`, for an app from its own list of three. A tty
  passes the tty check and reaches a script only as a handler parameter, never in its text.
- **A tab's tty is private.** It is written to the watch's stdin and nowhere else. A `tabs:` log line names Terminal,
  iTerm2 or Ghostty, never a tty.
- **One entitlement.** `src-tauri/Entitlements.plist` holds `com.apple.security.automation.apple-events` and no other
  key: without it a build signed with the hardened runtime sends no Apple Event.
- **One plugin.** `tauri-plugin-updater`, called from Rust only; the capability gives the webview none of it.
- **One log, redacted.** Every line passes `log::redact`; no email, token, URL query or path of the person's. An
  install logs its step lines (`▸`, `✓`, `✗`, at most 200 a run, each redacted, then cut to 512 characters), each
  run's result and, after a failure, the lines the screen shows; never the rest of what a run prints (`install.rs`).
  An export logs `logs: exported` or `logs: export failed:` and a fixed reason, and the menu's line as `Saved`; never
  the zip's path. Nothing Orca lists is logged (no grant, name or fingerprint): only `orca: <state>` and
  `orca connect: <answer>`.
- **No other component's path in a string.** `scripts/ci-plan.py` reads a quoted path of another component as a
  read of that folder: join path segments one by one, and name other components only in comments.
- **`HARNESS_DEVICE_CLI`** (the fake CLI for tests) is read by debug builds only.

PR CI compiles and tests the app on Linux only; macOS is built and tested by hand, and released by
`make release-device`.
