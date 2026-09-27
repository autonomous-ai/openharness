import 'dart:io' as io;

import 'package:flutter/foundation.dart';

/// Native host capabilities. A browser has no local OS API, even when it runs
/// on a Mac. UI conventions should use Flutter's [defaultTargetPlatform].
abstract final class RuntimePlatform {
  static bool get isMacOS => !kIsWeb && io.Platform.isMacOS;
  static bool get isLinux => !kIsWeb && io.Platform.isLinux;
  static bool get isWindows => !kIsWeb && io.Platform.isWindows;
  static bool get isIOS => !kIsWeb && io.Platform.isIOS;
  static bool get isAndroid => !kIsWeb && io.Platform.isAndroid;
  static Map<String, String> get environment =>
      kIsWeb ? const {} : io.Platform.environment;
  static String get operatingSystem =>
      kIsWeb ? 'web' : io.Platform.operatingSystem;
  static String get operatingSystemVersion =>
      kIsWeb ? '' : io.Platform.operatingSystemVersion;
  static String get localeName => kIsWeb
      ? PlatformDispatcher.instance.locale.toLanguageTag()
      : io.Platform.localeName;
  static String get pathSeparator => kIsWeb ? '/' : io.Platform.pathSeparator;
  static String get localHostname =>
      kIsWeb ? 'Browser' : io.Platform.localHostname;
  static String get resolvedExecutable => io.Platform.resolvedExecutable;
}
