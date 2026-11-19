import 'dart:io';

import 'package:flutter/services.dart';
import 'package:path/path.dart' as p;

import 'device_app.dart';

/// Whether any of [paths] is an installed copy: it exists on disk, it is in no Trash (no path component is
/// `.Trash` or `.Trashes`), and it is not under `/Volumes/` (a mounted disk image or another disk).
/// [exists] defaults to `FileSystemEntity.type(path) != FileSystemEntityType.notFound`.
///
/// LaunchServices also lists copies in the Trash and on mounted disk images, which are not installs. The rule is
/// here, not in the Swift lookup, so a test pull request CI runs checks it.
Future<bool> deviceAppInstalledAt(
  List<String> paths, {
  Future<bool> Function(String path)? exists,
}) async {
  final onDisk = exists ?? _exists;
  for (final path in paths) {
    if (path.startsWith('/Volumes/')) continue;
    final parts = p.posix.split(path);
    if (parts.contains('.Trash') || parts.contains('.Trashes')) continue;
    if (await onDisk(path)) return true;
  }
  return false;
}

Future<bool> _exists(String path) async =>
    await FileSystemEntity.type(path) != FileSystemEntityType.notFound;

class ChannelDeviceAppProbe implements DeviceAppProbe {
  const ChannelDeviceAppProbe({
    this._channel = const MethodChannel('harness/device_app'),
    this._exists,
  });

  final MethodChannel _channel;

  /// Passed to [deviceAppInstalledAt].
  final Future<bool> Function(String path)? _exists;

  /// Throws a [FormatException] on a reply that is not `{paths: a list of strings, running: a bool}`, and
  /// whatever the channel throws.
  @override
  Future<DeviceAppPresence> lookup() async {
    final reply = await _channel.invokeMethod<Object?>('lookup');
    if (reply case {'paths': final List paths, 'running': final bool running}) {
      final strings = paths.whereType<String>().toList();
      if (strings.length == paths.length) {
        return DeviceAppPresence(
          installed: await deviceAppInstalledAt(strings, exists: _exists),
          running: running,
        );
      }
    }
    throw const FormatException('device app lookup reply');
  }
}
