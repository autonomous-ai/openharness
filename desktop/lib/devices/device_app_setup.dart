import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../core/local_key_value_store.dart';
import '../core/runtime_platform.dart';
import '../core/test_run.dart';
import '../logging/app_log.dart';
import '../update/desktop_updater.dart' show currentBundlePath;
import '../update/update_signature.dart';
import 'device_app.dart';
import 'device_app_installer.dart';
import 'device_app_manifest.dart';
import 'device_app_offer.dart';
import 'device_app_probe.dart';

/// Signed by the running Desktop's team as ai.autonomous.harness.device, and notarized. A running Desktop with
/// no signer (a local build) keeps the sha256 check alone, as its own updater does. A Desktop whose bundle or
/// signer cannot be read refuses.
Future<bool> deviceAppSignedLikeDesktop(
  String bundle, {
  String? Function()? runningBundle,
  Future<MacSigner?> Function(String bundle) readSigner = readMacSigner,
  Future<bool> Function({
        required String bundle,
        required String team,
        required String identifier,
      })
      verify =
      verifyMacBundle,
}) async {
  final running =
      (runningBundle ??
      () => currentBundlePath(isLinux: false, isWindows: false))();
  if (running == null) return false;
  final MacSigner? signer;
  try {
    signer = await readSigner(running);
  } on UpdateRefused {
    return false;
  }
  if (signer == null) return true;
  return verify(
    bundle: bundle,
    team: signer.team,
    identifier: deviceAppBundleId,
  );
}

/// Desktop runs the installer it downloads, so a manifest someone else wrote must not be able to name any program
/// with a matching sha256: the installer's Authenticode signature must be Valid and by the running Desktop's signer
/// (its subject and Azure identity), as Desktop's own updater asks of an update. A running Desktop that is not signed
/// (a local or staging build) keeps the sha256 check alone; one whose signature is broken, or whose signers cannot be
/// read, refuses.
Future<bool> deviceAppInstallerSignedLikeDesktop(
  String installer, {
  String Function()? runningExe,
  Future<({WindowsSigner running, WindowsSigner file})> Function({
        required String file,
        required String runningExe,
      })
      read =
      readWindowsSignerPair,
}) async {
  final ({WindowsSigner running, WindowsSigner file}) signers;
  try {
    signers = await read(
      file: installer,
      runningExe: (runningExe ?? () => RuntimePlatform.resolvedExecutable)(),
    );
  } on UpdateRefused {
    return false;
  }
  final (:running, :file) = signers;
  if (running.status == 'NotSigned') return true;
  if (!running.valid) return false;
  return file.valid && file.sameAs(running);
}

/// How [platform] finds the app: LaunchServices on macOS; on Windows and Linux its place under [environment] (by
/// default this process's) and this user's process list. [installLocation], [running] and [exists] stand in for the
/// OS under test.
@visibleForTesting
DeviceAppProbe deviceAppProbeFor(
  TargetPlatform platform, {
  Map<String, String>? environment,
  String? Function()? installLocation,
  Future<bool> Function()? running,
  Future<bool> Function(String path)? exists,
}) => switch (platform) {
  TargetPlatform.windows => PlaceDeviceAppProbe(
    place: () => deviceAppPlace(
      platform: platform,
      environment: environment,
      installLocation: installLocation,
    ),
    running: running ?? () => windowsDeviceAppRunning(environment: environment),
    exists: exists,
  ),
  TargetPlatform.linux => PlaceDeviceAppProbe(
    place: () => deviceAppPlace(platform: platform, environment: environment),
    running: running ?? linuxDeviceAppRunning,
    exists: exists,
  ),
  _ => const ChannelDeviceAppProbe(),
};

/// How [platform] opens the app: `open` on macOS; on Windows and Linux, which have none, it starts the named path,
/// else its place under [environment] (by default this process's), and fails with neither. [installLocation] stands
/// in for the registry under test.
@visibleForTesting
DeviceAppOpen deviceAppOpenFor(
  TargetPlatform platform, {
  DeviceAppStart start = startDeviceAppDetached,
  Map<String, String>? environment,
  String? Function()? installLocation,
}) {
  if (platform != TargetPlatform.windows && platform != TargetPlatform.linux) {
    return ({String? path}) => openDeviceApp(runDeviceAppTool, path: path);
  }
  return ({String? path}) async {
    final app =
        path ??
        deviceAppPlace(
          platform: platform,
          environment: environment,
          installLocation: installLocation,
        );
    return app != null &&
        await startDeviceApp(app, start: start, environment: environment);
  };
}

/// What [platform]'s installer checks the download with: the installer's signer on Windows, the bundle's on macOS.
/// Linux is never asked, as an AppImage carries no OS signature, and refuses were it ever asked.
@visibleForTesting
DeviceAppSignatureCheck deviceAppSignatureCheckFor(TargetPlatform platform) =>
    switch (platform) {
      TargetPlatform.windows => deviceAppInstallerSignedLikeDesktop,
      TargetPlatform.linux => _neverSigned,
      _ => deviceAppSignedLikeDesktop,
    };

Future<bool> _neverSigned(String _) async => false;

/// [platform]'s installer as the app builds it, with [platform]'s signature check ([deviceAppSignatureCheckFor])
/// and place, opening with [open]: the end-to-end test builds this one too. [manifestUrl], [dio] and [run] stand in
/// for the release and its tools under test.
DeviceAppInstaller deviceAppInstallerFor(
  TargetPlatform platform, {
  required DeviceAppOpen open,
  String manifestUrl = deviceAppManifestUrl,
  Dio? dio,
  DeviceAppRun run = runDeviceAppTool,
}) => DeviceAppInstaller(
  manifestUrl: manifestUrl,
  // Windows and Linux install at the place, never in a folder of these.
  targetFolders: switch (platform) {
    TargetPlatform.windows || TargetPlatform.linux => const [],
    _ => deviceAppTargetFolders(),
  },
  verifySignature: deviceAppSignatureCheckFor(platform),
  open: open,
  dio: dio,
  run: run,
  platform: platform,
  place: () => deviceAppPlace(platform: platform),
);

/// The offer with this OS's lookup, installer and opener. [supported] defaults to
/// `!kUnderTest && deviceAppSupported()`: under test it shows nothing and never looks.
DeviceAppOffer deviceAppOfferForThisComputer({
  LocalKeyValueStore? store,
  bool? supported,
}) {
  final platform = defaultTargetPlatform;
  final open = deviceAppOpenFor(platform);
  final installer = deviceAppInstallerFor(platform, open: open);
  return DeviceAppOffer(
    supported: supported ?? (!kUnderTest && deviceAppSupported()),
    probe: deviceAppProbeFor(platform),
    install: installer.install,
    open: open,
    store: store,
    log: (line) => appLog.info('devices', line),
  );
}
