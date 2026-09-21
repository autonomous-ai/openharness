# Harness for iOS and Android

A viewer onto the machines this device has linked — one agent at a time, on a phone.

```bash
flutter pub get
flutter analyze          # 0 issues outside third_party/xterm
flutter test
flutter run              # -d <your device>
flutter build ios --debug --no-codesign
flutter build apk --debug
```

## This package depends on nothing else in this repo

`harness_mobile` is standalone. It used to be a thin shell over `path: ../desktop`, which meant every
desktop-only concern was a phone concern too: the app pulled in `window_manager`, `file_selector`,
`desktop_drop`, `sqlite3` and `go_router`, and the phone build was pinned to a Flutter app whose
targets are macOS and Linux.

The app it runs now lives under `lib/`, in the same folders the desktop app uses for it:

| | |
|---|---|
| `lib/core/` | models, config, platform, file store, crash log |
| `lib/state/` | `AppNotifier` — machines, agents, connections, panes, the account's desk |
| `lib/api/`, `lib/ws/` | REST to the backend, and the relay socket per machine |
| `lib/auth/`, `lib/viewer/` | SSO, device linking, and the viewer's stand-ins for the harness CLI |
| `lib/e2ee/` | the end-to-end encryption this app terminates itself |
| `lib/terminal/`, `lib/widgets/` | the xterm session, the terminal panel and its chrome |
| `lib/shared/`, `lib/analytics/`, `lib/logging/` | design system, analytics, file logs |
| `third_party/xterm/` | the vendored, patched xterm 4.0.0 (see its `README.autonomous.md`) |

Two folders are this package's own, and have no counterpart on the desktop:

- **`lib/phone/`** — the shell a phone needs that a window does not: tabs, cards, sheets, the
  one-agent-at-a-time terminal page.
- **`lib/p2p/`** — the phone's second wire to each machine. The `terminal-v1` WebRTC data channel the
  harness CLI opens with werift on the desktop's behalf, so a terminal rides p2p or TURN when it can
  and the relay only when it must.

## The account's tabs are the desk's, here too

The tabs a person has are one document per account on the backend (`/api/desk`), the same on every
computer they sign in on. The desktop owns its half of that in `desktop/lib/state/desk_sync.dart`,
which is **vendored here unchanged**; `lib/state/phone_desk.dart` is this package's own other half,
and it is deliberately not the window's:

- A window's tabs ARE its `swarms`, so the desktop diffs that projection after every layout change.
  A phone's `swarms` are not tabs — they are where the pager attaches the agents either side of the
  one on screen — so nothing here is projected onto the desk.
- The phone reads the tabs, follows them (`desk_changed` rides each machine's relay socket, since a
  phone holds no adapter socket of its own), and writes exactly twice: an agent created here joins
  the tab the phone is in, and one deleted here leaves every tab that held it.
- Which tab is open, and where you were inside it, stay on the device — as they do per window.

What the person sees of it is `lib/phone/desk_tab_strip.dart`, the chip rail under the terminal's
header, and a swipe that walks that tab's agents rather than the whole account
(`lib/phone/desk_groups.dart`).

## It is a VIEWER build, always

No harness CLI runs beside this app and no agent is ever hosted here. It holds its own SSO session and
terminates the E2EE to each machine itself (`lib/viewer/`, `lib/e2ee/`) — where the desktop hands both
to the CLI on its own computer. `kViewerMode` (`lib/core/viewer_mode.dart`) is true on iOS and Android
unconditionally, and that one flag is what gates the paths a phone cannot take: first-run provisioning
and the self-updater are both skipped in `AppNotifier.bootstrap`, because an app the store updates
installs nothing.

## Keeping in step with `../desktop`

The shared half of `lib/` was **vendored** from `desktop/lib/`, not rewritten, and outside
`lib/phone/` and `lib/p2p/` the two trees are byte-identical apart from the package name and six
files. So a fix that belongs on both sides can be carried across with `diff`:

```bash
# What has drifted, ignoring the package rename
cd mobile/lib && for f in $(find . -name '*.dart' | sed 's|^\./||'); do
  [ -f "../../desktop/lib/$f" ] || continue
  diff -q <(sed 's|package:harness_mobile/|package:harness/|g' "$f") "../../desktop/lib/$f" >/dev/null \
    || echo "DIFFERS: $f"
done
```

The six that are expected to differ, and why:

| File | Why |
|---|---|
| `main.dart` | mounts `PhoneShell` and the p2p transport, not `SwarmScreen` |
| `app_shell.dart` | no managed window: `window_manager` ships for macOS/Windows/Linux only |
| `widgets/update_notice.dart` | same — it was wrapped in a window drag area |
| `screens/login_screen.dart`, `widgets/bootstrapping_screen.dart`, `widgets/engine_identity.dart` | assets are this package's own, so they no longer name a `package:` to load from |

`lib/core/desktop_window.dart` and `lib/widgets/window_chrome.dart` have no copy here at all.
