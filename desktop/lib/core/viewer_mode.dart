import 'package:flutter/foundation.dart';

import 'runtime_platform.dart';

/// Whether this build is a VIEWER: a window onto the user's machines and nothing more.
///
/// No harness CLI runs beside it and no agent is ever hosted here, so every machine — this computer
/// included, if it is a Harness machine at all — is reached through the relay, with this app
/// terminating the end-to-end encryption the CLI terminates everywhere else (see `lib/viewer/`).
///
/// True on iOS, Android and Windows, where the CLI cannot run: tmux is not optional to it, and a
/// phone will not host a Node runtime or spawn a process at all. On macOS and Linux only with
/// `--dart-define=HARNESS_VIEWER_MODE=true`, which is how the path is developed and tested on a Mac
/// against real machines.
final bool kViewerMode =
    kIsWeb ||
    const bool.fromEnvironment('HARNESS_VIEWER_MODE') ||
    RuntimePlatform.isIOS ||
    RuntimePlatform.isAndroid ||
    RuntimePlatform.isWindows;
