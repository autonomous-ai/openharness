import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'super_tab_board_fit_test.dart' show closeWindow, crewServer, showWindow;
import 'super_tab_tasks_view_test.dart' show taskFixture;

/// The Board's smaller polish of the Desktop 1.3.89 audit (task #4445): the off-screen pills, List and the Board tab,
/// and a card whose chat can't be read.

Finder _key(String k) => find.byKey(ValueKey(k));

/// Whether the project's Board tab draws as the view on: the tab shown has no action.
bool _boardTabOn(WidgetTester tester) =>
    tester.widget<TextButton>(_key('super-board-tab-board')).onPressed == null;

void main() {
  testWidgets('a pill names only the columns wholly out of view on its side', (
    tester,
  ) async {
    final c = await showWindow(tester, crewServer());
    // Proposal wholly out on the left, Next up and Shipped each partly in view.
    tester
        .widget<SingleChildScrollView>(_key('super-tasks-board'))
        .controller!
        .jumpTo(300);
    await tester.pump();
    expect(
      find.descendant(
        of: _key('super-tasks-board-more-left'),
        matching: find.text('Proposal 2'),
      ),
      findsOneWidget,
    );
    expect(_key('super-tasks-board-more-right'), findsNothing);
    await closeWindow(tester, c);
  });

  testWidgets('with List on the Board tab is a way back, not the view on, and '
      'no Tasks title repeats it', (tester) async {
    final c = await showWindow(tester, crewServer());
    final view = _key('super-tasks-lead');
    expect(_boardTabOn(tester), isTrue);
    expect(
      find.descendant(of: view, matching: find.text('Tasks')),
      findsNothing,
    );
    await tester.tap(_key('super-tasks-layout-list'));
    await tester.pumpAndSettle();
    expect(_key('super-tasks-board'), findsNothing, reason: 'the List is on');
    expect(_boardTabOn(tester), isFalse);
    expect(
      find.descendant(of: view, matching: find.text('Tasks')),
      findsNothing,
    );
    await tester.tap(_key('super-board-tab-board'));
    await tester.pumpAndSettle();
    expect(_key('super-tasks-board'), findsOneWidget);
    expect(_boardTabOn(tester), isTrue);
    await closeWindow(tester, c);
  });

  testWidgets("clicking a card whose chat can't be read says so", (
    tester,
  ) async {
    final server = crewServer();
    // Shipped and closed: only the Board's read of closed tasks holds it.
    (server.state['conversations'] as List).add(
      taskFixture(
        'old',
        'Old shipped work',
        35,
        status: 'done',
        agent: 'kestrel',
        pullRequest: 3701,
        merged: true,
        archived: true,
        shippedAt: DateTime.now().subtract(const Duration(hours: 2)),
      ),
    );
    final c = await showWindow(tester, server);
    final card = _key('super-task-card-old');
    await tester.ensureVisible(card);
    await tester.pumpAndSettle();
    final selected = c.selectedId;
    // Gone from the server since, so its chat can't be read.
    (server.state['conversations'] as List).removeWhere(
      (g) => (g as Map)['id'] == 'old',
    );
    await tester.tap(card);
    await tester.pumpAndSettle();
    expect(find.text("You can't open this task's chat."), findsOneWidget);
    expect(c.selectedId, selected);
    await closeWindow(tester, c);
  });
}
