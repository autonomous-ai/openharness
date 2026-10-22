import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/machine_resources.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/machine_status.dart';
import 'package:harness/super_tabs/machines.dart';
import 'package:harness/super_tabs/project_sidebar.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

void main() {
  for (final scale in [1.0, 2.0]) {
    testWidgets(
      'sidebar shares text alignment and preserves lead navigation at ${scale}x',
      (tester) async {
        await tester.binding.setSurfaceSize(const Size(1600, 700));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final app = createApp(connected: true);
        addTearDown(app.dispose);
        final server = ConversationServer();
        server.state['projects'] = [
          projectFixture('lead', 'web-project', 'lead'),
          projectFixture(
            'empty',
            'sample-project',
            'empty-lead',
            visibility: 'private',
          ),
        ];
        (server.state['conversations'] as List)[1]
          ..['projectId'] = 'lead'
          ..['number'] = 12;
        (server.state['conversations'] as List).add({
          ...conversationFixture('empty-lead', 'Lead'),
          'projectId': 'empty',
        });
        final c = server.controller();
        await c.refresh();
        var created = 0;
        await tester.pumpWidget(
          MaterialApp(
            theme: grid.buildAppTheme(brightness: Brightness.dark),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: TextScaler.linear(scale)),
              child: child!,
            ),
            home: Scaffold(
              body: SuperTabView(
                controller: c,
                app: app,
                onInvite: () {},
                onAddAgent: (_) {},
                onOpenTerminal: (_) {},
                onNewProject: () => created++,
                machineName: (_) => 'Test Mac',
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        final sidebar = find.byType(ProjectSidebar);
        Finder inside(Finder finder) =>
            find.descendant(of: sidebar, matching: finder);
        final expand = find.byKey(const ValueKey('super-project-expand-lead'));
        final empty = find.byKey(const ValueKey('super-project-expand-empty'));
        expect(expand, findsOneWidget);
        expect(empty, findsOneWidget);
        expect(inside(find.byType(OutlinedButton)), findsNothing);
        expect(inside(find.text('Projects')), findsOneWidget);
        expect(inside(find.text('Machines')), findsOneWidget);

        // Project names always select the lead; disclosure never switches chats.
        await tester.tap(inside(find.text('sample-project')));
        await tester.pumpAndSettle();
        expect(c.selectedId, 'empty-lead');
        await tester.tap(expand);
        await tester.pumpAndSettle();
        expect(c.selectedId, 'empty-lead');
        final work = find.byKey(const ValueKey('super-group-offline'));
        expect(work, findsOneWidget);
        final projectX = tester.getTopLeft(inside(find.text('web-project'))).dx;
        for (final label in ['sample-project', '#12 Offline editing']) {
          expect(tester.getTopLeft(inside(find.text(label))).dx, projectX);
        }
        final yourDevices = inside(find.text('Your devices'));
        expect(tester.getTopLeft(yourDevices).dx, projectX);
        final projectRect = tester.getRect(
          find.byKey(const ValueKey('super-group-lead')),
        );
        final workRect = tester.getRect(work);
        expect(workRect.left, projectRect.left);
        expect(workRect.right, projectRect.right);

        await tester.tap(work);
        await tester.pumpAndSettle();
        expect(c.selectedId, 'offline');
        await tester.tap(empty);
        await tester.pumpAndSettle();
        expect(c.selectedId, 'offline');
        expect(c.expandedProjects, contains('empty'));
        expect(inside(find.text('No workgroups yet')), findsOneWidget);
        expect(
          tester.getTopLeft(inside(find.text('No workgroups yet'))).dx,
          projectX,
        );
        expect(find.byTooltip('Collapse sample-project'), findsOneWidget);
        expect(
          find.descendant(
            of: empty,
            matching: find.byIcon(AppIcons.chevronDown),
          ),
          findsOneWidget,
        );

        await tester.tap(empty);
        await tester.pumpAndSettle();
        expect(inside(find.text('No workgroups yet')), findsNothing);
        expect(c.selectedId, 'offline');

        // Both navigation actions retain keyboard activation.
        final newProject = find.byTooltip('New project');
        Focus.of(
          tester.element(
            find.descendant(of: newProject, matching: find.byIcon(AppIcons.plus)),
          ),
        ).requestFocus();
        await tester.pump();
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(created, 1);
        await tester.tap(find.byKey(const ValueKey('super-your-devices')));
        await tester.pumpAndSettle();
        expect(app.activeSwarm.isDevices, isTrue);
        expect(app.activeSwarm.panes.first.isDevices, isTrue);
        expect(app.activeSwarm.panes.last.isViewer, isFalse);
        expect(app.machinesRequest, isNull);
        final devicesId = app.activeSwarmId;
        await tester.tap(find.byKey(const ValueKey('super-your-devices')));
        await tester.pumpAndSettle();
        expect(app.activeSwarmId, devicesId);
        expect(app.swarms.where((s) => s.isDevices), hasLength(1));
        expect(c.selectedId, 'offline');
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        await c.flush();
        c.dispose();
      },
    );
  }

  testWidgets(
    "the Machines heading's + lines up with the Projects heading's +, "
    'with the pill flush before it',
    (tester) async {
      final app = createApp(connected: true);
      addTearDown(app.dispose);
      final server = ConversationServer();
      server.state['projects'] = [projectFixture('lead', 'web-project', 'lead')];
      final c = server.controller();
      await c.refresh();
      for (final width in [280.0, 420.0]) {
        await tester.binding.setSurfaceSize(Size(width, 700));
        await tester.pumpWidget(
          MaterialApp(
            theme: grid.buildAppTheme(brightness: Brightness.dark),
            home: Scaffold(
              body: SizedBox(
                width: width,
                child: ProjectSidebar(
                  controller: c,
                  app: app,
                  onAddAgent: (_) {},
                  needsHuman: (_) => 0,
                  onSelect: (_) {},
                  onNewProject: () {},
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        final projectAdd = tester.getRect(find.byTooltip('New project'));
        final machinesAdd = tester.getRect(find.byTooltip('Add machine'));
        expect(
          machinesAdd.right,
          closeTo(projectAdd.right, 1),
          reason: 'at width $width',
        );

        final pill = tester.getRect(find.byType(SuperTabMachinesPill));
        expect(
          pill.right,
          lessThanOrEqualTo(machinesAdd.left),
          reason: 'at width $width',
        );
        expect(
          machinesAdd.left - pill.right,
          lessThan(20),
          reason: 'the pill sits flush before the +, at width $width',
        );
      }
      await tester.binding.setSurfaceSize(null);
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    },
  );

  testWidgets(
    'a wide reconnecting pill does not overflow a dragged-down narrow '
    'drawer, and the + stays aligned',
    (tester) async {
      final app = createApp(connected: true);
      addTearDown(app.dispose);
      final server = ConversationServer();
      server.state['projects'] = [projectFixture('lead', 'web-project', 'lead')];
      final c = server.controller();
      await c.refresh();
      server.failReads = true;
      await c.refresh();
      expect(c.backendUnreachable, isTrue);
      // "Reconnecting · 12m" is close to the pill's widest normal content.
      final pinned = c.unreachableSince!.add(const Duration(minutes: 12));

      for (final width in [180.0, 240.0]) {
        for (final scale in [1.0, 2.0]) {
          await tester.binding.setSurfaceSize(Size(width, 700));
          await tester.pumpWidget(
            MaterialApp(
              theme: grid.buildAppTheme(brightness: Brightness.dark),
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(
                  context,
                ).copyWith(textScaler: TextScaler.linear(scale)),
                child: child!,
              ),
              home: Scaffold(
                body: SizedBox(
                  width: width,
                  child: ProjectSidebar(
                    controller: c,
                    app: app,
                    onAddAgent: (_) {},
                    needsHuman: (_) => 0,
                    onSelect: (_) {},
                    onNewProject: () {},
                    now: () => pinned,
                  ),
                ),
              ),
            ),
          );
          await tester.pumpAndSettle();
          final reason = 'at width $width, scale $scale';
          expect(tester.takeException(), isNull, reason: reason);
          expect(
            find.textContaining('Reconnecting'),
            findsOneWidget,
            reason: reason,
          );

          final projectAdd = tester.getRect(find.byTooltip('New project'));
          final machinesAdd = tester.getRect(find.byTooltip('Add machine'));
          expect(
            machinesAdd.right,
            closeTo(projectAdd.right, 1),
            reason: reason,
          );
        }
      }
      await tester.binding.setSurfaceSize(null);
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    },
  );

  testWidgets('the left Machines group repaints on a live app change alone', (
    tester,
  ) async {
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    final server = ConversationServer();
    server.state['agents'] = [
      {
        'id': 'agent-0',
        'projectId': null,
        'name': 'Lead',
        'displayName': 'Atlas',
        'machineId': 'm',
        'harnessId': 'a0',
        'contributorId': 'owner',
        'configuration': {'engine': 'claude'},
      },
    ];
    final c = server.controller();
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: ProjectSidebar(
            controller: c,
            app: app,
            onAddAgent: (_) {},
            needsHuman: (_) => 0,
            onSelect: (_) {},
            // This computer reads its own machine; a sample gives the row a
            // non-null age, so its status reflects `connected` immediately.
            readLocal: (_) async => const MachineResources(cpuPercent: 10),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    // Let the first local read land.
    await tester.pump();
    await tester.pump();
    Finder statusDot() => find.descendant(
      of: find.byKey(const ValueKey('super-machine-m')),
      matching: find.byType(SuperTabMachineDot),
    );
    expect(tester.widget<SuperTabMachineDot>(statusDot()).status, isNot(SuperTabMachineStatus.offline));

    // The Machines group has no listener of its own on the controller the
    // rest of this sidebar rebuilds on, so a bare app event (no controller
    // change, no re-pump) must still repaint it.
    await app.handleEventForTest('m', {'type': 'node_status', 'online': false});
    await tester.pump();
    expect(tester.widget<SuperTabMachineDot>(statusDot()).status, SuperTabMachineStatus.offline);

    await tester.pumpWidget(const SizedBox());
    await c.flush();
    c.dispose();
  });

  testWidgets('Projects and Machines groups collapse and persist', (
    tester,
  ) async {
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    final server = ConversationServer();
    server.state['projects'] = [projectFixture('lead', 'web-project', 'lead')];
    final c = server.controller();
    await c.refresh();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            app: app,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            onNewProject: () {},
            machineName: (_) => 'Test Mac',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final sidebar = find.byType(ProjectSidebar);
    Finder inside(Finder finder) =>
        find.descendant(of: sidebar, matching: finder);

    expect(inside(find.text('web-project')), findsOneWidget);
    expect(inside(find.text('Your devices')), findsOneWidget);

    await tester.tap(find.byTooltip('Collapse Projects'));
    await tester.pumpAndSettle();
    expect(inside(find.text('web-project')), findsNothing);
    expect(c.projectsGroupOpen, isFalse);

    await tester.tap(find.byTooltip('Collapse Machines'));
    await tester.pumpAndSettle();
    expect(inside(find.text('Your devices')), findsNothing);
    expect(c.machinesGroupOpen, isFalse);

    // Persisted state survives a restart of the sidebar's controller.
    await c.flush();
    final saved = server.saved!;
    expect(saved['projectsGroupOpen'], isFalse);
    expect(saved['machinesGroupOpen'], isFalse);
    final reopened = server.controller(initial: saved);
    await reopened.refresh();
    expect(reopened.projectsGroupOpen, isFalse);
    expect(reopened.machinesGroupOpen, isFalse);

    await tester.tap(find.byTooltip('Expand Projects'));
    await tester.pumpAndSettle();
    expect(inside(find.text('web-project')), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    c.dispose();
    await reopened.flush();
    reopened.dispose();
  });
}
