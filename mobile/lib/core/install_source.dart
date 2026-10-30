import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// Where this build was installed from, as far as the phone can tell — for its measurement context's
/// channel ([measurementChannel]), so a tester's counts are kept apart from the store's.
///
/// Over `harness/install_source` (ios/Runner/AppDelegate.swift): an App Store build's receipt is named
/// `receipt`, any other build's — TestFlight, one Xcode installed — `sandboxReceipt`. iOS only: on
/// Android a Play internal test installs exactly as the store release it becomes, so it reads as the
/// store, as does anything that does not answer.
enum InstallSource { store, sandbox }

@visibleForTesting
const installSourceChannel = MethodChannel('harness/install_source');

Future<InstallSource> installSource() async {
  if (kIsWeb || defaultTargetPlatform != TargetPlatform.iOS) {
    return InstallSource.store;
  }
  try {
    final source = await installSourceChannel.invokeMethod<String>('source');
    return source == 'sandbox' ? InstallSource.sandbox : InstallSource.store;
  } catch (_) {
    return InstallSource.store;
  }
}

/// The measurement context's channel (backend `ProductUsageContext.channel`): a debug build is
/// `development`, which the backend does not keep; a release build from anywhere but the store is
/// `testing`, which it keeps apart; the store's is `production`.
String measurementChannel({
  required bool release,
  required InstallSource source,
}) => !release
    ? 'development'
    : source == InstallSource.sandbox
    ? 'testing'
    : 'production';
