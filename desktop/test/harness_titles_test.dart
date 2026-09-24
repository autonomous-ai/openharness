import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm.dart';

import 'swarm_state_test.dart' show createApp, MemoryStore;

const automaticName = 'Codex harness 9-20 9:15';

Future<void> sessionTitle(
  AppNotifier app,
  String title, {
  String name = automaticName,
}) => app.handleEventForTest('m', {
  'type': 'agent_synced',
  'payload': {
    'agent': {
      'id': 'a0',
      'name': name,
      'title': title,
      'engine': 'codex',
      'terminal': {'available': true},
    },
  },
});

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'pane placeholders are display-only and explicit names beat session titles',
    () {
      const agent = Agent(id: 'a0', name: automaticName, engine: 'codex');
      expect(agent.name, automaticName);
      expect(agent.displayName, 'Untitled Pane');
      expect(
        const Agent(
          id: 'a0',
          name: automaticName,
          title: 'Review API changes',
        ).displayName,
        'Review API changes',
      );
      expect(
        const Agent(
          id: 'a0',
          name: 'My release',
          title: 'Review API changes',
        ).displayName,
        'My release',
      );
    },
  );

  test('a tab is named after its first harness\'s project', () async {
    final app = createApp(store: MemoryStore());
    app.machineStates['m']!.agents = const [
      Agent(
        id: 'a0',
        name: automaticName,
        title: 'Review API changes',
        engine: 'codex',
        terminalAvailable: true,
        project: AgentProject(
          name: 'harness',
          cwd: '/src/harness/desktop',
          root: '/src/harness',
        ),
      ),
      Agent(
        id: 'a1',
        name: 'second',
        engine: 'claude',
        terminalAvailable: true,
        project: AgentProject(name: 'website', cwd: '/src/website'),
      ),
    ];
    await app.addAgentToSwarm('m', 'a0');
    // The folder as the pane header shows it: a subfolder of a checkout is
    // itself, not the repository around it — and the project wins over the
    // session's title.
    expect(app.activeSwarm.name, 'desktop');
    expect(app.activeSwarm.nameIsCustom, isFalse);
    await app.addAgentToSwarm('m', 'a1');
    expect(app.activeSwarm.name, 'desktop', reason: 'the FIRST pane names it');
  });

  test('a tab saved as Untitled Tab restores as New Tab', () {
    expect(Swarm.normalizeName('Untitled Tab'), Swarm.defaultName);
    expect(Swarm.defaultName, 'New Tab');
  });

  test('tab follows its first harness until an explicit rename, including after restore', () async {
    final store = MemoryStore();
    final app = createApp(store: store);
    app.machineStates['m']!.agents = const [
      Agent(
        id: 'a0',
        name: automaticName,
        engine: 'codex',
        terminalAvailable: true,
      ),
    ];
    await app.addAgentToSwarm('m', 'a0');
    expect(app.activeSwarm.name, 'New Tab');
    expect(app.activeSwarm.nameIsCustom, isFalse);
    await sessionTitle(app, 'Review API changes');
    expect(app.activeSwarm.name, 'Review API changes');
    await app.flushPaneLayout();
    app.dispose();

    final restored = createApp(store: store);
    await restored.restorePaneLayoutForTest();
    expect(restored.activeSwarm.nameIsCustom, isFalse);
    await sessionTitle(restored, 'Fix API retries');
    expect(restored.activeSwarm.name, 'Fix API retries');
    restored.renameSwarm(restored.activeSwarmId, 'Release workspace');
    await sessionTitle(restored, 'Add regression tests');
    expect(restored.activeSwarm.name, 'Release workspace');
    expect(
      restored.stateOf('m')!.agents.first.displayName,
      'Add regression tests',
    );
    await restored.closeSwarm(restored.activeSwarmId);
    restored.reopenClosedSwarm();
    expect(restored.activeSwarm.nameIsCustom, isTrue);
    await restored.flushPaneLayout();
    restored.dispose();

    final reopened = createApp(store: store);
    addTearDown(reopened.dispose);
    await reopened.restorePaneLayoutForTest();
    await sessionTitle(reopened, 'An engine title', name: 'My custom pane');
    expect(reopened.activeSwarm.name, 'Release workspace');
    expect(reopened.stateOf('m')!.agents.first.displayName, 'My custom pane');
  });
}
