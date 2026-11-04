import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/project_sidebar.dart';

import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

/// The design's sidebar (docs/plans/2026-11-02-quiet-swarm-design.md, screen
/// 1): the Swarm, Activity, Buddy, Projects with its +, and Manage at the foot.
void main() {
  Future<SuperTabController> show(
    WidgetTester tester, {
    VoidCallback? onNewProject,
    VoidCallback? onManage,
    bool manageSelected = false,
  }) async {
    final server = ConversationServer();
    server.state['swarmBuddy'] = true;
    server.state['projects'] = [projectFixture('lead', 'openharness', 'lead')];
    final c = server.controller();
    await c.refresh();
    final AppNotifier app = createApp();
    addTearDown(app.dispose);
    await tester.binding.setSurfaceSize(const Size(280, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: ProjectSidebar(
            controller: c,
            app: app,
            needsHuman: (_) => 0,
            onSelect: c.select,
            onNewSwarm: () {},
            onNewProject: onNewProject ?? () {},
            onNotifications: () {},
            onManage: onManage ?? () {},
            manageSelected: manageSelected,
          ),
        ),
      ),
    );
    await tester.pump();
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    });
    return c;
  }

  double top(WidgetTester tester, String key) =>
      tester.getTopLeft(find.byKey(ValueKey(key))).dy;

  testWidgets('its rows, in the design\'s order', (tester) async {
    await show(tester);
    final order = [
      'super-swarm-switcher',
      'super-activity',
      'super-swarm-buddy',
      'project-sidebar-projects',
      'super-project-lead',
      'super-manage',
    ];
    for (var i = 1; i < order.length; i++) {
      expect(
        top(tester, order[i - 1]),
        lessThan(top(tester, order[i])),
        reason: '${order[i - 1]} over ${order[i]}',
      );
    }
    expect(find.text('Buddy'), findsOneWidget);
  });

  testWidgets('none of what moved', (tester) async {
    await show(tester);
    for (final label in const [
      'New project',
      'Your devices',
      'Your models',
      'Threads',
      'Machines',
      'Models',
    ]) {
      expect(find.text(label), findsNothing, reason: label);
    }
  });

  testWidgets('Manage stands at the foot, however short the list', (
    tester,
  ) async {
    await show(tester);
    expect(
      tester.getBottomLeft(find.byKey(const ValueKey('super-manage'))).dy,
      greaterThan(800 - 60),
    );
  });

  testWidgets('Manage opens, and shows when open', (tester) async {
    var opened = 0;
    await show(tester, onManage: () => opened++);
    await tester.tap(find.byKey(const ValueKey('super-manage')));
    expect(opened, 1);
  });

  testWidgets('while Manage shows, no project row is the open one', (
    tester,
  ) async {
    await show(tester, manageSelected: true);
    final row = tester.widget<Semantics>(
      find
          .ancestor(
            of: find.byKey(const ValueKey('super-manage')),
            matching: find.byType(Semantics),
          )
          .first,
    );
    expect(row.properties.selected, isTrue);
  });

  testWidgets(
    'a project row has no chevron; every click selects its chat and lists '
    'no tasks',
    (tester) async {
      final c = await show(tester);
      expect(
        find.byKey(const ValueKey('super-project-toggle-lead')),
        findsNothing,
      );
      await c.select('offline');
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('super-group-lead')));
      await tester.pump();
      expect(c.selectedId, 'lead');
      await tester.tap(find.byKey(const ValueKey('super-group-lead')));
      await tester.pump();
      expect(c.selectedId, 'lead');
      expect(find.byKey(const ValueKey('super-group-offline')), findsNothing);
    await tester.pump(const Duration(seconds: 1));
    },
  );

  testWidgets('+ beside Projects is New project, the same action', (
    tester,
  ) async {
    var opened = 0;
    await show(tester, onNewProject: () => opened++);
    await tester.tap(
      find.descendant(
        of: find.byKey(const ValueKey('project-sidebar-projects')),
        matching: find.byTooltip('New project'),
      ),
    );
    expect(opened, 1);
  });
}
