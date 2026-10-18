import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/logging/app_log.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show createApp;

/// A current daemon with two agents that answers every request and never answers an open, so a
/// reattached session stays `opening` until the test breaks it again.
class _Connection extends WsConn {
  _Connection()
    : super(
        wsBaseUrl: '',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final opened = <String>[];
  final opens = <Map<String, dynamic>>[];
  int forceReconnects = 0;

  /// The machine's link is gone: nothing sent on it goes through.
  bool refuse = false;
  @override
  Future<void> waitUntilReady({required Duration timeout}) async {}
  @override
  Future<void> forceReconnect() async => forceReconnects++;
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async => type == 'agents_list'
      ? {
          'agents': [
            for (final id in ['a0', 'a1'])
              {
                'id': id,
                'name': id,
                'engine': 'codex',
                'terminal': {
                  'runtimes': [
                    {'backend': 'tmux', 'paneId': id == 'a0' ? '%1' : '%2'},
                  ],
                },
              },
          ],
        }
      : {
          'protocolVersion': 3,
          'backend': 'tmux',
          'available': true,
          'features': {'noTakeover': true},
        };
  @override
  Future<bool> sendTerminalFrame(
    String type,
    Map<String, dynamic> payload,
  ) async {
    if (type == 'terminal_open') {
      opened.add(payload['agentId'] as String);
      opens.add(payload);
    }
    return !refuse;
  }
}

class _RecordingLog implements AppLog {
  final lines = <String>[];
  @override
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) => lines.add('$category $message');
}

void main() {
  /// Two tabs, `a0` in the first (background) and `a1` in the second (in front), on a machine
  /// that has come back once, so its agents and terminal capability are loaded.
  Future<({AppNotifier app, _Connection connection, TerminalSession background})>
  rig(WidgetTester tester) async {
    final connection = _Connection();
    // Disposed at the end of each test body: it disposes the sessions too, whose open watchdogs
    // and this sweep's timers must not outlive the body.
    final app = createApp(connectionForTest: (_) => connection);
    app.machineStates['m']!.nodeOnline = true;
    TerminalSession terminal(String id) => TerminalSession(
      machineId: 'm',
      agentId: id,
      agentName: id,
      engineId: 'codex',
      send: connection.sendTerminalFrame,
      sendBinary: (_) async => true,
      // The fake daemon never answers an open; keep the open watchdog out of these timelines.
      resyncTimeout: const Duration(hours: 1),
    )..status = TerminalSessionStatus.controlling;
    final background = terminal('a0');
    app.adoptSessionForTest(background);
    app.newSwarm(name: 'Second');
    app.adoptSessionForTest(terminal('a1'));
    await app.handleEventForTest('m', {
      'type': 'node_status',
      'payload': {'online': false},
    });
    await app.handleEventForTest('m', {
      'type': 'node_status',
      'payload': {'online': true},
    });
    for (var i = 0; i < 30; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    connection.opened.clear();
    connection.opens.clear();
    return (app: app, connection: connection, background: background);
  }

  testWidgets(
    'a pane whose stream died on a reachable machine is reattached without a click, behind another tab',
    (tester) async {
      final log = _RecordingLog();
      final previous = appLog;
      appLog = log;
      addTearDown(() => appLog = previous);
      final r = await rig(tester);

      r.background.transportLost('gone');
      await tester.pump(const Duration(milliseconds: 900));
      expect(r.connection.opened, isEmpty);
      await tester.pump(const Duration(milliseconds: 200));

      expect(r.connection.opened, ['a0']);
      expect(log.lines, contains('terminal reattach machine=m agent=a0 attempt=1'));
      r.app.dispose();
    },
  );

  testWidgets('each further attempt waits longer: 1 s, then 2 s', (tester) async {
    final r = await rig(tester);

    r.background.transportLost('gone');
    await tester.pump(const Duration(milliseconds: 1100));
    expect(r.connection.opened, ['a0']);

    r.background.transportLost('gone again');
    await tester.pump(const Duration(milliseconds: 1100));
    expect(r.connection.opened, ['a0'], reason: 'the second wait is 2 s');
    await tester.pump(const Duration(seconds: 1));
    expect(r.connection.opened, ['a0', 'a0']);
    r.app.dispose();
  });

  testWidgets(
    'a sweep reopen never takes the terminal, whatever the last open asked for',
    (tester) async {
      final r = await rig(tester);
      expect(r.background.takeover, isTrue, reason: 'a person opened it');

      r.background.transportLost('gone');
      await tester.pump(const Duration(milliseconds: 1100));

      expect(r.connection.opens.single['takeover'], isFalse);
      r.app.dispose();
    },
  );

  testWidgets('a pane someone else took is never reattached', (tester) async {
    final r = await rig(tester);
    r.background.transportLost('gone');
    await tester.pump(const Duration(milliseconds: 1100));
    await r.app.handleEventForTest('m', {
      'type': 'terminal_error',
      'payload': {
        'requestId': r.connection.opens.single['requestId'],
        'code': 'CONTROL_LEASE_HELD',
      },
    });
    expect(r.background.status, TerminalSessionStatus.takenOver);

    await tester.pump(const Duration(seconds: 40));

    expect(r.connection.opens, hasLength(1));
    r.app.dispose();
  });

  testWidgets('a dead watcher is reattached, as a watcher', (tester) async {
    final r = await rig(tester);
    r.background
      ..watching = true
      ..takeover = false;

    r.background.transportLost('gone');
    await tester.pump(const Duration(milliseconds: 1100));

    expect(r.connection.opens.single['takeover'], isFalse);
    r.app.dispose();
  });

  testWidgets('a pane that is live again keeps no retry going', (tester) async {
    final r = await rig(tester);
    r.background.transportLost('gone');
    await tester.pump(const Duration(milliseconds: 1100));
    await r.app.handleEventForTest('m', {
      'type': 'terminal_ready',
      'payload': {
        'requestId': r.connection.opens.single['requestId'],
        'protocolVersion': 3,
        'streamId': '00112233-4455-6677-8899-aabbccddeeff',
        'agentId': 'a0',
      },
    });
    await r.background.handleBinary(
      TerminalBinaryFrame(
        kind: TerminalBinaryKind.keyframe,
        streamId: '00112233-4455-6677-8899-aabbccddeeff',
        seq: 0,
        bytes: Uint8List.fromList('prompt> '.codeUnits),
        compressed: false,
        cols: 80,
        rows: 24,
      ),
    );
    expect(r.background.status, TerminalSessionStatus.controlling);

    await tester.pump(const Duration(seconds: 60));

    expect(r.connection.opens, hasLength(1));
    r.app.dispose();
  });

  testWidgets('a stream this app closed itself is left closed', (tester) async {
    final r = await rig(tester);

    await r.background.close();
    await tester.pump(const Duration(seconds: 3));

    expect(r.connection.opened, isEmpty);
    r.app.dispose();
  });

  testWidgets('nothing is retried while the machine is offline', (tester) async {
    final r = await rig(tester);

    await r.app.handleEventForTest('m', {
      'type': 'node_status',
      'payload': {'online': false},
    });
    // The first retry would come after 1 s. Stay under the offline poll's 5 s tick, which reads the
    // live machine list (refused under test).
    await tester.pump(const Duration(seconds: 4));

    expect(r.connection.opened, isEmpty);

    // Back online, which stops the offline poll's timer before the test ends.
    await r.app.handleEventForTest('m', {
      'type': 'node_status',
      'payload': {'online': true},
    });
    for (var i = 0; i < 30; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    r.app.dispose();
  });

  // Each dead pane's first reattach may redial the machine when its open goes unanswered, and a
  // redial knocks every pane on the machine over: N dead panes redialled one machine N times.
  testWidgets('dead panes on one machine redial its link once, not once each', (
    tester,
  ) async {
    final connection = _Connection();
    final app = createApp(connectionForTest: (_) => connection);
    app.machineStates['m']!.nodeOnline = true;
    // Tiles the app attaches itself once the machine answers, so an unanswered open asks the app to
    // redial the machine.
    unawaited(app.addAgentToSwarm('m', 'a0'));
    unawaited(app.addAgentToSwarm('m', 'a1'));
    await app.handleEventForTest('m', {
      'type': 'node_status',
      'payload': {'online': false},
    });
    await app.handleEventForTest('m', {
      'type': 'node_status',
      'payload': {'online': true},
    });
    for (var i = 0; i < 30; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    final sessions = [for (final pane in app.panes) pane.session!];
    expect(sessions, hasLength(2));
    expect(connection.opened, ['a0', 'a1']);

    connection.refuse = true;
    for (final session in sessions) {
      session.transportLost('gone');
    }
    // Both first reattaches (1 s), each with its redial and resends (3 s).
    for (var i = 0; i < 50; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }

    expect(connection.opened.skip(2).toSet(), {
      'a0',
      'a1',
    }, reason: 'both reattached');
    expect(connection.forceReconnects, 1);
    app.dispose();
  });

  testWidgets('only a stream dying or coming back runs the sweep', (
    tester,
  ) async {
    final r = await rig(tester);
    final sweeps = r.app.paneSweepsForTest;

    // A live session notifies on all sorts of changes: a title, a resize, a watcher band.
    for (var i = 0; i < 100; i++) {
      r.background.setEngineId(i.isEven ? 'claude' : 'codex');
    }
    expect(r.app.paneSweepsForTest, sweeps);

    r.background.transportLost('gone');
    expect(r.app.paneSweepsForTest, sweeps + 1);
    await tester.pump(const Duration(milliseconds: 1100));
    expect(r.connection.opened, ['a0'], reason: 'the retry still runs');
    r.app.dispose();
  });
}
