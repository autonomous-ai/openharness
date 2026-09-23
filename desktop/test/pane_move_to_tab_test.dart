// Moving a tile to another tab is a change of membership, not a close and a
// reopen: the same TerminalPane — and so the same live terminal — comes out the
// other side. These pin that, and the bookkeeping the destination inherits.
import 'package:flutter_test/flutter_test.dart';

import 'dart:ui';

import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/state/pane_preset.dart';
import 'package:harness/state/terminal_pane.dart';

import 'swarm_state_test.dart' show createApp;

List<String?> agentsOf(AppNotifier n, String swarmId) => [
  for (final pane in n.swarms.firstWhere((s) => s.id == swarmId).panes)
    pane.agentId,
];

/// Two tabs: the first holding [count] agents, the second empty and returned.
(AppNotifier, String, String) twoTabs({int count = 2}) {
  final app = createApp();
  final source = app.activeSwarmId;
  for (var i = 0; i < count; i++) {
    app.panes.add(TerminalPane(id: i, machineId: 'm', agentId: 'a$i'));
  }
  app.newSwarm();
  final target = app.activeSwarmId;
  app.selectSwarm(source);
  return (app, source, target);
}

void main() {
  test('the tile lands on the other tab and leaves this one', () {
    final (app, source, target) = twoTabs();
    addTearDown(app.dispose);
    app.focusPane(0);

    expect(app.movePaneToSwarm(0, target), isTrue);

    expect(agentsOf(app, source), ['a1']);
    expect(agentsOf(app, target), ['a0']);
  });

  test('the same tile object moves, so its terminal is never reopened', () {
    final (app, _, target) = twoTabs();
    addTearDown(app.dispose);
    final moved = app.panes.firstWhere((pane) => pane.id == 0);

    app.movePaneToSwarm(0, target);

    final landed = app.swarms
        .firstWhere((swarm) => swarm.id == target)
        .panes
        .single;
    expect(identical(landed, moved), isTrue);
  });

  test('the view follows the tile, which is then the focused one', () {
    final (app, source, target) = twoTabs();
    addTearDown(app.dispose);
    app.focusPane(0);

    app.movePaneToSwarm(0, target);

    expect(app.activeSwarmId, target);
    expect(app.focusedPaneId, 0);

    app.selectSwarm(source);
    expect(
      app.focusedPaneId,
      1,
      reason: 'the tab left behind hands focus to a neighbour',
    );
  });

  test('staying put is a choice the caller has', () {
    final (app, source, target) = twoTabs();
    addTearDown(app.dispose);

    app.movePaneToSwarm(0, target, follow: false);

    expect(app.activeSwarmId, source);
    expect(agentsOf(app, target), ['a0']);
  });

  test('an unknown tile, an unknown tab, or this tab, all change nothing', () {
    final (app, source, target) = twoTabs();
    addTearDown(app.dispose);

    expect(app.movePaneToSwarm(99, target), isFalse);
    expect(app.movePaneToSwarm(0, 'no-such-tab'), isFalse);
    expect(app.movePaneToSwarm(0, source), isFalse);

    expect(agentsOf(app, source), ['a0', 'a1']);
    expect(agentsOf(app, target), isEmpty);
  });

  test('a destination already holding the agent takes it as a close', () {
    final (app, source, target) = twoTabs();
    addTearDown(app.dispose);
    app.swarms
        .firstWhere((swarm) => swarm.id == target)
        .panes
        .add(TerminalPane(id: 7, machineId: 'm', agentId: 'a0'));

    expect(app.movePaneToSwarm(0, target), isTrue);

    expect(agentsOf(app, source), ['a1']);
    expect(agentsOf(app, target), [
      'a0',
    ], reason: 'one membership per tab, never the agent twice');
  });

  test('a full destination refuses, and says where to make room', () {
    final (app, source, target) = twoTabs();
    addTearDown(app.dispose);
    final full = app.swarms.firstWhere((swarm) => swarm.id == target);
    for (var i = 0; i < AppNotifier.maxPanes; i++) {
      full.panes.add(TerminalPane(id: 100 + i, machineId: 'm', agentId: 'b$i'));
    }

    expect(app.movePaneToSwarm(0, target), isFalse);

    expect(agentsOf(app, source), ['a0', 'a1']);
    expect(full.panes.length, AppNotifier.maxPanes);
    expect(app.lastError, contains('Close one there'));
  });

  test('the harness viewer travels beside its terminal', () {
    final (app, source, target) = twoTabs();
    addTearDown(app.dispose);
    app.panes.add(
      TerminalPane(
        id: 5,
        machineId: 'm',
        kind: PaneKind.web,
        ownerAgentId: 'a0',
        url: 'http://127.0.0.1:1/',
      ),
    );

    app.movePaneToSwarm(0, target);

    expect(agentsOf(app, source), ['a1']);
    final landed = app.swarms.firstWhere((swarm) => swarm.id == target).panes;
    expect(landed.map((pane) => pane.id), [0, 5]);
  });

  test('the tab left behind re-tiles instead of keeping a lopsided split', () {
    // Panes opened with Split Right/Down save a manual layout, so a tab that
    // never had a divider dragged still has one. Carrying it down a tile — what
    // a close does — leaves the rest at proportions drawn for a tile that is no
    // longer there.
    final (app, source, target) = twoTabs(count: 3);
    addTearDown(app.dispose);
    app.activeSwarm.savePaneSizes(
      '3:manual',
      PaneArrangement(const [
        Rect.fromLTRB(0, 0, .7, 1),
        Rect.fromLTRB(.7, 0, 1, .5),
        Rect.fromLTRB(.7, .5, 1, 1),
      ]),
    );

    app.movePaneToSwarm(1, target, follow: false);

    final left = app.swarms.firstWhere((swarm) => swarm.id == source);
    expect(left.panes.length, 2);
    expect(left.paneSizes['2:manual'], isNull);
    expect(left.arranged, isNull);
  });

  test('a layout chosen outright still stands after a move', () {
    final (app, source, target) = twoTabs(count: 3);
    addTearDown(app.dispose);
    app.setPreset(2, PanePreset.rows);

    app.movePaneToSwarm(1, target, follow: false);

    final left = app.swarms.firstWhere((swarm) => swarm.id == source);
    expect(left.presets[2], PanePreset.rows);
  });

  test('the destination forgets a shape it remembered for this count', () {
    final (app, _, target) = twoTabs();
    addTearDown(app.dispose);
    final destination = app.swarms.firstWhere((swarm) => swarm.id == target);
    destination.panes.add(TerminalPane(id: 8, machineId: 'm', agentId: 'b0'));
    destination.presets[2] = PanePreset.columns;
    destination.arrangedKey = '2:manual';

    app.movePaneToSwarm(0, target);

    expect(destination.presets[2], isNull);
    expect(destination.arrangedKey, isNull);
  });
}
