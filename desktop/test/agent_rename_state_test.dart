import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/rename_connection.dart';
import 'swarm_state_test.dart' show createApp;
import 'swarm_screen_test.dart' show terminal;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late RenameConnection connection;
  late AppNotifier app;
  var disposed = false;
  setUp(() {
    connection = RenameConnection();
    app = createApp(connectionForTest: (_) => connection);
    disposed = false;
  });
  tearDown(() {
    if (!disposed) app.dispose();
  });
  String name([String id = 'a0']) =>
      app.stateOf('m')!.agents.firstWhere((a) => a.id == id).name;

  test('identical renames join; separate agents rename independently and all views update', () async {
    final pane = app.adoptSessionForTest(terminal('a0', []));
    app.newSwarm();
    app.activeSwarm.panes.add(pane);
    final second = app.adoptSessionForTest(terminal('a0', []));
    final request = app.renameAgent('m', 'a0', '  Fix parser  ');
    expect(
      identical(request, app.renameAgent('m', 'a0', 'Fix parser')),
      isTrue,
    );
    expect(app.pendingAgentRename('m', 'a0'), same(request));
    expect(app.pendingAgentName('m', 'a0'), 'Fix parser');
    expect(
      await app.renameAgent('m', 'a0', 'Competing'),
      contains('already in progress'),
    );
    final another = app.renameAgent('m', 'a1', 'Docs');
    expect(connection.renames, [
      {'agentId': 'a0', 'name': 'Fix parser'},
      {'agentId': 'a1', 'name': 'Docs'},
    ]);
    connection.replies.first.complete({
      'agent': {'id': 'a0', 'name': 'Fix parser · canonical'},
    });
    connection.replies.last.complete({});
    expect(await request, isNull);
    expect(await another, isNull);
    expect(name(), 'Fix parser · canonical');
    expect(name('a1'), 'Docs');
    expect(pane.session!.agentName, name());
    expect(second.session!.agentName, name());
    expect(app.pendingAgentRename('m', 'a0'), isNull);
    expect(await app.renameAgent('m', 'a0', name()), isNull);
    expect(connection.renames, hasLength(2));
  });

  test(
    'blank, missing, and shared agents cannot send rename requests',
    () async {
      expect(
        await app.renameAgent('missing', 'a0', 'Name'),
        'Machine not found',
      );
      expect(await app.renameAgent('m', 'a0', '  '), 'Name cannot be empty');
      expect(await app.renameAgent('m', 'gone', 'Name'), 'Agent not found');
      final shared = MachineState(
        const Machine(
          machineId: 'shared',
          authMode: MachineAuthMode.remote,
          isShared: true,
        ),
      )..agents = app.stateOf('m')!.agents;
      app.machineStates['shared'] = shared;
      expect(
        await app.renameAgent('shared', 'a0', 'Name'),
        contains('view-only'),
      );
      expect(connection.renames, isEmpty);
    },
  );

  for (final change in ['machine', 'session', 'dispose']) {
    test('a late rename cannot mutate a changed $change', () async {
      final request = app.renameAgent('m', 'a0', 'Late name');
      switch (change) {
        case 'machine':
          app.machineStates['m'] = MachineState(app.stateOf('m')!.machine)
            ..agents = [
              const Agent(id: 'a0', name: 'Replacement', status: 'idle'),
            ];
        case 'session':
          app.stateOf('m')!.agents = [
            const Agent(
              id: 'a0',
              sessionId: 'replacement-session',
              name: 'Replacement',
            ),
          ];
        case 'dispose':
          app.dispose();
          disposed = true;
      }
      connection.replies.single.complete({});
      expect(await request, contains('agent changed'));
      if (!disposed) expect(name(), 'Replacement');
      expect(app.pendingAgentRename('m', 'a0'), isNull);
    });
  }

  test('deleting then reusing an id invalidates its old rename', () async {
    final request = app.renameAgent('m', 'a0', 'Old request');
    await app.handleEventForTest('m', {
      'type': 'agent_deleted',
      'payload': {'agentId': 'a0'},
    });
    app.stateOf('m')!.agents.add(const Agent(id: 'a0', name: 'Recreated'));
    connection.replies.single.complete({});
    expect(await request, contains('agent changed'));
    expect(name(), 'Recreated');
  });

  test(
    'refusals, exceptions, and timeouts release busy state for retry',
    () async {
      var request = app.renameAgent('m', 'a0', 'Retry');
      connection.replies.last.complete({
        'error': 'REFUSED',
        'detail': 'Agent is read only',
      });
      expect(await request, 'Rename failed: Agent is read only');
      expect(name(), 'Agent 0');
      request = app.renameAgent('m', 'a0', 'Retry');
      connection.replies.last.completeError(StateError('fixture detail'));
      expect(await request, 'Could not rename the agent. Try again.');
      request = app.renameAgent('m', 'a0', 'Retry');
      connection.replies.last.completeError(
        const WsRequestTimeout('agent_update'),
      );
      expect(await request, contains('Could not confirm'));
      expect(app.pendingAgentRename('m', 'a0'), isNull);
      request = app.renameAgent('m', 'a0', 'Retry');
      connection.replies.last.complete({});
      expect(await request, isNull);
      expect(name(), 'Retry');
    },
  );

  test('a later rename event wins over an older request receipt', () async {
    final request = app.renameAgent('m', 'a0', 'Requested');
    await app.handleEventForTest('m', {
      'type': 'agent_renamed',
      'payload': {'agentId': 'a0', 'name': 'From another client'},
    });
    connection.replies.single.complete({
      'agent': {'name': 'Requested'},
    });
    expect(await request, contains('From another client'));
    expect(name(), 'From another client');
    final retry = app.renameAgent('m', 'a0', 'Requested');
    await app.handleEventForTest('m', {
      'type': 'agent_renamed',
      'payload': {'agentId': 'a0', 'name': 'Requested'},
    });
    connection.replies.last.complete({});
    expect(await retry, isNull);
  });

  test('old inventory preserves a confirmed rename; a new inventory updates open titles', () async {
    final pane = app.adoptSessionForTest(terminal('a0', []));
    connection.inventory = Completer<Map<String, dynamic>>();
    final oldRead = app.reloadMachineData('m');
    await Future<void>.delayed(Duration.zero);
    final request = app.renameAgent('m', 'a0', 'Saved name');
    connection.replies.single.complete({});
    expect(await request, isNull);
    connection.inventory!.complete({
      'agents': [
        {'id': 'a0', 'name': 'Agent 0', 'engine': 'codex'},
      ],
    });
    await oldRead;
    expect(name(), 'Saved name');
    expect(pane.session!.agentName, 'Saved name');
    connection.inventory = Completer<Map<String, dynamic>>();
    final freshRead = app.reloadMachineData('m');
    connection.inventory!.complete({
      'agents': [
        {'id': 'a0', 'name': 'New inventory', 'engine': 'codex'},
      ],
    });
    await freshRead;
    expect(name(), 'New inventory');
    expect(pane.session!.agentName, 'New inventory');
  });
}
