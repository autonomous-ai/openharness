import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/tasks/personal_tasks_pane.dart';

import 'super_tab_personal_tasks_pane_test.dart' show TasksFixture;
import 'super_tab_personal_tasks_test.dart' show task;
import 'support/capture.dart';

void main() {
  final shots = Platform.environment['HARNESS_V3_TASKS_SHOTS'];
  setUpAll(() => loadCaptureFonts(shots));
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
}
