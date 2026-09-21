import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/restart_connection.dart';
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late RestartConnection connection;
  late AppNotifier app;
  bool disposed = false;
  setUp(() {
    connection = RestartConnection();
    app = createApp(connectionForTest: (_) => connection);
    disposed = false;
  });
  tearDown(() {
    if (!disposed) app.dispose();
  });
  String id() => connection.requests.last['creationId'] as String;

  test(
    'restart joins across views and preserves tabs, focus and sessions',
    () async {
      final source = app.adoptSessionForTest(terminal('a0', []));
      final session = source.session;
      app.newSwarm(name: 'Other work');
      final other = app.adoptSessionForTest(terminal('a1', []));
      final target = app.activeSwarm;
      final attempt = app.restartAttempt('m', 'a0');
      final first = app.restartAgent('m', 'a0', attempt: attempt);
      expect(app.restartAgent('m', 'a0'), same(first));
      connection.restartReplies.single.complete(restartReceipt(id()));
      expect((await first).error, isNull);
      expect(
        await app.restartAgent('m', 'a0', attempt: attempt),
        same(attempt.result),
      );
      expect(connection.requests, hasLength(1));
      expect(app.activeSwarm, same(target));
      expect(app.focusedPane, same(other));
      expect(source.session, same(session));
      expect(app.allPanes, hasLength(2));
    },
  );

  test('lost response checks the original receipt and retains fresh-session outcome', () async {
    final attempt = app.restartAttempt('m', 'a0');
    var request = app.restartAgent('m', 'a0', attempt: attempt);
    connection.restartReplies.single.completeError(
      const WsRequestTimeout('agent_restart'),
    );
    expect((await request).error, contains('not confirmed'));
    expect(app.restartAttempt('m', 'a0'), same(attempt));
    request = app.restartAgent('m', 'a0');
    connection.checkReplies.last.complete({
      'creationId': id(),
      'state': 'pending',
    });
    expect((await request).error, contains('still restarting'));
    request = app.restartAgent('m', 'a0');
    connection.checkReplies.last.complete(restartReceipt(id(), resumed: false));
    expect((await request).resumed, isFalse);
    expect(connection.requests, hasLength(1));
    expect(connection.checks, [
      {'creationId': id()},
      {'creationId': id()},
    ]);
  });

  for (final state in [
    'missing',
    'unconfirmed',
    'wrong receipt',
    'malformed',
    'wrong agent',
  ]) {
    test('$state cannot implicitly repeat the restart', () async {
      final attempt = app.restartAttempt('m', 'a0');
      final request = app.restartAgent('m', 'a0');
      final previous = id();
      connection.restartReplies.single.complete(switch (state) {
        'wrong receipt' => restartReceipt('another-intent'),
        'malformed' => {'creationId': id(), 'state': 'created', 'agent': {}},
        'wrong agent' => restartReceipt(id(), agentId: 'a1'),
        _ => {'creationId': id(), 'state': state},
      });
      expect((await request).error, isNotNull);
      final check = app.restartAgent('m', 'a0');
      connection.checkReplies.single.complete({'error': 'UNKNOWN_TYPE'});
      expect((await check).error, isNotNull);
      expect(connection.requests, hasLength(1));
      expect(app.discardRestartAttempt('m', 'a0', attempt), isTrue);
      final fresh = app.restartAgent('m', 'a0');
      expect(id(), isNot(previous));
      connection.restartReplies.last.complete(restartReceipt(id()));
      expect((await fresh).error, isNull);
    });
  }

  test('a confirmed refusal allows a new receipt on retry', () async {
    final first = app.restartAgent('m', 'a0');
    final previous = id();
    connection.restartReplies.single.complete({
      'creationId': previous,
      'state': 'failed',
      'failure': {
        'code': 'AGENT_BUSY',
        'detail': 'Wait for the other operation.',
      },
    });
    expect((await first).error, 'Wait for the other operation.');
    final retry = app.restartAgent('m', 'a0');
    expect(id(), isNot(previous));
    connection.restartReplies.last.complete(restartReceipt(id()));
    expect((await retry).error, isNull);
  });

  for (final change in [
    'machine',
    'removed',
    'recreated',
    'dispose',
    'stop pending',
    'stop refused',
  ]) {
    test('late restart cannot undo $change', () async {
      final first = app.restartAgent('m', 'a0');
      Future<String?>? stop;
      switch (change) {
        case 'machine':
          app.machineStates['m'] = MachineState(app.stateOf('m')!.machine)
            ..agents = [const Agent(id: 'a0', name: 'Replacement')];
        case 'removed':
        case 'recreated':
          await app.handleEventForTest('m', {
            'type': 'agent_deleted',
            'payload': {'agentId': 'a0'},
          });
          if (change == 'recreated') {
            app
                .stateOf('m')!
                .agents
                .add(const Agent(id: 'a0', name: 'Replacement'));
          }
        case 'dispose':
          app.dispose();
          disposed = true;
        case 'stop pending':
        case 'stop refused':
          stop = app.deleteAgent('m', 'a0');
          if (change == 'stop refused') {
            connection.stopReplies.single.complete({'error': 'REFUSED'});
            await stop;
          }
      }
      connection.restartReplies.single.complete(
        restartReceipt(id(), name: 'Stale'),
      );
      expect((await first).error, contains('changed'));
      expect((await first).retryable, isFalse);
      if (!disposed) {
        expect(app.stateOf('m')!.agents.any((a) => a.name == 'Stale'), isFalse);
      }
      if (change == 'stop pending') {
        connection.stopReplies.single.complete({'deleted': true});
        await stop;
      }
    });
  }

  test('a changed source before dispatch sends nothing; reopening uses the current source', () async {
    final old = app.restartAttempt('m', 'a0');
    app.stateOf('m')!.agents[0] = const Agent(
      id: 'a0',
      name: 'New session',
      sessionId: 'new',
    );
    expect(
      (await app.restartAgent('m', 'a0', attempt: old)).error,
      contains('changed'),
    );
    expect(connection.requests, isEmpty);
    expect(app.restartAttempt('m', 'a0'), isNot(same(old)));
  });

  test(
    'newer name and session observations outrank an old restart receipt',
    () async {
      final first = app.restartAgent('m', 'a0');
      await app.handleEventForTest('m', {
        'type': 'agent_renamed',
        'payload': {'agentId': 'a0', 'name': 'A better name'},
      });
      connection.restartReplies.single.complete(
        restartReceipt(id(), sessionId: 'fresh', resumed: false),
      );
      await first;
      expect(
        app.stateOf('m')!.agents.firstWhere((a) => a.id == 'a0').name,
        'A better name',
      );
      final second = app.restartAgent('m', 'a0');
      app.stateOf('m')!.agents[0] = const Agent(
        id: 'a0',
        name: 'Latest',
        sessionId: 'later',
      );
      connection.restartReplies.last.complete(
        restartReceipt(id(), sessionId: 'old'),
      );
      await second;
      expect(app.stateOf('m')!.agents[0].sessionId, 'later');
      expect(app.stateOf('m')!.agents[0].name, 'Latest');
    },
  );

  test(
    'inventory begun before restart cannot undo its fresh session',
    () async {
      connection.inventory = Completer<Map<String, dynamic>>();
      final read = app.reloadMachineData('m');
      await Future<void>.delayed(Duration.zero);
      final restart = app.restartAgent('m', 'a0');
      connection.restartReplies.single.complete(
        restartReceipt(id(), sessionId: 'fresh'),
      );
      await restart;
      connection.inventory!.complete({
        'agents': [
          {'id': 'a0', 'name': 'Old', 'sessionId': 'old'},
        ],
      });
      await read;
      expect(app.stateOf('m')!.agents.single.sessionId, 'fresh');
    },
  );

  test('missing and shared agents cannot restart', () async {
    expect(
      (await app.restartAgent('missing', 'a0')).error,
      'Machine not found',
    );
    expect((await app.restartAgent('m', 'missing')).error, contains('changed'));
    app.stateOf('m')!.machine = const Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      isShared: true,
    );
    expect((await app.restartAgent('m', 'a0')).error, contains('view-only'));
    expect(connection.requests, isEmpty);
  });
}
