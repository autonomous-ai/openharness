import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';

import 'support/rename_connection.dart';
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

/// Opening a harness stamps it on its own daemon (`agent_update {opened}`), so
/// every client's "last used" order moves with it.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late RenameConnection connection;
  late AppNotifier app;
  setUp(() {
    connection = RenameConnection();
    app = createApp(connectionForTest: (_) => connection, connected: true);
  });
  tearDown(() => app.dispose());

  Map<String, dynamic> opened(String id) => {'agentId': id, 'opened': true};

  test('one stamp per harness inside the debounce window', () {
    app.touchAgent('m', 'a0');
    app.touchAgent('m', 'a0');
    app.touchAgent('m', 'a0');
    expect(connection.renames, [opened('a0')]);
  });

  test('A, B, A in quick succession is three opens, not two', () {
    app.touchAgent('m', 'a0');
    app.touchAgent('m', 'a1');
    app.touchAgent('m', 'a0');
    expect(connection.renames, [opened('a0'), opened('a1'), opened('a0')]);
  });

  test(
    'the daemon\'s stamp in the reply lands without waiting for a push',
    () async {
      final stamp = DateTime.utc(2026, 9, 26, 12);
      app.touchAgent('m', 'a0');
      connection.replies.single.complete({
        'agent': {'id': 'a0', 'lastOpenedAt': stamp.toIso8601String()},
      });
      await pumpEventQueue();
      final agent = app.stateOf('m')!.agents.firstWhere((a) => a.id == 'a0');
      expect(agent.lastOpenedAt, stamp);
      expect(agent.lastUsedAt, stamp);
      expect(agent.name, 'Agent 0');
    },
  );

  test('an older daemon\'s refusal or a dead socket is swallowed', () async {
    app.touchAgent('m', 'a0');
    app.touchAgent('m', 'a1');
    connection.replies.first.complete({'error': 'MISSING_UPDATE'});
    connection.replies.last.completeError(StateError('socket closed'));
    await pumpEventQueue();
    expect(
      app.stateOf('m')!.agents.every((a) => a.lastOpenedAt == null),
      isTrue,
    );
    expect(app.lastError, isNull);
  });

  test('never for a disconnected machine or a view-only shared harness', () {
    app.stateOf('m')!.connectionStatus = ConnectionStatus.disconnected;
    app.touchAgent('m', 'a0');
    app.machineStates['shared'] =
        MachineState(
            const Machine(
              machineId: 'shared',
              authMode: MachineAuthMode.remote,
              isShared: true,
            ),
          )
          ..nodeOnline = true
          ..connectionStatus = ConnectionStatus.connected
          ..agents = const [Agent(id: 's0', name: 'Shared')];
    app.touchAgent('shared', 's0');
    app.touchAgent('missing', 'a0');
    expect(connection.renames, isEmpty);
  });

  test('a person focusing a harness stamps it; clicks inside it and a '
      'device\'s move do not', () {
    final first = app.adoptSessionForTest(terminal('a0', []));
    final second = app.adoptSessionForTest(terminal('a1', []));
    // A restored layout puts a tile in front without anybody opening it.
    expect(connection.renames, isEmpty);

    app.focusPane(first.id, reveal: true);
    expect(connection.renames, [opened('a0')]);
    // The grid's pointer-down re-focuses the tile already in front.
    app.focusPane(first.id);
    app.focusPane(first.id);
    expect(connection.renames, [opened('a0')]);

    app.focusPane(second.id);
    expect(connection.renames, [opened('a0'), opened('a1')]);

    // Native focus echoing a reparent is the renderer's doing, not a person's.
    app.focusPaneFromRenderer(first.id);
    expect(connection.renames, hasLength(2));
    // …but the next gesture on the harness it left in front is an open again.
    app.focusPane(first.id);
    expect(connection.renames, [opened('a0'), opened('a1'), opened('a0')]);
  });

  test('adding a harness to the grid opens it', () async {
    // No terminal capability yet: the tile is placed, nothing is attached.
    expect(app.stateOf('m')!.terminalCapabilityAvailable, isFalse);
    await app.addAgentToSwarm('m', 'a3');
    expect(app.focusedPane?.agentId, 'a3');
    expect(connection.renames, [opened('a3')]);
  });
}
