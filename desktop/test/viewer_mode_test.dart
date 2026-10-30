import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/viewer_mode.dart';

void main() {
  test('a native Windows build is this computer, like macOS and Linux', () {
    for (final os in ['macos', 'linux', 'windows']) {
      expect(
        viewerModeFor(isWeb: false, viewerBuild: false, operatingSystem: os),
        isFalse,
        reason: os,
      );
    }
  });

  test('the browser, phones and a viewer build stay viewers', () {
    expect(
      viewerModeFor(isWeb: true, viewerBuild: false, operatingSystem: 'web'),
      isTrue,
    );
    expect(
      viewerModeFor(isWeb: false, viewerBuild: false, operatingSystem: 'ios'),
      isTrue,
    );
    expect(
      viewerModeFor(
        isWeb: false,
        viewerBuild: false,
        operatingSystem: 'android',
      ),
      isTrue,
    );
    // The build decides, never the desktop OS.
    expect(
      viewerModeFor(
        isWeb: false,
        viewerBuild: true,
        operatingSystem: 'windows',
      ),
      isTrue,
    );
    expect(
      viewerModeFor(isWeb: false, viewerBuild: true, operatingSystem: 'macos'),
      isTrue,
    );
  });
}
