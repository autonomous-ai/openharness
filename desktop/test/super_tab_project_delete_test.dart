import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

void main() {
  final confirm = find.widgetWithText(FilledButton, 'Delete Project');
  final composer = find.byKey(const ValueKey('super-message-composer'));

  Future<(ConversationServer, SuperTabController)> mount(
    WidgetTester tester, {
    ConversationServer? server,
    String account = 'owner',
  }) async {
    server ??= ConversationServer();
    final c = server.controller(account: account);
    await c.refresh();
    addTearDown(c.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            onNewProject: () {},
            machineName: (_) => 'Team Mac',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return (server, c);
  }

  Future<void> openDelete(WidgetTester tester) async {
    await tester.tap(find.byTooltip('Project options'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(MenuItemButton, 'Delete Project'));
    await tester.pumpAndSettle();
  }

  Future<void> finish(WidgetTester tester) async {
    await tester.pump(const Duration(milliseconds: 250));
    await tester.pumpWidget(const SizedBox());
  }

  testWidgets('Delete Project names the project and defaults to Cancel', (
    tester,
  ) async {
    final (server, c) = await mount(tester);
    expect(c.snapshot!.agents, isEmpty);
    await openDelete(tester);
    expect(server.posts, isEmpty);
    expect(
      find.text(
        '“Pilot” and all of its conversations will be permanently deleted. Its Product Manager’s session will close too. This can’t be undone.',
      ),
      findsOneWidget,
    );
    expect(tester.widget<FilledButton>(confirm).onPressed, isNotNull);
    expect(
      tester
          .widget<TextButton>(find.widgetWithText(TextButton, 'Cancel'))
          .autofocus,
      isTrue,
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsNothing);
    expect(server.posts, isEmpty);
    expect(c.snapshot!.projects, hasLength(1));
    await finish(tester);
  });

  testWidgets(
    'deleting one project selects the remaining lead and clears its conversations',
    (tester) async {
      final server = ConversationServer();
      server.state['projects'] = [
        projectFixture('lead', 'Pilot', 'lead'),
        projectFixture('design', 'Design', 'design-lead'),
      ];
      (server.state['conversations'] as List).add({
        ...conversationFixture('design-lead', 'Lead'),
        'projectId': 'design',
      });
      server.append('Old project conversation.');
      final (_, c) = await mount(tester, server: server);
      c.setDraft('offline', 'Unsent project draft');
      await openDelete(tester);
      await tester.tap(confirm);
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsNothing);
      expect(server.posts.single['command'], {
        'type': 'project.delete',
        'projectId': 'lead',
      });
      expect(c.snapshot!.projects.single.id, 'design');
      expect(c.selectedId, 'design-lead');
      expect(c.snapshot!.conversations.single.id, 'design-lead');
      expect(c.draft('offline'), isEmpty);
      expect(find.text('Old project conversation.'), findsNothing);
      expect(composer, findsOneWidget);
      await finish(tester);
    },
  );

  testWidgets(
    'deleting the final project shows an empty Swarm without a composer',
    (tester) async {
      final (_, c) = await mount(tester);
      await openDelete(tester);
      await tester.tap(confirm);
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsNothing);
      expect(c.snapshot!.projects, isEmpty);
      expect(c.snapshot!.conversations, isEmpty);
      expect(find.text('Create a project to get started.'), findsOneWidget);
      expect(find.text('Loading conversation…'), findsNothing);
      expect(composer, findsNothing);
      expect(find.byTooltip('Project options'), findsNothing);
      expect(find.byTooltip('New project'), findsOneWidget);
      expect(find.byTooltip('Chat'), findsNothing);
      await finish(tester);
    },
  );

  for (final (code, message) in [
    (
      'STARTS_PENDING',
      'Resolve this project’s pending agent starts before deleting it.',
    ),
    ('WORK_ACTIVE', 'Resolve this project’s active work before deleting it.'),
  ]) {
    testWidgets('$code refusal preserves the project and shows its reason', (
      tester,
    ) async {
      final (server, c) = await mount(tester);
      server.refuse = {'code': code, 'message': message};
      await openDelete(tester);
      await tester.tap(confirm);
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(AlertDialog),
          matching: find.text(message),
        ),
        findsOneWidget,
      );
      expect(c.snapshot!.projects, hasLength(1));
      expect(c.hasPendingAction, isFalse);
      expect(tester.widget<FilledButton>(confirm).onPressed, isNotNull);
      await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
      await tester.pumpAndSettle();
      expect(server.posts, hasLength(1));
      await finish(tester);
    });
  }

  testWidgets(
    'lost deletion reply retries the same receipt after polling removes the project',
    (tester) async {
      final (server, c) = await mount(tester);
      server.loseReply = true;
      await openDelete(tester);
      await tester.tap(confirm);
      await tester.pumpAndSettle();
      expect(c.hasPendingAction, isTrue);
      expect(find.widgetWithText(FilledButton, 'Retry'), findsOneWidget);
      await c.refresh();
      await tester.pumpAndSettle();
      expect(c.snapshot!.projects, isEmpty);
      expect(find.widgetWithText(FilledButton, 'Retry'), findsOneWidget);
      await tester.tap(find.widgetWithText(FilledButton, 'Retry'));
      await tester.pumpAndSettle();
      expect(server.posts, hasLength(2));
      expect(server.posts[1]['operationId'], server.posts[0]['operationId']);
      expect(c.hasPendingAction, isFalse);
      expect(find.byType(AlertDialog), findsNothing);
      expect(find.text('Create a project to get started.'), findsOneWidget);
      await finish(tester);
    },
  );

  testWidgets(
    'closing an uncertain deletion leaves a recoverable action in the empty Swarm',
    (tester) async {
      final (server, c) = await mount(tester);
      server.loseReply = true;
      await openDelete(tester);
      await tester.tap(confirm);
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(TextButton, 'Close'));
      await tester.pumpAndSettle();
      await c.refresh();
      await tester.pumpAndSettle();
      expect(c.hasPendingAction, isTrue);
      expect(c.snapshot!.projects, isEmpty);
      await tester.tap(find.widgetWithText(TextButton, 'Check pending action'));
      await tester.pumpAndSettle();
      expect(c.hasPendingAction, isFalse);
      expect(server.posts, hasLength(2));
      expect(server.posts[1]['operationId'], server.posts[0]['operationId']);
      expect(find.text('Create a project to get started.'), findsOneWidget);
      await finish(tester);
    },
  );

  testWidgets('a collaborator cannot open Delete Project', (tester) async {
    final server = ConversationServer();
    (server.state['people'] as List).add({
      'id': 'peer',
      'email': 'peer@example.com',
      'role': 'collaborator',
    });
    await mount(tester, server: server, account: 'peer');
    await tester.tap(find.byTooltip('Project options'));
    await tester.pumpAndSettle();
    expect(find.text('Delete Project'), findsNothing);
    expect(server.posts, isEmpty);
    await finish(tester);
  });

  testWidgets('access revocation removes the captured confirmation', (
    tester,
  ) async {
    final (server, c) = await mount(tester);
    await openDelete(tester);
    c.revokeAccess('Account changed');
    await tester.pumpAndSettle();
    expect(confirm, findsNothing);
    expect(find.textContaining('permanently deleted'), findsNothing);
    expect(find.text('This action is no longer available.'), findsOneWidget);
    expect(server.posts, isEmpty);
    await finish(tester);
  });
}
