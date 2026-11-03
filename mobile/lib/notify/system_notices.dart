import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import 'package:harness_mobile/core/last_opened_agent.dart';
import 'package:harness_mobile/logging/app_log.dart';

import 'agent_notice.dart';

/// One notice about one agent, as the OS draws it: the agent's name, the
/// machine it runs on, and the news — what the turn said, or what it is asking
/// — the three lines of the dial's drawer row.
typedef AgentNoticeMessage = ({
  AgentRef agent,
  NoticeKind kind,
  String title,
  String machine,
  String body,
});

/// Where a Swarm notice leads: the Swarm, and the conversation it is about.
typedef SwarmNoticeTarget = ({
  String swarmId,
  String conversationId,
  String? messageId,
  String? decisionId,
});

/// One notice about what a Swarm asks of the person. [key] names it, so the
/// same need posted twice replaces itself; [subtitle] says where it is.
typedef SwarmNoticeMessage = ({
  String key,
  String title,
  String subtitle,
  String body,
  SwarmNoticeTarget target,
});

/// The notification centre's Swarm notices: decisions asked of the person,
/// Lead tags, work waiting on them.
///
/// Not on [SystemNotices], whose stand-ins would all have to answer it:
/// [LocalSystemNotices] and [SilentSystemNotices] carry both.
abstract interface class SwarmNotices {
  Future<void> showSwarm(SwarmNoticeMessage message);

  /// Takes the notice [key] names back down: its need was met somewhere else.
  Future<void> cancelSwarm(String key);

  /// Shows [count] on the app icon: what the Swarms ask of the person, the
  /// drawer's waiting count. Zero takes it off.
  Future<void> setSwarmBadge(int count);

  /// The Swarm notice tapped last — what the shell opens. Reset to null by
  /// whoever acts on it.
  ValueNotifier<SwarmNoticeTarget?> get openedSwarm;
}

/// The OS notification centre, as far as the phone uses it.
///
/// An interface so the notifier's tests never reach a platform plugin — see
/// [SilentSystemNotices].
abstract interface class SystemNotices {
  /// Asks the person, once, whether the phone may notify them. The OS
  /// remembers the answer; asking again is a no-op. True when allowed, false
  /// when refused, null when nothing could say.
  Future<bool?> requestPermission();

  Future<void> show(AgentNoticeMessage message);

  /// Takes [agent]'s notice back down — its question was answered somewhere
  /// else, so the lock screen must stop asking.
  Future<void> cancel(AgentRef agent);

  /// The agent whose notice was tapped last — what the shell opens. Reset to
  /// null by whoever acts on it.
  ValueNotifier<AgentRef?> get opened;

  /// The key of the device whose notice was tapped last — what the shell opens. Reset to null by
  /// whoever acts on it.
  ValueNotifier<String?> get openedDevice;

  /// News about the ACCOUNT rather than an agent: a device joined it. [key] names the notice, so the
  /// same news posted twice replaces itself. Tapping it opens that device's page ([key] is its key).
  Future<void> showAccountNotice({required String key, required String title, required String body});
}

/// Nothing leaves the process. What a test notifier is given.
class SilentSystemNotices implements SystemNotices, SwarmNotices {
  @override
  final opened = ValueNotifier<AgentRef?>(null);

  @override
  final openedDevice = ValueNotifier<String?>(null);

  @override
  final openedSwarm = ValueNotifier<SwarmNoticeTarget?>(null);

  @override
  Future<bool?> requestPermission() async => null;

  @override
  Future<void> show(AgentNoticeMessage message) async {}

  @override
  Future<void> cancel(AgentRef agent) async {}

  @override
  Future<void> showAccountNotice({required String key, required String title, required String body}) async {}

  @override
  Future<void> showSwarm(SwarmNoticeMessage message) async {}

  @override
  Future<void> cancelSwarm(String key) async {}

  @override
  Future<void> setSwarmBadge(int count) async {}
}

/// Whether the OS lets this app post notices right now — Settings ▸ Notifications reads it. Null
/// where nothing can say: a stand-in centre (tests, the sample), or a platform call that failed.
///
/// Not on [SystemNotices] itself: every stand-in would have to answer it, and only the real centre
/// knows.
Future<bool?> noticesEnabled(SystemNotices notices) =>
    notices is LocalSystemNotices
    ? notices.enabled()
    : Future<bool?>.value(null);

/// What the phone's notices are about, in the words Settings ▸ Notifications and Focus's tips use —
/// one source, so the two never promise different things.
///
/// "Needs you" since 2026-10-21: `commander_question` ([NoticeKind.question]) reaches a phone over the
/// relay (`cli/src/core/questions.ts` `sendRemote`). From 2026-10-14 until then the daemon sent it only
/// to the dial and its own computer, and this did not promise it.
const noticesWhen =
    'a harness finishes or needs you, or a new device joins your account';

/// What a device notice's payload starts with; the device's key follows. An agent notice's payload
/// is `machine\nagent`, so the two never read as each other.
const _devicePayload = 'device:';

/// What a Swarm notice's payload starts with: `swarm:<swarm>/<conversation>`, each part
/// URI-encoded, with no newline — so it never reads as an agent's or a device's.
const _swarmPayload = 'swarm:';

/// The Android channel, iOS thread and iOS category of Swarm notices.
const _swarmChannel = 'swarm-needs-you';

/// `harness/app_badge` — the app icon's count (Swift: `AppBadgeChannel` in `ios/Runner/AppDelegate.swift`).
const _appBadge = MethodChannel('harness/app_badge');

/// The real centre, through flutter_local_notifications.
///
/// Started lazily on first use, so a launch that never needs it — and every
/// test — pays nothing for it.
class LocalSystemNotices implements SystemNotices, SwarmNotices {
  LocalSystemNotices([FlutterLocalNotificationsPlugin? plugin])
    : _plugin = plugin ?? FlutterLocalNotificationsPlugin();

  final FlutterLocalNotificationsPlugin _plugin;
  Future<void>? _ready;

  @override
  final opened = ValueNotifier<AgentRef?>(null);

  @override
  final openedDevice = ValueNotifier<String?>(null);

  @override
  final openedSwarm = ValueNotifier<SwarmNoticeTarget?>(null);

  /// One Android channel per kind, so a person can silence finished turns and
  /// still hear questions — the two are not equally urgent. Also the iOS
  /// thread each kind is grouped under.
  static const _channels = {
    NoticeKind.done: (
      id: 'agent-done',
      name: 'Agent finished',
      description: 'An agent finished its turn while Harness was away.',
    ),
    NoticeKind.question: (
      id: 'agent-question',
      name: 'Agent needs you',
      description: 'An agent stopped to ask you something.',
    ),
  };

  /// Started once and shared — but only a start that WORKED is kept. A failed
  /// one kept here would fail every notice after it, instantly, for the rest of
  /// the launch; forgetting it lets the next notice try again.
  Future<void> _init() =>
      _ready ??= _start().catchError((Object error, StackTrace stack) {
        _ready = null;
        Error.throwWithStackTrace(error, stack);
      });

  Future<void> _start() async {
    await _plugin.initialize(
      settings: const InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher'),
        // Asked for explicitly in [requestPermission], never as a side effect
        // of the first notice.
        iOS: DarwinInitializationSettings(
          requestAlertPermission: false,
          requestBadgePermission: false,
          requestSoundPermission: false,
          // A Swarm notice on a phone that hides previews still says who asks
          // and where.
          notificationCategories: [
            DarwinNotificationCategory(
              _swarmChannel,
              options: {
                DarwinNotificationCategoryOption.hiddenPreviewShowTitle,
                DarwinNotificationCategoryOption.hiddenPreviewShowSubtitle,
              },
            ),
          ],
        ),
      ),
      onDidReceiveNotificationResponse: (response) => _open(response.payload),
    );
    // A notice tapped while the app was not running at all launches it; the
    // tap reaches no callback then, only this.
    final launch = await _plugin.getNotificationAppLaunchDetails();
    if (launch?.didNotificationLaunchApp ?? false) {
      _open(launch?.notificationResponse?.payload);
    }
  }

  void _open(String? payload) {
    if (decodeSwarmPayload(payload) case final target?) {
      openedSwarm.value = target;
      return;
    }
    // A device notice carries `device:<key>` — no newline, so it never reads as an agent's payload.
    if (payload != null && payload.startsWith(_devicePayload)) {
      openedDevice.value = payload.substring(_devicePayload.length);
      return;
    }
    final agent = decodeAgentPayload(payload);
    if (agent != null) opened.value = agent;
  }

  @override
  Future<bool?> requestPermission() async {
    try {
      await _init();
      final ios = await _plugin
          .resolvePlatformSpecificImplementation<
            IOSFlutterLocalNotificationsPlugin
          >()
          ?.requestPermissions(alert: true, sound: true, badge: true);
      final android = await _plugin
          .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin
          >()
          ?.requestNotificationsPermission();
      return ios ?? android;
    } catch (error) {
      appLog.warn('notify', 'permission request failed', error: error);
      return null;
    }
  }

  /// Whether notices are allowed now — see [noticesEnabled]. iOS cannot tell "never asked" from
  /// "refused" here: both read false, and asking ([requestPermission]) is what tells them apart.
  Future<bool?> enabled() async {
    try {
      await _init();
      final ios = _plugin
          .resolvePlatformSpecificImplementation<
            IOSFlutterLocalNotificationsPlugin
          >();
      if (ios != null) return (await ios.checkPermissions())?.isEnabled;
      final android = _plugin
          .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin
          >();
      if (android != null) return await android.areNotificationsEnabled();
    } catch (error) {
      appLog.warn('notify', 'permission check failed', error: error);
    }
    return null;
  }

  @override
  Future<void> show(AgentNoticeMessage message) async {
    final channel = _channels[message.kind]!;
    try {
      await _init();
      await _plugin.show(
        // One per AGENT: newer news replaces its own last notice rather than
        // stacking beside it — the desktop banner's rule, and the unread
        // mark's: a question after a finish is the one that stands.
        id: noticeIdFor(message.agent),
        title: message.title,
        body: message.body,
        payload: encodeAgentPayload(message.agent),
        notificationDetails: NotificationDetails(
          android: AndroidNotificationDetails(
            channel.id,
            channel.name,
            channelDescription: channel.description,
            importance: Importance.high,
            priority: Priority.high,
            subText: message.machine,
          ),
          iOS: DarwinNotificationDetails(
            subtitle: message.machine,
            threadIdentifier: channel.id,
          ),
        ),
      );
    } catch (error) {
      appLog.warn('notify', 'notice failed', error: error);
    }
  }

  @override
  Future<void> showAccountNotice({required String key, required String title, required String body}) async {
    try {
      await _init();
      await _plugin.show(
        id: accountNoticeIdFor(key),
        title: title,
        body: body,
        notificationDetails: const NotificationDetails(
          android: AndroidNotificationDetails(
            'account-device',
            'New device on your account',
            channelDescription: 'A computer or app signed in to your account and can reach your machines.',
            importance: Importance.high,
            priority: Priority.high,
          ),
          iOS: DarwinNotificationDetails(threadIdentifier: 'account-device'),
        ),
        payload: '$_devicePayload$key',
      );
    } catch (error) {
      appLog.warn('notify', 'account notice failed', error: error);
    }
  }

  @override
  Future<void> showSwarm(SwarmNoticeMessage message) async {
    try {
      await _init();
      await _plugin.show(
        id: swarmNoticeIdFor(message.key),
        title: message.title,
        body: message.body,
        payload: encodeSwarmPayload(message.target),
        notificationDetails: NotificationDetails(
          android: AndroidNotificationDetails(
            _swarmChannel,
            'Swarm needs you',
            channelDescription:
                'A Swarm asks you to decide, tags you, or has work waiting on you.',
            importance: Importance.high,
            priority: Priority.high,
            subText: message.subtitle,
            // Hidden on a secure lock screen set to hide private content.
            visibility: NotificationVisibility.private,
          ),
          iOS: DarwinNotificationDetails(
            subtitle: message.subtitle,
            threadIdentifier: _swarmChannel,
            categoryIdentifier: _swarmChannel,
          ),
        ),
      );
    } catch (error) {
      appLog.warn('notify', 'swarm notice failed', error: error);
    }
  }

  @override
  Future<void> cancelSwarm(String key) async {
    try {
      await _init();
      await _plugin.cancel(id: swarmNoticeIdFor(key));
    } catch (error) {
      appLog.warn('notify', 'swarm cancel failed', error: error);
    }
  }

  /// iOS only: Android has no count of its own on the icon — launchers draw a dot from the
  /// notices posted.
  @override
  Future<void> setSwarmBadge(int count) async {
    if (defaultTargetPlatform != TargetPlatform.iOS) return;
    try {
      await _appBadge.invokeMethod<void>('set', count);
    } catch (error) {
      appLog.warn('notify', 'swarm badge failed', error: error);
    }
  }

  @override
  Future<void> cancel(AgentRef agent) async {
    try {
      await _init();
      await _plugin.cancel(id: noticeIdFor(agent));
    } catch (error) {
      appLog.warn('notify', 'cancel failed', error: error);
    }
  }
}

/// A stable, positive id per agent, so a notice replaces the last one for the
/// same agent across runs too.
@visibleForTesting
int noticeIdFor(AgentRef agent) {
  // FNV-1a: `String.hashCode` is not guaranteed stable from one run to the next.
  var hash = 0x811c9dc5;
  for (final unit in encodeAgentPayload(agent).codeUnits) {
    hash = ((hash ^ unit) * 0x01000193) & 0x7fffffff;
  }
  return hash;
}

/// A stable, positive id per account notice — the same FNV-1a as [noticeIdFor], over its own key,
/// so it never lands on an agent's.
@visibleForTesting
int accountNoticeIdFor(String key) {
  var hash = 0x811c9dc5;
  for (final unit in 'account\n$key'.codeUnits) {
    hash = ((hash ^ unit) * 0x01000193) & 0x7fffffff;
  }
  return hash;
}

/// A stable, positive id per Swarm notice — the same FNV-1a, over its own key, so it never lands
/// on an agent's or an account's.
@visibleForTesting
int swarmNoticeIdFor(String key) {
  var hash = 0x811c9dc5;
  for (final unit in 'swarm\n$key'.codeUnits) {
    hash = ((hash ^ unit) * 0x01000193) & 0x7fffffff;
  }
  return hash;
}

@visibleForTesting
String encodeSwarmPayload(SwarmNoticeTarget target) =>
    '$_swarmPayload${Uri.encodeComponent(target.swarmId)}'
    '/${Uri.encodeComponent(target.conversationId)}'
    '${target.messageId != null
        ? '/message/${Uri.encodeComponent(target.messageId!)}'
        : target.decisionId != null
        ? '/decision/${Uri.encodeComponent(target.decisionId!)}'
        : ''}';

@visibleForTesting
SwarmNoticeTarget? decodeSwarmPayload(String? payload) {
  if (payload == null || !payload.startsWith(_swarmPayload)) return null;
  final parts = payload.substring(_swarmPayload.length).split('/');
  if ((parts.length != 2 && parts.length != 4) || parts.any((p) => p.isEmpty)) {
    return null;
  }
  if (parts.length == 4 && !const ['message', 'decision'].contains(parts[2])) {
    return null;
  }
  try {
    return (
      swarmId: Uri.decodeComponent(parts[0]),
      conversationId: Uri.decodeComponent(parts[1]),
      messageId: parts.length == 4 && parts[2] == 'message'
          ? Uri.decodeComponent(parts[3])
          : null,
      decisionId: parts.length == 4 && parts[2] == 'decision'
          ? Uri.decodeComponent(parts[3])
          : null,
    );
  } on ArgumentError {
    return null;
  }
}

@visibleForTesting
String encodeAgentPayload(AgentRef agent) =>
    '${agent.machineId}\n${agent.agentId}';

@visibleForTesting
AgentRef? decodeAgentPayload(String? payload) {
  final parts = payload?.split('\n');
  if (parts == null || parts.length != 2) return null;
  if (parts[0].isEmpty || parts[1].isEmpty) return null;
  return (machineId: parts[0], agentId: parts[1]);
}
