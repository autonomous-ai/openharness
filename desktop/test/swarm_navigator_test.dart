import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/state/swarm_search.dart';

import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

void main() {
  test('each membership is an exact destination, never an implicit add or fallback', () async {
    final app = createApp();
    addTearDown(app.dispose);
    final pane = app.adoptSessionForTest(terminal('a0', []));
    final first = app.activeSwarm;
    app.renameSwarm(first.id, 'Release');
    app.newSwarm(name: 'Review');
    final second = app.activeSwarm;
    await app.addAgentToSwarm('m', 'a0');
    app.newSwarm(name: 'Research');
    final third = app.activeSwarm;
    await app.addAgentToSwarm('m', 'a0');
    final search = SwarmSearchController(app, [], navigating: true);
    addTearDown(search.dispose);
    search.setQuery('Agent 0');
    expect(search.rows.map((r) => r.swarmId).toSet(), {
      first.id,
      second.id,
      third.id,
    });
    expect(search.rows.map((r) => r.id).toSet(), hasLength(6));
    expect(search.selected?.agentId, 'a0');
    final exact = search.rows.singleWhere(
      (r) => r.swarmId == second.id && r.agentId != null,
    );
    expect(search.canAdd(exact), isFalse);
    expect(
      await activateSwarmDestination(app, exact, destinationSwarmId: third.id),
      isTrue,
    );
    expect(
      app.activeSwarmId,
      second.id,
      reason: 'The active tab also contains this harness',
    );
    expect(app.focusedPane, same(pane));
    expect(first.panes, [pane]);
    expect(second.panes, [pane]);
    expect(third.panes, [pane]);
    await app.closeSwarm(second.id);
    final active = app.activeSwarmId;
    expect(
      await activateSwarmDestination(app, exact, destinationSwarmId: first.id),
      isFalse,
    );
    expect(
      app.activeSwarmId,
      active,
      reason: 'A removed location cannot redirect to another membership',
    );
    search.setQuery('Agent 69');
    expect(
      search.rows,
      isEmpty,
      reason: 'Discovered agents without a view belong to Add',
    );
    expect(search.submit(), isNull);
  });

  test('location search uses only its own tab context and output reuses the catalog', () async {
    final app = createApp();
    addTearDown(app.dispose);
    final session = terminal('a0', []);
    app.adoptSessionForTest(session);
    app.renameSwarm(app.activeSwarmId, 'Release');
    app.newSwarm(name: 'Research');
    await app.addAgentToSwarm('m', 'a0');
    final catalog = SwarmLocationCatalog();
    final first = catalog.read(app, []);
    session.terminal.write('More output\r\n');
    app.dismissError();
    expect(catalog.read(app, []), same(first));
    final rows = rankSwarmLocations(first, 'Agent 0 Research');
    expect(rows, hasLength(2));
    expect(rows.first.isSwarm, isTrue);
    expect(rows.last.swarmName, 'Research');
  });

  test(
    'locations refresh discovered context and retain offline views',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      final session = terminal('a0', []);
      final pane = app.adoptSessionForTest(session);
      final catalog = SwarmLocationCatalog();
      final first = catalog.read(app, []);
      final machine = app.machineStates['m']!;
      machine.agents = const [
        Agent(
          id: 'a0',
          name: 'Changed title',
          engine: 'hermes',
          terminalAvailable: true,
          project: AgentProject(name: 'Updated project', cwd: '/work/updated'),
        ),
      ];
      final updated = catalog.read(app, []);
      expect(updated, isNot(same(first)));
      final changed = rankSwarmLocations(updated, 'Changed updated hermes');
      expect(changed, hasLength(2));
      expect(changed.first.isSwarm, isTrue);
      expect(changed.last.paneId, pane.id);
      expect(changed.last.detail, contains('Updated project'));
      app.machineStates.clear();
      final retained = catalog
          .read(app, [])
          .singleWhere((r) => r.paneId != null);
      expect(retained.title, session.agentName);
      expect(retained.machineLabel, 'm');
      expect(retained.engine, session.engineId);
      expect(
        await activateSwarmDestination(
          app,
          retained,
          destinationSwarmId: app.activeSwarmId,
        ),
        isTrue,
      );
      expect(app.focusedPane, same(pane));
    },
  );
}
