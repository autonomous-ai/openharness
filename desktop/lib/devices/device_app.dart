import 'package:flutter/foundation.dart';

import '../core/runtime_platform.dart';
import '../core/viewer_mode.dart';

const deviceAppBundleId = 'ai.autonomous.harness.device';
const deviceAppBundleName = 'Harness Device.app';

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

final _macVersion = RegExp(r'^Version (\d+)');

/// macOS 13 or later, and not a viewer build. Defaults: [defaultTargetPlatform],
/// [RuntimePlatform.operatingSystemVersion], `kIsWeb || kViewerMode`.
bool deviceAppSupported({
  TargetPlatform? platform,
  String? osVersion,
  bool? viewer,
}) {
  if (viewer ?? (kIsWeb || kViewerMode)) return false;
  if ((platform ?? defaultTargetPlatform) != TargetPlatform.macOS) return false;
  final match = _macVersion.firstMatch(
    osVersion ?? RuntimePlatform.operatingSystemVersion,
  );
  // The menu-bar app needs macOS 13; anything that does not read as a macOS version is not offered it.
  return match != null && int.parse(match.group(1)!) >= 13;
}
