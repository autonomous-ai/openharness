import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_sessions.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/state/swarm_navigation.dart';

import 'swarm_attention_test.dart' show waitingQuestion;
import 'swarm_state_test.dart' show MemoryStore, createApp;

void main() {
  test('discovery and internal questions never add unseen harnesses to the monitor', () async {
    final app = createApp();
    addTearDown(app.dispose);
    app.machineStates['m']!.agents.addAll([
      const Agent(
        id: 'probe',
        name: 'Performance probe 123',
        engine: 'terminal',
      ),
      const Agent(
        id: 'child',
        name: 'Background worker',
        engine: 'codex',
        parentAgentId: 'a0',
      ),
    ]);
    app.machineStates['m']!.blockedAgents['child'] = waitingQuestion('child');
    expect(harnessSessions(app), isEmpty);
    await app.addAgentToSwarm('m', 'a0');
    expect(harnessSessions(app).map((row) => row.agent.id), ['a0']);
    expect(harnessSessions(app).where((row) => row.needsInput), isEmpty);
    // Explicitly opening another engine makes it user-visible too.
    await app.addAgentToSwarm('m', 'probe');
    expect(harnessSessions(app).map((row) => row.agent.id), ['a0', 'probe']);
  });

  test(
    'closed and paused harnesses survive restart without retaining streams',
    () async {
      final storage = MemoryStore();
      final app = createApp(store: storage);
      await app.addAgentToSwarm('m', 'a0');
      await app.closePane(app.panes.single.id);
      await app.flushPaneLayout();
      expect(app.allPanes, isEmpty);
      expect(harnessSessions(app).single.agent.id, 'a0');
      app.dispose();
      final restored = createApp(store: storage);
      addTearDown(restored.dispose);
      restored.machineStates['m']!.agents = [
        const Agent(
          id: 'a0',
          name: 'Saved work',
          engine: 'claude',
          sessionId: 'saved-conversation',
          status: 'stopped',
        ),
        const Agent(
          id: 'probe',
          name: 'Performance probe 123',
          engine: 'terminal',
          status: 'stopped',
        ),
      ];
      await restored.restorePaneLayoutForTest();
      expect(restored.allPanes, isEmpty);
      expect(harnessSessions(restored).single.agent.id, 'a0');
      expect(harnessSessions(restored).single.agent.isStopped, isTrue);
    },
  );

  test(
    'identities include the owning machine and repeated panes deduplicate',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      app.machineStates['remote'] = MachineState(
        const Machine(
          machineId: 'remote',
          name: 'Remote',
          authMode: MachineAuthMode.remote,
        ),
      )..agents = [const Agent(id: 'a0', name: 'Different harness')];
      await app.addAgentToSwarm('m', 'a0');
      app.newSwarm(name: 'Another view');
      await app.addAgentToSwarm('m', 'a0');
      expect(harnessSessions(app), hasLength(1));
      expect(harnessSessions(app).single.machineId, 'm');
    },
  );

  test('migrates only explicit recent visits from older builds', () async {
    final storage = MemoryStore();
    storage.values['swarm_recent_v1'] = jsonEncode([
      agentDestinationId('m', 'a0'),
      'swarm:old',
      9,
      'agent:malformed',
    ]);
    final store = PaneLayoutStore(storage: storage);
    expect(await store.loadMonitorHarnesses(null), [('m', 'a0')]);
    expect(await store.loadMonitorHarnesses({'monitorHarnesses': []}), isEmpty);
    storage.values['swarm_recent_v1'] = '{broken';
    expect(await store.loadMonitorHarnesses(null), isEmpty);
  });
}
