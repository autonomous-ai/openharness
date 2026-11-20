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

  test(
    'only macOS 13 or later, Windows and Linux, and never a viewer build',
    () {
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
      // Apple documents the string as localized.
      expect(on('バージョン 14.5（ビルド 23F79）'), isTrue);
      expect(on('Versión 12.7.6 (compilación 21H1320)'), isFalse);
      expect(on(''), isFalse);
      expect(on('6.8.0-45-generic'), isFalse);
      expect(on('Version 15.6 (Build 24G84)', viewer: true), isFalse);
      // Desktop's own floor, Windows 10, is the app's.
      for (final windows in [
        '"Windows 11 Pro" 10.0 (Build 22631)',
        '"Windows 10 Pro" 10.0 (Build 19045)',
      ]) {
        expect(on(windows, platform: TargetPlatform.windows), isTrue);
        expect(
          on(windows, platform: TargetPlatform.windows, viewer: true),
          isFalse,
        );
      }
      expect(on('6.8.0-45-generic', platform: TargetPlatform.linux), isTrue);
      expect(
        on('6.8.0-45-generic', platform: TargetPlatform.linux, viewer: true),
        isFalse,
      );
    },
  );

  test("each OS's words", () {
    expect(deviceAppCopy(TargetPlatform.macOS), (
      band: 'Your dial follows apps and terminal tabs with the Harness menu-bar app.',
      title: 'Menu-bar app',
      detail: 'Follows the app and terminal tab in front.',
    ));
    for (final platform in [TargetPlatform.windows, TargetPlatform.linux]) {
      expect(deviceAppCopy(platform), (
        band: 'Your dial follows apps with the Harness tray app.',
        title: 'Tray app',
        detail: 'Follows the app in front.',
      ), reason: '$platform');
    }
  });

  test('the Windows place is under LOCALAPPDATA', () {
    expect(
      deviceAppPlace(
        platform: TargetPlatform.windows,
        environment: {'LocalAppData': r'C:\Users\Nguyễn Văn A\AppData\Local'},
      ),
      r'C:\Users\Nguyễn Văn A\AppData\Local\Harness Device\harness-device.exe',
    );
  });

  test('no absolute LOCALAPPDATA, no place', () {
    for (final environment in [
      <String, String>{},
      {'LOCALAPPDATA': ''},
      {'LOCALAPPDATA': r'AppData\Local'},
    ]) {
      expect(
        deviceAppPlace(
          platform: TargetPlatform.windows,
          environment: environment,
        ),
        isNull,
        reason: '$environment',
      );
    }
  });

  test('the Linux place is beside Desktop\'s own AppImage', () {
    expect(
      deviceAppPlace(
        platform: TargetPlatform.linux,
        environment: {'HOME': '/home/p q'},
      ),
      '/home/p q/.local/opt/Harness-Device.AppImage',
    );
  });

  test('no home, no place', () {
    expect(
      deviceAppPlace(
        platform: TargetPlatform.linux,
        environment: {'HOME': '', 'USERPROFILE': ''},
      ),
      isNull,
    );
  });

  test('macOS has no place', () {
    expect(
      deviceAppPlace(
        platform: TargetPlatform.macOS,
        environment: {
          'HOME': '/Users/p',
          'LOCALAPPDATA': r'C:\Users\p\AppData\Local',
        },
      ),
      isNull,
    );
  });
}
