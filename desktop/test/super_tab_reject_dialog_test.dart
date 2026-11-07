// Task #4251 (finding 10 of #4211): Reject's dialog names the task. The rows' agent picker it also styled went with
// #4204's cards, which have no agent switch.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/tasks/personal_tasks_pane.dart';
import 'package:harness/super_tabs/zone_time.dart';

import 'super_tab_personal_tasks_pane_test.dart' show TasksFixture;

void main() {
  setUpAll(superTabLoadZones);

  Future<TasksFixture> mount(WidgetTester t, String title) async {
    final f = TasksFixture();
    addTearDown(f.controller.dispose);
    f.rows.last['title'] = title;
    await f.controller.refresh();
    await t.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 340,
            child: SuperTabPersonalTasksPane(
              controller: f.controller,
              onOpenTask: (_) {},
            ),
          ),
        ),
      ),
    );
    return f;
  }

  // Each waiting card has its own Reject: the one on this task's card.
  final reject = find.descendant(
    of: find.byKey(const ValueKey('personal-task-new')),
    matching: find.text('Decline'),
  );

  testWidgets('the Reject dialog names the task', (t) async {
    await mount(t, 'Add the project export');
    await t.tap(reject);
    await t.pumpAndSettle();
    expect(
      find.descendant(
        of: find.byType(AlertDialog),
        matching: find.text('Decline “Add the project export”?'),
      ),
      findsOneWidget,
    );
    expect(find.text('Decline task'), findsOneWidget, reason: 'the button');
  });

  testWidgets('a long title wraps in the dialog without overflowing', (
    t,
  ) async {
    final title = 'Add the project export ${'with every column ' * 12}';
    await mount(t, title);
    await t.tap(reject);
    await t.pumpAndSettle();
    final heading = find.descendant(
      of: find.byType(AlertDialog),
      matching: find.textContaining('Decline “Add the project export'),
    );
    expect(heading, findsOneWidget);
    expect(t.takeException(), isNull);
  });
}
