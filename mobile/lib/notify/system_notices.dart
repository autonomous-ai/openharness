import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import 'package:harness_mobile/core/last_opened_agent.dart';
import 'package:harness_mobile/logging/app_log.dart';

import 'agent_notice.dart';

/// One notice about one agent, as the OS draws it: the agent's name, the
/// machine it runs on, and the news — what the turn said, or what it is asking
/// — the three lines of the dial's drawer row. [quiet] posts it with no sound,
/// no vibration and no banner ([AgentNotice.quiet]).
typedef AgentNoticeMessage = ({
  AgentRef agent,
  NoticeKind kind,
  String title,
  String machine,
  String body,
  bool quiet,
});

/// Where a Swarm notice leads: the Swarm, and the conversation it is about;
/// for a message only in a thread, that thread's root ([threadId]), since the
/// chat alone does not show it.
typedef SwarmNoticeTarget = ({
  String swarmId,
  String conversationId,
  String? messageId,
  String? decisionId,
  String? threadId,
});

/// One notice about what a Swarm asks of the person. [key] names the
/// notification it shows in, so the same need posted twice replaces itself,
/// and so does the server's push for it (task #3248: a thread's replies share
/// one); [subtitle] says where it is. [quiet] replaces what that notification
/// showed with no sound, no vibration and no banner.
typedef SwarmNoticeMessage = ({
  String key,
  String title,
  String subtitle,
  String body,
  SwarmNoticeTarget target,
  bool quiet,
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

/// The Android channel of a quiet push (task #3248; backend `push/sender.ts` SWARM_QUIET_CHANNEL): on
/// Android the channel, not the push, decides whether it sounds, so this one never does.
const _swarmQuietChannel = 'swarm-quiet';

/// How Android names the Swarm channel, here and when a notice makes it.
const _swarmChannelName = 'Swarm needs you';
const _swarmChannelDescription =
    'A Swarm asks you to decide, tags you, or has work waiting on you.';

/// Android draws an FCM push under its tag with this id (the server tags it with the notice's key), so a
/// Swarm notice posted under the same tag and id replaces the push, and the other way round.
const _androidPushId = 0;

bool get _android => defaultTargetPlatform == TargetPlatform.android;

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

  /// Told when the person has just allowed notices ([requestPermission]): the moment pushes can
  /// start reaching them (`notify/push_tokens.dart`).
  void Function()? onAllowed;

  /// Android: makes the channels pushes are drawn on, before one can arrive (task #3248). Without
  /// them a push that came before the app's first Swarm notice landed on FCM's default channel, and
  /// a quiet one would sound. Needs no start of the centre; nothing on iOS, whose pushes have no
  /// channel.
  Future<void> preparePush() async {
    if (!_android) return;
    try {
      final android = _plugin
          .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin
          >();
      await android?.createNotificationChannel(
        const AndroidNotificationChannel(
          _swarmChannel,
          _swarmChannelName,
          description: _swarmChannelDescription,
          importance: Importance.high,
        ),
      );
      await android?.createNotificationChannel(
        const AndroidNotificationChannel(
          _swarmQuietChannel,
          'Swarm, quiet updates',
          description:
              'A newer reply in a thread you have not read yet: it replaces the notice already there.',
          importance: Importance.low,
          playSound: false,
          enableVibration: false,
        ),
      );
    } catch (error) {
      appLog.warn('notify', 'push channels not made', error: error);
    }
  }

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
      final allowed = ios ?? android;
      if (allowed == true) onAllowed?.call();
      return allowed;
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
            // A quiet notice replaces or joins the list without a sound, a
            // vibration or a heads-up, whatever its channel says.
            silent: message.quiet,
          ),
          iOS: DarwinNotificationDetails(
            subtitle: message.machine,
            threadIdentifier: channel.id,
            // Unset is the plugin's default, sound and banner. Without a sound
            // here iOS plays none in the background either; passive neither
            // lights the screen nor shows a banner, only the list.
            presentSound: message.quiet ? false : null,
            presentBanner: message.quiet ? false : null,
            interruptionLevel: message.quiet ? InterruptionLevel.passive : null,
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

  /// Where a Swarm notice is in the notification centre: the notification the server's push for the
  /// same thing uses (task #3248). Android: its key as the tag, with FCM's id. iOS: [swarmNoticeIdFor],
  /// which the push carries in decimal as its `apns-collapse-id`.
  ({int id, String? tag}) _swarmPlace(String key) => _android
      ? (id: _androidPushId, tag: key)
      : (id: swarmNoticeIdFor(key), tag: null);

  @override
  Future<void> showSwarm(SwarmNoticeMessage message) async {
    final place = _swarmPlace(message.key);
    final quiet = message.quiet;
    try {
      await _init();
      await _plugin.show(
        id: place.id,
        title: message.title,
        body: message.body,
        payload: encodeSwarmPayload(message.target),
        notificationDetails: NotificationDetails(
          android: AndroidNotificationDetails(
            _swarmChannel,
            _swarmChannelName,
            channelDescription: _swarmChannelDescription,
            importance: Importance.high,
            priority: Priority.high,
            subText: message.subtitle,
            // Hidden on a secure lock screen set to hide private content.
            visibility: NotificationVisibility.private,
            tag: place.tag,
            // A quiet one replaces what its notification showed, without a sound, a vibration or a
            // heads-up, as a quiet agent notice does.
            silent: quiet,
          ),
          iOS: DarwinNotificationDetails(
            subtitle: message.subtitle,
            threadIdentifier: _swarmChannel,
            categoryIdentifier: _swarmChannel,
            presentSound: quiet ? false : null,
            presentBanner: quiet ? false : null,
            interruptionLevel: quiet ? InterruptionLevel.passive : null,
          ),
        ),
      );
    } catch (error) {
      appLog.warn('notify', 'swarm notice failed', error: error);
    }
  }

  /// Also takes down the push shown in the same notification.
  @override
  Future<void> cancelSwarm(String key) async {
    final place = _swarmPlace(key);
    try {
      await _init();
      await _plugin.cancel(id: place.id, tag: place.tag);
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
              '${target.threadId != null ? '/thread/${Uri.encodeComponent(target.threadId!)}' : ''}'
        : target.decisionId != null
        ? '/decision/${Uri.encodeComponent(target.decisionId!)}'
        : ''}';

@visibleForTesting
SwarmNoticeTarget? decodeSwarmPayload(String? payload) {
  if (payload == null || !payload.startsWith(_swarmPayload)) return null;
  final parts = payload.substring(_swarmPayload.length).split('/');
  if ((parts.length != 2 && parts.length != 4 && parts.length != 6) ||
      parts.any((p) => p.isEmpty)) {
    return null;
  }
  if (parts.length >= 4 && !const ['message', 'decision'].contains(parts[2])) {
    return null;
  }
  // A message in a thread names its root after it (encodeSwarmPayload).
  if (parts.length == 6 && (parts[2] != 'message' || parts[4] != 'thread')) {
    return null;
  }
  try {
    return (
      swarmId: Uri.decodeComponent(parts[0]),
      conversationId: Uri.decodeComponent(parts[1]),
      messageId: parts.length >= 4 && parts[2] == 'message'
          ? Uri.decodeComponent(parts[3])
          : null,
      decisionId: parts.length == 4 && parts[2] == 'decision'
          ? Uri.decodeComponent(parts[3])
          : null,
      threadId: parts.length == 6 ? Uri.decodeComponent(parts[5]) : null,
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

/// A tapped push (`notify/push_channel.dart`) opens the chat its `link` names: the app's own
/// `swarm:` payload, which the server puts beside the notice's `key` (`backend/src/push/notices.ts`).
/// Anything else (no link, an agent's or a device's payload) only opened the app.
void openPushed(Map<String, String> data, SystemNotices notices) {
  if (notices case final SwarmNotices swarm) {
    if (decodeSwarmPayload(data['link']) case final target?) {
      swarm.openedSwarm.value = target;
    }
  }
}
