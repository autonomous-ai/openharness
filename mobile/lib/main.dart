import 'app_shell.dart';
import 'p2p/phone_terminal_p2p.dart';
import 'phone/phone_shell.dart';

/// Harness for iOS and Android: a viewer onto the machines this device has
/// linked, one agent at a time.
///
/// Everything before the first frame — file logs, the crash log, the keyboard
/// config, the saved appearance — and every screen up to sign-in comes from
/// [startHarness] in `app_shell.dart`. This package owns all of it: the app it
/// runs lives under `lib/`, with no dependency on any other package in this
/// repo. `lib/phone/` is what a phone needs that a window does not.
///
/// The app has no harness CLI beside it, so it is a VIEWER build: it holds its
/// own SSO session and terminates the end-to-end encryption to each machine
/// itself (`kViewerMode`, and `lib/viewer/`). That is decided by the platform,
/// not here — a Mac running this package can take the same path with
/// `--dart-define=HARNESS_VIEWER_MODE=true`.
///
/// It also brings its own second wire to each machine: the WebRTC data channel
/// the harness CLI opens on the desktop's behalf (`lib/p2p/`), so a terminal
/// rides p2p or TURN when it can and the relay only when it must.
Future<void> main() => startHarness(
  authenticatedScreen: (app) => PhoneShell(notifier: app),
  transportPlugins: phoneTerminalP2p.create,
);
