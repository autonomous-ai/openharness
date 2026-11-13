# Harness Device

A menu-bar app for the round dial, for people who do not use the Harness desktop app. It installs the `harness` CLI,
keeps the daemon running, shows the dial's state in its menu, and offers sign-in and Claude Code once. Rust and Tauri 2
in `src-tauri/`; the window's three screens are plain TypeScript in `ui/`.

## Toolchain

- Rust stable, 1.77 or newer (Tauri 2): `rustup update stable`. The repo pins no toolchain; CI uses
  `dtolnay/rust-toolchain@stable`.
- The Tauri CLI, to build and run the app (CI does not use it): `cargo install tauri-cli --version "^2" --locked`.
- macOS 13 or later (`SMAppService`). Linux builds need webkit2gtk 4.1, appindicator and rsvg.
- Tauri's dependencies take minutes to compile: one `CARGO_TARGET_DIR` outside the repository compiles them once.

## Commands

- `cd src-tauri && cargo test --lib`: every rule. It needs no `ui/dist`.
- `cd ui && npm run build` first, before `cargo test` or `cargo build`: the binary embeds `ui/dist`.
- `cd ui && npm test` and `npm run typecheck`: the window.
- `cd src-tauri && cargo tauri build --debug`: the app bundle.
- `cd ui && npm run gallery`: every screen in every state, both themes (`ui/gallery.html`).

## Rules a change keeps

- **Thin over the CLI.** The app owns no daemon logic: it runs the `harness` CLI and reads its NDJSON.
- **Fixed arguments.** The app runs only the CLI it found, the two install lines and `open`, each with arguments
  fixed in Rust. Nothing from the webview becomes a command line: it sends one of six action names.
- **One log, redacted.** Every line passes `log::redact`; no email, token, URL query or path of the person's.
- **No other component's path in a string.** `scripts/ci-plan.py` reads a quoted path of another component as a
  read of that folder: join path segments one by one, and name other components only in comments.
- **`HARNESS_DEVICE_CLI`** (the fake CLI for tests) is read by debug builds only.

PR CI compiles and tests the app on Linux only; macOS is built and tested by hand.
