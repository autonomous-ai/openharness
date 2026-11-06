import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/project_sidebar.dart';

import 'super_tab_activity_lists_test.dart' show load, swarm;
import 'swarm_state_test.dart' show createApp;

/// Swarm v3's left pane (task #4118, anh Dee 2026-11-07): org switching, Decisions, My agents, then collapsible Projects,
/// closed unless the person has no agents. Mentions goes.
Map<String, dynamic> _agent(
  String id,
  String name, {
  String contributor = 'owner',
}) => {
  'id': id,
  'projectId': 'lead',
  'name': name,
  'displayName': name,
  'machineId': 'host',
  'harnessId': 'session',
  'contributorId': contributor,
  'configuration': {'engine': 'codex'},
};

void main() {
  Finder key(String k) => find.byKey(ValueKey(k));

  Future<SuperTabController> show(
    WidgetTester tester, {
    List<Map<String, dynamic>>? agents,
    bool board = true,
  }) async {
    final server = swarm();
    if (agents != null) server.state['agents'] = agents;
    final activity = (await tester.runAsync(() => load(server)))!;
    final c = activity.controller;
    final AppNotifier app = createApp();
    addTearDown(app.dispose);
    await tester.binding.setSurfaceSize(const Size(300, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          // The view rebuilds the sidebar as the controller changes.
          body: ListenableBuilder(
            listenable: c,
            builder: (context, _) => ProjectSidebar(
              controller: c,
              app: app,
              onSelect: c.select,
              onNewSwarm: () {},
              onNewProject: () {},
              onPage: (_) {},
              activity: activity,
              attention: activity.attention,
              onManage: () {},
              board: board,
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    addTearDown(() => tester.pumpWidget(const SizedBox()));
    return c;
  }

  group('Mentions goes', () {
    testWidgets('the Desktop\'s left pane has Decisions and no Mentions', (
      tester,
    ) async {
      await show(tester);
      expect(key('super-decisions'), findsOneWidget);
      expect(key('super-mentions'), findsNothing);
    });

    testWidgets('a layout that is not the Desktop\'s keeps its rows', (
      tester,
    ) async {
      await show(tester, board: false);
      expect(key('super-mentions'), findsOneWidget);
    });
  });

  group('Projects folds', () {
    testWidgets('closed while the person has an agent', (tester) async {
      await show(tester);
      expect(key('project-sidebar-projects'), findsOneWidget);
      expect(key('super-project-lead'), findsNothing);
      expect(find.byTooltip('Expand Projects'), findsOneWidget);
    });

    testWidgets('open when the person has no agents, or only another\'s', (
      tester,
    ) async {
      await show(tester, agents: []);
      expect(key('super-project-lead'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await show(
        tester,
        agents: [_agent('tuan-agent', 'Tuan agent', contributor: 'tuan')],
      );
      expect(key('super-project-lead'), findsOneWidget);
    });

    testWidgets('its heading opens and closes it', (tester) async {
      final c = await show(tester);
      await tester.tap(find.byTooltip('Expand Projects'));
      await tester.pump();
      expect(key('super-project-lead'), findsOneWidget);
      await tester.tap(find.byTooltip('Collapse Projects'));
      await tester.pump();
      expect(key('super-project-lead'), findsNothing);
      // The choice is saved with the view.
      expect(c.projectsGroupOpen, isFalse);
      await tester.runAsync(c.flush);
    });

    testWidgets('a layout that is not the Desktop\'s keeps Projects open', (
      tester,
    ) async {
      await show(tester, board: false);
      expect(key('super-project-lead'), findsOneWidget);
      expect(find.byTooltip('Collapse Projects'), findsNothing);
    });
  });
}
