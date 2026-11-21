import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/devices/device_app_manifest.dart';

const _url =
    'https://cdn.autonomous.ai/harness/device/0.1.4/Harness-Device.app.tar.gz';
const _sha256 =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const _size = 12424649;

/// One manifest entry, good unless a field is passed.
Map<String, Object?> entry({
  Object? url = _url,
  Object? sha256 = _sha256,
  Object? size = _size,
}) => {'version': '0.1.4', 'url': url, 'sha256': sha256, 'size': size};

DeviceAppRelease? parse(
  Object? manifest, {
  String architecture = 'arm64',
  TargetPlatform platform = TargetPlatform.macOS,
}) => parseDeviceAppManifest(
  manifest,
  architecture: architecture,
  platform: platform,
);

const _windowsX64Url =
    'https://cdn.autonomous.ai/harness/device/0.2.0/Harness-Device-windows-x64-setup.exe';
const _windowsArm64Url =
    'https://cdn.autonomous.ai/harness/device/0.2.0/Harness-Device-windows-arm64-setup.exe';
const _linuxX64Url =
    'https://cdn.autonomous.ai/harness/device/0.2.0/Harness-Device-linux-x64.AppImage';
const _linuxArm64Url =
    'https://cdn.autonomous.ai/harness/device/0.2.0/Harness-Device-linux-arm64.AppImage';
const _x64Signature = 'x64-signature';
const _arm64Signature = 'arm64-signature';

/// The live manifest's Linux shape: Desktop's entries, and Tauri's
/// `platforms` entries naming the same files with their signatures. A null
/// [version] leaves the entries' `version` out.
Map<String, Object?> linuxManifest({
  Object? x64Url = _linuxX64Url,
  Object? arm64Url = _linuxArm64Url,
  Object? version = '0.2.0',
}) => {
  'version': '0.2.0',
  'platforms': {
    'linux-x86_64': {'url': x64Url, 'signature': _x64Signature},
    'linux-aarch64': {'url': arm64Url, 'signature': _arm64Signature},
  },
  'device-linux-x64-appimage': {
    ...entry(url: _linuxX64Url)..remove('version'),
    'version': ?version,
  },
  'device-linux-arm64-appimage': {
    ...entry(url: _linuxArm64Url)..remove('version'),
    'version': ?version,
  },
};

void main() {
  test('Apple Silicon takes the arm64 entry, then the other', () {
    const arm64Url =
        'https://cdn.autonomous.ai/harness/device/0.1.4/arm64/Harness-Device.app.tar.gz';
    expect(
      parse({
        'device-macos-arm64': entry(url: arm64Url),
        'device-macos': entry(),
      })?.url,
      arm64Url,
    );
    expect(parse({'device-macos': entry()})?.url, _url);
    expect(
      parse({
        'device-macos-arm64': entry(url: arm64Url, size: '12'),
        'device-macos': entry(),
      })?.url,
      _url,
    );
  });

  test('Intel never takes the arm64 entry', () {
    expect(parse({'device-macos-arm64': entry()}, architecture: 'x64'), isNull);
    expect(
      parse({
        'device-macos-arm64': entry(
          url: 'https://cdn.autonomous.ai/harness/device/0.1.4/arm64.tar.gz',
        ),
        'device-macos': entry(),
      }, architecture: 'x64')?.url,
      _url,
    );
  });

  test('Windows arm64 takes its own entry, then x64\'s', () {
    DeviceAppRelease? windows(Map<String, Object?> manifest) =>
        parse(manifest, platform: TargetPlatform.windows);
    expect(
      windows({
        'device-windows-arm64-exe': entry(url: _windowsArm64Url),
        'device-windows-x64-exe': entry(url: _windowsX64Url),
      })?.url,
      _windowsArm64Url,
    );
    expect(
      windows({'device-windows-x64-exe': entry(url: _windowsX64Url)})?.url,
      _windowsX64Url,
    );
    expect(
      windows({
        'device-windows-arm64-exe': entry(url: _windowsArm64Url, size: '12'),
        'device-windows-x64-exe': entry(url: _windowsX64Url),
      })?.url,
      _windowsX64Url,
    );
  });

  test('Windows x64 never takes arm64\'s', () {
    expect(
      parse(
        {'device-windows-arm64-exe': entry(url: _windowsArm64Url)},
        architecture: 'x64',
        platform: TargetPlatform.windows,
      ),
      isNull,
    );
    expect(
      parse(
        {
          'device-windows-arm64-exe': entry(url: _windowsArm64Url),
          'device-windows-x64-exe': entry(url: _windowsX64Url),
        },
        architecture: 'x64',
        platform: TargetPlatform.windows,
      )?.url,
      _windowsX64Url,
    );
  });

  test('Linux takes only its own arch', () {
    final both = {
      'device-linux-arm64-appimage': entry(url: _linuxArm64Url),
      'device-linux-x64-appimage': entry(url: _linuxX64Url),
    };
    expect(parse(both, platform: TargetPlatform.linux)?.url, _linuxArm64Url);
    expect(
      parse(both, architecture: 'x64', platform: TargetPlatform.linux)?.url,
      _linuxX64Url,
    );
    expect(
      parse({
        'device-linux-x64-appimage': entry(url: _linuxX64Url),
      }, platform: TargetPlatform.linux),
      isNull,
    );
    expect(
      parse(
        {'device-linux-arm64-appimage': entry(url: _linuxArm64Url)},
        architecture: 'x64',
        platform: TargetPlatform.linux,
      ),
      isNull,
    );
  });

  test('Linux takes the Tauri signature of the same file from platforms', () {
    final x64 = parse(
      linuxManifest(),
      architecture: 'x64',
      platform: TargetPlatform.linux,
    );
    expect(x64?.url, _linuxX64Url);
    expect(x64?.signature, _x64Signature);
    expect(x64?.version, '0.2.0');
    final arm64 = parse(linuxManifest(), platform: TargetPlatform.linux);
    expect(arm64?.url, _linuxArm64Url);
    expect(arm64?.signature, _arm64Signature);
    expect(arm64?.version, '0.2.0');
  });

  test('a platforms url naming another file gives no signature', () {
    for (final url in [
      'https://cdn.autonomous.ai/harness/device/0.1.9/Harness-Device-linux-x64.AppImage',
      _linuxX64Url.toUpperCase(),
      '$_linuxX64Url/',
    ]) {
      final release = parse(
        linuxManifest(x64Url: url),
        architecture: 'x64',
        platform: TargetPlatform.linux,
      );
      expect(release?.url, _linuxX64Url, reason: url);
      expect(release?.signature, isNull, reason: url);
    }
  });

  test('the other arch\'s platforms entry gives no signature', () {
    final manifest = linuxManifest();
    (manifest['platforms'] as Map).remove('linux-x86_64');
    final release = parse(
      manifest,
      architecture: 'x64',
      platform: TargetPlatform.linux,
    );
    expect(release?.url, _linuxX64Url);
    expect(release?.signature, isNull);
  });

  test('an entry with no version, or not X.Y.Z, gives no signature', () {
    for (final version in [null, '0.2']) {
      final release = parse(
        linuxManifest(version: version),
        architecture: 'x64',
        platform: TargetPlatform.linux,
      );
      expect(release?.url, _linuxX64Url, reason: '$version');
      expect(release?.version, isNull, reason: '$version');
      expect(release?.signature, isNull, reason: '$version');
    }
  });

  test('macOS and Windows releases carry no signature', () {
    final mac = parse({
      'platforms': {
        'darwin-aarch64': {'url': _url, 'signature': 'sig'},
      },
      'device-macos': entry(),
    });
    expect(mac?.url, _url);
    expect(mac?.version, '0.1.4');
    expect(mac?.signature, isNull);
    final windows = parse(
      {
        'platforms': {
          'windows-x86_64': {'url': _windowsX64Url, 'signature': 'sig'},
        },
        'device-windows-x64-exe': entry(url: _windowsX64Url),
      },
      architecture: 'x64',
      platform: TargetPlatform.windows,
    );
    expect(windows?.url, _windowsX64Url);
    expect(windows?.signature, isNull);
  });

  test('a Mac never takes a Windows or Linux entry', () {
    final others = {
      'device-windows-arm64-exe': entry(url: _windowsArm64Url),
      'device-windows-x64-exe': entry(url: _windowsX64Url),
      'device-linux-arm64-appimage': entry(url: _linuxArm64Url),
      'device-linux-x64-appimage': entry(url: _linuxX64Url),
    };
    for (final architecture in ['arm64', 'x64']) {
      expect(parse(others, architecture: architecture), isNull);
    }
  });

  test('Windows and Linux never take a macOS entry', () {
    final mac = {'device-macos-arm64': entry(), 'device-macos': entry()};
    for (final platform in [TargetPlatform.windows, TargetPlatform.linux]) {
      for (final architecture in ['arm64', 'x64']) {
        expect(
          parse(mac, architecture: architecture, platform: platform),
          isNull,
          reason: '$platform $architecture',
        );
      }
    }
  });

  test('another platform takes no entry', () {
    final all = {
      'device-macos': entry(),
      'device-windows-x64-exe': entry(url: _windowsX64Url),
      'device-linux-x64-appimage': entry(url: _linuxX64Url),
    };
    for (final platform in [
      TargetPlatform.android,
      TargetPlatform.iOS,
      TargetPlatform.fuchsia,
    ]) {
      expect(parse(all, architecture: 'x64', platform: platform), isNull);
    }
  });

  test('the live manifest\'s shape: the archive, never the dmg', () {
    const dmg =
        'https://cdn.autonomous.ai/harness/device/0.1.4/Harness-Device.dmg';
    final manifest = {
      'version': '0.1.4',
      'notes': 'Harness Device 0.1.4',
      'pub_date': '2026-11-16T10:00:00Z',
      'platforms': {
        'darwin-aarch64': {'url': _url, 'signature': 'sig'},
        'darwin-x86_64': {'url': _url, 'signature': 'sig'},
      },
      'device-macos': entry(),
      'device-macos-dmg': entry(url: dmg, size: 12345678),
      'device-macos-arm64': entry(),
      'device-macos-arm64-dmg': entry(url: dmg, size: 12345678),
    };
    for (final architecture in ['arm64', 'x64']) {
      final release = parse(manifest, architecture: architecture);
      expect(release?.url, _url, reason: architecture);
      expect(release?.sha256, _sha256, reason: architecture);
      expect(release?.size, _size, reason: architecture);
    }
  });

  test('both prefixes are allowed', () {
    for (final url in [
      'https://cdn.autonomous.ai/harness/device/0.1.4/Harness-Device.app.tar.gz',
      'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/0.1.4/Harness-Device.app.tar.gz',
    ]) {
      expect(parse({'device-macos': entry(url: url)})?.url, url);
    }
  });

  test('a URL outside the prefixes is refused', () {
    for (final url in [
      'http://cdn.autonomous.ai/harness/device/a.tar.gz',
      'https://cdn.autonomous.ai/harness/desktop/a.zip',
      'https://cdn.autonomous.ai.evil.example/harness/device/a.tar.gz',
      'https://cdn.autonomous.ai@evil.example/harness/device/a.tar.gz',
      'https://cdn.autonomous.ai/harness/device/../desktop/a.zip',
      'https://cdn.autonomous.ai/harness/device/%2e%2e/desktop/a.zip',
      'https://cdn.autonomous.ai/harness/device/..%2Fdesktop/a.zip',
      'https://cdn.autonomous.ai/harness/device/..%5Cdesktop/a.zip',
      'https://cdn.autonomous.ai/harness/device/%252e%252e/desktop/a.zip',
      'https://cdn.autonomous.ai/harness/device/a.tar.gz%3Fx=1',
      'https://cdn.autonomous.ai/harness/device/a.tar.gz?x=1',
      'https://cdn.autonomous.ai/harness/device/a.tar.gz#x',
      'https://cdn.autonomous.ai:8443/harness/device/a.tar.gz',
      r'https://cdn.autonomous.ai/harness/device/..\desktop/a.zip',
      '',
      7,
    ]) {
      expect(parse({'device-macos': entry(url: url)}), isNull, reason: '$url');
      expect(
        parse(
          {'device-windows-x64-exe': entry(url: url)},
          architecture: 'x64',
          platform: TargetPlatform.windows,
        ),
        isNull,
        reason: 'windows $url',
      );
      expect(
        parse({
          'device-linux-arm64-appimage': entry(url: url),
        }, platform: TargetPlatform.linux),
        isNull,
        reason: 'linux $url',
      );
    }
  });

  test('a sha256 that is not 64 hex digits is refused', () {
    for (final sha256 in ['a' * 63, 'a' * 65, 'g' * 64, null]) {
      expect(
        parse({'device-macos': entry(sha256: sha256)}),
        isNull,
        reason: '$sha256',
      );
    }
    expect(parse({'device-macos': entry(sha256: 'A' * 64)})?.sha256, 'a' * 64);
  });

  test('a size outside 1 byte to 200 MB is refused', () {
    for (final size in [
      0,
      -1,
      deviceAppMaxBytes + 1,
      12424649.0,
      '12424649',
      null,
    ]) {
      expect(
        parse({'device-macos': entry(size: size)}),
        isNull,
        reason: '$size',
      );
    }
    for (final size in [1, deviceAppMaxBytes]) {
      expect(parse({'device-macos': entry(size: size)})?.size, size);
    }
  });

  test('a manifest that is not an object is refused', () {
    for (final manifest in [
      null,
      <Object?>[],
      '<html>',
      {'device-macos': 'x'},
    ]) {
      expect(parse(manifest), isNull, reason: '$manifest');
    }
  });
}
