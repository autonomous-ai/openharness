import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../core/runtime_platform.dart';

/// Flutter's own `Clipboard` (package:flutter/services.dart) only ever exposes `text/plain` — see
/// `widgets/terminal_panel.dart`'s `_paste()`. Reading a real IMAGE off the clipboard (a
/// screenshot, "Copy Image" from a browser, ...) needs a native round trip instead: NSPasteboard on
/// macOS (`macos/Runner/MainFlutterWindow.swift`), the GTK clipboard on Linux
/// (`linux/runner/my_application.cc`). Both answer over the same channel name and method, so this
/// wrapper is the one place call sites need to know about.
class NativeClipboard {
  NativeClipboard._();

  static const MethodChannel _channel = MethodChannel(
    'harness/clipboard_image',
  );

  /// Reads the system clipboard for an image, returned as PNG bytes.
  ///
  /// Returns `null` on any platform without a native handler for this channel (Windows — the
  /// runner is unexercised, see CLAUDE.md — and any platform that isn't macOS/Linux) or when the
  /// clipboard genuinely holds no image, so call sites can use one check to fall through to
  /// today's text-paste behavior either way.
  static Future<Uint8List?> readImagePng() async {
    if (!RuntimePlatform.isMacOS && !RuntimePlatform.isLinux) return null;
    Uint8List? bytes;
    try {
      bytes = await _channel.invokeMethod<Uint8List>('readImagePng');
    } on MissingPluginException {
      bytes = null;
    } catch (_) {
      bytes = null;
    }
    if ((bytes == null || bytes.isEmpty) && RuntimePlatform.isWsl) {
      return readWindowsImagePng();
    }
    return bytes;
  }

  /// The files the clipboard holds, as paths in the order they were copied —
  /// what a file manager's Copy puts there (Finder, Nautilus, Dolphin).
  ///
  /// Empty when it holds none, and on a runner that does not answer: Windows,
  /// or an app built before `readFilePaths` existed.
  static Future<List<String>> readFilePaths() async {
    if (!RuntimePlatform.isMacOS && !RuntimePlatform.isLinux) return const [];
    try {
      return await _channel.invokeListMethod<String>('readFilePaths') ??
          const [];
    } catch (_) {
      return const [];
    }
  }

  /// Under WSL, the WINDOWS clipboard's image as PNG, read through
  /// `powershell.exe` (WSL interop). WSLg mirrors a Windows screenshot into
  /// the Linux clipboard as BMP only, when it mirrors it at all
  /// (microsoft/wslg#833, #236), so the GTK read above can come back empty
  /// with a picture plainly on the Windows clipboard (openharness#107).
  /// Null when there is no image, no interop, or it takes over five seconds.
  @visibleForTesting
  static Future<Uint8List?> Function() readWindowsImagePng =
      _readWindowsImagePng;

  static Future<Uint8List?> _readWindowsImagePng() async {
    const script =
        r'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;'
        r'$i=[System.Windows.Forms.Clipboard]::GetImage();'
        r'if($i -eq $null){exit 1};'
        r'$m=New-Object System.IO.MemoryStream;'
        r'$i.Save($m,[System.Drawing.Imaging.ImageFormat]::Png);'
        r'[Convert]::ToBase64String($m.ToArray())';
    try {
      final result = await Process.run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-Command',
        script,
      ]).timeout(const Duration(seconds: 5));
      if (result.exitCode != 0) return null;
      final encoded = (result.stdout as String).trim();
      if (encoded.isEmpty) return null;
      return base64Decode(encoded);
    } catch (_) {
      return null;
    }
  }

  /// Writes `pngBytes` onto the system clipboard, replacing whatever was there — the LOCAL half
  /// of native image drag-drop (see `_dropImage` in `widgets/pane_grid.dart`): when the pane's
  /// machine is this same computer, the app puts the bytes on ITS OWN clipboard directly instead
  /// of sending them over the terminal wire, then forwards a Ctrl+V so the engine reads them
  /// exactly as it already does for an ordinary local clipboard paste.
  ///
  /// Returns `false` on any platform without a native handler for this channel, or when the
  /// native side could not decode/write the bytes — callers should treat that as "could not do
  /// the local shortcut" rather than surfacing a crash.
  static Future<bool> writeImagePng(Uint8List pngBytes) async {
    if (!RuntimePlatform.isMacOS && !RuntimePlatform.isLinux) return false;
    try {
      final wrote = await _channel.invokeMethod<bool>(
        'writeImagePng',
        pngBytes,
      );
      return wrote ?? false;
    } on MissingPluginException {
      return false;
    } catch (_) {
      return false;
    }
  }
}
