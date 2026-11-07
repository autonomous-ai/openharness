// Task #4251 (findings 8 and 10 of #4211): the Board layout in a 900-wide window and the Reject dialog, for the
// PR's pictures, light and dark. Writes nothing unless HARNESS_SUPER_TAB_CAPTURE names a folder.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/tasks/personal_tasks_pane.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/super_tabs/zone_time.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'super_tab_personal_tasks_pane_test.dart' show TasksFixture;
import 'super_tab_personal_tasks_test.dart' show task;
import 'support/capture.dart';
import 'support/memory_key_value_store.dart';
import 'support/super_tab_fixture.dart';

final shots = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];

void main() {
  setUpAll(() async {
    await superTabLoadZones();
    await loadCaptureFonts(shots);
  });

  for (final brightness in Brightness.values) {
    testWidgets('the Board layout at 900 wide in ${brightness.name}', (
      tester,
    ) async {
      if (shots == null) return;
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      await tester.binding.setSurfaceSize(const Size(900, 700));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final server = swarm();
      (server.state['conversations'] as List).add({
        ...conversationFixture('buddy-owner-lead', 'Buddy'),
        'kind': 'buddy',
        'projectId': 'lead',
        'buddyOwnerId': 'owner',
        'agentIds': <String>[],
      });
      server.append(
        'What shall we work on?',
        conversationId: 'buddy-owner-lead',
      );
      final c = server.controller(
        account: 'owner',
        initial: {
          'tabId': 'tab',
          'accountId': 'owner',
          'selectedId': 'buddy-owner-lead',
        },
      );
      await tester.runAsync(c.refresh);
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          home: Scaffold(
            body: SuperTabView(
              controller: c,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Mac Studio',
              paneStore: MemoryKeyValueStore(),
              board: true,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      // A project's Board opens from the Projects grid (task #4466).
      await tester.tap(find.byKey(const ValueKey('super-projects')));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('super-group-lead')));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await captureWindow(tester, shots, 'board-900-${brightness.name}');
      await tester.pumpWidget(const SizedBox());
      c.dispose();
      await tester.pump(const Duration(seconds: 5));
    });

    testWidgets('the Reject dialog in ${brightness.name}', (t) async {
      if (shots == null) return;
      final f = TasksFixture();
      addTearDown(f.controller.dispose);
      f.mode = 'review';
      f.rows
        ..clear()
        ..add({
          ...task('second', 1, 30),
          'title': 'Add the project export',
          'projectName': 'Desktop',
        });
      await f.controller.refresh();
      t.view.physicalSize = const Size(440, 560);
      t.view.devicePixelRatio = 1;
      addTearDown(t.view.reset);
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
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
      await t.tap(find.text('Add the project export'));
      await t.pumpAndSettle();
      await captureWindow(t, shots, 'tasks-open-row-${brightness.name}');
      await t.tap(find.text('Reject'));
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
      await captureWindow(t, shots, 'reject-dialog-${brightness.name}');
      await t.tap(find.text('Cancel'));
      await t.pumpAndSettle();
    });
  }
}
