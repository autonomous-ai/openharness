# Harness Device no longer follows the ChatGPT app

Date: 2026-11-26. Decision: Diego, through the PM: "drop Follow ChatGPT at install; treat choosing a pane from
ChatGPT as not supported yet, and change the device to match." PM's choice B: off on every OS.

## Goal

Harness Device stops following the ChatGPT app's window on macOS, Windows and Linux:
- no Follow ChatGPT screen at the first launch;
- no Accessibility request;
- no window title sent to the CLI.

The dial no longer moves to the ChatGPT thread in front. Release 0.1.15 carries this.

## What goes (device-app only, this PR)

- **Screen and state.**
  - The Follow ChatGPT screen goes: `Screen::Follow`, its UI in `ui/src` (`api.ts`, `screens.ts`, `main.ts`), the
    gallery entry and its tests.
  - `Action::Allow`, `Effect::AskAx`, `Effect::OpenAxSettings`, `AX_SETTINGS`, `Event::Follow`, `FollowState` and the
    `chatgpt:` log lines go.
  - The saved `asked_follow` and `asked_ax` go. An older `state.json` still loads: serde ignores the unknown keys; a
    state test proves it.
- **The follow doors.**
  - `follow.rs`, `follow_macos.rs`, `follow_windows.rs`, `follow_x11.rs`, `follow_sway.rs` and `follow_hyprland.rs` go,
    with their wiring in `runner.rs`, `main.rs`, `lib.rs` and `tabs.rs`.
  - What other features still use is kept, and the plan names it per file. That covers the app in front (`front*.rs`)
    and terminal tabs (`tabs*.rs`), which use NSWorkspace and Apple Events, not Accessibility.
  - After this, macOS asks for no Accessibility at all: nothing else uses it.
- **What only follow needed.**
  - Dependencies: `objc2-application-services`, `objc2-core-foundation` (a direct dependency only of `follow_macos`)
    and the `Win32_Storage_Packaging_Appx` feature go. `Cargo.lock` is regenerated with `cargo check`, never
    `cargo update`.
  - Visibility: the `front_x11`, `front_sway` and `front_hyprland` helpers that were opened up only for the doors go
    back to private.
  - UI: the `focused` rule in `screens.ts` existed only for Follow's `Not now`, so it goes.
- **Docs and tests.**
  - `device-app/AGENTS.md`: the intro ("three screens", the ChatGPT sentence), the follow rules, the Accessibility
    command line and the ChatGPT paragraphs go.
  - `device-app/RELEASE.md` (the screen's mention).
  - The design doc `desktop/design/desktop-design-system.md`: its Harness Device section's Follow screen, focus rule
    and "asks once" rule go, and the gallery changes in the same PR.
  - `parity.rs`: the follow cases go.
  - The e2e scripts: `linux.sh` and `windows.ps1` have no follow checks. `macos.sh` drops the `askedFollow` key it
    seeds in `state.json`; `state.rs`'s test is the proof that an old key loads.

## What stays

- The app in front, terminal tabs, Orca and the rest of the watch's lines. The bundle id and install paths.
- The CLI. It still accepts a `{"thread"}` line on `harness device watch` stdin, but from this release no client sends
  one. Removing the CLI side is a follow-up PR (cli component): `devices/client.ts`, `services/devicesListener.ts`'s
  `threadHandler`, `services/devices.ts`'s `threadReported` and `cable/hosts/threadTitle.ts`, plus the dial eval's
  ChatGPT focus checks. It goes in its own PR because:
  - it is another component, released on its own;
  - an older Harness Device (0.1.14 and before) still sends the line until it updates, and the CLI must keep
    accepting it in the meantime without error.

## Tests

Red first, where a test can fail before the change:
- `state.rs`: a `state.json` with `askedFollow`/`askedAx` loads, and its next save has neither key.
- `parity.rs`: no screen and no menu item follows ChatGPT on any door, so a fresh first run shows nothing after Sign in.
  This is written against the old types before they go: it fails while Follow is due on a Mac without the
  permission.

The rest is deletion, which the compiler holds once the types are gone (`Effect::AskAx`, `Screen::Follow`). The tests
that covered the deleted code go with it.

PR CI runs `cargo test` (Linux and Windows) and the e2e scripts on Linux and Windows. The required local gate is
`cargo test --locked` in `device-app/src-tauri` on a Mac (needs the PM's slot). `macos.sh` is a by-hand gate for
changes to install, start and the app in front; it runs only if the plan's changes touch those.

## Platforms

macOS, Windows and Linux: following ChatGPT goes on all three. macOS also loses the first-run screen and the
Accessibility request.
