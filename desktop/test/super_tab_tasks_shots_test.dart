import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import 'super_tab_tasks_view_test.dart' show tasksServer, taskFixture;
import 'support/capture.dart';

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_TASKS_SHOTS'];

/// A project's Tasks view as the PR shows it (Dee, task #2569): Board and
/// List, in both appearances, with a Needs-you card and the header's count.
/// The Board's columns are panels of inset tiles (Huy, task #2948): Proposals
/// is empty and says so, and the task just opened from the board shows
/// selected on coming back.
void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    for (final layout in ['board', 'list']) {
      testWidgets('screenshots for review ($layout, ${brightness.name})', (
        tester,
      ) async {
        await tester.binding.setSurfaceSize(const Size(1440, 820));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final before = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = before);
        final server = tasksServer();
        server.proposals['lead'] = [];
        (server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
          taskFixture(
            'dial',
            'Dial thread alerts',
            15,
            requester: 'scholes',
            status: 'working',
          ),
          taskFixture(
            'grouping',
            'Task chat grouping',
            16,
            requester: 'scholes',
            status: 'review',
            liveness: {'state': 'waiting', 'why': 'review', 'since': 1},
          ),
          taskFixture(
            'long',
            'A long title that takes all three of its lines on the board, '
                'and then goes on with more words than three lines of a '
                'column can hold, so the rest is cut',
            17,
            requester: 'tony',
          ),
        ]);
        // A promise the PM keeps, as the mockup's preview route.
        (server.state['conversations'] as List)
            .cast<Map<String, dynamic>>()
            .firstWhere((g) => g['id'] == 'preview')
          ..['notBefore'] = '2026-12-04'
          ..['requesterId'] = 'ken';
        final c = server.controller();
        addTearDown(c.dispose);
        await c.refresh();
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
                machineName: (_) => 'Team Mac',
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('super-tasks')));
        await tester.pumpAndSettle();
        // Open a task from the board, then come back: it shows selected.
        await tester.tap(find.byKey(const ValueKey('super-task-card-dial')));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('super-tasks')));
        await tester.pumpAndSettle();
        if (layout == 'list') {
          await tester.tap(
            find.byKey(const ValueKey('super-tasks-layout-list')),
          );
          await tester.pumpAndSettle();
        }
        expect(find.text('Needs you'), findsOneWidget);
        expect(find.byKey(const ValueKey('super-tasks-badge')), findsOneWidget);
        expect(tester.takeException(), isNull);
        await captureWindow(tester, shots, 'tasks-$layout-${brightness.name}');
      });
    }
  }
}
