import 'dart:io' show Platform;

import 'package:window_manager/window_manager.dart';
import 'package:flutter/services.dart';

import '../shared/theme/color_palette.dart';
import '../shared/theme/app_type.dart';
import 'build_identity.dart';

/// Whether this build runs inside a window the app is allowed to manage.
///
/// `window_manager` ships implementations for macOS, Windows and Linux only.
/// Its Dart surface still compiles everywhere, so on any other platform the
/// calls below are not a compile error — they are a `MissingPluginException` at
/// runtime, thrown from `main` before the first frame. The guard therefore has
/// to live here rather than being left to each call site to remember.
bool get hasManagedWindow =>
    Platform.isMacOS || Platform.isWindows || Platform.isLinux;

/// Configures the native window before the first Flutter frame.
///
/// On macOS, AppKit places Swarm tabs beside the system traffic lights in a
/// compact unified title bar. Flutter starts below that row. Windows and Linux
/// keep their native caption bar and use the Flutter Swarm-tab fallback.
Future<void> configureDesktopWindow({
  HarnessPalette palette = HarnessPalette.graphite,
}) async {
  if (!hasManagedWindow) return;
  await windowManager.ensureInitialized();
  final options = WindowOptions(
    size: const Size(1280, 800),
    minimumSize: const Size(880, 560),
    title: desktopAppName,
    center: true,
    titleBarStyle: TitleBarStyle.normal,
  );
  // The plugin's optional callback is a VoidCallback: an async callback would
  // return before native setup finishes and detach any error from this future.
  await windowManager.waitUntilReadyToShow(options);
  if (Platform.isMacOS) {
    await const MethodChannel('harness/swarm_tabs').invokeMethod('configure', {
      'palette': palette.nativeColors,
      'fontFamily': AppType.monoFamily,
      'fontSize': AppType.chromeSize,
      'fontFallbacks': AppType.monoFallback,
    });
  }
  // Always open filling the screen (owner, 2026-09-15): the tabs, a viewer
  // beside its terminal and the rail all want the width. The options above
  // stay the frame the green button returns to.
  await windowManager.maximize();
  await windowManager.show();
  await windowManager.focus();
}

/// Bring the window to the front, wherever it was.
///
/// For work that STARTS somewhere else. Speaking into the dial opens the task palette here, and a
/// palette behind another app — or on a window the person minimised an hour ago — is a question nobody
/// is being asked: the dial shows its sending overlay, the words go nowhere, and the only clue is on a
/// screen that never came forward.
///
/// [windowManager.show] alone is not enough on macOS: a minimised or hidden window needs it, a
/// backgrounded one needs the focus call, and which of the two applies is not knowable from here — so
/// both run, in that order. Failures are swallowed on purpose: the plugin throws on a platform without a
/// window server (a headless test host), and losing the palette is worse than losing the raise.
Future<void> revealWindow() async {
  if (!hasManagedWindow) return;
  try {
    if (await windowManager.isMinimized()) await windowManager.restore();
    await windowManager.show();
    await windowManager.focus();
  } catch (_) {
    // No window server, or a platform that will not raise on demand. The palette still opens.
  }
}
