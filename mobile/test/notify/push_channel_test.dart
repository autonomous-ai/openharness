import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/push_channel.dart';

/// `harness/push` as Dart sees it: the address the OS gave, read strictly, and the pushes the person
/// tapped, each handed over once — the one that launched the app included.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const name = 'harness/push';
  const method = MethodChannel(name);
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  late List<MethodCall> calls;
  late List<Object?> waiting;
  late Object? Function(MethodCall call) answer;

  setUp(() {
    calls = [];
    waiting = [];
    answer = (_) => null;
    messenger.setMockMethodCallHandler(method, (call) async {
      calls.add(call);
      if (call.method == 'take') {
        final taken = [...waiting];
        waiting.clear();
        return taken;
      }
      return answer(call);
    });
  });

  tearDown(() => messenger.setMockMethodCallHandler(method, null));

  /// The native side calling Dart, as iOS or Android does.
  Future<void> fromNative(String call) async {
    await messenger.handlePlatformMessage(
      name,
      const StandardMethodCodec().encodeMethodCall(MethodCall(call)),
      (_) {},
    );
  }

  group('address', () {
    test(
      'an iOS or Android token is its platform and token, nothing else',
      () async {
        answer = (_) => {
          'token': 'abc',
          'platform': 'ios',
          'environment': 'sandbox',
        };
        expect(await PushChannel().address(), (token: 'abc', platform: 'ios'));
        answer = (_) => {'token': 'fcm:1', 'platform': 'android'};
        expect(await PushChannel().address(), (
          token: 'fcm:1',
          platform: 'android',
        ));
      },
    );

    test('anything else names no address', () async {
      for (final bad in <Object?>[
        null,
        {'platform': 'ios'},
        {'token': '', 'platform': 'ios'},
        {'token': 'abc', 'platform': 'web'},
        {'token': 'abc'},
      ]) {
        answer = (_) => bad;
        expect(await PushChannel().address(), isNull, reason: '$bad');
      }
    });

    test(
      'the OS refusing (no network, no entitlement) is no address, not a crash',
      () async {
        answer = (_) => throw PlatformException(
          code: 'unregistered',
          message: 'no aps-environment',
        );
        expect(await PushChannel().address(), isNull);
      },
    );

    test('a build with no push side at all is no address', () async {
      messenger.setMockMethodCallHandler(method, null);
      expect(await PushChannel().address(), isNull);
      await PushChannel().forget();
    });
  });

  test('forget asks the OS to stop delivering', () async {
    await PushChannel().forget();
    expect(calls.map((c) => c.method), ['forget']);
  });

  group('tapped pushes', () {
    test(
      'the one that launched the app is taken when Dart starts listening',
      () async {
        waiting.add({'kind': 'swarm', 'swarm': 's1', 'conversation': 'c1'});
        final opened = <Map<String, String>>[];
        PushChannel().listen(onOpened: opened.add, onChanged: () {});
        await pumpEventQueue();
        expect(opened, [
          {'kind': 'swarm', 'swarm': 's1', 'conversation': 'c1'},
        ]);
      },
    );

    test(
      'one tapped while running is taken when the native side says it arrived',
      () async {
        final opened = <Map<String, String>>[];
        PushChannel().listen(onOpened: opened.add, onChanged: () {});
        await pumpEventQueue();
        expect(opened, isEmpty);

        waiting.add({
          'kind': 'agent_done',
          'machine': 'm1',
          'agent': 'a1',
          'aps': {'alert': 'x'},
        });
        await fromNative('arrived');
        await pumpEventQueue();
        expect(opened, [
          {'kind': 'agent_done', 'machine': 'm1', 'agent': 'a1'},
        ], reason: 'values that are not strings are dropped');
      },
    );

    test('a new address from the OS is told', () async {
      var changed = 0;
      PushChannel().listen(onOpened: (_) {}, onChanged: () => changed++);
      await fromNative('changed');
      expect(changed, 1);
    });

    test('after close, what is tapped waits for the next listener', () async {
      final opened = <Map<String, String>>[];
      final channel = PushChannel()
        ..listen(onOpened: opened.add, onChanged: () {});
      await pumpEventQueue();
      channel.close();
      waiting.add({'kind': 'swarm'});
      await fromNative('arrived');
      await pumpEventQueue();
      expect(opened, isEmpty);
      expect(waiting, isNotEmpty);
    });
  });
}
