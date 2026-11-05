import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/push_registration.dart';
import 'package:harness_mobile/notify/system_notices.dart';

/// A phone's push token goes to the server while it is signed in, and comes
/// back off it at sign-out; a tapped push opens what it links (task #2905).
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('harness/push');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  late Object? token;
  late List<String> delivered;
  late String? launchLink;
  late List<(String, String, String)> server;
  late bool dropHangs;
  late List<SwarmNoticeTarget> opened;

  PushRegistration make() => PushRegistration(
    register: (platform, token) async {
      server.add(('register', platform, token));
      return true;
    },
    drop: (platform, token) async {
      server.add(('drop', platform, token));
      if (dropHangs) await Completer<void>().future;
      return true;
    },
    open: opened.add,
    dropTimeout: const Duration(milliseconds: 20),
  );

  /// What the phone's native side says, as it says it.
  Future<void> fromNative(String method, Object? arguments) =>
      messenger.handlePlatformMessage(
        channel.name,
        const StandardMethodCodec().encodeMethodCall(
          MethodCall(method, arguments),
        ),
        (_) {},
      );

  setUp(() {
    token = {'platform': 'ios', 'token': 'ab01'};
    delivered = [];
    launchLink = null;
    server = [];
    dropHangs = false;
    opened = [];
    messenger.setMockMethodCallHandler(channel, (call) async {
      return switch (call.method) {
        'token' => token,
        'delivered' => delivered,
        'launchLink' => launchLink,
        _ => null,
      };
    });
  });
  tearDown(() => messenger.setMockMethodCallHandler(channel, null));

  test('sends the phone\'s token when signed in', () async {
    final push = make();
    await push.start();
    await push.signedIn();
    expect(server, [('register', 'ios', 'ab01')]);
  });

  test('sends nothing when the phone has no token', () async {
    token = null;
    final push = make();
    await push.start();
    await push.signedIn();
    expect(server, isEmpty);
  });

  test('sends nothing on a phone without the native side', () async {
    messenger.setMockMethodCallHandler(channel, null);
    final push = make();
    await push.start();
    await push.signedIn();
    expect(server, isEmpty);
    expect(await push.deliveredKeys(), isEmpty);
  });

  test('sends a new token while signed in, and none after signing out', () async {
    final push = make();
    await push.start();
    await push.signedIn();
    await fromNative('token', {'platform': 'ios', 'token': 'cd02'});
    await push.signedOut();
    await fromNative('token', {'platform': 'ios', 'token': 'ef03'});
    expect(server, [
      ('register', 'ios', 'ab01'),
      ('register', 'ios', 'cd02'),
      ('drop', 'ios', 'cd02'),
    ]);
  });

  test('takes the token off the server at sign-out, and stops waiting after the timeout', () async {
    dropHangs = true;
    final push = make();
    await push.start();
    await push.signedIn();
    await push.signedOut();
    expect(server.last, ('drop', 'ios', 'ab01'));
  });

  test('a sign-out with nothing registered drops nothing', () async {
    final push = make();
    await push.start();
    await push.signedOut();
    expect(server, isEmpty);
  });

  test('opens what a tapped push links, at the reply in its thread', () async {
    final push = make();
    await push.start();
    await fromNative('opened', {'link': 'swarm:tab/conv/message/m1/thread/root'});
    expect(opened, [
      (swarmId: 'tab', conversationId: 'conv', messageId: 'm1', decisionId: null, threadId: 'root'),
    ]);
  });

  test('opens the push whose tap launched the app', () async {
    launchLink = 'swarm:tab/conv/message/m1';
    final push = make();
    await push.start();
    expect(opened.single.messageId, 'm1');
  });

  test('opens nothing for a link it cannot read', () async {
    final push = make();
    await push.start();
    await fromNative('opened', {'link': 'https://example.com'});
    await fromNative('opened', {'link': 42});
    expect(opened, isEmpty);
  });

  test('lists the keys of pushes already in the notification centre', () async {
    delivered = ['reply:tab:row1', 'mention:t1'];
    expect(await make().deliveredKeys(), {'reply:tab:row1', 'mention:t1'});
  });
}
