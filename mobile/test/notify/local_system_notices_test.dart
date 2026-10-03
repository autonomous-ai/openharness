import 'package:flutter/services.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_test/flutter_test.dart';
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

  AgentNoticeMessage message(NoticeKind kind, {String body = 'Fixed it.'}) => (
    agent: ref,
    kind: kind,
    title: 'Fix login',
    machine: 'MacBook',
    body: body,
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

  test('asking permission asks both platforms for alerts and sound', () async {
    await notices.requestPermission();
    expect(plugin.ios.asked, [(alert: true, sound: true)]);
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
  final asked = <({bool alert, bool sound})>[];
  bool fail = false;

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
    asked.add((alert: alert, sound: sound));
    return true;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeAndroid implements AndroidFlutterLocalNotificationsPlugin {
  int asked = 0;

  @override
  Future<bool?> requestNotificationsPermission() async {
    asked++;
    return true;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
