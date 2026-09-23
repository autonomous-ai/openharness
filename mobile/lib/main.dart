import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

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
Future<void> main() {
  _drawEdgeToEdgeOnEveryAndroid();
  return startHarness(
    authenticatedScreen: (app) => PhoneShell(notifier: app),
    transportPlugins: phoneTerminalP2p.create,
  );
}

/// Draw behind the status and navigation bars on every Android version, not only the new ones.
///
/// ⚠️ **Android 15 already does this, and that is exactly the problem.** Targeting SDK 35+ makes
/// edge-to-edge mandatory from Android 15 on, so the layout has handled the system insets for a
/// while — but on Android 14 and below nothing opted in, and the same screens sat between two opaque
/// bars instead. Play Console flags that split ("some users may not see edge-to-edge"); this is the
/// opt-in Flutter documents for it. Transparent bars, so what shows through is the app's own
/// background rather than the theme's black strip; the navigation bar keeps the system's contrast
/// scrim where the device uses three-button navigation.
///
/// Not on iOS, which has always drawn under its bars and has no mode to switch. Not awaited: it is
/// a platform message the first frame does not depend on, and [startHarness] times the launch from
/// its own first line.
void _drawEdgeToEdgeOnEveryAndroid() {
  if (!Platform.isAndroid) return;
  WidgetsFlutterBinding.ensureInitialized();
  unawaited(SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge));
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Color(0x00000000),
      systemNavigationBarColor: Color(0x00000000),
    ),
  );
}
