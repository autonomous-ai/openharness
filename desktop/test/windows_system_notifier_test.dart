// Windows toasts: what the Dart side hands the runner, the tag that lets the
// next toast replace this one, and the click that comes back as a link.
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/notify/system_notifications.dart';

import 'support/memory_key_value_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('harness/notifications');
  late List<MethodCall> calls;
  late Object? Function(MethodCall) reply;

  setUp(() {
    calls = [];
    reply = (_) => 'granted';
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          calls.add(call);
          return reply(call);
        });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  test('posts a toast with its tag and the link its click opens', () async {
    final windows = WindowsSystemNotifier(channel: channel);
    final answer = await windows.show(
      id: 'harness-agent:m1/a1',
      title: 'Fix login',
      body: 'Finished',
      machineId: 'm1',
      agentId: 'a1',
    );
    expect(answer, NotificationPermission.granted);
    expect(calls.single.method, 'show');
    expect(calls.single.arguments, {
      'id': 'harness-agent:m1/a1',
      'title': 'Fix login',
      'body': 'Finished',
      'machineId': 'm1',
      'agentId': 'a1',
      'tag': windowsToastTag('harness-agent:m1/a1'),
      'launch': 'harness://notification/m1/a1',
    });
  });

  test('withdraws by the same tag', () async {
    await WindowsSystemNotifier(channel: channel)
        .withdraw('harness-agent:m1/a1');
    expect(calls.single.method, 'withdraw');
    expect(calls.single.arguments, {
      'id': 'harness-agent:m1/a1',
      'tag': windowsToastTag('harness-agent:m1/a1'),
    });
  });

  test('the tag is FNV-1a over the id, short enough for Windows', () {
    expect(windowsToastTag(''), 'harness-811c9dc5');
    expect(windowsToastTag('a'), 'harness-e40c292c');
    expect(windowsToastTag('foobar'), 'harness-bf9cf968');
    expect(windowsToastTag('á😊'), 'harness-b05d8502');
    expect(
      windowsToastTag('harness-agent:${'m' * 200}/${'a' * 200}').length,
      lessThanOrEqualTo(64),
    );
  });

  test('show preserves encoded agent IDs and the link size fallback', () async {
    final windows = WindowsSystemNotifier(channel: channel);
    await windows.show(
      id: 'harness-agent:m1/a1',
      title: 'Fix login',
      body: 'Finished',
      machineId: 'má/chine',
      agentId: 'a ?#%',
    );
    expect((calls.single.arguments as Map)['tag'], 'harness-159216cc');
    expect(
      (calls.single.arguments as Map)['launch'],
      'harness://notification/m%C3%A1%2Fchine/a%20%3F%23%25',
    );
    calls.clear();
    await windows.show(
      id: 'long',
      title: 'Fix login',
      body: 'Finished',
      machineId: 'm' * 240,
      agentId: 'a1',
    );
    expect((calls.single.arguments as Map)['launch'], 'harness://notification');
  });

  test('show maps runner answers and failures without throwing', () async {
    final windows = WindowsSystemNotifier(channel: channel);
    Future<NotificationPermission> show() => windows.show(
      id: 'id',
      title: 'Fix login',
      body: 'Finished',
      machineId: 'm1',
      agentId: 'a1',
    );
    for (final answer in {
      'granted': NotificationPermission.granted,
      'denied': NotificationPermission.denied,
      'unavailable': NotificationPermission.unavailable,
      'unknown': NotificationPermission.unknown,
      'unexpected': NotificationPermission.unknown,
      null: NotificationPermission.unknown,
    }.entries) {
      reply = (_) => answer.key;
      expect(await show(), answer.value);
    }
    reply = (_) => throw PlatformException(code: 'TOAST_FAILURE');
    expect(await show(), NotificationPermission.unknown);
    expect(await windows.authorize(), NotificationPermission.unknown);
    await expectLater(windows.withdraw('id'), completes);

    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
    expect(await show(), NotificationPermission.unavailable);
    await expectLater(windows.withdraw('id'), completes);
  });

  test('answers as the Mac does', () async {
    reply = (_) => 'unavailable';
    expect(
      await WindowsSystemNotifier(channel: channel).authorize(),
      NotificationPermission.unavailable,
    );
    reply = (_) => 'denied';
    expect(
      await WindowsSystemNotifier(channel: channel).authorize(),
      NotificationPermission.denied,
    );
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
    expect(
      await WindowsSystemNotifier(channel: channel).authorize(),
      NotificationPermission.unavailable,
      reason: 'a runner that does not answer',
    );
  });

  test('a click arrives as a link, and opens the agent', () {
    final windows = WindowsSystemNotifier(channel: channel);
    expect(windows.supported, isTrue);
    expect(windows.clickOpensAgent, isTrue);
    expect(windows.deniedAdvice, contains('Settings ▸ System ▸ Notifications'));
    final system = SystemNotifications(
      store: DesktopNotificationStore(storage: MemoryKeyValueStore()),
      notifier: windows,
    );
    final taps = <String>[];
    system.onTap = (machineId, agentId) => taps.add('$machineId/$agentId');
    system.openLink(NotificationLink.build('m1', 'a1'));
    expect(taps, ['m1/a1']);
  });

  test('each desktop gets its own notifier', () {
    expect(
      platformSystemNotifier(operatingSystem: 'windows'),
      isA<WindowsSystemNotifier>(),
    );
    expect(
      platformSystemNotifier(operatingSystem: 'macos'),
      isA<MacSystemNotifier>(),
    );
    expect(
      platformSystemNotifier(operatingSystem: 'linux'),
      isA<LinuxSystemNotifier>(),
    );
    expect(
      platformSystemNotifier(operatingSystem: 'android'),
      isA<NoSystemNotifier>(),
    );
  });
}
