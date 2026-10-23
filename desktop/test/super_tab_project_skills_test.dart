import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

void main() {
  Future<ConversationServer> mount(
    WidgetTester tester, {
    String account = 'owner',
    String? skillMode,
  }) async {
    final server = ConversationServer();
    final project = projectFixture('lead', 'Pilot', 'lead');
    if (skillMode != null) project['skillMode'] = skillMode;
    server.state['projects'] = [project];
    if (account != 'owner') {
      (server.state['people'] as List).add({
        'id': account,
        'email': '$account@example.com',
        'role': 'collaborator',
      });
    }
    final controller = server.controller(account: account);
    await controller.refresh();
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SuperTabView(
            controller: controller,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Test Mac',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return server;
  }

  Future<void> openSkills(WidgetTester tester) async {
    await tester.tap(find.byTooltip('Project options'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(MenuItemButton, 'Skills'));
    await tester.pumpAndSettle();
  }

  testWidgets('owner changes a legacy project from orchestration to Default', (
    tester,
  ) async {
    final server = await mount(tester);
    await openSkills(tester);
    expect(find.text('Skills for this project'), findsOneWidget);
    expect(
      find.text(
        'Default — the team process; agents otherwise work their usual way',
      ),
      findsOneWidget,
    );
    expect(
      find.text(
        'Harness orchestration — adds Harness practices: plans, test-first, review rounds',
      ),
      findsOneWidget,
    );
    expect(
      tester
          .widget<RadioGroup<String>>(find.byType(RadioGroup<String>))
          .groupValue,
      'orchestration',
    );
    await tester.tap(
      find.text(
        'Default — the team process; agents otherwise work their usual way',
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();
    expect(server.posts.single['command'], {
      'type': 'project.skills',
      'projectId': 'lead',
      'mode': 'default',
    });
  });

  testWidgets(
    'owner sees Default selected for a project already in that mode',
    (tester) async {
      final server = await mount(tester, skillMode: 'default');
      await openSkills(tester);
      expect(
        tester
            .widget<RadioGroup<String>>(find.byType(RadioGroup<String>))
            .groupValue,
        'default',
      );
      await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
      await tester.pumpAndSettle();
      expect(server.posts, isEmpty);
    },
  );

  testWidgets('collaborator does not see Skills in the project menu', (
    tester,
  ) async {
    final server = await mount(tester, account: 'peer');
    await tester.tap(find.byTooltip('Project options'));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(MenuItemButton, 'Skills'), findsNothing);
    expect(server.posts, isEmpty);
  });
}
