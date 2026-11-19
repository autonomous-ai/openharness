import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/devices/device_app_probe.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const applications = '/Applications/Harness Device.app';
  const trash = '/Users/a/.Trash/Harness Device.app';
  const volumeTrash = '/Volumes/X/.Trashes/501/Harness Device.app';
  const diskImage = '/Volumes/Harness Device/Harness Device.app';

  Future<bool> Function(String) existing(Set<String> paths) =>
      (path) async => paths.contains(path);

  Future<bool> installed(List<String> paths, {Set<String>? exists}) =>
      deviceAppInstalledAt(paths, exists: existing(exists ?? paths.toSet()));

  group('which copy counts as installed', () {
    test('a copy in Applications counts', () async {
      expect(await installed([applications]), isTrue);
      expect(
        await installed(['/Users/a/Applications/Harness Device.app']),
        isTrue,
      );
    });

    test('a copy in a Trash does not count', () async {
      expect(await installed([trash]), isFalse);
      expect(await installed([volumeTrash]), isFalse);
    });

    test('a copy under /Volumes/ does not count', () async {
      expect(await installed([diskImage]), isFalse);
    });

    test('a path that is gone does not count', () async {
      expect(await installed([applications], exists: {}), isFalse);
    });

    test('one good copy among others is enough', () async {
      expect(await installed([trash, diskImage, applications]), isTrue);
      expect(await installed([]), isFalse);
    });

    test('a folder that only looks like a Trash counts', () async {
      expect(
        await installed(['/Users/a/Apps.Trash/Harness Device.app']),
        isTrue,
      );
      expect(await installed(['/Users/a/VolumesX/Harness Device.app']), isTrue);
    });

    test('the real check reads the disk', () async {
      final dir = await Directory.systemTemp.createTemp('device_app_probe');
      addTearDown(() => dir.delete(recursive: true));
      final app = await Directory('${dir.path}/Harness Device.app').create();
      expect(await deviceAppInstalledAt([app.path]), isTrue);
      await app.delete(recursive: true);
      expect(await deviceAppInstalledAt([app.path]), isFalse);
    });
  });

  group('the channel', () {
    const channel = MethodChannel('harness/device_app');
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    final probe = ChannelDeviceAppProbe(
      exists: existing({trash, applications}),
    );

    void reply(Object? value, [List<MethodCall>? calls]) =>
        messenger.setMockMethodCallHandler(channel, (call) async {
          calls?.add(call);
          return value;
        });

    tearDown(() => messenger.setMockMethodCallHandler(channel, null));

    test('asks lookup, with no argument, and filters the paths', () async {
      final calls = <MethodCall>[];
      reply({
        'paths': [trash, applications],
        'running': false,
      }, calls);
      final presence = await probe.lookup();
      expect(calls, hasLength(1));
      expect(calls.single.method, 'lookup');
      expect(calls.single.arguments, isNull);
      expect(presence.installed, isTrue);
      expect(presence.running, isFalse);

      reply({
        'paths': [trash],
        'running': false,
      });
      expect((await probe.lookup()).installed, isFalse);
    });

    test('running is read as it comes', () async {
      reply({'paths': <String>[], 'running': true});
      final presence = await probe.lookup();
      expect(presence.installed, isFalse);
      expect(presence.running, isTrue);
    });

    test('a reply of the wrong shape is refused', () async {
      for (final value in <Object?>[
        {'paths': <String>[]},
        {'running': false},
        {'paths': applications, 'running': false},
        {
          'paths': [7],
          'running': false,
        },
        {'paths': <String>[], 'running': 0},
        {'installed': true, 'running': false},
        'yes',
        null,
      ]) {
        reply(value);
        await expectLater(
          probe.lookup(),
          throwsA(isA<FormatException>()),
          reason: '$value',
        );
      }
    });

    test('a Mac whose app has no such channel throws', () async {
      await expectLater(probe.lookup(), throwsA(isA<MissingPluginException>()));
    });
  });
}
