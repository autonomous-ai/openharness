import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/push_channel.dart';
import 'package:harness_mobile/notify/push_tokens.dart';

import 'viewer_app_fixture.dart';
import 'voice_fakes.dart' show MemoryKeyValueStore;

/// The phone's push address follows the sign-in: told to the backend once the account is known,
/// told again when the OS hands over a new one, taken back — and the OS stopped delivering — when
/// the person signs out. A tapped push opens what the same local notice would.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late _Channel channel;
  late PushTokens push;

  setUp(() {
    channel = _Channel()..next = (token: 'apns-1', platform: 'ios', environment: 'production');
    push = PushTokens(
      channel: channel,
      storage: MemoryKeyValueStore(),
      allowed: () async => true,
      device: () async => 'pub-1',
    );
  });

  test('signed in, the address reaches the backend; signed out, it is taken back', () async {
    final rig = viewerApp(pushTokens: push);
    await rig.app.bootstrap();
    await settle();
    expect(rig.api.pushRegistered.map((a) => a.token), ['apns-1']);

    await rig.app.logout();
    await settle();
    expect(rig.api.pushForgotten, ['apns-1']);
    expect(channel.forgot, 1);
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
    channel.next = (token: 'apns-2', platform: 'ios', environment: 'production');
    channel.onChanged!();
    await settle();
    expect(rig.api.pushRegistered.map((a) => a.token), ['apns-1', 'apns-2']);
    rig.app.dispose();
  });

  test('a tapped push opens the agent it names', () async {
    final rig = viewerApp(pushTokens: push);
    await rig.app.bootstrap();
    await settle();
    channel.onOpened!({'kind': 'agent_question', 'machine': 'm1', 'agent': 'a1'});
    expect(rig.app.agentNotices.system.opened.value, (machineId: 'm1', agentId: 'a1'));
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
