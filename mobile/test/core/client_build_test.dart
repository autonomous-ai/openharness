import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/client_build.dart';

void main() {
  ClientBuild build({
    String? version = '1.0.9',
    bool releaseMode = true,
    TargetPlatform platform = TargetPlatform.iOS,
    Map<String, String> environment = const {},
  }) => clientBuildOf(
    version: version,
    releaseMode: releaseMode,
    platform: platform,
    environment: environment,
  );

  group('what the socket says of the build', () {
    test('a release build says its release and nothing else', () {
      expect(build().release, '1.0.9');
      expect(build().debug, isFalse);
      expect(build().query, {'release': '1.0.9'});
      expect(build(platform: TargetPlatform.android).query, {
        'release': '1.0.9',
      });
    });

    test('a debug or profile build says so', () {
      final debug = build(releaseMode: false);
      expect(debug.debug, isTrue);
      expect(debug.query, {'release': '1.0.9', 'debug': '1'});
      expect(
        build(releaseMode: false, platform: TargetPlatform.android).debug,
        isTrue,
      );
    });

    test('the iOS Simulator says so, whatever the build', () {
      final simulator = build(environment: {'SIMULATOR_DEVICE_NAME': 'iPhone'});
      expect(simulator.debug, isTrue);
      expect(simulator.query, {'release': '1.0.9', 'debug': '1'});
    });

    test(
      'that environment means nothing off iOS, and its absence nothing on it',
      () {
        expect(
          build(
            platform: TargetPlatform.android,
            environment: {'SIMULATOR_DEVICE_NAME': 'x'},
          ).debug,
          isFalse,
        );
        expect(build(environment: {'HOME': '/private'}).debug, isFalse);
      },
    );

    test('a version that is not a plain x.y.z is no release', () {
      for (final version in [
        null,
        '',
        '1.0',
        '1.0.9+72',
        '1.0.9-beta',
        '1.0.9.1',
        '01.0.9',
        '1000.0.0',
        'PRIVATE',
      ]) {
        expect(build(version: version).release, isNull, reason: '$version');
        expect(build(version: version).query, isEmpty, reason: '$version');
      }
    });

    test('says nothing that tells one phone from another', () {
      final query = build(
        releaseMode: false,
        environment: {'SIMULATOR_DEVICE_NAME': 'PRIVATE_NAME', 'USER': 'pat'},
      ).query;
      expect(query.keys, ['release', 'debug']);
      expect(query.values.join(), isNot(contains('PRIVATE')));
    });
  });

  test('the running build is read once and never fails', () async {
    final first = runningClientBuild();
    expect(runningClientBuild(), same(first));
    // Under test the platform has no package info: no release, and not a release build.
    final read = await first;
    expect(read.release, isNull);
    expect(read.debug, isTrue);
  });
}
