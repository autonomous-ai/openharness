import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/terminal_pane.dart';

import 'swarm_state_test.dart' show createApp;

void main() {
  test(
    'Player exports actual tab context and deduplicated reported models',
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
      expect(contexts.first, {
        'id': 'a0',
        'machine': 'Test host',
        'project': 'openharness',
        'branch': 'dev/firmware-pro',
        'engine': 'codex',
        'remaining': null,
        'validUntil': 0,
      });
      expect(contexts.last['project'], '');
      expect(contexts.last['branch'], '');
    },
  );

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
