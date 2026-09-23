// Choosing where a pane goes.
//
// The list is the other tabs and a new one. Arrows walk it, digits and clicks
// take a row outright, and Escape leaves the tile where it was — the same
// grammar the layout palette uses, on names instead of shapes.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness/state/app_state.dart';
import 'package:harness/state/terminal_pane.dart';
import 'package:harness/widgets/move_pane_palette.dart';

import 'swarm_state_test.dart' show createApp;

List<String?> _agentsOf(AppNotifier app, String swarmId) => [
  for (final pane in app.swarms.firstWhere((s) => s.id == swarmId).panes)
    pane.agentId,
];

/// One tab with two harnesses in front, [others] named tabs behind it.
Future<(AppNotifier, String)> _open(
  WidgetTester tester, {
  List<String> others = const ['Second'],
}) async {
  final app = createApp();
  addTearDown(app.dispose);
  final source = app.activeSwarmId;
  for (var i = 0; i < 2; i++) {
    app.panes.add(TerminalPane(id: i, machineId: 'm', agentId: 'a$i'));
  }
  for (final name in others) {
    app.newSwarm(name: name);
  }
  app.selectSwarm(source);
  app.focusPane(0);
  await tester.pumpWidget(
    MaterialApp(
      home: Builder(
        builder: (context) => TextButton(
          onPressed: () => showMovePanePalette(context, app),
          child: const Text('open'),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
  return (app, source);
}

void main() {
  testWidgets('it lists the other tabs, and a new one last', (tester) async {
    await _open(tester, others: const ['Second', 'Third']);

    expect(find.text('Second'), findsOneWidget);
    expect(find.text('Third'), findsOneWidget);
    expect(find.text('New Tab'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('move-pane-destination-2')),
      findsOneWidget,
      reason: 'two tabs and the new one',
    );
  });

  testWidgets('a click sends the tile there and follows it', (tester) async {
    final (app, source) = await _open(tester);

    await tester.tap(find.text('Second'));
    await tester.pumpAndSettle();

    final target = app.swarms.firstWhere((s) => s.name == 'Second').id;
    expect(_agentsOf(app, source), ['a1']);
    expect(_agentsOf(app, target), ['a0']);
    expect(app.activeSwarmId, target);
    expect(find.byKey(const ValueKey('move-pane-palette')), findsNothing);
  });

  testWidgets('a digit takes the row it numbers', (tester) async {
    final (app, source) = await _open(tester, others: const ['Second', 'Third']);

    await tester.sendKeyEvent(LogicalKeyboardKey.digit2);
    await tester.pumpAndSettle();

    final third = app.swarms.firstWhere((s) => s.name == 'Third').id;
    expect(_agentsOf(app, third), ['a0']);
    expect(_agentsOf(app, source), ['a1']);
  });

  testWidgets('the arrows walk the list and Enter takes it', (tester) async {
    final (app, _) = await _open(tester, others: const ['Second', 'Third']);

    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();

    final third = app.swarms.firstWhere((s) => s.name == 'Third').id;
    expect(_agentsOf(app, third), ['a0']);
  });

  testWidgets('the last row opens a tab of its own', (tester) async {
    final (app, source) = await _open(tester);
    final before = app.swarms.length;

    await tester.tap(find.text('New Tab'));
    await tester.pumpAndSettle();

    expect(app.swarms.length, before + 1);
    expect(_agentsOf(app, source), ['a1']);
    expect(_agentsOf(app, app.activeSwarmId), ['a0']);
  });

  testWidgets('Escape leaves every tile where it was', (tester) async {
    final (app, source) = await _open(tester);

    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();

    expect(_agentsOf(app, source), ['a0', 'a1']);
    expect(app.activeSwarmId, source);
    expect(find.byKey(const ValueKey('move-pane-palette')), findsNothing);
  });

  testWidgets('with no pane focused there is nothing to move', (tester) async {
    final app = createApp();
    addTearDown(app.dispose);
    app.newSwarm(name: 'Second');
    app.selectSwarm(app.swarms.first.id);
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () => showMovePanePalette(context, app),
            child: const Text('open'),
          ),
        ),
      ),
    );

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('move-pane-palette')), findsNothing);
  });
}
