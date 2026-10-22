import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:window_manager/window_manager.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/project_sidebar.dart';
import 'package:harness/super_tabs/task_status.dart';

import '../test/support/super_tab_fixture.dart';
import '../test/support/super_tab_task_board_fixture.dart';

/// The Swarm sidebar's task board on a real macOS window: a status chip, the agent's avatar, the age and the pull
/// request on each workgroup's row, the status filter, and the Finished row closed and open. Fixture data only —
/// it opens no account, daemon or Swarm. `SUPER_TAB_NATIVE_SHOTS=<folder>` keeps a picture of each step.
void main() {
  if (!kUnderTest) throw StateError('Requires FLUTTER_TEST=1');
  IntegrationTestWidgetsFlutterBinding.ensureInitialized().framePolicy =
      LiveTestWidgetsFlutterBindingFramePolicy.onlyPumps;

  testWidgets('native task board shows every task\'s state in the sidebar', (
    tester,
  ) async {
    await windowManager.ensureInitialized().timeout(
      const Duration(seconds: 10),
    );
    await windowManager
        .setSize(const Size(420, 980))
        .timeout(const Duration(seconds: 10));
    await windowManager.setAlwaysOnTop(true);
    addTearDown(() => windowManager.setAlwaysOnTop(false));
    await windowManager.show().timeout(const Duration(seconds: 10));
    await windowManager.focus().timeout(const Duration(seconds: 10));

    final server = ConversationServer();
    taskBoard(server, [
      taskGroup(
        27,
        'Relay opens by release',
        'working',
        agent: 'atlas',
        ago: const Duration(minutes: 2),
        evidence: '$taskBoardRepo/1557',
      ),
      taskGroup(
        28,
        'Machine freshness',
        'needs_human',
        agent: 'sage',
        ago: const Duration(minutes: 12),
      ),
      taskGroup(
        29,
        'Sidebar status chips',
        'blocked',
        agent: 'nova',
        ago: const Duration(minutes: 47),
      ),
      taskGroup(
        30,
        'Phone connect on background',
        'review',
        agent: 'atlas',
        ago: const Duration(minutes: 5),
        result: 'Ready: $taskBoardRepo/1572',
      ),
      taskGroup(
        31,
        'Docs pass',
        'working',
        agent: 'finn',
        ago: const Duration(hours: 3),
      ),
      taskGroup(32, 'Spike: dial retries', null),
      taskGroup(
        33,
        'Swarm fresh worktree',
        'done',
        agent: 'finn',
        ago: const Duration(hours: 5),
        result: 'Merged: $taskBoardRepo/1494',
      ),
      taskGroup(
        34,
        'Try a relay codec',
        'stopped',
        agent: 'nova',
        ago: const Duration(days: 1),
      ),
      taskGroup(
        35,
        'Old idea',
        'cancelled',
        agent: 'sage',
        ago: const Duration(days: 2),
      ),
    ]);
    final c = server.controller();
    await c.refresh();
    c.expandedProjects.add('lead');

    final boundary = GlobalKey();
    Future<void> pump(Brightness brightness) async {
      grid.AppTheme.brightness.value = brightness;
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
            home: Scaffold(
              body: ListenableBuilder(
                listenable: c,
                builder: (context, _) => ProjectSidebar(
                  controller: c,
                  onSelect: c.select,
                  needsHuman: (_) => 0,
                  onAddAgent: (_) {},
                  now: () => taskBoardNow,
                  readPullRequests: (urls) async => pullRequestRows(urls, {
                    1557: ('Draft', 2),
                    1572: ('Open', 5),
                    1494: ('Merged', 5),
                  }),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 50));
      await tester.pumpAndSettle(
        const Duration(milliseconds: 100),
        EnginePhase.sendSemanticsUpdate,
        const Duration(seconds: 10),
      );
    }

    final folder = Platform.environment['SUPER_TAB_NATIVE_SHOTS'];
    Future<void> shot(String name) async {
      if (folder == null) return;
      final render =
          boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      final image = await render.toImage(pixelRatio: 2);
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      await Directory(folder).create(recursive: true);
      await File('$folder/$name.png').writeAsBytes(bytes!.buffer.asUint8List());
      image.dispose();
    }

    for (final brightness in [Brightness.light, Brightness.dark]) {
      await pump(brightness);
      // The PR states arrive after the first frame, in one batch.
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump(const Duration(milliseconds: 100));
      final name = brightness.name;
      expect(find.text('Needs you'), findsWidgets);
      expect(find.text('#1557 Draft'), findsOneWidget);
      await shot('1-all-$name');

      c.filterByStatus(SuperTabTaskStatus.needsYou);
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byKey(const ValueKey('super-group-task-28')), findsOneWidget);
      expect(find.byKey(const ValueKey('super-group-task-27')), findsNothing);
      await shot('2-filter-needs-you-$name');
      c.filterByStatus(null);

      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('Finished (3)'), findsOneWidget);
      await shot('3-finished-closed-$name');
      c.toggleFinished('lead');
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byKey(const ValueKey('super-group-task-33')), findsOneWidget);
      await shot('4-finished-open-$name');
      c.toggleFinished('lead');
    }
    await tester.pumpWidget(const SizedBox());
    c.dispose();
  });
}
