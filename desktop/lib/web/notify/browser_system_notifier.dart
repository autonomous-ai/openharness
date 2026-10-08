import 'dart:js_interop';
import 'dart:js_interop_unsafe';

import 'package:web/web.dart' as web;

import '../../notify/system_notifications.dart';

/// The notifier a browser build uses — see `notify/browser_notifier.dart`.
SystemNotifier browserSystemNotifier() => BrowserSystemNotifier();

/// The browser's own notifications (the Notification API): the web build's
/// third channel beside the banner and the sound, as `UNUserNotificationCenter`
/// is on macOS. Posted only while the tab is not in front, like everywhere.
///
/// One per agent, under the same id the desktop uses, as the notification's
/// `tag`: the browser replaces an agent's last one instead of stacking them.
/// A click brings this tab forward and opens that agent.
///
/// A phone's browser offers the API but posts only through a service worker,
/// so constructing a notification throws there: that reads as
/// [NotificationPermission.unavailable], and the banner keeps doing the job.
class BrowserSystemNotifier implements SystemNotifier {
  BrowserSystemNotifier({this.icon = 'icons/icon-192.png'});

  /// Relative to the page's base, which serves the bundle's own icons.
  final String icon;

  final _shown = <String, web.Notification>{};
  void Function(String machineId, String agentId)? _onTap;

  @override
  bool get supported => globalContext.has('Notification');

  @override
  bool get clickOpensAgent => true;

  @override
  String get deniedAdvice =>
      "Allow notifications for this site in the browser's site settings.";

  @override
  Future<NotificationPermission> authorize() async {
    if (!supported) return NotificationPermission.unavailable;
    final current = _read(web.Notification.permission);
    if (current != NotificationPermission.unknown) return current;
    try {
      return _read((await web.Notification.requestPermission().toDart).toDart);
    } catch (_) {
      return NotificationPermission.unknown;
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
    if (!supported) return NotificationPermission.unavailable;
    final permission = _read(web.Notification.permission);
    if (permission != NotificationPermission.granted) return permission;
    try {
      _shown.remove(id)?.close();
      final notification = web.Notification(
        title,
        web.NotificationOptions(body: body, tag: id, icon: icon),
      );
      notification
        ..onclick = ((web.Event _) {
          web.window.focus();
          _close(id, notification);
          final handler = _onTap;
          if (handler != null && machineId.isNotEmpty && agentId.isNotEmpty) {
            handler(machineId, agentId);
          }
        }).toJS
        ..onclose = ((web.Event _) => _forget(id, notification)).toJS;
      _shown[id] = notification;
      return NotificationPermission.granted;
    } catch (_) {
      return NotificationPermission.unavailable;
    }
  }

  @override
  Future<void> withdraw(String id) async {
    final notification = _shown[id];
    if (notification != null) _close(id, notification);
  }

  @override
  set onTap(void Function(String machineId, String agentId)? handler) =>
      _onTap = handler;

  void _close(String id, web.Notification notification) {
    _forget(id, notification);
    notification.close();
  }

  /// Only if [notification] is still the one under [id]: a replaced one
  /// closing late must not take its successor out of the map.
  void _forget(String id, web.Notification notification) {
    if (identical(_shown[id], notification)) _shown.remove(id);
  }

  static NotificationPermission _read(String value) => switch (value) {
    'granted' => NotificationPermission.granted,
    'denied' => NotificationPermission.denied,
    _ => NotificationPermission.unknown,
  };
}
