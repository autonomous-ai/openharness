import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import 'package:harness_mobile/core/last_opened_agent.dart';
import 'package:harness_mobile/logging/app_log.dart';

/// One "agent finished" notice, as the OS draws it: the agent's name, the
/// machine it runs on, and what the turn said — the three lines of the dial's
/// drawer row.
typedef DoneNoticeMessage = ({
  AgentRef agent,
  String title,
  String machine,
  String body,
});

/// The OS notification centre, as far as the phone uses it.
///
/// An interface so the notifier's tests never reach a platform plugin — see
/// [SilentSystemNotices].
abstract interface class SystemNotices {
  /// Asks the person, once, whether the phone may notify them. The OS
  /// remembers the answer; asking again is a no-op.
  Future<void> requestPermission();

  Future<void> show(DoneNoticeMessage message);

  /// The agent whose notice was tapped last — what the shell opens. Reset to
  /// null by whoever acts on it.
  ValueNotifier<AgentRef?> get opened;
}

/// Nothing leaves the process. What a test notifier is given.
class SilentSystemNotices implements SystemNotices {
  @override
  final opened = ValueNotifier<AgentRef?>(null);

  @override
  Future<void> requestPermission() async {}

  @override
  Future<void> show(DoneNoticeMessage message) async {}
}

/// The real centre, through flutter_local_notifications.
///
/// Started lazily on first use, so a launch that never needs it — and every
/// test — pays nothing for it.
class LocalSystemNotices implements SystemNotices {
  LocalSystemNotices([FlutterLocalNotificationsPlugin? plugin])
    : _plugin = plugin ?? FlutterLocalNotificationsPlugin();

  final FlutterLocalNotificationsPlugin _plugin;
  Future<void>? _ready;

  @override
  final opened = ValueNotifier<AgentRef?>(null);

  static const _channel = AndroidNotificationDetails(
    'agent-done',
    'Agent finished',
    channelDescription: 'An agent finished its turn while Harness was away.',
    importance: Importance.high,
    priority: Priority.high,
  );

  Future<void> _init() => _ready ??= _start();

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
    final agent = decodeAgentPayload(payload);
    if (agent != null) opened.value = agent;
  }

  @override
  Future<void> requestPermission() async {
    try {
      await _init();
      await _plugin
          .resolvePlatformSpecificImplementation<
            IOSFlutterLocalNotificationsPlugin
          >()
          ?.requestPermissions(alert: true, sound: true);
      await _plugin
          .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin
          >()
          ?.requestNotificationsPermission();
    } catch (error) {
      appLog.warn('notify', 'permission request failed', error: error);
    }
  }

  @override
  Future<void> show(DoneNoticeMessage message) async {
    try {
      await _init();
      await _plugin.show(
        // One per AGENT: a newer turn replaces its own last notice rather than
        // stacking beside it — the desktop banner's rule.
        id: noticeIdFor(message.agent),
        title: message.title,
        body: message.body,
        payload: encodeAgentPayload(message.agent),
        notificationDetails: NotificationDetails(
          android: AndroidNotificationDetails(
            _channel.channelId,
            _channel.channelName,
            channelDescription: _channel.channelDescription,
            importance: _channel.importance,
            priority: _channel.priority,
            subText: message.machine,
          ),
          iOS: DarwinNotificationDetails(
            subtitle: message.machine,
            threadIdentifier: 'agent-done',
          ),
        ),
      );
    } catch (error) {
      appLog.warn('notify', 'notice failed', error: error);
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
