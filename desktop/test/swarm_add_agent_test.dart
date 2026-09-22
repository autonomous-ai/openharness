import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:xterm/xterm.dart';

import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

void main() {
  testWidgets('New Pane shortcut reuses the chosen session in this workspace', (
    tester,
  ) async {
    final app = createApp();
    final input = <TerminalBinaryFrame>[];
    final shared = app.adoptSessionForTest(terminal('a0', input));
    final source = app.activeSwarm;
    app.newSwarm(name: 'Review');
    final existing = app.adoptSessionForTest(terminal('a1', input));
    final target = app.activeSwarm;
    await mount(tester, app);
    tester.view.physicalSize = const Size(880, 560);
    await tester.pump();
    expect(find.byKey(const ValueKey('swarm-new-pane-button')), findsNothing);
    expect(find.byType(FloatingActionButton), findsNothing);
    await chord(tester, LogicalKeyboardKey.keyO);
    await tester.enterText(
      find.byKey(const ValueKey('swarm-search-input')),
      'Agent 0',
    );
    await tester.pump();
    expect(
      find.textContaining('enter  open', findRichText: true),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('swarm-row-action')), findsOneWidget);

    expect(find.byType(AlertDialog), findsNothing);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(app.activeSwarm, same(target));
    expect(target.panes, [existing, shared]);
    expect(source.panes, [shared]);
    expect(input, isEmpty);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  for (final axis in PaneResizeAxis.values) {
    testWidgets(
      'split ${axis.name} chooses an existing agent and preserves its neighbors',
      (tester) async {
        final app = createApp();
        final input = <TerminalBinaryFrame>[];
        final first = app.adoptSessionForTest(terminal('a0', input));
        final neighbor = app.adoptSessionForTest(terminal('a1', input));
        final target = app.activeSwarm;
        app.newSwarm(name: 'Elsewhere');
        final shared = app.adoptSessionForTest(terminal('a2', input));
        final source = app.activeSwarm;
        app.selectSwarm(target.id);
        app.focusPane(first.id);
        await mount(tester, app);
        tester.view.physicalSize = const Size(3000, 1800);
        await tester.pump();
        final neighborRect = tester.getRect(find.byKey(neighbor.cellKey));
        final expected = app.preparePaneSplit(axis)!;
        await chord(tester, LogicalKeyboardKey.keyP);
        final inputField = find.byKey(const ValueKey('swarm-search-input'));
        await tester.enterText(
          inputField,
          axis == PaneResizeAxis.x ? '> split right' : '> split down',
        );
        await tester.pump();
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();
        expect(find.byType(AlertDialog), findsNothing);
        expect(app.panes, [first, neighbor]);
        await tester.enterText(inputField, 'Agent 2');
        await tester.pump();
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();
        expect(app.panes, [first, shared, neighbor]);
        expect(source.panes, [shared]);
        expect(app.activeSwarm.manualLayout!.tiles, expected.after.tiles);
        expect(tester.getRect(find.byKey(neighbor.cellKey)), neighborRect);
        expect(input, isEmpty);
        expect(find.byType(TerminalView), findsNWidgets(3));
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      },
    );
  }

  test(
    'adding a group uses this swarm, skips duplicates and keeps the source',
    () async {
      final app = createApp();
      addTearDown(app.dispose);
      app.adoptSessionForTest(terminal('a0', []));
      app.adoptSessionForTest(terminal('a1', []));
      final source = app.activeSwarm;
      app.renameSwarm(source.id, 'Release');
      app.newSwarm(name: 'Review');
      final target = app.activeSwarm;
      await app.addAgentToSwarm('m', 'a0');
      final search = SwarmSearchController(app, [], adding: true);
      addTearDown(search.dispose);
      final row = search.rows.singleWhere(
        (row) => row.id == swarmDestinationId(source.id),
      );
      final choice = search.submit(row)!;
      expect(choice.action, SwarmSearchAction.addHere);
      expect(
        await activateSwarmSearchSelection(
          app,
          choice,
          destinationSwarmId: target.id,
        ),
        isTrue,
      );
      expect(app.activeSwarm, same(target));
      expect(target.panes, source.panes);
      expect(target.name, 'Review');
      expect(search.canAdd(row), isFalse);
    },
  );
}
