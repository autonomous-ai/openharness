# Harness for iOS and Android

A viewer onto the machines this device has linked — one harness at a time, on a phone.

Start with the [mobile team handoff](../docs/research/2026-09-28-phone-overnight.md)
for recent changes, the code map, validation and outstanding product decisions.

```bash
flutter pub get
flutter analyze          # 0 issues outside third_party/xterm
env -u TMUX flutter test
flutter run              # -d <your device>
flutter build ios --debug --no-codesign
flutter build apk --debug
```

## Standalone runtime, monorepo tests

`harness_mobile` is standalone. It used to be a thin shell over `path: ../desktop`, which meant every
desktop-only concern was a phone concern too: the app pulled in `window_manager`, `file_selector`,
`desktop_drop`, `sqlite3` and `go_router`, and the phone build was pinned to a Flutter app whose
targets are macOS and Linux.

Run the full tests from `mobile/` inside this repository: encryption protocol checks read CLI
source, and the branch-history UI tests use a desktop font fixture. Automated app interaction
uses only the offline sample and simulator; tests must not contact real accounts or daemons.

The app it runs now lives under `lib/`, in the same folders the desktop app uses for it:

| | |
|---|---|
| `lib/core/` | models, config, platform, file store, crash log |
| `lib/state/` | `AppNotifier` — machines, agents, connections, panes, the account's desk |
| `lib/api/`, `lib/ws/` | REST to the backend, and the relay socket per machine |
| `lib/auth/`, `lib/viewer/` | SSO, device linking, and the viewer's stand-ins for the harness CLI |
| `lib/e2ee/` | the end-to-end encryption this app terminates itself |
| `lib/terminal/`, `lib/widgets/` | the xterm session, the terminal panel and its chrome |
| `lib/shared/`, `lib/logging/` | design system, file logs |
| `third_party/xterm/` | the vendored, patched xterm 4.0.0 (see its `README.autonomous.md`) |

Two folders are this package's own, and have no counterpart on the desktop:

- **`lib/phone/`** — Focus, Find, New, voice input, approvals, onboarding and settings. `PhoneShell`
  owns one navigation stack rooted in `AgentHome`, with the full-screen terminal in `TerminalPage`.
- **`lib/p2p/`** — the phone's second wire to each machine. The `terminal-v1` WebRTC data channel the
  harness CLI opens with werift on the desktop's behalf, so a terminal rides p2p or TURN when it can
  and the relay only when it must.

`lib/demo/` provides the offline sample runtime. `test/render/` captures the phone screens;
`integration_test/tour_test.dart` opens `SampleApp` directly for the simulator walkthrough.

## The account’s swarms are the desk’s, here too

The account’s swarms are stored on the backend (`/api/desk`). `lib/state/desk_sync.dart` models
that shared document; `lib/state/phone_desk.dart` handles the phone's reads and explicit writes.
The phone's `swarms` are temporary terminal containers for the pager, not a projection of the
account’s swarms. Swiping must never rewrite the shared desk.

The phone follows desk updates over machine relay sockets and polls every 15 seconds in the
foreground. Creating or deleting a harness updates its desk membership; explicit swarm operations
also live in `PhoneDesk`. The current swarm and position remain device-local. `lib/phone/desk_groups.dart`
resolves the swarm’s harnesses for navigation.

## It is a VIEWER build, always

No harness CLI runs beside this app and no agent is ever hosted here. It holds its own SSO session and
terminates the E2EE to each machine itself (`lib/viewer/`, `lib/e2ee/`) — where the desktop hands both
to the CLI on its own computer. `kViewerMode` (`lib/core/viewer_mode.dart`) is true on iOS and Android
unconditionally, so `AppNotifier` always has its `ViewerServices`, and the desktop's side of every
branch on that is gone from this package rather than skipped: first-run provisioning, the self-updater
(an app the store updates installs nothing), finding and supervising a local harness CLI, signing in
through it or a browser, and the grid's presets, splits and keyboard rail.

## Keeping in step with `../desktop`

Much of `lib/` originated in `desktop/lib/`, but the copies now differ substantially. Mobile
removes desktop routing, local CLI supervision and transport, grid controls and local file access.
It also owns its authentication, encryption and phone-specific lifecycle handling.

Port shared protocol and model fixes deliberately. Check `core/agent_git_context.dart`,
`e2ee/envelope.dart`, `state/app_state.dart` and their regression tests when upstream adds RPCs
or agent fields. `test/encrypted_down_types_test.dart` compares the phone's encryption rules with
the CLI's source so a new machine request cannot silently leave unencrypted.

`third_party/xterm/` is patched code: preserve its mobile input, rendering and accessibility changes.
Never commit local signing edits to `ios/Runner.xcodeproj/project.pbxproj`.
