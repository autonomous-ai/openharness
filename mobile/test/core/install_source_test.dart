import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/install_source.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  late List<String> calls;

  void answer(Object? Function() reply) {
    calls = [];
    messenger.setMockMethodCallHandler(installSourceChannel, (call) async {
      calls.add(call.method);
      return reply();
    });
  }

  tearDown(() {
    messenger.setMockMethodCallHandler(installSourceChannel, null);
    debugDefaultTargetPlatformOverride = null;
  });

  group('installSource', () {
    setUp(() => debugDefaultTargetPlatformOverride = TargetPlatform.iOS);

    test('a sandbox receipt is a tester\'s build', () async {
      answer(() => 'sandbox');
      expect(await installSource(), InstallSource.sandbox);
      expect(calls, ['source']);
    });

    test('the store\'s receipt is the store', () async {
      answer(() => 'store');
      expect(await installSource(), InstallSource.store);
    });

    test(
      'an unknown answer, no answer or a failure reads as the store',
      () async {
        answer(() => 'weird');
        expect(await installSource(), InstallSource.store);
        answer(() => null);
        expect(await installSource(), InstallSource.store);
        answer(() => throw PlatformException(code: 'broken'));
        expect(await installSource(), InstallSource.store);
        messenger.setMockMethodCallHandler(installSourceChannel, null);
        expect(await installSource(), InstallSource.store);
      },
    );

    test('Android is never asked: it reads as the store', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      answer(() => 'sandbox');
      expect(await installSource(), InstallSource.store);
      expect(calls, isEmpty);
    });
  });

  test('measurementChannel: debug, a tester\'s release, the store\'s', () {
    for (final source in InstallSource.values) {
      expect(measurementChannel(release: false, source: source), 'development');
    }
    expect(
      measurementChannel(release: true, source: InstallSource.sandbox),
      'testing',
    );
    expect(
      measurementChannel(release: true, source: InstallSource.store),
      'production',
    );
  });
}
