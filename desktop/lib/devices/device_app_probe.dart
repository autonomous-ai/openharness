import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:path/path.dart' as p;

import '../core/runtime_platform.dart';
import '../core/windows_folder.dart';
import 'device_app.dart';
import 'device_app_installer.dart' show runDeviceAppTool;

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

/// Windows and Linux, which have no LaunchServices to ask: the app is installed when its file is at [place] (see
/// [deviceAppPlace]) or it runs, and runs when [running] says a process of this user is it.
class PlaceDeviceAppProbe implements DeviceAppProbe {
  const PlaceDeviceAppProbe({
    required this._place,
    required this._running,
    this._exists,
  });

  /// Asked at each lookup: on Windows an install registers where it went.
  final String? Function() _place;

  /// [windowsDeviceAppRunning] or [linuxDeviceAppRunning]. What it throws, [lookup] throws.
  final Future<bool> Function() _running;

  /// Passed to [deviceAppInstalledAt].
  final Future<bool> Function(String path)? _exists;

  @override
  Future<DeviceAppPresence> lookup() async {
    final running = await _running();
    final place = _place();
    return DeviceAppPresence(
      installed:
          running ||
          (place != null &&
              await deviceAppInstalledAt([place], exists: _exists)),
      running: running,
    );
  }
}

/// Whether this user runs the app, by `tasklist.exe` from System32, filtered to the app's image and [environment]'s
/// `USERNAME`. [run] defaults to [runDeviceAppTool] with a 10 s bound. Throws with no `USERNAME` (no filter would
/// count another user's copy) and when tasklist exits other than 0.
Future<bool> windowsDeviceAppRunning({
  Future<ProcessResult> Function(String executable, List<String> arguments)?
  run,
  Map<String, String>? environment,
}) async {
  final env = environment ?? RuntimePlatform.environment;
  // Windows reads its environment's names in any case.
  final user = env.entries
      .where((e) => e.key.toUpperCase() == 'USERNAME')
      .map((e) => e.value)
      .firstOrNull;
  if (user == null || user.isEmpty) {
    throw StateError('tasklist: no USERNAME');
  }
  final tasklist =
      run ??
      (executable, arguments) => runDeviceAppTool(
        executable,
        arguments,
        timeout: const Duration(seconds: 10),
      );
  final result = await tasklist(windowsSystemProgram('tasklist.exe'), [
    '/FI',
    'IMAGENAME eq $deviceAppWindowsExe',
    '/FI',
    'USERNAME eq $user',
    '/FO',
    'CSV',
    '/NH',
  ]);
  if (result.exitCode != 0) {
    throw ProcessException(
      'tasklist.exe',
      const [],
      'tasklist failed',
      result.exitCode,
    );
  }
  return tasklistNamesDeviceApp('${result.stdout}');
}

/// Whether tasklist's CSV names the app: a row whose first field, unquoted, is [deviceAppWindowsExe] in any case.
/// With no match tasklist prints one line in the system's language instead of a row, which never matches.
bool tasklistNamesDeviceApp(String csv) {
  for (final line in const LineSplitter().convert(csv)) {
    var name = line.split(',').first.trim();
    if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
      name = name.substring(1, name.length - 1);
    }
    if (name.toLowerCase() == deviceAppWindowsExe) return true;
  }
  return false;
}

/// Whether this user runs the app: a numeric entry of [proc] whose `comm` is `harness-device` and whose `status`
/// gives this process's real uid. Throws when `self/status` gives no uid; an entry that vanishes or cannot be read
/// is skipped.
Future<bool> linuxDeviceAppRunning({String proc = '/proc'}) async {
  final uid = _realUid(await _read(p.posix.join(proc, 'self', 'status')));
  if (uid == null) throw FormatException('$proc/self/status: no Uid');
  await for (final entry in Directory(proc).list(followLinks: false)) {
    if (!_pid.hasMatch(p.posix.basename(entry.path))) continue;
    try {
      final comm = await _read(p.posix.join(entry.path, 'comm'));
      if (comm.trim() != 'harness-device') continue;
      if (_realUid(await _read(p.posix.join(entry.path, 'status'))) == uid) {
        return true;
      }
    } on FileSystemException {
      // It ended while the list was read, or is not ours to read.
    }
  }
  return false;
}

final _pid = RegExp(r'^\d+$');

// latin1, which never throws: a process may name itself with any bytes.
Future<String> _read(String path) => File(path).readAsString(encoding: latin1);

/// The first of `status`'s `Uid:` fields, the real uid.
String? _realUid(String status) {
  for (final line in const LineSplitter().convert(status)) {
    if (!line.startsWith('Uid:')) continue;
    final fields = line.substring(4).trim().split(RegExp(r'\s+'));
    return fields.first.isEmpty ? null : fields.first;
  }
  return null;
}
