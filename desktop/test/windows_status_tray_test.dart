// The Windows tray (`windows/runner/tray.cpp`): the rows the workspace hands
// it, what comes back when one is chosen, and the one-time notice when the
// close button hides Harness instead of quitting it.
import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/windows_status_tray.dart';
import 'package:harness/notify/alert_sounds.dart';
import 'package:harness/notify/system_notifications.dart';

import 'support/memory_key_value_store.dart';
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

class _Notifier implements SystemNotifier {
  NotificationPermission answer = NotificationPermission.granted;
  final shown = <String>[];
  Completer<void>? waitBeforeShowing;

  @override
  bool get supported => true;

  @override
  bool get clickOpensAgent => true;

  @override
  String get deniedAdvice => '';

  @override
  Future<NotificationPermission> authorize() async => answer;

  @override
  Future<NotificationPermission> show({
    required String id,
    required String title,
    required String body,
    required String machineId,
    required String agentId,
  }) async {
    shown.add('$id|$title|$body');
    await waitBeforeShowing?.future;
    return answer;
  }

  @override
  Future<void> withdraw(String id) async {}

  @override
  set onTap(void Function(String machineId, String agentId)? handler) {}
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('test/status_menu');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  late List<MethodCall> calls;

  setUp(() {
    calls = [];
    messenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call);
      return null;
    });
  });

  tearDown(() {
    messenger.setMockMethodCallHandler(channel, null);
    channel.setMethodCallHandler(null);
  });

  Future<void> fromNative(String method, [Object? arguments]) {
    final done = Completer<void>();
    messenger.handlePlatformMessage(
      channel.name,
      const StandardMethodCodec().encodeMethodCall(
        MethodCall(method, arguments),
      ),
      (_) => done.complete(),
    );
    return done.future;
  }

  TrayNoticeStore notice() => TrayNoticeStore(storage: MemoryKeyValueStore());

  test('the tray is the runner\'s status menu channel', () {
    expect(WindowsStatusTray.channelName, 'harness/status_menu');
  });

  test('sends the rows once per change, and an empty tray when the workspace '
      'leaves', () async {
    final tray = WindowsStatusTray(channel: channel, notice: notice());
    final row = <String, Object?>{
      'machineId': 'm',
      'agentId': 'a',
      'unread': true,
      'title': 'Fix login',
    };
    await tray.update(
      entries: [row],
      workingEntries: const [],
      workspaceAvailable: true,
    );
    await tray.update(
      entries: [Map.of(row)],
      workingEntries: const [],
      workspaceAvailable: true,
    );
    await tray.clear();
    expect(calls.map((call) => call.method), ['update', 'update']);
    expect(calls.first.arguments, {
      'entries': [row],
      'workingEntries': [],
      'workspaceAvailable': true,
    });
    expect(calls.last.arguments, {
      'entries': [],
      'workingEntries': [],
      'workspaceAvailable': false,
    });
  });

  test(
    'a chosen row reaches the workspace, and the icon reveals the window',
    () async {
      var reveals = 0;
      final chosen = <Map>[];
      final tray = WindowsStatusTray(
        channel: channel,
        notice: notice(),
        reveal: () async => reveals++,
      )..install();
      // No workspace on screen: nothing to open.
      await fromNative('selected', {'machineId': 'm', 'agentId': 'a'});
      tray.onSelected = (receipt) async => chosen.add(receipt);
      await fromNative('selected', {
        'machineId': 'm',
        'agentId': 'a',
        'readToken': 't',
      });
      await fromNative('openApp');
      await fromNative('somethingElse');
      expect(chosen, [
        {'machineId': 'm', 'agentId': 'a', 'readToken': 't'},
      ]);
      expect(reveals, 1);
    },
  );

  test('hiding to the tray says so once, counted once Windows has shown it', () async {
    final store = MemoryKeyValueStore();
    final notifier = _Notifier()..answer = NotificationPermission.unavailable;
    WindowsStatusTray(
      channel: channel,
      notice: TrayNoticeStore(storage: store),
      notifier: () => notifier,
    ).install();
    await fromNative('hidden');
    notifier.answer = NotificationPermission.granted;
    await fromNative('hidden');
    await fromNative('hidden');
    const shown =
        '${WindowsStatusTray.noticeId}|Harness|Harness is still running in the tray.';
    expect(notifier.shown, [shown, shown]);
    // The next start remembers.
    WindowsStatusTray(
      channel: channel,
      notice: TrayNoticeStore(storage: store),
      notifier: () => notifier,
    ).install();
    await fromNative('hidden');
    expect(notifier.shown, hasLength(2));
  });

  test('concurrent hides share one pending notice', () async {
    final store = MemoryKeyValueStore();
    final showing = Completer<void>();
    final notifier = _Notifier()..waitBeforeShowing = showing;
    WindowsStatusTray(
      channel: channel,
      notice: TrayNoticeStore(storage: store),
      notifier: () => notifier,
    ).install();
    final first = fromNative('hidden');
    final second = fromNative('hidden');
    await Future<void>.delayed(Duration.zero);
    final attemptsWhilePending = notifier.shown.length;
    showing.complete();
    await Future.wait([first, second]);
    expect(attemptsWhilePending, 1);
    expect(store.values['app_tray_notice_shown'], 'on');
    await fromNative('hidden');
    expect(notifier.shown, hasLength(1));
  });

  test('Quit asks the runner to quit for real', () async {
    await WindowsStatusTray(channel: channel, notice: notice()).quit();
    expect(calls.single.method, 'quit');
  });

  testWidgets('the workspace feeds the tray and opens the row chosen there', (
    tester,
  ) async {
    const windowChannel = MethodChannel('window_manager');
    final windowActions = <String>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      windowChannel,
      (call) async {
        windowActions.add(call.method);
        return call.method == 'isMinimized' ? false : null;
      },
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        windowChannel,
        null,
      ),
    );
    final updates = <Map>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
      call,
    ) async {
      if (call.method == 'update') updates.add(call.arguments as Map);
      return null;
    });
    final app = createApp(connected: true)..watchedAgents = () => const [];
    final resultTab = app.activeSwarmId;
    app.adoptSessionForTest(terminal('a8', []));
    app.newSwarm(name: 'Desktop');
    app.adoptSessionForTest(terminal('a0', []));
    final originalTab = app.activeSwarmId;
    app.agentUnread.mark('m', 'a8', AlertKind.done);
    final tray = WindowsStatusTray(channel: channel, notice: notice())
      ..install();
    await mount(tester, app, statusTray: tray);
    await tester.pumpAndSettle();
    expect(updates.last['workspaceAvailable'], isTrue);
    var row = (updates.last['entries'] as List).cast<Map>().single;
    expect(row['agentId'], 'a8');
    expect(app.activeSwarmId, originalTab);

    Future<void> select(Map receipt) async {
      final done = Completer<void>();
      tester.binding.defaultBinaryMessenger.handlePlatformMessage(
        channel.name,
        const StandardMethodCodec().encodeMethodCall(
          MethodCall('selected', receipt),
        ),
        (_) => done.complete(),
      );
      // Platform replies and destination focus both need the next frame.
      for (var i = 0; i < 8 && !done.isCompleted; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      await tester.pumpAndSettle();
      expect(done.isCompleted, isTrue);
    }

    // A menu can stay open while a newer completion replaces its receipt.
    // The tray must use the workspace's existing freshness check.
    app.agentUnread.mark('m', 'a8', AlertKind.failed, fresh: true);
    await tester.pump();
    await select(row);
    expect(app.activeSwarmId, originalTab);
    expect(app.agentUnread.kindFor('m', 'a8'), AlertKind.failed);
    row = (updates.last['entries'] as List).cast<Map>().single;

    await select(row);
    expect(app.activeSwarmId, resultTab);
    expect(app.agentUnread.kindFor('m', 'a8'), isNull);
    expect(windowActions, contains('show'));

    await tester.pumpWidget(const SizedBox());
    expect(updates.last, {
      'entries': [],
      'workingEntries': [],
      'workspaceAvailable': false,
    });
    app.dispose();
  });
}
