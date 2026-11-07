// Desktop 1.3.89 audit, smaller polish (task #4445, group D): the Tasks pane and task header, the Buddy header and
// Restart dialog, and the join dialog, for the PR's pictures, light and dark. Writes nothing unless
// HARNESS_SUPER_TAB_CAPTURE names a folder.
import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/buddy_restart.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/join_dialog.dart';
import 'package:harness/super_tabs/join_link.dart';
import 'package:harness/super_tabs/tasks/personal_tasks.dart';
import 'package:harness/super_tabs/tasks/personal_tasks_pane.dart';
import 'package:harness/super_tabs/tasks/task_header.dart';
import 'package:harness/super_tabs/zone_time.dart';

import 'super_tab_personal_tasks_pane_test.dart' show TasksFixture, inCard;
import 'super_tab_personal_tasks_test.dart' show task;
import 'super_tab_tasks_pane_polish_test.dart'
    show taskHeaderController, taskHeaderPr;
import 'support/buddy_engine_fixture.dart';
import 'support/buddy_fixture.dart';
import 'support/capture.dart';

final shots = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];

void main() {
  setUpAll(() async {
    await loadCaptureFonts(shots);
    await superTabLoadZones();
  });

  Future<void> theme(WidgetTester t, Brightness brightness, Size size) async {
    t.view.devicePixelRatio = 1;
    t.view.physicalSize = size;
    addTearDown(t.view.reset);
    final previous = grid.AppTheme.brightness.value;
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = previous);
  }

  Widget app(Brightness brightness, Widget home) => MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: grid.buildAppTheme(brightness: brightness),
    home: Scaffold(body: home),
  );

  for (final brightness in Brightness.values) {
    final b = brightness.name;

    testWidgets('D1 Tasks pane and merged task header ($b)', (t) async {
      if (shots == null) return;
      await theme(t, brightness, const Size(1000, 640));
      final header = taskHeaderController(merged: true);
      addTearDown(header.dispose);
      final f = TasksFixture()
        ..rows = [
          {
            ...task('new', 1, 30),
            'title': 'Add the project export',
            'projectName': 'Desktop',
          },
          {
            ...task('old', 1, 20),
            'title': 'Expand the settings page',
            'projectName': 'Harness',
          },
          {
            ...task('done', 1, 10),
            'title': 'Repair the retry state',
            'projectName': 'Harness',
            'status': 'done',
            'suggested': false,
            'canApprove': false,
          },
        ];
      addTearDown(f.controller.dispose);
      await t.runAsync(() async {
        await header.refresh();
        await f.controller.refresh();
      });
      await t.pumpWidget(
        app(
          brightness,
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: SuperTabTaskHeader(
                  controller: header,
                  task: SuperTabPersonalTask({
                    ...task('aeef', 1, 20),
                    'title': 'Desktop Tasks pane: board-style cards',
                    'status': 'done',
                    'canApprove': false,
                    'requester': {'id': '6a86', 'name': 'Ken'},
                    'pullRequestUrl': taskHeaderPr,
                  }),
                ),
              ),
              SizedBox(
                width: 340,
                child: SuperTabPersonalTasksPane(
                  controller: f.controller,
                  onOpenTask: (_) {},
                ),
              ),
            ],
          ),
        ),
      );
      await t.pumpAndSettle();
      await t.tap(find.byKey(const ValueKey('tasks-approval-mode')));
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
      await captureWindow(t, shots, 'd1-tasks-mode-$b');
      await t.sendKeyEvent(LogicalKeyboardKey.escape);
      await t.pumpAndSettle();
      f.hold = Completer<void>();
      await t.tap(inCard('new', find.text('Approve')));
      await t.pump();
      // The spinner a moment in, once its arc shows.
      await t.pump(const Duration(milliseconds: 400));
      expect(t.takeException(), isNull);
      await captureWindow(t, shots, 'd1-tasks-pending-$b');
      f.hold!.complete();
      await t.pumpAndSettle();
    });

    testWidgets('D2 Buddy header names its model ($b)', (t) async {
      if (shots == null) return;
      final server = buddyEngineSwarm();
      (server.state['agents'] as List).cast<Map>().firstWhere(
        (a) => a['id'] == 'wren',
      )['configuration'] = {
        'engine': 'claude',
        'model': 'claude-opus-5-5',
      };
      final c = await showBuddyEngine(t, server, brightness: brightness);
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
      await captureWindow(t, shots, 'd2-buddy-header-$b');
      await closeBuddyEngine(t, c);
    });

    testWidgets('D2 Restart dialog error ($b)', (t) async {
      if (shots == null) return;
      await theme(t, brightness, const Size(880, 600));
      final server = buddySwarm();
      giveBuddy(server, machineId: 'm');
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await t.runAsync(c.refresh);
      await t.pumpWidget(
        app(
          brightness,
          Builder(
            builder: (context) => TextButton(
              onPressed: () => showRestartBuddy(context, c, 'lead'),
              child: const Text('open'),
            ),
          ),
        ),
      );
      await t.tap(find.text('open'));
      await t.pumpAndSettle();
      await t.tap(find.widgetWithText(FilledButton, 'Restart'));
      await t.pumpAndSettle();
      expect(find.text('Restart is not available here.'), findsOneWidget);
      await captureWindow(t, shots, 'd2-restart-error-$b');
    });

    for (final failed in [false, true]) {
      testWidgets('D3 join dialog${failed ? ' error' : ''} ($b)', (t) async {
        if (shots == null) return;
        await theme(t, brightness, const Size(880, 600));
        await t.pumpWidget(
          app(
            brightness,
            Builder(
              builder: (context) => TextButton(
                onPressed: () => showDialog<void>(
                  context: context,
                  builder: (_) => SwarmJoinDialog(
                    link: const SwarmJoinLink('tab', token: 'invite-token'),
                    accountEmail: 'leo@example.com',
                    isCurrent: () => true,
                    onJoined: (_, _) {},
                    request: (_, _, {body}) async => failed
                        ? throw const SuperTabFailure(
                            'FORBIDDEN',
                            'private',
                            statusCode: 403,
                          )
                        : {
                            'id': 'tab',
                            'name': 'Pilot',
                            'role': 'collaborator',
                          },
                  ),
                ),
                child: const Text('open'),
              ),
            ),
          ),
        );
        await t.tap(find.text('open'));
        await t.pumpAndSettle();
        expect(find.text('Signed in as leo@example.com'), findsOneWidget);
        await captureWindow(t, shots, 'd3-join${failed ? '-error' : ''}-$b');
      });
    }
  }
}
