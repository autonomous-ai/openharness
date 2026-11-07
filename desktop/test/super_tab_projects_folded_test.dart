import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/buddy_rows.dart' show SuperTabCountBadge;

import 'support/super_tab_fixture.dart';
import 'support/super_tab_left_pane.dart';

/// Audit finding 19 (Desktop 1.3.89, task #4445): the Desktop folds Projects while the person has an agent, so a tag
/// in a project went unseen. Folded, the heading is bold and counts the projects whose rows are waiting.
void main() {
  Finder heading(Finder matching) => find.descendant(
    of: find.byKey(const ValueKey('project-sidebar-projects')),
    matching: matching,
  );
  FontWeight? weight(WidgetTester tester) =>
      tester.widget<Text>(heading(find.text('Projects'))).style?.fontWeight;

  /// A second project, `second-project`, beside the fixture's web-project.
  void twoProjects(ConversationServer server) {
    (server.state['projects'] as List).add(
      projectFixture('second', 'second-project', 'second'),
    );
    (server.state['conversations'] as List).add({
      ...conversationFixture('second', 'second-project'),
      'projectId': 'second',
    });
  }

  testWidgets('folded with nothing waiting, it is the ordinary heading', (
    tester,
  ) async {
    await showLeftPane(tester, setup: twoProjects);
    expect(find.byTooltip('Expand Projects'), findsOneWidget);
    expect(weight(tester), isNot(grid.AppFont.semibold));
    expect(heading(find.byType(SuperTabCountBadge)), findsNothing);
  });

  testWidgets('folded with a tag in one project and new lines in another, it '
      'is bold and counts the two', (tester) async {
    final c = await showLeftPane(
      tester,
      setup: (server) {
        twoProjects(server);
        server.followedThreads = null;
        server.tag('message-1');
        server.append('Can someone look?', conversationId: 'second');
        server.messages.last['author'] = {
          'kind': 'person',
          'id': 'tuan',
          'name': 'tuan@example.com',
        };
      },
    );
    expect(find.byTooltip('Expand Projects'), findsOneWidget);
    expect(weight(tester), grid.AppFont.semibold);
    expect(
      find.descendant(
        of: heading(find.byType(SuperTabCountBadge)),
        matching: find.text('2'),
      ),
      findsOneWidget,
    );
    // Open, the rows say it themselves: the heading goes back to ordinary.
    await tester.tap(find.byTooltip('Expand Projects'));
    await tester.pump();
    expect(find.byKey(const ValueKey('super-mentions-lead')), findsOneWidget);
    expect(weight(tester), isNot(grid.AppFont.semibold));
    expect(heading(find.byType(SuperTabCountBadge)), findsNothing);
    await tester.runAsync(c.flush);
  });
}
