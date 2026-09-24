import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_text.dart';
import 'package:harness/state/swarm_navigation.dart';

import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;
import 'swarm_interactions_test.dart' show chord;

void main() {
  testWidgets('Open and New are separate popups with one dismissal', (
    tester,
  ) async {
    final app = createApp();
    final input = <TerminalBinaryFrame>[];
    final pane = app.adoptSessionForTest(terminal('a0', input));
    await mount(tester, app);
    await chord(tester, LogicalKeyboardKey.keyP);
    final field = find.byKey(const ValueKey('swarm-search-input'));
    final results = find.byKey(const ValueKey('swarm-search-results'));
    expect(field, findsOneWidget);
    expect(find.byType(AlertDialog), findsNothing);
    expect(find.byKey(const ValueKey('swarm-search-new-agent')), findsNothing);
    final panelRect = tester.getRect(results);
    final fieldRect = tester.getRect(field);
    final cell = terminalCellSizeOf(tester.element(field));
    expect(fieldRect.left - panelRect.left, closeTo(cell.width * 4, .01));
    expect(fieldRect.right, lessThanOrEqualTo(panelRect.right));
    expect(fieldRect.width, greaterThan(panelRect.width / 2));
    await chord(tester, LogicalKeyboardKey.keyN);
    expect(find.byType(AlertDialog), findsOneWidget);
    expect(find.byKey(const ValueKey('create-agent-submit')), findsOneWidget);
    expect(results, findsNothing);
    expect(find.text('Back to Search'), findsNothing);
    expect(app.panes, [pane]);
    expect(input, isEmpty);
    await tester.tapAt(const Offset(20, 200));
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.byType(AlertDialog), findsNothing);
    expect(results, findsNothing);
    expect(app.panes, [pane]);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    expect(input.single.bytes, [27, 91, 66]);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });
  for (final activate in ['click', 'enter']) {
    testWidgets('$activate opens one existing agent immediately in this tab', (
      tester,
    ) async {
      final app = createApp();
      final input = <TerminalBinaryFrame>[];
      final existing = terminal('a0', input);
      app.adoptSessionForTest(existing);
      final source = app.activeSwarm;
      app.newSwarm();
      final target = app.activeSwarm;
      await mount(tester, app);
      await chord(tester, LogicalKeyboardKey.keyP);
      final field = find.byKey(const ValueKey('swarm-search-input'));
      await tester.enterText(field, 'Agent 0');
      await tester.pump();
      expect(find.byType(Checkbox), findsNothing);
      expect(app.panes, isEmpty);
      expect(find.byKey(const ValueKey('swarm-search-count')), findsNothing);
      expect(find.byKey(const ValueKey('swarm-search-hints')), findsNothing);
      expect(find.byKey(const ValueKey('swarm-search-accept')), findsNothing);
      if (activate == 'click') {
        await tester.tap(find.byKey(ValueKey(agentDestinationId('m', 'a0'))));
      } else {
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      }
      await tester.pump();
      expect(field, findsNothing);
      expect(app.activeSwarm, same(target));
      expect(target.panes, hasLength(1));
      expect(target.panes.single.session, same(existing));
      expect(source.panes, hasLength(1));
      expect(input, isEmpty);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    });
  }
  testWidgets('start-page search opens a retained harness', (tester) async {
    final app = createApp();
    final input = <TerminalBinaryFrame>[];
    final existing = terminal('a0', input);
    app.adoptSessionForTest(existing);
    app.newSwarm();
    final target = app.activeSwarm;
    await mount(tester, app);
    final field = find.byKey(const ValueKey('harness-start-search'));
    await tester.tap(field);
    await tester.enterText(field, 'Agent 0');
    await tester.pump();
    await tester.tap(find.byKey(ValueKey(agentDestinationId('m', 'a0'))));
    await tester.pump();
    expect(app.activeSwarm, same(target));
    expect(target.panes.single.session, same(existing));
    expect(input, isEmpty);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });
}
