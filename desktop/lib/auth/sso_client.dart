import 'package:flutter/foundation.dart' show kIsWeb;

import '../core/runtime_platform.dart';

/// auth-service's client for the surface this build is (backend `SSO_CLIENT_IDS`): a build that
/// signs in by itself — the web app, a viewer — names its own, so the sign-in is made as that
/// surface rather than as the terminal's.
///
/// A desktop build with the harness CLI beside it never reads this: the CLI signs in, and names
/// `harness-desktop` itself when the app tells it who is asking (`--entry-point=desktop`).
String get ssoClientId {
  if (kIsWeb) return 'harness-web';
  if (RuntimePlatform.isIOS || RuntimePlatform.isAndroid) return 'harness-mobile';
  return 'harness-desktop';
}
