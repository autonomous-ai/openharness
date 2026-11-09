import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/project_sidebar.dart';

import '../super_tab_activity_lists_test.dart' show load, swarm;
import '../swarm_state_test.dart' show createApp;
import 'super_tab_fixture.dart';

/// An agent of [contributor]'s in the fixture's one project.
Map<String, dynamic> leftPaneAgent(
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

/// The Desktop's left pane alone ([ProjectSidebar] with `board`), on the
/// fixture's Swarm after [setup], [width] wide.
Future<SuperTabController> showLeftPane(
  WidgetTester tester, {
  void Function(ConversationServer server)? setup,
  double width = 300,
  Brightness brightness = Brightness.light,
}) async {
  final server = swarm();
  setup?.call(server);
  final activity = (await tester.runAsync(() => load(server)))!;
  final c = activity.controller;
  final AppNotifier app = createApp();
  addTearDown(app.dispose);
  final previous = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = previous);
  await tester.binding.setSurfaceSize(Size(width, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: brightness),
      home: Scaffold(
        body: ListenableBuilder(
          listenable: c,
          builder: (context, _) => ProjectSidebar(
            controller: c,
            app: app,
            onSelect: c.select,
            onNewAgent: () {},
            onNewSwarm: () {},
            onNewProject: () {},
            onPage: (_) {},
            attention: activity.attention,
            onManage: () {},
          ),
        ),
      ),
    ),
  );
  await tester.pump();
  addTearDown(() => tester.pumpWidget(const SizedBox()));
  return c;
}
