import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import 'super_tab_personal_tasks_pane_test.dart' show TasksFixture;
import 'support/capture.dart';
import 'swarm_state_test.dart' show createApp;

/// Audit finding 7 of task #4211 (task #4250): losing the connection was invisible on the Board, Decisions and the
/// Leaderboard. The app knew ("Could not refresh this conversation") but only a chat showed "Reconnecting… Retry", and
/// the Tasks pane kept its rows as if live. One line, whatever the middle holds; the Tasks pane marks its rows.
final shots = Platform.environment['SUPER_TAB_OFFLINE_SHOTS'];

void main() {
  setUpAll(() => loadCaptureFonts(shots));
  Finder key(String k) => find.byKey(ValueKey(k));

  Future<TasksFixture> mount(WidgetTester tester, Brightness brightness) async {
    await tester.binding.setSurfaceSize(const Size(1500, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final before = grid.AppTheme.brightness.value;
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = before);
    final f = TasksFixture();
    addTearDown(f.controller.dispose);
    await f.controller.refresh();
    final app = createApp();
    addTearDown(app.dispose);
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: brightness),
        home: Scaffold(
          body: SuperTabView(
            controller: f.controller,
            app: app,
            onNewSwarm: () {},
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Mac Studio',
            board: true,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return f;
  }

  /// The connection is lost: the next read of the Swarm fails and what was read stays.
  Future<void> goOffline(WidgetTester tester, TasksFixture f) async {
    f.offline = true;
    await tester.runAsync(f.controller.refresh);
    await tester.pump();
  }

  for (final brightness in Brightness.values) {
    // Humans opens the Leaderboard on the Desktop (task #4466).
    for (final page in ['super-decisions', 'project-sidebar-humans']) {
      testWidgets('${brightness.name}: $page says it is reconnecting, once, '
          'and Retry reads again', (tester) async {
        final f = await mount(tester, brightness);
        await tester.tap(key(page));
        await tester.pumpAndSettle();
        expect(key('super-reconnecting'), findsNothing);
        await goOffline(tester, f);
        expect(key('super-reconnecting'), findsOneWidget);
        await captureWindow(tester, shots, 'offline-$page-${brightness.name}');
        f.offline = false;
        // The line's own Retry, in the row of the words.
        await tester.tap(
          find.descendant(
            of: find
                .ancestor(
                  of: key('super-reconnecting'),
                  matching: find.byType(Row),
                )
                .first,
            matching: find.text('Retry'),
          ),
        );
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 50)),
        );
        await tester.pumpAndSettle();
        expect(key('super-reconnecting'), findsNothing);
      });
    }

    testWidgets('${brightness.name}: a Board and a chat have the line once, '
        'not twice', (tester) async {
      final f = await mount(tester, brightness);
      await goOffline(tester, f);
      expect(key('super-reconnecting'), findsOneWidget);
      await tester.tap(key('super-board-tab-chat'));
      await tester.pumpAndSettle();
      expect(key('super-reconnecting'), findsOneWidget);
    });

    testWidgets('${brightness.name}: the Tasks pane marks its rows as '
        'possibly out of date, only while offline', (tester) async {
      final f = await mount(tester, brightness);
      expect(key('tasks-stale'), findsNothing);
      await goOffline(tester, f);
      expect(key('tasks-stale'), findsOneWidget);
      expect(find.text('Task new'), findsOneWidget);
      f.offline = false;
      await tester.runAsync(f.controller.refresh);
      await tester.pump();
      expect(key('tasks-stale'), findsNothing);
    });
  }
}
