import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/tasks/personal_tasks.dart';
import 'package:harness/super_tabs/tasks/task_header.dart';
import 'package:harness/terminal/terminal_typography.dart';
import 'package:harness/super_tabs/tasks/personal_tasks_pane.dart';

import 'super_tab_personal_tasks_pane_test.dart' show TasksFixture;
import 'super_tab_personal_tasks_test.dart' show task;
import 'support/capture.dart';

void main() {
  final shots = Platform.environment['HARNESS_V3_TASKS_SHOTS'];
  setUpAll(() async {
    await loadCaptureFonts(shots);
    if (shots != null && Platform.isMacOS) {
      for (final (family, path) in [
        ('Menlo', '/System/Library/Fonts/Menlo.ttc'),
        // Activity marks draw in the terminal's face; without it "?" is a block.
        (terminalFontFamily, '/System/Library/Fonts/Menlo.ttc'),
        ('Apple Symbols', '/System/Library/Fonts/Apple Symbols.ttf'),
      ]) {
        final bytes = ByteData.sublistView(await File(path).readAsBytes());
        await (FontLoader(family)..addFont(Future.value(bytes))).load();
      }
    }
  });
  for (final brightness in Brightness.values) {
    testWidgets('Tasks pane and decisions fit in ${brightness.name}', (
      t,
    ) async {
      final f = TasksFixture();
      addTearDown(f.controller.dispose);
      f.rows
        ..clear()
        ..addAll([
          {
            ...task('first', 1, 40),
            'title': 'Keep reconnects quiet',
            'projectName': 'Harness',
            'status': 'working',
            'suggested': false,
          },
          {
            ...task('second', 1, 30),
            'title': 'Add the project export',
            'projectName': 'Desktop',
          },
          {
            ...task('third', 1, 20),
            'title': 'Expand the settings page',
            'projectName': 'Desktop',
            'status': 'rejected',
            'suggested': false,
            'reason': 'Keep the first release small',
          },
          {
            ...task('fourth', 1, 10),
            'title': 'Repair the retry state',
            'projectName': 'Harness',
            'status': 'done',
            'suggested': false,
          },
        ]);
      await f.controller.refresh();
      t.view.physicalSize = const Size(440, 760);
      t.view.devicePixelRatio = 1;
      addTearDown(t.view.reset);
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
      await t.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          home: Scaffold(
            body: SuperTabPersonalTasksPane(
              controller: f.controller,
              onOpenTask: (_) {},
            ),
          ),
        ),
      );
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
      await captureWindow(t, shots, 'tasks-auto-${brightness.name}');
      f.mode = 'review';
      await f.controller.refresh();
      await t.pump();
      await t.tap(find.text('Add the project export'));
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
      await captureWindow(t, shots, 'tasks-review-${brightness.name}');
      await t.tap(find.text('Reject'));
      await t.pumpAndSettle();
      await t.enterText(
        find.byKey(const ValueKey('task-reject-reason')),
        'Keep the first release small',
      );
      await t.pump();
      expect(t.takeException(), isNull);
      await captureWindow(t, shots, 'tasks-reject-${brightness.name}');
      await t.tap(find.text('Cancel'));
      await t.pumpAndSettle();
    });
  }

  // Audit #4436 findings 3, 4 and 17: a refusal said in the pane with every card still working, each status in its
  // own word, and a rejected task's reason in its header.
  for (final brightness in Brightness.values) {
    testWidgets('a refusal, every status and a reason in ${brightness.name}', (
      t,
    ) async {
      final f = TasksFixture();
      addTearDown(f.controller.dispose);
      Map<String, dynamic> row(
        String id,
        int at,
        String title,
        String status,
      ) => {
        ...task(id, 1, at),
        'title': title,
        'projectName': 'Harness',
        'status': status,
        'canApprove': status == 'proposal',
        'suggested': status == 'proposal',
      };
      f.rows
        ..clear()
        ..addAll([
          row('a', 90, 'Add the project export', 'proposal'),
          row('b', 80, 'Keep reconnects quiet', 'review'),
          row('c', 70, 'Name the machine row menu', 'planned'),
          row('d', 60, 'Drop the old sync path', 'cancelled'),
          row('e', 50, 'Repair the retry state', 'done'),
          row('f', 40, 'Bound the history read', 'blocked'),
          {
            ...row('g', 30, 'Expand the settings page', 'rejected'),
            'reason': 'Keep the first release small',
          },
        ]);
      await f.controller.refresh();
      t.view.physicalSize = const Size(440, 1000);
      t.view.devicePixelRatio = 1;
      addTearDown(t.view.reset);
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
      Widget app(Widget body) => MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: brightness),
        home: Scaffold(body: body),
      );
      await t.pumpWidget(
        app(
          SuperTabPersonalTasksPane(
            controller: f.controller,
            onOpenTask: (_) {},
          ),
        ),
      );
      await t.pumpAndSettle();
      f.refusal = const SuperTabFailure(
        'CONFLICT',
        'The suggested agent changed. Read the task again.',
        statusCode: 409,
      );
      await t.tap(find.text('Approve'));
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
      await captureWindow(t, shots, 'tasks-refused-${brightness.name}');
      t.view.physicalSize = const Size(720, 200);
      for (final (id, name) in [('g', 'rejected'), ('b', 'review')]) {
        await t.pumpWidget(
          app(
            SuperTabTaskHeader(
              controller: f.controller,
              task: SuperTabPersonalTask(
                f.rows.firstWhere((r) => r['id'] == id),
              ),
            ),
          ),
        );
        await t.pumpAndSettle();
        expect(t.takeException(), isNull);
        await captureWindow(t, shots, 'task-header-$name-${brightness.name}');
      }
    });
  }
}
