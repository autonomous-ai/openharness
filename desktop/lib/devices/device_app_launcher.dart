import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;

import '../core/linux_app_image.dart';
import '../core/runtime_platform.dart';
import '../logging/app_log.dart';
import 'device_app.dart';

/// Linux: Harness Device's entry in the desktop's app list. An AppImage
/// registers nothing itself, so Desktop writes the entry when it installs the
/// app, as it writes its own (`registerAppImageLauncher`).
const deviceAppLauncherName = 'harness-device.desktop';

/// The app's window class, as the entry's `StartupWMClass`: a dock then draws
/// the app's window with the entry's icon. GTK takes it from the binary's
/// name, which the AppImage starts as `harness-device`
/// (`tests/fixtures/app-list-entry-vectors.json`).
const deviceAppWindowClass = 'harness-device';

/// The AppImage's own 128-pixel icon; Tauri names it after the binary.
const deviceAppIconMember =
    'usr/share/icons/hicolor/128x128/apps/harness-device.png';

typedef DeviceAppIconExtract = Future<List<int>?> Function(String appImage);

/// The icon inside [appImage], taken by the AppImage runtime's
/// `--appimage-extract` in a temporary folder of its own, as
/// `website/scripts/desktop-install.sh` takes Desktop's. Null on any failure;
/// the folder is removed whatever happened.
Future<List<int>?> extractDeviceAppIcon(String appImage) async {
  Directory? temp;
  try {
    temp = await Directory.systemTemp.createTemp('harness-device-icon-');
    final process = await Process.start(appImage, const [
      '--appimage-extract',
      deviceAppIconMember,
    ], workingDirectory: temp.path);
    // The runtime names every file it extracts: drained so it never blocks.
    final drained = [
      process.stdout.drain<void>(),
      process.stderr.drain<void>(),
    ];
    final int code;
    try {
      code = await process.exitCode.timeout(const Duration(seconds: 10));
    } on TimeoutException {
      process.kill(ProcessSignal.sigkill);
      await process.exitCode;
      return null;
    }
    await Future.wait(drained);
    if (code != 0) return null;
    return await File('${temp.path}/squashfs-root/$deviceAppIconMember')
        .readAsBytes();
  } on Exception {
    // No icon: the entry goes without one.
    return null;
  } finally {
    try {
      await temp?.delete(recursive: true);
    } on FileSystemException {
      // What is left sits in the system's temporary folder.
    }
  }
}

/// Writes the entry that starts [appImage], and its icon, when
/// [deviceAppLauncherChange] says to: the one rule the Device app and the
/// one-line installer follow too. A path holding a control character writes
/// nothing, as no `Exec=` line can hold it. Never throws: an entry is not
/// worth failing an install over. The log names no path.
Future<void> writeDeviceAppLauncher(
  String appImage, {
  Map<String, String>? environment,
  DeviceAppIconExtract extractIcon = extractDeviceAppIcon,
}) async {
  try {
    final dataHome = launcherDataHome(
      environment ?? RuntimePlatform.environment,
    );
    if (dataHome == null) return;
    if (_control.hasMatch(appImage) || _control.hasMatch(dataHome)) {
      appLog.warn('devices', 'device app: launcher entry not written (path)');
      return;
    }
    final entry = _entry(dataHome);
    final icon = _icon(dataHome);
    final wanted = _entryText(appImage, icon: icon.path);
    final change = deviceAppLauncherChange(
      existing: await entry.exists() ? await readLauncherEntry(entry) : null,
      appImage: appImage,
      wanted: wanted,
      exists: (path) => File(path).existsSync(),
    );
    if (!change) return;
    final iconBytes = await extractIcon(appImage);
    if (iconBytes != null) {
      await icon.parent.create(recursive: true);
      await replaceLauncherFile(icon, iconBytes);
    }
    await entry.parent.create(recursive: true);
    await replaceLauncherFile(
      entry,
      utf8.encode(iconBytes == null ? _entryText(appImage) : wanted),
    );
    if (environment == null) {
      try {
        await Process.run('update-desktop-database', [entry.parent.path]);
      } on ProcessException {
        /* Optional desktop utility. */
      }
    }
    appLog.info('devices', 'device app: launcher entry written');
  } on Exception catch (error) {
    appLog.warn(
      'devices',
      'device app: launcher entry failed: ${_message(error)}',
    );
  }
}

/// Whether the entry is (re)written, given the one there ([existing], null when
/// none) and the one this writer would write ([wanted]). An entry whose `Exec=`
/// starts [appImage] is its own, kept as `registerAppImageLauncher` keeps
/// Desktop's: it stays while the person hid it, and while its `Exec=` and
/// `StartupWMClass=` are [wanted]'s and its icon is there, so a person's name
/// or icon stays. One that starts an absolute path no longer on disk is taken
/// over. Any other (another copy still on disk, a program by name, no `Exec=`)
/// is a person's or another copy's, and stays.
@visibleForTesting
bool deviceAppLauncherChange({
  String? existing,
  required String appImage,
  required String wanted,
  required bool Function(String path) exists,
}) {
  if (existing == null) return true;
  final target = launcherExecTarget(existing);
  if (target == null || !p.posix.isAbsolute(target)) return false;
  if (target != appImage) return !exists(target);
  // Hidden as a menu editor hides an entry: a rewrite would undo it.
  if ([
    'NoDisplay',
    'Hidden',
  ].any((key) => launcherEntryValue(existing, key) == 'true')) {
    return false;
  }
  // The file Icon= names by its path is there, or Icon= names a theme's icon
  // without one, the person's; no Icon= is right only when [wanted] has none.
  final icon = launcherEntryValue(existing, 'Icon');
  final iconRight = icon == null
      ? launcherEntryValue(wanted, 'Icon') == null
      : !p.posix.isAbsolute(icon) || exists(icon);
  return !iconRight ||
      ['Exec', 'StartupWMClass'].any(
        (key) =>
            launcherEntryValue(existing, key) !=
            launcherEntryValue(wanted, key),
      );
}

String _entryText(String appImage, {String? icon}) =>
    '[Desktop Entry]\n'
    'Type=Application\n'
    'Name=Harness Device\n'
    'Comment=The app for your Harness device.\n'
    'Exec=${quoteLauncherExec(appImage)}\n'
    '${icon == null ? '' : 'Icon=$icon\n'}'
    'Terminal=false\n'
    'Categories=Utility;\n'
    'StartupWMClass=$deviceAppWindowClass\n';

/// C0, DEL and C1 (Unicode's Cc), as the Device app's `char::is_control`.
final _control = RegExp(r'[\x00-\x1f\x7f-\x9f]');

/// Removes the entry and its icon once the app's place, which the entry
/// starts, is gone: a person deleted the AppImage, and Desktop has no other
/// way to hear of it. Any other entry, and one whose file is there, stays: only
/// the entry Desktop wrote is Desktop's to remove. Never throws.
Future<void> forgetGoneDeviceAppLauncher({
  Map<String, String>? environment,
}) async {
  if (!RuntimePlatform.isLinux && environment == null) return;
  try {
    final env = environment ?? RuntimePlatform.environment;
    final dataHome = launcherDataHome(env);
    if (dataHome == null) return;
    final entry = _entry(dataHome);
    if (!await entry.exists()) return;
    final target = launcherExecTarget(await readLauncherEntry(entry));
    final place = deviceAppPlace(
      platform: TargetPlatform.linux,
      environment: env,
    );
    if (target == null || target != place || await File(target).exists()) {
      return;
    }
    await entry.delete();
    final icon = _icon(dataHome);
    if (await icon.exists()) await icon.delete();
    appLog.info('devices', 'device app: launcher entry removed');
  } on Exception catch (error) {
    appLog.warn(
      'devices',
      'device app: launcher entry failed: ${_message(error)}',
    );
  }
}

File _entry(String dataHome) =>
    File('$dataHome/applications/$deviceAppLauncherName');

File _icon(String dataHome) => File('$dataHome/icons/harness-device.png');

/// A file error's message carries no path; anything else is named by its type.
String _message(Exception error) =>
    error is FileSystemException ? error.message : '${error.runtimeType}';
