import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/gestures.dart' show kDoubleTapTimeout;
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/terminal_panel.dart';
import 'package:harness/ws/ws_conn.dart';
import 'package:xterm/xterm.dart';

import 'swarm_screen_test.dart' show mount;
import 'swarm_state_test.dart' show createApp;
import 'ws_conn_test.dart' show FakeHub;

class _ObservedSession extends TerminalSession {
  _ObservedSession(String id, List<TerminalBinaryFrame> input)
    : super(
        machineId: 'm',
        agentId: id,
        agentName: 'Session $id',
        engineId: 'codex',
        send: (_, _) async => true,
        sendBinary: (frame) async {
          if (frame.kind == TerminalBinaryKind.input) input.add(frame);
          return true;
        },
      ) {
    status = TerminalSessionStatus.controlling;
    streamId = 'stream-$id';
  }

  int frameCalls = 0;

  @override
  Future<bool> handleFrame(String type, Map<String, dynamic> payload) {
    frameCalls++;
    return super.handleFrame(type, payload);
  }
}

Future<void> _event(
  AppNotifier app,
  String type, [
  Map<String, dynamic> payload = const {},
]) => app.handleEventForTest('m', {'type': type, 'payload': payload});

void main() {
  testWidgets('negotiated session events keep the focused terminal usable', (
    tester,
  ) async {
    final app = createApp();
    app.machineStates['m']!.nodeOnline = true;
    final input = <TerminalBinaryFrame>[];
    final session = _ObservedSession('a0', input);
    app.adoptSessionForTest(session);
    await _event(app, 'turn_started', {'agentId': 'a0'});
    final hub = (await tester.runAsync(FakeHub.start))!;
    final delivered = (await tester.runAsync(() async => Completer<void>()))!;
    final connection = (await tester.runAsync(
      () async => WsConn(
        wsBaseUrl: 'wss://unused.example',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => 'unused',
        onAuthFailure: (_) {},
        onStatus: (_) {},
        transportKind: WsTransportKind.localPlaintext,
        allowLocalTcpFixture: true,
        localWsUri: Uri.parse('ws://127.0.0.1:${hub.port}/api/local-ws'),
        onEvent: (frame) async {
          await app.handleEventForTest('m', frame);
          if (frame['type'] == 'turn_ended') delivered.complete();
        },
      ),
    ))!;
    try {
      await mount(tester, app);
      await tester.tap(find.byType(TerminalView).first);
      // Finish xterm's tap classification before checking keyboard focus.
      await tester.pump(kDoubleTapTimeout);
      final focus = FocusManager.instance.primaryFocus;
      expect(app.agentIsProcessing('m', 'a0'), isTrue);
      await tester.runAsync(() async {
        await connection.connect();
        await connection.request('agents_list');
        hub.clients.single.add(
          jsonEncode({
            'type': 'session_event',
            'payload': {
              'generation': 'fixture',
              'frame': {
                'type': 'turn_ended',
                'agentId': 'a0',
                'payload': {'agentId': 'a0'},
              },
              'batch': {'id': 1, 'index': 0, 'count': 1},
            },
          }),
        );
        await delivered.future.timeout(const Duration(seconds: 5));
      });
      await tester.pump();
      expect(app.agentIsProcessing('m', 'a0'), isFalse);
      expect(FocusManager.instance.primaryFocus, same(focus));
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
      await tester.pump(const Duration(milliseconds: 5));
      expect(input, hasLength(1));
      expect(
        tester.widget<TerminalView>(find.byType(TerminalView).first).terminal,
        same(session.terminal),
      );
    } finally {
      await tester.runAsync(() async {
        await connection.close();
        await hub.close();
      });
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    }
  });

  for (final activity in ['heartbeats', 'dial scroll']) {
    testWidgets('$activity leave the surrounding workspace idle', (
      tester,
    ) async {
      final app = createApp();
      app.machineStates['m']!.nodeOnline = true;
      final sessions = <_ObservedSession>[];
      final inputs = List.generate(16, (_) => <TerminalBinaryFrame>[]);
      final first = app.activeSwarmId;
      for (var tab = 0; tab < 4; tab++) {
        if (tab > 0) app.newSwarm();
        for (var pane = 0; pane < 4; pane++) {
          final index = tab * 4 + pane;
          final session = _ObservedSession('a$index', inputs[index]);
          session.terminal.write(
            List.generate(200, (line) => 'History $line\r\n').join(),
          );
          sessions.add(session);
          app.adoptSessionForTest(session);
          await _event(app, 'turn_started', {'agentId': session.agentId});
        }
      }
      final previousObserver = debugOnRebuildDirtyWidget;
      try {
        await mount(tester, app);
        for (final tab in app.swarms) {
          app.selectSwarm(tab.id);
          await tester.pump();
        }
        app.selectSwarm(first);
        app.focusPane(app.panes.first.id);
        await tester.pump();
        await tester.pump();
        expect(
          find.byType(TerminalPanel, skipOffstage: false),
          findsNWidgets(16),
        );
        final views = tester
            .widgetList<TerminalView>(
              find.byType(TerminalView, skipOffstage: false),
            )
            .toList();
        final scrolls = {
          for (final view in views) view.terminal: view.scrollController!,
        };
        final before = {
          for (final entry in scrolls.entries) entry.key: entry.value.offset,
        };
        final focus = FocusManager.instance.primaryFocus;
        final rebuilds = <String, int>{};
        var notifications = 0;
        app.addListener(() => notifications++);
        for (final session in sessions) {
          session.frameCalls = 0;
        }
        debugOnRebuildDirtyWidget = (element, _) {
          final type = element.widget.runtimeType.toString();
          rebuilds.update(type, (count) => count + 1, ifAbsent: () => 1);
        };

        if (activity == 'heartbeats') {
          for (final session in sessions) {
            await _event(app, 'turn_heartbeat', {'agentId': session.agentId});
            await tester.pump();
          }
          expect(app.machineStates['m']!.processingAgentIds, hasLength(16));
        } else {
          await _event(app, 'dial_scroll', {'phase': 'down', 'dy': 0});
          await tester.pump();
          for (var i = 0; i < 16; i++) {
            await _event(app, 'dial_scroll', {'dy': 3, 'velocity': 0});
            await tester.pump();
          }
          await _event(app, 'dial_scroll', {'phase': 'up', 'dy': 0});
          await tester.pump();
          expect(
            scrolls[sessions.first.terminal]!.offset,
            lessThan(before[sessions.first.terminal]!),
          );
        }
        debugOnRebuildDirtyWidget = previousObserver;
        debugPrint(
          'WORKSPACE_EVENTS $activity: notifications=$notifications, '
          'terminalDispatches=${sessions.fold(0, (n, s) => n + s.frameCalls)}, '
          'workspaceBuilds=${rebuilds['PaneGrid'] ?? 0}',
        );
        for (final session in sessions.skip(1)) {
          expect(scrolls[session.terminal]!.offset, before[session.terminal]);
        }
        expect(FocusManager.instance.primaryFocus, same(focus));
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
        await tester.pump(const Duration(milliseconds: 5));
        expect(inputs.first, hasLength(1));
        expect(inputs.skip(1).expand((frames) => frames), isEmpty);
        expect(notifications, 0);
        expect(rebuilds['PaneGrid'] ?? 0, 0);
        expect(sessions.every((session) => session.frameCalls == 0), isTrue);
      } finally {
        debugOnRebuildDirtyWidget = previousObserver;
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      }
    });
  }

  testWidgets(
    'fresh heartbeat evidence renews the watchdog without workspace redraws',
    (tester) async {
      final app = createApp();
      addTearDown(app.dispose);
      var notifications = 0;
      app.addListener(() => notifications++);
      await _event(app, 'turn_heartbeat', {
        'agentId': 'a0',
        'activity': {
          'state': 'working',
          'epoch': 'fixture-daemon',
          'revision': 1,
          'validForMs': 12000,
        },
      });
      expect(app.agentIsProcessing('m', 'a0'), isTrue);
      expect(notifications, 1);
      await tester.pump(const Duration(seconds: 8));
      await _event(app, 'turn_heartbeat', {
        'agentId': 'a0',
        'activity': {
          'state': 'working',
          'epoch': 'fixture-daemon',
          'revision': 2,
          'validForMs': 12000,
        },
      });
      await tester.pump(const Duration(seconds: 8));
      expect(app.agentIsProcessing('m', 'a0'), isTrue);
      expect(notifications, 1);
      await tester.pump(const Duration(seconds: 5));
      expect(app.agentIsProcessing('m', 'a0'), isFalse);
      expect(notifications, 2);
    },
  );

  test(
    'device status still reaches its own observers without workspace churn',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      var workspaceChanges = 0;
      app.machineStates['m']!.localOnly = true;
      var deviceChanges = 0;
      app.addListener(() => workspaceChanges++);
      app.dial.addListener(() => deviceChanges++);
      await _event(app, 'dial_status', {'attached': true, 'fw': '1.2.3'});
      expect(app.dial.status.attached, isTrue);
      expect(app.dial.status.fw, '1.2.3');
      await _event(app, 'dial_status', {'attached': false});
      expect(app.dial.status.attached, isFalse);
      expect(deviceChanges, 2);
      expect(workspaceChanges, 0);
    },
  );
}
