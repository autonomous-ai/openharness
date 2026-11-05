import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/push_channel.dart';
import 'package:harness_mobile/notify/push_tokens.dart';
import 'package:harness_mobile/notify/system_notices.dart' show SwarmNotices;

import 'viewer_app_fixture.dart';
import 'voice_fakes.dart' show MemoryKeyValueStore;

/// The phone's push address follows the sign-in: told to the backend once the account is known,
/// told again when the OS hands over a new one, taken back — and the OS stopped delivering — when
/// the person signs out. A tapped push opens what the same local notice would.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const apns1 = (token: 'apns-1', platform: 'ios');
  late _Channel channel;
  late MemoryKeyValueStore storage;
  late PushTokens push;

  setUp(() {
    channel = _Channel()..next = apns1;
    storage = MemoryKeyValueStore();
    push = PushTokens(
      channel: channel,
      storage: storage,
      allowed: () async => true,
    );
  });

  test(
    'signed in, the address reaches the backend; signed out, it is taken back',
    () async {
      final rig = viewerApp(pushTokens: push);
      await rig.app.bootstrap();
      await settle();
      expect(rig.api.pushRegistered, [apns1]);

      await rig.app.logout();
      await settle();
      expect(rig.api.pushForgotten, [apns1]);
      expect(channel.forgot, 1);
      rig.app.dispose();
    },
  );

  // A lost phone cut off from another device: no lock-screen notice of the account after it.
  test(
    'a session ended elsewhere stops the OS delivering and forgets the record',
    () async {
      final rig = viewerApp(pushTokens: push);
      await rig.app.bootstrap();
      await settle();
      expect(rig.api.pushRegistered, [apns1]);

      rig.app.authFailureForTest('Your sign-in expired. Sign in again.');
      await settle();
      expect(channel.forgot, 1);
      expect(storage.values, isEmpty);
      rig.app.dispose();
    },
  );

  test(
    'a launch that finds the session gone forgets a token it had told',
    () async {
      await storage.write(
        'push_token_sent_v1',
        '{"account":"acct-1","platform":"ios","token":"apns-1","at":0}',
      );
      final rig = viewerApp(signedIn: false, pushTokens: push);
      await rig.app.bootstrap();
      await settle();
      expect(channel.forgot, 1);
      expect(storage.values, isEmpty);
      rig.app.dispose();
    },
  );

  test('a launch signed out with nothing told leaves the OS alone', () async {
    final rig = viewerApp(signedIn: false, pushTokens: push);
    await rig.app.bootstrap();
    await settle();
    expect(channel.forgot, 0);
    rig.app.dispose();
  });

  test('signed out, nothing reaches the backend', () async {
    final rig = viewerApp(signedIn: false, pushTokens: push);
    await rig.app.bootstrap();
    await settle();
    channel.onChanged!();
    await settle();
    expect(rig.api.pushRegistered, isEmpty);
    rig.app.dispose();
  });

  test('a new address from the OS is told again', () async {
    final rig = viewerApp(pushTokens: push);
    await rig.app.bootstrap();
    await settle();
    channel.next = (token: 'apns-2', platform: 'ios');
    channel.onChanged!();
    await settle();
    expect(rig.api.pushRegistered, [apns1, (token: 'apns-2', platform: 'ios')]);
    rig.app.dispose();
  });

  test('a tapped push opens the chat its link names', () async {
    final rig = viewerApp(pushTokens: push);
    await rig.app.bootstrap();
    await settle();
    channel.onOpened!({'key': 'mention:x1', 'link': 'swarm:s1/c1/message/m1'});
    final notices = rig.app.agentNotices.system as SwarmNotices;
    expect(notices.openedSwarm.value?.conversationId, 'c1');
    expect(notices.openedSwarm.value?.messageId, 'm1');
    rig.app.dispose();
    expect(channel.closed, isTrue);
  });
}

class _Channel extends PushChannel {
  PushAddress? next;
  int forgot = 0;
  bool closed = false;
  void Function(Map<String, String>)? onOpened;
  void Function()? onChanged;

  @override
  Future<PushAddress?> address() async => next;

  @override
  Future<void> forget() async => forgot++;

  @override
  void listen({
    required void Function(Map<String, String> data) onOpened,
    required void Function() onChanged,
  }) {
    this.onOpened = onOpened;
    this.onChanged = onChanged;
  }

  @override
  void close() => closed = true;
}
