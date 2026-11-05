import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/project_sidebar.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

/// The sidebar's top navigation rows, top to bottom: everything above Projects.
List<String> topRows(WidgetTester tester) {
  final projects = tester.getTopLeft(find.text('Projects')).dy;
  final rows =
      tester
          .widgetList<InkWell>(
            find.descendant(
              of: find.byType(ProjectSidebar),
              matching: find.byWidgetPredicate(
                (w) =>
                    w is InkWell &&
                    w.key is ValueKey<String> &&
                    (w.key! as ValueKey<String>).value.startsWith('super-'),
              ),
            ),
          )
          .map((w) => find.byWidget(w))
          .where((row) => tester.getTopLeft(row).dy < projects)
          .toList()
        ..sort(
          (a, b) => tester.getTopLeft(a).dy.compareTo(tester.getTopLeft(b).dy),
        );
  return [
    for (final row in rows)
      tester
          .widgetList<Text>(
            find.descendant(of: row, matching: find.byType(Text)),
          )
          .map((t) => t.data)
          .join(),
  ];
}

Future<SuperTabController> showSwarm(WidgetTester tester) async {
  await tester.binding.setSurfaceSize(const Size(1200, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final app = createApp(connected: true);
  addTearDown(app.dispose);
  final server = ConversationServer();
  // Two tags wait and one decision is asked: the Activity row counts only the
  // decision.
  server.state['mentionsWaiting'] = 2;
  server.ask(['Ship it?']);
  server.state['decisionsWaiting'] = 1;
  final c = server.controller();
  await c.refresh();
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: Scaffold(
        body: SuperTabView(
          controller: c,
          app: app,
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
  return c;
}

Future<void> closeSwarm(WidgetTester tester, SuperTabController c) async {
  await tester.pumpWidget(const SizedBox());
  await c.flush();
  c.dispose();
}

void main() {
  // Slack's Activity takes Notifications' place on every platform (Lead,
  // 10-31), and takes in Threads: on a Mac too, beside the menu bar and the
  // Dock. The rest moved
  // into Manage, at the foot (Quiet Swarm, screen 1).
  for (final platform in [TargetPlatform.macOS, TargetPlatform.linux]) {
    testWidgets('the top reads Decisions, Mentions and Threads without '
        'counts, and Manage is at the foot', (tester) async {
      final c = await showSwarm(tester);
      expect(topRows(tester), ['Decisions', 'Mentions', 'Threads']);
      expect(
        tester.getTopLeft(find.byKey(const ValueKey('super-manage'))).dy,
        greaterThan(tester.getTopLeft(find.text('Projects')).dy),
      );
      expect(find.text('Notifications'), findsNothing);
      // The foot lines up with the list, and ends on the chat box's bottom line.
      final manage = tester.getRect(find.byKey(const ValueKey('super-manage')));
      final activity = tester.getRect(
        find.byKey(const ValueKey('super-decisions')),
      );
      final sidebar = tester.getRect(find.byType(ProjectSidebar));
      expect(manage.left, activity.left);
      expect(manage.width, activity.width);
      expect(sidebar.bottom - manage.bottom, ProjectSidebar.footGap);
      expect(tester.takeException(), isNull);
      await closeSwarm(tester, c);
    }, variant: TargetPlatformVariant.only(platform));
  }
}
