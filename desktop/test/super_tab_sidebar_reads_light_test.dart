// Task #2427 (Huy, 11-03): the Swarm sidebar reads light like Slack. A project row is bold only for what is for a
// person in it or its tasks: a person's new message, a mention of the reader. Agents' progress messages leave it in
// regular weight and grey, as every read row is. The sidebar lists no tasks (task #2569): a project's row says them.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/humans_fixture.dart';
import 'support/super_tab_fixture.dart';

void main() {
  final project = find.byKey(const ValueKey('super-group-lead'));

  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server, {
    Size size = const Size(1300, 900),
  }) async {
    await tester.binding.setSurfaceSize(size);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final controller = server.controller(
      account: 'peer',
      initial: {'tabId': 'tab', 'accountId': 'peer', 'selectedId': 'lead'},
    );
    await controller.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: SuperTabView(
            controller: controller,
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Studio',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return controller;
  }

  Future<void> close(WidgetTester tester, SuperTabController controller) async {
    await tester.pumpWidget(const SizedBox());
    await controller.flush();
    controller.dispose();
  }

  /// The title's style in [row]: the RichText that holds [title].
  TextStyle titleStyle(WidgetTester tester, Finder row, String title) {
    final text = tester.widget<RichText>(
      find
          .descendant(
            of: row,
            matching: find.byWidgetPredicate(
              (w) => w is RichText && w.text.toPlainText().contains(title),
            ),
          )
          .first,
    );
    TextStyle? found;
    text.text.visitChildren((span) {
      if (span is TextSpan && (span.text ?? '').contains(title))
        found = span.style;
      return found == null;
    });
    return (found ?? text.text.style!).merge(null);
  }

  Future<void> news(WidgetTester tester, SuperTabController controller) async {
    await controller.select('offline');
    await controller.refresh();
    await tester.pumpAndSettle();
  }

  testWidgets(
    'a task with only agents\' new messages leaves its project regular',
    (tester) async {
      final server = humansSwarm();
      addNumberedWorkgroups(server, 1);
      final controller = await show(tester, server);
      server.append('Working on it.', conversationId: 'g1', agent: true);
      server.append(
        'Pushed the first commit.',
        conversationId: 'g1',
        agent: true,
      );
      await news(tester, controller);
      expect(find.byKey(const ValueKey('super-group-g1')), findsNothing);
      expect(
        titleStyle(tester, project, 'Pilot').fontWeight,
        isNot(grid.AppFont.semibold),
      );
      await close(tester, controller);
    },
  );

  // Huy, 11-04 (task #2638): # lamp stayed bold after he read its chat, for
  // one unread task under it. A project's row is its chat's: a task's unread
  // is on its card and in Activity (the Tasks view, #2569).
  testWidgets('the project chat read while a task under it is unread: the '
      'project row is not bold', (tester) async {
    final server = humansSwarm();
    addNumberedWorkgroups(server, 1);
    final controller = await show(tester, server);
    server.append('Can you check the lamp?', conversationId: 'lead');
    server.append('Can you check this?', conversationId: 'g1');
    await controller.select('lead');
    await controller.refresh();
    await tester.pumpAndSettle();
    await news(tester, controller);
    expect(
      titleStyle(tester, project, 'Pilot').fontWeight,
      isNot(grid.AppFont.semibold),
    );
    await close(tester, controller);
  });

  testWidgets('a person\'s new message in the project chat makes its row '
      'bold', (tester) async {
    final server = humansSwarm();
    addNumberedWorkgroups(server, 1);
    final controller = await show(tester, server);
    server.append('Can you check the lamp?', conversationId: 'lead');
    await news(tester, controller);
    expect(
      titleStyle(tester, project, 'Pilot').fontWeight,
      grid.AppFont.semibold,
    );
    await close(tester, controller);
  });

  // Review of #2790 (Sedge, Plover): a wait made a row bold, for every
  // viewer, and opening the task did not clear it, while a screen reader
  // heard "Unread messages". A wait is no unread message: Activity says it,
  // and the row is bold only for what there is to read.
  testWidgets(
    'a waiting task does not make its project bold, whoever it waits on',
    (tester) async {
      final semantics = tester.ensureSemantics();
      final server = humansSwarm();
      addNumberedWorkgroups(server, 2);
      final groups = (server.state['conversations'] as List)
          .cast<Map<String, dynamic>>();
      for (final (id, on) in [('g1', 'owner'), ('g2', 'peer')]) {
        groups.firstWhere((g) => g['id'] == id)
          ..['agentIds'] = ['lead-agent']
          ..['assignment'] = {
            'id': 'a-$id',
            'agentId': 'lead-agent',
            'status': 'needs_human',
            'askedOf': on,
            'result': 'Which machine?',
          };
      }
      final controller = await show(tester, server);
      await controller.select('offline');
      await tester.pumpAndSettle();
      expect(
        titleStyle(tester, project, 'Pilot').fontWeight,
        isNot(grid.AppFont.semibold),
      );
      expect(
        tester.getSemantics(project).getSemanticsData().label,
        isNot(contains('Unread messages')),
      );
      semantics.dispose();
      await close(tester, controller);
    },
  );
}
