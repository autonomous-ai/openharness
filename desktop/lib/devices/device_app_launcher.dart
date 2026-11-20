import 'dart:async';
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

/// Writes the entry that starts [appImage], and its icon, unless an entry is
/// there that is not this one's and starts no file that is gone (a person's
/// own, which may start a program by name). Never throws: an entry is not
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
    final entry = _entry(dataHome);
    if (await entry.exists()) {
      final target = launcherExecTarget(await entry.readAsString());
      final gone =
          target != null &&
          p.posix.isAbsolute(target) &&
          !await File(target).exists();
      if (target != appImage && !gone) return;
    }
    final iconBytes = await extractIcon(appImage);
    final icon = _icon(dataHome);
    if (iconBytes != null) {
      await icon.parent.create(recursive: true);
      await icon.writeAsBytes(iconBytes);
    }
    await entry.parent.create(recursive: true);
    await entry.writeAsString(
      '[Desktop Entry]\n'
      'Type=Application\n'
      'Name=Harness Device\n'
      'Comment=The app for your Harness device.\n'
      'Exec=${quoteLauncherExec(appImage)}\n'
      '${iconBytes == null ? '' : 'Icon=${icon.path}\n'}'
      'Terminal=false\n'
      'Categories=Utility;\n',
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
    final target = launcherExecTarget(await entry.readAsString());
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
