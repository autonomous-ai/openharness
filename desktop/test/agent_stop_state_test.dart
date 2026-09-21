import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/stop_connection.dart';
import 'swarm_state_test.dart' show createApp;
import 'swarm_screen_test.dart' show terminal;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late StopConnection connection;
  late AppNotifier app;
  var disposed = false;
  setUp(() {
    connection = StopConnection();
    app = createApp(connectionForTest: (_) => connection);
    disposed = false;
  });
  tearDown(() {
    if (!disposed) app.dispose();
  });

  for (final change in ['machine', 'session', 'removed', 'recreated']) {
    test(
      'confirmation cannot stop a target changed by $change before accepting',
      () async {
        final confirm = app.prepareAgentStop('m', 'a0');
        if (change == 'machine') {
          app.machineStates['m'] = MachineState(app.stateOf('m')!.machine)
            ..agents = [const Agent(id: 'a0', name: 'Other machine')];
        } else if (change == 'session') {
          app.stateOf('m')!.agents = [
            const Agent(id: 'a0', name: 'Restarted', sessionId: 'replacement'),
          ];
        } else {
          await app.handleEventForTest('m', {
            'type': 'agent_deleted',
            'payload': {'agentId': 'a0'},
          });
          if (change == 'recreated') {
            app
                .stateOf('m')!
                .agents
                .add(const Agent(id: 'a0', name: 'Recreated'));
          }
        }
        expect(await confirm(), contains('The agent changed'));
        expect(connection.stops, isEmpty);
      },
    );
  }

  test(
    'confirmation still applies after an ordinary name or inventory update',
    () async {
      final confirm = app.prepareAgentStop('m', 'a0');
      app.stateOf('m')!.agents = [
        const Agent(id: 'a0', name: 'Renamed by another view', engine: 'codex'),
      ];
      final request = confirm();
      expect(connection.stops, ['a0']);
      connection.stopReplies.single.complete({'deleted': true});
      expect(await request, isNull);
    },
  );

  test('stop joins across views, blocks conflicting actions and removes only its panes', () async {
    final pane = app.adoptSessionForTest(terminal('a0', []));
    final first = app.activeSwarm;
    app.newSwarm();
    app.activeSwarm.panes.add(pane);
    final other = app.adoptSessionForTest(terminal('a1', []));
    final stopping = app.deleteAgent('m', 'a0');
    expect(app.deleteAgent('m', 'a0'), same(stopping));
    expect(app.pendingAgentStop('m', 'a0'), same(stopping));
    expect(await app.renameAgent('m', 'a0', 'New'), contains('stopping'));
    expect((await app.restartAgent('m', 'a0')).error, contains('stopping'));
    expect(connection.renames, isEmpty);
    expect(connection.restarts, 0);
    connection.stopReplies.single.complete({'deleted': true});
    expect(await stopping, isNull);
    expect(connection.stops, ['a0']);
    expect(first.panes, isEmpty);
    expect(app.allPanes, [other]);
    expect(pane.session, isNull);
    expect(app.stateOf('m')!.agents.any((a) => a.id == 'a0'), isFalse);
  });

  for (final change in ['machine', 'session', 'dispose']) {
    test('late stop cannot remove a changed $change', () async {
      final stop = app.deleteAgent('m', 'a0');
      if (change == 'dispose') {
        app.dispose();
        disposed = true;
      } else {
        final state = change == 'machine'
            ? MachineState(app.stateOf('m')!.machine)
            : app.stateOf('m')!;
        state.agents = [
          Agent(
            id: 'a0',
            sessionId: change == 'session' ? 'new' : null,
            name: 'Replacement',
          ),
        ];
        app.machineStates['m'] = state;
      }
      connection.stopReplies.single.complete({'deleted': true});
      expect(await stop, contains('agent changed'));
      if (!disposed) {
        expect(app.stateOf('m')!.agents.single.name, 'Replacement');
      }
    });
  }

  test(
    'a delete event confirms early, and an old receipt cannot stop a reused id',
    () async {
      final stop = app.deleteAgent('m', 'a0');
      await app.handleEventForTest('m', {
        'type': 'agent_deleted',
        'payload': {'agentId': 'a0'},
      });
      expect(await stop, isNull);
      expect(app.pendingAgentStop('m', 'a0'), isNull);
      app.stateOf('m')!.agents.add(const Agent(id: 'a0', name: 'Recreated'));
      final newStop = app.deleteAgent('m', 'a0');
      expect(newStop, isNot(same(stop)));
      connection.stopReplies.first.completeError(
        const WsRequestTimeout('agent_delete'),
      );
      await Future<void>.delayed(Duration.zero);
      expect(app.stateOf('m')!.agents.last.name, 'Recreated');
      expect(app.pendingAgentStop('m', 'a0'), same(newStop));
      connection.stopReplies.last.complete({
        'error': 'REFUSED',
        'detail': 'Still working',
      });
      expect(await newStop, 'Stop failed: Still working');
      expect(app.stateOf('m')!.agents.last.name, 'Recreated');
    },
  );

  test(
    'refusal, timeout and exception keep the agent and allow retry',
    () async {
      for (final failure in [
        {'error': 'REFUSED', 'detail': 'Try after reconnecting'},
        const WsRequestTimeout('agent_delete'),
        StateError('fixture detail'),
      ]) {
        final stop = app.deleteAgent('m', 'a0');
        if (failure is Map<String, dynamic>) {
          connection.stopReplies.last.complete(failure);
        } else {
          connection.stopReplies.last.completeError(failure);
        }
        expect(await stop, isNotNull);
        expect(app.pendingAgentStop('m', 'a0'), isNull);
        expect(app.stateOf('m')!.agents.any((a) => a.id == 'a0'), isTrue);
      }
      final stop = app.deleteAgent('m', 'a0');
      connection.stopReplies.last.complete({'deleted': true});
      expect(await stop, isNull);
    },
  );

  test('missing and shared targets cannot send a stop', () async {
    expect(await app.deleteAgent('unknown', 'a0'), 'Machine not found');
    expect(await app.deleteAgent('m', 'unknown'), contains('no longer listed'));
    app.stateOf('m')!.machine = const Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      isShared: true,
    );
    expect(await app.deleteAgent('m', 'a0'), contains('view-only'));
    expect(connection.stops, isEmpty);
  });

  for (final recreated in [false, true]) {
    test('old inventory cannot undo a stop (recreated: $recreated)', () async {
      connection.inventory = Completer<Map<String, dynamic>>();
      final read = app.reloadMachineData('m');
      await Future<void>.delayed(Duration.zero);
      final stop = app.deleteAgent('m', 'a0');
      connection.stopReplies.single.complete({'deleted': true});
      expect(await stop, isNull);
      if (recreated) {
        app.stateOf('m')!.agents.add(const Agent(id: 'a0', name: 'Recreated'));
      }
      connection.inventory!.complete({
        'agents': [
          {'id': 'a0', 'name': 'Old name', 'engine': 'codex'},
        ],
      });
      await read;
      final current = app
          .stateOf('m')!
          .agents
          .where((a) => a.id == 'a0')
          .firstOrNull;
      expect(current?.name, recreated ? 'Recreated' : isNull);
    });
  }
}
