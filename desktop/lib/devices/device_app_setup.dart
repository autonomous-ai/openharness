import '../core/local_key_value_store.dart';
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

/// The offer with the real lookup, installer and opener. [supported] defaults to
/// `!kUnderTest && deviceAppSupported()`: under test it shows nothing and never looks.
DeviceAppOffer deviceAppOfferForThisComputer({
  LocalKeyValueStore? store,
  bool? supported,
}) {
  Future<bool> open({String? path}) =>
      openDeviceApp(runDeviceAppTool, path: path);
  final installer = DeviceAppInstaller(
    manifestUrl: deviceAppManifestUrl,
    targetFolders: deviceAppTargetFolders(),
    verifySignature: deviceAppSignedLikeDesktop,
    open: open,
  );
  return DeviceAppOffer(
    supported: supported ?? (!kUnderTest && deviceAppSupported()),
    probe: const ChannelDeviceAppProbe(),
    install: installer.install,
    open: open,
    store: store,
    log: (line) => appLog.info('devices', line),
  );
}
