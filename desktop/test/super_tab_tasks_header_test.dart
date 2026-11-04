import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_icon_button.dart';
import 'package:harness/super_tabs/buddy_rows.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_tasks_view_test.dart' show tasksServer;
import 'support/super_tab_fixture.dart';

Finder _key(String key) => find.byKey(ValueKey(key));

Future<SuperTabController> _showView(
  WidgetTester tester,
  ConversationServer server,
) async {
  await tester.binding.setSurfaceSize(const Size(1500, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final c = server.controller();
  addTearDown(c.dispose);
  await c.refresh();
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.light),
      home: Scaffold(
        body: SuperTabView(
          controller: c,
          onInvite: () {},
          onAddAgent: (_) {},
          onOpenTerminal: (_) {},
          machineName: (_) => 'Team Mac',
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return c;
}

bool _selected(WidgetTester tester) =>
    tester.widget<AppIconButton>(_key('super-tasks')).selected == true;

/// The project header's Tasks icon (Dee, task #2569): it opens the project's
/// Tasks view, with a red count of the tasks that need the reader.
void main() {
  testWidgets('the project header reads Terminals, Tasks, then Members', (
    tester,
  ) async {
    await _showView(tester, tasksServer());
    double x(String key) => tester.getCenter(_key(key)).dx;
    expect(x('super-terminals'), lessThan(x('super-tasks')));
    expect(x('super-tasks'), lessThan(x('super-members-button')));
  });

  testWidgets('a red count of the tasks that need the reader, none at 0', (
    tester,
  ) async {
    await _showView(tester, tasksServer());
    expect(
      tester.widget<SuperTabCountBadge>(_key('super-tasks-badge')).count,
      1,
    );
    await tester.pumpWidget(const SizedBox());
    await _showView(tester, tasksServer(empty: true));
    expect(_key('super-tasks'), findsOneWidget);
    expect(_key('super-tasks-badge'), findsNothing);
  });

  testWidgets('Tasks opens the Board, and Chat goes back to the chat', (
    tester,
  ) async {
    await _showView(tester, tasksServer());
    expect(_key('super-tasks-column-working'), findsNothing);
    await tester.tap(_key('super-tasks'));
    await tester.pumpAndSettle();
    expect(_key('super-tasks-column-working'), findsOneWidget);
    expect(_selected(tester), isTrue);
    await tester.tap(_key('super-chat'));
    await tester.pumpAndSettle();
    expect(_key('super-tasks-column-working'), findsNothing);
    expect(_selected(tester), isFalse);
  });

  testWidgets('a card opens its task with Tasks selected; Tasks brings the '
      'board back', (tester) async {
    final c = await _showView(tester, tasksServer());
    await tester.tap(_key('super-tasks'));
    await tester.pumpAndSettle();
    await tester.tap(_key('super-task-card-tag'));
    await tester.pumpAndSettle();
    expect(c.selectedId, 'tag');
    expect(_key('super-tasks-column-working'), findsNothing);
    expect(_selected(tester), isTrue);
    await tester.tap(_key('super-tasks'));
    await tester.pumpAndSettle();
    expect(c.selectedId, 'lead');
    expect(_key('super-tasks-column-working'), findsOneWidget);
  });

  testWidgets('back on the board, the task just opened shows selected', (
    tester,
  ) async {
    await _showView(tester, tasksServer());
    await tester.tap(_key('super-tasks'));
    await tester.pumpAndSettle();
    expect(
      tester.getSemantics(_key('super-task-card-tag')),
      isNot(isSemantics(isSelected: true)),
    );
    await tester.tap(_key('super-task-card-tag'));
    await tester.pumpAndSettle();
    await tester.tap(_key('super-tasks'));
    await tester.pumpAndSettle();
    expect(
      tester.getSemantics(_key('super-task-card-tag')),
      isSemantics(isSelected: true),
    );
    expect(
      tester.getSemantics(_key('super-task-card-preview')),
      isNot(isSemantics(isSelected: true)),
    );
  });
}
