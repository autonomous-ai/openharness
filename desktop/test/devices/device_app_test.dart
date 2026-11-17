import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/devices/device_app.dart';

void main() {
  test('each step has its line', () {
    expect(
      {for (final s in DeviceAppInstallStep.values) s.name: s.failureLine},
      {
        'manifest': 'Couldn’t download the app.',
        'download': 'Couldn’t download the app.',
        'checksum': 'Couldn’t verify the download.',
        'unpack': 'Couldn’t verify the download.',
        'signature': 'Couldn’t verify the download.',
        'install': 'Couldn’t install the app.',
        'open': 'Installed. Couldn’t open it.',
      },
    );
  });

  test('only macOS 13 or later, and never a viewer build', () {
    bool on(
      String version, {
      TargetPlatform platform = TargetPlatform.macOS,
      bool viewer = false,
    }) => deviceAppSupported(
      platform: platform,
      osVersion: version,
      viewer: viewer,
    );
    expect(on('Version 13.0 (Build 22A380)'), isTrue);
    expect(on('Version 26.6.2 (Build 25G83)'), isTrue);
    expect(on('Version 12.7.6 (Build 21H1320)'), isFalse);
    expect(on(''), isFalse);
    expect(on('6.8.0-45-generic'), isFalse);
    expect(
      on('Version 15.6 (Build 24G84)', platform: TargetPlatform.linux),
      isFalse,
    );
    expect(
      on('Version 15.6 (Build 24G84)', platform: TargetPlatform.windows),
      isFalse,
    );
    expect(on('Version 15.6 (Build 24G84)', viewer: true), isFalse);
  });
}
