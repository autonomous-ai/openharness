import 'package:flutter/foundation.dart';

import 'runtime_platform.dart';

/// Whether this build is a VIEWER: a window onto the user's machines and nothing more.
///
/// No harness CLI runs beside it and no agent is ever hosted here, so every machine — this computer
/// included, if it is a Harness machine at all — is reached through the relay, with this app
/// terminating the end-to-end encryption the CLI terminates everywhere else (see `lib/viewer/`).
///
/// True in a browser, and on iOS and Android, where a phone will not host a Node runtime or spawn a
/// process at all. On macOS, Linux and Windows only with `--dart-define=HARNESS_VIEWER_MODE=true`,
/// which is how the path is developed and tested on a Mac against real machines. The build decides,
/// never the desktop OS: Windows hosts the CLI as macOS and Linux do (sub-project B), so a Windows
/// build is "this computer" unless it was built as a viewer.
final bool kViewerMode = viewerModeFor(
  isWeb: kIsWeb,
  viewerBuild: const bool.fromEnvironment('HARNESS_VIEWER_MODE'),
  operatingSystem: RuntimePlatform.operatingSystem,
);

/// [kViewerMode]'s rule, with the build and the OS passed in.
@visibleForTesting
bool viewerModeFor({
  required bool isWeb,
  required bool viewerBuild,
  required String operatingSystem,
}) =>
    isWeb ||
    viewerBuild ||
    operatingSystem == 'ios' ||
    operatingSystem == 'android';
