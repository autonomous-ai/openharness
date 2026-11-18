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

DeviceAppRelease? parse(Object? manifest, {String architecture = 'arm64'}) =>
    parseDeviceAppManifest(manifest, architecture: architecture);

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
