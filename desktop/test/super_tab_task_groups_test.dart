import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/activity.dart';
import 'package:harness/super_tabs/attention.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/project_sidebar.dart';

import 'support/super_tab_fixture.dart';

/// Two projects: web-project (chat `lead`) with one task in each group and two
/// working, and alpha (chat `alpha-chat`) with one working task. Every chat is
/// read unless a test says otherwise.
ConversationServer groupedServer() {
  final server = ConversationServer();
  server.state['projects'] = [
    projectFixture('lead', 'web-project', 'lead'),
    projectFixture('alpha', 'alpha', 'alpha-chat'),
  ];
  Map<String, dynamic> task(
    String id,
    String projectId,
    int number, {
    String? status,
    Map<String, dynamic>? liveness,
  }) => {
    ...conversationFixture(id, id),
    'projectId': projectId,
    'number': number,
    if (status != null)
      'assignment': {'agentId': 'a1', 'status': status, 'progressAt': 1},
    'liveness': ?liveness,
  };
  (server.state['conversations'] as List)
    ..removeWhere((g) => (g as Map)['id'] == 'offline')
    ..addAll(<Map<String, dynamic>>[
      task(
        'mine',
        'lead',
        15,
        status: 'needs_human',
        liveness: {
          'state': 'waiting',
          'why': 'person',
          'personId': 'owner',
          'since': 1,
        },
      ),
      task('busy-old', 'lead', 13, status: 'working'),
      task('busy-new', 'lead', 16, status: 'working'),
      task(
        'review',
        'lead',
        14,
        status: 'review',
        liveness: {'state': 'waiting', 'why': 'review', 'since': 1},
      ),
      task('quiet-chat', 'lead', 12),
      {...conversationFixture('alpha-chat', 'alpha'), 'projectId': 'alpha'},
      task('alpha-busy', 'alpha', 3, status: 'working'),
    ]);
  return server;
}

Future<SuperTabController> pumpGrouped(
  WidgetTester tester,
  ConversationServer server, {
  Size size = const Size(1300, 1600),
}) async {
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final c = server.controller();
  await c.refresh();
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.light),
      home: Scaffold(
        body: ListenableBuilder(
          listenable: c,
          builder: (context, _) => ProjectSidebar(
            controller: c,
            onSelect: c.select,
            attention: SuperTabAttention.of(c),
            activity: SuperTabActivity.of(c),
            onNotifications: () {},
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return c;
}

Future<void> closeGrouped(WidgetTester tester, SuperTabController c) async {
  await tester.pumpWidget(const SizedBox());
  await c.flush();
  c.dispose();
}

Finder row(String id) => find.byKey(ValueKey('super-group-$id'));

/// A project's tasks live in its Tasks view (Dee, task #2569): the sidebar
/// lists no task under a project, its row's badge counts the tasks that need
/// the reader, and next unread goes from chat to chat.
void main() {
  testWidgets('a project lists no tasks under it, open or closed', (
    tester,
  ) async {
    final server = groupedServer();
    (server.state['conversations'] as List).add({
      ...conversationFixture('old', 'old'),
      'projectId': 'lead',
      'number': 2,
      'archived': true,
    });
    final c = await pumpGrouped(tester, server);
    await c.select('lead');
    await tester.pumpAndSettle();
    await tester.tap(row('lead'));
    await tester.pumpAndSettle();
    for (final id in [
      'mine',
      'busy-old',
      'busy-new',
      'review',
      'quiet-chat',
      'alpha-busy',
      'old',
    ]) {
      expect(row(id), findsNothing, reason: id);
    }
    expect(
      find.byWidgetPredicate(
        (w) =>
            w.key is ValueKey<String> &&
            ((w.key as ValueKey<String>).value.startsWith(
                  'super-task-group-',
                ) ||
                (w.key as ValueKey<String>).value.startsWith('super-closed-')),
      ),
      findsNothing,
    );
    expect(row('lead'), findsOneWidget);
    expect(row('alpha-chat'), findsOneWidget);
    await closeGrouped(tester, c);
  });

  // Task #2927: the tasks that need the reader are on their cards and in
  // Activity; the project's number is its own chat's tags.
  testWidgets('a project\'s badge leaves out the tasks that need the reader', (
    tester,
  ) async {
    final c = await pumpGrouped(tester, groupedServer());
    // `mine` waits on the reader by name; nothing in alpha does.
    expect(find.byKey(const ValueKey('super-mentions-lead')), findsNothing);
    expect(
      find.byKey(const ValueKey('super-mentions-alpha-chat')),
      findsNothing,
    );
    await closeGrouped(tester, c);
  });

  test(
    'next unread goes from project chat to project chat, past tasks',
    () async {
      final server = groupedServer();
      final c = server.controller();
      await c.refresh();
      expect(superTabSidebarOrder(c), ['alpha-chat', 'lead']);
      await c.flush();
      c.dispose();
    },
  );
}
