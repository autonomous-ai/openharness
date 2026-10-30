import 'package:flutter/services.dart';

import 'runtime_platform.dart';

/// The Dart plugin registers even when its optional native library cannot load.
class LinuxWebViewRuntime {
  static const channel = MethodChannel('harness/linux_webview');
  static bool available = false;

  static Future<void> initialize() async {
    if (!RuntimePlatform.isLinux) return;
    try {
      available = await channel.invokeMethod<bool>('isAvailable') ?? false;
    } on PlatformException {
      available = false;
    } on MissingPluginException {
      available = false;
    }
  }
}
