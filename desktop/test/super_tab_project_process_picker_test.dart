import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_menu.dart';
import 'package:harness/state/harness_launch_integration.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/widgets/new_harness_form.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'super_tab_launch_test.dart' show SuperTabLaunchFixture;
import 'support/super_tab_fixture.dart';

/// Task #3897 (the Desktop half of #3896): a project's process, Simple or Full, is chosen when the project is made and
/// changed in Project settings by its owner (or the Swarm's); everyone else reads it.

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 3; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 30)),
    );
    await tester.pump(const Duration(milliseconds: 50));
  }
}

Finder _key(String k) => find.byKey(ValueKey(k));

Iterable<Map> _commands(ConversationServer server, String type) => [
  for (final post in server.posts)
    if ((post['command'] as Map?)?['type'] == type) post['command'] as Map,
];

void main() {
  group('Project settings has a Process row', () {
    Future<(SuperTabController, ConversationServer)> show(
      WidgetTester tester, {
      String reader = 'owner',
      String projectOwner = 'owner',
    }) async {
      await tester.binding.setSurfaceSize(const Size(1600, 1000));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final server = swarm();
      (server.state['people'] as List).add({
        'id': 'tuan',
        'email': 'tuan@example.com',
        'role': 'collaborator',
      });
      (server.state['projects'] as List).first
        ..['ownerId'] = projectOwner
        ..['members'] = [
          {'id': 'owner'},
          {'id': 'tuan'},
        ];
      final c = server.controller(
        account: reader,
        initial: {'tabId': 'tab', 'accountId': reader, 'selectedId': 'lead'},
      );
      await tester.runAsync(c.refresh);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.light),
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
      await _settle(tester);
      return (c, server);
    }

    Future<void> end(WidgetTester tester, SuperTabController c) async {
      await tester.pumpWidget(const SizedBox());
      c.dispose();
      await tester.pump(const Duration(seconds: 5));
    }

    Future<void> openProcess(WidgetTester tester) async {
      await tester.tap(find.byTooltip('Project options'));
      await _settle(tester);
      await tester.tap(find.widgetWithText(AppMenuItem, 'Project settings…'));
      await _settle(tester);
      expect(
        find.descendant(
          of: _key('super-project-setting-Process'),
          matching: find.text('Full'),
        ),
        findsOneWidget,
        reason: 'the row says the project\'s process',
      );
      await tester.tap(_key('super-project-setting-Process'));
      await _settle(tester);
    }

    InkWell option(WidgetTester tester, String id) => tester.widget<InkWell>(
      find.descendant(
        of: _key('project-process-$id'),
        matching: find.byType(InkWell),
      ),
    );

    testWidgets('the owner chooses Simple, and the server is told', (
      tester,
    ) async {
      final (c, server) = await show(tester);
      await openProcess(tester);
      // One line each on what the two mean.
      expect(find.textContaining('To do, Doing, Done'), findsOneWidget);
      expect(find.textContaining('review, test and merge'), findsWidgets);
      expect(option(tester, 'simple').onTap, isNotNull);
      expect(_key('project-process-owner-only'), findsNothing);
      await tester.tap(_key('project-process-simple'));
      await _settle(tester);
      expect(_commands(server, 'project.process'), [
        {'type': 'project.process', 'projectId': 'lead', 'process': 'simple'},
      ]);
      expect(c.snapshot!.projectById('lead')!.isSimple, isTrue);
      await end(tester, c);
    });

    testWidgets('the Swarm owner may too, on a project that is another\'s', (
      tester,
    ) async {
      final (c, server) = await show(tester, projectOwner: 'tuan');
      await openProcess(tester);
      await tester.tap(_key('project-process-simple'));
      await _settle(tester);
      expect(_commands(server, 'project.process'), hasLength(1));
      await end(tester, c);
    });

    testWidgets('anyone else reads it, with the options off and no command', (
      tester,
    ) async {
      final (c, server) = await show(tester, reader: 'tuan');
      await openProcess(tester);
      expect(option(tester, 'simple').onTap, isNull);
      expect(option(tester, 'full').onTap, isNull);
      expect(_key('project-process-owner-only'), findsOneWidget);
      await tester.tap(_key('project-process-simple'), warnIfMissed: false);
      await _settle(tester);
      expect(_commands(server, 'project.process'), isEmpty);
      await end(tester, c);
    });

    testWidgets('the server\'s refusal is said, and nothing changes', (
      tester,
    ) async {
      final (c, server) = await show(tester);
      await openProcess(tester);
      server
        ..refuse = {
          'code': 'PROCESS_FORBIDDEN',
          'message': 'Only the project\'s owner changes its process.',
        }
        ..refuseStatus = 403;
      await tester.tap(_key('project-process-simple'));
      await _settle(tester);
      expect(
        tester.widget<Text>(_key('project-process-error')).data,
        'Only the project\'s owner changes its process.',
      );
      expect(c.snapshot!.projectById('lead')!.isSimple, isFalse);
      await end(tester, c);
    });
  });

  group('New project offers the process', () {
    Future<NewHarnessController> mount(
      WidgetTester tester, {
      bool locked = false,
    }) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
      tester.view.physicalSize = const Size(760, 600);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final f = SuperTabLaunchFixture();
      final box = NewHarnessController(
        f.app,
        machineId: 'm',
        engine: 'codex',
        folder: '/work/lamp-os',
        integration: HarnessLaunchIntegration(
          creationId: 'process-form-fixture',
          actionLabel: 'New Project',
          projectVisibility: 'public',
          projectProcess: 'full',
          projectVisibilityLocked: locked,
          prepare: (_, task, _) async => task,
          beforeSubmit: (_, _) async {},
          complete: (_, _) async {},
        ),
      );
      addTearDown(box.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.light),
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
      return box;
    }

    Future<void> unmount(WidgetTester tester) async {
      await tester.pumpWidget(const SizedBox());
      debugDefaultTargetPlatformOverride = null;
    }

    testWidgets('Full is chosen, and Simple is one pick away', (tester) async {
      final box = await mount(tester);
      final pill = _key('new-harness-project-process');
      expect(pill, findsOneWidget);
      expect(find.descendant(of: pill, matching: find.text('Full')), findsOne);
      // Beside Public, on the same line.
      expect(
        (tester.getCenter(pill).dy -
                tester.getCenter(_key('new-harness-project-visibility')).dy)
            .abs(),
        lessThan(4),
      );
      await tester.tap(pill);
      await tester.pumpAndSettle();
      expect(find.textContaining('To do, Doing, Done'), findsOneWidget);
      await tester.tap(find.widgetWithText(AppMenuItem, 'Simple'));
      await tester.pumpAndSettle();
      expect(box.integration!.projectProcess, 'simple');
      expect(
        find.descendant(of: pill, matching: find.text('Simple')),
        findsOneWidget,
      );
      await unmount(tester);
    });

    testWidgets('once creation has started it is fixed for the request', (
      tester,
    ) async {
      final box = await mount(tester, locked: true);
      await tester.tap(_key('new-harness-project-process'));
      await tester.pumpAndSettle();
      expect(find.widgetWithText(AppMenuItem, 'Simple'), findsNothing);
      expect(box.integration!.projectProcess, 'full');
      await unmount(tester);
    });
  });
}
