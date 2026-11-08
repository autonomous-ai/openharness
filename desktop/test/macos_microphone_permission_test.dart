import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// #2665: the composer's mic records on macOS. The app runs with the hardened
/// runtime, which opens the microphone only with the audio-input entitlement,
/// and macOS asks the person only with a usage text (without one it kills the
/// app at the first take).
void main() {
  String plist(String path) => File(path).readAsStringSync();

  bool hasTrue(String plist, String key) => RegExp(
    '<key>${RegExp.escape(key)}</key>\\s*<true/>',
  ).hasMatch(plist);

  for (final file in [
    'macos/Runner/Release.entitlements',
    'macos/Runner/DebugProfile.entitlements',
  ]) {
    test('$file lets the app use the microphone', () {
      expect(
        hasTrue(plist(file), 'com.apple.security.device.audio-input'),
        isTrue,
      );
    });
  }

  test('Info.plist says why Harness asks for the microphone', () {
    final usage = RegExp(
      r'<key>NSMicrophoneUsageDescription</key>\s*<string>([^<]+)</string>',
    ).firstMatch(plist('macos/Runner/Info.plist'));
    expect(usage, isNotNull);
    expect(usage!.group(1), contains('voice message'));
  });
}
