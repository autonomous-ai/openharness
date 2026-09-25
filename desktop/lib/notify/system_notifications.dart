library;

import 'dart:async';
import 'dart:io' show Platform, Process, ProcessException, ProcessResult;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'agent_alerts.dart';
import 'alert_sounds.dart';

/// Whether an agent's news is ALSO handed to the operating system, so it reaches
/// somebody whose window is behind their editor, on another desktop, or minimised.
///
/// OFF by default, like the banner and the sound: all three are interruptions.
/// Turning it on is also the moment macOS asks for permission — an app that asks
/// before anybody wanted it to say anything is a bad guest.
class DesktopNotificationStore extends OnOffPreference {
  DesktopNotificationStore({super.storage})
    : super('app_desktop_notifications');
}

/// What the operating system said about posting notifications.
enum NotificationPermission {
  /// Nobody has asked yet, or the answer is not known.
  unknown,
  granted,

  /// The person said no, or turned Harness off in the system's own settings.
  /// Only they can change it, and only there.
  denied,

  /// This build or this computer cannot post at all: an ad-hoc-signed dev build
  /// on macOS, a Linux desktop without `notify-send`.
  unavailable;

  static NotificationPermission parse(Object? value) => switch (value) {
    'granted' => granted,
    'denied' => denied,
    'unavailable' => unavailable,
    _ => unknown,
  };
}

/// The operating-system half: what actually puts a notification on screen.
///
/// Every call is best-effort. A platform that cannot post answers [unavailable]
/// or does nothing; it never throws into the event dispatcher that carried the news.
abstract class SystemNotifier {
  /// Whether this platform has a notifier at all. The Settings row is not shown
  /// where it would be a switch connected to nothing.
  bool get supported;

  /// Whether clicking a notification opens its agent. Settings only promises
  /// what the platform does.
  bool get clickOpensAgent;

  /// Ask for permission if it has not been asked, and say what the answer is.
  Future<NotificationPermission> authorize();

  /// Post, or replace the one already posted under [id].
  Future<NotificationPermission> show({
    required String id,
    required String title,
    required String body,
    required String machineId,
    required String agentId,
  });

  /// Take down the one posted under [id], if it is still there.
  Future<void> withdraw(String id);

  /// Called with the agent a person clicked a notification for.
  set onTap(void Function(String machineId, String agentId)? handler);
}

/// No system notifications — Windows, tests, and anything else.
class NoSystemNotifier implements SystemNotifier {
  const NoSystemNotifier();

  @override
  bool get supported => false;

  @override
  bool get clickOpensAgent => false;

  @override
  Future<NotificationPermission> authorize() async =>
      NotificationPermission.unavailable;

  @override
  Future<NotificationPermission> show({
    required String id,
    required String title,
    required String body,
    required String machineId,
    required String agentId,
  }) async => NotificationPermission.unavailable;

  @override
  Future<void> withdraw(String id) async {}

  @override
  set onTap(void Function(String machineId, String agentId)? handler) {}
}

/// macOS: `UNUserNotificationCenter`, in `HarnessNotifications.swift`.
///
/// Works for the signed and notarized build people install. A local
/// `flutter run` build is ad-hoc signed, and there the centre refuses with an
/// error — which comes back as [NotificationPermission.unavailable], and the
/// banner keeps doing the job.
class MacSystemNotifier implements SystemNotifier {
  MacSystemNotifier({MethodChannel? channel})
    : _channel = channel ?? const MethodChannel('harness/notifications');

  final MethodChannel _channel;

  @override
  bool get supported => true;

  @override
  bool get clickOpensAgent => true;

  @override
  Future<NotificationPermission> authorize() => _ask('authorize', null);

  @override
  Future<NotificationPermission> show({
    required String id,
    required String title,
    required String body,
    required String machineId,
    required String agentId,
  }) => _ask('show', {
    'id': id,
    'title': title,
    'body': body,
    'machineId': machineId,
    'agentId': agentId,
  });

  @override
  Future<void> withdraw(String id) async {
    try {
      await _channel.invokeMethod<void>('withdraw', {'id': id});
    } catch (_) {}
  }

  @override
  set onTap(void Function(String machineId, String agentId)? handler) {
    _channel.setMethodCallHandler(
      handler == null
          ? null
          : (call) async {
              if (call.method != 'tapped') return;
              final args = call.arguments;
              if (args is! Map) return;
              final machineId = args['machineId'];
              final agentId = args['agentId'];
              if (machineId is String &&
                  machineId.isNotEmpty &&
                  agentId is String &&
                  agentId.isNotEmpty) {
                handler(machineId, agentId);
              }
            },
    );
  }

  Future<NotificationPermission> _ask(String method, Object? args) async {
    try {
      return NotificationPermission.parse(
        await _channel.invokeMethod<String>(method, args),
      );
    } on MissingPluginException {
      return NotificationPermission.unavailable;
    } catch (_) {
      return NotificationPermission.unknown;
    }
  }
}

/// Runs a command and hands back its result. Injected so a test can see what
/// would have been run without a notification daemon.
typedef ProcessRunner = Future<ProcessResult> Function(
  String executable,
  List<String> arguments,
);

/// Linux: `notify-send`, which talks to whatever notification daemon the
/// desktop already runs. No native dependency, and no click action — the tool
/// has none, so a click does what the desktop's own default is.
class LinuxSystemNotifier implements SystemNotifier {
  LinuxSystemNotifier({ProcessRunner? run}) : _run = run ?? Process.run;

  final ProcessRunner _run;

  /// The daemon's id for each agent's notification, so the next one REPLACES it
  /// (`--replace-id`) rather than stacking — the banner's rule.
  final _ids = <String, String>{};

  /// Whether this `notify-send` knows `--print-id`/`--replace-id` (libnotify
  /// 0.7.9 and later). An older one refuses the flags; it is asked once, and
  /// every notification after that is posted plainly.
  bool _canReplace = true;

  @override
  bool get supported => true;

  @override
  bool get clickOpensAgent => false;

  @override
  Future<NotificationPermission> authorize() async {
    try {
      final result = await _run('notify-send', ['--version']);
      return result.exitCode == 0
          ? NotificationPermission.granted
          : NotificationPermission.unavailable;
    } on ProcessException {
      return NotificationPermission.unavailable;
    }
  }

  @override
  Future<NotificationPermission> show({
    required String id,
    required String title,
    required String body,
    required String machineId,
    required String agentId,
  }) async {
    List<String> args({required bool replace}) => [
      '--app-name=Harness',
      if (replace) '--print-id',
      if (replace && _ids[id] != null) '--replace-id=${_ids[id]}',
      // `--` so an agent called "-u critical" is a title and not a flag.
      '--',
      title,
      body,
    ];
    try {
      if (_canReplace) {
        final result = await _run('notify-send', args(replace: true));
        if (result.exitCode == 0) {
          final printed = '${result.stdout}'.trim();
          if (int.tryParse(printed) != null) _ids[id] = printed;
          return NotificationPermission.granted;
        }
        // Only a notify-send that does not KNOW the flags gives them up. Any
        // other failure is the daemon, and the next alert should still replace.
        if ('${result.stderr}'.toLowerCase().contains('unknown option')) {
          _canReplace = false;
        }
      }
      final result = await _run('notify-send', args(replace: false));
      // A failure here is the desktop's daemon, not a missing tool — one that
      // is restarting, or not up yet at login. Unknown, so the next alert tries
      // again rather than the channel going dark for the rest of the session.
      return result.exitCode == 0
          ? NotificationPermission.granted
          : NotificationPermission.unknown;
    } on ProcessException {
      return NotificationPermission.unavailable;
    }
  }

  /// `notify-send` cannot close a notification. The desktop's daemon expires it.
  @override
  Future<void> withdraw(String id) async => _ids.remove(id);

  @override
  set onTap(void Function(String machineId, String agentId)? handler) {}
}

/// The notifier for the platform this build runs on.
SystemNotifier platformSystemNotifier() {
  if (kIsWeb) return const NoSystemNotifier();
  if (Platform.isMacOS) return MacSystemNotifier();
  if (Platform.isLinux) return LinuxSystemNotifier();
  return const NoSystemNotifier();
}

/// The third channel beside the banner and the sound: news the operating system
/// delivers, so it survives the window being somewhere else.
///
/// Decides whether to post — the switch, and what the platform last said — and
/// leaves HOW to the [SystemNotifier]. It does not decide WHEN: the caller posts
/// only while the window is not in front, because in front of the window the
/// banner already says it.
class SystemNotifications {
  SystemNotifications({
    DesktopNotificationStore? store,
    SystemNotifier? notifier,
  }) : store = store ?? desktopNotificationStore,
       notifier = notifier ?? platformSystemNotifier();

  final DesktopNotificationStore store;
  final SystemNotifier notifier;

  /// What the platform last answered. Settings reads it to explain a switch that
  /// is on but cannot do anything.
  final permission = ValueNotifier(NotificationPermission.unknown);

  bool get supported => notifier.supported;

  /// One notification per AGENT, as for banners: a busy agent replaces its own
  /// last message instead of stacking a column of them in Notification Center.
  static String idFor(String machineId, String agentId) =>
      'harness-agent:$machineId/$agentId';

  /// Turn the channel on or off, asking the platform for permission on the way on.
  Future<void> setEnabled(bool on) async {
    await store.set(on);
    if (on) permission.value = await notifier.authorize();
  }

  /// Hand [alert] to the operating system. Silent when the switch is off, and
  /// when this build or computer cannot post at all.
  ///
  /// A DENIAL is not remembered the same way: the person can allow Harness in
  /// the system's settings at any moment, and the next alert has to find that
  /// out without a restart. Asking a denied app costs no prompt — the system
  /// answers from what the person chose.
  ///
  /// Never throws and never makes the caller wait.
  void post(AgentAlert alert) {
    if (!store.value || !supported) return;
    if (permission.value == NotificationPermission.unavailable) return;
    unawaited(
      notifier
          .show(
            id: idFor(alert.machineId, alert.agentId),
            title: alert.title,
            body: alert.sentence,
            machineId: alert.machineId,
            agentId: alert.agentId,
          )
          .then((answer) {
            if (answer != NotificationPermission.unknown) {
              permission.value = answer;
            }
          })
          .catchError((_) {}),
    );
  }

  /// The person got to this agent some other way. Its notification is old news.
  void withdraw(String machineId, String agentId) {
    if (!supported) return;
    unawaited(notifier.withdraw(idFor(machineId, agentId)).catchError((_) {}));
  }

  /// Where a click on a notification goes. Null stops listening.
  set onTap(void Function(String machineId, String agentId)? handler) =>
      notifier.onTap = handler;
}

/// The store the app reads, loaded at start-up beside the other preferences.
final desktopNotificationStore = DesktopNotificationStore();

/// The app's one channel to the operating system's notifications.
final systemNotifications = SystemNotifications();
