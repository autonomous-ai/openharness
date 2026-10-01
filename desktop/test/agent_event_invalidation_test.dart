import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/status_menu.dart';

import 'swarm_state_test.dart' show createApp;

const _snapshot = <String, dynamic>{
  'id': 'a0',
  'name': 'Work',
  'engine': 'codex',
  'sessionId': 'conversation',
  'terminal': {'available': true},
};

Future<void> _sync(AppNotifier app, Map<String, dynamic> raw) =>
    app.handleMachineEventForTest('m', {
      'type': 'agent_synced',
      'payload': {'agent': raw},
    });

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'old conversation activity cannot revive a replaced or stopped harness',
    () async {
      final app = createApp(connected: true);
      addTearDown(app.dispose);
      app.rememberOpenedHarness('m', 'a0');
      await _sync(app, _snapshot);
      Future<void> activity(String type, String session) =>
          app.handleMachineEventForTest('m', {
            'type': type,
            'agentId': 'a0',
            'payload': {'agentId': 'a0', 'sessionId': session},
          });

      await activity('turn_heartbeat', 'conversation');
      expect(statusMenuWorkingEntries(app).single['agentId'], 'a0');
      await _sync(app, {..._snapshot, 'sessionId': 'replacement'});
      expect(statusMenuWorkingEntries(app), isEmpty);
      await activity('turn_heartbeat', 'conversation');
      await activity('turn_started', 'conversation');
      expect(statusMenuWorkingEntries(app), isEmpty);

      await activity('turn_started', 'replacement');
      await activity('turn_ended', 'conversation');
      expect(statusMenuWorkingEntries(app).single['sessionId'], 'replacement');
      await _sync(app, {
        ..._snapshot,
        'sessionId': 'replacement',
        'status': 'stopped',
      });
      expect(app.agentIsProcessing('m', 'a0'), isFalse);
      await activity('turn_heartbeat', 'replacement');
      expect(app.agentIsProcessing('m', 'a0'), isFalse);
      expect(statusMenuWorkingEntries(app), isEmpty);
    },
  );

  testWidgets(
    'a working row expires without fresh activity even if the terminal remains open',
    (tester) async {
      final app = createApp(connected: true);
      addTearDown(app.dispose);
      app.rememberOpenedHarness('m', 'a0');
      await _sync(app, _snapshot);
      await app.handleMachineEventForTest('m', {
        'type': 'turn_heartbeat',
        'payload': {'agentId': 'a0', 'sessionId': 'conversation'},
      });
      expect(statusMenuWorkingEntries(app), hasLength(1));
      await tester.pump(const Duration(seconds: 13));
      expect(statusMenuWorkingEntries(app), isEmpty);
      expect(app.stateOf('m')!.agents.first.terminalAvailable, isTrue);
    },
  );

  test('repeated discovery snapshots keep pane presentation stable', () async {
    final app = createApp();
    addTearDown(app.dispose);
    await _sync(app, _snapshot);
    final roster = app.stateOf('m')!.agents;
    final agent = roster.first;
    var rebuilds = 0;
    app.addListener(() => rebuilds++);

    for (var i = 0; i < 100; i++) {
      await _sync(app, {..._snapshot});
    }
    await app.handleMachineEventForTest('m', {
      'type': 'agent_renamed',
      'agentId': 'a0',
      'payload': {'name': 'Work'},
    });
    expect(app.stateOf('m')!.agents, same(roster));
    expect(app.stateOf('m')!.agents.first, same(agent));
    expect(rebuilds, 0);

    await _sync(app, {..._snapshot, 'title': 'Reviewing changes'});
    expect(rebuilds, 1);
    expect(app.stateOf('m')!.agents.first.title, 'Reviewing changes');
  });

  test(
    'RPC and device inventory frames do not invalidate the workspace',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      var rebuilds = 0;
      app.addListener(() => rebuilds++);
      for (final type in [
        'agent_recent',
        'devices_status',
        'future_extension',
      ]) {
        await app.handleMachineEventForTest('m', {
          'type': type,
          'payload': <String, dynamic>{},
        });
      }
      expect(rebuilds, 0);
    },
  );

  test('an unchanged snapshot still clears discovery errors and resolves a pending turn', () async {
    final app = createApp();
    addTearDown(app.dispose);
    await _sync(app, _snapshot);
    final machine = app.stateOf('m')!;
    machine.agentsLoadError = 'Temporary failure';
    machine.pendingProcessingSessions.add('conversation');
    var rebuilds = 0;
    app.addListener(() => rebuilds++);
    await _sync(app, _snapshot);
    expect(machine.agentsLoadError, isNull);
    expect(machine.pendingProcessingSessions, isEmpty);
    expect(machine.processingAgentIds, contains('a0'));
    expect(rebuilds, greaterThan(0));
  });

  test(
    'a verdict phase can advance without changing its summary or timestamp',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      Map<String, dynamic> snapshot(String state) => {
        ..._snapshot,
        'verdict': {
          'ready': false,
          'phases': [
            {'id': 'review', 'name': 'Review', 'state': state},
          ],
        },
      };
      await _sync(app, snapshot('pending'));
      var rebuilds = 0;
      app.addListener(() => rebuilds++);
      await _sync(app, snapshot('active'));
      expect(rebuilds, 1);
      expect(
        app.stateOf('m')!.agents.first.verdict!.currentPhase!.state,
        AgentPhaseState.active,
      );
      await _sync(app, snapshot('active'));
      expect(rebuilds, 1);
    },
  );

  // Every field below affects a visible label, action, model, or work phase.
  // Suppressing duplicate pushes must never suppress a change to one of them.
  final changes = <String, Map<String, dynamic>>{
    'title': {'title': 'New title'},
    'grid model': {
      'grid': {'model': 'Qwen3.5-4B'},
    },
    'grid search': {
      'grid': {'webSearch': 'on'},
    },
    'grid endpoint': {
      'grid': {'baseUrl': 'http://localhost:8080'},
    },
    'grid state': {
      'grid': {'state': 'asleep'},
    },
    'grid note': {
      'grid': {
        'note': {'reason': 'offline', 'model': 'Qwen3.5-4B', 'machine': 'M2'},
      },
    },
    'fork source': {
      'forkedFrom': {'agentId': 'source', 'name': 'Source'},
    },
    'fork capability': {'forkable': false},
    'resume mode': {'resumeMode': 'conversation'},
    'permission': {'permissionMode': 'readOnly'},
    'bypass': {'bypassPermission': false},
    'named agent': {'namedAgent': 'reviewer'},
    'terminal': {
      'terminal': {'available': false},
    },
    'verdict phase': {
      'verdict': {
        'ready': false,
        'phases': [
          {'id': 'review', 'name': 'Review', 'state': 'active'},
        ],
      },
    },
  };
  for (final change in changes.entries) {
    test(
      '${change.key} updates once, while identical parsed values stay quiet',
      () async {
        final app = createApp();
        addTearDown(app.dispose);
        await _sync(app, _snapshot);
        var rebuilds = 0;
        app.addListener(() => rebuilds++);
        final changed = {..._snapshot, ...change.value};
        await _sync(app, changed);
        final agent = app.stateOf('m')!.agents.first;
        expect(rebuilds, 1);
        expect(
          AppNotifier.agentsEqual([agent], [Agent.fromJson(changed)]),
          isTrue,
        );
        await _sync(app, changed);
        expect(app.stateOf('m')!.agents.first, same(agent));
        expect(rebuilds, 1);
        await _sync(app, _snapshot);
        expect(rebuilds, 2, reason: 'removing a value must also reach the UI');
      },
    );
  }
}
