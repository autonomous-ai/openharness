import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;

import '../core/home_dir.dart';
import '../core/runtime_platform.dart';
import '../core/viewer_mode.dart';

const deviceAppBundleId = 'ai.autonomous.harness.device';
const deviceAppBundleName = 'Harness Device.app';
const deviceAppWindowsExe = 'harness-device.exe';
const deviceAppImageName = 'Harness-Device.AppImage';

/// Where the menu-bar app lives on Windows and Linux, or null when nothing
/// names that folder. Windows: where its per-user installer puts it,
/// `%LOCALAPPDATA%\Harness Device`. Linux: `~/.local/opt`, beside Desktop's own
/// AppImage, under one fixed name so the app's updater replaces it in place.
/// macOS has none: LaunchServices finds the app wherever it is.
/// [platform] and [environment] default to this process's.
String? deviceAppPlace({
  TargetPlatform? platform,
  Map<String, String>? environment,
}) {
  final env = environment ?? RuntimePlatform.environment;
  switch (platform ?? defaultTargetPlatform) {
    case TargetPlatform.windows:
      // Windows reads its environment's names in any case.
      final local = env.entries
          .where((e) => e.key.toUpperCase() == 'LOCALAPPDATA')
          .map((e) => e.value)
          .firstOrNull;
      if (local == null || !p.windows.isAbsolute(local)) return null;
      return p.windows.join(local, 'Harness Device', deviceAppWindowsExe);
    case TargetPlatform.linux:
      final home = maybeHomeDir(environment: env, isWindows: false);
      if (home == null) return null;
      return p.posix.join(home, '.local', 'opt', deviceAppImageName);
    default:
      return null;
  }
}

/// What LaunchServices and AppKit say about the menu-bar app on this computer.
class DeviceAppPresence {
  const DeviceAppPresence({required this.installed, required this.running});
  final bool installed, running;
}

abstract interface class DeviceAppProbe {
  /// Throws when the lookup cannot be made.
  Future<DeviceAppPresence> lookup();
}

/// Opens the menu-bar app: the bundle at [path], or by bundle id when [path] is null. True when `open` exited 0.
typedef DeviceAppOpen = Future<bool> Function({String? path});

enum DeviceAppInstallStep {
  manifest,
  download,
  checksum,
  unpack,
  signature,
  install,
  open,
}

extension DeviceAppFailureLine on DeviceAppInstallStep {
  String get failureLine => switch (this) {
    DeviceAppInstallStep.manifest ||
    DeviceAppInstallStep.download => 'Couldn’t download the app.',
    DeviceAppInstallStep.checksum ||
    DeviceAppInstallStep.unpack ||
    DeviceAppInstallStep.signature => 'Couldn’t verify the download.',
    DeviceAppInstallStep.install => 'Couldn’t install the app.',
    DeviceAppInstallStep.open => 'Installed. Couldn’t open it.',
  };
}

class DeviceAppInstallResult {
  const DeviceAppInstallResult.done(String this.installedAt) : failed = null;
  const DeviceAppInstallResult.failed(
    DeviceAppInstallStep this.failed, {
    this.installedAt,
  });

  /// Null: installed and opened.
  final DeviceAppInstallStep? failed;

  /// The bundle's path once it is in place, also when only `open` failed.
  final String? installedAt;
}

/// The first dotted number: Apple documents the words around it as localized.
final _macVersion = RegExp(r'(\d+)\.\d+');

/// macOS 13 or later, every Windows Desktop runs on (Windows 10 or 11: nothing the app uses needs more) and every
/// Linux, and not a viewer build. Defaults: [defaultTargetPlatform], [RuntimePlatform.operatingSystemVersion],
/// `kIsWeb || kViewerMode`.
bool deviceAppSupported({
  TargetPlatform? platform,
  String? osVersion,
  bool? viewer,
}) {
  if (viewer ?? (kIsWeb || kViewerMode)) return false;
  switch (platform ?? defaultTargetPlatform) {
    case TargetPlatform.windows || TargetPlatform.linux:
      return true;
    case TargetPlatform.macOS:
      final match = _macVersion.firstMatch(
        osVersion ?? RuntimePlatform.operatingSystemVersion,
      );
      // The menu-bar app needs macOS 13; anything that does not read as a macOS version is not offered it.
      return match != null && int.parse(match.group(1)!) >= 13;
    default:
      return false;
  }
}

/// The band's sentence and the Devices row's title and detail.
typedef DeviceAppCopy = ({String band, String title, String detail});

/// The words for the app on [platform]: off macOS it lives in the tray, not a menu bar, and follows no terminal tab.
DeviceAppCopy deviceAppCopy(TargetPlatform platform) =>
    platform == TargetPlatform.macOS
    ? (
        band: 'Your dial follows apps and terminal tabs with the Harness menu-bar app.',
        title: 'Menu-bar app',
        detail: 'Follows the app and terminal tab in front.',
      )
    : (
        band: 'Your dial follows apps with the Harness tray app.',
        title: 'Tray app',
        detail: 'Follows the app in front.',
      );
