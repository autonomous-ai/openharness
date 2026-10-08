import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/state/app_state.dart';

import 'swarm_state_test.dart' show createApp;

void main() {
  test(
    'Player exports known-session context and deduplicated reported models',
    () {
      final app = createApp();
      addTearDown(app.dispose);
      final machine = app.machineStates['m']!;
      machine.agents = [
        const Agent(
          id: 'a0',
          name: 'Harness OS',
          engine: 'codex',
          modelName: 'gpt-5',
          project: AgentProject(
            name: 'cosmic-fox',
            cwd: '/work/cosmic-fox',
            root: '/work/cosmic-fox',
            remote: 'https://github.com/autonomous-ai/openharness.git',
            branch: 'dev/firmware-pro',
          ),
        ),
        const Agent(
          id: 'a1',
          name: 'Another session',
          engine: 'codex',
          modelName: 'gpt-5',
        ),
        const Agent(id: 'unknown', name: 'Unknown model', engine: 'claude'),
      ];
      app.activeSwarm.panes.addAll([
        TerminalPane(id: 1, machineId: 'm', agentId: 'a0'),
        TerminalPane(id: 2, machineId: 'm', agentId: 'a0'),
        TerminalPane(id: 3, machineId: 'm', agentId: 'a1'),
        TerminalPane(id: 4, machineId: 'm', agentId: 'unknown'),
      ]);
      final overview = app.playerOverview;
      expect(overview['harnesses'], 3);
      expect(overview['machines'], 1);
      expect(overview['models'], 1);
      final contexts = overview['contexts'] as List;
      expect(contexts, hasLength(3));
      expect(contexts.singleWhere((c) => c['id'] == 'a0'), {
        'id': 'a0',
        'machine': 'Test host',
        'project': 'openharness',
        'branch': 'dev/firmware-pro',
        'engine': 'codex',
        'remaining': null,
        'validUntil': 0,
      });
      expect(contexts.singleWhere((c) => c['id'] == 'unknown')['project'], '');
      expect(contexts.singleWhere((c) => c['id'] == 'unknown')['branch'], '');
    },
  );

  test('Player includes closed, paused and terminal sessions on every machine beyond 24', () {
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    app.machineStates.clear();
    for (var m = 0; m < 4; m++) {
      final host = Machine(
        machineId: 'm$m',
        name: 'Machine $m',
        authMode: MachineAuthMode.remote,
      );
      final machine = MachineState(host)
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected
        ..agents = [
          for (var i = 0; i < 30; i++)
            Agent(
              id: 'a$m-$i',
              name: 'Session $m-$i',
              engine: i == 29 ? 'terminal' : 'codex',
              status: i == 0 ? 'stopped' : 'running',
              terminalAvailable: i != 0,
              lastActivityAt: DateTime.fromMillisecondsSinceEpoch(
                1000 + m * 30 + i,
              ),
            ),
        ];
      app.machineStates['m$m'] = machine;
      for (final agent in machine.agents) {
        app.rememberOpenedHarness('m$m', agent.id);
      }
      machine.processingAgentIds.add('a$m-1');
      machine.recentTurnEnds.add((agentId: 'a$m-2', failed: false));
    }
    final overview = app.playerOverview;
    final rows = overview['sessions'] as List;
    expect(rows, hasLength(120));
    expect(overview['contexts'] as List, hasLength(120));
    expect(overview['machines'], 4);
    expect(rows.first['id'], 'a3-29');
    expect(rows.singleWhere((r) => r['id'] == 'a0-0')['status'], 'paused');
    expect(rows.singleWhere((r) => r['id'] == 'a2-1')['status'], 'working');
    expect(rows.singleWhere((r) => r['id'] == 'a1-2')['status'], 'finished');
    expect(rows.where((r) => r['engine'] == 'terminal'), hasLength(4));
    expect(app.panes, isEmpty);
  });

  test('Player never presents an unconfirmed branch as the real branch', () {
    final app = createApp();
    addTearDown(app.dispose);
    app.machineStates['m']!.agents = [
      const Agent(
        id: 'a0',
        name: 'Session',
        engine: 'codex',
        project: AgentProject(
          name: 'openharness',
          cwd: '/work',
          branch: 'generated-name',
          branchPending: true,
        ),
      ),
    ];
    app.activeSwarm.panes.add(
      TerminalPane(id: 1, machineId: 'm', agentId: 'a0'),
    );
    expect((app.playerOverview['contexts'] as List).single['branch'], '');
  });
}
