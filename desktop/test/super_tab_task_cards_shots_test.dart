import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/workspace_chrome.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/tasks/personal_task_card.dart';
import 'package:harness/super_tabs/tasks/personal_tasks_pane.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/super_tabs/zone_time.dart';

import 'super_tab_personal_tasks_pane_test.dart' show TasksFixture;
import 'super_tab_personal_tasks_test.dart' show task;
import 'support/buddy_engine_fixture.dart';
import 'support/capture.dart';
import 'swarm_state_test.dart' show createApp;

/// Pictures of #4204 for its pull request: HARNESS_TASK_CARDS_SHOTS=<dir> writes them; without it they only lay out.
void main() {
  final shots = Platform.environment['HARNESS_TASK_CARDS_SHOTS'];
  setUpAll(() async {
    await loadCaptureFonts(shots);
    await superTabLoadZones();
  });

  List<Map<String, dynamic>> rows() => [
    {
      ...task('aeef', 1, 50),
      'projectId': '5701',
      'title': 'Desktop Tasks pane: board-style cards, click opens the task with its chat in the middle',
      'status': 'working',
      'canApprove': false,
      'requester': {'id': '6a86', 'name': 'Ken'},
      'agent': {'id': '0540', 'name': 'Hugo'},
      'pullRequestUrl':
          'https://github.com/autonomous-ai/openharness/pull/3464',
    },
    {
      ...task('waiting', 1, 40),
      'projectId': 'desktop',
      'projectName': 'Desktop',
      'title': 'Add the project export',
      'requester': {'id': '6a86', 'name': 'Ken'},
    },
    {
      ...task('rejected', 1, 30),
      'projectId': 'cli',
      'projectName': 'CLI',
      'title': 'Expand the settings page',
      'status': 'rejected',
      'canApprove': false,
    },
    {
      ...task('done', 1, 20),
      'projectId': '5701',
      'title': 'Repair the retry state after a lost connection, so a dropped read never leaves the pane empty',
      'status': 'done',
      'canApprove': false,
      'requester': {'id': '6a86', 'name': 'Ken'},
    },
  ];

  Widget themed(Brightness brightness, Widget child) => MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: grid.buildAppTheme(brightness: brightness),
    home: WorkspaceChromeScope(
      chrome: WorkspaceChrome(compactBelow: 720),
      child: Scaffold(body: child),
    ),
  );

  void size(WidgetTester t, Size size, Brightness brightness) {
    t.view.physicalSize = size;
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
  }

  Widget view(SuperTabController c, {bool tasksPane = true}) {
    final app = createApp();
    addTearDown(app.dispose);
    return SuperTabView(
      controller: c,
      app: app,
      board: true,
      rightPane: tasksPane ? null : (_) => const SizedBox.expand(),
      machineName: (_) => 'Kens-MacBook',
      onInvite: () {},
      onAddAgent: (_) {},
      onOpenTerminal: (_) {},
      onNewSwarm: () {},
    );
  }

  for (final brightness in Brightness.values) {
    final b = brightness.name;
    testWidgets('Tasks pane cards, $b', (t) async {
      size(t, const Size(340, 760), brightness);
      final empty = TasksFixture()..rows = [];
      addTearDown(empty.controller.dispose);
      await empty.controller.refresh();
      await t.pumpWidget(
        themed(
          brightness,
          SuperTabPersonalTasksPane(
            controller: empty.controller,
            onOpenTask: (_) {},
          ),
        ),
      );
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
      await captureWindow(t, shots, 'cards-0-$b');
      final f = TasksFixture()
        ..rows = rows()
        ..mode = 'review';
      addTearDown(f.controller.dispose);
      await f.controller.refresh();
      await t.pumpWidget(
        themed(
          brightness,
          SuperTabPersonalTasksPane(
            controller: f.controller,
            onOpenTask: (_) {},
            selectedId: 'aeef',
          ),
        ),
      );
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
      await captureWindow(t, shots, 'cards-$b');
    });

    testWidgets('a task opened in the middle, $b', (t) async {
      size(t, const Size(1440, 800), brightness);
      final f = TasksFixture()..rows = rows();
      addTearDown(f.controller.dispose);
      await f.controller.refresh();
      await t.pumpWidget(themed(brightness, view(f.controller)));
      await t.pump();
      await t.tap(
        find.descendant(
          of: find.byKey(const ValueKey('personal-task-aeef')),
          matching: find.byType(SuperTabPersonalTaskCard),
        ),
      );
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
      expect(find.byKey(const ValueKey('super-task-header')), findsOneWidget);
      await captureWindow(t, shots, 'task-middle-$b');
    });

    testWidgets('the Buddy chat header, $b', (t) async {
      size(t, const Size(1440, 500), brightness);
      final server = buddyEngineSwarm();
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();
      await c.select('swarm-buddy-peer');
      await t.pumpWidget(themed(brightness, view(c, tasksPane: false)));
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
      expect(
        find.byKey(const ValueKey('super-agent-chat-header')),
        findsOneWidget,
      );
      await captureWindow(t, shots, 'buddy-header-$b');
    });
  }
}
