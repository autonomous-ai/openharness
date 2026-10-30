import 'dart:convert';

import 'package:flutter/services.dart';

import '../notify/alert_sounds.dart';
import '../notify/system_notifications.dart';
import 'desktop_window.dart';

/// Whether Windows has said "Harness is still running in the tray." once.
///
/// On Windows the close button hides Harness to the tray instead of quitting
/// it, which is not what it means on a Mac. The first time, a toast says
/// where the window went.
class TrayNoticeStore extends OnOffPreference {
  TrayNoticeStore({super.storage}) : super('app_tray_notice_shown');
}

/// Harness in the Windows notification area (`windows/runner/tray.cpp`), on
/// `harness/status_menu`.
///
/// Dart → native:
/// - `update({entries, workingEntries, workspaceAvailable})`: the rows the
///   macOS status menu draws, straight from `statusMenuEntries` and
///   `statusMenuWorkingEntries`. The workspace sends them while it is on
///   screen, and [clear]s them when it leaves.
/// - `quit`: leave for real ([quitHarness]). The window's close button only
///   hides it.
///
/// Native → Dart:
/// - `selected(<row>)`: a notification or working row was chosen, and the
///   workspace opens it as a macOS menu click does ([onSelected]);
/// - `openApp`: the icon, or Open Harness, brought the window forward;
/// - `hidden`: the close button hid the window to the tray.
class WindowsStatusTray {
  WindowsStatusTray({
    MethodChannel? channel,
    TrayNoticeStore? notice,
    SystemNotifier Function()? notifier,
    Future<void> Function()? reveal,
  }) : _channel = channel ?? const MethodChannel(channelName),
       _notice = notice ?? TrayNoticeStore(),
       _notifier = notifier ?? (() => systemNotifications.notifier),
       _reveal = reveal ?? revealWindow;

  static const channelName = 'harness/status_menu';
  static const noticeId = 'harness-tray-notice';
  static const noticeBody = 'Harness is still running in the tray.';

  final MethodChannel _channel;
  final TrayNoticeStore _notice;
  final SystemNotifier Function() _notifier;
  final Future<void> Function() _reveal;
  String? _sent;
  bool _installed = false;
  Future<void>? _noticePending;

  /// Where a chosen row goes: the workspace's `_openStatusHarness`. Null while
  /// no workspace is on screen, which is when the tray has no rows.
  Future<void> Function(Map receipt)? onSelected;

  /// Starts listening to the runner. Once, at start-up, on Windows only.
  void install() {
    if (_installed) return;
    _installed = true;
    _channel.setMethodCallHandler(_receive);
  }

  /// The tray's rows. Sent only when they changed.
  Future<void> update({
    required List<Map<String, Object?>> entries,
    required List<Map<String, Object?>> workingEntries,
    required bool workspaceAvailable,
  }) async {
    final state = <String, Object?>{
      'entries': entries,
      'workingEntries': workingEntries,
      'workspaceAvailable': workspaceAvailable,
    };
    final encoded = jsonEncode(state);
    if (encoded == _sent) return;
    _sent = encoded;
    try {
      await _channel.invokeMethod<void>('update', state);
    } on MissingPluginException {
      // No runner answers: a test, or a build without the tray.
    }
  }

  /// No workspace: "Open Harness to get started", and no rows to choose.
  Future<void> clear() => update(
    entries: const [],
    workingEntries: const [],
    workspaceAvailable: false,
  );

  /// Leaves Harness for real, through Flutter's exit request.
  Future<void> quit() async {
    try {
      await _channel.invokeMethod<void>('quit');
    } on MissingPluginException {
      // Nothing to ask.
    }
  }

  Future<void> _receive(MethodCall call) async {
    switch (call.method) {
      case 'selected':
        if (call.arguments case final Map receipt) {
          await onSelected?.call(receipt);
        }
      case 'openApp':
        await _reveal();
      case 'hidden':
        await _noticeOnce();
    }
  }

  /// Once, and counted only after Windows has shown it: a copy run straight
  /// from the zip cannot post a toast, and says so the next time instead.
  Future<void> _noticeOnce() => _noticePending ??= _showNotice().whenComplete(
    () => _noticePending = null,
  );

  Future<void> _showNotice() async {
    await _notice.load();
    if (_notice.value) return;
    final answer = await _notifier().show(
      id: noticeId,
      title: 'Harness',
      body: noticeBody,
      machineId: '',
      agentId: '',
    );
    if (answer == NotificationPermission.granted) await _notice.set(true);
  }
}

/// The app's one tray.
final windowsStatusTray = WindowsStatusTray();

/// Quits Harness for real on Windows, where the close button only hides it.
Future<void> quitHarness() => windowsStatusTray.quit();
