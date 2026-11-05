import 'dart:io' as io;

import 'package:flutter/services.dart';
import 'package:path/path.dart' as p;

import 'runtime_platform.dart';

/// Whether the system web view a Linux or Windows web pane draws with is here:
/// their plugins register even when it is not. Without it, the pane shows its
/// URL. A Mac always has one.
class NativeWebViewRuntime {
  static const channel = MethodChannel('harness/linux_webview');
  static bool available = false;

  static Future<void> initialize() async {
    if (RuntimePlatform.isWindows) {
      available = windowsWebView2Installed(io.Platform.environment);
      return;
    }
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

/// Whether WebView2's runtime is installed, for this computer or for this user:
/// the two folders its installer uses.
bool windowsWebView2Installed(
  Map<String, String> environment, {
  bool Function(String path) exists = _folderExists,
}) => [environment['ProgramFiles(x86)'], environment['LOCALAPPDATA']]
    .whereType<String>()
    .any(
      (root) => exists(
        p.windows.join(root, 'Microsoft', 'EdgeWebView', 'Application'),
      ),
    );

bool _folderExists(String path) => io.Directory(path).existsSync();
