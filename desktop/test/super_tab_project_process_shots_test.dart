import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_menu.dart';
import 'package:harness/state/harness_launch_integration.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/tasks_view.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/widgets/new_harness_form.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'super_tab_launch_test.dart' show SuperTabLaunchFixture;
import 'super_tab_tasks_view_test.dart' show tasksServer;
import 'support/capture.dart';
import 'support/memory_key_value_store.dart';

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_PROCESS_SHOTS'];

/// Task #3897: a Simple and a Full project's Board, the Process choice in Project settings and in New project, in both
/// appearances.
void main() {
  setUpAll(() async {
    await loadCaptureFonts(shots);
    if (shots != null && Platform.isMacOS) {
      final bytes = ByteData.sublistView(
        await File('/System/Library/Fonts/Apple Symbols.ttf').readAsBytes(),
      );
      await (FontLoader('Apple Symbols')..addFont(Future.value(bytes))).load();
    }
  });

  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 3; i++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 30)),
      );
      await tester.pump(const Duration(milliseconds: 50));
    }
  }

  for (final brightness in Brightness.values) {
    for (final simple in [true, false]) {
      testWidgets('Board, ${simple ? 'Simple' : 'Full'} (${brightness.name})', (
        tester,
      ) async {
        await tester.binding.setSurfaceSize(const Size(1500, 800));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final before = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = before);
        final server = tasksServer();
        if (simple) {
          (server.state['projects'] as List).single
            ..['process'] = 'simple'
            ..['columns'] = [
              {'id': 'todo', 'title': 'To do'},
              {'id': 'doing', 'title': 'Doing'},
              {'id': 'done', 'title': 'Done'},
            ];
        }
        final c = server.controller();
        await c.refresh();
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
            home: Scaffold(
              body: SuperTabTasksView(
                controller: c,
                project: c.snapshot!.projects.single,
                storage: MemoryKeyValueStore(),
                needsHuman: (_) => 0,
                onOpenTask: (_) {},
                onOpenProposal: (_) {},
                onOpenMessage: (_, _) {},
                now: () => DateTime(2026, 11, 4, 9),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await captureWindow(
          tester,
          shots,
          'board-${simple ? 'simple' : 'full'}-${brightness.name}',
        );
        await tester.pumpWidget(const SizedBox());
        await c.flush();
        c.dispose();
      });
    }

    testWidgets('Project settings, Process (${brightness.name})', (
      tester,
    ) async {
      await tester.binding.setSurfaceSize(const Size(1300, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final before = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = before);
      final server = swarm();
      final SuperTabController c = server.controller(
        account: 'owner',
        initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
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
              board: true,
            ),
          ),
        ),
      );
      await settle(tester);
      await tester.tap(find.byTooltip('Project options'));
      await settle(tester);
      await tester.tap(find.widgetWithText(AppMenuItem, 'Project settings…'));
      await settle(tester);
      await tester.tap(
        find.byKey(const ValueKey('super-project-setting-Process')),
      );
      await settle(tester);
      await captureWindow(tester, shots, 'settings-process-${brightness.name}');
      await tester.pumpWidget(const SizedBox());
      c.dispose();
      await tester.pump(const Duration(seconds: 5));
    });

    testWidgets('New project, Process menu (${brightness.name})', (
      tester,
    ) async {
      final before = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = before);
      debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
      tester.view.physicalSize = const Size(900, 600);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final f = SuperTabLaunchFixture();
      final box = NewHarnessController(
        f.app,
        machineId: 'm',
        engine: 'codex',
        folder: '/work/scout',
        integration: HarnessLaunchIntegration(
          creationId: 'process-shots',
          actionLabel: 'New Project',
          projectVisibility: 'public',
          projectProcess: 'full',
          prepare: (_, task, _) async => task,
          beforeSubmit: (_, _) async {},
          complete: (_, _) async {},
        ),
      );
      addTearDown(box.dispose);
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          home: Scaffold(
            body: NewHarnessForm(
              controller: box,
              desktop: true,
              embedded: true,
              onClose: () {},
              onCreated: () {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('new-harness-project-process')),
      );
      await tester.pumpAndSettle();
      await captureWindow(
        tester,
        shots,
        'new-project-process-${brightness.name}',
      );
      await tester.pumpWidget(const SizedBox());
      debugDefaultTargetPlatformOverride = null;
    });
  }
}
