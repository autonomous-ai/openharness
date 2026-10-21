import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/harness_placement.dart';
import 'package:harness/state/swarm_navigation.dart';

import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show createApp;

void main() {
  test(
    'a successful recent open consumes only the empty Swarm draft',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      final draft = app.activeSwarm;
      app.markSuperTabDraft(draft.id);
      final row = swarmDestinations(app)
          .singleWhere((row) => row.agentId == 'a0');
      expect(
        await activateSwarmSearchSelection(
          app,
          SwarmSearchSelection(row),
          destinationSwarmId: draft.id,
          placement: HarnessPlacement.currentTab,
        ),
        isTrue,
      );
      expect(app.activeSwarm, same(draft));
      expect(draft.isSuperTab, isFalse);
      expect(draft.superTabId, isNull);
      expect(draft.panes.single.agentId, 'a0');
      expect(app.swarms, hasLength(1));
    },
  );

  test('a disappeared recent result preserves the Swarm draft', () async {
    final app = createApp();
    addTearDown(app.dispose);
    final draft = app.activeSwarm;
    app.markSuperTabDraft(draft.id);
    final row = swarmDestinations(app)
        .singleWhere((row) => row.agentId == 'a0');
    app.machineStates['m']!.agents = [];
    expect(
      await activateSwarmSearchSelection(
        app,
        SwarmSearchSelection(row),
        destinationSwarmId: draft.id,
        placement: HarnessPlacement.currentTab,
      ),
      isFalse,
    );
    expect(draft.isSuperTab, isTrue);
    expect(draft.panes, isEmpty);
    expect(app.swarms, hasLength(1));
  });

  test('ordinary new-tab allocation never consumes a Swarm draft', () {
    final app = createApp();
    addTearDown(app.dispose);
    final draft = app.activeSwarm;
    app.markSuperTabDraft(draft.id);
    app.newSwarm();
    expect(app.activeSwarm, isNot(same(draft)));
    expect(app.activeSwarm.isSuperTab, isFalse);
    expect(draft.isSuperTab, isTrue);
  });

  for (final placement in [
    null,
    HarnessPlacement.currentTab,
    HarnessPlacement.newTab,
  ]) {
    test(
      'ordinary search from a completed Swarm uses its own canvas ($placement)',
      () async {
        final app = createApp();
        addTearDown(app.dispose);
        final shared = app.activeSwarm;
        app.bindSuperTab(shared.id, 'shared-tab', 'Pilot');
        final row = swarmDestinations(app)
            .singleWhere((row) => row.agentId == 'a0');
        expect(
          await activateSwarmSearchSelection(
            app,
            SwarmSearchSelection(row),
            destinationSwarmId: shared.id,
            placement: placement,
          ),
          isTrue,
        );
        expect(shared.superTabId, 'shared-tab');
        expect(shared.name, 'Pilot');
        expect(shared.panes, isEmpty);
        expect(app.activeSwarm.isSuperTab, isFalse);
        expect(app.panes.single.agentId, 'a0');
      },
    );
  }

  test(
    'opening an existing view focuses it without consuming the draft',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      final original = app.activeSwarm;
      final pane = app.adoptSessionForTest(terminal('a0', []));
      app.newSwarm(newTabPage: true);
      final draft = app.activeSwarm;
      app.markSuperTabDraft(draft.id);
      final row = swarmDestinations(app)
          .singleWhere((row) => row.agentId == 'a0');
      expect(
        await activateSwarmSearchSelection(
          app,
          SwarmSearchSelection(row),
          destinationSwarmId: draft.id,
        ),
        isTrue,
      );
      expect(app.activeSwarm, same(original));
      expect(app.panes.single, same(pane));
      expect(draft.isSuperTab, isTrue);
      expect(draft.panes, isEmpty);
    },
  );

  for (final placement in [
    null,
    HarnessPlacement.currentTab,
    HarnessPlacement.newTab,
  ]) {
    for (final mode in ['group', 'add group', 'multiple', 'add one']) {
      test(
        'search $mode leaves shared membership and its terminal intact ($placement)',
        () async {
          final app = createApp();
          addTearDown(app.dispose);
          app.machineStates['m']!.agents = app.machineStates['m']!.agents
              .take(2)
              .toList();
          final shared = app.activeSwarm;
          final pane = app.adoptSessionForTest(terminal('a0', []));
          app.bindSuperTab(shared.id, 'shared-tab', 'Pilot');
          final catalog = SwarmSearchCatalog().read(app, []);
          final group = catalog.singleWhere((row) => row.isMachine);
          final agents = catalog.where((row) => row.agentId != null).toList();
          final selection = switch (mode) {
            'group' => SwarmSearchSelection(group),
            'add group' => SwarmSearchSelection(
              group,
              SwarmSearchAction.addHere,
            ),
            'multiple' => SwarmSearchSelection.multiple(agents),
            _ => SwarmSearchSelection(
              agents.singleWhere((row) => row.agentId == 'a1'),
              SwarmSearchAction.addHere,
            ),
          };
          expect(
            await activateSwarmSearchSelection(
              app,
              selection,
              destinationSwarmId: shared.id,
              placement: placement,
            ),
            isTrue,
          );
          expect(shared.superTabId, 'shared-tab');
          expect(shared.name, 'Pilot');
          expect(shared.panes, [pane]);
          expect(app.activeSwarm.isSuperTab, isFalse);
          expect(
            app.panes.map((pane) => pane.agentId).toSet(),
            mode == 'add one' ? {'a1'} : {'a0', 'a1'},
          );
        },
      );
    }
  }
}
