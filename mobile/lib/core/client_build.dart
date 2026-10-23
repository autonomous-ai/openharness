import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';

import 'app_version.dart';

/// What the relay socket tells the backend of the build that opened it (`/api/web-ws?client=mobile`), so
/// its count of the phone's opens (`relay_mobile_opens`) can be read by release, and a debug build or a
/// simulator left open cannot pass for the store's. Nothing that tells one phone from another.
///
/// Read by the backend as `?release=` (a plain x.y.z, else the open counts under `unknown`) and
/// `?debug=1` (opens from a debug or simulator build are counted apart, not under a release).
@immutable
class ClientBuild {
  const ClientBuild({this.release, this.debug = false});

  /// The public release (`1.0.9`, no build number), or null where it is not a plain x.y.z.
  final String? release;

  /// A build that is not a release build, or one running in the iOS Simulator.
  final bool debug;

  /// The socket's extra query: nothing for a build that says neither.
  Map<String, String> get query => {
    'release': ?release,
    if (debug) 'debug': '1',
  };
}

final _plainRelease = RegExp(r'^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){2}$');

/// The build, from what the platform says of it. Apart from [runningClientBuild] so a test can name
/// each input.
///
/// A debug or profile build is `debug` (what `flutter run` makes, on a phone, a simulator or an
/// emulator), as is anything running in the iOS Simulator (the simulator's own environment names it).
/// An Android emulator running a release build is not told apart: Android has no such mark without
/// native code.
@visibleForTesting
ClientBuild clientBuildOf({
  required String? version,
  required bool releaseMode,
  required TargetPlatform platform,
  required Map<String, String> environment,
}) => ClientBuild(
  release: version != null && _plainRelease.hasMatch(version) ? version : null,
  debug:
      !releaseMode ||
      (platform == TargetPlatform.iOS &&
          environment.containsKey('SIMULATOR_DEVICE_NAME')),
);

Future<ClientBuild>? _running;

/// This build, read once and kept: the socket asks at every dial, so only the first can wait.
/// Never throws: a version that cannot be read is a release the backend counts as `unknown`.
Future<ClientBuild> runningClientBuild() => _running ??= _read();

Future<ClientBuild> _read() async {
  String? version;
  try {
    version = await runningAppVersion();
  } catch (_) {}
  var environment = const <String, String>{};
  if (!kIsWeb) {
    try {
      environment = Platform.environment;
    } catch (_) {}
  }
  return clientBuildOf(
    version: version,
    releaseMode: kReleaseMode,
    platform: defaultTargetPlatform,
    environment: environment,
  );
}
