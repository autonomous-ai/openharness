import 'dart:io' as io;

import 'package:flutter/foundation.dart';

/// Native host capabilities. A browser has no local OS API, even when it runs
/// on a Mac. UI conventions should use Flutter's [defaultTargetPlatform].
abstract final class RuntimePlatform {
  static bool get isMacOS => !kIsWeb && io.Platform.isMacOS;
  static bool get isLinux => !kIsWeb && io.Platform.isLinux;

  /// The Linux build running inside Windows Subsystem for Linux (WSLg). WSL
  /// sets `WSL_DISTRO_NAME` for what it starts, and its kernels name
  /// themselves `…-microsoft-standard-WSL2`. Not a supported platform — only
  /// the places where WSLg behaves unlike a Linux desktop read this.
  static bool get isWsl =>
      isLinux &&
      (environment['WSL_DISTRO_NAME'] != null ||
          operatingSystemVersion.toLowerCase().contains('microsoft'));
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
