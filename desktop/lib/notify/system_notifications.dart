library;

import 'dart:async';
import 'dart:convert' show utf8;
import 'dart:io' show Platform, Process, ProcessException, ProcessResult;
import 'dart:isolate';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'agent_alerts.dart';
import 'alert_sounds.dart';
import 'browser_notifier.dart';

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

/// Whether this computer has been offered notifications once already.
///
/// Notifications stay off until somebody wants them; the one moment they are
/// offered is when an agent finished while the person was away from Harness
/// and nothing told them. Asked once, whatever the answer: a second offer is a
/// nag.
class NotificationOfferStore extends OnOffPreference {
  NotificationOfferStore({super.storage})
    : super('app_notifications_offered');
}

final notificationOfferStore = NotificationOfferStore();

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

/// What a Windows toast opens when it is clicked:
/// `harness://notification/<machineId>/<agentId>`, each part
/// percent-encoded. The toast launches it like any other link (single
/// instance, then `harness/community_links`), and
/// [SystemNotifications.openLink] sends it where a macOS click goes. The bare
/// link names no agent: it only brings Harness forward, which the runner has
/// already done by the time Dart reads it.
class NotificationLink {
  const NotificationLink(this.machineId, this.agentId);

  final String machineId;
  final String agentId;

  static const bare = 'harness://notification';

  /// The runner hands Dart at most this many bytes of a link (the macOS and
  /// Linux limit too).
  static const maxLength = 240;

  static String build(String machineId, String agentId) {
    if (machineId.isEmpty || agentId.isEmpty) return bare;
    final url =
        '$bare/${Uri.encodeComponent(machineId)}/${Uri.encodeComponent(agentId)}';
    return url.length > maxLength ? bare : url;
  }

  static NotificationLink? parse(String value) {
    if (utf8.encode(value).length > maxLength) return null;
    final uri = Uri.tryParse(value);
    if (uri == null ||
        uri.scheme != 'harness' ||
        uri.host != 'notification' ||
        uri.hasPort ||
        uri.userInfo.isNotEmpty ||
        uri.hasQuery ||
        uri.hasFragment) {
      return null;
    }
    try {
      final segments = uri.pathSegments;
      if (segments.isEmpty) return const NotificationLink('', '');
      if (segments.length != 2 || segments.any((segment) => segment.isEmpty)) {
        return null;
      }
      return NotificationLink(segments[0], segments[1]);
    } on FormatException {
      // An external link can contain invalid UTF-8 percent escapes.
      return null;
    }
  }
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

  /// Where a person who said no turns notifications back on — Settings shows
  /// it under a switch that is on but [NotificationPermission.denied].
  String get deniedAdvice;

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

/// No system notifications — tests, and anything else.
class NoSystemNotifier implements SystemNotifier {
  const NoSystemNotifier();

  @override
  bool get supported => false;

  @override
  bool get clickOpensAgent => false;

  @override
  String get deniedAdvice =>
      'Allow it in System Settings ▸ Notifications ▸ Harness.';

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
  String get deniedAdvice =>
      'Allow it in System Settings ▸ Notifications ▸ Harness.';

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

  Future<NotificationPermission> _ask(String method, Object? args) =>
      _askNotifications(_channel, method, args);
}

/// One call on `harness/notifications`, answered as the macOS and Windows
/// runners answer: a missing runner is [NotificationPermission.unavailable],
/// any other failure [NotificationPermission.unknown].
Future<NotificationPermission> _askNotifications(
  MethodChannel channel,
  String method,
  Object? args,
) async {
  try {
    return NotificationPermission.parse(
      await channel.invokeMethod<String>(method, args),
    );
  } on MissingPluginException {
    return NotificationPermission.unavailable;
  } catch (_) {
    return NotificationPermission.unknown;
  }
}

/// The toast's tag for notification [id]: `harness-` and the FNV-1a 32-bit
/// hash of its UTF-8, in hex. A toast posted under a tag replaces the one
/// already there, as the Mac's identifier does, and Windows caps a tag at 64
/// characters, which an agent's id can pass.
String windowsToastTag(String id) {
  var hash = 0x811c9dc5;
  for (final byte in utf8.encode(id)) {
    hash ^= byte;
    hash = (hash * 0x01000193) & 0xffffffff;
  }
  return 'harness-${hash.toRadixString(16).padLeft(8, '0')}';
}

/// Windows: toasts through WinRT's `ToastNotificationManager`, in
/// `windows/runner/notifications.cpp`.
///
/// They post under the AUMID `Autonomous.Harness`, which only the installed
/// app's Start Menu shortcut carries. A copy run straight from the zip
/// answers [NotificationPermission.unavailable], and the banner keeps doing
/// the job. Windows has no permission prompt: [authorize] reports the switch
/// in Settings ▸ System ▸ Notifications.
///
/// A click is not a channel call. The toast launches its
/// `harness://notification/…` link ([NotificationLink]), which reaches the
/// running app through the single instance and `harness/community_links`, and
/// [SystemNotifications.openLink] sends it where a macOS click goes.
class WindowsSystemNotifier implements SystemNotifier {
  WindowsSystemNotifier({MethodChannel? channel})
    : _channel = channel ?? const MethodChannel('harness/notifications');

  final MethodChannel _channel;

  @override
  bool get supported => true;

  @override
  bool get clickOpensAgent => true;

  @override
  String get deniedAdvice =>
      'Allow it in Windows Settings ▸ System ▸ Notifications ▸ Harness.';

  @override
  Future<NotificationPermission> authorize() =>
      _askNotifications(_channel, 'authorize', null);

  @override
  Future<NotificationPermission> show({
    required String id,
    required String title,
    required String body,
    required String machineId,
    required String agentId,
  }) => _askNotifications(_channel, 'show', {
    'id': id,
    'title': title,
    'body': body,
    'machineId': machineId,
    'agentId': agentId,
    'tag': windowsToastTag(id),
    'launch': NotificationLink.build(machineId, agentId),
  });

  @override
  Future<void> withdraw(String id) async {
    try {
      await _channel.invokeMethod<void>('withdraw', {
        'id': id,
        'tag': windowsToastTag(id),
      });
    } catch (_) {}
  }

  /// Clicks come back as links ([SystemNotifications.openLink]), not here.
  @override
  set onTap(void Function(String machineId, String agentId)? handler) {}
}

/// Runs a command and hands back its result. Injected so a test can see what
/// would have been run without a notification daemon.
typedef ProcessRunner = Future<ProcessResult> Function(
  String executable,
  List<String> arguments,
);

/// [run] on a short-lived isolate of its own, named for the executable.
///
/// Dart starts a process synchronously on the calling isolate: it forks and
/// waits for the child to exec before `Process.run` returns. On Linux the UI
/// isolate runs on GTK's main thread (Flutter 3.47), so `notify-send` started
/// there for every notification held up the frame and the window's events
/// until the child had been scheduled — 0.22 ms median and up to 18–43 ms on a
/// loaded Mac (posix_file_mode.dart; Linux not measured). The isolate takes
/// that wait instead. Its result, and a [ProcessException], come back as they
/// are.
ProcessRunner offUiIsolate([ProcessRunner run = Process.run]) =>
    (executable, arguments) =>
        Isolate.run(() => run(executable, arguments), debugName: executable);

/// Linux: `notify-send`, which talks to whatever notification daemon the
/// desktop already runs. No native dependency, and no click action — the tool
/// has none, so a click does what the desktop's own default is.
class LinuxSystemNotifier implements SystemNotifier {
  LinuxSystemNotifier({ProcessRunner? run}) : _run = run ?? offUiIsolate();

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
  String get deniedAdvice =>
      'Allow it in System Settings ▸ Notifications ▸ Harness.';

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

/// The notifier for the platform this build runs on ([operatingSystem] is
/// `Platform.operatingSystem` unless a test names one).
SystemNotifier platformSystemNotifier({String? operatingSystem}) {
  if (kIsWeb) return browserSystemNotifier();
  return switch (operatingSystem ?? Platform.operatingSystem) {
    'macos' => MacSystemNotifier(),
    'linux' => LinuxSystemNotifier(),
    'windows' => WindowsSystemNotifier(),
    _ => const NoSystemNotifier(),
  };
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
  final _pending = <String, Future<void>>{};

  // Posting may wait for an OS permission callback. Keep a read/withdraw
  // behind that post, and a later notification behind the withdraw, so an old
  // asynchronous post cannot bring back a message that was already read.
  void _ordered(String id, Future<void> Function() operation) {
    final previous = _pending[id];
    late final Future<void> current;
    current =
        (previous == null
                ? Future<void>.sync(operation)
                : previous.then((_) => operation()))
            .catchError((_) {})
            .whenComplete(() {
              if (identical(_pending[id], current)) _pending.remove(id);
            });
    _pending[id] = current;
  }

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
    _ordered(
      idFor(alert.machineId, alert.agentId),
      () => notifier
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

  /// What a device notice puts in the `machineId` slot of a click. The slots carry an agent's address
  /// and the native side hands them back unchanged, so this marks "not an agent" without a new field
  /// in the Swift code; [postNotice] puts the device's key in the `agentId` slot.
  static const deviceNoticeMachine = '@device';

  /// What a Swarm tag's notice puts in the `machineId` slot; the `agentId` slot holds
  /// `<swarm tab id>/<tag id>` ([mention]), which the click opens (swarm_screen.dart).
  static const mentionNoticeMachine = '@mention';

  /// News about the ACCOUNT rather than an agent — a device joined it, a person was tagged. The same
  /// switch and the same rules as [post]; a click on it opens that device ([devicePub]) or that tag
  /// in its Swarm ([mention]) when given, else nothing.
  void postNotice({
    required String id,
    required String title,
    required String body,
    String? devicePub,
    ({String tabId, String mentionId})? mention,
  }) {
    if (!store.value || !supported) return;
    if (permission.value == NotificationPermission.unavailable) return;
    _ordered(
      id,
      () => notifier
          .show(
            id: id,
            title: title,
            body: body,
            machineId: mention != null
                ? mentionNoticeMachine
                : devicePub == null
                ? ''
                : deviceNoticeMachine,
            agentId: mention != null
                ? '${mention.tabId}/${mention.mentionId}'
                : devicePub ?? '',
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
    final id = idFor(machineId, agentId);
    _ordered(id, () => notifier.withdraw(id));
  }

  void Function(String machineId, String agentId)? _onTap;

  /// Where a click on a notification goes. Null stops listening.
  set onTap(void Function(String machineId, String agentId)? handler) {
    _onTap = handler;
    notifier.onTap = handler;
  }

  /// A `harness://notification/…` link: what clicking a Windows toast opens.
  /// True when [url] is one, whether or not anything was listening, because
  /// such a link is never a community link. The click goes to [onTap], the
  /// handler a macOS notification click calls. A link that names no agent (or
  /// one that arrives before the workspace listens, which is a click that
  /// launched Harness) only opens the app, as on macOS.
  bool openLink(String url) {
    final link = NotificationLink.parse(url);
    if (link == null) return false;
    if (link.machineId.isNotEmpty && link.agentId.isNotEmpty) {
      _onTap?.call(link.machineId, link.agentId);
    }
    return true;
  }
}

/// The store the app reads, loaded at start-up beside the other preferences.
final desktopNotificationStore = DesktopNotificationStore();

/// The app's one channel to the operating system's notifications.
final systemNotifications = SystemNotifications();
