import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/last_opened_agent.dart' show AgentRef;
import 'package:harness_mobile/notify/agent_notice.dart';
import 'package:harness_mobile/notify/system_notices.dart';

/// The OS notification centre as the phone drives it, with the plugin faked at
/// its Dart surface — no platform channel is ever reached.
///
/// What matters is what a person sees on the lock screen and what a tap on it
/// opens: one notice per agent that newer news replaces, a channel per kind so
/// questions can be heard while finished turns are silenced, the machine on
/// the second line, and a tap that leads back to exactly that agent — even the
/// tap that launched the app from cold.
void main() {
  const ref = (machineId: 'machine-1', agentId: 'agent-7');

  AgentNoticeMessage message(
    NoticeKind kind, {
    String body = 'Fixed it.',
    bool quiet = false,
  }) => (
    agent: ref,
    kind: kind,
    title: 'Fix login',
    machine: 'MacBook',
    body: body,
    quiet: quiet,
  );

  late _FakePlugin plugin;
  late LocalSystemNotices notices;

  setUp(() {
    plugin = _FakePlugin();
    notices = LocalSystemNotices(plugin);
  });

  test('a new device on the account: its own channel, replaced by its own key, opening no agent', () async {
    await notices.showAccountNotice(key: 'pub-1', title: 'New device on your account', body: 'iPad signed in.');
    await notices.showAccountNotice(key: 'pub-1', title: 'New device on your account', body: 'iPad signed in.');
    expect(plugin.shown.map((n) => n.id).toSet(), {accountNoticeIdFor('pub-1')});
    expect(accountNoticeIdFor('pub-1'), isNot(noticeIdFor(ref)));
    final shown = plugin.shown.first;
    expect(shown.title, 'New device on your account');
    expect(shown.details!.android!.channelId, 'account-device');
    expect(shown.details!.iOS!.threadIdentifier, 'account-device');
    expect(decodeAgentPayload(shown.payload), isNull);
    // A tap opens that device's page: the payload names the device, never an agent.
    expect(shown.payload, 'device:pub-1');
  });

  test('a tap on a device notice opens that device, not an agent', () async {
    await notices.showAccountNotice(key: 'pub-1', title: 'New device on your account', body: 'iPad signed in.');
    plugin.onResponse!(
      const NotificationResponse(
        notificationResponseType: NotificationResponseType.selectedNotification,
        payload: 'device:pub-1',
      ),
    );
    expect(notices.openedDevice.value, 'pub-1');
    expect(notices.opened.value, isNull);
  });

  test('a tap on an agent notice opens no device', () async {
    await notices.show(message(NoticeKind.done));
    plugin.onResponse!(
      NotificationResponse(
        notificationResponseType: NotificationResponseType.selectedNotification,
        payload: encodeAgentPayload(ref),
      ),
    );
    expect(notices.opened.value, ref);
    expect(notices.openedDevice.value, isNull);
  });

  group('a Swarm notice', () {
    const target = (swarmId: 'tab-1', conversationId: 'g9', messageId: null, decisionId: null, threadId: null);
    const swarm = (
      key: 'decision:d1',
      title: 'River asks you',
      subtitle: 'Mobile',
      body: 'Open Harness to answer.',
      target: target,
    );

    test('its own channel, where it is on the second line, replaced by its own key', () async {
      await notices.showSwarm(swarm);
      await notices.showSwarm(swarm);

      expect(plugin.shown.map((n) => n.id).toSet(), {swarmNoticeIdFor('decision:d1')});
      final shown = plugin.shown.first;
      expect(shown.title, 'River asks you');
      expect(shown.body, 'Open Harness to answer.');
      expect(shown.details!.android!.channelId, 'swarm-needs-you');
      expect(shown.details!.android!.subText, 'Mobile');
      expect(shown.details!.iOS!.subtitle, 'Mobile');
      expect(shown.details!.iOS!.threadIdentifier, 'swarm-needs-you');
      expect(decodeAgentPayload(shown.payload), isNull);
    });

    test('a locked phone that hides private content hides it', () async {
      await notices.showSwarm(swarm);
      final shown = plugin.shown.single;

      // Android: content hidden on a secure lock screen that hides it.
      expect(shown.details!.android!.visibility, NotificationVisibility.private);
      // iOS: when previews are hidden, who asks and where still show.
      expect(shown.details!.iOS!.categoryIdentifier, 'swarm-needs-you');
      final category = plugin.settings!.iOS!.notificationCategories.singleWhere(
        (c) => c.identifier == 'swarm-needs-you',
      );
      expect(category.options, {
        DarwinNotificationCategoryOption.hiddenPreviewShowTitle,
        DarwinNotificationCategoryOption.hiddenPreviewShowSubtitle,
      });
    });

    test('a tap opens that conversation, and no agent or device', () async {
      await notices.showSwarm(swarm);
      plugin.onResponse!(
        NotificationResponse(
          notificationResponseType: NotificationResponseType.selectedNotification,
          payload: plugin.shown.single.payload,
        ),
      );
      expect(notices.openedSwarm.value, target);
      expect(notices.opened.value, isNull);
      expect(notices.openedDevice.value, isNull);
    });

    test('the tap that launched the app from cold opens it too', () async {
      plugin.launch = NotificationAppLaunchDetails(
        true,
        notificationResponse: NotificationResponse(
          notificationResponseType: NotificationResponseType.selectedNotification,
          payload: encodeSwarmPayload(target),
        ),
      );
      await notices.requestPermission();
      expect(notices.openedSwarm.value, target);
    });

    test('a tap on a thread notice brings back its thread', () async {
      const inThread = (swarmId: 'tab-1', conversationId: 'g9', messageId: 'reply-r2', decisionId: null, threadId: 'root-1');
      expect(decodeSwarmPayload(encodeSwarmPayload(inThread)), inThread);
    });

    test('taking it down cancels its own id', () async {
      await notices.cancelSwarm('decision:d1');
      expect(plugin.cancelled, [swarmNoticeIdFor('decision:d1')]);
    });

    test('a plugin that fails never throws into the Swarm', () async {
      plugin.failShow = true;
      plugin.failCancel = true;
      await notices.showSwarm(swarm);
      await notices.cancelSwarm('decision:d1');
      expect(plugin.shown, isEmpty);
    });

    // The server's push (backend push/fcm.ts) is a notification Android draws itself on this channel
    // while the app is away. Not made yet, Android puts it on FCM's own "Misc" channel instead: no
    // heads-up, and out of reach of the Swarm switch in Settings.
    test('its channel is made at start, before any push can land on it, as its notices use it', () async {
      // The phone asks whether notices are allowed before it registers for pushes.
      await notices.requestPermission();
      final channel = plugin.android.channels.single;
      expect(channel.id, 'swarm-needs-you');
      expect(channel.importance, Importance.high);

      await notices.showSwarm(swarm);
      await notices.showSwarm(swarm);
      // Made once per start, not once per notice.
      expect(plugin.android.channels, hasLength(1));
      final posted = plugin.shown.first.details!.android!;
      expect(posted.channelId, channel.id);
      expect(posted.channelName, channel.name);
      expect(posted.channelDescription, channel.description);
      expect(posted.importance, channel.importance);
    });

    test('a channel that cannot be made leaves every notice working', () async {
      plugin.android.failChannel = true;
      expect(await notices.requestPermission(), isTrue);
      await notices.showSwarm(swarm);
      expect(plugin.shown, hasLength(1));
      // The start counts as done: it is not tried again for each notice.
      expect(plugin.initialized, 1);
    });
  });

  test('nothing starts until a notice is first needed', () {
    expect(plugin.initialized, 0);
    // The app's own, over the real plugin: building it reaches no platform.
    expect(LocalSystemNotices().opened.value, isNull);
  });

  test(
    'a finished turn: the agent, its machine, its news, on the done channel',
    () async {
      await notices.show(message(NoticeKind.done));
      final shown = plugin.shown.single;
      expect(shown.id, noticeIdFor(ref));
      expect(shown.title, 'Fix login');
      expect(shown.body, 'Fixed it.');
      expect(decodeAgentPayload(shown.payload), ref);
      final android = shown.details!.android!;
      expect(android.channelId, 'agent-done');
      expect(android.subText, 'MacBook');
      expect(android.importance, Importance.high);
      final ios = shown.details!.iOS!;
      expect(ios.subtitle, 'MacBook');
      expect(ios.threadIdentifier, 'agent-done');
      // Asked for explicitly in `requestPermission`, never by the first notice.
      final settings = plugin.settings!.iOS!;
      expect(settings.requestAlertPermission, isFalse);
      expect(settings.requestSoundPermission, isFalse);
      expect(settings.requestBadgePermission, isFalse);
    },
  );

  test(
    'a question rides a channel of its own, so it can be heard alone',
    () async {
      await notices.show(
        message(NoticeKind.question, body: 'Approve Bash command: rm -rf dist'),
      );
      final shown = plugin.shown.single;
      expect(shown.details!.android!.channelId, 'agent-question');
      expect(shown.details!.android!.channelName, 'Agent needs you');
      expect(shown.details!.iOS!.threadIdentifier, 'agent-question');
      expect(shown.body, 'Approve Bash command: rm -rf dist');
    },
  );

  test('a loud notice keeps the channel\'s sound, vibration and banner', () async {
    await notices.show(message(NoticeKind.question));
    final shown = plugin.shown.single;
    expect(shown.details!.android!.silent, isFalse);
    final ios = shown.details!.iOS!;
    expect(ios.presentSound, isNull, reason: 'the plugin default: sound');
    expect(ios.presentBanner, isNull, reason: 'the plugin default: a banner');
    expect(ios.interruptionLevel, isNull);
  });

  test('a quiet notice: no sound, no vibration, no banner — only the list', () async {
    await notices.show(
      message(NoticeKind.question, body: 'Approve Bash command: npm test', quiet: true),
    );
    final shown = plugin.shown.single;
    expect(shown.id, noticeIdFor(ref), reason: 'it replaces the agent\'s notice');
    expect(shown.body, 'Approve Bash command: npm test');
    expect(shown.details!.android!.channelId, 'agent-question');
    expect(shown.details!.android!.silent, isTrue);
    final ios = shown.details!.iOS!;
    expect(ios.presentSound, isFalse);
    expect(ios.presentBanner, isFalse);
    expect(ios.interruptionLevel, InterruptionLevel.passive);
    expect(ios.threadIdentifier, 'agent-question');
  });

  test('newer news about the same agent replaces its notice', () async {
    await notices.show(message(NoticeKind.done));
    await notices.show(message(NoticeKind.question));
    expect(plugin.shown.map((s) => s.id).toSet(), {noticeIdFor(ref)});
    // And the plugin is started once, not per notice.
    expect(plugin.initialized, 1);
  });

  test('taking a notice down cancels that agent\'s id', () async {
    await notices.cancel(ref);
    expect(plugin.cancelled, [noticeIdFor(ref)]);
  });

  test('asking permission asks both platforms for alerts, sound and the icon count', () async {
    await notices.requestPermission();
    expect(plugin.ios.asked, [(alert: true, sound: true, badge: true)]);
    expect(plugin.android.asked, 1);
  });

  test('a tap on a notice opens its agent', () async {
    await notices.show(message(NoticeKind.done));
    plugin.onResponse!(
      NotificationResponse(
        notificationResponseType: NotificationResponseType.selectedNotification,
        payload: encodeAgentPayload(ref),
      ),
    );
    expect(notices.opened.value, ref);
  });

  test('a tap carrying something that is not ours opens nothing', () async {
    await notices.show(message(NoticeKind.done));
    plugin.onResponse!(
      const NotificationResponse(
        notificationResponseType: NotificationResponseType.selectedNotification,
        payload: 'not an agent',
      ),
    );
    expect(notices.opened.value, isNull);
  });

  test('the tap that launched the app from cold opens its agent too', () async {
    plugin.launch = NotificationAppLaunchDetails(
      true,
      notificationResponse: NotificationResponse(
        notificationResponseType: NotificationResponseType.selectedNotification,
        payload: encodeAgentPayload(ref),
      ),
    );
    await notices.requestPermission();
    expect(notices.opened.value, ref);
  });

  test('a launch that was not a tap opens nothing', () async {
    plugin.launch = const NotificationAppLaunchDetails(false);
    await notices.cancel(ref);
    expect(notices.opened.value, isNull);
  });

  group("the app icon's count", () {
    const channel = MethodChannel('harness/app_badge');
    late List<MethodCall> calls;
    var fail = false;

    setUp(() {
      TestWidgetsFlutterBinding.ensureInitialized();
      calls = [];
      fail = false;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
        if (fail) throw PlatformException(code: 'badge');
        calls.add(call);
        return null;
      });
    });

    tearDown(() {
      debugDefaultTargetPlatformOverride = null;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null);
    });

    test('is set on the icon on iOS', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      await notices.setSwarmBadge(3);
      await notices.setSwarmBadge(0);
      expect(calls.map((c) => (c.method, c.arguments)), [('set', 3), ('set', 0)]);
    });

    test('is left alone on Android, whose launchers show a dot from the notices', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      await notices.setSwarmBadge(3);
      expect(calls, isEmpty);
    });

    test('a platform that fails never throws into the Swarm', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      fail = true;
      await notices.setSwarmBadge(3);
      expect(calls, isEmpty);
    });
  });

  group('a plugin that fails', () {
    test('never throws into the notifier', () async {
      plugin.failShow = true;
      plugin.failCancel = true;
      plugin.ios.fail = true;
      await notices.show(message(NoticeKind.done));
      await notices.cancel(ref);
      await notices.requestPermission();
      expect(plugin.shown, isEmpty);
    });

    test('a start that failed once is tried again, not cached', () async {
      // The start is kept as one future so every later call shares it. A
      // start that THREW was kept the same way — so one failed start, at the
      // first notice of a launch, silenced every notice until the app was
      // killed, each one failing instantly against the stored error.
      plugin.failInitOnce = true;
      await notices.show(message(NoticeKind.done));
      expect(plugin.shown, isEmpty);
      await notices.show(message(NoticeKind.question));
      expect(plugin.shown, hasLength(1));
      expect(plugin.initialized, 2);
    });
  });

  group('SilentSystemNotices', () {
    test('takes every call and leaves the process', () async {
      final silent = SilentSystemNotices();
      await silent.requestPermission();
      await silent.show(message(NoticeKind.done));
      await silent.cancel(ref);
      expect(silent.opened.value, isNull);
    });
  });

  group('pushes', () {
    test('allowing notices is told, so pushes can start reaching the person', () async {
      var told = 0;
      notices.onAllowed = () => told++;
      await notices.requestPermission();
      expect(told, 1);
    });

    test('refusing them is not', () async {
      var told = 0;
      notices.onAllowed = () => told++;
      plugin.ios.allow = false;
      await notices.requestPermission();
      plugin.ios.fail = true;
      await notices.requestPermission();
      expect(told, 0);
    });

    // What the server sends (backend push/notices.ts): `key`, and `link`, the app's own `swarm:`
    // payload.
    test('a tapped reply push opens the thread at the reply', () {
      openPushed({'key': 'reply:s1:r1', 'link': 'swarm:s1/c1/message/m1/thread/t1'}, notices);
      expect(notices.openedSwarm.value, (
        swarmId: 's1',
        conversationId: 'c1',
        messageId: 'm1',
        decisionId: null,
        threadId: 't1',
      ));
      expect(notices.opened.value, isNull);
    });

    test('a tapped tag push opens the chat at the message, its ids decoded', () {
      openPushed({'key': 'mention:x1', 'link': 'swarm:s%2F1/c1/message/m1'}, notices);
      expect(notices.openedSwarm.value, (
        swarmId: 's/1',
        conversationId: 'c1',
        messageId: 'm1',
        decisionId: null,
        threadId: null,
      ));
    });

    test('a push opens the chat its link names and nothing else', () {
      for (final data in <Map<String, String>>[
        {},
        {'key': 'mention:x1'},
        {'link': 'machine-1\nagent-7'},
        {'link': 'device:key-1'},
        {'link': 'swarm:s1'},
        {'link': 'swarm:s1/c1/agent/a1'},
        {'link': 'https://example.com/swarm:s1/c1'},
        // The first contract's keys: the server never sends them, and they open nothing.
        {'kind': 'agent_question', 'machine': 'machine-1', 'agent': 'agent-7'},
        {'kind': 'swarm', 'swarm': 's1', 'conversation': 'c1', 'message': 'm1'},
      ]) {
        openPushed(data, notices);
      }
      expect(notices.openedSwarm.value, isNull);
      expect(notices.opened.value, isNull);
      expect(notices.openedDevice.value, isNull);
    });

    test('a centre without Swarm notices opens nothing', () {
      final silent = _AgentsOnly();
      openPushed({'link': 'swarm:s1/c1/message/m1'}, silent);
      openPushed({'link': 'machine-1\nagent-7'}, silent);
      expect(silent.opened.value, isNull);
    });

    // A push and the notice the running app posts for the same news share an id, so one replaces
    // the other: Android's PushService.noticeId computes these too, and the backend sets the same as
    // `apns-collapse-id` (docs/design/2026-11-05-phone-push.md lists them).
    test('the ids a push shares with the app’s own notices', () {
      expect(swarmNoticeIdFor('mention:m1'), 1161357565);
      expect(swarmNoticeIdFor('decision:d1'), 15921470);
      expect(swarmNoticeIdFor('work:s1:c1:a1:needs_human'), 701122187);
      expect(swarmNoticeIdFor('mention:é✓'), 1555091707);
      expect(noticeIdFor(ref), 1081005959);
    });
  });
}

/// A centre with no Swarm side: what [openPushed] must not assume.
class _AgentsOnly implements SystemNotices {
  @override
  final opened = ValueNotifier<AgentRef?>(null);

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

typedef _Shown = ({
  int id,
  String? title,
  String? body,
  String? payload,
  NotificationDetails? details,
});

/// The plugin, at the surface `LocalSystemNotices` calls. Everything else
/// falls to [noSuchMethod] — and so fails the test, which is the point.
class _FakePlugin implements FlutterLocalNotificationsPlugin {
  final shown = <_Shown>[];
  final cancelled = <int>[];
  final ios = _FakeIos();
  final android = _FakeAndroid();
  int initialized = 0;
  InitializationSettings? settings;
  DidReceiveNotificationResponseCallback? onResponse;
  NotificationAppLaunchDetails? launch;
  bool failInitOnce = false;
  bool failShow = false;
  bool failCancel = false;

  @override
  Future<bool?> initialize({
    required InitializationSettings settings,
    DidReceiveNotificationResponseCallback? onDidReceiveNotificationResponse,
    DidReceiveBackgroundNotificationResponseCallback?
    onDidReceiveBackgroundNotificationResponse,
  }) async {
    initialized++;
    if (failInitOnce) {
      failInitOnce = false;
      throw PlatformException(code: 'init', message: 'not yet');
    }
    this.settings = settings;
    onResponse = onDidReceiveNotificationResponse;
    return true;
  }

  @override
  Future<NotificationAppLaunchDetails?>
  getNotificationAppLaunchDetails() async => launch;

  @override
  T? resolvePlatformSpecificImplementation<
    T extends FlutterLocalNotificationsPlatform
  >() {
    if (T == IOSFlutterLocalNotificationsPlugin) return ios as T;
    if (T == AndroidFlutterLocalNotificationsPlugin) return android as T;
    return null;
  }

  @override
  Future<void> show({
    required int id,
    String? title,
    String? body,
    NotificationDetails? notificationDetails,
    String? payload,
  }) async {
    if (failShow) throw PlatformException(code: 'show');
    shown.add((
      id: id,
      title: title,
      body: body,
      payload: payload,
      details: notificationDetails,
    ));
  }

  @override
  Future<void> cancel({required int id, String? tag}) async {
    if (failCancel) throw PlatformException(code: 'cancel');
    cancelled.add(id);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeIos implements IOSFlutterLocalNotificationsPlugin {
  final asked = <({bool alert, bool sound, bool badge})>[];
  bool fail = false;
  bool? allow = true;

  @override
  Future<bool?> requestPermissions({
    bool sound = false,
    bool alert = false,
    bool badge = false,
    bool provisional = false,
    bool critical = false,
    bool carPlay = false,
    bool providesAppNotificationSettings = false,
  }) async {
    if (fail) throw PlatformException(code: 'permission');
    asked.add((alert: alert, sound: sound, badge: badge));
    return allow;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeAndroid implements AndroidFlutterLocalNotificationsPlugin {
  int asked = 0;
  final channels = <AndroidNotificationChannel>[];
  bool failChannel = false;

  @override
  Future<bool?> requestNotificationsPermission() async {
    asked++;
    return true;
  }

  @override
  Future<void> createNotificationChannel(
    AndroidNotificationChannel notificationChannel,
  ) async {
    if (failChannel) throw PlatformException(code: 'channel');
    channels.add(notificationChannel);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
